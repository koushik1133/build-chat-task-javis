/** Chat-app notification contracts. Pure: safe to import from client code. */

export const CHAT_PROVIDERS = ["slack", "teams", "discord", "webhook"] as const;
export type ChatProviderId = (typeof CHAT_PROVIDERS)[number];

export const CHAT_PROVIDER_LABELS: Record<ChatProviderId, string> = { slack: "Slack", teams: "Microsoft Teams", discord: "Discord", webhook: "Generic webhook" };

export function isChatProviderId(v: unknown): v is ChatProviderId {
  return typeof v === "string" && (CHAT_PROVIDERS as readonly string[]).includes(v);
}

/** Provider-neutral message that the formatters turn into Block Kit / Adaptive Card / embed JSON. */
export interface ChatMessage {
  title: string;
  text: string;
  url?: string | null;
  fields?: Array<{ label: string; value: string }>;
  eventType?: string | null;
}

export interface ChatIntegrationView {
  id: string;
  provider: ChatProviderId;
  name: string;
  /** Masked webhook URL (host + last characters only). */
  webhook_url_masked: string;
  channel_label: string | null;
  events: string[];
  enabled: boolean;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

export const MAX_MESSAGES_PER_MINUTE = 30;
