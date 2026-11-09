"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { money } from "@/components/shop/shop-ui";

export interface DiscountPreview {
  discount_minor: number;
  free_shipping: boolean;
  vouchers: Array<{ code: string; name: string; discount_minor: number }>;
  points: { points: number; valueMinor: number } | null;
  gift_card: { last4: string; balance_minor: number; applied_minor: number } | null;
  problems: Array<{ field: "voucher" | "points" | "gift_card"; code: string; message: string }>;
  total_minor: number;
  payable_minor: number;
  currency: string;
}

export interface DiscountSelection {
  voucher_codes: string[];
  points: number;
  gift_card: string;
  portal_token: string;
}

/** sessionStorage keys written by <RefCapture> on any /shop page. */
export const refKey = (org: string) => `kh_ref_${org}`;
export const portalKey = (org: string) => `kh_pt_${org}`;
function readStore(key: string): string {
  try { return window.sessionStorage.getItem(key) ?? ""; } catch { return ""; }
}

/**
 * Voucher, gift card and (for signed-in rewards members) loyalty points inputs
 * with a server-computed preview. Errors are inline and announced; nothing is
 * redeemed until the order is placed.
 */
export function DiscountFields({ org, email, pickup, onChange }: { org: string; email: string; pickup: boolean; onChange: (sel: DiscountSelection, preview: DiscountPreview | null) => void }) {
  const [codeInput, setCodeInput] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [gift, setGift] = useState("");
  const [giftApplied, setGiftApplied] = useState("");
  const [points, setPoints] = useState("");
  const [preview, setPreview] = useState<DiscountPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [portalToken, setPortalToken] = useState("");
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => { setPortalToken(readStore(portalKey(org))); }, [org]);

  const run = useCallback(async (next: { codes: string[]; gift: string; points: number }) => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/shop/${encodeURIComponent(org)}/discounts/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ voucher_codes: next.codes, points: next.points || undefined, gift_card: next.gift || undefined, portal_token: portalToken || undefined, email: email || undefined, pickup }),
      });
      const json = (await res.json().catch(() => ({}))) as DiscountPreview & { error?: string };
      if (!res.ok) { setFailure(res.status === 429 ? "Too many attempts. Please wait a minute and try again." : "Could not check that code. Please try again."); setPreview(null); cb.current({ voucher_codes: [], points: 0, gift_card: "", portal_token: portalToken }, null); return; }
      setPreview(json);
      // Keep only what the server accepted so a rejected code never reaches checkout.
      const rejectedVoucher = json.problems.some((p) => p.field === "voucher");
      const okCodes = rejectedVoucher ? next.codes.filter((c) => json.vouchers.some((v) => v.code === c.toUpperCase())) : next.codes;
      const okGift = json.gift_card ? next.gift : "";
      const okPoints = json.points ? next.points : 0;
      setCodes(okCodes);
      setGiftApplied(okGift);
      cb.current({ voucher_codes: okCodes, points: okPoints, gift_card: okGift, portal_token: portalToken }, json);
    } catch {
      setFailure("Could not check that code. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [org, email, pickup, portalToken]);

  const problem = (field: "voucher" | "points" | "gift_card") => preview?.problems.find((p) => p.field === field)?.message ?? null;

  return (
    <section className="scroll-mb-28 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="co-discounts">
      <h2 id="co-discounts" className="mb-3 flex items-center gap-2 text-sm font-semibold"><Tag className="h-4 w-4" aria-hidden /> Discounts and gift cards</h2>
      <div className="space-y-3">
        <div>
          <Field label="Discount code" error={problem("voucher")}>
            <div className="flex gap-2">
              <Input aria-label="Discount code" value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} maxLength={40} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (codeInput.trim()) { const next = [...new Set([...codes, codeInput.trim()])]; setCodeInput(""); void run({ codes: next, gift: giftApplied, points: Number(points) || 0 }); } } }} />
              <Button type="button" variant="outline" touch disabled={busy || !codeInput.trim()} onClick={() => { const next = [...new Set([...codes, codeInput.trim()])]; setCodeInput(""); void run({ codes: next, gift: giftApplied, points: Number(points) || 0 }); }}>Apply</Button>
            </div>
          </Field>
          {codes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Applied codes">
              {codes.map((c) => (
                <li key={c} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
                  {c}
                  <button type="button" aria-label={`Remove code ${c}`} className="inline-flex h-11 w-8 items-center justify-center rounded hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void run({ codes: codes.filter((x) => x !== c), gift: giftApplied, points: Number(points) || 0 })}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Gift card" error={problem("gift_card")} hint={giftApplied && preview?.gift_card ? `Card ending ${preview.gift_card.last4} applied: ${money(preview.gift_card.applied_minor, preview.currency)}` : undefined}>
          <div className="flex gap-2">
            <Input aria-label="Gift card number" value={gift} onChange={(e) => setGift(e.target.value.toUpperCase())} maxLength={40} autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono" />
            <Button type="button" variant="outline" touch disabled={busy || !gift.trim()} onClick={() => void run({ codes, gift: gift.trim(), points: Number(points) || 0 })}>Apply</Button>
          </div>
        </Field>
        {portalToken && (
          <Field label="Use reward points" error={problem("points")} hint="Points from your rewards account.">
            <div className="flex gap-2">
              <Input aria-label="Points to use" type="number" min={0} inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} />
              <Button type="button" variant="outline" touch disabled={busy} onClick={() => void run({ codes, gift: giftApplied, points: Number(points) || 0 })}>Apply</Button>
            </div>
          </Field>
        )}
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <div aria-live="polite" className="text-sm">
          {preview && preview.discount_minor > 0 && <p className="text-emerald-700 dark:text-emerald-400">Discount applied: {money(preview.discount_minor, preview.currency)}</p>}
          {preview?.free_shipping && <p className="text-emerald-700 dark:text-emerald-400">Free shipping applied.</p>}
        </div>
      </div>
    </section>
  );
}
