import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { matchesEventType } from "@/lib/automations/triggers";
import { chatUrlRefusal, maskWebhookUrl } from "./providers";
import type { ChatIntegrationView, ChatProviderId } from "./types";

export class ChatValidationError extends Error {}

export interface ChatIntegrationRow {
  id: string;
  user_id: string;
  provider: ChatProviderId;
  name: string;
  webhook_url_enc: string;
  channel_label: string | null;
  events: string | null;
  enabled: boolean;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

const COLS = `id, user_id, provider, name, webhook_url_enc, channel_label, events, enabled, last_status, last_error, created_at`;

export function sealUrl(url: string): string {
  if (isEncryptionConfigured()) return encryptSecret(url);
  if (process.env.NODE_ENV === "production") throw new ChatValidationError("Webhook URLs cannot be stored: set CREDENTIAL_ENCRYPTION_KEY.");
  return `plain:${url}`;
}

export function openUrl(stored: string): string | null {
  // The dev-only plaintext form is never honoured in production (fail closed).
  if (stored.startsWith("plain:")) return process.env.NODE_ENV === "production" ? null : stored.slice(6);
  return decryptSecret(stored);
}

export function parseEvents(raw: string | null | undefined): string[] {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 100).slice(0, 100) : [];
  } catch {
    return [];
  }
}

/** True when any of the integration's patterns match the event type. */
export function integrationMatches(events: readonly string[], eventType: string): boolean {
  return events.length > 0 && matchesEventType(events.join(","), eventType);
}

export function toView(r: ChatIntegrationRow): ChatIntegrationView {
  const url = openUrl(r.webhook_url_enc);
  return {
    id: r.id, provider: r.provider, name: r.name, webhook_url_masked: url ? maskWebhookUrl(url) : "(unreadable)", channel_label: r.channel_label,
    events: parseEvents(r.events), enabled: r.enabled, last_status: r.last_status, last_error: r.last_error, created_at: r.created_at,
  };
}

export async function listIntegrations(dataId: string): Promise<ChatIntegrationView[]> {
  const rows = await query<ChatIntegrationRow>(`SELECT ${COLS} FROM chat_integrations WHERE user_id = $1 ORDER BY created_at ASC`, [dataId]);
  return rows.map(toView);
}

export async function getIntegrationRow(dataId: string, id: string): Promise<ChatIntegrationRow | null> {
  return queryOne<ChatIntegrationRow>(`SELECT ${COLS} FROM chat_integrations WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function getIntegrationRowById(id: string): Promise<ChatIntegrationRow | null> {
  return queryOne<ChatIntegrationRow>(`SELECT ${COLS} FROM chat_integrations WHERE id = $1`, [id]);
}

export async function createIntegration(
  dataId: string,
  input: { provider: ChatProviderId; name: string; webhook_url: string; channel_label?: string | null; events: string[]; enabled?: boolean }
): Promise<ChatIntegrationView> {
  const refusal = chatUrlRefusal(input.provider, input.webhook_url);
  if (refusal) throw new ChatValidationError(refusal);
  const id = randomUUID();
  await query(
    `INSERT INTO chat_integrations (id, user_id, provider, name, webhook_url_enc, channel_label, events, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [id, dataId, input.provider, input.name.trim(), sealUrl(input.webhook_url), input.channel_label?.trim() || null, JSON.stringify(input.events), input.enabled ?? true]
  );
  const row = await getIntegrationRow(dataId, id);
  return toView(row!);
}

export async function updateIntegration(
  dataId: string,
  id: string,
  patch: { name?: string; webhook_url?: string; channel_label?: string | null; events?: string[]; enabled?: boolean }
): Promise<ChatIntegrationView | null> {
  const row = await getIntegrationRow(dataId, id);
  if (!row) return null;
  let urlEnc = row.webhook_url_enc;
  if (patch.webhook_url) {
    const refusal = chatUrlRefusal(row.provider, patch.webhook_url);
    if (refusal) throw new ChatValidationError(refusal);
    urlEnc = sealUrl(patch.webhook_url);
  }
  await query(
    `UPDATE chat_integrations SET name = $1, webhook_url_enc = $2, channel_label = $3, events = $4, enabled = $5 WHERE id = $6 AND user_id = $7`,
    [
      patch.name?.trim() || row.name,
      urlEnc,
      patch.channel_label === undefined ? row.channel_label : patch.channel_label?.trim() || null,
      JSON.stringify(patch.events ?? parseEvents(row.events)),
      patch.enabled ?? row.enabled,
      id,
      dataId,
    ]
  );
  const next = await getIntegrationRow(dataId, id);
  return next ? toView(next) : null;
}

export async function deleteIntegration(dataId: string, id: string): Promise<boolean> {
  const row = await getIntegrationRow(dataId, id);
  if (!row) return false;
  await query(`DELETE FROM chat_integrations WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}
