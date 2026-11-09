import { queryOne } from "@/lib/dsql";
import { getBranding, brandingToCssVars, readableTextOn } from "@/lib/branding";
import { listBookingTypes } from "@/lib/calendar/booking";
import { listArticles } from "@/lib/kb/articles";
import { mergePublicConfig, parseWidgetConfig, type PublicWidgetConfig, type WidgetConfig } from "./config";

export interface SiteWidgetRow {
  id: string;
  user_id: string;
  title: string;
  consent_text: string | null;
  widget_config: string | null;
  allowed_origins: string | null;
}

export async function loadSiteForWidget(siteId: string): Promise<SiteWidgetRow | null> {
  return queryOne<SiteWidgetRow>(
    `SELECT id, user_id, title, consent_text, widget_config, allowed_origins FROM sites WHERE id = $1 AND deleted_at IS NULL`,
    [siteId]
  );
}

export async function orgSlugFor(dataId: string): Promise<string | null> {
  const row = await queryOne<{ slug: string }>(`SELECT slug FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
  return row?.slug ?? null;
}

/** Merged public config for the embed script, or null when the site is unknown. */
export async function loadPublicConfig(siteId: string): Promise<{ site: SiteWidgetRow; stored: WidgetConfig; config: PublicWidgetConfig } | null> {
  const site = await loadSiteForWidget(siteId);
  if (!site) return null;
  const stored = parseWidgetConfig(site.widget_config);
  const [branding, orgSlug, types, helpArticles] = await Promise.all([
    getBranding(site.user_id),
    orgSlugFor(site.user_id),
    stored.modes.booking ? listBookingTypes(site.user_id, { activeOnly: true }).catch(() => []) : Promise.resolve([]),
    stored.modes.help ? listArticles(site.user_id, { publicOnly: true, limit: 1 }).catch(() => []) : Promise.resolve([]),
  ]);
  const config = mergePublicConfig({
    siteId: site.id,
    siteTitle: site.title,
    orgSlug,
    brandName: branding.brand_name,
    stored,
    consentText: site.consent_text,
    brandPrimary: branding.primary_color,
    brandForeground: readableTextOn(branding.primary_color),
    cssVars: brandingToCssVars(branding),
    bookingTypes: types.map((t) => ({ slug: t.slug, name: t.name, description: t.description, durationMinutes: t.duration_minutes, priceMinor: t.price_minor, currency: t.currency })),
    helpAvailable: helpArticles.length > 0 && Boolean(orgSlug),
  });
  return { site, stored, config };
}
