import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { formatMoney } from "@/lib/money/items";
import { cancelSubscription, loadMetrics } from "@/lib/memberships/subscriptions";
import { getSubscription, listSubscriptions } from "@/lib/memberships/store";
import { SUB_STATUSES } from "@/lib/memberships/pure";

/** Membership tools: read member status and metrics; cancel a membership (approval-gated). Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- memberships.status ---------- */
const StatusInput = z.object({
  subscription_id: z.string().max(100).optional(),
  contact_id: z.string().max(100).optional(),
  status: z.enum(SUB_STATUSES).optional(),
  q: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
registerTool<z.infer<typeof StatusInput>>({
  name: "memberships.status",
  module: "memberships",
  description: "Look up customer memberships: one by subscription_id, or list by contact_id / status (trialing, active, past_due, paused, cancelled, expired) / name or email. Also returns MRR, active members and churn for the org.",
  input: StatusInput,
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "string", description: "A single subscription id" },
      contact_id: { type: "string", description: "All memberships of one contact" },
      status: { type: "string", enum: [...SUB_STATUSES], description: "Filter by status" },
      q: { type: "string", description: "Member name, email or plan name" },
      limit: { type: "integer", description: "Max rows (default 20)" },
    },
  },
  scope: "read",
  preview: (i) => (i.subscription_id ? `Read membership ${i.subscription_id}` : `List memberships${i.status ? ` (${i.status})` : ""}`),
  async run(ctx, input) {
    try {
      if (input.subscription_id) {
        const s = await getSubscription(ctx.userId, input.subscription_id);
        if (!s) return fail("Membership not found");
        return { ok: true, summary: `${s.contact_name ?? s.contact_email ?? "Member"} on ${s.plan_name}: ${s.status}`, data: { subscription: s } };
      }
      const [rows, metrics] = await Promise.all([
        listSubscriptions(ctx.userId, { status: input.status ?? null, contactId: input.contact_id ?? null, q: input.q ?? null, limit: input.limit ?? 20 }),
        loadMetrics(ctx.userId),
      ]);
      const cur = metrics.primary_currency;
      return {
        ok: true,
        summary: `${rows.length} membership${rows.length === 1 ? "" : "s"}; ${metrics.active_members} active${cur ? `, MRR ${formatMoney(metrics.mrr_minor[cur] ?? 0, cur)}` : ""}, churn ${metrics.churn_pct}%`,
        data: {
          memberships: rows.map((s) => ({
            id: s.id,
            member: s.contact_name ?? s.contact_email,
            contact_id: s.contact_id,
            plan: s.plan_name,
            status: s.status,
            quantity: s.quantity,
            price: formatMoney(s.amount_minor * s.quantity, s.currency),
            next_charge_at: s.next_charge_at,
            cancel_at_period_end: s.cancel_at_period_end,
            failed_attempts: s.failed_attempts,
          })),
          metrics,
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- memberships.cancel ---------- */
const CancelInput = z.object({
  subscription_id: z.string().min(1).max(100),
  at_period_end: z.boolean().optional(),
  reason: z.string().max(300).optional(),
});
registerTool<z.infer<typeof CancelInput>>({
  name: "memberships.cancel",
  module: "memberships",
  description: "Cancel a customer's membership. By default it ends at the close of the paid period; pass at_period_end=false to end it now (access stops and any unpaid invoice is voided). Always needs approval.",
  input: CancelInput,
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "string", description: "Subscription id from memberships.status" },
      at_period_end: { type: "boolean", description: "true (default) = end when the paid period ends; false = end now" },
      reason: { type: "string", description: "Why (kept in the event log)" },
    },
    required: ["subscription_id"],
  },
  scope: "write",
  risk: "high",
  requiresApproval: true,
  preview: (i) => `Cancel membership ${i.subscription_id} ${i.at_period_end === false ? "now" : "at period end"}`,
  async run(ctx, input) {
    try {
      const s = await cancelSubscription(ctx.userId, input.subscription_id, { atPeriodEnd: input.at_period_end !== false, by: "staff", reason: input.reason ?? "cancelled by agent" });
      return { ok: true, summary: `Membership ${s.id} ${s.status === "cancelled" ? "cancelled" : "set to end at period end"}`, data: { id: s.id, status: s.status, cancel_at_period_end: s.cancel_at_period_end, ends_at: s.current_period_end } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
