"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner } from "@/components/ui/feedback";
import { apiJson, errMsg } from "./shared";

/** Staff: add a voucher/points discount to a draft invoice, or pay part of an issued one with a gift card. */
export function InvoiceDiscountDialog({ invoice, onClose, onDone }: { invoice: { id: string; number: string; status: string }; onClose: () => void; onDone: (msg: string) => void }) {
  const draft = invoice.status === "draft";
  const [code, setCode] = useState("");
  const [points, setPoints] = useState("");
  const [gift, setGift] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await apiJson("/api/engagement/invoice-discount", { method: "POST", json: { invoice_id: invoice.id, voucher_code: code.trim() || undefined, points: Number(points) || undefined, gift_card: gift.trim() || undefined } });
      onDone(`Updated ${invoice.number}.`);
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Dialog title={`Discount or gift card: ${invoice.number}`} size="sm" onClose={onClose}>
      <form onSubmit={go} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        {draft ? (
          <>
            <Field label="Voucher code" hint="Applied before tax as a negative line."><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} className="font-mono" /></Field>
            <Field label="Loyalty points to redeem" hint="Uses the invoice contact's balance."><Input type="number" min={0} value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" /></Field>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Vouchers and points can only be added while the invoice is a draft.</p>
        )}
        {!draft && invoice.status !== "void" && invoice.status !== "paid" && (
          <Field label="Gift card code" hint="Pays up to the card balance."><Input value={gift} onChange={(e) => setGift(e.target.value.toUpperCase())} maxLength={40} className="font-mono" autoComplete="off" /></Field>
        )}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !(code.trim() || Number(points) > 0 || gift.trim())}>{busy ? "Applying…" : "Apply"}</Button></DialogFooter>
      </form>
    </Dialog>
  );
}
