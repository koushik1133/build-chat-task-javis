import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { completeWithTools } from "@/lib/llm/router";
import { assertBudget } from "@/lib/llm/budgets";
import { recordUsage } from "@/lib/llm/metering";
import { emitEvent } from "@/lib/events/bus";
import { getTool, listTools, needsApproval } from "@/lib/agents/registry";
import type { RouterMessage, ToolContext, ToolSpec } from "@/lib/agents/types";

/**
 * AI receptionist for inbound SMS / WhatsApp / voice.
 *
 * Classifies the intent, drafts a short reply (optionally using a few CRM and
 * task tools), meters spend under the "receptionist" feature, and decides
 * whether the reply may go out automatically or must wait in the approvals
 * inbox. It never throws: a model failure degrades to a polite fallback that
 * is always held for a human.
 */

export type InboundChannel = "sms" | "whatsapp" | "voice";
export type InboundIntent = "booking" | "quote" | "support" | "sales" | "spam" | "other";

export interface InboundTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InboundMessage {
  channel: InboundChannel;
  fromNumber: string;
  text: string;
  history?: InboundTurn[];
}

export interface InboundResult {
  reply: string;
  intent: InboundIntent;
  autoSend: boolean;
  approvalId?: string;
  /** True when the model could not be reached and a canned reply was used. */
  fallback?: boolean;
}

const INTENTS: InboundIntent[] = ["booking", "quote", "support", "sales", "spam", "other"];
const RECEPTIONIST_TOOLS = ["crm.search_contacts", "crm.create_contact", "tasks.create", "comms.notify", "calendar.propose_slots", "calendar.book", "calendar.cancel_booking"];
const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 20;

export const FALLBACK_REPLY =
  "Thanks for reaching out — a team member will get back to you shortly.";

/** Tools are registered by another module; load them lazily and tolerate absence. */
async function loadTools(): Promise<ToolSpec[]> {
  try {
    await import("@/lib/agents/tools/index");
  } catch {
    // Tool modules not present yet — run without tools.
  }
  try {
    return listTools({ names: RECEPTIONIST_TOOLS });
  } catch {
    return [];
  }
}

async function loadContext(userId: string) {
  const [integration, profile] = await Promise.all([
    queryOne<{ messaging_auto_reply: boolean | null }>(
      `SELECT messaging_auto_reply FROM user_integrations WHERE user_id = $1`,
      [userId]
    ).catch(() => null),
    queryOne<{ company_name: string | null; industry: string | null; product_desc: string | null }>(
      `SELECT company_name, industry, product_desc FROM business_profile WHERE user_id = $1`,
      [userId]
    ).catch(() => null),
  ]);
  return {
    autoReply: !!integration?.messaging_auto_reply,
    companyName: profile?.company_name?.trim() || "our office",
    industry: profile?.industry?.trim() || null,
    productDesc: profile?.product_desc?.trim() || null,
  };
}

async function insertApproval(
  userId: string,
  toolName: string,
  input: unknown,
  preview: string
): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, created_at)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5, 'pending', NOW())`,
    [id, userId, toolName, JSON.stringify(input ?? {}), preview.slice(0, 500)]
  );
  return id;
}

function systemPrompt(ctx: Awaited<ReturnType<typeof loadContext>>, channel: InboundChannel) {
  const medium = channel === "voice" ? "a phone call (spoken aloud)" : `a ${channel.toUpperCase()} message`;
  return [
    `You are the AI receptionist for ${ctx.companyName}${ctx.industry ? ` (${ctx.industry})` : ""}.`,
    ctx.productDesc ? `About the business: ${ctx.productDesc.slice(0, 600)}` : "",
    `You are answering ${medium}. Be warm, concise and professional — at most 2–3 short sentences, no markdown.`,
    "If the caller wants to book, get a quote, or needs support, gather the one or two details a human would need next and reassure them someone will follow up.",
    "You may use tools to look up or create a contact and to create a follow-up task, but never invent facts about pricing or availability.",
    "For booking requests, use calendar.propose_slots to offer real times and calendar.book to confirm one the caller picked; never make up availability.",
    `When you are done, respond ONLY with JSON: {"intent": one of ${JSON.stringify(INTENTS)}, "reply": "<the message to send>"}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseFinal(content: string | null): { intent: InboundIntent; reply: string } | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { intent?: unknown; reply?: unknown };
      const intent = INTENTS.includes(obj.intent as InboundIntent) ? (obj.intent as InboundIntent) : "other";
      const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
      if (reply) return { intent, reply };
    } catch {
      // fall through to plain-text handling
    }
  }
  const plain = content.trim();
  return plain ? { intent: "other", reply: plain.slice(0, 1000) } : null;
}

async function runTool(userId: string, name: string, rawArgs: string): Promise<string> {
  const spec = getTool(name);
  if (!spec) return JSON.stringify({ ok: false, error: `Unknown tool ${name}` });

  let args: unknown = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return JSON.stringify({ ok: false, error: "Arguments were not valid JSON" });
  }
  const parsed = spec.input.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") });
  }

  const ctx: ToolContext = { userId, runId: "receptionist", agentId: null, autonomy: "approve" };
  if (needsApproval(spec, parsed.data, ctx)) {
    const preview = spec.preview ? spec.preview(parsed.data) : `${spec.name} ${JSON.stringify(parsed.data).slice(0, 200)}`;
    const approvalId = await insertApproval(userId, spec.name, parsed.data, preview);
    return JSON.stringify({ ok: true, queued_for_approval: true, approval_id: approvalId, summary: preview });
  }

  try {
    const result = await spec.run(ctx, parsed.data);
    return JSON.stringify({ ok: result.ok, summary: result.summary, data: result.data ?? null, error: result.error ?? null }).slice(0, 4000);
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Handle one inbound message end to end. Never throws.
 */
export async function handleInboundMessage(userId: string, msg: InboundMessage): Promise<InboundResult> {
  const ctx = await loadContext(userId).catch(() => ({
    autoReply: false,
    companyName: "our office",
    industry: null,
    productDesc: null,
  }));

  let intent: InboundIntent = "other";
  let reply = FALLBACK_REPLY;
  let fallback = false;

  try {
    const budget = await assertBudget(userId);
    const tools = await loadTools();

    const messages: RouterMessage[] = [
      { role: "system", content: systemPrompt(ctx, msg.channel) },
      ...(msg.history ?? [])
        .slice(-MAX_HISTORY)
        .map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: msg.text.slice(0, 4000) },
    ];

    let final: { intent: InboundIntent; reply: string } | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const turn = await completeWithTools(messages, {
        tools: round < MAX_TOOL_ROUNDS ? tools : [],
        allowlist: budget.allowlist,
        maxTokens: 400,
        temperature: 0.3,
      });
      void recordUsage(userId, {
        feature: "receptionist",
        provider: turn.provider,
        model: turn.model,
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
      });

      if (turn.toolCalls.length === 0) {
        final = parseFinal(turn.content);
        break;
      }

      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name.replace(".", "__"), arguments: c.arguments },
        })),
      });
      for (const call of turn.toolCalls) {
        const out = await runTool(userId, call.name, call.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }

    if (final) {
      intent = final.intent;
      reply = final.reply;
    } else {
      fallback = true;
    }
  } catch (err) {
    console.error("[receptionist] drafting reply failed:", err);
    fallback = true;
  }

  void emitEvent(userId, {
    type: "message.received",
    entity: "messaging_conversation",
    entityId: msg.fromNumber,
    data: { channel: msg.channel, intent },
  });

  if (fallback) return { reply: FALLBACK_REPLY, intent, autoSend: false, fallback: true };

  if (ctx.autoReply && intent !== "spam") {
    return { reply, intent, autoSend: true };
  }

  let approvalId: string | undefined;
  try {
    approvalId = await insertApproval(
      userId,
      "messaging.reply",
      { to: msg.fromNumber, channel: msg.channel, text: reply },
      `Reply to ${msg.fromNumber} via ${msg.channel}: ${reply}`
    );
  } catch (err) {
    console.error("[receptionist] could not queue approval:", err);
  }
  return { reply, intent, autoSend: false, approvalId };
}
