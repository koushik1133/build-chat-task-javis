import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { EVENT_TYPES } from "@/lib/events/bus";
import { generateWebhookSecret } from "./sign";
import { isAllowedWebhookUrl } from "./url";

/** Minimal env shape so callers (and tests) can pass a plain object instead of process.env. */
type EnvLike = Record<string, string | undefined>;

/**
 * Webhook subscriptions. The signing secret is encrypted at rest with
 * CREDENTIAL_ENCRYPTION_KEY (src/lib/secure-store). When that key is not
 * configured the secret is stored with a `plain:` prefix so deliveries keep
 * working in development. In production the key is mandatory: creating or
 * rotating a subscription without it fails instead of writing `plain:`.
 */

export const WILDCARD = "*";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  event_types: string;
  active: boolean;
  description: string | null;
  created_by: string | null;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number;
}

export interface SubscriptionDTO {
  id: string;
  url: string;
  event_types: string[];
  active: boolean;
  description: string | null;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number;
}

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

const COLS = "id, user_id, url, secret, event_types, active, description, created_by, created_at, last_success_at, last_failure_at, failure_count";

export function parseEventTypes(raw: string | null | undefined): string[] {
  if (!raw) return [WILDCARD];
  try {
    const v: unknown = JSON.parse(raw);
    const list = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    return list.length ? list : [WILDCARD];
  } catch {
    return [WILDCARD];
  }
}

export function toSubscriptionDTO(r: SubscriptionRow): SubscriptionDTO {
  return {
    id: r.id,
    url: r.url,
    event_types: parseEventTypes(r.event_types),
    active: Boolean(r.active),
    description: r.description,
    created_at: r.created_at,
    last_success_at: r.last_success_at,
    last_failure_at: r.last_failure_at,
    failure_count: Number(r.failure_count ?? 0),
  };
}

/** True when a subscription wants `eventType`. Supports "*" and "prefix.*". */
export function matchesEventType(eventTypes: readonly string[], eventType: string): boolean {
  for (const t of eventTypes) {
    if (t === WILDCARD || t === eventType) return true;
    if (t.endsWith(".*") && eventType.startsWith(t.slice(0, -1))) return true;
  }
  return false;
}

export function validateEventTypes(input: readonly string[] | undefined): string[] {
  const list = [...new Set((input ?? [WILDCARD]).map((s) => s.trim()).filter(Boolean))];
  if (list.length === 0) return [WILDCARD];
  for (const t of list) {
    if (t === WILDCARD) continue;
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)+$/i.test(t) || t.length > 80) throw new WebhookValidationError(`Invalid event type "${t}"`);
  }
  return list;
}

/** Known event types (for pickers); unknown types are still accepted so new lanes can add events freely. */
export const KNOWN_EVENT_TYPES: readonly string[] = EVENT_TYPES;

export function sealSecret(plain: string, env: EnvLike = process.env): string {
  if (isEncryptionConfigured()) return encryptSecret(plain);
  if (env.NODE_ENV === "production") {
    throw new WebhookValidationError("Webhook signing secrets cannot be stored: set CREDENTIAL_ENCRYPTION_KEY.");
  }
  return `plain:${plain}`;
}

export function openSecret(stored: string): string | null {
  if (stored.startsWith("plain:")) return stored.slice("plain:".length);
  return decryptSecret(stored);
}

export async function listSubscriptions(dataId: string): Promise<SubscriptionDTO[]> {
  const rows = await query<SubscriptionRow>(`SELECT ${COLS} FROM webhook_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [dataId]);
  return rows.map(toSubscriptionDTO);
}

export async function getSubscriptionRow(dataId: string, id: string): Promise<SubscriptionRow | null> {
  return queryOne<SubscriptionRow>(`SELECT ${COLS} FROM webhook_subscriptions WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function getSubscription(dataId: string, id: string): Promise<SubscriptionDTO | null> {
  const row = await getSubscriptionRow(dataId, id);
  return row ? toSubscriptionDTO(row) : null;
}

export interface CreateSubscriptionInput {
  url: string;
  event_types?: string[];
  description?: string | null;
  created_by?: string | null;
}

/** Creates a subscription and returns the plaintext secret ONCE. */
export async function createSubscription(dataId: string, input: CreateSubscriptionInput): Promise<{ subscription: SubscriptionDTO; secret: string }> {
  const url = input.url.trim();
  if (!isAllowedWebhookUrl(url)) throw new WebhookValidationError("URL must be a public https endpoint (no IP literals, localhost or internal hosts)");
  const eventTypes = validateEventTypes(input.event_types);
  const count = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM webhook_subscriptions WHERE user_id = $1`, [dataId]);
  if (Number(count?.n ?? 0) >= 50) throw new WebhookValidationError("Limit of 50 webhook subscriptions reached");
  const secret = generateWebhookSecret();
  const row = await queryOne<SubscriptionRow>(
    `INSERT INTO webhook_subscriptions (user_id, url, secret, event_types, active, description, created_by)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6) RETURNING ${COLS}`,
    [dataId, url, sealSecret(secret), JSON.stringify(eventTypes), input.description?.trim().slice(0, 200) || null, input.created_by ?? null]
  );
  if (!row) throw new Error("Insert returned no row");
  return { subscription: toSubscriptionDTO(row), secret };
}

export interface UpdateSubscriptionInput {
  url?: string;
  event_types?: string[];
  description?: string | null;
  active?: boolean;
}

export async function updateSubscription(dataId: string, id: string, patch: UpdateSubscriptionInput): Promise<SubscriptionDTO> {
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.url !== undefined) {
    const url = patch.url.trim();
    if (!isAllowedWebhookUrl(url)) throw new WebhookValidationError("URL must be a public https endpoint (no IP literals, localhost or internal hosts)");
    push("url", url);
  }
  if (patch.event_types !== undefined) push("event_types", JSON.stringify(validateEventTypes(patch.event_types)));
  if (patch.description !== undefined) push("description", patch.description?.trim().slice(0, 200) || null);
  if (patch.active !== undefined) {
    push("active", patch.active);
    // Re-enabling clears the consecutive-failure counter so auto-disable starts fresh.
    if (patch.active) sets.push("failure_count = 0");
  }
  if (sets.length === 0) {
    const cur = await getSubscription(dataId, id);
    if (!cur) throw new Error("Webhook not found");
    return cur;
  }
  const row = await queryOne<SubscriptionRow>(`UPDATE webhook_subscriptions SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`, params);
  if (!row) throw new Error("Webhook not found");
  return toSubscriptionDTO(row);
}

/** Rotate the signing secret; returns the new plaintext once. */
export async function rotateSecret(dataId: string, id: string): Promise<string> {
  const secret = generateWebhookSecret();
  const rows = await query<{ id: string }>(`UPDATE webhook_subscriptions SET secret = $3 WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId, sealSecret(secret)]);
  if (rows.length === 0) throw new Error("Webhook not found");
  return secret;
}

export async function deleteSubscription(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM webhook_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  if (rows.length === 0) return false;
  await query(`DELETE FROM webhook_deliveries WHERE subscription_id = $1 AND user_id = $2`, [id, dataId]).catch(() => undefined);
  return true;
}
