import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { getBranding } from "@/lib/branding";
import { parseOriginList } from "@/lib/cors";
import { appOrigin } from "@/lib/share-tokens";
import { CONSENT_MODES, MAX_CONSENT_TEXT, MAX_GREETING, WIDGET_MODES, WIDGET_POSITIONS, parseWidgetConfig, type WidgetSiteDTO } from "@/lib/webchat/config";
import { orgSlugFor } from "@/lib/webchat/public-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SiteRow {
  id: string;
  title: string;
  consent_text: string | null;
  widget_config: string | null;
  allowed_origins: string | null;
  html: string | null;
  updated_at: string;
}

function scriptTag(siteId: string): string {
  return `<script async src="${appOrigin()}/api/widget.js" data-site="${siteId}"></script>`;
}

function isInstalled(html: string | null, siteId: string): boolean {
  return Boolean(html && html.includes("/api/widget.js") && html.includes(`data-site="${siteId}"`));
}

function toDto(r: SiteRow): WidgetSiteDTO {
  return { id: r.id, title: r.title, consentText: r.consent_text, allowedOrigins: parseOriginList(r.allowed_origins), config: parseWidgetConfig(r.widget_config), installed: isInstalled(r.html, r.id), updatedAt: r.updated_at };
}

/** GET /api/widget/settings — sites + their widget config, branding colour, org slug, app URL. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const [rows, branding, orgSlug] = await Promise.all([
      query<SiteRow>(`SELECT id, title, consent_text, widget_config, allowed_origins, html, updated_at FROM sites WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`, [scope.dataId]),
      getBranding(scope.dataId),
      orgSlugFor(scope.dataId),
    ]);
    return NextResponse.json({ sites: rows.map(toDto), branding: { primaryColor: branding.primary_color, brandName: branding.brand_name }, orgSlug, appUrl: appOrigin() });
  } catch (err) {
    console.error("[widget settings] GET failed:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const PutSchema = z
  .object({
    siteId: z.string().uuid(),
    config: z
      .object({
        enabled: z.boolean(),
        modes: z.object({ chat: z.boolean(), lead: z.boolean(), booking: z.boolean(), help: z.boolean() }).strict(),
        defaultMode: z.enum(WIDGET_MODES),
        greeting: z.string().trim().min(1).max(MAX_GREETING),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
        position: z.enum(WIDGET_POSITIONS),
        consentMode: z.enum(CONSENT_MODES),
      })
      .strict(),
    consentText: z.string().trim().max(MAX_CONSENT_TEXT).nullable(),
    allowedOrigins: z.array(z.string().trim().min(1).max(300)).max(50),
  })
  .strict();

/** PUT — save widget config, consent text and allowed origins for one site. */
export async function PUT(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body", detail: parsed.error.flatten() }, { status: 400 });
  const { siteId, config, consentText, allowedOrigins } = parsed.data;
  try {
    const cleaned = allowedOrigins.map((o) => o.trim()).filter(Boolean);
    const origins = parseOriginList(cleaned.join(","));
    if (origins.length < new Set(cleaned.map((o) => o.toLowerCase())).size && cleaned.some((o) => parseOriginList(o).length === 0)) {
      return NextResponse.json({ error: "One or more origins are not valid (use https://example.com)" }, { status: 400 });
    }
    const stored = parseWidgetConfig(config);
    const row = await queryOne<SiteRow>(
      `UPDATE sites SET widget_config = $3, consent_text = $4, allowed_origins = $5, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, title, consent_text, widget_config, allowed_origins, html, updated_at`,
      [siteId, scope.dataId, JSON.stringify(stored), consentText || null, origins.length ? JSON.stringify(origins) : null]
    );
    if (!row) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    void recordAudit(scope, { action: "widget.config.updated", entity: "site", entityId: siteId, after: { modes: stored.modes, consentMode: stored.consentMode }, req }).catch(() => undefined);
    return NextResponse.json({ site: toDto(row) });
  } catch (err) {
    console.error("[widget settings] PUT failed:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const InstallSchema = z.object({ siteId: z.string().uuid(), action: z.enum(["install", "uninstall"]).default("install") }).strict();

/** POST — install/uninstall the script tag in the site builder's HTML (before </body>). */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = InstallSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { siteId, action } = parsed.data;
  try {
    const site = await queryOne<{ html: string }>(`SELECT html FROM sites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [siteId, scope.dataId]);
    if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    const stripped = site.html.replace(/<script[^>]*\/api\/widget\.js[^>]*><\/script>\s*/gi, "");
    let html = stripped;
    if (action === "install") {
      const tag = scriptTag(siteId);
      html = /<\/body>/i.test(stripped) ? stripped.replace(/<\/body>/i, `${tag}\n</body>`) : `${stripped}\n${tag}`;
    }
    await query(`UPDATE sites SET html = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [siteId, scope.dataId, html]);
    void recordAudit(scope, { action: action === "install" ? "widget.installed" : "widget.uninstalled", entity: "site", entityId: siteId, req }).catch(() => undefined);
    return NextResponse.json({ ok: true, installed: action === "install" });
  } catch (err) {
    console.error("[widget settings] install failed:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
