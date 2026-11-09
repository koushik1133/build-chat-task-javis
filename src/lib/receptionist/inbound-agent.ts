import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { completeWithTools } from "@/lib/llm/router";
import { assertBudget } from "@/lib/llm/budgets";
import { clampMaxTokens } from "@/lib/llm/clamp";
import { recordUsage } from "@/lib/llm/metering";
import { emitEvent } from "@/lib/events/bus";
import { getTool, listTools, needsApproval } from "@/lib/agents/registry";
import type { RouterMessage, ToolContext, ToolSpec } from "@/lib/agents/types";
import { hasUntrustedOutput } from "@/lib/agents/registry";
import { UNTRUSTED_PREAMBLE, wrapUntrusted, wrapUntrustedJson } from "@/lib/ai/untrusted";
import { guardCustomerReply } from "@/lib/ai/output-guard";

/**
 * AI receptionist for inbound SMS / WhatsApp / voice / email / website chat.
 *
 * Classifies the intent, drafts a short reply (optionally using a few CRM and
 * task tools), meters spend under the "receptionist" feature, and decides
 * whether the reply may go out automatically or must wait in the approvals
 * inbox. It never throws: a model failure degrades to a polite fallback that
 * is always held for a human.
 */

export type InboundChannel = "sms" | "whatsapp" | "voice" | "email" | "webchat";
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
  /** Where the answer came from; also stored on the pending approval. */
  grounding?: Grounding;
  /** Why an auto-send was downgraded to a pending approval (output guard). */
  guardReasons?: string[];
}

export interface GroundingSource {
  title: string;
  slug?: string | null;
  score: number;
}

export interface Grounding {
  sources: GroundingSource[];
  confidence: number;
  /** The reply is a handoff because nothing grounded a factual question. */
  refused?: boolean;
}

export interface KbHit {
  title: string;
  slug?: string | null;
  excerpt?: string | null;
  snippet?: string | null;
  score: number;
}

export interface InboundDeps {
  /** KB retrieval; defaults to searchArticles. */
  retrieve?: (userId: string, q: string) => Promise<KbHit[]>;
}

/** Minimum retrieval score to treat a KB hit as grounding. */
export const GROUNDING_THRESHOLD = 0.6;
export const HANDOFF_REPLY =
  "I don't want to give you wrong information on that, so I'll have a team member confirm the details and get back to you shortly.";

const FACTUAL_QUESTION = /\b(price|prices|pricing|cost|costs|how much|fee|fees|rate|rates|hours|opening|open|close|closing|policy|policies|refund|warranty|guarantee|deliver|delivery|shipping|address|located|location|insurance|licen[cs]ed)\b/i;
/** A booking request still needs the model + calendar tools even if it also contains a factual-sounding word ("are you open Friday?"). */
const BOOKING_REQUEST = /\b(book|booking|appointment|appointments|schedule|reserve|reservation|reschedule)\b/i;
const PRICE_QUESTION = /\b(price|prices|pricing|cost|costs|how much|fee|fees|rate|rates|quote)\b/i;
const STOPWORDS = new Set(["what","when","where","which","your","does","have","with","that","this","about","much","will","you","the","and","are","for","how","can","any","there","their","our","opening"]);

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/**
 * Deterministic refuse-to-guess pre-check. A factual question about the
 * business (prices, hours, policies) with no retrieval above threshold and no
 * business-profile text that mentions it gets a handoff, not an invention.
 */
export function precheckGrounding(
  text: string,
  hits: KbHit[],
  productDesc: string | null
): { grounding: Grounding; refuse: boolean; grounded: KbHit[] } {
  const grounded = hits.filter((h) => h.score >= GROUNDING_THRESHOLD).slice(0, 3);
  const confidence = grounded.length ? Math.max(...grounded.map((h) => h.score)) : hits.length ? Math.max(...hits.map((h) => h.score)) : 0;
  const sources = grounded.map((h) => ({ title: h.title, slug: h.slug ?? null, score: h.score }));
  const factual = FACTUAL_QUESTION.test(text);
  const dnaOverlap = !!productDesc && keywords(text).some((w) => productDesc.toLowerCase().includes(w));
  if (dnaOverlap && sources.length === 0) sources.push({ title: "Business profile", slug: null, score: 0.5 });
  const refuse = factual && grounded.length === 0 && !dnaOverlap && !BOOKING_REQUEST.test(text);
  return { grounding: { sources, confidence, ...(refuse ? { refused: true } : {}) }, refuse, grounded };
}

/** "Source: A, B" suffix for replies that came from KB articles. */
export function citationSuffix(grounded: KbHit[]): string {
  const titles = [...new Set(grounded.map((h) => h.title.trim()).filter(Boolean))].slice(0, 3);
  return titles.length ? ` (Source: ${titles.join("; ")})` : "";
}

async function defaultRetrieve(userId: string, q: string): Promise<KbHit[]> {
  const { searchArticles } = await import("@/lib/kb/search");
  const hits = await searchArticles(userId, q, 5);
  return hits.map((h) => ({ title: h.title, slug: h.slug, excerpt: h.excerpt, snippet: h.snippet, score: h.score }));
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

function systemPrompt(ctx: Awaited<ReturnType<typeof loadContext>>, channel: InboundChannel, grounded: KbHit[] = []) {
  const medium =
    channel === "voice"
      ? "a phone call (spoken aloud)"
      : channel === "email"
        ? "an email (reply in a short, plain-text email)"
        : channel === "webchat"
          ? "a live chat on the business website (the visitor is reading on screen right now)"
          : `a ${channel.toUpperCase()} message`;
  return [
    `You are the AI receptionist for ${ctx.companyName}${ctx.industry ? ` (${ctx.industry})` : ""}.`,
    ctx.productDesc ? `About the business: ${ctx.productDesc.slice(0, 600)}` : "",
    `You are answering ${medium}. Be warm, concise and professional — at most ${channel === "email" ? "4–5" : "2–3"} short sentences, no markdown.`,
    "If the caller wants to book, get a quote, or needs support, gather the one or two details a human would need next and reassure them someone will follow up.",
    "You may use tools to look up or create a contact and to create a follow-up task, but never invent facts about pricing or availability.",
    "For booking requests, use calendar.propose_slots to offer real times and calendar.book to confirm one the caller picked; never make up availability.",
    grounded.length
      ? `Knowledge base excerpts (operator-approved; answer only from these for factual questions):\n${grounded.map((h, i) => `[${i + 1}] ${h.title}: ${(h.snippet ?? h.excerpt ?? "").slice(0, 500)}`).join("\n")}`
      : "",
    `When you are done, respond ONLY with JSON: {"intent": one of ${JSON.stringify(INTENTS)}, "reply": "<the message to send>"}.`,
    UNTRUSTED_PREAMBLE,
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
  // Only the tools offered to the model may run, however the model names them.
  const spec = RECEPTIONIST_TOOLS.includes(name) ? getTool(name) : undefined;
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

  // Every receptionist turn carries customer text, so the action firewall is always on.
  const ctx: ToolContext = { userId, runId: "receptionist", agentId: null, autonomy: "approve", tainted: true };
  if (needsApproval(spec, parsed.data, ctx)) {
    const preview = spec.preview ? spec.preview(parsed.data) : `${spec.name} ${JSON.stringify(parsed.data).slice(0, 200)}`;
    const approvalId = await insertApproval(userId, spec.name, parsed.data, preview);
    return JSON.stringify({ ok: true, queued_for_approval: true, approval_id: approvalId, summary: preview });
  }

  try {
    const result = await spec.run(ctx, parsed.data);
    if (result.ok && hasUntrustedOutput(spec)) return wrapUntrustedJson(spec.name, result.data ?? result.summary, 1000);
    return JSON.stringify({ ok: result.ok, summary: result.summary, data: result.data ?? null, error: result.error ?? null }).slice(0, 4000);
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Handle one inbound message end to end. Never throws.
 */
export async function handleInboundMessage(userId: string, msg: InboundMessage, deps: InboundDeps = {}): Promise<InboundResult> {
  const ctx = await loadContext(userId).catch(() => ({
    autoReply: false,
    companyName: "our office",
    industry: null,
    productDesc: null,
  }));

  let intent: InboundIntent = "other";
  let reply = FALLBACK_REPLY;
  let fallback = false;
  let grounding: Grounding | undefined;
  let refused = false;
  let citation = "";

  try {
    const budget = await assertBudget(userId, "receptionist");
    const hits = await (deps.retrieve ?? defaultRetrieve)(userId, msg.text.slice(0, 300)).catch(() => [] as KbHit[]);
    const pre = precheckGrounding(msg.text, hits, ctx.productDesc);
    grounding = pre.grounding;
    if (pre.refuse) {
      refused = true;
    }
    citation = citationSuffix(pre.grounded);
    const tools = refused ? [] : await loadTools();

    const messages: RouterMessage[] = [
      { role: "system", content: systemPrompt(ctx, msg.channel, pre.grounded) },
      ...(msg.history ?? [])
        .slice(-MAX_HISTORY)
        .map((h) => ({ role: h.role, content: h.role === "user" ? wrapUntrusted(`${msg.channel}_history`, h.content, { maxChars: 1500 }) : h.content })),
      { role: "user", content: wrapUntrusted(`${msg.channel}_message`, msg.text, { maxChars: 4000 }) },
    ];

    let final: { intent: InboundIntent; reply: string } | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS && !refused; round++) {
      const turn = await completeWithTools(messages, {
        tools: round < MAX_TOOL_ROUNDS ? tools : [],
        allowlist: budget.allowlist,
        maxTokens: clampMaxTokens(budget, 400),
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

    if (refused) {
      reply = HANDOFF_REPLY;
      intent = PRICE_QUESTION.test(msg.text) ? "quote" : "other";
    } else if (final) {
      intent = final.intent;
      reply = final.reply;
      if (citation && !reply.includes("Source:")) reply = `${reply}${citation}`;
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

  // Output guard: an AI-authored message must never leak secrets/internal ids; downgrade to a human.
  const guard = guardCustomerReply(reply);
  if (ctx.autoReply && intent !== "spam" && guard.ok) {
    return { reply, intent, autoSend: true, grounding };
  }

  let approvalId: string | undefined;
  try {
    approvalId = await insertApproval(
      userId,
      "messaging.reply",
      { to: msg.fromNumber, channel: msg.channel, text: reply, grounding },
      `${guard.ok ? "" : `Held by output guard (${guard.reasons.join(", ")}). `}Reply to ${msg.fromNumber} via ${msg.channel}: ${reply}`
    );
  } catch (err) {
    console.error("[receptionist] could not queue approval:", err);
  }
  return { reply, intent, autoSend: false, approvalId, grounding, ...(guard.ok ? {} : { guardReasons: guard.reasons }) };
}
