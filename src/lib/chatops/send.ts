import { emitEvent } from "@/lib/events/bus";
import { query } from "@/lib/dsql";
import { rateLimit } from "@/lib/request-limits";
import { resolvesToPublicAddress, type HostLookup } from "@/lib/webhooks/url";
import { formatForProvider } from "./format";
import { chatUrlRefusal } from "./providers";
import { getIntegrationRowById, openUrl, type ChatIntegrationRow } from "./subscriptions";
import { MAX_MESSAGES_PER_MINUTE, type ChatMessage } from "./types";

const TIMEOUT_MS = 5_000;
const dropped = new Map<string, number>();

export interface ChatSendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  dropped?: boolean;
}

async function record(row: ChatIntegrationRow, status: string, error: string | null): Promise<void> {
  await query(`UPDATE chat_integrations SET last_status = $1, last_error = $2 WHERE id = $3`, [status, error ? error.slice(0, 300) : null, row.id]).catch(() => undefined);
  if (status === "error" && row.last_status !== "error") {
    await emitEvent(row.user_id, { type: "chat.delivery_failed", entity: "chat_integration", entityId: row.id, data: { integration: row.name, provider: row.provider, error: error ?? "failed" } });
  }
}

/**
 * Deliver one message. SSRF-guarded (provider host allow-list + public DNS),
 * 5s timeout, no redirects, at most 30 messages/minute per integration
 * (extra messages are dropped and counted, never queued).
 */
export async function sendChat(integrationId: string, message: ChatMessage, opts: { fetchImpl?: typeof fetch; lookup?: HostLookup; dataId?: string; bypassRate?: boolean } = {}): Promise<ChatSendResult> {
  const row = await getIntegrationRowById(integrationId);
  if (!row || (opts.dataId && row.user_id !== opts.dataId)) return { ok: false, status: null, error: "not_found" };
  const url = openUrl(row.webhook_url_enc);
  if (!url) {
    await record(row, "error", "Stored webhook URL could not be decrypted.");
    return { ok: false, status: null, error: "Stored webhook URL could not be decrypted." };
  }
  const refusal = chatUrlRefusal(row.provider, url) ?? ((await resolvesToPublicAddress(url, { lookup: opts.lookup })) ? null : "Destination resolves to a private or internal address.");
  if (refusal) {
    await record(row, "error", refusal);
    return { ok: false, status: null, error: refusal };
  }
  if (!opts.bypassRate) {
    const rl = rateLimit(`chat:${row.id}`, MAX_MESSAGES_PER_MINUTE, 60_000);
    if (!rl.allowed) {
      const n = (dropped.get(row.id) ?? 0) + 1;
      dropped.set(row.id, n);
      await query(`UPDATE chat_integrations SET last_error = $1 WHERE id = $2`, [`Rate limit: ${n} message(s) dropped (max ${MAX_MESSAGES_PER_MINUTE}/min)`, row.id]).catch(() => undefined);
      return { ok: false, status: null, error: "rate_limited", dropped: true };
    }
    dropped.delete(row.id);
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "KernelHub-Chat/1.0" },
      body: JSON.stringify(formatForProvider(row.provider, message)),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      await record(row, "ok", null);
      return { ok: true, status: res.status, error: null };
    }
    const err = `HTTP ${res.status}`;
    await record(row, "error", err);
    return { ok: false, status: res.status, error: err };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "request failed";
    await record(row, "error", msg);
    return { ok: false, status: null, error: msg };
  }
}
