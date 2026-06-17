import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicRedirect } from "@/lib/supabase/callback";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

// Public paths that never require auth
const PUBLIC = ["/", "/login", "/auth/", "/api/"];
function isPublicPath(path: string) {
  return PUBLIC.some((p) => path === p || path.startsWith(p));
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          // Write refreshed tokens onto both the forwarded request and the response
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const path = request.nextUrl.pathname;

  if (isPublicPath(path)) {
    // Still call getUser on public paths so Supabase can refresh the token
    // and write updated cookies — but never redirect.
    await supabase.auth.getUser().catch(() => null);
    return response;
  }

  // Protected path — check session from cookies (no network call → no loop risk).
  // getUser() in the middleware already refreshed the token above when needed.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.redirect(
      publicRedirect(`/login?next=${encodeURIComponent(path)}`, request)
    );
  }

  return response;
}
