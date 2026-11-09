import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { getLink, listConnectedForUser, listConnections, listSyncLog } from "@/lib/accounting/connections";
import { pushEntity } from "@/lib/accounting/sync";
import { getInvoice } from "@/lib/money/invoices";

/** Accounting tools: inspect sync state, push an invoice (gated). Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- accounting.sync_status ---------- */
const StatusInput = z.object({
  invoice_id: z.string().max(100).optional().describe("When given, include this invoice's link state per connection"),
  recent_errors: z.number().int().min(0).max(50).optional(),
});
registerTool<z.infer<typeof StatusInput>>({
  name: "accounting.sync_status",
  module: "billing",
  description: "Show connected accounting systems (QuickBooks / Xero / simulated), their last sync, link counts and recent errors; optionally the sync state of one invoice.",
  input: StatusInput,
  parameters: {
    type: "object",
    properties: {
      invoice_id: { type: "string", description: "Invoice id to report on (optional)" },
      recent_errors: { type: "integer", description: "How many recent error log lines per connection (default 5)" },
    },
  },
  scope: "read",
  preview: (i) => `Accounting sync status${i.invoice_id ? ` for invoice ${i.invoice_id}` : ""}`,
  async run(ctx, input) {
    try {
      const connections = await listConnections(ctx.userId);
      if (connections.length === 0) return { ok: true, data: { connections: [] }, summary: "No accounting system is connected. Connect one under Settings → Accounting." };
      const out = [];
      for (const c of connections) {
        const errors = await listSyncLog(ctx.userId, c.id, { status: "error", limit: input.recent_errors ?? 5 });
        const invoice = input.invoice_id ? await getLink(c.id, "invoice", input.invoice_id) : null;
        out.push({
          id: c.id, provider: c.provider, company: c.company_name, status: c.status, last_sync_at: c.last_sync_at, last_error: c.last_error, counts: c.counts,
          recent_errors: errors.map((e) => ({ at: e.created_at, kind: e.entity_kind, entity_id: e.entity_id, message: e.message })),
          invoice: input.invoice_id ? (invoice ? { state: invoice.error ? "error" : invoice.remote_id ? "synced" : "pending", remote_id: invoice.remote_id, last_pushed_at: invoice.last_pushed_at, error: invoice.error } : { state: "not_linked" }) : undefined,
        });
      }
      const summary = out.map((c) => `${c.provider}${c.company ? ` (${c.company})` : ""}: ${c.status}, ${c.counts.linked} linked, ${c.counts.errors} errors${c.invoice ? `, invoice ${c.invoice.state}` : ""}`).join("; ");
      return { ok: true, data: { connections: out }, summary };
    } catch (err) {
      return fail(`Status failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- accounting.push_invoice ---------- */
const PushInput = z.object({
  invoice_id: z.string().min(1).max(100),
  connection_id: z.string().max(100).optional().describe("Push to one connection only; default all connected"),
});
registerTool<z.infer<typeof PushInput>>({
  name: "accounting.push_invoice",
  module: "billing",
  description: "Push an invoice (with its customer) to the connected accounting system(s) now. Draft invoices are pushed as drafts. Needs approval.",
  input: PushInput,
  parameters: {
    type: "object",
    properties: {
      invoice_id: { type: "string", description: "Invoice id" },
      connection_id: { type: "string", description: "Connection id (optional)" },
    },
    required: ["invoice_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Push invoice ${i.invoice_id} to accounting${i.connection_id ? ` (connection ${i.connection_id})` : ""}`,
  async run(ctx, input) {
    try {
      const inv = await getInvoice(ctx.userId, input.invoice_id);
      if (!inv) return fail("Invoice not found");
      const conns = (await listConnectedForUser(ctx.userId)).filter((c) => !input.connection_id || c.id === input.connection_id);
      if (conns.length === 0) return fail(input.connection_id ? "That connection is not available" : "No accounting system is connected");
      const results = [];
      for (const c of conns) results.push({ connection_id: c.id, provider: c.provider, ...(await pushEntity(c.id, "invoice", inv.id, { force: true })) });
      const ok = results.filter((r) => r.status === "ok").length;
      const errors = results.filter((r) => r.status === "error");
      return {
        ok: errors.length < results.length,
        data: { invoice: inv.number, results },
        summary: `Invoice ${inv.number}: ${ok} pushed, ${results.length - ok - errors.length} unchanged, ${errors.length} failed${errors.length ? ` (${errors.map((e) => e.message).join("; ")})` : ""}`,
        error: errors.length === results.length ? errors[0]?.message : undefined,
      };
    } catch (err) {
      return fail(`Push failed: ${errMsg(err)}`);
    }
  },
});
