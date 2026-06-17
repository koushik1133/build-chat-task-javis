import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { publicRedirect } from "@/lib/supabase/callback";

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

  const wantsHtml = request.headers.get("accept")?.includes("text/html");
  const response = wantsHtml
    ? NextResponse.redirect(publicRedirect("/login?signed_out=1", request), {
        status: 303,
      })
    : NextResponse.json({ ok: true });

  clearSupabaseCookies(response, request);
  return response;
}
