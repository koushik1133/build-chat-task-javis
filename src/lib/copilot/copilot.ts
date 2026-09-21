import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { listTools, needsApproval } from "@/lib/agents/registry";
import type { RouterMessage, ToolContext, ToolSpec } from "@/lib/agents/types";
import { completeWithTools } from "@/lib/llm/router";
import { assertBudget } from "@/lib/llm/budgets";
import { recordUsage } from "@/lib/llm/metering";
import { SYSTEM_BASE } from "@/lib/prompts";
import { buildModuleContext, type CopilotModule } from "./context-builders";
// Tool modules self-register at import time; the barrel pulls them all in.
// The three below are imported directly as well until the barrel lists them.
import { ensureToolsLoaded } from "@/lib/agents/tools";
import "@/lib/agents/tools/social";
import "@/lib/agents/tools/strategy";
import "@/lib/agents/tools/agents";

/**
 * Per-module copilot: a bounded tool loop over the registry, scoped to the
 * page the user is on. Reads run immediately; writes go through the same
 * `needsApproval` gate as agents (autonomy "approve"), so anything the tool
 * marks as needing a human becomes a pending approval instead of executing.
 */

export interface CopilotHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface CopilotRequest {
  module: CopilotModule;
  message: string;
  recordId?: string;
  history?: CopilotHistoryItem[];
}

export interface CopilotToolCall {
  name: string;
  summary: string;
  ok: boolean;
}

export interface CopilotResult {
  text: string;
  toolCalls: CopilotToolCall[];
  /** Ids of approvals rows created for gated writes. */
  approvals: string[];
}

const MAX_TOOL_STEPS = 4;
const MAX_HISTORY = 10;
/** Tool result payloads are clipped before going back to the model. */
const MAX_TOOL_OUTPUT = 6000;

/** Modules whose tools are always offered alongside the page's own. */
const SHARED_MODULES = ["knowledge"] as const;
/** Modules offered when no page-specific module applies. */
const GENERAL_MODULES = ["knowledge", "comms", "tasks", "crm", "leads"] as const;

function toolsFor(module: CopilotModule): ToolSpec[] {
  const modules = new Set<string>(module === "general" ? GENERAL_MODULES : [module, ...SHARED_MODULES]);
  // comms lets the CRM/leads copilots draft and (with approval) send follow-ups.
  if (module === "crm" || module === "leads") modules.add("comms");
  const seen = new Set<string>();
  const out: ToolSpec[] = [];
  for (const m of modules) {
    for (const t of listTools({ module: m })) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        out.push(t);
      }
    }
  }
  return out;
}

function clip(v: unknown, max = MAX_TOOL_OUTPUT): string {
  let text: string;
  try {
    text = typeof v === "string" ? v : JSON.stringify(v ?? null);
  } catch {
    text = String(v);
  }
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

async function queueApproval(userId: string, spec: ToolSpec, input: unknown): Promise<string> {
  const id = randomUUID();
  const preview = spec.preview ? spec.preview(input) : `${spec.name} ${clip(input, 200)}`;
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5, 'pending')`,
    [id, userId, spec.name, JSON.stringify(input ?? {}), preview.slice(0, 500)]
  );
  return id;
}

function systemPrompt(module: CopilotModule, context: string, tools: ToolSpec[]): string {
  const toolLines = tools.map((t) => `- ${t.name} (${t.scope}${needsApprovalHint(t)}): ${t.description}`).join("\n");
  return [
    SYSTEM_BASE,
    "",
    `You are the in-app copilot for the "${module}" page. Answer from the snapshot below first; call tools when you need fresher or fuller data, or to act on the user's request.`,
    "Rules:",
    "- Use tools to act (create, update, move, schedule) instead of describing what the user should click. Confirm what you did in one or two sentences.",
    "- Some writes are queued for the user's approval rather than executed; when a tool reports that, say it is waiting in the Approvals inbox.",
    "- Never invent ids. Get them from the snapshot or a list/search tool.",
    "- Keep answers concise and concrete. Use short bullet lists for multiple items.",
    "",
    context,
    "",
    "## Available tools",
    toolLines || "(none)",
  ].join("\n");
}

function needsApprovalHint(t: ToolSpec): string {
  if (t.scope !== "write") return "";
  return t.requiresApproval === true ? ", needs approval" : "";
}

export async function runCopilot(userId: string, req: CopilotRequest): Promise<CopilotResult> {
  ensureToolsLoaded();
  const tools = toolsFor(req.module);
  const context = await buildModuleContext(userId, req.module, req.recordId);
  const ctx: ToolContext = { userId, runId: `copilot:${randomUUID()}`, agentId: null, autonomy: "approve" };

  const messages: RouterMessage[] = [{ role: "system", content: systemPrompt(req.module, context, tools) }];
  for (const h of (req.history ?? []).slice(-MAX_HISTORY)) {
    if ((h.role === "user" || h.role === "assistant") && h.content.trim()) {
      messages.push({ role: h.role, content: h.content.slice(0, 4000) });
    }
  }
  messages.push({ role: "user", content: req.message });

  const toolCalls: CopilotToolCall[] = [];
  const approvals: string[] = [];
  const specByName = new Map(tools.map((t) => [t.name, t]));
  let text = "";

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const budget = await assertBudget(userId);
    const lastStep = step === MAX_TOOL_STEPS;
    const turn = await completeWithTools(messages, {
      tools: lastStep ? undefined : tools,
      allowlist: budget.allowlist,
      maxTokens: 1200,
      temperature: 0.2,
    });
    void recordUsage(userId, {
      feature: "copilot",
      provider: turn.provider,
      model: turn.model,
      promptTokens: turn.promptTokens,
      completionTokens: turn.completionTokens,
    });

    if (turn.toolCalls.length === 0 || lastStep) {
      text = turn.content?.trim() ?? "";
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
      const spec = specByName.get(call.name);
      let result: { ok: boolean; summary: string; data?: unknown; error?: string };

      if (!spec) {
        result = { ok: false, summary: `Unknown tool ${call.name}`, error: "unknown_tool" };
      } else {
        const rawArgs = parseArgs(call.arguments);
        const parsed = rawArgs === null ? null : spec.input.safeParse(rawArgs);
        if (!parsed || !parsed.success) {
          const issues = parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : "arguments were not valid JSON";
          result = { ok: false, summary: `Invalid arguments for ${spec.name}`, error: issues };
        } else if (needsApproval(spec, parsed.data, ctx)) {
          try {
            const id = await queueApproval(userId, spec, parsed.data);
            approvals.push(id);
            result = {
              ok: true,
              summary: `Queued for approval: ${spec.preview ? spec.preview(parsed.data) : spec.name}`,
              data: { queued: true, approvalId: id, note: "Not executed yet — the user must approve it in the Approvals inbox." },
            };
          } catch (err) {
            result = { ok: false, summary: `Could not queue approval for ${spec.name}`, error: err instanceof Error ? err.message : String(err) };
          }
        } else {
          try {
            result = await spec.run(ctx, parsed.data);
          } catch (err) {
            result = { ok: false, summary: `${spec.name} failed`, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      toolCalls.push({ name: call.name, summary: result.summary, ok: result.ok });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clip({ ok: result.ok, summary: result.summary, data: result.data, error: result.error }),
      });
    }
  }

  if (!text) {
    text =
      approvals.length > 0
        ? `I queued ${approvals.length} action${approvals.length === 1 ? "" : "s"} for your approval. Review them in the Approvals inbox.`
        : toolCalls.length > 0
          ? toolCalls.map((c) => `• ${c.summary}`).join("\n")
          : "I couldn't produce a response. Please try rephrasing.";
  }

  return { text, toolCalls, approvals };
}
