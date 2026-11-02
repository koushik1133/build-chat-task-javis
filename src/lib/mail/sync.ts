import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { handleInboundMessage } from "@/lib/receptionist/inbound-agent";
import { parseConversation, saveConversation, type ConversationTurn } from "@/lib/twilio-webhook";
import { ensureFreshAuth, getMailAccountById, getMailProvider } from "./index";
import { extractAddress, mailToTurn, replySubject, threadKeyFor } from "./parse";
import type { MailAccountRow, NormalizedMessage } from "./types";

/**
 * Mailbox → unified inbox.
 *
 * `syncAccount` pulls new mail through the account's provider, upserts
 * `mail_messages`, folds each thread into one `messaging_conversations` row
 * (channel "email", linked to a CRM contact by address) and hands inbound mail
 * to the AI receptionist exactly as the SMS webhook does. `syncDueAccounts`
 * is the cron hook: each account is synced at most once every 2 minutes.
 */

export const SYNC_INTERVAL_MINUTES = 2;

export interface SyncResult {
  accountId: string;
  imported: number;
  skipped: number;
  replied: number;
  error: string | null;
}

interface ConversationRow {
  id: string;
  messages: string;
  contact_id: string | null;
}

async function findOrCreateContact(dataId: string, email: string, name: string | null): Promise<string | null> {
  if (!email) return null;
  try {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE user_id = $1 AND LOWER(email) = $2 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
      [dataId, email]
    );
    if (existing) return existing.id;
    const fullName = name?.trim() || email.split("@")[0];
    const row = await queryOne<{ id: string }>(
      `INSERT INTO crm_contacts (user_id, full_name, email, lifecycle, tags, notes)
       VALUES ($1, $2, $3, 'lead', '["email-inbox"]', 'Created from an inbound email.') RETURNING id`,
      [dataId, fullName.slice(0, 200), email]
    );
    if (row) void emitEvent(dataId, { type: "crm.contact.created", entity: "crm_contact", entityId: row.id, data: { source: "mail" } });
    return row?.id ?? null;
  } catch (err) {
    console.warn("[mail/sync] contact lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function findOrCreateConversation(dataId: string, threadKey: string, counterpart: string, contactId: string | null): Promise<ConversationRow> {
  const existing = await queryOne<ConversationRow>(
    `SELECT id, messages, contact_id FROM messaging_conversations WHERE user_id = $1 AND thread_key = $2`,
    [dataId, threadKey]
  );
  if (existing) {
    if (!existing.contact_id && contactId) {
      await query(`UPDATE messaging_conversations SET contact_id = $1 WHERE id = $2`, [contactId, existing.id]).catch(() => undefined);
    }
    return existing;
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO messaging_conversations (user_id, channel, from_number, messages, thread_key, contact_id, created_at, updated_at)
     VALUES ($1, 'email', $2, '[]', $3, $4, NOW(), NOW()) RETURNING id`,
    [dataId, counterpart, threadKey, contactId]
  );
  return { id: row?.id ?? "", messages: "[]", contact_id: contactId };
}

async function insertMailMessage(account: MailAccountRow, msg: NormalizedMessage, conversationId: string): Promise<boolean> {
  const dup = await queryOne<{ id: string }>(
    `SELECT id FROM mail_messages WHERE account_id = $1 AND provider_message_id = $2`,
    [account.id, msg.providerMessageId]
  );
  if (dup) return false;
  await query(
    `INSERT INTO mail_messages (user_id, account_id, provider_message_id, thread_id, conversation_id, direction, from_addr, to_addrs, subject, snippet, body_text, body_html, received_at, is_read, labels, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
    [
      account.user_id,
      account.id,
      msg.providerMessageId,
      msg.threadId,
      conversationId,
      msg.direction,
      msg.from,
      JSON.stringify(msg.to),
      msg.subject.slice(0, 500),
      msg.snippet.slice(0, 300),
      msg.bodyText.slice(0, 100_000),
      msg.bodyHtml ? msg.bodyHtml.slice(0, 200_000) : null,
      msg.receivedAt,
      msg.isRead,
      JSON.stringify(msg.labels),
    ]
  );
  return true;
}

/** Send the receptionist's auto-reply back through the same mailbox. */
async function autoReply(account: MailAccountRow, msg: NormalizedMessage, text: string, conversationId: string): Promise<boolean> {
  const provider = getMailProvider(account.provider);
  if (!provider) return false;
  try {
    const auth = await ensureFreshAuth(account);
    const sent = await provider.send(auth, { to: [msg.from], subject: replySubject(msg.subject), text, threadId: msg.threadId }, account.id);
    await query(
      `INSERT INTO mail_messages (user_id, account_id, provider_message_id, thread_id, conversation_id, direction, from_addr, to_addrs, subject, snippet, body_text, received_at, is_read, labels, created_at)
       VALUES ($1,$2,$3,$4,$5,'out',$6,$7,$8,$9,$10,NOW(),TRUE,'["SENT"]',NOW())`,
      [account.user_id, account.id, sent.providerMessageId, sent.threadId ?? msg.threadId, conversationId, account.email, JSON.stringify([msg.from]), replySubject(msg.subject), text.slice(0, 300), text]
    );
    return true;
  } catch (err) {
    console.error("[mail/sync] auto-reply failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Fold one message into the inbox. Returns true when it was new. */
async function ingestMessage(account: MailAccountRow, msg: NormalizedMessage, runReceptionist: boolean): Promise<{ imported: boolean; replied: boolean }> {
  const dataId = account.user_id;
  const counterpart = msg.direction === "in" ? extractAddress(msg.from) : extractAddress(msg.to[0] ?? "");
  const threadKey = threadKeyFor(account.id, msg);
  const contactId = msg.direction === "in" ? await findOrCreateContact(dataId, counterpart, msg.fromName ?? null) : null;
  const conv = await findOrCreateConversation(dataId, threadKey, counterpart || account.email, contactId);
  if (!conv.id) throw new Error("Could not create the inbox conversation");

  const isNew = await insertMailMessage(account, msg, conv.id);
  if (!isNew) return { imported: false, replied: false };

  const turns = parseConversation(conv.messages);
  const turn = mailToTurn(msg, { includeSubject: turns.length === 0 });
  const mailTurn: ConversationTurn = { role: turn.role, content: turn.content, ts: turn.ts };
  turns.push(mailTurn);
  let replied = false;

  if (msg.direction === "in") {
    void emitEvent(dataId, {
      type: "mail.received",
      entity: "mail_message",
      entityId: msg.providerMessageId,
      data: { account_id: account.id, from: counterpart, subject: msg.subject.slice(0, 200), conversation_id: conv.id },
    });

    if (runReceptionist) {
      const history = turns
        .slice(0, -1)
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({ role: t.role, content: t.content }));
      const result = await handleInboundMessage(dataId, { channel: "email", fromNumber: counterpart, text: turn.content, history });
      const assistant: ConversationTurn = { role: "assistant", content: result.reply, ts: new Date().toISOString(), intent: result.intent };
      if (result.autoSend) {
        replied = await autoReply(account, msg, result.reply, conv.id);
        if (!replied) assistant.simulated = true;
      } else {
        assistant.pending = true;
      }
      turns.push(assistant);
    }
  }

  await saveConversation(dataId, counterpart || account.email, "email", conv.id, turns);
  return { imported: true, replied };
}

export async function syncAccount(accountId: string): Promise<SyncResult> {
  const result: SyncResult = { accountId, imported: 0, skipped: 0, replied: 0, error: null };
  const account = await getMailAccountById(accountId);
  if (!account) return { ...result, error: "Account not found" };
  if (account.status === "disabled") return { ...result, error: "Account is disabled" };
  const provider = getMailProvider(account.provider);
  if (!provider) return { ...result, error: `Unknown provider ${account.provider}` };

  try {
    const auth = await ensureFreshAuth(account);
    const { messages, cursor } = await provider.listNew(auth, account.sync_cursor, account.id);
    // The first pull of a mailbox is a backfill: import history, but do not have the
    // receptionist answer twenty old emails at once.
    const runReceptionist = account.sync_cursor !== null;
    const ordered = [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    for (const msg of ordered) {
      try {
        const r = await ingestMessage(account, msg, runReceptionist);
        if (r.imported) result.imported++;
        else result.skipped++;
        if (r.replied) result.replied++;
      } catch (err) {
        console.error(`[mail/sync] message ${msg.providerMessageId} failed:`, err instanceof Error ? err.message : err);
        result.skipped++;
      }
    }
    await query(
      `UPDATE mail_accounts SET sync_cursor = $1, last_sync_at = NOW(), status = 'connected', last_error = NULL WHERE id = $2`,
      [cursor ?? account.sync_cursor, account.id]
    );
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    result.error = message;
    await query(`UPDATE mail_accounts SET last_sync_at = NOW(), status = 'error', last_error = $1 WHERE id = $2`, [message, account.id]).catch(() => undefined);
  }
  return result;
}

/**
 * Claim an account for a sync by bumping `last_sync_at` first (conditional
 * UPDATE), so the cron and a manual "Sync now" can never run the same mailbox
 * concurrently and ingest a message twice. `minGapMs` is how recently the last
 * sync may have started for the claim to still succeed.
 */
export async function claimAccountForSync(accountId: string, minGapMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - Math.max(0, minGapMs)).toISOString();
  const claimed = await queryOne<{ id: string }>(
    `UPDATE mail_accounts SET last_sync_at = NOW()
      WHERE id = $1 AND status <> 'disabled' AND (last_sync_at IS NULL OR last_sync_at < $2)
      RETURNING id`,
    [accountId, cutoff]
  ).catch(() => null);
  return Boolean(claimed);
}

/** How long a manual sync is assumed to run for; a second click inside this window is rejected. */
export const MANUAL_SYNC_GAP_MS = 20_000;

export interface SyncDueResult {
  claimed: number;
  imported: number;
  replied: number;
  failed: number;
}

/**
 * Cron hook. Claims accounts that have not synced in the last 2 minutes by
 * bumping `last_sync_at` first, so overlapping ticks never sync the same
 * mailbox twice.
 */
export async function syncDueAccounts(limit = 20): Promise<SyncDueResult> {
  const out: SyncDueResult = { claimed: 0, imported: 0, replied: 0, failed: 0 };
  // Cutoff computed here rather than with interval arithmetic so the query stays plain SQL.
  const cutoff = new Date(Date.now() - SYNC_INTERVAL_MINUTES * 60_000).toISOString();
  const due = await query<{ id: string }>(
    `SELECT id FROM mail_accounts
      WHERE status <> 'disabled'
        AND (last_sync_at IS NULL OR last_sync_at < $2)
      ORDER BY last_sync_at ASC NULLS FIRST
      LIMIT $1`,
    [Math.max(1, Math.min(100, limit)), cutoff]
  ).catch(() => []);

  for (const row of due) {
    if (!(await claimAccountForSync(row.id, SYNC_INTERVAL_MINUTES * 60_000))) continue;
    out.claimed++;
    const r = await syncAccount(row.id);
    out.imported += r.imported;
    out.replied += r.replied;
    if (r.error) out.failed++;
  }
  return out;
}
