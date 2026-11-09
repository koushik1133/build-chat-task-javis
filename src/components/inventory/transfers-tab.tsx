"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, PackageCheck, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { SkeletonList } from "@/components/ui/feedback";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { fmtDate } from "@/lib/money/format";
import { api, Banner, Dialog, DialogFooter, Empty, Field } from "@/components/finance/shared";
import { TRANSFER_TONE, type LocationItem, type ProductLite, type TransferItem } from "./types";

export function TransfersTab({ locations, products, onChanged, onNotice }: { locations: LocationItem[]; products: ProductLite[]; onChanged: () => void; onNotice: (msg: string) => void }) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<TransferItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ transfers: TransferItem[] }>("/api/transfers");
      setTransfers(r.transfers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load transfers.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(t: TransferItem, action: "ship" | "cancel", msg: string) {
    setBusy(t.id);
    setError(null);
    try {
      await api(`/api/transfers/${t.id}/${action}`, { method: "POST", body: "{}" });
      onNotice(msg);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn’t work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel(t: TransferItem) {
    const body = t.status === "in_transit" ? "Units not yet received go back to the source location." : "The draft will be discarded.";
    if (!(await confirm({ title: `Cancel ${t.number}?`, body, confirmLabel: "Cancel transfer", cancelLabel: "Keep", tone: "danger" }))) return;
    await run(t, "cancel", `${t.number} cancelled.`);
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button touch onClick={() => setCreating(true)} disabled={locations.length < 2}>
          <Plus className="h-4 w-4" aria-hidden /> New transfer
        </Button>
      </div>
      {locations.length < 2 && <Banner tone="info">Add at least two locations to move stock between them.</Banner>}
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {loading && transfers.length === 0 ? (
        <SkeletonList count={3} label="Loading transfers…" />
      ) : transfers.length === 0 ? (
        <Empty icon={<ArrowRight className="h-5 w-5" />} title="No transfers yet" text="Create a transfer to move stock from one location to another, then ship and receive it." />
      ) : (
        <ul className="space-y-2">
          {transfers.map((t) => (
            <li key={t.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {t.number}{" "}
                    <span className="font-normal text-muted-foreground">
                      {t.from_name ?? "?"} <ArrowRight className="inline h-3.5 w-3.5" aria-hidden /> {t.to_name ?? "?"}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.lines.map((l) => `${l.qty} × ${l.product_name ?? l.product_id}${t.status === "in_transit" && l.received_qty > 0 ? ` (${l.received_qty} received)` : ""}`).join(", ")} · {fmtDate(t.created_at)}
                  </p>
                </div>
                <Pill tone={TRANSFER_TONE[t.status]} className="capitalize">
                  {t.status.replace("_", " ")}
                </Pill>
              </div>
              {(t.status === "draft" || t.status === "in_transit") && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.status === "draft" && (
                    <Button size="sm" touch disabled={busy === t.id} onClick={() => void run(t, "ship", `${t.number} shipped.`)}>
                      {busy === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />} Ship
                    </Button>
                  )}
                  {t.status === "in_transit" && (
                    <Button size="sm" touch disabled={busy === t.id} onClick={() => setReceiving(t)}>
                      <PackageCheck className="h-3.5 w-3.5" aria-hidden /> Receive
                    </Button>
                  )}
                  <Button variant="outline" size="sm" touch disabled={busy === t.id} onClick={() => void cancel(t)} aria-label={`Cancel ${t.number}`}>
                    <X className="h-3.5 w-3.5" aria-hidden /> Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateDialog
          locations={locations}
          products={products}
          onClose={() => setCreating(false)}
          onSaved={(msg) => {
            setCreating(false);
            onNotice(msg);
            void load();
          }}
        />
      )}
      {receiving && (
        <ReceiveDialog
          transfer={receiving}
          onClose={() => setReceiving(null)}
          onSaved={(msg) => {
            setReceiving(null);
            onNotice(msg);
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function CreateDialog({ locations, products, onClose, onSaved }: { locations: LocationItem[]; products: ProductLite[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const tracked = products.filter((p) => p.track_stock);
  const [from, setFrom] = useState(locations[0]?.id ?? "");
  const [to, setTo] = useState(locations[1]?.id ?? "");
  const [lines, setLines] = useState<Array<{ product_id: string; qty: string }>>([{ product_id: tracked[0]?.id ?? "", qty: "1" }]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        from_location_id: from,
        to_location_id: to,
        note: note.trim() || null,
        lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, qty: Math.trunc(Number(l.qty)) })),
      };
      if (body.lines.length === 0 || body.lines.some((l) => !(l.qty >= 1))) throw new Error("Add at least one product with a quantity of 1 or more.");
      const r = await api<{ transfer: TransferItem }>("/api/transfers", { method: "POST", body: JSON.stringify(body) });
      onSaved(`${r.transfer.number} created as a draft.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the transfer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="New transfer" onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select data-autofocus value={from} onChange={(e) => setFrom(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">Products</legend>
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select aria-label={`Product ${i + 1}`} value={l.product_id} onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))} className="min-w-0 flex-1">
                {tracked.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku ? `${p.name} (${p.sku})` : p.name}
                  </option>
                ))}
              </Select>
              <Input aria-label={`Quantity ${i + 1}`} type="number" inputMode="numeric" min={1} step={1} value={l.qty} onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} className="w-24" />
              <Button type="button" variant="ghost" size="icon" touch aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { product_id: tracked[0]?.id ?? "", qty: "1" }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add product
          </Button>
        </fieldset>
        <Field label="Note">
          <Input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">
            {error}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || from === to || tracked.length === 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Create draft
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function ReceiveDialog({ transfer, onClose, onSaved }: { transfer: TransferItem; onClose: () => void; onSaved: (msg: string) => void }) {
  const open = transfer.lines.filter((l) => l.remaining > 0);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.product_id, String(l.remaining)])));
  const [closeShort, setCloseShort] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const lines = open.map((l) => ({ product_id: l.product_id, received_qty: Math.max(0, Math.trunc(Number(qty[l.product_id] ?? 0))) }));
      const r = await api<{ transfer: TransferItem }>(`/api/transfers/${transfer.id}/receive`, { method: "POST", body: JSON.stringify({ lines, close_short: closeShort }) });
      onSaved(r.transfer.status === "received" ? `${transfer.number} fully received.` : `${transfer.number} partly received; the rest is still in transit.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not receive the transfer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`Receive ${transfer.number}`} description={`${transfer.from_name ?? "?"} → ${transfer.to_name ?? "?"}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ul className="space-y-2">
          {open.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">
                {l.product_name ?? l.product_id} <span className="text-xs text-muted-foreground">({l.remaining} outstanding)</span>
              </span>
              <Input
                aria-label={`Received quantity for ${l.product_name ?? l.product_id}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={l.remaining}
                step={1}
                value={qty[l.product_id] ?? ""}
                onChange={(e) => setQty((prev) => ({ ...prev, [l.product_id]: e.target.value }))}
                className="w-24"
              />
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={closeShort} onChange={(e) => setCloseShort(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-border" />
          <span>Close the transfer and write off anything not received (lowers your total stock)</span>
        </label>
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">
            {error}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Receive
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
