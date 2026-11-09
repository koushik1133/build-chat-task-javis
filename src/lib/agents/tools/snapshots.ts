import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { applySnapshot, getSnapshotDoc, listSnapshots } from "@/lib/snapshots/store";
import { SECTION_KEYS } from "@/lib/snapshots/types";

/** Snapshot tools: list and apply configuration snapshots. Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ListInput = z.object({});
registerTool<z.infer<typeof ListInput>>({
  name: "snapshots.list",
  module: "snapshots",
  description: "List configuration snapshots available to this workspace (its own and any shared by its agency). Returns ids for snapshots.apply.",
  input: ListInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "List workspace snapshots",
  async run(ctx) {
    try {
      const rows = await listSnapshots(ctx.userId);
      return { ok: true, data: rows.map((s) => ({ id: s.id, name: s.name, sections: s.sections, origin: s.origin, created_at: s.created_at })), summary: `${rows.length} snapshot${rows.length === 1 ? "" : "s"}` };
    } catch (err) {
      return fail(`Could not list snapshots: ${errMsg(err)}`);
    }
  },
});

const ApplyInput = z.object({
  snapshot_id: z.string().min(1).max(80),
  sections: z.array(z.enum(SECTION_KEYS)).max(SECTION_KEYS.length).optional(),
  mode: z.enum(["merge", "skip_existing"]).optional(),
});
type ApplyT = z.infer<typeof ApplyInput>;
registerTool<ApplyT>({
  name: "snapshots.apply",
  module: "snapshots",
  description: "Apply a configuration snapshot to this workspace (record types, templates, tax rates, SLA policies, automations (paused) and more). Never copies data. Idempotent; default mode skip_existing never overwrites.",
  input: ApplyInput,
  parameters: {
    type: "object",
    properties: {
      snapshot_id: { type: "string", description: "Snapshot id from snapshots.list" },
      sections: { type: "array", items: { type: "string", enum: [...SECTION_KEYS] }, description: "Limit to these sections (default all in the snapshot)" },
      mode: { type: "string", enum: ["merge", "skip_existing"] },
    },
    required: ["snapshot_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Apply snapshot ${i.snapshot_id}${i.sections?.length ? ` (${i.sections.join(", ")})` : ""} in ${i.mode ?? "skip_existing"} mode`,
  async run(ctx, input) {
    try {
      const found = await getSnapshotDoc(ctx.userId, input.snapshot_id);
      if (!found) return fail("Snapshot not found");
      const r = await applySnapshot(ctx.userId, found.doc, { sections: input.sections, mode: input.mode, actorId: null, snapshotId: found.meta.id, snapshotSha: found.meta.sha256 });
      return { ok: r.status !== "failed", data: { created: r.created, updated: r.updated, skipped: r.skipped, errors: r.errors, status: r.status }, summary: `Applied "${found.meta.name}": ${r.created} created, ${r.updated} updated, ${r.skipped} skipped, ${r.errors.length} errors` };
    } catch (err) {
      return fail(`Apply failed: ${errMsg(err)}`);
    }
  },
});
