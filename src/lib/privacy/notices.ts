import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { getPrivacySettings } from "./settings";
import type { PrivacySettings } from "./constants";

/**
 * Versioned privacy notices. A published row is immutable; "editing" publishes
 * version+1 so every consent record can reference the text the person saw.
 */

export interface NoticeRow {
  id: string;
  user_id: string;
  version: number;
  locale: string;
  body_md: string;
  published_at: string | null;
  created_at: string;
}

const COLS = `id, user_id, version, locale, body_md, published_at, created_at`;

export async function listNotices(dataId: string, locale?: string | null): Promise<NoticeRow[]> {
  const values: unknown[] = [dataId];
  let where = "user_id = $1";
  if (locale) {
    values.push(locale);
    where += ` AND locale = $2`;
  }
  return query<NoticeRow>(`SELECT ${COLS} FROM privacy_notices WHERE ${where} ORDER BY locale ASC, version DESC LIMIT 200`, values).catch(() => []);
}

export async function latestPublished(dataId: string, locale = "en"): Promise<NoticeRow | null> {
  if (!(await tableExists("privacy_notices"))) return null;
  const row = await queryOne<NoticeRow>(`SELECT ${COLS} FROM privacy_notices WHERE user_id = $1 AND locale = $2 AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1`, [dataId, locale]).catch(() => null);
  if (row || locale === "en") return row;
  return queryOne<NoticeRow>(`SELECT ${COLS} FROM privacy_notices WHERE user_id = $1 AND locale = 'en' AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1`, [dataId]).catch(() => null);
}

/** Publish a new immutable version. */
export async function publishNotice(dataId: string, input: { locale: string; body_md: string }, actorId: string | null): Promise<NoticeRow> {
  const last = await queryOne<{ v: number | string | null }>(`SELECT MAX(version) AS v FROM privacy_notices WHERE user_id = $1 AND locale = $2`, [dataId, input.locale]);
  const version = (Number(last?.v) || 0) + 1;
  const row = await queryOne<NoticeRow>(
    `INSERT INTO privacy_notices (id, user_id, version, locale, body_md, published_at, created_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, version, input.locale, input.body_md]
  );
  if (!row) throw new Error("notice insert returned no row");
  await recordAudit({ dataId, userId: actorId }, { action: "privacy.notice.published", entity: "privacy_notice", entityId: row.id, after: { version, locale: input.locale } });
  return row;
}

export interface PublicNotice {
  org: { name: string; slug: string };
  notice: { version: number; locale: string; body_md: string; published_at: string } | null;
  grievance: Pick<PrivacySettings, "grievance_officer_name" | "grievance_officer_email" | "dsr_due_days">;
}

/** Public rendering by org slug (no auth). */
export async function publicNoticeBySlug(slug: string, locale = "en"): Promise<PublicNotice | null> {
  const org = await queryOne<{ owner_user_id: string; name: string; slug: string }>(`SELECT owner_user_id, name, slug FROM organizations WHERE slug = $1`, [slug]).catch(() => null);
  if (!org) return null;
  const [notice, settings] = await Promise.all([latestPublished(org.owner_user_id, locale), getPrivacySettings(org.owner_user_id)]);
  return {
    org: { name: org.name, slug: org.slug },
    notice: notice && notice.published_at ? { version: notice.version, locale: notice.locale, body_md: notice.body_md, published_at: notice.published_at } : null,
    grievance: { grievance_officer_name: settings.grievance_officer_name, grievance_officer_email: settings.grievance_officer_email, dsr_due_days: settings.dsr_due_days },
  };
}
