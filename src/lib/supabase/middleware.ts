import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicRedirect } from "@/lib/supabase/callback";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Routes that never require authentication. */
function isPublicPath(path: string) {
  if (path === "/" || path === "/login") return true;
  if (path.startsWith("/auth/")) return true;
  // API routes enforce auth individually (requireUser, cron secret, public webhooks).
  if (path.startsWith("/api/")) return true;
  return false;
}

function forwardRequest(request: NextRequest, path: string) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", path);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;
  let response = forwardRequest(request, path);

  const supabase = createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = forwardRequest(request, path);
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isPublicPath(path)) {
    if (user && path === "/login") {
      const next = request.nextUrl.searchParams.get("next");
      const dest =
        next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login")
          ? next
          : "/onboarding";
      return NextResponse.redirect(publicRedirect(dest, request));
    }
    return response;
  }

  if (!user) {
    return NextResponse.redirect(
      publicRedirect(`/login?next=${encodeURIComponent(path)}`, request)
    );
  }

  return response;
}
