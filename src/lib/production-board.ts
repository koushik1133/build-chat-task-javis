/** Shared Kanban column + HITL move rules (client + server). */

export type BoardColumn = { id: string; label: string; hitl: boolean; color: string };

export function parseBoardColumns(raw: unknown): BoardColumn[] {
  if (Array.isArray(raw)) return raw as BoardColumn[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as BoardColumn[]; } catch { return []; }
  }
  return [];
}

export function colById(cols: BoardColumn[], id: string) {
  return cols.find(c => c.id === id);
}

/** Whether a drag/menu move is allowed without clicking Approve. */
export function validateMove(
  cols: BoardColumn[],
  fromId: string,
  toId: string
): { ok: true } | { ok: false; reason: string } {
  if (fromId === toId) return { ok: true };
  const from = colById(cols, fromId);
  const to = colById(cols, toId);
  if (!from || !to) return { ok: false, reason: "Unknown column." };
  if (from.hitl) {
    return {
      ok: false,
      reason: `"${from.label}" is a HITL gate — use Approve or Reject.`,
    };
  }
  return { ok: true };
}

/** Automations fire only after approved exit from HITL or normal non-HITL moves. */
export function shouldFireAutomations(
  cols: BoardColumn[],
  fromId: string,
  toId: string,
  viaApproval: boolean
): boolean {
  if (fromId === toId) return false;
  const from = colById(cols, fromId);
  const to = colById(cols, toId);
  if (!from || !to) return false;
  if (to.hitl) return false;
  if (from.hitl) return viaApproval;
  return true;
}

export function nextColumn(cols: BoardColumn[], currentId: string): BoardColumn | null {
  const idx = cols.findIndex(c => c.id === currentId);
  return idx >= 0 && idx < cols.length - 1 ? cols[idx + 1] : null;
}

export function sortByPriority<T extends { priority: string }>(items: T[]): T[] {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...items].sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));
}
