"use client";

import { useCallback, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner } from "@/components/ui/feedback";
import { Input, Select, Textarea } from "@/components/ui/input";

/** Customer-facing return request (order status page and portal). Client-safe: talks to the public routes only. */

export interface ReturnInfo {
  eligible: boolean;
  reason: string | null;
  window_days: number;
  deadline: string | null;
  lines: Array<{ product_id: string | null; description: string; qty_available: number }>;
  existing: Array<{ id: string; status: string; reason: string | null; created_at: string }>;
}

const STATUS_TEXT: Record<string, string> = {
  requested: "Waiting for review",
  approved: "Approved",
  rejected: "Not accepted",
  label_sent: "Return label sent",
  received: "Received",
  refunded: "Refunded",
  closed: "Closed",
};

export function CustomerReturns({ infoUrl, postUrl, extraBody, initial, onDone, compact }: { infoUrl: string; postUrl: string; extraBody?: Record<string, unknown>; initial?: ReturnInfo | null; onDone?: () => void; compact?: boolean }) {
  const [info, setInfo] = useState<ReturnInfo | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState("refund");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const openDialog = useCallback(async () => {
    setError(null);
    setOpen(true);
    if (info) return;
    setLoading(true);
    try {
      const res = await fetch(infoUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load return options");
      const j = (await res.json()) as { returns: ReturnInfo };
      setInfo(j.returns);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load return options");
    } finally {
      setLoading(false);
    }
  }, [info, infoUrl]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!info) return;
    const items = info.lines.flatMap((l) => {
      const q = qty[l.product_id ?? l.description] ?? 0;
      return q > 0 ? [{ product_id: l.product_id, description: l.description, qty: q }] : [];
    });
    if (items.length === 0) return setError("Choose at least one item to return.");
    if (!reason.trim()) return setError("Tell us why you are returning it.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(postUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...extraBody, reason, resolution, items }) });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(typeof j?.detail === "string" ? j.detail : "Could not submit the return");
      }
      setSent(true);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the return");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "" : "mt-6"}>
      {info?.existing && info.existing.length > 0 && (
        <ul className="mb-2 space-y-1 text-sm text-muted-foreground" aria-label="Your returns">
          {info.existing.map((r) => (
            <li key={r.id}>
              Return requested {new Date(r.created_at).toLocaleDateString()}: <span className="font-medium text-foreground">{STATUS_TEXT[r.status] ?? r.status}</span>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" touch size={compact ? "sm" : undefined} onClick={() => void openDialog()}>
        <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
        Return items
      </Button>
      {open && (
        <Dialog title="Return items" description={info ? `Returns are accepted for ${info.window_days} days after delivery.` : undefined} onClose={() => setOpen(false)}>
          {loading || !info ? (
            error ? <Banner tone="error">{error}</Banner> : <p role="status" className="py-6 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /><span className="sr-only">Loading</span></p>
          ) : sent ? (
            <div role="status" className="py-4 text-sm">
              <p className="font-medium">Return request sent.</p>
              <p className="mt-1 text-muted-foreground">We will email you once it has been reviewed.</p>
              <DialogFooter><Button type="button" touch onClick={() => setOpen(false)}>Done</Button></DialogFooter>
            </div>
          ) : !info.eligible ? (
            <div className="py-2 text-sm">
              <p>{info.reason ?? "This order cannot be returned."}</p>
              <DialogFooter><Button type="button" variant="outline" touch onClick={() => setOpen(false)}>Close</Button></DialogFooter>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium">What are you returning?</legend>
                {info.lines.map((l) => {
                  const key = l.product_id ?? l.description;
                  return (
                    <div key={key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words">{l.description}</span>
                      <Input type="number" inputMode="numeric" min={0} max={l.qty_available} value={qty[key] ?? 0} onChange={(e) => setQty((q) => ({ ...q, [key]: Math.min(l.qty_available, Math.max(0, Number(e.target.value) || 0)) }))} aria-label={`Quantity of ${l.description} to return (max ${l.qty_available})`} className="w-20 shrink-0" />
                    </div>
                  );
                })}
              </fieldset>
              <Field label="Reason" required>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required />
              </Field>
              <Field label="What would you like?">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  <option value="refund">Refund to my payment method</option>
                  <option value="exchange">Exchange</option>
                  <option value="store_credit">Store credit</option>
                </Select>
              </Field>
              {error && <Banner tone="error">{error}</Banner>}
              <DialogFooter>
                <Button type="button" variant="outline" touch onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                <Button type="submit" touch disabled={busy} aria-busy={busy || undefined}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Submit return</Button>
              </DialogFooter>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}
