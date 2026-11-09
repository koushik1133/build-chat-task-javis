import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { getOrgSettings } from "@/lib/org-settings";
import { appOrigin, issueShareToken } from "@/lib/share-tokens";
import { buildHomeSummary } from "@/lib/home/summary";
import type { HomeSummary, KpiTile, NeedsYouItem } from "@/lib/home/kpis";
import { DEFAULT_MATRIX, isRole, type Area, type Role } from "@/lib/auth/roles";
import { listDigestMembers, listDigestOrgs, markDigestSent, type NotificationPreferences } from "@/lib/notifications/preferences";
import { getSavedReportById, listSchedules, toSchedule, type ReportSchedule, type ReportScheduleRow, type SavedReport } from "./store";
import { runReport, type ReportResult } from "./query";
import { escapeHtml, reportHtmlTable } from "./export";
import { nextRunAt } from "./schedule";

/**
 * Digests and scheduled report delivery. Both are cron-driven, idempotent
 * (conditional UPDATE claims) and write to the notification outbox only.
 */

export const REPORT_TOKEN_TTL_DAYS = 7;

/* ─── pure content builders ─────────────────────────────────────────────── */

export interface DigestReportSection {
  name: string;
  html: string;
  link: string | null;
  row_count: number;
}

export interface DigestInput {
  orgName: string;
  cadence: "daily" | "weekly";
  kpis: KpiTile[];
  needsYou: NeedsYouItem[];
  reports: DigestReportSection[];
  appUrl: string;
}

export interface DigestContent { subject: string; html: string; text: string }

function kpiHtml(t: KpiTile): string {
  const delta = typeof t.deltaPct === "number" ? ` <span style="color:${t.deltaPct >= 0 ? "#15803d" : "#b91c1c"};font-size:12px">${t.deltaPct >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(t.deltaPct))}%</span>` : "";
  return `<td style="padding:10px 12px;border:1px solid #eee;border-radius:8px;vertical-align:top"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666">${escapeHtml(t.label)}</div><div style="font-size:20px;font-weight:600;margin-top:2px">${escapeHtml(t.value)}${delta}</div>${t.hint ? `<div style="font-size:12px;color:#666;margin-top:2px">${escapeHtml(t.hint)}</div>` : ""}</td>`;
}

export function buildDigestContent(input: DigestInput): DigestContent {
  const period = input.cadence === "daily" ? "Daily" : "Weekly";
  const subject = `${period} digest · ${input.orgName}${input.needsYou.length ? ` · ${input.needsYou.length} need${input.needsYou.length === 1 ? "s" : ""} you` : ""}`;
  const kpis = input.kpis.length ? `<table role="presentation" style="border-collapse:separate;border-spacing:8px;width:100%"><tr>${input.kpis.slice(0, 4).map(kpiHtml).join("")}</tr></table>` : "";
  const needs = input.needsYou.length
    ? `<h3 style="font-size:14px;margin:20px 0 8px">Needs you</h3><ul style="padding-left:18px;margin:0">${input.needsYou.slice(0, 10).map((n) => `<li style="margin:4px 0;font-size:13px"><a href="${escapeHtml(input.appUrl + n.href)}" style="color:#1d4ed8">${escapeHtml(n.title)}</a> <span style="color:#666">— ${escapeHtml(n.detail)}</span></li>`).join("")}</ul>`
    : `<p style="font-size:13px;color:#666;margin-top:16px">Nothing is waiting on you right now.</p>`;
  const reports = input.reports
    .map((r) => `<h3 style="font-size:14px;margin:20px 0 8px">${escapeHtml(r.name)}</h3>${r.html}${r.link ? `<p style="font-size:12px"><a href="${escapeHtml(r.link)}" style="color:#1d4ed8">Download CSV</a> (link valid ${REPORT_TOKEN_TTL_DAYS} days)</p>` : ""}`)
    .join("");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:640px"><h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(period)} digest for ${escapeHtml(input.orgName)}</h2>${kpis}${needs}${reports}<p style="font-size:12px;color:#666;margin-top:24px">Change how often you get this under <a href="${escapeHtml(input.appUrl)}/settings/notifications" style="color:#1d4ed8">Settings → Notifications</a>.</p></div>`;
  const text = [
    `${period} digest for ${input.orgName}`,
    ...input.kpis.map((k) => `${k.label}: ${k.value}${k.hint ? ` (${k.hint})` : ""}`),
    input.needsYou.length ? `Needs you:` : "Nothing is waiting on you.",
    ...input.needsYou.map((n) => `- ${n.title} — ${n.detail} ${input.appUrl}${n.href}`),
    ...input.reports.map((r) => `${r.name}: ${r.row_count} rows${r.link ? ` ${r.link}` : ""}`),
  ].join("\n");
  return { subject, html, text };
}

export interface ScheduleMailInput {
  report: Pick<SavedReport, "name" | "description">;
  result: ReportResult;
  format: ReportSchedule["format"];
  link: string | null;
  appUrl: string;
  cadence: ReportSchedule["cadence"];
}

export function buildScheduleContent(input: ScheduleMailInput): DigestContent {
  const subject = `${input.report.name} · ${input.cadence} report`;
  const table = input.format === "inline" || input.result.rows.length <= 25 ? reportHtmlTable(input.result) : `<p style="font-size:13px">${input.result.rows.length} rows.</p>`;
  const link = input.link ? `<p style="font-size:13px"><a href="${escapeHtml(input.link)}" style="color:#1d4ed8">Download ${input.format === "pdf" ? "PDF" : "CSV"}</a> (link valid ${REPORT_TOKEN_TTL_DAYS} days)</p>` : "";
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:640px"><h2 style="font-size:18px;margin:0 0 4px">${escapeHtml(input.report.name)}</h2>${input.report.description ? `<p style="font-size:13px;color:#666;margin:0 0 12px">${escapeHtml(input.report.description)}</p>` : ""}${table}${link}<p style="font-size:12px;color:#666;margin-top:20px">Scheduled from <a href="${escapeHtml(input.appUrl)}/reports" style="color:#1d4ed8">Reports</a>.</p></div>`;
  const text = `${input.report.name}\n${input.result.rows.length} rows${input.link ? `\n${input.link}` : ""}`;
  return { subject, html, text };
}

/** Is a member's digest due? Pure: cadence anchored on the last send (or 36h/8d ago when never sent). */
export function digestDue(prefs: Pick<NotificationPreferences, "digest" | "digest_hour" | "digest_weekday">, lastSentAt: string | null, now: Date, timeZone: string): boolean {
  if (prefs.digest !== "daily" && prefs.digest !== "weekly") return false;
  const anchor = lastSentAt ? new Date(lastSentAt) : new Date(now.getTime() - (prefs.digest === "daily" ? 36 : 8 * 24) * 3_600_000);
  const next = nextRunAt({ cadence: prefs.digest, hour: prefs.digest_hour, weekday: prefs.digest_weekday ?? 1 }, anchor, timeZone);
  return next.getTime() <= now.getTime();
}

/* ─── member scope ──────────────────────────────────────────────────────── */

async function memberRole(dataId: string, memberUserId: string): Promise<Role | null> {
  if (memberUserId === dataId) return "owner";
  const row = await queryOne<{ role: string }>(
    `SELECT m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.owner_user_id = $1 AND m.user_id = $2 AND m.status = 'active' LIMIT 1`,
    [dataId, memberUserId]
  ).catch(() => null);
  return row && isRole(row.role) ? row.role : null;
}

function canFor(role: Role): (area: Area, edit?: boolean) => boolean {
  return (area, edit = false) => {
    const p = DEFAULT_MATRIX[role][area];
    return Boolean(p && p.view && (!edit || p.edit));
  };
}

async function orgName(dataId: string): Promise<string> {
  const row = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1 LIMIT 1`, [dataId]).catch(() => null);
  return row?.name ?? "your workspace";
}

/* ─── scheduled reports ─────────────────────────────────────────────────── */

export interface SendResult { sent: number; skipped: number; failed: number }

/** Issue a 7-day public CSV/PDF link for a saved report. */
export async function issueReportLink(dataId: string, reportId: string, format: "csv" | "pdf" = "csv"): Promise<string> {
  const t = await issueShareToken(dataId, "report", reportId, REPORT_TOKEN_TTL_DAYS);
  return format === "pdf" ? `${t.url}?format=pdf` : t.url;
}

/** Claim and deliver every enabled schedule whose next_run_at has passed. Never throws. */
export async function sendDueReportSchedules(limit = 20, now = new Date()): Promise<SendResult> {
  const out: SendResult = { sent: 0, skipped: 0, failed: 0 };
  if (!(await tableExists("report_schedules"))) return out;
  let due: ReportScheduleRow[] = [];
  try {
    due = await query<ReportScheduleRow>(`SELECT * FROM report_schedules WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at ASC LIMIT $2`, [now.toISOString(), Math.max(1, Math.min(200, limit))]);
  } catch (err) {
    console.error("[reports/schedules] list failed:", err);
    return out;
  }
  for (const row of due) {
    const s = toSchedule(row);
    const tz = (await getOrgSettings(row.user_id).catch(() => null))?.timezone ?? "UTC";
    const next = nextRunAt({ cadence: s.cadence, hour: s.hour, weekday: s.weekday, dayOfMonth: s.day_of_month }, now, tz);
    // Claim: only one worker advances next_run_at.
    const claimed = await query<{ id: string }>(`UPDATE report_schedules SET next_run_at = $3, last_sent_at = $2, updated_at = NOW() WHERE id = $1 AND enabled = TRUE AND next_run_at <= $2 RETURNING id`, [row.id, now.toISOString(), next.toISOString()]).catch(() => []);
    if (claimed.length === 0) {
      out.skipped++;
      continue;
    }
    try {
      const report = await getSavedReportById(row.user_id, s.report_id);
      if (!report) {
        await query(`UPDATE report_schedules SET enabled = FALSE WHERE id = $1`, [row.id]).catch(() => undefined);
        out.skipped++;
        continue;
      }
      const result = await runReport(row.user_id, report.spec, { now });
      const link = s.format === "inline" ? null : await issueReportLink(row.user_id, report.id, s.format);
      const content = buildScheduleContent({ report, result, format: s.format, link, appUrl: appOrigin(), cadence: s.cadence });
      for (const to of s.recipients) {
        await enqueueNotification(row.user_id, {
          channel: "email",
          recipient: to,
          subject: content.subject,
          body: content.html,
          data: { kind: "report.scheduled", category: "reports", member_user_id: s.created_by, schedule_id: s.id, report_id: report.id, link },
        });
      }
      out.sent++;
    } catch (err) {
      out.failed++;
      console.error(`[reports/schedules] ${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/* ─── digests ───────────────────────────────────────────────────────────── */

async function reportSections(dataId: string, memberUserId: string, cadence: "daily" | "weekly", now: Date): Promise<DigestReportSection[]> {
  // Scheduled reports created by this member with the same cadence are summarised inline in the digest.
  const schedules = (await listSchedules(dataId).catch(() => [])).filter((s) => s.enabled && s.created_by === memberUserId && s.cadence === cadence).slice(0, 3);
  const sections: DigestReportSection[] = [];
  for (const s of schedules) {
    const report = await getSavedReportById(dataId, s.report_id);
    if (!report) continue;
    try {
      const result = await runReport(dataId, report.spec, { now });
      const link = await issueReportLink(dataId, report.id, "csv");
      sections.push({ name: report.name, html: reportHtmlTable(result, 10), link, row_count: result.rows.length });
    } catch (err) {
      console.warn(`[digest] report ${report.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return sections;
}

/** Send daily/weekly digests to every member whose digest is due. Never throws. */
export async function sendDueDigests(limit = 50, now = new Date()): Promise<SendResult> {
  const out: SendResult = { sent: 0, skipped: 0, failed: 0 };
  let orgs: string[] = [];
  try {
    orgs = await listDigestOrgs(limit);
  } catch (err) {
    console.error("[digest] list orgs failed:", err);
    return out;
  }
  let budget = Math.max(1, limit);
  for (const dataId of orgs) {
    if (budget <= 0) break;
    const settings = await getOrgSettings(dataId).catch(() => null);
    const tz = settings?.timezone ?? "UTC";
    const members = await listDigestMembers(dataId).catch(() => []);
    for (const m of members) {
      if (budget <= 0) break;
      if (!digestDue(m.prefs, m.last_digest_at, now, tz)) {
        out.skipped++;
        continue;
      }
      if (!m.prefs.channels.reports.email) {
        await markDigestSent(dataId, m.member_user_id, now).catch(() => undefined);
        out.skipped++;
        continue;
      }
      // Claim before building so two ticks never double-send.
      const claimed = await query<{ id: string }>(`UPDATE notification_preferences SET last_digest_at = $3 WHERE user_id = $1 AND member_user_id = $2 AND (last_digest_at IS NULL OR last_digest_at < $3) RETURNING id`, [dataId, m.member_user_id, now.toISOString()]).catch(() => []);
      if (claimed.length === 0) {
        out.skipped++;
        continue;
      }
      budget--;
      try {
        const recipient = m.email ?? (await queryOne<{ invited_email: string | null }>(`SELECT m.invited_email FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.owner_user_id = $1 AND m.user_id = $2 LIMIT 1`, [dataId, m.member_user_id]).catch(() => null))?.invited_email;
        if (!recipient) {
          out.skipped++;
          continue;
        }
        const role = (await memberRole(dataId, m.member_user_id)) ?? "member";
        const cadence = m.prefs.digest === "daily" ? "daily" : "weekly";
        const [summary, name, reports] = await Promise.all([
          buildHomeSummary({ dataId, can: canFor(role) }, now) as Promise<HomeSummary>,
          orgName(dataId),
          reportSections(dataId, m.member_user_id, cadence, now),
        ]);
        const content = buildDigestContent({ orgName: name, cadence, kpis: summary.kpis ?? [], needsYou: summary.needsYou ?? [], reports, appUrl: appOrigin() });
        await enqueueNotification(dataId, {
          channel: "email",
          recipient,
          subject: content.subject,
          body: content.html,
          data: { kind: "digest", category: "reports", member_user_id: m.member_user_id, cadence },
        });
        out.sent++;
      } catch (err) {
        out.failed++;
        console.error(`[digest] ${dataId}/${m.member_user_id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}
