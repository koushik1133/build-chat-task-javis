import type { ConversationTurn } from "@/lib/twilio-webhook";

/**
 * Pure helpers for approving/rejecting a receptionist draft (client-safe).
 *
 * A draft is the newest `pending` assistant turn in the thread. Approving
 * releases it to the visitor (optionally with the operator's edited text);
 * rejecting removes it. When no pending turn exists (e.g. the thread was
 * trimmed), approve appends a fresh visible turn so the reply still lands.
 */

export function pendingDraftIndex(turns: ConversationTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant" && turns[i].pending) return i;
  }
  return -1;
}

export function releaseDraft(turns: ConversationTurn[], text: string, opts: { simulated?: boolean; now?: Date } = {}): { turns: ConversationTurn[]; released: boolean } {
  const ts = (opts.now ?? new Date()).toISOString();
  const idx = pendingDraftIndex(turns);
  const next = turns.map((t) => ({ ...t }));
  if (idx === -1) {
    const turn: ConversationTurn = { role: "assistant", content: text, ts };
    if (opts.simulated) turn.simulated = true;
    return { turns: [...next, turn], released: false };
  }
  const turn = { ...next[idx], content: text, ts };
  delete turn.pending;
  if (opts.simulated) turn.simulated = true;
  else delete turn.simulated;
  next[idx] = turn;
  return { turns: next, released: true };
}

export function discardDraft(turns: ConversationTurn[]): { turns: ConversationTurn[]; discarded: boolean } {
  const idx = pendingDraftIndex(turns);
  if (idx === -1) return { turns, discarded: false };
  return { turns: [...turns.slice(0, idx), ...turns.slice(idx + 1)], discarded: true };
}
