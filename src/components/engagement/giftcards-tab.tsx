"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/lib/money/items";
import type { GiftCardDTO } from "@/lib/engagement/giftcards";
import { apiJson, errMsg } from "./shared";

const TONE = { active: "success", redeemed: "neutral", void: "danger", expired: "warning" } as const;

function IssueDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const j = await apiJson<{ code: string }>("/api/engagement/gift-cards", { method: "POST", json: { amount_minor: Math.round(Number(amount) * 100), currency, recipient_email: email || null, message: message || null } });
      setCode(j.code); onDone();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(code ?? ""); setCopied(true); } catch { /* clipboard unavailable */ } }
  if (code) {
    return (
      <Dialog title="Gift card issued" size="sm" onClose={onClose}>
        <Banner tone="warn">This code is shown once and cannot be recovered. Copy it now{email ? " (it was also emailed to the recipient)" : ""}.</Banner>
        <p className="my-3 select-all break-all rounded-lg bg-secondary px-3 py-3 text-center font-mono text-lg tracking-wider" aria-label="Gift card code">{code}</p>
        <DialogFooter><Button variant="outline" onClick={() => void copy()}><Copy className="mr-1 h-4 w-4" aria-hidden />{copied ? "Copied" : "Copy code"}</Button><Button onClick={onClose}>Done</Button></DialogFooter>
      </Dialog>
    );
  }
  return (
    <Dialog title="Issue gift card" size="sm" onClose={onClose}>
      <form onSubmit={go} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label="Amount" required><Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" /></Field>
          <Field label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} /></Field>
        </div>
        <Field label="Recipient email" hint="Optional. The code is emailed here."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Message"><Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} /></Field>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !(Number(amount) > 0)}>{busy ? "Issuing…" : "Issue card"}</Button></DialogFooter>
      </form>
    </Dialog>
  );
}

function History({ card, onClose }: { card: GiftCardDTO; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ id: string; kind: string; amount_minor: number; balance_after: number; created_at: string }> | null>(null);
  useEffect(() => { apiJson<{ ledger: NonNullable<typeof rows> }>(`/api/engagement/gift-cards/${card.id}`).then((j) => setRows(j.ledger)).catch(() => setRows([])); }, [card.id]);
  return (
    <Dialog title={`Card ending ${card.code_last4}`} onClose={onClose}>
      {!rows ? <Loading label="Loading history…" /> : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r) => <li key={r.id} className="flex justify-between gap-3 py-2"><span className="capitalize">{r.kind}<span className="block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span></span><span className="text-right tabular-nums">{formatMoney(r.amount_minor, card.currency)}<span className="block text-xs text-muted-foreground">bal {formatMoney(r.balance_after, card.currency)}</span></span></li>)}
        </ul>
      )}
    </Dialog>
  );
}

export function GiftCardsTab() {
  const [cards, setCards] = useState<GiftCardDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issue, setIssue] = useState(false);
  const [hist, setHist] = useState<GiftCardDTO | null>(null);
  const confirm = useConfirm();
  const load = useCallback(async () => { try { setCards((await apiJson<{ gift_cards: GiftCardDTO[] }>("/api/engagement/gift-cards")).gift_cards); setErr(null); } catch (e) { setErr(errMsg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function voidCard(c: GiftCardDTO) {
    if (!(await confirm({ title: `Void card ending ${c.code_last4}?`, body: `The remaining ${formatMoney(c.balance_minor, c.currency)} can no longer be spent. This cannot be undone.`, confirmLabel: "Void card", tone: "danger" }))) return;
    try { await apiJson(`/api/engagement/gift-cards/${c.id}`, { method: "PATCH", json: { status: "void" } }); await load(); } catch (e) { setErr(errMsg(e)); }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">Cards are sold in the shop or issued by hand. Only the last four characters are stored.</p><Button touch onClick={() => setIssue(true)}><Gift className="mr-1 h-4 w-4" aria-hidden />Issue card</Button></div>
      {err ? <ErrorState message={err} onRetry={() => void load()} /> : !cards ? <Loading label="Loading gift cards…" /> : cards.length === 0 ? <Empty title="No gift cards yet" text="Issue a card or mark a product as a gift card to start selling them." /> : (
        <TableScroller label="Gift cards">
          <table className="w-full text-sm"><thead className={THEAD}><tr><th className={TH}>Card</th><th className={TH}>Balance</th><th className={TH}>Status</th><th className={TH}>Issued</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">{cards.map((c) => (
              <tr key={c.id}><td className="px-3 py-2 font-mono">•••• {c.code_last4}<div className="font-sans text-xs text-muted-foreground">{c.recipient_email ?? c.issued_via}</div></td><td className="px-3 py-2 tabular-nums">{formatMoney(c.balance_minor, c.currency)} <span className="text-xs text-muted-foreground">of {formatMoney(c.initial_minor, c.currency)}</span></td><td className="px-3 py-2"><Pill tone={TONE[c.status]}>{c.status}</Pill></td><td className="px-3 py-2">{new Date(c.created_at).toLocaleDateString()}</td>
                <td className="space-x-1 px-3 py-2 text-right"><Button size="sm" variant="outline" touch onClick={() => setHist(c)}>History</Button>{c.status === "active" && <Button size="sm" variant="ghost" touch onClick={() => void voidCard(c)}>Void</Button>}</td></tr>
            ))}</tbody></table>
        </TableScroller>
      )}
      {issue && <IssueDialog onClose={() => setIssue(false)} onDone={() => void load()} />}
      {hist && <History card={hist} onClose={() => setHist(null)} />}
    </div>
  );
}
