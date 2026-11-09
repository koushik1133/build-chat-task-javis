import { query, queryOne } from "@/lib/dsql";
import { KERNELHUB_NAME } from "@/lib/brand";
import { requestMemo } from "@/lib/request-cache";

/**
 * White-label branding per org, keyed by the org data id (owner_user_id).
 * Public surfaces (/p/*, /book/*) and outbound emails read it; the app shell
 * itself keeps the KernelHub identity.
 */
export interface Branding {
  brand_name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  email_footer: string | null;
  custom_domain: string | null;
  support_email: string | null;
  favicon_url: string | null;
  updated_at: string | null;
  /** False when the org has never saved branding (defaults in use). */
  configured: boolean;
}

export const DEFAULT_BRANDING: Branding = {
  brand_name: KERNELHUB_NAME,
  logo_url: null,
  primary_color: "#f97316", // matches --primary (25 95% 53%)
  accent_color: "#f59e0b",
  email_footer: null,
  custom_domain: null,
  support_email: null,
  favicon_url: null,
  updated_at: null,
  configured: false,
};

export const BRANDING_COLUMNS = [
  "brand_name",
  "logo_url",
  "primary_color",
  "accent_color",
  "email_footer",
  "custom_domain",
  "support_email",
  "favicon_url",
] as const;
export type BrandingColumn = (typeof BRANDING_COLUMNS)[number];

/** Fields to write; `null` clears a field back to its default. */
export type BrandingPatch = { [K in BrandingColumn]?: Branding[K] | null };


interface BrandingRow {
  brand_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  email_footer: string | null;
  custom_domain: string | null;
  support_email: string | null;
  favicon_url: string | null;
  updated_at: string | Date | null;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

/**
 * Only absolute http(s) URLs may be used as a logo / favicon source. These
 * values end up in `<img src>`, `<link rel="icon">` and outbound email, so a
 * `javascript:` or `data:` scheme (both accepted by a plain URL check) would be
 * a stored XSS vector on every white-labelled surface.
 */
export function isSafeAssetUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2000) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A plain mailbox address safe to place inside a `mailto:` href (no header injection via `?`, `&`, quotes or whitespace). */
export function isPlainEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
}

function rowToBranding(row: BrandingRow | null): Branding {
  if (!row) return DEFAULT_BRANDING;
  return {
    brand_name: row.brand_name?.trim() || DEFAULT_BRANDING.brand_name,
    logo_url: isSafeAssetUrl(row.logo_url) ? row.logo_url : null,
    primary_color: isHexColor(row.primary_color) ? row.primary_color.toLowerCase() : DEFAULT_BRANDING.primary_color,
    accent_color: isHexColor(row.accent_color) ? row.accent_color.toLowerCase() : DEFAULT_BRANDING.accent_color,
    email_footer: row.email_footer || null,
    custom_domain: row.custom_domain || null,
    support_email: isPlainEmail(row.support_email) ? row.support_email : null,
    favicon_url: isSafeAssetUrl(row.favicon_url) ? row.favicon_url : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    configured: true,
  };
}

/** Uncached loader (exported for tests); callers use `getBranding`. */
export async function loadBranding(dataId: string): Promise<Branding> {
  const row = await queryOne<BrandingRow>(
    `SELECT brand_name, logo_url, primary_color, accent_color, email_footer, custom_domain, support_email, favicon_url, updated_at
       FROM org_branding WHERE user_id = $1`,
    [dataId]
  ).catch(() => null);
  return rowToBranding(row);
}

/**
 * Branding for an org, with defaults when unset or when the table is missing.
 * Per-request memoised: public layouts, email wrappers and metadata all ask
 * for the same org's branding within one render.
 */
export const getBranding: (dataId: string) => Promise<Branding> = requestMemo(loadBranding);

/** Upsert the given fields (null clears a field). Returns the merged branding. */
export async function updateBranding(dataId: string, patch: BrandingPatch): Promise<Branding> {
  const current = await getBranding(dataId);
  const pick = <K extends BrandingColumn>(k: K): Branding[K] | null => {
    const v = patch[k];
    if (v !== undefined) return v === "" ? null : v;
    if (k === "brand_name" && !current.configured) return null;
    return current[k];
  };
  const next = {
    brand_name: pick("brand_name"),
    logo_url: pick("logo_url"),
    primary_color: pick("primary_color") ?? DEFAULT_BRANDING.primary_color,
    accent_color: pick("accent_color") ?? DEFAULT_BRANDING.accent_color,
    email_footer: pick("email_footer"),
    custom_domain: pick("custom_domain"),
    support_email: pick("support_email"),
    favicon_url: pick("favicon_url"),
  };
  await query(
    `INSERT INTO org_branding (user_id, brand_name, logo_url, primary_color, accent_color, email_footer, custom_domain, support_email, favicon_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       brand_name = EXCLUDED.brand_name, logo_url = EXCLUDED.logo_url, primary_color = EXCLUDED.primary_color,
       accent_color = EXCLUDED.accent_color, email_footer = EXCLUDED.email_footer, custom_domain = EXCLUDED.custom_domain,
       support_email = EXCLUDED.support_email, favicon_url = EXCLUDED.favicon_url, updated_at = NOW()`,
    [
      dataId,
      next.brand_name,
      next.logo_url,
      next.primary_color,
      next.accent_color,
      next.email_footer,
      next.custom_domain,
      next.support_email,
      next.favicon_url,
    ]
  );
  // Fresh read: the memoised `getBranding` may hold the pre-write row for this request.
  return loadBranding(dataId);
}

export async function resetBranding(dataId: string): Promise<void> {
  await query(`DELETE FROM org_branding WHERE user_id = $1`, [dataId]).catch(() => undefined);
}

// ── CSS vars ────────────────────────────────────────────────────────────────

import { hexToHslTriplet, readableTextOn } from "./branding-colors";
export { hexToHslTriplet, readableTextOn };

/**
 * CSS custom properties for a branded surface. Includes both raw brand vars
 * and overrides of the Tailwind theme tokens so `bg-primary`, `text-primary`
 * and focus rings pick the brand colour up automatically.
 */
export function brandingToCssVars(b: Pick<Branding, "primary_color" | "accent_color">): Record<string, string> {
  const primary = isHexColor(b.primary_color) ? b.primary_color : DEFAULT_BRANDING.primary_color;
  const accent = isHexColor(b.accent_color) ? b.accent_color : DEFAULT_BRANDING.accent_color;
  return {
    "--brand-primary": primary,
    "--brand-accent": accent,
    "--brand-primary-foreground": readableTextOn(primary),
    "--primary": hexToHslTriplet(primary),
    "--primary-foreground": readableTextOn(primary) === "#ffffff" ? "0 0% 100%" : "0 0% 7%",
    "--ring": hexToHslTriplet(primary),
    "--accent-foreground": hexToHslTriplet(accent),
  };
}

/** Serialise vars for a `style` attribute or inline `<style>` block. */
export function cssVarsToStyleString(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

// ── Public surface resolution ───────────────────────────────────────────────

/**
 * Work out which org a public URL belongs to and return its branding.
 *   /book/<org-slug>/...     → organizations.slug
 *   /book/cancel/<token>     → bookings.cancel_token_hash
 *   /p/q|i|pay|c|sign/<token> → share_tokens (quote|invoice|pay|portal|sign)
 * Any failure (bad token, missing table) yields the defaults.
 */
export async function resolvePublicBranding(pathname: string | null | undefined): Promise<Branding> {
  if (!pathname) return DEFAULT_BRANDING;
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  try {
    if (parts[0] === "book" && parts[1]) {
      if (parts[1] === "cancel" && parts[2]) {
        const { hashToken } = await import("@/lib/share-tokens");
        const row = await queryOne<{ user_id: string }>(`SELECT user_id FROM bookings WHERE cancel_token_hash = $1`, [
          hashToken(parts[2]),
        ]);
        return row ? getBranding(row.user_id) : DEFAULT_BRANDING;
      }
      const org = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE slug = $1`, [
        parts[1],
      ]);
      return org ? getBranding(org.owner_user_id) : DEFAULT_BRANDING;
    }
    if (parts[0] === "help" && parts[1]) {
      const org = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE slug = $1`, [
        parts[1],
      ]);
      return org ? getBranding(org.owner_user_id) : DEFAULT_BRANDING;
    }
    if (parts[0] === "m" && parts[1]) {
      const { resolveShareToken } = await import("@/lib/share-tokens");
      const row = await resolveShareToken("crew", parts[1]);
      return row ? getBranding(row.user_id) : DEFAULT_BRANDING;
    }
    if (parts[0] === "p" && parts[1] && parts[2]) {
      const kinds: Record<string, "quote" | "invoice" | "pay" | "portal" | "sign"> = { q: "quote", i: "invoice", pay: "pay", c: "portal", sign: "sign" };
      const kind = kinds[parts[1]];
      if (!kind) return DEFAULT_BRANDING;
      const { resolveShareToken } = await import("@/lib/share-tokens");
      const row = await resolveShareToken(kind, parts[2]);
      return row ? getBranding(row.user_id) : DEFAULT_BRANDING;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_BRANDING;
}

// ── Email ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Pure wrapper used by `wrapBrandedEmail`; exported for tests and previews. */
export function renderBrandedEmail(branding: Branding, html: string): string {
  const name = escapeHtml(branding.brand_name);
  const primary = isHexColor(branding.primary_color) ? branding.primary_color : DEFAULT_BRANDING.primary_color;
  const fg = readableTextOn(primary);
  // Every branding value is org-controlled text: escape it, and only ever emit
  // an http(s) image source / a plain mailbox address (see isSafeAssetUrl).
  const header = isSafeAssetUrl(branding.logo_url)
    ? `<img src="${escapeHtml(branding.logo_url)}" alt="${name}" height="36" style="height:36px;max-width:200px;display:block" />`
    : `<span style="font:600 18px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${fg}">${name}</span>`;
  const support = isPlainEmail(branding.support_email)
    ? `<p style="margin:6px 0 0;font-size:12px;color:#6b7280">Questions? <a href="mailto:${escapeHtml(branding.support_email)}" style="color:${primary}">${escapeHtml(branding.support_email)}</a></p>`
    : "";
  const footer = branding.email_footer
    ? `<p style="margin:0;font-size:12px;color:#6b7280;white-space:pre-wrap">${escapeHtml(branding.email_footer)}</p>`
    : `<p style="margin:0;font-size:12px;color:#6b7280">Sent by ${name}</p>`;
  const body = /<[a-z][\s\S]*>/i.test(html)
    ? html
    : `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(html)}</pre>`;
  return [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">`,
    `<tr><td style="background:${primary};padding:16px 24px">${header}</td></tr>`,
    `<tr><td style="padding:24px;font-size:15px;line-height:1.55">${body}</td></tr>`,
    `<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb">${footer}${support}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

/**
 * Wrap an outbound email body in the org's branded chrome. Idempotent: an
 * already-wrapped document (full `<html>`) is returned untouched.
 */
export async function wrapBrandedEmail(dataId: string, html: string): Promise<string> {
  if (/<html[\s>]/i.test(html)) return html;
  const branding = await getBranding(dataId);
  return renderBrandedEmail(branding, html);
}
