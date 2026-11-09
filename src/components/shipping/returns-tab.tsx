"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api, fromMinor, toMinor } from "@/components/finance/shared";
import { fmtMoney } from "@/lib/money/format";
import { RETURN_STATUSES } from "@/lib/shipping/types";
import { RETURN_TONE, fmtWhen, type ReturnView, type ShipmentView } from "./shared";

type Notice = { tone: "success" | "error"; text: string };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

interface OrderInfo { refundable_minor: number }

export function ReturnsTab({ selectedId, onSelect, notify }: { selectedId: string | null; onSelect: (id: string | null) => void; notify: (n: Notice) => void }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<ReturnView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api<{ returns: ReturnView[] }>(`/api/shipping/returns?limit=100${status ? `&status=${status}` : ""}`)).returns);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load returns");
    }
  }, [status]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  return (
    <div>
      <label className="mb-3 block w-48 text-sm">
        <span className="mb-1 block text-xs text-muted-foreground">Status</span>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {RETURN_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </Select>
      </label>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !rows ? <Loading label="Loading returns…" /> : rows.length === 0 ? (
        <Empty title="No returns" text="Customers can request a return from their order page or portal; requests land here for review." />
      ) : (
        <TableScroller label="Return requests">
          <table className="w-full text-sm">
            <thead className={THEAD}><tr><th scope="col" className={TH}>Order</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Items</th><th scope="col" className={TH}>Resolution</th><th scope="col" className={TH}>Requested</th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-secondary/30">
                  <td className="px-3 py-2"><button type="button" onClick={() => onSelect(r.id)} className="min-h-11 rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">{r.order_number ?? r.order_id.slice(0, 8)}</button></td>
                  <td className="px-3 py-2"><StatusPill status={r.status} map={RETURN_TONE} /></td>
                  <td className="px-3 py-2 text-muted-foreground">{r.items.map((i) => `${i.qty} × ${i.description}`).join(", ")}</td>
                  <td className="px-3 py-2 capitalize">{r.resolution.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtWhen(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
      {selectedId && <ReturnDrawer id={selectedId} onClose={() => onSelect(null)} onChanged={() => void load()} notify={notify} />}
    </div>
  );
}

function ReturnDrawer({ id, onClose, onChanged, notify }: { id: string; onClose: () => void; onChanged: () => void; notify: (n: Notice) => void }) {
  const [ret, setRet] = useState<ReturnView | null>(null);
  const [ships, setShips] = useState<ShipmentView[]>([]);
  const [order, setOrder] = useState<(OrderInfo & { currency: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"reject" | "label" | "refund" | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ return: ReturnView; shipments: ShipmentView[] }>(`/api/shipping/returns/${id}`);
      setRet(r.return);
      setShips(r.shipments);
      const o = await api<OrderInfo & { returns: ReturnView[] }>(`/api/shipping/orders/${r.return.order_id}`);
      const suggested = o.returns.find((x) => x.id === id)?.suggested_refund_minor;
      setRet({ ...r.return, suggested_refund_minor: suggested });
      setOrder({ refundable_minor: o.refundable_minor, currency: r.shipments[0]?.currency ?? "USD" });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the return");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(action: string, extra: Record<string, unknown> = {}, ok: string) {
    setBusy(action);
    try {
      await api(`/api/shipping/returns/${id}`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      notify({ tone: "success", text: ok });
      onChanged();
      await load();
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Action failed" });
    } finally {
      setBusy(null);
    }
  }
  async function receive() {
    const restock = await confirmDialog({ title: "Mark received", body: "Put the returned items back into stock?", confirmLabel: "Receive and restock", cancelLabel: "Receive without restocking" });
    await post("receive", { restock }, restock ? "Received and restocked." : "Marked as received.");
  }

  return (
    <Drawer labelledBy="ret-drawer-title" onClose={onClose} header={<div className="flex items-center gap-3"><h2 id="ret-drawer-title" className="text-base font-semibold">{ret ? `Return · ${ret.order_number ?? ""}` : "Return"}</h2>{ret && <StatusPill status={ret.status} map={RETURN_TONE} className="ml-auto" />}</div>}
      footer={ret && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {ret.status === "requested" && <><Button type="button" variant="outline" touch onClick={() => setDlg("reject")} disabled={busy !== null}>Reject</Button><Button type="button" touch onClick={() => void post("approve", {}, "Return approved; the customer was emailed.")} disabled={busy !== null} aria-busy={busy === "approve" || undefined}>{busy === "approve" ? spinner : null}Approve</Button></>}
          {(ret.status === "approved" || ret.status === "label_sent") && <><Button type="button" variant="outline" touch onClick={() => setDlg("label")} disabled={busy !== null}>{ret.status === "label_sent" ? "Resend label" : "Send label / instructions"}</Button><Button type="button" touch onClick={() => void receive()} disabled={busy !== null} aria-busy={busy === "receive" || undefined}>Mark received</Button></>}
          {ret.status === "received" && <Button type="button" touch onClick={() => setDlg("refund")} disabled={busy !== null}>Resolve ({ret.resolution.replace(/_/g, " ")})</Button>}
          {(ret.status === "rejected" || ret.status === "refunded") && <Button type="button" variant="outline" touch onClick={() => void post("close", {}, "Return closed.")} disabled={busy !== null}>Close</Button>}
        </div>
      )}>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !ret ? <Loading label="Loading return…" /> : (
        <div className="space-y-4 text-sm">
          <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</h3><p className="whitespace-pre-wrap break-words">{ret.reason ?? "-"}</p></section>
          <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</h3><ul>{ret.items.map((i, k) => <li key={k}>{i.qty} × {i.description}</li>)}</ul></section>
          {ret.refund_minor > 0 && <p>Refunded {fmtMoney(ret.refund_minor, order?.currency ?? "USD")}.</p>}
          {ret.notes && <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3><p className="whitespace-pre-wrap break-words text-muted-foreground">{ret.notes}</p></section>}
          {ships.map((s) => <p key={s.id} className="text-muted-foreground">Return shipment: {s.status_label}{s.tracking_number ? ` · ${s.tracking_number}` : ""}</p>)}
        </div>
      )}
      {dlg === "reject" && <NoteDialog title="Reject return" label="Note to the customer (optional)" confirm="Reject" onClose={() => setDlg(null)} onSubmit={async (n) => { setDlg(null); await post("reject", { notes: n || undefined }, "Return rejected."); }} />}
      {dlg === "label" && <LabelDialog onClose={() => setDlg(null)} onSubmit={async (b) => { setDlg(null); await post("label", b, "Return label sent."); }} />}
      {dlg === "refund" && ret && order && <RefundDialog ret={ret} refundable={order.refundable_minor} currency={order.currency} onClose={() => setDlg(null)} onSubmit={async (b) => { setDlg(null); await post("refund", b, "Return resolved."); }} />}
    </Drawer>
  );
}

function NoteDialog({ title, label, confirm, onClose, onSubmit }: { title: string; label: string; confirm: string; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const [n, setN] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <Field label={label}><Textarea value={n} onChange={(e) => setN(e.target.value)} rows={3} maxLength={1000} /></Field>
      <DialogFooter><Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button><Button type="button" touch onClick={() => void onSubmit(n)}>{confirm}</Button></DialogFooter>
    </Dialog>
  );
}

function LabelDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: Record<string, unknown>) => Promise<void> }) {
  const [mode, setMode] = useState<"label" | "instructions">("label");
  const [text, setText] = useState("");
  return (
    <Dialog title="Send return label" description="A prepaid label spends carrier credit; instructions cost nothing." onClose={onClose}>
      <Field label="How?"><Select value={mode} onChange={(e) => setMode(e.target.value as "label" | "instructions")}><option value="label">Buy a return label</option><option value="instructions">Send instructions only</option></Select></Field>
      <Field label={mode === "instructions" ? "Instructions" : "Extra instructions (optional)"} className="mt-3"><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} /></Field>
      <DialogFooter><Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button><Button type="button" touch disabled={mode === "instructions" && !text.trim()} onClick={() => void onSubmit(mode === "instructions" ? { instructions: text } : { instructions: text || undefined })}>Send</Button></DialogFooter>
    </Dialog>
  );
}

function RefundDialog({ ret, refundable, currency, onClose, onSubmit }: { ret: ReturnView; refundable: number; currency: string; onClose: () => void; onSubmit: (b: Record<string, unknown>) => Promise<void> }) {
  const [resolution, setResolution] = useState(ret.resolution);
  const [amount, setAmount] = useState(fromMinor(Math.min(ret.suggested_refund_minor ?? 0, refundable)));
  const over = toMinor(amount) > refundable;
  return (
    <Dialog title="Resolve return" description={`At most ${fmtMoney(refundable, currency)} can still be refunded on this order.`} onClose={onClose}>
      <Field label="Resolution"><Select value={resolution} onChange={(e) => setResolution(e.target.value as ReturnView["resolution"])}><option value="refund">Refund to original payment</option><option value="store_credit">Store credit (recorded as a note)</option><option value="exchange">Exchange (no refund)</option></Select></Field>
      {resolution !== "exchange" && <Field label={`Amount (${currency})`} error={over ? "More than is refundable; it will be capped." : null} className="mt-3"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
      {resolution === "refund" && <Banner tone="info" className="mt-3">The refund goes through the payment provider and cannot be undone.</Banner>}
      <DialogFooter><Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button><Button type="button" touch onClick={() => void onSubmit({ resolution, ...(resolution === "exchange" ? {} : { amount_minor: Math.min(toMinor(amount), refundable) }) })}>Confirm</Button></DialogFooter>
    </Dialog>
  );
}

