import { query, queryOne } from "@/lib/dsql";
import { ensureFreshAuth, getMailAccount, getMailProvider } from "./index";
import { replySubject } from "./parse";

/**
 * Outbound email for the unified inbox: a human reply typed on an "email"
 * conversation goes back out through the mailbox that received the thread.
 */

export interface MailReplyResult {
  /** True when no real provider delivered it (simulated inbox). */
  simulated: boolean;
  providerMessageId: string | null;
  accountEmail: string;
}

interface LastInbound {
  account_id: string;
  from_addr: string | null;
  subject: string | null;
  thread_id: string | null;
}

export async function sendMailReply(dataId: string, conversationId: string, text: string): Promise<MailReplyResult> {
  const last = await queryOne<LastInbound>(
    `SELECT account_id, from_addr, subject, thread_id FROM mail_messages
      WHERE user_id = $1 AND conversation_id = $2 AND direction = 'in'
      ORDER BY received_at DESC LIMIT 1`,
    [dataId, conversationId]
  );
  if (!last?.from_addr) throw new Error("This thread has no inbound email to reply to.");

  const account = await getMailAccount(dataId, last.account_id);
  if (!account) throw new Error("The mailbox for this thread is no longer connected.");
  if (account.status === "disabled") throw new Error("The mailbox for this thread is disabled.");
  const provider = getMailProvider(account.provider);
  if (!provider) throw new Error(`Unknown mail provider ${account.provider}`);

  const auth = await ensureFreshAuth(account);
  const subject = replySubject(last.subject);
  const sent = await provider.send(auth, { to: [last.from_addr], subject, text, threadId: last.thread_id }, account.id);

  await query(
    `INSERT INTO mail_messages (user_id, account_id, provider_message_id, thread_id, conversation_id, direction, from_addr, to_addrs, subject, snippet, body_text, received_at, is_read, labels, created_at)
     VALUES ($1,$2,$3,$4,$5,'out',$6,$7,$8,$9,$10,NOW(),TRUE,'["SENT"]',NOW())`,
    [dataId, account.id, sent.providerMessageId, sent.threadId ?? last.thread_id, conversationId, account.email, JSON.stringify([last.from_addr]), subject, text.slice(0, 300), text]
  );

  return { simulated: provider.id === "simulated", providerMessageId: sent.providerMessageId, accountEmail: account.email };
}
