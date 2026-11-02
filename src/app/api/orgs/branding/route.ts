import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { createAdminClient } from "@/lib/supabase/server";
import {
  getBranding,
  isHexColor,
  isSafeAssetUrl,
  renderBrandedEmail,
  resetBranding,
  updateBranding,
  type BrandingPatch,
} from "@/lib/branding";
import { sniffImage } from "@/lib/image-sniff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);
const BUCKET = "branding";

const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const Hex = z.string().trim().refine(isHexColor, "expected #rrggbb");
// `.url()` alone accepts javascript: and data: schemes; these land in <img src> / <link rel=icon>.
const AssetUrl = z.string().trim().max(2000).refine(isSafeAssetUrl, "expected an absolute http(s) URL");
const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "expected a hostname like app.example.com");

const Patch = z
  .object({
    brand_name: nullable(z.string().trim().min(1).max(80)),
    logo_url: nullable(AssetUrl),
    favicon_url: nullable(AssetUrl),
    primary_color: Hex.optional(),
    accent_color: Hex.optional(),
    email_footer: nullable(z.string().trim().max(1000)),
    custom_domain: nullable(Domain),
    support_email: nullable(z.string().trim().email().max(254)),
  })
  .strict();

/** GET /api/orgs/branding — current branding (defaults when unset) + an email preview. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const branding = await getBranding(scope.dataId);
    return NextResponse.json({
      branding,
      canEdit: scope.can("settings", true),
      emailPreview: renderBrandedEmail(branding, "<p>Hi Ana,</p><p>Your quote Q-000012 is ready to review.</p>"),
    });
  } catch (err) {
    return dbUnavailableResponse(err, "orgs/branding");
  }
}

async function uploadImage(dataId: string, kind: "logo" | "favicon", file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${kind} must be under 2MB`);
  if (!IMAGE_TYPES.has(file.type)) throw new Error(`${kind} must be PNG, JPEG, WebP, SVG or ICO`);
  // The declared type and file name are client-controlled; the bytes decide. The bucket is
  // public, so an SVG with scripts/event handlers/external refs is refused outright.
  const buf = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImage(buf, file.type);
  if (!sniffed) throw new Error(`${kind} must be a valid PNG, JPEG, WebP, ICO or a static SVG (no scripts, event handlers or external references)`);
  const supabase = createAdminClient();
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b) => b.name === BUCKET)) await supabase.storage.createBucket(BUCKET, { public: true });
  } catch (err) {
    console.warn("[branding] bucket check failed:", err);
  }
  const path = `${dataId}/${kind}-${Date.now()}.${sniffed.ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: sniffed.mime, upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * PATCH /api/orgs/branding — owner/admin. Accepts JSON (fields above) or
 * multipart/form-data with the same fields plus optional `logo` / `favicon`
 * files, which are stored in Supabase Storage and saved as URLs.
 * Send `{ "reset": true }` to clear all branding.
 */
export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  let raw: Record<string, unknown> = {};
  const files: Partial<Record<"logo" | "favicon", File>> = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "bad request" }, { status: 400 });
    for (const [k, v] of form.entries()) {
      if (v instanceof File) {
        if ((k === "logo" || k === "favicon") && v.size > 0) files[k] = v;
      } else if (k !== "reset") {
        raw[k] = v === "" ? null : v;
      }
    }
  } else {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "bad request" }, { status: 400 });
    if (body.reset === true) {
      try {
        await resetBranding(scope.dataId);
        return NextResponse.json({ branding: await getBranding(scope.dataId) });
      } catch (err) {
        return dbUnavailableResponse(err, "orgs/branding");
      }
    }
    raw = body;
  }

  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  }
  const patch: BrandingPatch = { ...parsed.data };

  try {
    if (files.logo) patch.logo_url = await uploadImage(scope.dataId, "logo", files.logo);
    if (files.favicon) patch.favicon_url = await uploadImage(scope.dataId, "favicon", files.favicon);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "upload failed" }, { status: 400 });
  }

  try {
    const branding = await updateBranding(scope.dataId, patch);
    return NextResponse.json({
      branding,
      emailPreview: renderBrandedEmail(branding, "<p>Hi Ana,</p><p>Your quote Q-000012 is ready to review.</p>"),
    });
  } catch (err) {
    return dbUnavailableResponse(err, "orgs/branding");
  }
}
