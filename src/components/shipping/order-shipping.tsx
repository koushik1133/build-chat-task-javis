"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Loader2, PackagePlus, Printer, Send, Truck, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { api } from "@/components/finance/shared";
import { fmtMoney } from "@/lib/money/format";
import { RETURN_TONE, SHIPMENT_TONE, fmtWhen, type ReturnView, type ShipmentView } from "./shared";
import { ShipmentTimeline } from "./shipment-timeline";

/** Shipping section of the Orders drawer: shipments, rate picker, label/slip printing, tracking, returns summary. */

interface OrderShippingData {
  shipments: ShipmentView[];
  returns: ReturnView[];
  shipping_method: string | null;
  shipping_quote: { label: string; price_minor: number } | null;
}
interface Rate {
  id: string;
  carrier: string;
  service: string;
  service_label: string;
  amount_minor: number;
  currency: string;
  days_min: number | null;
  days_max: number | null;
}

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

export function OrderShipping({ orderId, orderStatus, hasAddress, currency, onNotice }: { orderId: string; orderStatus: string; hasAddress: boolean; currency: string; onNotice?: (n: { tone: "success" | "error"; text: string }) => void }) {
  const [data, setData] = useState<OrderShippingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api<OrderShippingData>(`/api/shipping/orders/${orderId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load shipping");
    }
  }, [orderId]);
  useEffect(() => {
    void load();
  }, [load]);

  const notify = (tone: "success" | "error", text: string) => onNotice?.({ tone, text });
  async function act(id: string, kind: "ship" | "void") {
    if (kind === "void" && !(await confirmDialog({ title: "Void this label?", body: "The carrier is asked to refund the label. This only works before the carrier scans it.", confirmLabel: "Void label", tone: "danger" }))) return;
    setBusy(id + kind);
    try {
      await api(`/api/shipping/shipments/${id}/${kind}`, { method: "POST", body: "{}" });
      notify("success", kind === "ship" ? "Marked as shipped; the customer was emailed." : "Label voided.");
      setTick((t) => t + 1);
      await load();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const canShip = (orderStatus === "paid" || orderStatus === "fulfilled") && hasAddress;
  const live = data?.shipments.filter((s) => s.status !== "void") ?? [];

  return (
    <section aria-labelledby="ord-ship-h">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id="ord-ship-h" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shipping</h3>
        {canShip && (
          <Button type="button" size="sm" variant="outline" touch onClick={() => setCreate(true)}>
            <PackagePlus className="mr-1.5 h-4 w-4" aria-hidden />
            {live.length > 0 ? "Add shipment" : "Create shipment"}
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <Loading label="Loading shipping…" />
      ) : (
        <div className="space-y-3 text-sm">
          {data.shipping_method && <p className="text-muted-foreground">Customer chose <span className="font-medium text-foreground">{data.shipping_method}</span>{data.shipping_quote ? ` (${fmtMoney(data.shipping_quote.price_minor, currency)})` : ""}.</p>}
          {!hasAddress && <p className="text-muted-foreground">Collection order: nothing to ship.</p>}
          {data.shipments.length === 0 && hasAddress && <p className="text-muted-foreground">No shipments yet.</p>}
          {data.shipments.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={s.status} map={SHIPMENT_TONE} label={s.status_label} />
                <span className="min-w-0 break-all font-medium">{[s.carrier, s.service].filter(Boolean).join(" ") || "Shipment"}</span>
                {s.return_id && <span className="text-xs text-muted-foreground">(return)</span>}
                <span className="ml-auto text-xs text-muted-foreground">{s.rate_minor > 0 ? fmtMoney(s.rate_minor, s.currency) : "no label cost"}</span>
              </div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {s.tracking_number ?? "No tracking number"}
                {s.tracking_url && (
                  <a href={s.tracking_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline">
                    Carrier <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(s.label_url || s.label_attachment_id) && (
                  <Button asChild size="sm" variant="outline" touch><a href={`/api/shipping/shipments/${s.id}/label`} target="_blank" rel="noopener noreferrer"><Printer className="mr-1.5 h-4 w-4" aria-hidden />Label</a></Button>
                )}
                <Button asChild size="sm" variant="outline" touch><a href={`/api/shipping/shipments/${s.id}/packing-slip`} target="_blank" rel="noopener noreferrer"><FileText className="mr-1.5 h-4 w-4" aria-hidden />Packing slip</a></Button>
                {s.status === "label_purchased" && (
                  <Button type="button" size="sm" touch onClick={() => void act(s.id, "ship")} disabled={busy !== null} aria-busy={busy === s.id + "ship" || undefined}>{busy === s.id + "ship" ? spinner : <Send className="mr-1.5 h-4 w-4" aria-hidden />}Mark shipped</Button>
                )}
                {s.status === "label_purchased" && (
                  <Button type="button" size="sm" variant="outline" touch onClick={() => void act(s.id, "void")} disabled={busy !== null}><Ban className="mr-1.5 h-4 w-4" aria-hidden />Void</Button>
                )}
                <Button type="button" size="sm" variant="ghost" touch onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>{open === s.id ? "Hide tracking" : "Tracking"}</Button>
              </div>
              {open === s.id && <div className="mt-3"><ShipmentTimeline shipmentId={s.id} refreshKey={tick} /></div>}
            </div>
          ))}
          {data.returns.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Returns</p>
              <ul className="space-y-1">
                {data.returns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <StatusPill status={r.status} map={RETURN_TONE} />
                    <span className="text-xs text-muted-foreground">{fmtWhen(r.created_at)}</span>
                    <Link href={`/shipping?tab=returns&return=${r.id}`} className="ml-auto rounded text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {create && <CreateShipmentDialog orderId={orderId} currency={currency} additional={live.length > 0} onClose={() => setCreate(false)} onDone={() => { setCreate(false); notify("success", "Shipment created."); void load(); }} onError={(m) => notify("error", m)} />}
    </section>
  );
}

function CreateShipmentDialog({ orderId, currency, additional, onClose, onDone, onError }: { orderId: string; currency: string; additional: boolean; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<"label" | "manual">("label");
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [rateId, setRateId] = useState("");
  const [weight, setWeight] = useState("");
  const [dims, setDims] = useState({ l: "", w: "", h: "" });
  const [manual, setManual] = useState({ carrier: "", tracking: "", url: "" });
  const [busy, setBusy] = useState<"rates" | "buy" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pkg = () => ({
    ...(Number(weight) > 0 ? { weight_grams: Math.round(Number(weight)) } : {}),
    ...(Number(dims.l) > 0 ? { length_cm: Number(dims.l) } : {}),
    ...(Number(dims.w) > 0 ? { width_cm: Number(dims.w) } : {}),
    ...(Number(dims.h) > 0 ? { height_cm: Number(dims.h) } : {}),
  });

  async function getRates() {
    setBusy("rates");
    setErr(null);
    try {
      const r = await api<{ rates: Rate[]; weight_grams: number }>("/api/shipping/rates", { method: "POST", body: JSON.stringify({ order_id: orderId, package: pkg() }) });
      setRates(r.rates);
      setRateId([...r.rates].sort((a, b) => a.amount_minor - b.amount_minor)[0]?.id ?? "");
      if (!weight) setWeight(String(r.weight_grams));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not get rates");
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy("buy");
    setErr(null);
    try {
      const body = mode === "manual"
        ? { order_id: orderId, additional, packages: [pkg()], manual: { carrier: manual.carrier, tracking_number: manual.tracking || undefined, tracking_url: manual.url || undefined } }
        : { order_id: orderId, additional, rate_id: rateId, packages: [pkg()] };
      await api("/api/shipping/shipments", { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Could not create the shipment";
      setErr(m);
      onError(m);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog title="Create shipment" description={mode === "label" ? "Buying a label charges your carrier account." : "Record a shipment you arranged yourself; no label is bought."} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Field label="How?">
          <Select value={mode} onChange={(e) => setMode(e.target.value as "label" | "manual")}>
            <option value="label">Buy a label</option>
            <option value="manual">Enter tracking manually</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Weight (g)"><Input inputMode="numeric" value={weight} onChange={(e) => { setWeight(e.target.value); setRates(null); }} placeholder="auto" /></Field>
          <Field label="Length (cm)"><Input inputMode="decimal" value={dims.l} onChange={(e) => { setDims({ ...dims, l: e.target.value }); setRates(null); }} /></Field>
          <Field label="Width (cm)"><Input inputMode="decimal" value={dims.w} onChange={(e) => { setDims({ ...dims, w: e.target.value }); setRates(null); }} /></Field>
          <Field label="Height (cm)"><Input inputMode="decimal" value={dims.h} onChange={(e) => { setDims({ ...dims, h: e.target.value }); setRates(null); }} /></Field>
        </div>
        {mode === "label" ? (
          <div>
            <Button type="button" variant="outline" touch onClick={() => void getRates()} disabled={busy !== null} aria-busy={busy === "rates" || undefined}>{busy === "rates" ? spinner : <Truck className="mr-1.5 h-4 w-4" aria-hidden />}Get rates</Button>
            {rates && rates.length === 0 && <p className="mt-2 text-sm text-muted-foreground">The carrier returned no rates for this parcel.</p>}
            {rates && rates.length > 0 && (
              <fieldset className="mt-3 space-y-2">
                <legend className="sr-only">Choose a rate</legend>
                {rates.map((r) => (
                  <label key={r.id} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm focus-within:ring-2 focus-within:ring-ring has-[:checked]:border-primary">
                    <span className="flex min-w-0 items-center gap-2">
                      <input type="radio" name="rate" aria-label={r.service_label} checked={rateId === r.id} onChange={() => setRateId(r.id)} className="h-4 w-4 accent-primary" />
                      <span className="min-w-0 break-words font-medium">{r.service_label}</span>
                      {r.days_min !== null && <span className="text-xs text-muted-foreground">{r.days_min === r.days_max ? `${r.days_min}d` : `${r.days_min}-${r.days_max}d`}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">{fmtMoney(r.amount_minor, r.currency || currency)}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Carrier" required><Input value={manual.carrier} onChange={(e) => setManual({ ...manual, carrier: e.target.value })} maxLength={80} /></Field>
            <Field label="Tracking number"><Input value={manual.tracking} onChange={(e) => setManual({ ...manual, tracking: e.target.value })} maxLength={120} /></Field>
            <Field label="Tracking link (https)" className="sm:col-span-2"><Input type="url" value={manual.url} onChange={(e) => setManual({ ...manual, url: e.target.value })} maxLength={2048} /></Field>
          </div>
        )}
        {err && <Banner tone="error">{err}</Banner>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" touch onClick={onClose} disabled={busy !== null}>Cancel</Button>
        <Button type="button" touch onClick={() => void submit()} disabled={busy !== null || (mode === "label" ? !rateId : !manual.carrier.trim())} aria-busy={busy === "buy" || undefined}>
          {busy === "buy" ? spinner : null}
          {mode === "label" ? "Buy label" : "Save shipment"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
