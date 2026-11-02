import { isIP } from "node:net";

/**
 * SSRF guard for webhook endpoints (same policy as push endpoints, copied so
 * the two surfaces can evolve independently).
 *
 * Require https, refuse credentials in the URL, IP literals, localhost and
 * internal-only suffixes, so a subscription can never be pointed at loopback,
 * link-local (cloud metadata) or private services. Deliveries also use
 * `redirect: "error"` so a public host cannot bounce us somewhere internal.
 *
 * Local development: set WEBHOOKS_ALLOW_INSECURE=1 to permit http://localhost.
 */
export function isAllowedWebhookUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof url !== "string" || url.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;

  if (env.WEBHOOKS_ALLOW_INSECURE === "1" && env.NODE_ENV !== "production") {
    if ((u.protocol === "http:" || u.protocol === "https:") && (host === "localhost" || host === "127.0.0.1" || host === "::1")) return true;
  }

  if (u.protocol !== "https:") return false;
  if (isIP(host) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa")) return false;
  return host.includes(".");
}
