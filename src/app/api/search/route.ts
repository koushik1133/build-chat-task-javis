import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { getMessages, intlTag, makeT, type MessageKey } from "@/lib/i18n";
import { formatMoney } from "@/lib/i18n/format";
import { getRequestLocale } from "@/lib/i18n/server";
import { SEARCH_PAGES } from "@/lib/search/pages";

export const dynamic = "force-dynamic";

export type SearchKind =
  | "page"
  | "contact"
  | "lead"
  | "task"
  | "quote"
  | "invoice"
  | "booking"
  | "ticket"
  | "record"
  | "article";

export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  items: SearchItem[];
}

const PER_KIND = 5;
const MAX_Q = 80;

const GROUP_KEYS: Record<SearchKind, MessageKey> = {
  page: "search.group.pages",
  contact: "search.group.contacts",
  lead: "search.group.leads",
  task: "search.group.tasks",
  quote: "search.group.quotes",
  invoice: "search.group.invoices",
  booking: "search.group.bookings",
  ticket: "search.group.tickets",
  record: "search.group.records",
  article: "search.group.articles",
};

/** `%term%` with ILIKE metacharacters escaped (pair with `ESCAPE '\'`). */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Runs a kind's query; any failure (missing table, DB down) yields no items for that kind. */
async function safe(kind: SearchKind, fn: () => Promise<SearchItem[]>): Promise<SearchItem[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[search] ${kind} lookup failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

async function searchContacts(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; full_name: string; email: string | null; company: string | null }>(
    `SELECT id, full_name, email, company FROM crm_contacts
      WHERE user_id = $1 AND (full_name ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\' OR company ILIKE $2 ESCAPE '\\')
      ORDER BY updated_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => ({
    kind: "contact",
    id: r.id,
    title: r.full_name,
    subtitle: [r.company, r.email].filter(Boolean).join(" · ") || null,
    href: `/crm?contact=${encodeURIComponent(r.id)}`,
  }));
}

async function searchLeads(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; data: string | null; status: string | null }>(
    `SELECT id, data, status FROM site_leads
      WHERE user_id = $1 AND data ILIKE $2 ESCAPE '\\'
      ORDER BY created_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      d = r.data ? (JSON.parse(r.data) as Record<string, unknown>) : {};
    } catch {
      d = {};
    }
    const name = str(d.name || d.full_name || d.fullName || d.email || "Lead");
    const email = d.email && d.email !== name ? str(d.email) : "";
    return {
      kind: "lead" as const,
      id: r.id,
      title: name,
      subtitle: [email, r.status].filter(Boolean).join(" · ") || null,
      href: `/leads?lead=${encodeURIComponent(r.id)}`,
    };
  });
}

async function searchTasks(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; title: string; done: boolean }>(
    `SELECT id, title, done FROM tasks
      WHERE user_id = $1 AND title ILIKE $2 ESCAPE '\\'
      ORDER BY done ASC, created_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => ({
    kind: "task",
    id: str(r.id),
    title: r.title,
    subtitle: r.done ? "Done" : "Open",
    href: `/tasks?task=${encodeURIComponent(str(r.id))}`,
  }));
}

async function searchMoneyDocs(
  kind: "quote" | "invoice",
  dataId: string,
  like: string,
  locale: string
): Promise<SearchItem[]> {
  const table = kind === "quote" ? "quotes" : "invoices";
  const rows = await query<{ id: string; number: string; status: string; total_minor: string | number; currency: string; contact_name: string | null }>(
    `SELECT d.id, d.number, d.status, d.total_minor, d.currency, c.full_name AS contact_name
       FROM ${table} d LEFT JOIN crm_contacts c ON c.id = d.contact_id
      WHERE d.user_id = $1 AND (d.number ILIKE $2 ESCAPE '\\' OR c.full_name ILIKE $2 ESCAPE '\\' OR d.notes ILIKE $2 ESCAPE '\\')
      ORDER BY d.created_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => ({
    kind,
    id: r.id,
    title: r.contact_name ? `${r.number} · ${r.contact_name}` : r.number,
    subtitle: `${formatMoney(Number(r.total_minor) || 0, r.currency, locale)} · ${r.status.replace("_", " ")}`,
    href: `/billing?${kind}=${encodeURIComponent(r.id)}`,
  }));
}

async function searchBookings(dataId: string, like: string, locale: string, timeZone?: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; name: string; email: string | null; starts_at: string; status: string }>(
    `SELECT id, name, email, starts_at, status FROM bookings
      WHERE user_id = $1 AND (name ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\')
      ORDER BY starts_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  return rows.map((r) => {
    const d = new Date(r.starts_at);
    return {
      kind: "booking" as const,
      id: r.id,
      title: r.name,
      subtitle: `${Number.isNaN(d.getTime()) ? "" : fmt.format(d)} · ${r.status}`.replace(/^ · /, ""),
      href: `/calendar?booking=${encodeURIComponent(r.id)}`,
    };
  });
}

async function searchTickets(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; number: number; subject: string; status: string; priority: string; requester_name: string | null }>(
    `SELECT id, number, subject, status, priority, requester_name FROM tickets
      WHERE user_id = $1 AND (subject ILIKE $2 ESCAPE '\\' OR requester_name ILIKE $2 ESCAPE '\\' OR requester_email ILIKE $2 ESCAPE '\\' OR CAST(number AS TEXT) = $3)
      ORDER BY updated_at DESC LIMIT ${PER_KIND}`,
    [dataId, like, like.slice(1, -1).replace(/^#/, "")]
  );
  return rows.map((r) => ({
    kind: "ticket",
    id: r.id,
    title: `#${r.number} ${r.subject}`,
    subtitle: [r.requester_name, r.status, r.priority].filter(Boolean).join(" · ") || null,
    href: `/helpdesk?ticket=${encodeURIComponent(r.id)}`,
  }));
}

async function searchRecords(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; title: string; stage: string; type_slug: string; type_name: string }>(
    `SELECT r.id, r.title, r.stage, t.slug AS type_slug, t.name AS type_name
       FROM records r JOIN record_types t ON t.id = r.type_id
      WHERE r.user_id = $1 AND r.deleted_at IS NULL AND (r.title ILIKE $2 ESCAPE '\\' OR r.summary ILIKE $2 ESCAPE '\\')
      ORDER BY r.updated_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => ({
    kind: "record",
    id: r.id,
    title: r.title,
    subtitle: `${r.type_name} · ${r.stage}`,
    href: `/r/${encodeURIComponent(r.type_slug)}?record=${encodeURIComponent(r.id)}`,
  }));
}

async function searchArticles(dataId: string, like: string): Promise<SearchItem[]> {
  const rows = await query<{ id: string; slug: string; title: string; status: string; category: string | null }>(
    `SELECT id, slug, title, status, category FROM kb_articles
      WHERE user_id = $1 AND (title ILIKE $2 ESCAPE '\\' OR excerpt ILIKE $2 ESCAPE '\\' OR body_md ILIKE $2 ESCAPE '\\')
      ORDER BY updated_at DESC LIMIT ${PER_KIND}`,
    [dataId, like]
  );
  return rows.map((r) => ({
    kind: "article",
    id: r.id,
    title: r.title,
    subtitle: [r.category, r.status].filter(Boolean).join(" · ") || null,
    href: `/knowledge?article=${encodeURIComponent(r.id)}`,
  }));
}

function searchPages(scope: Scope, q: string, t: ReturnType<typeof makeT>): SearchItem[] {
  const needle = q.toLowerCase();
  return SEARCH_PAGES.filter((p) => !p.area || scope.can(p.area))
    .map((p) => ({ href: p.href, label: p.key ? t(p.key) : p.label, fallback: p.label }))
    .filter((p) => p.label.toLowerCase().includes(needle) || p.fallback.toLowerCase().includes(needle) || p.href.includes(needle))
    .slice(0, 6)
    .map((p) => ({ kind: "page" as const, id: p.href, title: p.label, subtitle: p.href, href: p.href }));
}

/**
 * GET /api/search?q=term — grouped, scope-aware results across the workspace.
 * Kinds the caller's role cannot view are skipped; kinds whose tables are not
 * migrated yet simply return nothing.
 */
export async function GET(req: Request) {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
  const uiLocale = await getRequestLocale(scope.dataId);
  const locale = intlTag(uiLocale);
  const t = makeT(getMessages(uiLocale));

  if (q.length < 2) {
    const pages = searchPages(scope, "", t);
    return NextResponse.json({ q, groups: pages.length ? [{ kind: "page", label: t("search.group.pages"), items: pages }] : [] });
  }

  const like = likePattern(q);
  const { dataId } = scope;
  const orgTz = (await import("@/lib/org-settings")).getOrgSettings(dataId).then((s) => s.timezone).catch(() => undefined);

  const jobs: Array<[SearchKind, Promise<SearchItem[]>]> = [
    ["page", Promise.resolve(searchPages(scope, q, t))],
  ];
  if (scope.can("crm")) jobs.push(["contact", safe("contact", () => searchContacts(dataId, like))]);
  if (scope.can("leads")) jobs.push(["lead", safe("lead", () => searchLeads(dataId, like))]);
  if (scope.can("tasks")) jobs.push(["task", safe("task", () => searchTasks(dataId, like))]);
  if (scope.can("billing")) {
    jobs.push(["quote", safe("quote", () => searchMoneyDocs("quote", dataId, like, locale))]);
    jobs.push(["invoice", safe("invoice", () => searchMoneyDocs("invoice", dataId, like, locale))]);
  }
  if (scope.can("calendar")) jobs.push(["booking", safe("booking", async () => searchBookings(dataId, like, locale, await orgTz))]);
  if (scope.can("helpdesk")) jobs.push(["ticket", safe("ticket", () => searchTickets(dataId, like))]);
  if (scope.can("crm")) jobs.push(["record", safe("record", () => searchRecords(dataId, like))]);
  if (scope.can("knowledge")) jobs.push(["article", safe("article", () => searchArticles(dataId, like))]);

  const results = await Promise.all(jobs.map(([, p]) => p));
  const groups: SearchGroup[] = jobs
    .map(([kind], i) => ({ kind, label: t(GROUP_KEYS[kind]), items: results[i] }))
    .filter((g) => g.items.length > 0);

  return NextResponse.json({ q, groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
}
