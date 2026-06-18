import { query, queryOne } from "@/lib/dsql";
import {
  executeAutomationAction,
  parseActionConfig,
  type ActionConfig,
  type AutomationContext,
  type ExecuteResult,
} from "@/lib/automation-executor";
import { getUserIntegrations, mergeActionWithIntegrations, type UserIntegrations } from "@/lib/user-integrations";

type AutoRow = {
  id: string;
  name: string;
  action_type: string;
  action_config: string | null;
  trigger_event: string;
};

export async function runAutomation(
  userId: string,
  row: AutoRow,
  ctx: Omit<AutomationContext, "user_id" | "workflow_name" | "trigger">,
  prefetchedIntegrations?: UserIntegrations | null
): Promise<ExecuteResult & { id: string; name: string; action: string }> {
  const config = parseActionConfig(row.action_config);
  const integrations = prefetchedIntegrations !== undefined ? prefetchedIntegrations : await getUserIntegrations(userId);
  const mergedConfig = mergeActionWithIntegrations(row.action_type, config, integrations) as ActionConfig;
  const fullCtx: AutomationContext = {
    user_id: userId,
    workflow_name: row.name,
    trigger: row.trigger_event,
    automation_id: row.id,
    ...ctx,
  };

  const result = await executeAutomationAction(row.action_type, mergedConfig, fullCtx, integrations);

  // Don't block delivery on bookkeeping — email/Slack already sent.
  void query(
    `UPDATE automations SET run_count = run_count + 1, last_run = NOW(), last_result = $1 WHERE id = $2`,
    [JSON.stringify(result), row.id]
  ).catch(() => {});

  return { id: row.id, name: row.name, action: row.action_type, ...result };
}

export async function fireKanbanAutomations(
  userId: string,
  label: string,
  context: {
    task_title: string;
    to_column: string;
    from_column?: string;
    via_approval?: boolean;
  }
) {
  const matched = await query(
    `SELECT id, name, action_type, action_config, trigger_event FROM automations
     WHERE user_id = $1 AND status = 'active' AND kanban_label = $2`,
    [userId, label]
  ).catch(() => []);

  const rows = matched as AutoRow[];
  if (rows.length === 0) return [];

  // Fetch integrations once for the entire batch
  const integrations = await getUserIntegrations(userId);

  const promises = rows.map((row) =>
    runAutomation(userId, row, {
      task_title: context.task_title,
      from_column: context.from_column,
      to_column: context.to_column,
      kanban_label: label,
      via_approval: context.via_approval,
    }, integrations)
  );

  const settled = await Promise.allSettled(promises);
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      id: rows[i].id,
      name: rows[i].name,
      action: rows[i].action_type,
      success: false,
      message: "Execution failed",
      detail: String(r.reason),
    };
  });
}

export async function getAutomationById(userId: string, id: string): Promise<AutoRow | null> {
  return queryOne<AutoRow>(
    `SELECT id, name, action_type, action_config, trigger_event FROM automations WHERE id = $1 AND user_id = $2`,
    [id, userId]
  ).catch(() => null);
}
