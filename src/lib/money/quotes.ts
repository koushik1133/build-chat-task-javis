import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { issueShareToken } from "@/lib/share-tokens";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { computeTotals, formatMoney, parseItems, type LineItem } from "./items";

export { computeTotals } from "./items";
export type { LineItem } from "./items";

export type QuoteStatus = "draft" | "sent" | "viewed" | "accepted" | "declined" | "expired";

export const DEFAULT_TERMS_VERSION = "v1";
export const DEFAULT_TERMS_TEXT =
  "By accepting this quote you agree to the scope, pricing and validity period shown above. " +
  "Work begins once the quote is accepted and any deposit invoice is settled. " +
  "Prices exclude any charges not listed; changes to scope will be quoted separately.";

export interface QuoteRow {
  id: string;
  user_id: string;
  contact_id: string | null;
  number: string;
  status: QuoteStatus;
  currency: string;
  subtotal_minor: string | number;
  tax_minor: string | number;
  total_minor: string | number;
  valid_until: string | null;
  terms_version: string | null;
  terms_text: string | null;
  notes: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  accepted_at: string | null;
}

export interface QuoteDTO {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  number: string;
  status: QuoteStatus;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  terms_version: string | null;
  terms_text: string | null;
  notes: string | null;
  current_version: number;
  items: LineItem[];
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  accepted_at: string | null;
}

const QUOTE_COLS =
  "q.id, q.user_id, q.contact_id, q.number, q.status, q.currency, q.subtotal_minor, q.tax_minor, q.total_minor, q.valid_until, q.terms_version, q.terms_text, q.notes, q.current_version, q.created_at, q.updated_at, q.sent_at, q.accepted_at";

type JoinedRow = QuoteRow & { contact_name: string | null; contact_email: string | null; items: string | null };

function toDTO(r: JoinedRow): QuoteDTO {
  return {
    id: r.id,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    number: r.number,
    status: r.status,
    currency: r.currency,
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    total_minor: Number(r.total_minor),
    valid_until: r.valid_until,
    terms_version: r.terms_version,
    terms_text: r.terms_text,
    notes: r.notes,
    current_version: Number(r.current_version),
    items: parseItems(r.items),
    created_at: r.created_at,
    updated_at: r.updated_at,
    sent_at: r.sent_at,
    accepted_at: r.accepted_at,
  };
}

const SELECT_JOINED = `
  SELECT ${QUOTE_COLS}, c.full_name AS contact_name, c.email AS contact_email, v.items
    FROM quotes q
    LEFT JOIN crm_contacts c ON c.id = q.contact_id
    LEFT JOIN quote_versions v ON v.quote_id = q.id AND v.version = q.current_version`;

export async function listQuotes(dataId: string, opts: { status?: string; limit?: number } = {}): Promise<QuoteDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${SELECT_JOINED} WHERE q.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND q.status = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY q.created_at DESC LIMIT $${params.length}`;
  const rows = await query<JoinedRow>(sql, params);
  return rows.map(toDTO);
}

export async function getQuote(dataId: string, id: string): Promise<QuoteDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT_JOINED} WHERE q.id = $1 AND q.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

/** Public lookup by id only (share-token routes resolve ownership first). */
export async function getQuoteById(id: string): Promise<QuoteDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT_JOINED} WHERE q.id = $1`, [id]);
  return row ? toDTO(row) : null;
}

export interface CreateQuoteInput {
  contact_id?: string | null;
  currency?: string;
  items: LineItem[];
  valid_until?: string | null;
  terms_text?: string | null;
  terms_version?: string | null;
  notes?: string | null;
}

export async function createQuote(dataId: string, input: CreateQuoteInput): Promise<QuoteDTO> {
  if (input.contact_id) {
    const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [input.contact_id, dataId]);
    if (!c) throw new Error("Contact not found");
  }
  const id = randomUUID();
  const number = await nextDocNumber(dataId, "quote");
  const totals = computeTotals(input.items);
  const currency = (input.currency ?? "USD").toUpperCase();
  await query(
    `INSERT INTO quotes (id, user_id, contact_id, number, status, currency, subtotal_minor, tax_minor, total_minor,
       valid_until, terms_version, terms_text, notes, current_version)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, 1)`,
    [
      id, dataId, input.contact_id ?? null, number, currency,
      totals.subtotal_minor, totals.tax_minor, totals.total_minor,
      input.valid_until ?? null,
      input.terms_version ?? DEFAULT_TERMS_VERSION,
      input.terms_text ?? DEFAULT_TERMS_TEXT,
      input.notes ?? null,
    ]
  );
  await query(
    `INSERT INTO quote_versions (id, quote_id, version, items, subtotal_minor, tax_minor, total_minor)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [randomUUID(), id, JSON.stringify(input.items), totals.subtotal_minor, totals.tax_minor, totals.total_minor]
  );
  const q = await getQuote(dataId, id);
  if (!q) throw new Error("Quote vanished after insert");
  return q;
}

export interface UpdateQuoteInput {
  contact_id?: string | null;
  currency?: string;
  items?: LineItem[];
  valid_until?: string | null;
  terms_text?: string | null;
  notes?: string | null;
}

/** Edit a quote. Items changes append a new immutable version. Only draft/sent/viewed quotes are editable. */
export async function updateQuote(dataId: string, id: string, input: UpdateQuoteInput): Promise<QuoteDTO> {
  const q = await getQuote(dataId, id);
  if (!q) throw new Error("Quote not found");
  if (q.status === "accepted" || q.status === "declined") throw new Error(`Quote is ${q.status} and cannot be edited`);

  if (input.items) await updateQuoteItems(dataId, id, input.items);

  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.contact_id !== undefined) push("contact_id", input.contact_id);
  if (input.currency !== undefined) push("currency", input.currency.toUpperCase());
  if (input.valid_until !== undefined) push("valid_until", input.valid_until);
  if (input.terms_text !== undefined) push("terms_text", input.terms_text);
  if (input.notes !== undefined) push("notes", input.notes);
  await query(`UPDATE quotes SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);

  const out = await getQuote(dataId, id);
  if (!out) throw new Error("Quote not found");
  return out;
}

/** Append a new version with the given items and bump current_version (race-safe). */
export async function updateQuoteItems(dataId: string, id: string, items: LineItem[]): Promise<number> {
  const totals = computeTotals(items);
  return withRetry(async () => {
    const cur = await queryOne<{ current_version: number }>(
      `SELECT current_version FROM quotes WHERE id = $1 AND user_id = $2`,
      [id, dataId]
    );
    if (!cur) throw new Error("Quote not found");
    const next = Number(cur.current_version) + 1;
    const bumped = await query(
      `UPDATE quotes SET current_version = $3, subtotal_minor = $4, tax_minor = $5, total_minor = $6, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND current_version = $7 RETURNING id`,
      [id, dataId, next, totals.subtotal_minor, totals.tax_minor, totals.total_minor, Number(cur.current_version)]
    );
    if (bumped.length === 0) {
      const e = new Error("version race (OC000)");
      throw e;
    }
    await query(
      `INSERT INTO quote_versions (id, quote_id, version, items, subtotal_minor, tax_minor, total_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), id, next, JSON.stringify(items), totals.subtotal_minor, totals.tax_minor, totals.total_minor]
    );
    return next;
  });
}

export async function deleteDraftQuote(dataId: string, id: string): Promise<boolean> {
  const q = await getQuote(dataId, id);
  if (!q) return false;
  if (q.status !== "draft") throw new Error("Only draft quotes can be deleted");
  await query(`DELETE FROM quote_versions WHERE quote_id = $1`, [id]);
  await query(`DELETE FROM quotes WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

export async function businessName(dataId: string): Promise<string> {
  const org = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
  return org?.name ?? "Your provider";
}

/** Issue a share link, mark sent and queue the email to the contact (or explicit recipient). */
export async function sendQuote(
  dataId: string,
  id: string,
  opts: { to?: string | null; message?: string | null } = {}
): Promise<{ quote: QuoteDTO; url: string; path: string }> {
  const q = await getQuote(dataId, id);
  if (!q) throw new Error("Quote not found");
  if (q.status === "accepted" || q.status === "declined") throw new Error(`Quote is already ${q.status}`);
  if (q.items.length === 0) throw new Error("Add at least one line item before sending");
  const to = (opts.to ?? q.contact_email ?? "").trim();
  if (!to) throw new Error("No recipient email: set one on the contact or pass `to`");

  const link = await issueShareToken(dataId, "quote", id, 60);
  const from = await businessName(dataId);
  await query(
    `UPDATE quotes SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, dataId]
  );
  await enqueueNotification(dataId, {
    channel: "email",
    recipient: to,
    subject: `Quote ${q.number} from ${from}`,
    body:
      `${opts.message?.trim() ? opts.message.trim() + "\n\n" : ""}` +
      `${from} has sent you quote ${q.number} for ${formatMoney(q.total_minor, q.currency)}.\n\n` +
      `Review and accept it here: ${link.url}\n\n` +
      (q.valid_until ? `This quote is valid until ${new Date(q.valid_until).toDateString()}.\n` : ""),
    data: { kind: "quote", quote_id: id, number: q.number, url: link.url },
  });
  const out = await getQuote(dataId, id);
  return { quote: out ?? q, url: link.url, path: link.path };
}

/** Mark a sent quote as viewed (public page hit). No-op for other statuses. */
export async function markQuoteViewed(id: string): Promise<void> {
  await query(`UPDATE quotes SET status = 'viewed', updated_at = NOW() WHERE id = $1 AND status = 'sent'`, [id]).catch(() => undefined);
}

export function quoteIsExpired(q: Pick<QuoteDTO, "valid_until" | "status">): boolean {
  return Boolean(q.valid_until && new Date(q.valid_until).getTime() < Date.now() && q.status !== "accepted");
}
