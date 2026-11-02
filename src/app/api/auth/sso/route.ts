import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";
import { parseBody } from "@/lib/money/http";
import { authRateLimit } from "@/lib/request-limits";

export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254), next: z.string().max(500).optional() }).strict();

function ssoEnabled(): boolean {
  return process.env.SSO_ENABLED === "1";
}

function safeNext(raw?: string): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/onboarding";
}

/** GET /api/auth/sso — readiness flag for the login page (hides the button unless SSO_ENABLED=1). */
export async function GET() {
  return NextResponse.json({ enabled: ssoEnabled() });
}

/**
 * POST /api/auth/sso {email} — look the email domain up in sso_domains and
 * start a Supabase SAML sign-in for it. Returns {url} to redirect to.
 * Responses never say whether a domain is unknown vs. not configured, so the
 * endpoint cannot be used to enumerate customers.
 */
export async function POST(req: NextRequest) {
  if (!ssoEnabled()) return NextResponse.json({ error: "sso_disabled" }, { status: 404 });
  const limit = authRateLimit("sso", req);
  if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  const parsed = await parseBody(req, Body, 2_048);
  if (!parsed.ok) return parsed.res;
  const domain = parsed.data.email.split("@")[1] ?? "";
  const generic = NextResponse.json({ error: "Single sign-on is not set up for that email domain." }, { status: 404 });

  const row = await queryOne<{ provider_id: string | null }>(`SELECT provider_id FROM sso_domains WHERE domain = $1`, [domain]).catch(() => null);
  if (!row) return generic;

  try {
    const supabase = await createClient();
    const redirectTo = `${new URL(req.url).origin}/auth/callback?next=${encodeURIComponent(safeNext(parsed.data.next))}`;
    const { data, error } = row.provider_id
      ? await supabase.auth.signInWithSSO({ providerId: row.provider_id, options: { redirectTo } })
      : await supabase.auth.signInWithSSO({ domain, options: { redirectTo } });
    if (error || !data?.url) {
      console.warn("[auth/sso] signInWithSSO failed:", error?.message);
      return generic;
    }
    return NextResponse.json({ url: data.url });
  } catch (err) {
    console.error("[auth/sso] failed:", err);
    return NextResponse.json({ error: "Could not start single sign-on." }, { status: 500 });
  }
}
