import { randomUUID } from "crypto";
import type { ListNewResult, MailProvider, NormalizedMessage, OutboundMail } from "../types";

/**
 * Simulated mailbox for development and demos. `api/mail/simulate` pushes a
 * message into the in-process queue and immediately syncs the account, so the
 * full pipeline (upsert → thread → receptionist) runs without any provider.
 * Nothing leaves the server; sends are recorded in `sentLog` for inspection.
 */

const inbox = new Map<string, NormalizedMessage[]>();
const sentLog: Array<{ accountId: string; msg: OutboundMail; at: string }> = [];

export function pushSimulatedMail(accountId: string, input: { from: string; subject: string; body: string; threadId?: string | null }): NormalizedMessage {
  const msg: NormalizedMessage = {
    providerMessageId: `sim_${randomUUID()}`,
    threadId: input.threadId ?? null,
    direction: "in",
    from: input.from.trim().toLowerCase(),
    to: [],
    subject: input.subject,
    snippet: input.body.slice(0, 300),
    bodyText: input.body,
    bodyHtml: null,
    receivedAt: new Date().toISOString(),
    isRead: false,
    labels: ["INBOX", "UNREAD"],
  };
  const list = inbox.get(accountId) ?? [];
  list.push(msg);
  inbox.set(accountId, list);
  return msg;
}

/** Test/inspection hook. */
export function simulatedSentLog() {
  return sentLog;
}

export function resetSimulatedMail(): void {
  inbox.clear();
  sentLog.length = 0;
}

export const simulatedProvider: MailProvider = {
  id: "simulated",
  label: "Simulated inbox",
  configured: () => true,
  unavailableReason: () => null,
  oauthStartUrl: () => "/settings/mail",
  async exchangeCode() {
    return { auth: {}, email: "simulated@localhost", displayName: "Simulated inbox", cursor: "0" };
  },
  async refresh(auth) {
    return auth;
  },
  async listNew(_auth, cursor, accountId): Promise<ListNewResult> {
    const messages = inbox.get(accountId) ?? [];
    inbox.delete(accountId);
    const n = Number(cursor ?? "0") || 0;
    return { messages, cursor: String(n + messages.length) };
  },
  async send(_auth, msg, accountId) {
    sentLog.push({ accountId, msg, at: new Date().toISOString() });
    return { providerMessageId: `sim_out_${randomUUID()}`, threadId: msg.threadId ?? null };
  },
};
