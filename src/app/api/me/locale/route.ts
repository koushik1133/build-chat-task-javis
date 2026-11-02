import { NextResponse } from "next/server";
import { z } from "zod";
import { LOCALES, LOCALE_COOKIE } from "@/lib/i18n";

const Body = z.object({ locale: z.enum(LOCALES) }).strict();

/**
 * POST /api/me/locale — set the caller's own language cookie (`kh_locale`).
 * A per-browser preference, so no auth is required; it sits below the org
 * setting in the detection order.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const res = NextResponse.json({ ok: true, locale: parsed.data.locale });
  res.cookies.set(LOCALE_COOKIE, parsed.data.locale, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
