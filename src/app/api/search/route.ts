import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { getMessages, intlTag, makeT, type MessageKey } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/i18n/server";
import { SEARCH_PAGES } from "@/lib/search/pages";
import { runSearch, type SearchItem, type SearchKind } from "@/lib/search/engine";
import { parseSearchQuery } from "@/lib/search/rank";

export const dynamic = "force-dynamic";

export type { SearchKind, SearchItem };

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  items: SearchItem[];
}

const MAX_Q = 120;

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
  order: "search.group.orders",
  membership_plan: "search.group.membershipPlans",
  member: "search.group.members",
  project: "search.group.projects",
  supplier: "search.group.suppliers",
  purchase_order: "search.group.purchaseOrders",
  bill: "search.group.bills",
  staff: "search.group.staff",
  document: "search.group.documents",
  campaign: "search.group.campaigns",
  audience: "search.group.audiences",
  sequence: "search.group.sequences",
  product: "search.group.products",
  expense: "search.group.expenses",
  message: "search.group.messages",
  automation: "search.group.automations",
  report: "search.group.reports",
  snapshot: "search.group.snapshots",
  booking_type: "search.group.bookingTypes",
  location: "search.group.locations",
  transfer: "search.group.transfers",
  tax_filing: "search.group.taxFilings",
  shipment: "search.group.shipments",
  return: "search.group.returns",
  voucher: "search.group.vouchers",
  gift_card: "search.group.giftCards",
  survey: "search.group.surveys",
};

function searchPages(scope: Scope, q: string, t: ReturnType<typeof makeT>): SearchItem[] {
  const needle = q.toLowerCase();
  return SEARCH_PAGES.filter((p) => !p.area || scope.can(p.area))
    .map((p) => ({ href: p.href, label: p.key ? t(p.key) : p.label, fallback: p.label }))
    .filter((p) => p.label.toLowerCase().includes(needle) || p.fallback.toLowerCase().includes(needle) || p.href.includes(needle))
    .slice(0, 6)
    .map((p) => ({ kind: "page" as const, id: p.href, title: p.label, subtitle: p.href, href: p.href, icon: "layout-grid" }));
}

/**
 * GET /api/search?q=term — grouped, scope-aware results across the workspace.
 * Supports `kind:orders` and `in:billing` operators. Kinds the caller's role
 * cannot view are skipped; slow kinds are dropped after the 800 ms budget and
 * the response carries `partial: true`.
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
  const parsed = parseSearchQuery(q);

  if (parsed.text.length < 2) {
    const pages = searchPages(scope, "", t);
    return NextResponse.json({ q, groups: pages.length ? [{ kind: "page", label: t("search.group.pages"), items: pages }] : [], partial: false });
  }

  const orgTz = await import("@/lib/org-settings").then((m) => m.getOrgSettings(scope.dataId)).then((s) => s.timezone).catch(() => undefined);
  const result = await runSearch({ dataId: scope.dataId, actorId: scope.userId, q, can: scope.can, locale, timeZone: orgTz });
  const items = [...(parsed.kinds.length || parsed.areas.length ? [] : searchPages(scope, parsed.text, t)), ...result.items];

  // Group in order of each kind's best-ranked item.
  const order: SearchKind[] = [];
  const byKind = new Map<SearchKind, SearchItem[]>();
  for (const it of items) {
    if (!byKind.has(it.kind)) {
      byKind.set(it.kind, []);
      order.push(it.kind);
    }
    byKind.get(it.kind)!.push(it);
  }
  const groups: SearchGroup[] = order.map((kind) => ({ kind, label: t(GROUP_KEYS[kind]), items: byKind.get(kind)! }));
  return NextResponse.json({ q, groups, total: items.length, partial: result.partial });
}
