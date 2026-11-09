import { guardCustomerReply } from "@/lib/ai/output-guard";
import type { ToolContext, ToolSpec } from "./types";

/**
 * The single registry of tools an agent can call.
 *
 * The agent loop, the per-module copilots and the MCP server all read from
 * here, so a tool exists in one place or nowhere. Modules register at import
 * time via `registerTool`; `src/lib/agents/tools/index.ts` imports them all.
 */

const tools = new Map<string, ToolSpec>();

export function registerTool<T>(spec: ToolSpec<T>): ToolSpec<T> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(spec.name)) {
    throw new Error(`Tool name must look like "module.action": ${spec.name}`);
  }
  if (tools.has(spec.name)) {
    // Hot reload in dev re-imports modules; the latest definition wins.
    tools.delete(spec.name);
  }
  tools.set(spec.name, spec as ToolSpec);
  return spec;
}

export function getTool(name: string): ToolSpec | undefined {
  return tools.get(name);
}

export interface ToolFilter {
  /** Restrict to these names (an agent's allowlist). */
  names?: string[] | null;
  /** Restrict to one module (a copilot's scope). */
  module?: string;
  scope?: "read" | "write";
}

export function listTools(filter: ToolFilter = {}): ToolSpec[] {
  let out = [...tools.values()];
  if (filter.names && filter.names.length > 0) {
    const allow = new Set(filter.names);
    out = out.filter((t) => allow.has(t.name));
  }
  if (filter.module) out = out.filter((t) => t.module === filter.module);
  if (filter.scope) out = out.filter((t) => t.scope === filter.scope);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type ToolRisk = "low" | "medium" | "high";

/** External sends, money movement, deletion, publishing and access changes. */
const HIGH_RISK_TOOLS = new Set([
  "comms.send_email", "messaging.reply", "helpdesk.reply", "billing.send_quote", "billing.issue_credit_note",
  "accounting.push_invoice", "accounting.push", "documents.send", "voice.start_campaign", "social.publish_post",
  "marketing.enroll", "marketing.launch", "chat.send", "records.delete", "marketplace.install", "procurement.create_po",
  "privacy.open_request", "kb.publish_article",
  // Configuration / standing-rule / bulk-state changes that a customer must never be able to steer.
  "snapshots.apply", "automations.install_template", "automations.toggle", "billing.create_recurring",
  "orders.fulfil", "orders.unfulfil", "social.schedule_post", "inventory.adjust_stock", "agents.run_agent",
  "calendar.cancel_booking", "calendar.reschedule",
]);
const HIGH_RISK_ACTION = /^(send|refund|void|delete|erase|purge|launch|push|invite|grant|revoke|set_role|decide|approve|create_api_key|create_webhook|create_key)/;
const UNTRUSTED_OUTPUT_TOOLS = new Set([
  "helpdesk.get_ticket", "helpdesk.list_tickets", "crm.get_contact", "crm.search_contacts", "webchat.sessions",
  "records.search", "messaging.list", "mail.read", "mail.search",
  // Read tools that surface customer-typed names, notes, order comments or document text.
  "orders.list", "billing.list_invoices", "billing.list_quotes", "billing.statement", "documents.status", "reports.run",
  "tasks.list", "knowledge.search", "production.list_cards", "projects.list", "projects.status", "social.list_posts",
]);

/** Effective risk: explicit spec value, else name-based classification (reads are low). */
export function riskOf(spec: ToolSpec): ToolRisk {
  if (spec.risk) return spec.risk;
  if (spec.scope === "read") return "low";
  const action = spec.name.split(".")[1] ?? "";
  if (HIGH_RISK_TOOLS.has(spec.name) || HIGH_RISK_ACTION.test(action)) return "high";
  return "medium";
}

/** Whether the tool's result carries external text that must be wrapped. */
export function hasUntrustedOutput(spec: ToolSpec): boolean {
  return spec.untrustedOutput === true || UNTRUSTED_OUTPUT_TOOLS.has(spec.name) || spec.name.startsWith("leads.");
}

/** True when the action firewall (not the autonomy level) is what forces approval. */
export function taintForcesApproval(spec: ToolSpec, ctx: ToolContext): boolean {
  return ctx.tainted === true && spec.scope === "write" && riskOf(spec) === "high";
}

/** Tools whose text argument goes to a customer/public audience. */
const OUTBOUND_TEXT_TOOLS = new Set([
  "comms.send_email", "messaging.reply", "helpdesk.reply", "social.publish_post", "social.schedule_post", "documents.send",
  "chat.send", "billing.send_quote", "marketing.launch", "marketing.enroll",
]);
const TEXT_FIELDS = ["body", "text", "message", "content", "html", "caption", "subject", "note"];

/** True when an outbound-text tool's argument fails the customer-reply output guard (leaked keys/prompt/ids). */
export function outboundTextUnsafe(spec: ToolSpec, input: unknown): boolean {
  if (!OUTBOUND_TEXT_TOOLS.has(spec.name) || !input || typeof input !== "object") return false;
  for (const f of TEXT_FIELDS) {
    const v = (input as Record<string, unknown>)[f];
    if (typeof v !== "string" || !v.trim()) continue;
    // Only secrecy/leak checks matter here; length and emptiness are the tool's own business.
    const g = guardCustomerReply(v, { maxChars: 100_000 });
    if (!g.ok) return true;
  }
  return false;
}

export const TAINT_REASON = "Requires approval: run contains customer-supplied content";

/** Decide whether a call must pause for a human, given the agent's autonomy. */
export function needsApproval(spec: ToolSpec, input: unknown, ctx: ToolContext): boolean {
  if (taintForcesApproval(spec, ctx)) return true;
  if (spec.scope === "write" && outboundTextUnsafe(spec, input)) return true;
  if (ctx.autonomy === "draft") return spec.scope === "write";
  if (ctx.autonomy === "auto") return false;
  // "approve": defer to the tool's own rule; default write tools to gated.
  const rule = spec.requiresApproval;
  if (typeof rule === "function") return rule(input, ctx);
  if (typeof rule === "boolean") return rule;
  return spec.scope === "write";
}

/** OpenAI-compatible `tools` array for the model. */
export function toOpenAiTools(specs: ToolSpec[]) {
  return specs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name.replace(".", "__"), // OpenAI-compatible names can't contain "."
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Reverse of the name mangling in `toOpenAiTools`. */
export function fromOpenAiToolName(name: string): string {
  return name.replace("__", ".");
}
