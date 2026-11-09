import { isAllowedWebhookUrl } from "@/lib/webhooks/url";
import type { ChatProviderId } from "./types";

type EnvLike = Record<string, string | undefined>;

/**
 * Per-provider host allow-lists on top of the shared SSRF policy. A Slack
 * integration can only ever talk to hooks.slack.com, and so on; only the
 * generic "webhook" provider may use any public https URL.
 */
export function chatUrlRefusal(provider: ChatProviderId, url: string, env: EnvLike = process.env): string | null {
  if (!isAllowedWebhookUrl(url, env)) return "Webhook URL must be a public https URL.";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Webhook URL is not valid.";
  }
  const host = u.hostname.toLowerCase();
  switch (provider) {
    case "slack":
      return host === "hooks.slack.com" && u.pathname.startsWith("/services/") ? null : "Slack webhooks look like https://hooks.slack.com/services/...";
    case "teams":
      return host === "outlook.office.com" || host === "webhook.office.com" || host.endsWith(".webhook.office.com") || host.endsWith(".logic.azure.com") || host.endsWith(".powerplatform.com")
        ? null
        : "Teams webhooks must be on webhook.office.com, outlook.office.com or logic.azure.com.";
    case "discord":
      return (host === "discord.com" || host === "discordapp.com") && u.pathname.startsWith("/api/webhooks/") ? null : "Discord webhooks look like https://discord.com/api/webhooks/...";
    case "webhook":
      return null;
  }
}

/** Show the host and the last few characters only; the path usually is the secret. */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 4 ? u.pathname.slice(-4) : "";
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    return "…";
  }
}
