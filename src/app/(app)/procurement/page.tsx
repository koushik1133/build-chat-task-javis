"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ban, Download, FileText, Loader2, PackageCheck, Pencil, Plus, RefreshCw, Send, ShoppingCart, Truck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { LoadMore } from "@/components/ui/load-more";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { BLANK_ITEM, LineItemsEditor, TotalsSummary, useDocTotals, useTaxRates, type LineItem } from "@/components/billing/shared";
import { SkeletonList } from "@/components/ui/feedback";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { api, Banner, Dialog, DialogFooter, Empty, Field, fromMinor, Loading, TabPanel, Tabs, toMinor } from "@/components/finance/shared";
import { AGING_BUCKET_LABELS, AGING_BUCKETS, type AgingBucket, type AgingRow, type BillStatus, type PoStatus, type ReorderGroup, type ReorderSuggestion } from "@/lib/procurement/pure";

/* ── types (mirror the lib DTOs; type-only, client safe) ─────────────────── */

interface Supplier {
  id: string; name: string; email: string | null; phone: string | null; tax_number: string | null; address: string | null;
  payment_terms_days: number; currency: string; notes: string | null; active: boolean; created_at: string;
}
interface PurchaseOrder {
  id: string; supplier_id: string; supplier_name: string | null; supplier_email: string | null; number: string; status: PoStatus; items: LineItem[];
  subtotal_minor: number; tax_minor: number; total_minor: number; currency: string; expected_at: string | null; notes: string | null; sent_at: string | null; received_at: string | null; created_at: string;
}
interface Progress { product_id: string; ordered: number; received: number }
interface Bill {
  id: string; supplier_id: string; supplier_name: string | null; purchase_order_id: string | null; po_number: string | null; number: string; supplier_ref: string | null; status: BillStatus;
  items: LineItem[]; subtotal_minor: number; tax_minor: number; total_minor: number; paid_minor: number; outstanding_minor: number; currency: string;
  issued_at: string | null; due_at: string | null; paid_at: string | null; overdue: boolean; notes: string | null; created_at: string;
}
interface Aging { as_of: string; rows: AgingRow[]; totals: Record<AgingBucket, number>; total_minor: number; currencies: string[] }
interface ProductLite { id: string; name: string; sku: string | null; cost_minor: number; last_cost_minor: number | null; currency: string; tax_rate_bp: number; track_stock: boolean }

type Tab = "orders" | "suppliers" | "bills" | "aging" | "reorder";
const TABS: Tab[] = ["orders", "suppliers", "bills", "aging", "reorder"];
const PO_TONE: Record<PoStatus, Tone> = { draft: "neutral", sent: "info", partially_received: "warning", received: "success", cancelled: "danger" };
const BILL_TONE: Record<BillStatus, Tone> = { draft: "neutral", open: "info", partially_paid: "warning", paid: "success", void: "danger" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

function StatusPill({ status, tone }: { status: string; tone: Tone }) {
  return (
    <Pill tone={tone} className="capitalize">
      {status.replace(/_/g, " ")}
    </Pill>
  );
}

export default function ProcurementPage() {
  return (
    <Suspense fallback={<PageSkeleton wide rows={5} label="Loading procurement…" />}>
      <ProcurementInner />
    </Suspense>
  );
}

function ProcurementInner() {
  const search = useSearchParams();
  const router = useRouter();
  const initialTab = search.get("tab");
  const [tab, setTabState] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : "orders");
  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      router.replace(t === "orders" ? "/procurement" : `/procurement?tab=${t}`, { scroll: false });
    },
    [router]
  );

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [billsCursor, setBillsCursor] = useState<string | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  const [reorder, setReorder] = useState<{ suggestions: ReorderSuggestion[]; groups: ReorderGroup[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [poStatus, setPoStatus] = useState("");
  const [billFilter, setBillFilter] = useState<"" | "open" | "overdue" | "paid">("");
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const nextSignal = useAbortable();

  const [editingPo, setEditingPo] = useState<PurchaseOrder | "new" | null>(null);
  const [receivingPo, setReceivingPo] = useState<PurchaseOrder | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | "new" | null>(null);
  const [billingPo, setBillingPo] = useState<PurchaseOrder | null>(null);
  const [payingBill, setPayingBill] = useState<Bill | null>(null);
  const [sendingPo, setSendingPo] = useState<PurchaseOrder | null>(null);
  const [cancellingPo, setCancellingPo] = useState<PurchaseOrder | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const billQs = billFilter === "overdue" ? "&overdue=1" : billFilter ? `&status=${billFilter}` : "";
      const [o, s, b, a, r] = await Promise.all([
        api<{ purchase_orders: PurchaseOrder[]; next_cursor: string | null }>(`/api/purchase-orders?limit=50${poStatus ? `&status=${poStatus}` : ""}`, { signal }),
        api<{ suppliers: Supplier[] }>(`/api/suppliers?inactive=1${query ? `&q=${encodeURIComponent(query)}` : ""}`, { signal }),
        api<{ bills: Bill[]; next_cursor: string | null }>(`/api/supplier-bills?limit=50${billQs}`, { signal }),
        api<{ aging: Aging }>("/api/reports/ap-aging", { signal }),
        api<{ suggestions: ReorderSuggestion[]; groups: ReorderGroup[] }>("/api/inventory/reorder", { signal }),
      ]);
      setOrders(o.purchase_orders);
      setOrdersCursor(o.next_cursor ?? null);
      setSuppliers(s.suppliers);
      setBills(b.bills);
      setBillsCursor(b.next_cursor ?? null);
      setAging(a.aging);
      setReorder(r);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load procurement.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal, poStatus, billFilter, query]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMoreOrders = useCallback(async () => {
    if (!ordersCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const o = await api<{ purchase_orders: PurchaseOrder[]; next_cursor: string | null }>(`/api/purchase-orders?limit=50&cursor=${encodeURIComponent(ordersCursor)}${poStatus ? `&status=${poStatus}` : ""}`);
      setOrders((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...o.purchase_orders.filter((x) => !seen.has(x.id))];
      });
      setOrdersCursor(o.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more orders.");
    } finally {
      setLoadingMore(false);
    }
  }, [ordersCursor, loadingMore, poStatus]);

  const loadMoreBills = useCallback(async () => {
    if (!billsCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const billQs = billFilter === "overdue" ? "&overdue=1" : billFilter ? `&status=${billFilter}` : "";
      const b = await api<{ bills: Bill[]; next_cursor: string | null }>(`/api/supplier-bills?limit=50&cursor=${encodeURIComponent(billsCursor)}${billQs}`);
      setBills((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...b.bills.filter((x) => !seen.has(x.id))];
      });
      setBillsCursor(b.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more bills.");
    } finally {
      setLoadingMore(false);
    }
  }, [billsCursor, loadingMore, billFilter]);

  const act = useCallback(
    async (id: string, fn: () => Promise<string | void>) => {
      setBusyId(id);
      setError(null);
      setNotice(null);
      try {
        const msg = await fn();
        if (msg) setNotice(msg);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn’t work. Try again.");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const saved = useCallback(
    (msg: string) => {
      setEditingPo(null);
      setReceivingPo(null);
      setEditingSupplier(null);
      setBillingPo(null);
      setPayingBill(null);
      setNotice(msg);
      void load();
    },
    [load]
  );

  const sendPo = useCallback(
    (po: PurchaseOrder, to: string | null) => {
      setSendingPo(null);
      void act(po.id, async () => {
        await api(`/api/purchase-orders/${po.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to ? { to } : {}) });
        return `${po.number} sent to ${to ?? po.supplier_email}.`;
      });
    },
    [act]
  );
  const onSend = useCallback((po: PurchaseOrder) => setSendingPo(po), []);
  const onCancel = useCallback((po: PurchaseOrder) => setCancellingPo(po), []);
  const cancelPo = useCallback(
    (po: PurchaseOrder) => {
      setCancellingPo(null);
      void act(po.id, async () => {
        await api(`/api/purchase-orders/${po.id}/cancel`, { method: "POST" });
        return `${po.number} cancelled.`;
      });
    },
    [act]
  );
  const onCreateReorderPos = useCallback(
    (productIds?: string[]) =>
      void act("reorder", async () => {
        const out = await api<{ purchase_orders: PurchaseOrder[]; skipped: ReorderSuggestion[] }>("/api/inventory/reorder", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(productIds ? { product_ids: productIds } : {}),
        });
        setTab("orders");
        const skipped = out.skipped.length ? ` ${out.skipped.length} product${out.skipped.length === 1 ? "" : "s"} skipped (no preferred supplier).` : "";
        return `${out.purchase_orders.length} draft purchase order${out.purchase_orders.length === 1 ? "" : "s"} created.${skipped}`;
      }),
    [act, setTab]
  );

  const openOrders = useMemo(() => orders.filter((o) => o.status === "sent" || o.status === "partially_received").length, [orders]);
  const overdueBills = useMemo(() => bills.filter((b) => b.overdue).length, [bills]);
  const activeSuppliers = useMemo(() => suppliers.filter((s) => s.active), [suppliers]);

  return (
    <PageContainer
      wide
      title="Procurement"
      description="Order from suppliers, receive goods into stock, and keep track of what you owe."
      tooltip="Purchase orders update stock and product cost when received. Bills are what suppliers charge you; payments flow into expenses and accounting."
      icon={<Truck className="h-5 w-5" aria-hidden />}
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          {tab === "suppliers" ? (
            <Button touch onClick={() => setEditingSupplier("new")}>
              <Plus className="h-4 w-4" aria-hidden /> New supplier
            </Button>
          ) : tab === "reorder" ? (
            <Button touch onClick={() => onCreateReorderPos()} disabled={!reorder || reorder.groups.every((g) => !g.supplier_id) || busyId === "reorder"}>
              {busyId === "reorder" ? spinner : <ShoppingCart className="h-4 w-4" aria-hidden />} Create POs
            </Button>
          ) : (
            <Button touch onClick={() => setEditingPo("new")} disabled={activeSuppliers.length === 0 && !loading}>
              <Plus className="h-4 w-4" aria-hidden /> New purchase order
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Tabs
          id="procurement"
          label="Procurement sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "orders", label: "Purchase orders", count: openOrders },
            { id: "suppliers", label: "Suppliers", count: activeSuppliers.length },
            { id: "bills", label: "Bills", count: overdueBills },
            { id: "aging", label: "AP aging" },
            { id: "reorder", label: "Reorder", count: reorder?.suggestions.length ?? 0 },
          ]}
        />
      </div>

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}
      {!loading && activeSuppliers.length === 0 && tab === "orders" && (
        <Banner tone="info">
          Add a supplier before raising purchase orders.{" "}
          <button type="button" className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setEditingSupplier("new")}>
            Add supplier
          </button>
        </Banner>
      )}

      {tab === "orders" && (
        <TabPanel id="procurement" value="orders">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Field label="Status" className="sm:w-56">
              <Select value={poStatus} onChange={(e) => setPoStatus(e.target.value)}>
                <option value="">All statuses</option>
                {(["draft", "sent", "partially_received", "received", "cancelled"] as PoStatus[]).map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </Select>
            </Field>
          </div>
          {loading && orders.length === 0 ? (
            <SkeletonList count={5} itemClassName="h-14" label="Loading purchase orders…" />
          ) : orders.length === 0 ? (
            <Empty
              icon={<FileText className="h-5 w-5" />}
              title={poStatus ? "No orders with that status" : "No purchase orders yet"}
              text={poStatus ? "Try another status." : "Raise an order to a supplier; receiving it updates stock and product cost."}
              action={poStatus ? <Button variant="outline" touch onClick={() => setPoStatus("")}>Clear filter</Button> : activeSuppliers.length > 0 ? <Button touch onClick={() => setEditingPo("new")}><Plus className="h-4 w-4" aria-hidden /> New purchase order</Button> : <Button touch onClick={() => setEditingSupplier("new")}><Plus className="h-4 w-4" aria-hidden /> Add a supplier</Button>}
            />
          ) : (
            <>
              <OrdersList orders={orders} busyId={busyId} onEdit={setEditingPo} onSend={onSend} onReceive={setReceivingPo} onCancel={onCancel} onBill={setBillingPo} />
              <LoadMore hasMore={Boolean(ordersCursor)} loading={loadingMore} count={orders.length} onMore={loadMoreOrders} noun="orders" />
            </>
          )}
        </TabPanel>
      )}

      {tab === "suppliers" && (
        <TabPanel id="procurement" value="suppliers">
          <div className="mb-4">
            <SearchField value={q} onChange={setQ} label="Search suppliers" placeholder="Search name or email" className="sm:max-w-xs" />
          </div>
          {loading && suppliers.length === 0 ? (
            <SkeletonList count={3} itemClassName="h-24 rounded-lg" label="Loading suppliers…" />
          ) : suppliers.length === 0 ? (
            <Empty
              icon={<Truck className="h-5 w-5" />}
              title={q ? "No suppliers match" : "No suppliers yet"}
              text={q ? "Try a different search." : "Suppliers are who you buy from. Set payment terms so bill due dates fill in automatically."}
              action={q ? <Button variant="outline" touch onClick={() => setQ("")}>Clear search</Button> : <Button touch onClick={() => setEditingSupplier("new")}><Plus className="h-4 w-4" aria-hidden /> Add a supplier</Button>}
            />
          ) : (
            <SuppliersList suppliers={suppliers} onEdit={setEditingSupplier} />
          )}
        </TabPanel>
      )}

      {tab === "bills" && (
        <TabPanel id="procurement" value="bills">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Field label="Show" className="sm:w-56">
              <Select value={billFilter} onChange={(e) => setBillFilter(e.target.value as typeof billFilter)}>
                <option value="">All bills</option>
                <option value="open">Open</option>
                <option value="overdue">Overdue</option>
                <option value="paid">Paid</option>
              </Select>
            </Field>
          </div>
          {loading && bills.length === 0 ? (
            <SkeletonList count={5} itemClassName="h-14" label="Loading bills…" />
          ) : bills.length === 0 ? (
            <Empty
              icon={<Wallet className="h-5 w-5" />}
              title={billFilter ? "No bills match" : "No supplier bills yet"}
              text={billFilter ? "Try another filter." : "Create a bill from a received purchase order, then record payments as you make them."}
              action={billFilter ? <Button variant="outline" touch onClick={() => setBillFilter("")}>Clear filter</Button> : <Button variant="outline" touch onClick={() => setTab("orders")}>Go to purchase orders</Button>}
            />
          ) : (
            <>
              <BillsList bills={bills} onPay={setPayingBill} />
              <LoadMore hasMore={Boolean(billsCursor)} loading={loadingMore} count={bills.length} onMore={loadMoreBills} noun="bills" />
            </>
          )}
        </TabPanel>
      )}

      {tab === "aging" && (
        <TabPanel id="procurement" value="aging">
          {loading && !aging ? <SkeletonList count={4} itemClassName="h-14" label="Loading aging…" /> : aging ? <AgingTable aging={aging} /> : null}
        </TabPanel>
      )}

      {tab === "reorder" && (
        <TabPanel id="procurement" value="reorder">
          {loading && !reorder ? (
            <SkeletonList count={3} itemClassName="h-24 rounded-lg" label="Checking stock levels…" />
          ) : !reorder || reorder.suggestions.length === 0 ? (
            <Empty icon={<PackageCheck className="h-5 w-5" />} title="Nothing to reorder" text="Every tracked product is above its reorder point." />
          ) : (
            <ReorderPanel groups={reorder.groups} busy={busyId === "reorder"} onCreate={onCreateReorderPos} />
          )}
        </TabPanel>
      )}

      {editingPo && <PurchaseOrderDialog po={editingPo === "new" ? null : editingPo} suppliers={activeSuppliers} onClose={() => setEditingPo(null)} onSaved={saved} />}
      {receivingPo && <ReceiveDialog po={receivingPo} onClose={() => setReceivingPo(null)} onSaved={saved} />}
      {editingSupplier && <SupplierDialog supplier={editingSupplier === "new" ? null : editingSupplier} onClose={() => setEditingSupplier(null)} onSaved={saved} />}
      {billingPo && <BillFromPoDialog po={billingPo} onClose={() => setBillingPo(null)} onSaved={saved} />}
      {payingBill && <PayBillDialog bill={payingBill} onClose={() => setPayingBill(null)} onSaved={saved} />}
      {sendingPo && <SendPoDialog po={sendingPo} onClose={() => setSendingPo(null)} onSend={sendPo} />}
      {cancellingPo && (
        <Dialog title={`Cancel ${cancellingPo.number}?`} description="The order is marked cancelled and can no longer be sent, received or billed. This cannot be undone." onClose={() => setCancellingPo(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={() => setCancellingPo(null)}>Keep order</Button>
            <Button type="button" variant="destructive" touch onClick={() => cancelPo(cancellingPo)}>Cancel order</Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

/* ── Purchase orders ─────────────────────────────────────────────────────── */

function SendPoDialog({ po, onClose, onSend }: { po: PurchaseOrder; onClose: () => void; onSend: (po: PurchaseOrder, to: string | null) => void }) {
  const [to, setTo] = useState("");
  const needsEmail = !po.supplier_email;
  return (
    <Dialog
      title={`Send ${po.number}`}
      description={needsEmail ? `${po.supplier_name ?? "This supplier"} has no email on file. Enter one to email the order, or mark it as sent without emailing.` : `Emails the purchase order PDF to ${po.supplier_email} and marks it as sent.`}
      onClose={onClose}
      size="sm"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(po, needsEmail ? to.trim() || null : null);
        }}
      >
        {needsEmail && (
          <Field label="Send to (email)" hint="Leave blank to mark as sent without emailing.">
            <Input type="email" inputMode="email" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} placeholder="orders@supplier.com" autoFocus />
          </Field>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch>
            <Send className="h-4 w-4" aria-hidden /> {needsEmail && !to.trim() ? "Mark as sent" : "Send"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

type PoHandlers = { onEdit: (po: PurchaseOrder) => void; onSend: (po: PurchaseOrder) => void; onReceive: (po: PurchaseOrder) => void; onCancel: (po: PurchaseOrder) => void; onBill: (po: PurchaseOrder) => void };

function PoActions({ po, busy, onEdit, onSend, onReceive, onCancel, onBill }: { po: PurchaseOrder; busy: boolean } & PoHandlers) {
  const canEdit = po.status === "draft" || po.status === "sent";
  const canReceive = po.status === "sent" || po.status === "partially_received";
  const canBill = po.status !== "draft" && po.status !== "cancelled";
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {busy && spinner}
      {po.status === "draft" && (
        <Button size="sm" touch onClick={() => onSend(po)} disabled={busy || po.items.length === 0}>
          <Send className="h-3.5 w-3.5" aria-hidden /> Send
        </Button>
      )}
      {canReceive && (
        <Button size="sm" touch onClick={() => onReceive(po)} disabled={busy}>
          <PackageCheck className="h-3.5 w-3.5" aria-hidden /> Receive
        </Button>
      )}
      {canBill && (
        <Button size="sm" variant="outline" touch onClick={() => onBill(po)} disabled={busy}>
          <Wallet className="h-3.5 w-3.5" aria-hidden /> Bill
        </Button>
      )}
      <Button size="icon" variant="ghost" touch onClick={() => onEdit(po)} aria-label={`${canEdit ? "Edit" : "View"} ${po.number}`} disabled={busy}>
        <Pencil className="h-4 w-4" aria-hidden />
      </Button>
      <Button asChild size="icon" variant="ghost" touch>
        <a href={`/api/purchase-orders/${po.id}/pdf`} target="_blank" rel="noreferrer" aria-label={`Download PDF for ${po.number}`}>
          <Download className="h-4 w-4" aria-hidden />
        </a>
      </Button>
      {canEdit && (
        <Button size="icon" variant="ghost" touch onClick={() => onCancel(po)} aria-label={`Cancel ${po.number}`} disabled={busy}>
          <Ban className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

function OrdersList({ orders, busyId, ...h }: { orders: PurchaseOrder[]; busyId: string | null } & PoHandlers) {
  return (
    <>
      <ul className="space-y-2 sm:hidden" aria-label="Purchase orders">
        {orders.map((po) => (
          <li key={po.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{po.number}</p>
                <p className="truncate text-sm text-muted-foreground">{po.supplier_name ?? "Unknown supplier"}</p>
              </div>
              <StatusPill status={po.status} tone={PO_TONE[po.status]} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Total</dt>
              <dd className="text-right tabular-nums text-foreground">{fmtMoney(po.total_minor, po.currency)}</dd>
              <dt>Expected</dt>
              <dd className="text-right">{po.expected_at ? fmtDate(po.expected_at) : "—"}</dd>
            </dl>
            <div className="mt-2">
              <PoActions po={po} busy={busyId === po.id} {...h} />
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <TableScroller label="Purchase orders">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>Order</th>
                <th scope="col" className={TH}>Supplier</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={cn(TH, "text-right")}>Total</th>
                <th scope="col" className={TH}>Expected</th>
                <th scope="col" className={TH}>Created</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((po) => (
                <tr key={po.id}>
                  <td className="px-3 py-2 font-medium">{po.number}</td>
                  <td className="px-3 py-2">{po.supplier_name ?? "—"}</td>
                  <td className="px-3 py-2"><StatusPill status={po.status} tone={PO_TONE[po.status]} /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(po.total_minor, po.currency)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{po.expected_at ? fmtDate(po.expected_at) : "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtDate(po.created_at)}</td>
                  <td className="px-3 py-2"><PoActions po={po} busy={busyId === po.id} {...h} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </div>
    </>
  );
}

function PurchaseOrderDialog({ po, suppliers, onClose, onSaved }: { po: PurchaseOrder | null; suppliers: Supplier[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const readOnly = Boolean(po && po.status !== "draft" && po.status !== "sent");
  const { rates, inclusive, rounding } = useTaxRates();
  const [supplierId, setSupplierId] = useState(po?.supplier_id ?? suppliers[0]?.id ?? "");
  const supplier = suppliers.find((s) => s.id === supplierId);
  const [currency, setCurrency] = useState(po?.currency ?? supplier?.currency ?? "USD");
  const [items, setItems] = useState<LineItem[]>(po?.items.length ? po.items : [{ ...BLANK_ITEM }]);
  const [expected, setExpected] = useState(po?.expected_at ? po.expected_at.slice(0, 10) : "");
  const [notes, setNotes] = useState(po?.notes ?? "");
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const totals = useDocTotals(items, rates, useMemo(() => ({ inclusive, rounding }), [inclusive, rounding]));

  useEffect(() => {
    api<{ products: ProductLite[] }>("/api/products?limit=500")
      .then((d) => setProducts(d.products))
      .catch(() => setProducts([]));
  }, []);
  useEffect(() => {
    if (!po && supplier) setCurrency(supplier.currency);
  }, [supplier, po]);

  const addProduct = (id: string) => {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    const cost = p.last_cost_minor ?? p.cost_minor;
    const line: LineItem = { description: p.sku ? `${p.name} (${p.sku})` : p.name, qty: 1, unit_minor: cost, tax_rate_bp: 0, product_id: p.id };
    setItems((prev) => (prev.length === 1 && !prev[0].description && prev[0].unit_minor === 0 ? [line] : [...prev, line]));
    setPick("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const clean = items.filter((it) => it.description.trim());
      if (!supplierId) throw new Error("Choose a supplier");
      const body = { supplier_id: supplierId, currency, items: clean, expected_at: expected ? new Date(`${expected}T12:00:00`).toISOString() : null, notes: notes.trim() || null };
      if (po) await api(`/api/purchase-orders/${po.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      else await api("/api/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      onSaved(po ? `${po.number} updated.` : "Draft purchase order created.");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save the purchase order.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={po ? `${readOnly ? "" : "Edit "}${po.number}` : "New purchase order"} description={readOnly ? "This order can no longer be edited." : "Unit amounts are what the supplier charges you."} onClose={onClose} size="xl">
      <form onSubmit={submit} className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Supplier" required className="sm:col-span-2">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={readOnly} required>
              <option value="">Choose a supplier</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} disabled={readOnly} />
          </Field>
          <Field label="Expected by">
            <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} disabled={readOnly} />
          </Field>
          {!readOnly && (
            <Field label="Add from pricebook" hint="Linked lines update stock and cost when received." className="sm:col-span-2">
              <Select value={pick} onChange={(e) => addProduct(e.target.value)}>
                <option value="">Pick a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ""}{p.track_stock ? "" : " — not tracked"}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {readOnly ? (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">{it.description}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{it.qty} × {fmtMoney(it.unit_minor, currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <LineItemsEditor items={items} onChange={setItems} rates={rates} currency={currency} unitLabel="Unit cost" />
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <Field label="Notes" className="sm:flex-1">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} placeholder="Delivery instructions, references…" />
          </Field>
          <TotalsSummary totals={totals} currency={currency} inclusive={inclusive} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {!readOnly && (
            <Button type="submit" touch disabled={saving}>
              {saving && spinner} {po ? "Save changes" : "Create draft"}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function ReceiveDialog({ po, onClose, onSaved }: { po: PurchaseOrder; onClose: () => void; onSaved: (msg: string) => void }) {
  const [progress, setProgress] = useState<Progress[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of po.items) if (it.product_id && !m.has(it.product_id)) m.set(it.product_id, it.description);
    return m;
  }, [po.items]);

  useEffect(() => {
    api<{ progress: Progress[] }>(`/api/purchase-orders/${po.id}`)
      .then((d) => {
        setProgress(d.progress);
        const init: Record<string, string> = {};
        for (const p of d.progress) init[p.product_id] = String(Math.max(p.ordered - p.received, 0));
        setQty(init);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not load the order."));
  }, [po.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const lines = Object.entries(qty)
        .map(([product_id, v]) => ({ product_id, qty: Math.trunc(Number(v) || 0) }))
        .filter((l) => l.qty > 0);
      if (lines.length === 0) throw new Error("Enter a quantity for at least one line");
      await api(`/api/purchase-orders/${po.id}/receive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines, note: note.trim() || null }) });
      onSaved(`Receipt recorded on ${po.number}. Stock and product costs updated.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not record the receipt.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Receive ${po.number}`} description="Enter what arrived. Quantities default to what is still outstanding." onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        {!progress ? (
          <Loading label="Loading outstanding quantities…" />
        ) : progress.length === 0 ? (
          <Banner tone="warn">No lines on this order are linked to a product, so nothing can be received into stock.</Banner>
        ) : (
          <ul className="space-y-2" aria-label="Lines to receive">
            {progress.map((p) => {
              const remaining = Math.max(p.ordered - p.received, 0);
              return (
                <li key={p.product_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{nameOf.get(p.product_id) ?? p.product_id}</p>
                    <p className="text-xs text-muted-foreground">Ordered {p.ordered} · received {p.received} · {remaining} outstanding</p>
                  </div>
                  <Field label="Qty now" className="w-24">
                    <Input type="number" inputMode="numeric" min={0} max={remaining} value={qty[p.product_id] ?? ""} onChange={(e) => setQty((prev) => ({ ...prev, [p.product_id]: e.target.value }))} disabled={remaining === 0} />
                  </Field>
                </li>
              );
            })}
          </ul>
        )}
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery note number, condition…" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={saving || !progress || progress.length === 0}>
            {saving && spinner} Record receipt
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function BillFromPoDialog({ po, onClose, onSaved }: { po: PurchaseOrder; onClose: () => void; onSaved: (msg: string) => void }) {
  const [ref, setRef] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const out = await api<{ bill: Bill }>("/api/supplier-bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_purchase_order_id: po.id, supplier_ref: ref.trim() || null, due_at: due ? new Date(`${due}T12:00:00`).toISOString() : null }),
      });
      onSaved(`Bill ${out.bill.number} created for ${po.number}.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the bill.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title={`Bill ${po.number}`} description={`Creates an open bill for ${fmtMoney(po.total_minor, po.currency)} from ${po.supplier_name ?? "the supplier"}. If one already exists it is reused.`} onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        <Field label="Supplier invoice number" hint="Their reference, printed on the bill.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Due date" hint="Leave blank to use the supplier’s payment terms.">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={saving}>{saving && spinner} Create bill</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ── Suppliers ───────────────────────────────────────────────────────────── */

function SuppliersList({ suppliers, onEdit }: { suppliers: Supplier[]; onEdit: (s: Supplier) => void }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {suppliers.map((s) => (
        <li key={s.id} className={cn("rounded-lg border border-border p-3", !s.active && "opacity-60")}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{s.name}</p>
              <p className="truncate text-sm text-muted-foreground">{s.email ?? s.phone ?? "No contact details"}</p>
            </div>
            <Button size="icon" variant="ghost" touch onClick={() => onEdit(s)} aria-label={`Edit ${s.name}`}>
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone="neutral">Net {s.payment_terms_days}</Pill>
            <Pill tone="neutral">{s.currency}</Pill>
            {!s.active && <Pill tone="warning">Inactive</Pill>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    email: supplier?.email ?? "",
    phone: supplier?.phone ?? "",
    tax_number: supplier?.tax_number ?? "",
    address: supplier?.address && !supplier.address.startsWith("{") ? supplier.address : supplier?.address ? prettyAddress(supplier.address) : "",
    payment_terms_days: String(supplier?.payment_terms_days ?? 30),
    currency: supplier?.currency ?? "USD",
    notes: supplier?.notes ?? "",
    active: supplier?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const body = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        tax_number: form.tax_number.trim() || null,
        address: form.address.trim() || null,
        payment_terms_days: Math.max(0, Math.min(365, Math.trunc(Number(form.payment_terms_days) || 0))),
        currency: form.currency.trim().toUpperCase(),
        notes: form.notes.trim() || null,
        active: form.active,
      };
      if (supplier) await api(`/api/suppliers/${supplier.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      else await api("/api/suppliers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      onSaved(supplier ? `${body.name} updated.` : `${body.name} added.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save the supplier.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={supplier ? `Edit ${supplier.name}` : "New supplier"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
          </Field>
          <Field label="Email" hint="Purchase orders are sent here.">
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Payment terms (days)">
            <Input type="number" inputMode="numeric" min={0} max={365} value={form.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Tax number">
            <Input value={form.tax_number} onChange={(e) => set("tax_number", e.target.value)} maxLength={64} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea rows={2} value={form.address} onChange={(e) => set("address", e.target.value)} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Checkbox checked={form.active} onChange={(e) => set("active", e.target.checked)} label="Active (available for new orders)" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={saving}>{saving && spinner} {supplier ? "Save changes" : "Add supplier"}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function prettyAddress(json: string): string {
  try {
    const o = JSON.parse(json) as Record<string, string | undefined>;
    return [o.line1, o.line2, [o.city, o.region, o.postal_code].filter(Boolean).join(", "), o.country].filter(Boolean).join("\n");
  } catch {
    return json;
  }
}

/* ── Bills ───────────────────────────────────────────────────────────────── */

function BillsList({ bills, onPay }: { bills: Bill[]; onPay: (b: Bill) => void }) {
  const payable = (b: Bill) => b.status === "open" || b.status === "partially_paid";
  return (
    <>
      <ul className="space-y-2 sm:hidden" aria-label="Supplier bills">
        {bills.map((b) => (
          <li key={b.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{b.number}{b.supplier_ref ? <span className="text-muted-foreground"> · {b.supplier_ref}</span> : null}</p>
                <p className="truncate text-sm text-muted-foreground">{b.supplier_name ?? "Unknown supplier"}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusPill status={b.status} tone={BILL_TONE[b.status]} />
                {b.overdue && <Pill tone="danger">Overdue</Pill>}
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Outstanding</dt>
              <dd className="text-right tabular-nums text-foreground">{fmtMoney(b.outstanding_minor, b.currency)}</dd>
              <dt>Due</dt>
              <dd className={cn("text-right", b.overdue && "font-medium text-red-700 dark:text-red-300")}>{b.due_at ? fmtDate(b.due_at) : "—"}</dd>
            </dl>
            <div className="mt-2 flex justify-end gap-1">
              <Button asChild size="icon" variant="ghost" touch>
                <a href={`/api/supplier-bills/${b.id}/pdf`} target="_blank" rel="noreferrer" aria-label={`Download PDF for ${b.number}`}><Download className="h-4 w-4" aria-hidden /></a>
              </Button>
              {payable(b) && <Button size="sm" touch onClick={() => onPay(b)}><Wallet className="h-3.5 w-3.5" aria-hidden /> Record payment</Button>}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <TableScroller label="Supplier bills">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>Bill</th>
                <th scope="col" className={TH}>Supplier</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={cn(TH, "text-right")}>Total</th>
                <th scope="col" className={cn(TH, "text-right")}>Outstanding</th>
                <th scope="col" className={TH}>Due</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bills.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{b.number}</span>
                    {b.supplier_ref && <span className="text-muted-foreground"> · {b.supplier_ref}</span>}
                    {b.po_number && <span className="block text-xs text-muted-foreground">{b.po_number}</span>}
                  </td>
                  <td className="px-3 py-2">{b.supplier_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <StatusPill status={b.status} tone={BILL_TONE[b.status]} />
                      {b.overdue && <Pill tone="danger">Overdue</Pill>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(b.total_minor, b.currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(b.outstanding_minor, b.currency)}</td>
                  <td className={cn("px-3 py-2 text-muted-foreground", b.overdue && "font-medium text-red-700 dark:text-red-300")}>{b.due_at ? fmtDate(b.due_at) : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild size="icon" variant="ghost" touch>
                        <a href={`/api/supplier-bills/${b.id}/pdf`} target="_blank" rel="noreferrer" aria-label={`Download PDF for ${b.number}`}><Download className="h-4 w-4" aria-hidden /></a>
                      </Button>
                      {payable(b) && <Button size="sm" touch onClick={() => onPay(b)}><Wallet className="h-3.5 w-3.5" aria-hidden /> Record payment</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </div>
    </>
  );
}

function PayBillDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: (msg: string) => void }) {
  const [amount, setAmount] = useState(fromMinor(bill.outstanding_minor));
  const [method, setMethod] = useState("bank");
  const [ref, setRef] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const minor = toMinor(amount);
      if (minor <= 0) throw new Error("Enter an amount greater than zero");
      if (minor > bill.outstanding_minor) throw new Error(`Amount exceeds the outstanding balance of ${fmtMoney(bill.outstanding_minor, bill.currency)}`);
      const out = await api<{ bill: Bill }>(`/api/supplier-bills/${bill.id}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_minor: minor, method, ref: ref.trim() || null, note: note.trim() || null, paid_at: new Date(`${paidAt}T12:00:00`).toISOString() }),
      });
      onSaved(out.bill.status === "paid" ? `${bill.number} is paid in full.` : `Payment recorded on ${bill.number}; ${fmtMoney(out.bill.outstanding_minor, bill.currency)} still outstanding.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not record the payment.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title={`Pay ${bill.number}`} description={`${fmtMoney(bill.outstanding_minor, bill.currency)} outstanding to ${bill.supplier_name ?? "the supplier"}. The payment is logged as a purchases expense.`} onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Amount (${bill.currency})`} required>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Paid on">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="bank">Bank transfer</option>
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Reference">
            <Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Note" className="sm:col-span-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={saving}>{saving && spinner} Record payment</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ── AP aging ────────────────────────────────────────────────────────────── */

function AgingTable({ aging }: { aging: Aging }) {
  if (aging.rows.length === 0) return <Empty icon={<Wallet className="h-5 w-5" />} title="Nothing outstanding" text="No open supplier bills — your payables are clear." />;
  const cur = aging.currencies[0] ?? "USD";
  const mixed = aging.currencies.length > 1;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <div key={b} className={cn("rounded-lg border border-border p-3", b !== "current" && aging.totals[b] > 0 && "border-amber-500/40 bg-amber-500/5")}>
            <p className="text-xs text-muted-foreground">{AGING_BUCKET_LABELS[b]}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(aging.totals[b], cur)}</p>
          </div>
        ))}
      </div>
      {mixed && (
        <Banner tone="warn">Bills are in more than one currency ({aging.currencies.join(", ")}); the totals above add them without conversion.</Banner>
      )}
      <TableScroller label="Aging by supplier">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>Supplier</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} scope="col" className={cn(TH, "text-right")}>{AGING_BUCKET_LABELS[b]}</th>
              ))}
              <th scope="col" className={cn(TH, "text-right")}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {aging.rows.map((r) => (
              <tr key={`${r.supplier_id}:${r.currency}`}>
                <td className="px-3 py-2">
                  <span className="font-medium">{r.supplier_name}</span>
                  <span className="block text-xs text-muted-foreground">{r.bills} bill{r.bills === 1 ? "" : "s"} · {r.currency}</span>
                </td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className={cn("px-3 py-2 text-right tabular-nums", r.buckets[b] === 0 && "text-muted-foreground")}>{r.buckets[b] === 0 ? "—" : fmtMoney(r.buckets[b], r.currency)}</td>
                ))}
                <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtMoney(r.total_minor, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <p className="text-xs text-muted-foreground">As of <time dateTime={aging.as_of}>{new Date(aging.as_of).toLocaleString()}</time>.</p>
    </div>
  );
}

/* ── Reorder ─────────────────────────────────────────────────────────────── */

function ReorderPanel({ groups, busy, onCreate }: { groups: ReorderGroup[]; busy: boolean; onCreate: (productIds?: string[]) => void }) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={`${g.supplier_id ?? "none"}:${g.currency}`} className="rounded-lg border border-border" aria-label={g.supplier_name ?? "No preferred supplier"}>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <p className="font-medium">{g.supplier_name ?? "No preferred supplier"}</p>
              <p className="text-xs text-muted-foreground">{g.lines.length} product{g.lines.length === 1 ? "" : "s"} · est. {fmtMoney(g.total_minor, g.currency)}</p>
            </div>
            {g.supplier_id ? (
              <Button size="sm" touch onClick={() => onCreate(g.lines.map((l) => l.product_id))} disabled={busy}>
                {busy ? spinner : <ShoppingCart className="h-3.5 w-3.5" aria-hidden />} Create PO
              </Button>
            ) : (
              <Pill tone="warning">Set a preferred supplier on these products in Inventory</Pill>
            )}
          </header>
          <ul className="divide-y divide-border text-sm">
            {g.lines.map((l) => (
              <li key={l.product_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.name}{l.sku ? <span className="text-muted-foreground"> · {l.sku}</span> : null}</p>
                  <p className="text-xs text-muted-foreground">{l.stock_available} available · reorder at {l.reorder_point}</p>
                </div>
                <p className="tabular-nums text-muted-foreground">
                  Order <span className="font-medium text-foreground">{l.suggested_qty}</span> × {fmtMoney(l.unit_cost_minor, l.currency)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
