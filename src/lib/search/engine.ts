import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { formatMoney } from "@/lib/i18n/format";
import type { Area } from "@/lib/auth/roles";
import { PER_KIND, capResults, likePatterns, parseSearchQuery, rankItems, type Rankable } from "./rank";

/**
 * Search 2.0 engine: one definition per searchable kind, each guarded by a
 * permission area + table presence, run concurrently under a shared time
 * budget so a slow table degrades to partial results instead of a hang.
 */

export type SearchKind =
  | "page" | "contact" | "lead" | "task" | "quote" | "invoice" | "booking" | "ticket" | "record" | "article"
  | "order" | "project" | "supplier" | "purchase_order" | "bill" | "staff" | "document" | "campaign" | "audience"
  | "sequence" | "product" | "expense" | "message" | "automation" | "report" | "snapshot" | "booking_type" | "location" | "transfer" | "tax_filing" | "shipment" | "return" | "membership_plan" | "member" | "voucher" | "gift_card" | "survey";

export interface SearchItem extends Rankable {
  kind: SearchKind;
  href: string;
  icon?: string;
}

export interface KindCtx {
  dataId: string;
  /** The acting member (private saved reports). */
  actorId: string;
  q: string;
  /** ILIKE patterns (substring + typo stem), already escaped. */
  pats: string[];
  locale: string;
  timeZone?: string;
  /** True when the caller may read CRM data (gates message bodies). */
  canCrm: boolean;
}

export interface KindDef {
  kind: SearchKind;
  area: Area | null;
  table: string | null;
  icon: string;
  run(ctx: KindCtx): Promise<SearchItem[]>;
}

const FETCH = PER_KIND * 3;
const enc = encodeURIComponent;
const s = (v: unknown): string => (v == null ? "" : String(v));
const join = (...p: Array<string | null | undefined>): string | null => p.filter(Boolean).join(" · ") || null;

interface Spec<R> {
  kind: SearchKind;
  area: Area | null;
  table: string;
  icon: string;
  /** SELECT list (must alias the id column as `id`). */
  select: string;
  from?: string;
  where?: string;
  cols: string[];
  order: string;
  userCol?: string;
  map(r: R, ctx: KindCtx): Omit<SearchItem, "kind" | "icon">;
}

function make<R extends Record<string, unknown>>(spec: Spec<R>): KindDef {
  return {
    kind: spec.kind,
    area: spec.area,
    table: spec.table,
    icon: spec.icon,
    async run(ctx) {
      const match = spec.cols.map((c) => `${c} ILIKE ANY($2)`).join(" OR ");
      const rows = await query<R>(
        `SELECT ${spec.select} FROM ${spec.from ?? spec.table}
          WHERE ${spec.userCol ?? "user_id"} = $1${spec.where ? ` AND ${spec.where}` : ""} AND (${match})
          ORDER BY ${spec.order} LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats]
      );
      return rows.map((r) => ({ kind: spec.kind, icon: spec.icon, ...spec.map(r, ctx) }));
    },
  };
}

function parseLead(data: string | null): Record<string, unknown> {
  try {
    return data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const money = (minor: unknown, cur: unknown, locale: string) => formatMoney(Number(minor) || 0, s(cur) || "USD", locale);

export const KIND_DEFS: KindDef[] = [
  make<{ id: string; tracking_number: string | null; carrier: string | null; status: string; created_at: string }>({
    kind: "shipment", area: "billing", table: "shipments", icon: "truck",
    select: "id, tracking_number, carrier, status, created_at", cols: ["COALESCE(tracking_number, '')", "COALESCE(carrier, '')"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.tracking_number ?? "Shipment (no tracking)", subtitle: join(r.carrier, r.status.replace(/_/g, " ")), href: `/shipping?shipment=${enc(r.id)}`, at: r.created_at }),
  }),
  make<{ id: string; reason: string | null; status: string; number: string | null; created_at: string }>({
    kind: "return", area: "billing", table: "return_requests", icon: "package",
    select: "r.id AS id, r.reason, r.status, o.number, r.created_at", from: "return_requests r LEFT JOIN orders o ON o.id = r.order_id AND o.user_id = r.user_id", userCol: "r.user_id", cols: ["o.number", "COALESCE(r.reason, '')"], order: "r.created_at DESC",
    map: (r) => ({ id: r.id, title: `Return ${r.number ?? r.id.slice(0, 8)}`, subtitle: join(r.status.replace(/_/g, " "), r.reason), href: `/shipping?tab=returns&return=${enc(r.id)}`, at: r.created_at }),
  }),
  make<{ id: string; name: string; slug: string; active: boolean; amount_minor: string | number; currency: string; interval: string; updated_at: string }>({
    kind: "membership_plan", area: "billing", table: "membership_plans", icon: "id-card",
    select: "id, name, slug, active, amount_minor, currency, interval, updated_at", cols: ["name", "slug"], order: "updated_at DESC",
    map: (r, ctx) => ({ id: r.id, title: r.name, subtitle: join(`${money(r.amount_minor, r.currency, ctx.locale)} / ${r.interval}`, r.active ? null : "archived"), href: `/memberships?plan=${enc(r.id)}`, at: r.updated_at }),
  }),
  make<{ id: string; full_name: string | null; email: string | null; status: string; plan_name: string; created_at: string }>({
    kind: "member", area: "billing", table: "customer_subscriptions", icon: "id-card",
    select: "s.id AS id, c.full_name, c.email, s.status, p.name AS plan_name, s.created_at",
    from: "customer_subscriptions s JOIN membership_plans p ON p.id = s.plan_id LEFT JOIN crm_contacts c ON c.id = s.contact_id", userCol: "s.user_id",
    cols: ["COALESCE(c.full_name, '')", "COALESCE(c.email, '')", "p.name"], order: "s.created_at DESC",
    map: (r) => ({ id: r.id, title: r.full_name ?? r.email ?? "Member", subtitle: join(r.plan_name, r.status.replace(/_/g, " ")), href: `/memberships?tab=members&member=${enc(r.id)}`, at: r.created_at }),
  }),
  make<{ id: string; full_name: string; email: string | null; company: string | null; updated_at: string }>({
    kind: "contact", area: "crm", table: "crm_contacts", icon: "users", where: "deleted_at IS NULL",
    select: "id, full_name, email, company, updated_at", cols: ["full_name", "email", "company"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.full_name, subtitle: join(r.company, r.email), href: `/crm?contact=${enc(r.id)}`, at: r.updated_at }),
  }),
  make<{ id: string; data: string | null; status: string | null; created_at: string }>({
    kind: "lead", area: "leads", table: "site_leads", icon: "user-plus",
    select: "id, data, status, created_at", cols: ["data"], order: "created_at DESC",
    map: (r) => {
      const d = parseLead(r.data);
      const name = s(d.name || d.full_name || d.fullName || d.email || "Lead");
      const email = d.email && d.email !== name ? s(d.email) : "";
      return { id: r.id, title: name, subtitle: join(email, r.status), href: `/leads?lead=${enc(r.id)}`, at: r.created_at };
    },
  }),
  make<{ id: string; title: string; done: boolean; created_at: string }>({
    kind: "task", area: "tasks", table: "tasks", icon: "list-todo", where: "deleted_at IS NULL",
    select: "id::text AS id, title, done, created_at", cols: ["title"], order: "done ASC, created_at DESC",
    map: (r) => ({ id: s(r.id), title: r.title, subtitle: r.done ? "Done" : "Open", href: `/tasks?task=${enc(s(r.id))}`, at: r.created_at }),
  }),
  ...(["quote", "invoice"] as const).map((kind) =>
    make<{ id: string; number: string; status: string; total_minor: string | number; currency: string; contact_name: string | null; created_at: string }>({
      kind, area: "billing", table: kind === "quote" ? "quotes" : "invoices", icon: kind === "quote" ? "file-text" : "receipt",
      select: "d.id, d.number, d.status, d.total_minor, d.currency, c.full_name AS contact_name, d.created_at",
      from: `${kind === "quote" ? "quotes" : "invoices"} d LEFT JOIN crm_contacts c ON c.id = d.contact_id`,
      userCol: "d.user_id", cols: ["d.number", "c.full_name", "d.notes"], order: "d.created_at DESC",
      map: (r, ctx) => ({
        id: r.id,
        title: r.contact_name ? `${r.number} · ${r.contact_name}` : r.number,
        subtitle: `${money(r.total_minor, r.currency, ctx.locale)} · ${r.status.replace("_", " ")}`,
        href: `/billing?${kind}=${enc(r.id)}`,
        at: r.created_at,
      }),
    })
  ),
  {
    kind: "booking", area: "calendar", table: "bookings", icon: "calendar-days",
    async run(ctx) {
      const rows = await query<{ id: string; name: string; starts_at: string; status: string }>(
        `SELECT id, name, email, starts_at, status FROM bookings
          WHERE user_id = $1 AND (name ILIKE ANY($2) OR email ILIKE ANY($2)) ORDER BY starts_at DESC LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats]
      );
      const fmt = new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium", timeStyle: "short", ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}) });
      return rows.map((r) => {
        const d = new Date(r.starts_at);
        return { kind: "booking" as const, icon: "calendar-days", id: r.id, title: r.name, subtitle: `${Number.isNaN(d.getTime()) ? "" : fmt.format(d)} · ${r.status}`.replace(/^ · /, ""), href: `/calendar?booking=${enc(r.id)}`, at: r.starts_at };
      });
    },
  },
  {
    kind: "ticket", area: "helpdesk", table: "tickets", icon: "life-buoy",
    async run(ctx) {
      const rows = await query<{ id: string; number: number; subject: string; status: string; priority: string; requester_name: string | null; updated_at: string }>(
        `SELECT id, number, subject, status, priority, requester_name, updated_at FROM tickets
          WHERE user_id = $1 AND (subject ILIKE ANY($2) OR requester_name ILIKE ANY($2) OR requester_email ILIKE ANY($2) OR CAST(number AS TEXT) = $3)
          ORDER BY updated_at DESC LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats, ctx.q.replace(/^#/, "")]
      );
      return rows.map((r) => ({ kind: "ticket" as const, icon: "life-buoy", id: r.id, title: `#${r.number} ${r.subject}`, subtitle: join(r.requester_name, r.status, r.priority), href: `/helpdesk?ticket=${enc(r.id)}`, at: r.updated_at }));
    },
  },
  make<{ id: string; title: string; stage: string; type_slug: string; type_name: string; updated_at: string }>({
    kind: "record", area: "crm", table: "records", icon: "boxes",
    select: "r.id, r.title, r.stage, t.slug AS type_slug, t.name AS type_name, r.updated_at",
    from: "records r JOIN record_types t ON t.id = r.type_id", userCol: "r.user_id", where: "r.deleted_at IS NULL",
    cols: ["r.title", "r.summary"], order: "r.updated_at DESC",
    map: (r) => ({ id: r.id, title: r.title, subtitle: `${r.type_name} · ${r.stage}`, href: `/r/${enc(r.type_slug)}?record=${enc(r.id)}`, at: r.updated_at }),
  }),
  make<{ id: string; title: string; status: string; category: string | null; updated_at: string }>({
    kind: "article", area: "knowledge", table: "kb_articles", icon: "book-open",
    select: "id, title, status, category, updated_at", cols: ["title", "excerpt", "body_md"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.title, subtitle: join(r.category, r.status), href: `/knowledge?article=${enc(r.id)}`, at: r.updated_at }),
  }),
  // ── Phase 10 breadth ──────────────────────────────────────────────────────
  make<{ id: string; number: string; customer_name: string; customer_email: string; status: string; total_minor: string | number; currency: string; created_at: string }>({
    kind: "order", area: "billing", table: "orders", icon: "shopping-cart",
    select: "id, number, customer_name, customer_email, status, total_minor, currency, created_at", cols: ["number", "customer_name", "customer_email"], order: "created_at DESC",
    map: (r, ctx) => ({ id: r.id, title: `${r.number} · ${r.customer_name}`, subtitle: `${money(r.total_minor, r.currency, ctx.locale)} · ${r.status.replace(/_/g, " ")}`, href: `/orders?order=${enc(r.id)}`, at: r.created_at }),
  }),
  make<{ id: string; name: string; code: string | null; status: string; updated_at: string }>({
    kind: "project", area: "tasks", table: "projects", icon: "folder-kanban",
    select: "id, name, code, status, updated_at", where: "archived_at IS NULL", cols: ["name", "code"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.code ? `${r.code} · ${r.name}` : r.name, subtitle: r.status.replace(/_/g, " "), href: `/projects/${enc(r.id)}`, at: r.updated_at }),
  }),
  make<{ id: string; name: string; email: string | null; updated_at: string }>({
    kind: "supplier", area: "billing", table: "suppliers", icon: "truck",
    select: "id, name, email, updated_at", where: "deleted_at IS NULL", cols: ["name", "email"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: r.email, href: `/procurement?tab=suppliers&q=${enc(r.name)}`, at: r.updated_at }),
  }),
  make<{ id: string; number: string; supplier_name: string | null; status: string; total_minor: string | number; currency: string; created_at: string }>({
    kind: "purchase_order", area: "billing", table: "purchase_orders", icon: "package",
    select: "p.id, p.number, s.name AS supplier_name, p.status, p.total_minor, p.currency, p.created_at",
    from: "purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id", userCol: "p.user_id", cols: ["p.number", "s.name"], order: "p.created_at DESC",
    map: (r, ctx) => ({ id: r.id, title: r.supplier_name ? `${r.number} · ${r.supplier_name}` : r.number, subtitle: `${money(r.total_minor, r.currency, ctx.locale)} · ${r.status.replace(/_/g, " ")}`, href: `/procurement?tab=orders&q=${enc(r.number)}`, at: r.created_at }),
  }),
  make<{ id: string; number: string; supplier_ref: string | null; supplier_name: string | null; status: string; total_minor: string | number; currency: string; created_at: string }>({
    kind: "bill", area: "billing", table: "supplier_bills", icon: "receipt",
    select: "b.id, b.number, b.supplier_ref, s.name AS supplier_name, b.status, b.total_minor, b.currency, b.created_at",
    from: "supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id", userCol: "b.user_id", cols: ["b.number", "b.supplier_ref", "s.name"], order: "b.created_at DESC",
    map: (r, ctx) => ({ id: r.id, title: r.supplier_name ? `${r.number} · ${r.supplier_name}` : r.number, subtitle: `${money(r.total_minor, r.currency, ctx.locale)} · ${r.status.replace(/_/g, " ")}`, href: `/procurement?tab=bills&q=${enc(r.number)}`, at: r.created_at }),
  }),
  make<{ id: string; display_name: string; role_title: string | null; email: string | null; updated_at: string }>({
    kind: "staff", area: "team", table: "staff_profiles", icon: "user-round",
    select: "id, display_name, role_title, email, updated_at", cols: ["display_name", "email"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.display_name, subtitle: join(r.role_title, r.email), href: `/workforce?tab=staff`, at: r.updated_at }),
  }),
  {
    kind: "document", area: "crm", table: "documents", icon: "file-signature",
    async run(ctx) {
      const rows = await query<{ id: string; title: string; status: string; updated_at: string }>(
        `SELECT id, title, status, updated_at FROM documents
          WHERE user_id = $1 AND (title ILIKE ANY($2)
             OR id IN (SELECT document_id FROM document_signers WHERE user_id = $1 AND (name ILIKE ANY($2) OR email ILIKE ANY($2))))
          ORDER BY updated_at DESC LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats]
      );
      return rows.map((r) => ({ kind: "document" as const, icon: "file-signature", id: r.id, title: r.title, subtitle: r.status, href: `/documents?doc=${enc(r.id)}&q=${enc(r.title)}`, at: r.updated_at }));
    },
  },
  make<{ id: string; name: string; status: string; channel: string; updated_at: string }>({
    kind: "campaign", area: "crm", table: "campaigns", icon: "send",
    select: "id, name, status, channel, updated_at", cols: ["name", "subject"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: `${r.channel} · ${r.status}`, href: `/marketing?campaign=${enc(r.id)}`, at: r.updated_at }),
  }),
  make<{ id: string; name: string; updated_at: string }>({
    kind: "audience", area: "crm", table: "audiences", icon: "users",
    select: "id, name, updated_at", cols: ["name"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: "Audience", href: `/marketing?tab=audiences`, at: r.updated_at }),
  }),
  make<{ id: string; name: string; status: string; updated_at: string }>({
    kind: "sequence", area: "crm", table: "sequences", icon: "workflow",
    select: "id, name, status, updated_at", cols: ["name"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: `Sequence · ${r.status}`, href: `/marketing?tab=sequences`, at: r.updated_at }),
  }),
  make<{ id: string; name: string; code: string | null; kind: string; updated_at: string }>({
    kind: "location", area: "billing", table: "locations", icon: "warehouse",
    select: "id, name, code, kind, updated_at", where: "active = TRUE", cols: ["name", "code"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.code ? `${r.name} (${r.code})` : r.name, subtitle: `Location · ${r.kind}`, href: `/inventory?tab=locations&q=${enc(r.name)}`, at: r.updated_at }),
  }),
  make<{ id: string; number: string; status: string; from_name: string | null; to_name: string | null; created_at: string }>({
    kind: "transfer", area: "billing", table: "stock_transfers", icon: "arrow-left-right",
    select: "t.id, t.number, t.status, lf.name AS from_name, lt.name AS to_name, t.created_at",
    from: "stock_transfers t LEFT JOIN locations lf ON lf.id = t.from_location_id LEFT JOIN locations lt ON lt.id = t.to_location_id", userCol: "t.user_id", cols: ["t.number", "lf.name", "lt.name"], order: "t.created_at DESC",
    map: (r) => ({ id: r.id, title: r.number, subtitle: `${r.from_name ?? "?"} → ${r.to_name ?? "?"} · ${r.status.replace(/_/g, " ")}`, href: `/inventory?tab=transfers&q=${enc(r.number)}`, at: r.created_at }),
  }),
  make<{ id: string; sku: string | null; name: string; stock_on_hand: number; updated_at: string }>({
    kind: "product", area: "billing", table: "products", icon: "boxes",
    select: "id, sku, name, stock_on_hand, updated_at", where: "deleted_at IS NULL", cols: ["sku", "name"], order: "updated_at DESC",
    map: (r) => ({ id: r.id, title: r.sku ? `${r.name} (${r.sku})` : r.name, subtitle: `${r.stock_on_hand} on hand`, href: `/inventory?product=${enc(r.id)}&q=${enc(r.sku ?? r.name)}`, at: r.updated_at }),
  }),
  make<{ id: string; vendor: string | null; description: string | null; amount_minor: string | number; currency: string; spent_at: string }>({
    kind: "expense", area: "billing", table: "expenses", icon: "wallet",
    select: "id, vendor, description, amount_minor, currency, spent_at", cols: ["vendor", "description"], order: "spent_at DESC",
    map: (r, ctx) => ({ id: r.id, title: r.vendor || r.description || "Expense", subtitle: join(money(r.amount_minor, r.currency, ctx.locale), r.vendor ? r.description : null), href: `/finance?expense=${enc(r.id)}`, at: r.spent_at }),
  }),
  make<{ id: string; regime: string; period_start: string; period_end: string; status: string; filed_ref: string | null; created_at: string }>({
    kind: "tax_filing", area: "billing", table: "tax_filings", icon: "receipt",
    where: "(notes IS NULL OR notes NOT LIKE 'reminder:%')",
    select: "id, regime, period_start, period_end, status, filed_ref, created_at", cols: ["regime", "filed_ref", "notes"], order: "period_start DESC",
    map: (r) => ({ id: r.id, title: `${r.regime.replace(/_/g, " ")} ${String(r.period_start).slice(0, 10)} to ${String(r.period_end).slice(0, 10)}`, subtitle: join(r.status, r.filed_ref), href: "/tax?tab=filings", at: r.created_at }),
  }),
  {
    kind: "message", area: "crm", table: "portal_messages", icon: "message-square",
    async run(ctx) {
      const bodyMatch = ctx.canCrm ? " OR m.body ILIKE ANY($2)" : "";
      const rows = await query<{ id: string; contact_id: string; contact_name: string | null; body: string; direction: string; created_at: string }>(
        `SELECT m.id, m.contact_id, c.full_name AS contact_name, m.body, m.direction, m.created_at
           FROM portal_messages m LEFT JOIN crm_contacts c ON c.id = m.contact_id
          WHERE m.user_id = $1 AND (c.full_name ILIKE ANY($2)${bodyMatch})
          ORDER BY m.created_at DESC LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats]
      );
      return rows.map((r) => ({
        kind: "message" as const, icon: "message-square", id: r.id, title: r.contact_name ?? "Portal message",
        subtitle: r.body.replace(/\s+/g, " ").slice(0, 80), href: `/crm?contact=${enc(r.contact_id)}`, at: r.created_at,
      }));
    },
  },
  make<{ id: string; name: string; status: string; created_at: string }>({
    kind: "automation", area: "agents", table: "automations", icon: "zap",
    select: "id::text AS id, name, status, created_at", cols: ["name"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: `Automation · ${r.status}`, href: `/automations?automation=${enc(r.id)}`, at: r.created_at }),
  }),
  {
    kind: "report", area: "reports", table: "saved_reports", icon: "pie-chart",
    async run(ctx) {
      const rows = await query<{ id: string; name: string; description: string | null; updated_at: string }>(
        `SELECT id, name, description, updated_at FROM saved_reports
          WHERE user_id = $1 AND (visibility = 'org' OR created_by = $3) AND name ILIKE ANY($2)
          ORDER BY updated_at DESC LIMIT ${FETCH}`,
        [ctx.dataId, ctx.pats, ctx.actorId]
      );
      return rows.map((r) => ({ kind: "report" as const, icon: "pie-chart", id: r.id, title: r.name, subtitle: r.description, href: `/reports?report=${enc(r.id)}`, at: r.updated_at }));
    },
  },
  make<{ id: string; name: string; description: string | null; created_at: string }>({
    kind: "snapshot", area: "settings", table: "snapshots", icon: "archive",
    select: "id, name, description, created_at", cols: ["name"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: r.description, href: `/settings/snapshots`, at: r.created_at }),
  }),
  make<{ id: string; name: string; duration_minutes: number; created_at: string }>({
    kind: "booking_type", area: "calendar", table: "booking_types", icon: "calendar-clock",
    select: "id, name, duration_minutes, created_at", cols: ["name"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: `${r.duration_minutes} min`, href: `/calendar?tab=booking-types`, at: r.created_at }),
  }),
  make<{ id: string; code_upper: string; name: string; used_count: number; created_at: string }>({
    kind: "voucher", area: "billing", table: "vouchers", icon: "tag",
    select: "id, code_upper, name, used_count, created_at", cols: ["code_upper", "name"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.code_upper, subtitle: join(r.name, `${r.used_count} used`), href: `/engagement?tab=vouchers`, at: r.created_at }),
  }),
  make<{ id: string; code_last4: string; status: string; balance_minor: string | number; currency: string; created_at: string }>({
    kind: "gift_card", area: "billing", table: "gift_cards", icon: "gift",
    select: "id, code_last4, status, balance_minor, currency, created_at", cols: ["code_last4"], order: "created_at DESC",
    map: (r, ctx) => ({ id: r.id, title: `Gift card •••• ${r.code_last4}`, subtitle: join(r.status, formatMoney(Number(r.balance_minor), r.currency, ctx.locale)), href: `/engagement?tab=gift-cards`, at: r.created_at }),
  }),
  make<{ id: string; name: string; kind: string; created_at: string }>({
    kind: "survey", area: "crm", table: "surveys", icon: "heart-handshake",
    select: "id, name, kind, created_at", cols: ["name"], order: "created_at DESC",
    map: (r) => ({ id: r.id, title: r.name, subtitle: r.kind.toUpperCase(), href: `/engagement?tab=feedback`, at: r.created_at }),
  }),
];

export interface SearchOptions {
  dataId: string;
  actorId: string;
  q: string;
  can: (area: Area, edit?: boolean) => boolean;
  locale: string;
  timeZone?: string;
  /** Total time budget in ms (default 800). */
  budgetMs?: number;
  /** Extra / replacement kind definitions (tests inject slow kinds). */
  defs?: KindDef[];
}

export interface SearchResult {
  items: SearchItem[];
  partial: boolean;
  /** Kinds that timed out or failed. */
  skipped: string[];
}

const TIMED_OUT = Symbol("timeout");

/** Run every permitted kind concurrently within the budget; late/failed kinds are dropped. */
export async function runSearch(opts: SearchOptions): Promise<SearchResult> {
  const parsed = parseSearchQuery(opts.q);
  const text = parsed.text.trim();
  if (text.length < 2) return { items: [], partial: false, skipped: [] };
  const budget = opts.budgetMs ?? 800;
  const defs = (opts.defs ?? KIND_DEFS).filter((d) => {
    if (d.area && !opts.can(d.area)) return false;
    if (parsed.kinds.length && !parsed.kinds.includes(d.kind)) return false;
    if (parsed.areas.length && !(d.area && parsed.areas.includes(d.area))) return false;
    return true;
  });
  const ctx: KindCtx = {
    dataId: opts.dataId, actorId: opts.actorId, q: text, pats: likePatterns(text), locale: opts.locale, timeZone: opts.timeZone, canCrm: opts.can("crm"),
  };
  const skipped: string[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const settled = await Promise.all(
    defs.map(async (d) => {
      const timeout = new Promise<typeof TIMED_OUT>((res) => timers.push(setTimeout(() => res(TIMED_OUT), budget)));
      try {
        const work = (async () => {
          if (d.table && !(await tableExists(d.table))) return [] as SearchItem[];
          return d.run(ctx);
        })();
        // A late rejection after the timeout must not become an unhandled rejection.
        work.catch(() => undefined);
        const out = await Promise.race([work, timeout]);
        if (out === TIMED_OUT) {
          skipped.push(d.kind);
          return [] as SearchItem[];
        }
        return out;
      } catch (err) {
        console.warn(`[search] ${d.kind} lookup failed:`, err instanceof Error ? err.message : err);
        skipped.push(d.kind);
        return [] as SearchItem[];
      }
    })
  );
  timers.forEach(clearTimeout);
  const perKind = settled.map((items) => rankItems(items, text).slice(0, PER_KIND));
  const merged = rankItems(perKind.flat(), text);
  return { items: capResults(merged), partial: skipped.length > 0, skipped };
}
