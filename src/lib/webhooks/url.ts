import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Minimal env shape so callers (and tests) can pass a plain object instead of process.env. */
type EnvLike = Record<string, string | undefined>;

/**
 * SSRF guard for webhook endpoints (same policy as push endpoints, copied so
 * the two surfaces can evolve independently).
 *
 * Require https, refuse credentials in the URL, IP literals, localhost and
 * internal-only suffixes, so a subscription can never be pointed at loopback,
 * link-local (cloud metadata) or private services. Deliveries also use
 * `redirect: "error"` so a public host cannot bounce us somewhere internal.
 *
 * The string check alone does not stop a public hostname that resolves to a
 * private address (DNS rebinding, `*.nip.io` style hosts), so deliveries also
 * call `resolvesToPublicAddress()` right before the request is made.
 *
 * Local development: set WEBHOOKS_ALLOW_INSECURE=1 to permit http://localhost.
 */
export function isAllowedWebhookUrl(url: string, env: EnvLike = process.env): boolean {
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

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast and unspecified ranges. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v6)) return true; // hex-form mapped: refuse rather than parse
    return v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
  }
  return true; // not an IP literal at all → treat as unsafe
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `url`'s host and require EVERY address to be public. Any resolution
 * failure, empty answer or private address fails closed. Loopback is only
 * allowed when the insecure dev override is on (same rule as the string check).
 */
export async function resolvesToPublicAddress(url: string, opts: { lookup?: HostLookup; env?: EnvLike } = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  const loopbackName = host === "localhost" || host.endsWith(".localhost");
  if (env.WEBHOOKS_ALLOW_INSECURE === "1" && env.NODE_ENV !== "production" && (loopbackName || host === "127.0.0.1" || host === "::1")) return true;
  if (loopbackName) return false;
  if (isIP(host) !== 0) return !isPrivateAddress(host);
  try {
    const answers = await (opts.lookup ?? defaultLookup)(host);
    if (!Array.isArray(answers) || answers.length === 0) return false;
    return answers.every((a) => typeof a?.address === "string" && isIP(a.address) !== 0 && !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Combined guard for legacy outbound destinations (automation webhook action,
 * notification webhook channel): string policy + DNS resolution. Returns null
 * when the URL may be called, otherwise a short human reason.
 */
export async function outboundUrlRefusal(url: string, opts: { lookup?: HostLookup; env?: EnvLike } = {}): Promise<string | null> {
  if (!isAllowedWebhookUrl(url, opts.env ?? process.env)) return "Destination must be a public https URL (no IP literals, localhost or internal hosts).";
  if (!(await resolvesToPublicAddress(url, opts))) return "Destination resolves to a private or internal address.";
  return null;
}
