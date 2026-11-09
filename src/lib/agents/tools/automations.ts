import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { getAutomation, installTemplate, listAutomations, setEnabled, toAutomationDTO } from "@/lib/automations/store";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";

/** Automations v2 tools: list, toggle, install a template. All scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- automations.list ---------- */
const ListInput = z.object({ enabled: z.boolean().optional(), trigger_type: z.enum(["event", "schedule", "webhook", "manual"]).optional() });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "automations.list",
  module: "automations",
  description: "List the workspace's automations (event-driven workflows) with trigger, enabled state, run and error counts.",
  input: ListInput,
  parameters: { type: "object", properties: { enabled: { type: "boolean" }, trigger_type: { type: "string", enum: ["event", "schedule", "webhook", "manual"] } } },
  scope: "read",
  preview: (i) => `List ${i.enabled === undefined ? "all" : i.enabled ? "enabled" : "disabled"} automations`,
  async run(ctx, input) {
    try {
      const rows = await listAutomations(ctx.userId, { enabled: input.enabled ?? null, triggerType: input.trigger_type ?? null, limit: 100 });
      const data = rows.map(toAutomationDTO).map((a) => ({
        id: a.id,
        name: a.name,
        trigger_type: a.trigger_type,
        event_type: a.trigger_config.event_type ?? null,
        enabled: a.enabled,
        autonomy: a.autonomy,
        steps: a.steps.length,
        run_count: a.run_count,
        error_count: a.error_count,
        last_run_at: a.last_run_at,
        last_error: a.last_error,
      }));
      return { ok: true, data, summary: `Found ${data.length} automation(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- automations.toggle ---------- */
const ToggleInput = z.object({ id: z.string().min(1).max(100), enabled: z.boolean() });
type ToggleInputT = z.infer<typeof ToggleInput>;

registerTool<ToggleInputT>({
  name: "automations.toggle",
  module: "automations",
  description: "Enable or disable an automation by id.",
  input: ToggleInput,
  parameters: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `${i.enabled ? "Enable" : "Disable"} automation ${i.id}`,
  async run(ctx, input) {
    try {
      const existing = await getAutomation(ctx.userId, input.id);
      if (!existing) return fail("Automation not found");
      const row = await setEnabled(ctx.userId, input.id, input.enabled);
      if (!row) return fail("Automation not found");
      const dto = toAutomationDTO(row);
      return { ok: true, data: { id: dto.id, name: dto.name, enabled: dto.enabled }, summary: `${dto.enabled ? "Enabled" : "Disabled"} "${dto.name}"` };
    } catch (err) {
      return fail(`Toggle failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- automations.install_template ---------- */
const InstallInput = z.object({ key: z.enum(AUTOMATION_TEMPLATES.map((t) => t.key) as [string, ...string[]]) });
type InstallInputT = z.infer<typeof InstallInput>;

registerTool<InstallInputT>({
  name: "automations.install_template",
  module: "automations",
  description: `Install a ready-made automation template (installed paused so the user can review it). Keys: ${AUTOMATION_TEMPLATES.map((t) => t.key).join(", ")}.`,
  input: InstallInput,
  parameters: { type: "object", properties: { key: { type: "string", enum: AUTOMATION_TEMPLATES.map((t) => t.key) } }, required: ["key"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Install automation template "${i.key}"`,
  async run(ctx, input) {
    try {
      const { row, swapped } = await installTemplate(ctx.userId, input.key);
      const dto = toAutomationDTO(row);
      return {
        ok: true,
        data: { id: dto.id, name: dto.name, enabled: dto.enabled, swapped_tool: swapped },
        summary: `Installed "${dto.name}" (paused${swapped ? `; ${swapped} not available, used a task instead` : ""}). Review and enable it at /automations/${dto.id}.`,
      };
    } catch (err) {
      return fail(`Install failed: ${errMsg(err)}`);
    }
  },
});
