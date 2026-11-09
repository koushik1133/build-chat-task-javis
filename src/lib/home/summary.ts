import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import type { Area } from "@/lib/auth/roles";
import { getOrgSettings } from "@/lib/org-settings";
import { getBillingSettings } from "@/lib/money/settings";
import { convertMinor, listFxRates } from "@/lib/money/fx";
import { countUnreadInApp } from "@/lib/notifications/outbox";
import { getBalance } from "@/lib/credits/ledger";
import { runCashflow } from "@/lib/optimize";
import { demoRowCount } from "@/lib/demo/seed";
import {
  dayRangeInTz,
  deltaLabel,
  formatMinor,
  monthWindowsInTz,
  pctDelta,
  sortNeedsYou,
  type AgentRunItem,
  type HomeSummary,
  type KpiTile,
  type NeedsYouItem,
  type TimelineItem,
} from "./kpis";

/**
 * One-round-trip aggregation for /home. Every section is guarded: a missing
 * table or failing query yields `null` for that section (or a skipped tile)
 * instead of failing the whole payload. No LLM calls here.
 */

export interface SummaryScope {
  dataId: string;
  /** Actor (member) id — enables "assigned to me" items. */
  userId?: string | null;
  can(area: Area, edit?: boolean): boolean;
}

type CountRow = { n: string | number | null };
const num = (r: CountRow | null | undefined) => Number(r?.n ?? 0);
/** pg returns TIMESTAMPTZ as Date; normalise to ISO strings for the payload. */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

async function safe<T>(label: string, p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch (err) {
    console.warn(`[home/summary] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function buildHomeSummary(scope: SummaryScope, now = new Date()): Promise<HomeSummary> {
  const { dataId } = scope;
  const settings = await getOrgSettings(dataId).catch(() => ({ currency: "USD", timezone: "UTC", locale: "en" as const }));
  const currency = settings.currency || "USD";
  const timezone = settings.timezone || "UTC";
  const mw = monthWindowsInTz(now, timezone);
  const day = dayRangeInTz(now, timezone);
  const nowIso = now.toISOString();

  const [kpis, needsYou, today, agents, cashflow, demoRows] = await Promise.all([
    safe("kpis", () => buildKpis(scope, { currency, mw, day, nowIso, locale: settings.locale })),
    scope.can("agents") || scope.can("helpdesk") || scope.can("billing") || scope.can("crm")
      ? safe("needsYou", () => buildNeedsYou(scope, nowIso, currency))
      : Promise.resolve(null),
    scope.can("calendar") || scope.can("tasks") ? safe("today", () => buildToday(scope, day, timezone)) : Promise.resolve(null),
    scope.can("agents") ? safe("agents", () => buildAgents(dataId)) : Promise.resolve(null),
    scope.can("billing") || scope.can("reports")
      ? safe("cashflow", async () => {
          const fc = await runCashflow(dataId, { weeks: 8, now });
          return { currency: fc.currency, points: fc.weeks.map((w) => ({ weekStart: w.weekStart, balance: w.balance })) };
        })
      : Promise.resolve(null),
    safe("demo", () => demoRowCount(dataId)),
  ]);

  const empty = await safe("empty", async () => {
    const [c, q, b, t] = await Promise.all([
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM crm_contacts WHERE user_id = $1`, [dataId]).catch(() => null),
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM quotes WHERE user_id = $1`, [dataId]).catch(() => null),
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = $1`, [dataId]).catch(() => null),
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM tickets WHERE user_id = $1`, [dataId]).catch(() => null),
    ]);
    return num(c) + num(q) + num(b) + num(t) === 0;
  });

  return {
    generatedAt: nowIso,
    timezone,
    currency,
    kpis,
    needsYou,
    today,
    agents,
    cashflow,
    demo: { active: (demoRows ?? 0) > 0, rows: demoRows ?? 0 },
    empty: empty ?? false,
  };
}

interface KpiCtx {
  currency: string;
  locale: string;
  mw: ReturnType<typeof monthWindowsInTz>;
  day: { start: Date; end: Date };
  nowIso: string;
}

async function buildKpis(scope: SummaryScope, ctx: KpiCtx): Promise<KpiTile[]> {
  const { dataId } = scope;
  const tiles: Array<Promise<KpiTile | null>> = [];
  const tile = (area: Area, label: string, fn: () => Promise<KpiTile | null>) => {
    if (!scope.can(area)) return;
    tiles.push(safe(`kpi ${label}`, fn));
  };

  tile("billing", "revenue", async () => {
    if (!(await tableExists("invoice_payments"))) return null;
    // Net receipts per currency; converted into the reporting currency when the org has FX rates.
    const rows = await query<{ period: string; currency: string; total: string | number }>(
      `SELECT CASE WHEN p.created_at >= $2 THEN 'this' ELSE 'last' END AS period, p.currency, COALESCE(SUM(p.amount_minor - COALESCE(p.refunded_minor, 0)), 0) AS total
         FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE i.user_id = $1 AND p.status = 'succeeded' AND p.created_at >= $3 AND p.created_at < $4
        GROUP BY 1, 2`,
      [dataId, ctx.mw.thisStart.toISOString(), ctx.mw.lastStart.toISOString(), ctx.mw.nextStart.toISOString()]
    ).catch(() =>
      query<{ period: string; currency: string; total: string | number }>(
        `SELECT CASE WHEN p.created_at >= $2 THEN 'this' ELSE 'last' END AS period, p.currency, COALESCE(SUM(p.amount_minor), 0) AS total
           FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE i.user_id = $1 AND p.status = 'succeeded' AND p.created_at >= $3 AND p.created_at < $4
          GROUP BY 1, 2`,
        [dataId, ctx.mw.thisStart.toISOString(), ctx.mw.lastStart.toISOString(), ctx.mw.nextStart.toISOString()]
      )
    );
    const billing = await getBillingSettings(dataId).catch(() => null);
    const reporting = billing?.reporting_currency ?? ctx.currency;
    const rates = rows.some((r) => r.currency.toUpperCase() !== reporting) ? await listFxRates(dataId).catch(() => []) : [];
    let unconverted = 0;
    const sum = (period: string) =>
      rows
        .filter((r) => r.period === period)
        .reduce((acc, r) => {
          const v = convertMinor(Number(r.total), r.currency, reporting, rates);
          if (v === null) {
            unconverted++;
            return acc;
          }
          return acc + v;
        }, 0);
    const cur = sum("this");
    const prev = sum("last");
    const delta = pctDelta(cur, prev);
    return {
      key: "revenue", label: "Revenue this month", value: formatMinor(cur, reporting, ctx.locale),
      hint: unconverted > 0 ? `${deltaLabel(delta)} · some currencies lack an FX rate` : deltaLabel(delta),
      deltaPct: delta, tone: delta === null || delta >= 0 ? "good" : "bad", href: "/billing",
    };
  });

  tile("billing", "open quotes", async () => {
    const r = await queryOne<{ n: string | number; total: string | number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS total FROM quotes WHERE user_id = $1 AND status IN ('draft', 'sent', 'viewed')`,
      [dataId]
    );
    const n = Number(r?.n ?? 0);
    return { key: "quotes", label: "Open quotes", value: formatMinor(Number(r?.total ?? 0), ctx.currency, ctx.locale), hint: `${n} quote${n === 1 ? "" : "s"} awaiting a decision`, tone: "neutral", href: "/billing" };
  });

  tile("calendar", "bookings", async () => {
    const r = await queryOne<CountRow>(
      `SELECT COUNT(*) AS n FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3`,
      [dataId, ctx.day.start.toISOString(), ctx.day.end.toISOString()]
    );
    const n = num(r);
    return { key: "bookings", label: "Bookings today", value: String(n), hint: n === 0 ? "Nothing scheduled" : "confirmed", tone: "neutral", href: "/calendar" };
  });

  tile("helpdesk", "tickets", async () => {
    if (!(await tableExists("tickets"))) return null;
    const r = await queryOne<{ open: string | number; risk: string | number }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('open', 'pending')) AS open,
              COUNT(*) FILTER (WHERE status IN ('open', 'pending') AND (breached_first_response OR breached_resolution
                     OR (first_responded_at IS NULL AND first_response_due_at IS NOT NULL AND first_response_due_at < $2::timestamptz + INTERVAL '1 hour')
                     OR (resolved_at IS NULL AND resolution_due_at IS NOT NULL AND resolution_due_at < $2::timestamptz + INTERVAL '4 hours'))) AS risk
         FROM tickets WHERE user_id = $1`,
      [dataId, ctx.nowIso]
    );
    const risk = Number(r?.risk ?? 0);
    return { key: "tickets", label: "Open tickets", value: String(Number(r?.open ?? 0)), hint: risk > 0 ? `${risk} SLA at risk` : "SLA on track", tone: risk > 0 ? "warn" : "good", href: "/helpdesk" };
  });

  tile("tasks", "tasks", async () => {
    const [t, r] = await Promise.all([
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND done = FALSE`, [dataId]).catch(() => null),
      queryOne<CountRow>(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND done = FALSE AND due_at IS NOT NULL AND due_at < $2`, [dataId, ctx.nowIso]).catch(() => null),
    ]);
    const overdue = num(r);
    return { key: "tasks", label: "Open tasks", value: String(num(t)), hint: overdue > 0 ? `${overdue} task${overdue === 1 ? "" : "s"} overdue` : "Nothing overdue", tone: overdue > 0 ? "warn" : "neutral", href: "/tasks?overdue=1" };
  });

  tile("messaging", "inbox", async () => {
    if (!(await tableExists("notification_outbox"))) return null;
    const n = await countUnreadInApp(dataId);
    return { key: "inbox", label: "Unread notifications", value: String(n), hint: n > 0 ? "in your inbox" : "All caught up", tone: "neutral", href: "/settings/notifications" };
  });

  tile("settings", "credits", async () => {
    if (!(await tableExists("ai_credit_accounts"))) return null;
    const bal = await getBalance(dataId);
    return { key: "credits", label: "AI credits", value: new Intl.NumberFormat(ctx.locale).format(bal), hint: bal < 500 ? "Running low" : "available", tone: bal < 500 ? "warn" : "neutral", href: "/settings/ai" };
  });

  const out = await Promise.all(tiles);
  return out.filter((t): t is KpiTile => t !== null);
}

async function buildNeedsYou(scope: SummaryScope, nowIso: string, currency: string): Promise<NeedsYouItem[]> {
  const { dataId } = scope;
  const items: NeedsYouItem[] = [];
  const jobs: Array<Promise<unknown>> = [];

  if (scope.can("agents")) {
    jobs.push(safe("approvals", async () => {
      const rows = await query<{ id: string; tool_name: string; preview: string | null; created_at: string }>(
        `SELECT id, tool_name, preview, created_at FROM approvals WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 5`,
        [dataId]
      );
      for (const r of rows) items.push({ kind: "approval", id: r.id, title: `Approve: ${r.tool_name}`, detail: (r.preview ?? "").slice(0, 120) || "An agent is waiting for your decision", href: "/approvals", rank: 0 });
    }));
  }
  if (scope.can("helpdesk")) {
    jobs.push(safe("sla", async () => {
      if (!(await tableExists("tickets"))) return;
      const rows = await query<{ id: string; number: number; subject: string; priority: string }>(
        `SELECT id, number, subject, priority FROM tickets WHERE user_id = $1 AND status IN ('open', 'pending') AND (breached_first_response OR breached_resolution)
          ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at ASC LIMIT 5`,
        [dataId]
      );
      for (const r of rows) items.push({ kind: "sla", id: r.id, title: `SLA breached · #${r.number}`, detail: r.subject, href: `/helpdesk?ticket=${encodeURIComponent(r.id)}`, rank: 1 });
    }));
  }
  if (scope.can("billing")) {
    jobs.push(safe("overdue invoices", async () => {
      const rows = await query<{ id: string; number: string; total_minor: string | number; paid_minor: string | number; due_at: string; currency: string }>(
        `SELECT id, number, total_minor, paid_minor, due_at, currency FROM invoices WHERE user_id = $1 AND status IN ('sent', 'partially_paid', 'overdue') AND due_at IS NOT NULL AND due_at < $2
          ORDER BY due_at ASC LIMIT 5`,
        [dataId, nowIso]
      );
      for (const r of rows) {
        const owed = Number(r.total_minor) - Number(r.paid_minor);
        const days = Math.max(1, Math.floor((Date.parse(nowIso) - Date.parse(iso(r.due_at))) / 86_400_000));
        items.push({ kind: "invoice", id: r.id, title: `Invoice ${r.number} overdue`, detail: `${formatMinor(owed, r.currency || currency)} · ${days} day${days === 1 ? "" : "s"} late`, href: `/billing?invoice=${encodeURIComponent(r.id)}`, rank: 2 });
      }
    }));
  }
  if (scope.can("crm")) {
    jobs.push(safe("stalled deals", async () => {
      // Mirrors the stalled-deal playbook detector (read-only, no LLM).
      const rows = await query<{ id: string; full_name: string; company: string | null; deal_value: string | null }>(
        `SELECT id, full_name, company, deal_value FROM crm_contacts
          WHERE user_id = $1 AND lifecycle IN ('lead', 'prospect')
            AND (last_contact IS NULL OR last_contact < NOW() - INTERVAL '7 days')
            AND created_at < NOW() - INTERVAL '7 days'
          ORDER BY deal_value DESC NULLS LAST, created_at ASC LIMIT 5`,
        [dataId]
      );
      for (const r of rows) items.push({ kind: "deal", id: r.id, title: `Stalled: ${r.full_name}`, detail: `${r.company ? r.company + " · " : ""}no touch in 7+ days`, href: `/crm?contact=${encodeURIComponent(r.id)}`, rank: 3 });
    }));
  }
  if (scope.can("tasks") && scope.userId) {
    jobs.push(safe("my overdue tasks", async () => {
      const rows = await query<{ id: string; title: string; due_at: string; project_name: string | null }>(
        `SELECT t.id::text AS id, t.title, t.due_at, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.user_id = $1 AND t.done = FALSE AND t.deleted_at IS NULL AND t.assignee_id = $2 AND t.due_at IS NOT NULL AND t.due_at < $3
          ORDER BY t.due_at ASC LIMIT 5`,
        [dataId, scope.userId, nowIso]
      ).catch(() => []);
      for (const r of rows) {
        const days = Math.max(1, Math.floor((Date.parse(nowIso) - Date.parse(iso(r.due_at))) / 86_400_000));
        items.push({ kind: "task", id: r.id, title: `Overdue: ${r.title}`, detail: `${r.project_name ? r.project_name + " · " : ""}${days} day${days === 1 ? "" : "s"} late`, href: "/tasks?mine=1", rank: 2 });
      }
    }));
  }
  if (scope.can("tasks")) {
    jobs.push(safe("milestones due", async () => {
      if (!(await tableExists("project_milestones"))) return;
      const weekEnd = new Date(Date.parse(nowIso) + 7 * 86_400_000).toISOString().slice(0, 10);
      const rows = await query<{ id: string; name: string; due_on: string; project_id: string; project_name: string }>(
        `SELECT m.id, m.name, m.due_on::text AS due_on, m.project_id, p.name AS project_name FROM project_milestones m JOIN projects p ON p.id = m.project_id
          WHERE m.user_id = $1 AND m.status = 'open' AND m.due_on IS NOT NULL AND m.due_on <= $2 AND p.archived_at IS NULL AND p.status IN ('planning', 'active')
          ORDER BY m.due_on ASC LIMIT 5`,
        [dataId, weekEnd]
      );
      for (const r of rows) {
        const late = r.due_on < nowIso.slice(0, 10);
        items.push({ kind: "milestone", id: r.id, title: `${late ? "Milestone overdue" : "Milestone due"}: ${r.name}`, detail: `${r.project_name} · ${late ? "was due" : "due"} ${r.due_on}`, href: `/projects/${encodeURIComponent(r.project_id)}`, rank: late ? 2 : 4 });
      }
    }));
  }
  await Promise.all(jobs);
  return sortNeedsYou(items).slice(0, 12);
}

async function buildToday(scope: SummaryScope, day: { start: Date; end: Date }, timezone: string): Promise<TimelineItem[]> {
  const { dataId } = scope;
  const items: TimelineItem[] = [];
  const jobs: Array<Promise<unknown>> = [];
  if (scope.can("calendar")) {
    jobs.push(safe("today bookings", async () => {
      const rows = await query<{ id: string; name: string; starts_at: string; ends_at: string; notes: string | null; type_name: string | null }>(
        `SELECT b.id, b.name, b.starts_at, b.ends_at, b.notes, t.name AS type_name FROM bookings b LEFT JOIN booking_types t ON t.id = b.booking_type_id
          WHERE b.user_id = $1 AND b.status = 'confirmed' AND b.starts_at >= $2 AND b.starts_at < $3 ORDER BY b.starts_at ASC LIMIT 20`,
        [dataId, day.start.toISOString(), day.end.toISOString()]
      );
      for (const r of rows) {
        const mins = Math.round((Date.parse(iso(r.ends_at)) - Date.parse(iso(r.starts_at))) / 60_000);
        items.push({ kind: "booking", id: r.id, title: r.type_name ? `${r.type_name} · ${r.name}` : r.name, at: iso(r.starts_at), detail: `${mins} min${r.notes ? " · " + r.notes.slice(0, 80) : ""}`, href: "/calendar" });
      }
    }));
  }
  if (scope.can("tasks")) {
    jobs.push(safe("today tasks", async () => {
      const rows = await query<{ id: string; title: string }>(`SELECT id, title FROM tasks WHERE user_id = $1 AND done = FALSE ORDER BY created_at DESC LIMIT 6`, [dataId]);
      for (const r of rows) items.push({ kind: "task", id: String(r.id), title: r.title, at: null, href: "/tasks" });
      if (await tableExists("records")) {
        const due = await query<{ id: string; title: string; due_at: string; type_slug: string | null }>(
          `SELECT r.id, r.title, r.due_at, t.slug AS type_slug FROM records r LEFT JOIN record_types t ON t.id = r.type_id
            WHERE r.user_id = $1 AND r.deleted_at IS NULL AND r.due_at >= $2 AND r.due_at < $3 ORDER BY r.due_at ASC LIMIT 10`,
          [dataId, day.start.toISOString(), day.end.toISOString()]
        );
        for (const r of due) items.push({ kind: "task", id: r.id, title: r.title, at: iso(r.due_at), detail: "due today", href: r.type_slug ? `/r/${r.type_slug}` : "/r" });
      }
    }));
  }
  await Promise.all(jobs);
  void timezone;
  return items.sort((a, b) => (a.at ?? "9").localeCompare(b.at ?? "9"));
}

async function buildAgents(dataId: string): Promise<AgentRunItem[]> {
  const rows = await query<{ id: string; status: string | null; created_at: string; agent: string | null }>(
    `SELECT r.id, r.status, r.created_at, a.name AS agent FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id
      WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 6`,
    [dataId]
  );
  return rows.map((r) => ({ id: String(r.id), agent: r.agent ?? "Agent", status: r.status ?? "done", createdAt: iso(r.created_at), href: `/agents?run=${encodeURIComponent(String(r.id))}` }));
}
