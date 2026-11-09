import { isUndefinedColumn, query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";

/**
 * Customer statements: opening balance, dated entries (invoices, payments,
 * refunds, credit notes) and closing balance for a period, per currency.
 *
 * Sign convention: invoices increase what the customer owes; payments and
 * credit notes decrease it; refunds increase it again. Draft and void
 * invoices (and draft credit notes) are excluded.
 */

export type StatementEntryKind = "invoice" | "payment" | "refund" | "credit_note";

export interface StatementEntry {
  date: string;
  kind: StatementEntryKind;
  ref: string;
  description: string;
  currency: string;
  /** Signed effect on the balance (minor units): + owed, − credited. */
  amount_minor: number;
  invoice_id: string | null;
  entity_id: string;
}

export interface StatementBalance {
  currency: string;
  opening_minor: number;
  invoiced_minor: number;
  paid_minor: number;
  credited_minor: number;
  refunded_minor: number;
  closing_minor: number;
}

export interface Statement {
  contact: { id: string; name: string; email: string | null; company: string | null; tax_number: string | null; billing_address: string | null };
  from: string;
  to: string;
  entries: Array<StatementEntry & { running_minor: number }>;
  balances: StatementBalance[];
  generated_at: string;
}

/** Pure: split entries into opening (before `from`) and the period, with running balances per currency. */
export function computeStatement(entries: readonly StatementEntry[], from: Date, to: Date): Pick<Statement, "entries" | "balances"> {
  const sorted = [...entries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.ref.localeCompare(b.ref));
  const per = new Map<string, StatementBalance>();
  const bal = (cur: string): StatementBalance => {
    let b = per.get(cur);
    if (!b) {
      b = { currency: cur, opening_minor: 0, invoiced_minor: 0, paid_minor: 0, credited_minor: 0, refunded_minor: 0, closing_minor: 0 };
      per.set(cur, b);
    }
    return b;
  };
  const running = new Map<string, number>();
  const out: Statement["entries"] = [];
  for (const e of sorted) {
    const t = new Date(e.date).getTime();
    const b = bal(e.currency);
    if (t < from.getTime()) {
      b.opening_minor += e.amount_minor;
      continue;
    }
    if (t > to.getTime()) continue;
    if (e.kind === "invoice") b.invoiced_minor += e.amount_minor;
    else if (e.kind === "payment") b.paid_minor += -e.amount_minor;
    else if (e.kind === "credit_note") b.credited_minor += -e.amount_minor;
    else b.refunded_minor += e.amount_minor;
    const prev = running.get(e.currency) ?? b.opening_minor;
    const next = prev + e.amount_minor;
    running.set(e.currency, next);
    out.push({ ...e, running_minor: next });
  }
  const balances = [...per.values()].map((b) => ({
    ...b,
    closing_minor: b.opening_minor + b.invoiced_minor - b.paid_minor - b.credited_minor + b.refunded_minor,
  }));
  balances.sort((a, b) => a.currency.localeCompare(b.currency));
  return { entries: out, balances };
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Every balance-affecting entry for a contact (all time). */
export async function loadStatementEntries(dataId: string, contactId: string): Promise<StatementEntry[]> {
  const entries: StatementEntry[] = [];
  const invoices = await query<{ id: string; number: string; currency: string; total_minor: string; issued: Date | string }>(
    `SELECT id, number, currency, total_minor, COALESCE(sent_at, created_at) AS issued FROM invoices
      WHERE user_id = $1 AND contact_id = $2 AND status NOT IN ('draft', 'void')`,
    [dataId, contactId]
  );
  for (const i of invoices) {
    entries.push({ date: iso(i.issued), kind: "invoice", ref: i.number, description: `Invoice ${i.number}`, currency: i.currency, amount_minor: Number(i.total_minor), invoice_id: i.id, entity_id: i.id });
  }
  if (invoices.length > 0) {
    type PayRow = { id: string; invoice_id: string; number: string; provider: string; amount_minor: string; currency: string; created_at: Date | string; refunded_minor: string | null; refunded_at: Date | string | null };
    const payWhere = `FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.user_id = $1 AND i.contact_id = $2 AND p.status = 'succeeded'`;
    // Pre-migration deployments lack the refund columns: fall back to a refund-less read rather
    // than dropping every payment (which would show a fully paid customer as owing everything).
    const pays = await query<PayRow>(
      `SELECT p.id, p.invoice_id, i.number, p.provider, p.amount_minor, p.currency, p.created_at, p.refunded_minor, p.refunded_at ${payWhere}`,
      [dataId, contactId]
    ).catch((err: unknown) => {
      if (!isUndefinedColumn(err)) throw err;
      return query<PayRow>(
        `SELECT p.id, p.invoice_id, i.number, p.provider, p.amount_minor, p.currency, p.created_at, NULL::bigint AS refunded_minor, NULL::timestamptz AS refunded_at ${payWhere}`,
        [dataId, contactId]
      );
    });
    for (const p of pays) {
      entries.push({ date: iso(p.created_at), kind: "payment", ref: p.number, description: `Payment (${p.provider}) on ${p.number}`, currency: p.currency, amount_minor: -Number(p.amount_minor), invoice_id: p.invoice_id, entity_id: p.id });
      const refunded = Number(p.refunded_minor ?? 0);
      if (refunded > 0) {
        entries.push({ date: iso(p.refunded_at ?? p.created_at), kind: "refund", ref: p.number, description: `Refund on ${p.number}`, currency: p.currency, amount_minor: refunded, invoice_id: p.invoice_id, entity_id: `${p.id}:refund` });
      }
    }
  }
  if (await tableExists("credit_notes")) {
    const notes = await query<{ id: string; number: string; currency: string; total_minor: string; invoice_id: string | null; issued_at: Date | string; status: string }>(
      `SELECT id, number, currency, total_minor, invoice_id, COALESCE(issued_at, created_at) AS issued_at, status FROM credit_notes
        WHERE user_id = $1 AND status <> 'draft' AND (contact_id = $2 OR invoice_id IN (SELECT id FROM invoices WHERE user_id = $1 AND contact_id = $2))`,
      [dataId, contactId]
    );
    for (const n of notes) {
      // A refunded credit note returned the money: the refund row already re-adds it, so the credit still counts.
      entries.push({ date: iso(n.issued_at), kind: "credit_note", ref: n.number, description: `Credit note ${n.number}`, currency: n.currency, amount_minor: -Number(n.total_minor), invoice_id: n.invoice_id, entity_id: n.id });
    }
  }
  return entries;
}

export interface StatementContactRow {
  id: string;
  full_name: string;
  email: string | null;
  company: string | null;
  tax_number: string | null;
  billing_address: string | null;
}

export async function getStatementContact(dataId: string, contactId: string): Promise<StatementContactRow | null> {
  return queryOne<StatementContactRow>(
    `SELECT id, full_name, email, company, tax_number, billing_address FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, dataId]
  ).catch(() =>
    queryOne<StatementContactRow>(`SELECT id, full_name, email, company, NULL::text AS tax_number, NULL::text AS billing_address FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, dataId])
  );
}

export function defaultStatementRange(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 90 * 86_400_000), to: now };
}

export async function buildStatement(dataId: string, contactId: string, range: { from?: Date | null; to?: Date | null } = {}): Promise<Statement | null> {
  const contact = await getStatementContact(dataId, contactId);
  if (!contact) return null;
  const def = defaultStatementRange();
  const from = range.from ?? def.from;
  const to = range.to ?? def.to;
  if (from.getTime() > to.getTime()) throw new Error("`from` must be before `to`");
  const entries = await loadStatementEntries(dataId, contactId);
  const computed = computeStatement(entries, from, to);
  return {
    contact: { id: contact.id, name: contact.full_name, email: contact.email, company: contact.company, tax_number: contact.tax_number, billing_address: contact.billing_address },
    from: from.toISOString(),
    to: to.toISOString(),
    ...computed,
    generated_at: new Date().toISOString(),
  };
}

/** Current outstanding balance per currency (everything up to now). */
export async function contactBalances(dataId: string, contactId: string): Promise<StatementBalance[]> {
  const entries = await loadStatementEntries(dataId, contactId);
  return computeStatement(entries, new Date(0), new Date(Date.now() + 86_400_000)).balances;
}
