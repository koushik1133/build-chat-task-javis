import { query, queryOne } from "@/lib/dsql";
import { parseBoardColumns, type BoardColumn } from "@/lib/production-board";

export { fireKanbanAutomations } from "@/lib/automation-runner";

export async function getUserBoardColumns(userId: string): Promise<BoardColumn[]> {
  const cfg = await queryOne<{ columns: string }>(
    "SELECT columns FROM board_configs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId]
  ).catch(() => null);
  return cfg ? parseBoardColumns(cfg.columns) : [];
}

export async function logProductionActivity(
  userId: string,
  taskId: string,
  action: string,
  details: Record<string, unknown> = {}
) {
  await query(
    `INSERT INTO production_activity (task_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [taskId, userId, action, JSON.stringify(details)]
  ).catch(() => {});
}
