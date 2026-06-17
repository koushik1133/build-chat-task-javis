import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

function clearSupabaseCookies(response: NextResponse, request: NextRequest) {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-")) {
      response.cookies.set(cookie.name, "", {
        maxAge: 0,
        path: "/",
        sameSite: "lax",
      });
    }
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });

  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const base =
    (forwardedHost &&
      !forwardedHost.split(",")[0]!.trim().startsWith("0.0.0.0") &&
      `${proto}://${forwardedHost.split(",")[0]!.trim()}`) ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin;

  const wantsHtml = request.headers.get("accept")?.includes("text/html");
  const response = wantsHtml
    ? NextResponse.redirect(new URL("/login?signed_out=1", base), { status: 303 })
    : NextResponse.json({ ok: true });

  clearSupabaseCookies(response, request);
  return response;
}
