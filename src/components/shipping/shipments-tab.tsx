"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox, Select } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api } from "@/components/finance/shared";
import { fmtMoney } from "@/lib/money/format";
import { SHIPMENT_STATUSES } from "@/lib/shipping/types";
import { OrderShipping } from "./order-shipping";
import { SHIPMENT_TONE, fmtWhen, type ShipmentView } from "./shared";

type Notice = { tone: "success" | "error"; text: string };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

export function ShipmentsTab({ selectedId, onSelect, notify }: { selectedId: string | null; onSelect: (id: string | null) => void; notify: (n: Notice) => void }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<ShipmentView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [bulk, setBulk] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ shipments: ShipmentView[]; next_cursor: string | null }>(`/api/shipping/shipments?limit=50${status ? `&status=${status}` : ""}`);
      setRows(r.shipments);
      setCursor(r.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load shipments");
    }
  }, [status]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const r = await api<{ shipments: ShipmentView[]; next_cursor: string | null }>(`/api/shipping/shipments?limit=50&cursor=${encodeURIComponent(cursor)}${status ? `&status=${status}` : ""}`);
      setRows((cur) => [...(cur ?? []), ...r.shipments]);
      setCursor(r.next_cursor);
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not load more" });
    } finally {
      setMore(false);
    }
  }

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            <option value="">All statuses</option>
            {SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </Select>
        </label>
        <Button type="button" touch className="ml-auto" onClick={() => setBulk(true)}><PackagePlus className="mr-1.5 h-4 w-4" aria-hidden />Ship paid orders</Button>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <Loading label="Loading shipments…" />
      ) : rows.length === 0 ? (
        <Empty title="No shipments yet" text="Create a shipment from an order, or use Ship paid orders to do several at once." />
      ) : (
        <>
          <TableScroller label="Shipments">
            <table className="w-full text-sm">
              <thead className={THEAD}><tr><th scope="col" className={TH}>Tracking</th><th scope="col" className={TH}>Carrier</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Cost</th><th scope="col" className={TH}>Created</th></tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((s) => (
                  <tr key={s.id} className="hover:bg-secondary/30">
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => onSelect(s.id)} className="min-h-11 break-all rounded text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">{s.tracking_number ?? "(no tracking)"}</button>
                      {s.return_id && <span className="ml-2 text-xs text-muted-foreground">return</span>}
                    </td>
                    <td className="px-3 py-2">{[s.carrier, s.service].filter(Boolean).join(" ") || "-"}</td>
                    <td className="px-3 py-2"><StatusPill status={s.status} map={SHIPMENT_TONE} label={s.status_label} /></td>
                    <td className="px-3 py-2 tabular-nums">{s.rate_minor > 0 ? fmtMoney(s.rate_minor, s.currency) : "-"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtWhen(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
          {cursor && <div className="mt-3 text-center"><Button type="button" variant="outline" touch onClick={() => void loadMore()} disabled={more} aria-busy={more || undefined}>{more ? spinner : null}Load more</Button></div>}
        </>
      )}
      {selectedId && (
        <Drawer labelledBy="ship-drawer-title" onClose={() => onSelect(null)} header={<h2 id="ship-drawer-title" className="text-base font-semibold">Shipment</h2>}>
          {selected ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2"><StatusPill status={selected.status} map={SHIPMENT_TONE} label={selected.status_label} /><span className="break-all font-medium">{selected.tracking_number ?? "(no tracking)"}</span>{selected.tracking_url && <a href={selected.tracking_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline">Carrier <ExternalLink className="h-3 w-3" aria-hidden /></a>}</div>
              {selected.items.length > 0 && <p className="text-muted-foreground">{selected.items.map((i) => `${i.qty} × ${i.description}`).join(", ")}</p>}
              {selected.order_id ? <OrderShipping orderId={selected.order_id} orderStatus="paid" hasAddress currency={selected.currency} onNotice={(n) => { notify(n); void load(); }} /> : <p className="text-muted-foreground">Not linked to an order.</p>}
            </div>
          ) : (
            <Loading label="Loading shipment…" />
          )}
        </Drawer>
      )}
      {bulk && <BulkDialog onClose={() => setBulk(false)} onDone={(t) => { setBulk(false); notify(t); void load(); }} />}
    </div>
  );
}

interface PaidOrder { id: string; number: string; customer_name: string; shipping_address: unknown }

function BulkDialog({ onClose, onDone }: { onClose: () => void; onDone: (n: Notice) => void }) {
  const [orders, setOrders] = useState<PaidOrder[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [o, s] = await Promise.all([api<{ orders: PaidOrder[] }>("/api/orders?status=paid&limit=100"), api<{ shipments: ShipmentView[] }>("/api/shipping/shipments?limit=200")]);
        const shipped = new Set(s.shipments.filter((x) => x.status !== "void").map((x) => x.order_id));
        if (live) setOrders(o.orders.filter((x) => x.shipping_address && !shipped.has(x.id)));
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : "Could not load orders");
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else if (n.size < 50) n.add(id); return n; });

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ created: number; failed: number; results: Array<{ ok: boolean; error?: string }> }>("/api/shipping/shipments/bulk", { method: "POST", body: JSON.stringify({ order_ids: [...picked] }) });
      onDone({ tone: r.failed > 0 ? "error" : "success", text: `${r.created} shipment${r.created === 1 ? "" : "s"} created${r.failed ? `, ${r.failed} failed${r.results.find((x) => !x.ok)?.error ? `: ${r.results.find((x) => !x.ok)?.error}` : ""}` : ""}.` });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Bulk create failed");
      setBusy(false);
    }
  }

  return (
    <Dialog title="Ship paid orders" description="Creates a shipment (and buys a label) for each selected order, up to 50 at a time. The service the customer chose is used, else the cheapest." onClose={onClose} size="lg">
      {err && <Banner tone="error">{err}</Banner>}
      {!orders ? <Loading label="Loading orders…" /> : orders.length === 0 ? <Empty title="Nothing to ship" text="Paid orders with a shipping address and no shipment appear here." /> : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {orders.map((o) => (
            <li key={o.id} className="px-3 py-1"><Checkbox checked={picked.has(o.id)} onChange={() => toggle(o.id)} label={<span>{o.number} <span className="text-muted-foreground">· {o.customer_name}</span></span>} /></li>
          ))}
        </ul>
      )}
      <DialogFooter start={`${picked.size} selected`}>
        <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="button" touch onClick={() => void go()} disabled={busy || picked.size === 0} aria-busy={busy || undefined}>{busy ? spinner : null}Create shipments</Button>
      </DialogFooter>
    </Dialog>
  );
}
