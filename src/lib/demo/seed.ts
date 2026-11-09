import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { createContact } from "@/lib/crm/contacts";
import { createQuote, sendQuote, markQuoteViewed, declineQuote } from "@/lib/money/quotes";
import { createInvoiceFromQuote, sendInvoice, recordPayment, recomputeInvoiceStatus } from "@/lib/money/invoices";
import type { LineItem } from "@/lib/money/items";
import { createBooking, ensureDefaultCalendar, setBookingStatus } from "@/lib/calendar/booking";
import { createTicket, getDefaultPolicy, createPolicy, setStatus as setTicketStatus } from "@/lib/helpdesk/tickets";
import { createTask } from "@/lib/tasks/store";
import { createRecord, getType } from "@/lib/records/store";
import { installPack, getPack, PACKS } from "@/lib/records/packs";
import type { FieldDef, RecordType } from "@/lib/records/types";
import { createProduct } from "@/lib/inventory/products";
import { createExpense } from "@/lib/finance/expenses";
import { createTimeEntry } from "@/lib/finance/time";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { recordAudit } from "@/lib/audit";
import { buildDemoPlan, DEMO_TAG, planCounts, type DemoPlan } from "./plan";

/**
 * Demo workspace seeder. Every row goes through the real lib function (so
 * events, numbering, SLA timers and stock movements behave like production)
 * and is registered in `demo_seed_rows` so `clearDemoData` removes exactly
 * those rows and nothing else.
 */

export type DemoEntity =
  | "contact" | "quote" | "invoice" | "booking" | "ticket" | "task" | "record"
  | "product" | "expense" | "time_entry" | "outbox" | "booking_type" | "sla_policy";

export interface SeedOptions {
  industry?: string;
  currency?: string;
  now?: Date;
  actorId?: string | null;
}

export interface SeedResult {
  seeded: boolean;
  /** False when demo rows already existed (idempotent no-op). */
  created: Record<string, number>;
  warnings: string[];
}

const DAY = 86_400_000;

export async function demoRowCount(dataId: string): Promise<number> {
  if (!(await tableExists("demo_seed_rows"))) return 0;
  const r = await queryOne<{ n: string | number }>(`SELECT COUNT(*) AS n FROM demo_seed_rows WHERE user_id = $1`, [dataId]).catch(() => null);
  return Number(r?.n ?? 0);
}

export async function hasDemoData(dataId: string): Promise<boolean> {
  return (await demoRowCount(dataId)) > 0;
}

async function register(dataId: string, entity: DemoEntity, entityId: string): Promise<void> {
  await query(`INSERT INTO demo_seed_rows (id, user_id, entity, entity_id) VALUES ($1, $2, $3, $4)`, [randomUUID(), dataId, entity, entityId]);
}

/** Pick the pack for an industry; falls back to "startup" when the slug is unknown. */
export function packForIndustry(industry: string | null | undefined): string {
  const slug = (industry ?? "").toLowerCase();
  if (getPack(slug)) return slug;
  const byName = PACKS.find((p) => p.name.toLowerCase() === slug);
  return byName?.slug ?? "startup";
}

/** Fill required fields of a record type with plausible sample values so validation passes. */
export function sampleRecordData(fields: FieldDef[], contactEmail: string, contactPhone: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.required) continue;
    switch (f.type) {
      case "number": out[f.key] = 3; break;
      case "money": out[f.key] = 25000; break;
      case "date": out[f.key] = new Date().toISOString().slice(0, 10); break;
      case "boolean": out[f.key] = true; break;
      case "email": out[f.key] = contactEmail; break;
      case "phone": out[f.key] = contactPhone; break;
      case "url": out[f.key] = "https://example.com"; break;
      case "select": out[f.key] = f.options?.[0] ?? ""; break;
      case "multiselect": out[f.key] = f.options?.slice(0, 1) ?? []; break;
      default: out[f.key] = `Sample ${f.label.toLowerCase()} (${DEMO_TAG})`;
    }
  }
  return out;
}

function toLines(items: DemoPlan["quotes"][number]["items"]): LineItem[] {
  return items.map((l) => ({ description: l.description, qty: l.quantity, unit_minor: l.unit_price_minor, tax_rate_bp: l.tax_rate_bp }));
}

function at(now: Date, dayOffset: number, hour: number): Date {
  const d = new Date(now.getTime() + dayOffset * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

export async function seedDemoWorkspace(dataId: string, opts: SeedOptions = {}): Promise<SeedResult> {
  if (!(await tableExists("demo_seed_rows"))) throw new Error("demo_seed_rows table missing — apply aws/phase5/c.sql");
  if (await hasDemoData(dataId)) return { seeded: false, created: {}, warnings: ["Sample data already loaded"] };

  const now = opts.now ?? new Date();
  const packSlug = packForIndustry(opts.industry);
  const plan = buildDemoPlan(packSlug, opts.currency ?? "USD");
  const warnings: string[] = [];
  const created: Record<string, number> = {};
  const bump = (k: string) => { created[k] = (created[k] ?? 0) + 1; };
  const step = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  // Contacts
  const contactIds = new Map<string, { id: string; email: string; phone: string; name: string }>();
  for (const c of plan.contacts) {
    await step(`contact ${c.ref}`, async () => {
      const row = await createContact(dataId, {
        full_name: c.full_name, email: c.email, phone: c.phone, company: c.company, role: c.role,
        lifecycle: c.lifecycle, deal_value: c.deal_value, notes: c.notes, tags: [DEMO_TAG],
      });
      // Register before follow-up mutations so a later failure never leaves an untracked row.
      await register(dataId, "contact", row.id);
      bump("contacts");
      contactIds.set(c.ref, { id: row.id, email: c.email, phone: c.phone, name: c.full_name });
      if (c.lastContactDaysAgo === null) {
        await query(`UPDATE crm_contacts SET last_contact = NULL, created_at = $3 WHERE id = $1 AND user_id = $2`, [row.id, dataId, new Date(now.getTime() - 21 * DAY).toISOString()]).catch(() => undefined);
      } else {
        await query(`UPDATE crm_contacts SET last_contact = $3 WHERE id = $1 AND user_id = $2`, [row.id, dataId, new Date(now.getTime() - c.lastContactDaysAgo * DAY).toISOString()]).catch(() => undefined);
      }
    });
  }
  const contact = (ref: string) => contactIds.get(ref) ?? null;

  // Products (stock)
  for (const p of plan.products) {
    await step(`product ${p.ref}`, async () => {
      const row = await createProduct(dataId, {
        sku: p.sku, name: p.name, description: `${DEMO_TAG} sample`, kind: p.kind, unit: p.kind === "service" ? "hour" : "each",
        unit_price_minor: p.unit_price_minor, cost_minor: p.cost_minor, currency: plan.currency, tax_rate_bp: 0,
        track_stock: p.kind === "product", stock_on_hand: p.stock_on_hand, reorder_point: p.reorder_point, active: true,
      }, opts.actorId ?? null);
      await register(dataId, "product", row.id);
      bump("products");
    });
  }

  // Quotes → invoices
  for (const q of plan.quotes) {
    await step(`quote ${q.ref}`, async () => {
      const c = contact(q.contactRef);
      const quote = await createQuote(dataId, {
        contact_id: c?.id ?? null, currency: plan.currency, items: toLines(q.items),
        valid_until: new Date(now.getTime() + q.validInDays * DAY).toISOString(), notes: `${DEMO_TAG} sample quote`,
      });
      await register(dataId, "quote", quote.id);
      bump("quotes");
      if (q.status === "draft") return;
      await sendQuote(dataId, quote.id, { to: c?.email ?? "customer@example.com" });
      if (q.status === "viewed") await markQuoteViewed(quote.id);
      if (q.status === "declined") await declineQuote(dataId, quote.id, "Went with another supplier");
      if (q.status === "accepted") {
        await query(`UPDATE quotes SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`, [quote.id, dataId]);
        const inv = await createInvoiceFromQuote(dataId, quote.id, { due_days: Math.max(1, q.invoiceDueInDays ?? 14) });
        await register(dataId, "invoice", inv.id);
        bump("invoices");
        if ((q.invoiceDueInDays ?? 0) < 0) {
          await query(`UPDATE invoices SET due_at = $3 WHERE id = $1 AND user_id = $2`, [inv.id, dataId, new Date(now.getTime() + (q.invoiceDueInDays ?? -1) * DAY).toISOString()]);
        }
        await sendInvoice(dataId, inv.id, { to: c?.email ?? "customer@example.com" });
        if (q.invoicePaid) {
          await recordPayment({ invoiceId: inv.id, provider: "simulated", providerRef: `demo-${inv.id}`, amountMinor: inv.total_minor, currency: inv.currency });
        } else {
          await recomputeInvoiceStatus(inv.id);
        }
      }
    });
  }

  // Bookings (±2 weeks)
  await step("bookings", async () => {
    const cal = await ensureDefaultCalendar(dataId);
    for (const b of plan.bookings) {
      await step(`booking ${b.ref}`, async () => {
        const c = contact(b.contactRef);
        const { booking } = await createBooking(dataId, {
          calendarId: cal.id, contactId: c?.id ?? null, name: c?.name ?? "Sample customer", email: c?.email ?? null, phone: c?.phone ?? null,
          startsAt: at(now, b.dayOffset, b.hour), durationMinutes: b.durationMinutes, notes: `${b.notes} (${DEMO_TAG})`, source: "manual", ignoreRules: true,
        });
        await register(dataId, "booking", booking.id);
        bump("bookings");
        if (b.outcome) await setBookingStatus(dataId, booking.id, b.outcome);
      });
    }
  });

  // Tickets with SLA states
  await step("tickets", async () => {
    let policy = await getDefaultPolicy(dataId);
    if (!policy) {
      policy = await createPolicy(dataId, { name: "Standard support", first_response_minutes: 60, resolution_minutes: 1440, is_default: true });
      await register(dataId, "sla_policy", policy.id);
    }
    for (const t of plan.tickets) {
      await step(`ticket ${t.ref}`, async () => {
        const c = contact(t.contactRef);
        const row = await createTicket(dataId, {
          subject: t.subject, body: t.body, priority: t.priority, source: "email", contact_id: c?.id ?? null,
          requester_email: c?.email ?? null, requester_name: c?.name ?? null, sla_policy_id: policy?.id ?? null, tags: [...t.tags, DEMO_TAG],
        });
        await register(dataId, "ticket", row.id);
        bump("tickets");
        const past = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
        const soon = new Date(now.getTime() + 20 * 60_000).toISOString();
        switch (t.sla) {
          case "breached":
            await query(`UPDATE tickets SET created_at = $3, first_response_due_at = $4, breached_first_response = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [row.id, dataId, past(5), past(4)]);
            break;
          case "at_risk":
            await query(`UPDATE tickets SET first_response_due_at = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [row.id, dataId, soon]);
            break;
          case "resolved":
            await setTicketStatus(dataId, row.id, "resolved", { actorId: opts.actorId ?? null });
            break;
          case "pending":
            await setTicketStatus(dataId, row.id, "pending", { actorId: opts.actorId ?? null });
            break;
          default:
            break;
        }
      });
    }
  });

  // Tasks
  for (const title of plan.tasks) {
    await step(`task ${title}`, async () => {
      const t = await createTask(dataId, { title: `${title}` });
      await register(dataId, "task", t.id);
      bump("tasks");
    });
  }

  // Records in the industry pack's first type
  await step("records", async () => {
    const types: RecordType[] = await installPack(dataId, packSlug);
    const type = types[0] ?? (await getType(dataId, packSlug));
    if (!type) throw new Error("pack has no record types");
    const stages = type.stages.map((s) => s.key);
    for (let i = 0; i < plan.records.length; i++) {
      const r = plan.records[i];
      const c = plan.contacts[i % plan.contacts.length];
      const cid = contact(c.ref)?.id ?? null;
      await step(`record ${r.title}`, async () => {
        const rec = await createRecord(dataId, type, {
          title: r.title, summary: `${r.summary} (${DEMO_TAG})`, stage: stages[i % Math.max(1, stages.length)] ?? null,
          data: sampleRecordData(type.fields, c.email, c.phone), currency: plan.currency, actorId: opts.actorId ?? null,
        });
        await register(dataId, "record", rec.id);
        bump("records");
        if (cid) await query(`UPDATE records SET contact_id = $3, due_at = $4 WHERE id = $1 AND user_id = $2`, [rec.id, dataId, cid, new Date(now.getTime() + (i - 2) * 3 * DAY).toISOString()]).catch(() => undefined);
      });
    }
  });

  // Expenses + time entries
  for (const e of plan.expenses) {
    await step(`expense ${e.vendor}`, async () => {
      const row = await createExpense(dataId, {
        category: e.category, vendor: e.vendor, description: `${e.description} (${DEMO_TAG})`, amount_minor: e.amount_minor, currency: plan.currency,
        tax_minor: 0, spent_at: new Date(now.getTime() - e.daysAgo * DAY).toISOString(), billable: false,
      }, opts.actorId ?? null);
      await register(dataId, "expense", row.id);
      bump("expenses");
    });
  }
  for (const te of plan.timeEntries) {
    await step(`time ${te.description}`, async () => {
      const started = new Date(now.getTime() - te.daysAgo * DAY);
      const row = await createTimeEntry(dataId, {
        description: `${te.description} (${DEMO_TAG})`, started_at: started.toISOString(), minutes: te.minutes,
        rate_minor: te.rate_minor, currency: plan.currency, billable: true,
      }, opts.actorId ?? null);
      await register(dataId, "time_entry", row.id);
      bump("timeEntries");
    });
  }

  // One outbox email
  await step("outbox", async () => {
    const c = contact(plan.outboxEmail.recipientRef);
    const id = await enqueueNotification(dataId, {
      channel: "email", recipient: c?.email ?? "customer@example.com", subject: plan.outboxEmail.subject, body: plan.outboxEmail.body,
      data: { demo: true },
    });
    await register(dataId, "outbox", id);
    bump("outbox");
  });

  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "demo.seeded", entity: "workspace", entityId: dataId, after: { ...created, industry: packSlug } });
  return { seeded: true, created, warnings };
}

export interface ClearResult {
  removed: Record<string, number>;
}

/** Remove only rows the seeder created (plus their dependent rows). */
export async function clearDemoData(dataId: string, actorId: string | null = null): Promise<ClearResult> {
  if (!(await tableExists("demo_seed_rows"))) return { removed: {} };
  const rows = await query<{ entity: DemoEntity; entity_id: string }>(`SELECT entity, entity_id FROM demo_seed_rows WHERE user_id = $1`, [dataId]);
  const by = new Map<DemoEntity, string[]>();
  for (const r of rows) by.set(r.entity, [...(by.get(r.entity) ?? []), r.entity_id]);
  const removed: Record<string, number> = {};
  const del = async (entity: DemoEntity, sql: Array<[string, string]>) => {
    const ids = by.get(entity) ?? [];
    if (ids.length === 0) return;
    for (const [table, col] of sql) {
      const scoped = col === "id";
      await query(
        `DELETE FROM ${table} WHERE ${col}::text = ANY($1::text[])${scoped ? " AND user_id = $2" : ""}`,
        scoped ? [ids, dataId] : [ids]
      ).catch(() => undefined);
    }
    removed[entity] = ids.length;
  };
  // Dependents first (child tables are keyed by parent id, not user_id).
  await del("invoice", [["invoice_payments", "invoice_id"], ["invoices", "id"]]);
  await del("quote", [["quote_versions", "quote_id"], ["quote_acceptances", "quote_id"], ["quotes", "id"]]);
  await del("ticket", [["ticket_messages", "ticket_id"], ["tickets", "id"]]);
  await del("record", [["record_activity", "record_id"], ["record_links", "record_id"], ["records", "id"]]);
  await del("product", [["stock_movements", "product_id"], ["products", "id"]]);
  await del("booking", [["bookings", "id"]]);
  await del("booking_type", [["booking_types", "id"]]);
  await del("sla_policy", [["sla_policies", "id"]]);
  await del("task", [["tasks", "id"]]);
  await del("expense", [["expenses", "id"]]);
  await del("time_entry", [["time_entries", "id"]]);
  await del("outbox", [["notification_outbox", "id"]]);
  await del("contact", [["crm_activities", "contact_id"], ["crm_contacts", "id"]]);
  await query(`DELETE FROM demo_seed_rows WHERE user_id = $1`, [dataId]);
  void recordAudit({ dataId, userId: actorId }, { action: "demo.cleared", entity: "workspace", entityId: dataId, after: removed });
  return { removed };
}

export { buildDemoPlan, planCounts };
