/**
 * Security response headers, shared by next.config.ts (build-time) and tests.
 *
 * CSP ships report-only by default so an unexpected inline script never takes
 * the app down; flip CSP_ENFORCE=1 once the report stream is quiet.
 */

export interface SecurityHeaderEnv {
  isDev: boolean;
  supabaseUrl?: string | null;
  cspEnforce: boolean;
  /** Cloudflare Turnstile widget enabled (adds its script/frame origins). */
  turnstile?: boolean;
  /** Route may be framed by third-party sites (portal, booking, widget). */
  embeddable: boolean;
}

/** Route patterns (Next `headers()` sources) that third parties may frame. */
export const EMBEDDABLE_ROUTE_SOURCES = ["/p/:path*", "/book/:path*", "/api/leads/widget/:path*", "/widget-demo", "/api/widget/:path*", "/api/widget.js"] as const;

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function supabaseOrigins(url?: string | null): string[] {
  const trimmed = url?.trim();
  if (!trimmed) return [];
  try {
    const u = new URL(trimmed);
    return [u.origin, `wss://${u.host}`];
  } catch {
    return [];
  }
}

export function buildCsp(env: SecurityHeaderEnv): string {
  const supabase = supabaseOrigins(env.supabaseUrl);
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (env.isDev) scriptSrc.push("'unsafe-eval'");
  if (env.turnstile) scriptSrc.push(TURNSTILE_ORIGIN);

  const connectSrc = ["'self'", ...supabase];
  if (env.turnstile) connectSrc.push(TURNSTILE_ORIGIN);
  if (env.isDev) connectSrc.push("ws:", "wss:");

  const frameSrc = env.turnstile ? ["'self'", TURNSTILE_ORIGIN] : ["'self'"];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "connect-src": connectSrc,
    "frame-src": frameSrc,
    "frame-ancestors": env.embeddable ? ["*"] : ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

export function buildSecurityHeaders(env: SecurityHeaderEnv): Array<{ key: string; value: string }> {
  const headers: Array<{ key: string; value: string }> = [
    { key: env.cspEnforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", value: buildCsp(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  if (!env.embeddable) headers.push({ key: "X-Frame-Options", value: "DENY" });
  if (!env.isDev) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" });
  }
  return headers;
}
