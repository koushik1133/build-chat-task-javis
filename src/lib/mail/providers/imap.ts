import type { MailProvider } from "../types";

/**
 * IMAP placeholder. Talking IMAP needs a protocol client (e.g. imapflow) that
 * is deliberately not a dependency yet, so the provider reports itself as
 * unavailable and every operation fails with the same clear message.
 */
const REASON = "IMAP is not available yet — connect Gmail or Outlook, or use the simulated inbox.";

function unavailable(): never {
  throw new Error(REASON);
}

export const imapProvider: MailProvider = {
  id: "imap",
  label: "IMAP",
  configured: () => false,
  unavailableReason: () => REASON,
  oauthStartUrl: () => unavailable(),
  exchangeCode: async () => unavailable(),
  refresh: async () => unavailable(),
  listNew: async () => unavailable(),
  send: async () => unavailable(),
};
