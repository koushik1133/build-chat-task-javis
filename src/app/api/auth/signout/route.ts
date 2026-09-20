import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { publicRedirect } from "@/lib/supabase/callback";

function clearSupabaseCookies(response: NextResponse, request: NextRequest) {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-")) {
      response.cookies.set(cookie.name, "", {
        maxAge: 0,
        expires: new Date(0),
        path: "/",
        sameSite: "lax",
      });
    }
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  // Revoke every session for this user; fall back to a local sign-out if the
  // auth backend is unreachable so the cookies still get cleared below.
  await supabase.auth
    .signOut({ scope: "global" })
    .catch(async () => supabase.auth.signOut({ scope: "local" }).catch(() => {}));

  const wantsHtml = request.headers.get("accept")?.includes("text/html");
  const response = wantsHtml
    ? NextResponse.redirect(publicRedirect("/login?signed_out=1", request), {
        status: 303,
      })
    : NextResponse.json({ ok: true });

  clearSupabaseCookies(response, request);
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}
