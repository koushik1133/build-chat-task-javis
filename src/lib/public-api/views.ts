import { parseTags, type TicketMessageRow, type TicketRow } from "@/lib/helpdesk/tickets";

/** Public views of rows that carry internal columns. */

const TICKET_INTERNAL = new Set(["user_id", "sla_policy_id", "conversation_id", "escalated_at"]);

function omit<T extends object>(row: T, keys: ReadonlySet<string>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row)) if (!keys.has(k)) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function ticketView(t: TicketRow) {
  return { ...(omit(t, TICKET_INTERNAL) as Omit<TicketRow, "user_id" | "sla_policy_id" | "conversation_id" | "escalated_at" | "tags">), tags: parseTags(t.tags) };
}

export function ticketMessageView(m: TicketMessageRow): Omit<TicketMessageRow, "user_id"> {
  return omit(m, new Set(["user_id"])) as Omit<TicketMessageRow, "user_id">;
}
