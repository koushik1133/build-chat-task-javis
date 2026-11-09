"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Copy, ExternalLink, Loader2, PackageCheck, RefreshCw, ShoppingCart, Store, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { LoadMore, usePagedList } from "@/components/ui/load-more";
import { useDebouncedValue } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { AttachmentPanel } from "@/components/attachments/attachment-panel";
import { api, fromMinor, toMinor } from "@/components/finance/shared";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { ORDER_STATUS_LABEL, ORDER_STATUSES, formatAddress, type OrderStatus } from "@/lib/storefront/pure";
import type { OrderDTO } from "@/lib/storefront/orders";
import type { StorefrontDTO } from "@/lib/storefront/settings";
import type { StorefrontProductDTO } from "@/lib/storefront/catalog";

type Tab = "orders" | "storefront";
type Filter = "all" | OrderStatus;

const STATUS_TONE: Record<OrderStatus, Tone> = { pending_payment: "warning", paid: "success", fulfilled: "info", cancelled: "neutral", refunded: "violet" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
type Notice = { tone: "success" | "error"; text: string };

interface OrderDetail {
  order: OrderDTO;
  invoice: { id: string; number: string; status: string; total_minor: number; paid_minor: number } | null;
  payments: Array<{ id: string; provider: string; provider_ref: string | null; amount_minor: number; refunded_minor: number; status: string; created_at: string }>;
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Orders & storefront"><Loading label="Loading orders…" /></PageContainer>}>
      <OrdersInner />
    </Suspense>
  );
}

function OrdersInner() {
  const router = useRouter();
  const search = useSearchParams();
  const tab: Tab = search.get("tab") === "storefront" ? "storefront" : "orders";
  const selectedId = search.get("order");
  const [notice, setNotice] = useState<Notice | null>(null);

  const setTab = (t: Tab) => {
    const sp = new URLSearchParams(search.toString());
    if (t === "orders") sp.delete("tab");
    else sp.set("tab", t);
    sp.delete("order");
    router.replace(`/orders${sp.toString() ? `?${sp}` : ""}`);
  };
  const select = (id: string | null) => {
    const sp = new URLSearchParams(search.toString());
    if (id) sp.set("order", id);
    else sp.delete("order");
    router.replace(`/orders${sp.toString() ? `?${sp}` : ""}`);
  };

  return (
    <PageContainer wide title="Orders & storefront" description="Sell from your pricebook on a public shop page; orders become invoices and reserve stock until they are paid." icon={<ShoppingCart className="h-5 w-5" aria-hidden />}>
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">{notice.text}</Banner>}
      <Tabs id="orders-tabs" label="Orders and storefront" value={tab} onChange={setTab} className="mb-4 w-fit" tabs={[{ id: "orders", label: "Orders" }, { id: "storefront", label: "Storefront" }]} />
      <TabPanel id="orders-tabs" value="orders" className={cn(tab !== "orders" && "hidden")}>
        {tab === "orders" && <OrdersTab selectedId={selectedId} onSelect={select} notify={setNotice} />}
      </TabPanel>
      <TabPanel id="orders-tabs" value="storefront" className={cn(tab !== "storefront" && "hidden")}>
        {tab === "storefront" && <StorefrontTab notify={setNotice} />}
      </TabPanel>
    </PageContainer>
  );
}

/* ───────────────────────────── Orders tab ───────────────────────────── */

function OrdersTab({ selectedId, onSelect, notify }: { selectedId: string | null; onSelect: (id: string | null) => void; notify: (n: Notice) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const [counts, setCounts] = useState<Record<OrderStatus, number> | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const sp = new URLSearchParams();
      if (filter !== "all") sp.set("status", filter);
      if (query) sp.set("q", query);
      if (cursor) sp.set("cursor", cursor);
      const res = await api<{ orders: OrderDTO[]; next_cursor: string | null; counts: Record<OrderStatus, number> | null }>(`/api/orders?${sp}`);
      if (res.counts) setCounts(res.counts);
      return { rows: res.orders, next_cursor: res.next_cursor };
    },
    [filter, query]
  );
  const list = usePagedList<OrderDTO>(fetchPage);
  const { reload } = list;
  useEffect(() => {
    void reload();
  }, [reload]);

  const total = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : null;
  const filters: Array<{ id: Filter; label: string; n: number | null }> = [
    { id: "all", label: "All", n: total },
    ...ORDER_STATUSES.map((s) => ({ id: s as Filter, label: ORDER_STATUS_LABEL[s], n: counts?.[s] ?? null })),
  ];

  const onChanged = (o: OrderDTO) => {
    list.setRows((rows) => rows.map((r) => (r.id === o.id ? o : r)));
    void reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn("inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === f.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-secondary/60")}
            >
              {f.label}
              {f.n !== null && <span className="tabular-nums opacity-70">{f.n}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SearchField value={q} onChange={setQ} label="Search orders" placeholder="Order #, name or email" className="w-full sm:w-64" />
          <Button type="button" variant="outline" size="icon" aria-label="Refresh" onClick={() => void reload()}><RefreshCw className="h-4 w-4" aria-hidden /></Button>
        </div>
      </div>

      {list.loading ? (
        <Loading label="Loading orders…" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={() => void reload()} />
      ) : list.rows.length === 0 ? (
        <Empty icon={<ShoppingCart className="h-6 w-6" aria-hidden />} title={total === 0 ? "No orders yet" : "No orders match"} text={total === 0 ? "Enable your storefront and share the link to start taking orders." : "Try another status or search."} />
      ) : (
        <>
          <TableScroller label="Orders">
            <table className="w-full min-w-[720px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Order</th>
                  <th className={TH}>Customer</th>
                  <th className={TH}>Status</th>
                  <th className={cn(TH, "text-right")}>Total</th>
                  <th className={TH}>Delivery</th>
                  <th className={TH}>Placed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.rows.map((o) => (
                  <tr key={o.id} className={cn("cursor-pointer hover:bg-secondary/40", selectedId === o.id && "bg-secondary/50")} onClick={() => onSelect(o.id)}>
                    <td className="px-3 py-2">
                      <button type="button" className="font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(e) => { e.stopPropagation(); onSelect(o.id); }}>
                        {o.number}
                      </button>
                      <p className="text-xs text-muted-foreground">{o.items.length} line{o.items.length === 1 ? "" : "s"}</p>
                    </td>
                    <td className="px-3 py-2">
                      <p className="truncate">{o.customer_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{o.customer_email}</p>
                    </td>
                    <td className="px-3 py-2"><StatusPill status={o.status} map={STATUS_TONE} label={ORDER_STATUS_LABEL[o.status]} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(o.total_minor, o.currency)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{o.shipping_address ? "Ship" : "Pickup"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
          <LoadMore hasMore={Boolean(list.cursor)} loading={list.loadingMore} count={list.rows.length} onMore={() => void list.more()} noun="orders" />
        </>
      )}

      {selectedId && <OrderDrawer id={selectedId} onClose={() => onSelect(null)} onChanged={onChanged} notify={notify} />}
    </div>
  );
}

function OrderDrawer({ id, onClose, onChanged, notify }: { id: string; onClose: () => void; onChanged: (o: OrderDTO) => void; notify: (n: Notice) => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<OrderDetail>(`/api/orders/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the order.");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function fulfil() {
    setBusy("fulfil");
    try {
      const r = await api<{ order: OrderDTO }>(`/api/orders/${id}`, { method: "PATCH", body: JSON.stringify({ status: "fulfilled" }) });
      onChanged(r.order);
      notify({ tone: "success", text: `Order ${r.order.number} fulfilled; the customer has been emailed.` });
      await load();
    } catch (err) {
      notify({ tone: "error", text: err instanceof Error ? err.message : "Could not fulfil the order." });
    } finally {
      setBusy(null);
    }
  }

  const o = detail?.order;
  const refundable = detail ? detail.payments.filter((p) => p.status === "succeeded").reduce((s, p) => s + p.amount_minor - p.refunded_minor, 0) : 0;

  return (
    <Drawer labelledBy="order-drawer-title" onClose={onClose} header={
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <h2 id="order-drawer-title" className="truncate text-base font-semibold">{o ? `Order ${o.number}` : "Order"}</h2>
          {o && <p className="text-xs text-muted-foreground">Placed {fmtDate(o.created_at)}</p>}
        </div>
        {o && <StatusPill status={o.status} map={STATUS_TONE} label={ORDER_STATUS_LABEL[o.status]} className="ml-auto" />}
      </div>
    }
    footer={o && (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {(o.status === "pending_payment" || o.status === "paid" || o.status === "fulfilled") && (
          <Button type="button" variant="outline" onClick={() => setCancelOpen(true)} disabled={busy !== null}><XCircle className="mr-1.5 h-4 w-4" aria-hidden />{o.status === "pending_payment" ? "Cancel" : "Cancel & refund"}</Button>
        )}
        {(o.status === "paid" || o.status === "fulfilled") && refundable > 0 && (
          <Button type="button" variant="outline" onClick={() => setRefundOpen(true)} disabled={busy !== null}><Undo2 className="mr-1.5 h-4 w-4" aria-hidden />Refund</Button>
        )}
        {o.status === "paid" && (
          <Button type="button" onClick={() => void fulfil()} disabled={busy !== null}>{busy === "fulfil" ? spinner : <PackageCheck className="mr-1.5 h-4 w-4" aria-hidden />}Mark fulfilled</Button>
        )}
      </div>
    )}>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !detail || !o ? (
        <Loading label="Loading order…" />
      ) : (
        <div className="space-y-6 text-sm">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {o.items.map((it, i) => (
                <li key={i} className="flex justify-between gap-3 px-3 py-2">
                  <span>{it.qty} × {it.description}</span>
                  <span className="tabular-nums">{fmtMoney(Math.round(it.qty * it.unit_minor), o.currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-2 space-y-1">
              <Row k="Subtotal" v={fmtMoney(o.subtotal_minor, o.currency)} />
              <Row k="Tax" v={fmtMoney(o.tax_minor, o.currency)} />
              {o.shipping_minor > 0 && <Row k="Shipping" v={fmtMoney(o.shipping_minor, o.currency)} />}
              <Row k="Total" v={fmtMoney(o.total_minor, o.currency)} strong />
            </dl>
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer</h3>
              <p className="font-medium">{o.customer_name}</p>
              <p><a href={`mailto:${o.customer_email}`} className="text-primary underline-offset-4 hover:underline">{o.customer_email}</a></p>
              {o.customer_phone && <p className="text-muted-foreground">{o.customer_phone}</p>}
              {o.contact_id && <Link href={`/crm?contact=${o.contact_id}`} className="mt-1 inline-block text-xs text-primary underline-offset-4 hover:underline">Open contact</Link>}
              <p className="mt-2 text-xs text-muted-foreground">Marketing consent: {o.consent_marketing ? "yes" : "no"}</p>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery</h3>
              <p>{o.shipping_address ? formatAddress(o.shipping_address) : "Collection in person"}</p>
              {o.notes && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{o.notes}</p>}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment</h3>
            {detail.invoice ? (
              <p>
                Invoice <Link href="/billing" className="font-medium text-primary underline-offset-4 hover:underline">{detail.invoice.number}</Link> · <StatusPill status={detail.invoice.status} /> · paid {fmtMoney(detail.invoice.paid_minor, o.currency)} of {fmtMoney(detail.invoice.total_minor, o.currency)}
              </p>
            ) : (
              <p className="text-muted-foreground">No invoice linked.</p>
            )}
            {detail.payments.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {detail.payments.map((p) => (
                  <li key={p.id}>{fmtDate(p.created_at)} · {p.provider} · {fmtMoney(p.amount_minor, o.currency)} · {p.status}{p.refunded_minor > 0 ? ` · refunded ${fmtMoney(p.refunded_minor, o.currency)}` : ""}</li>
                ))}
              </ul>
            )}
            {o.payment_ref && <p className="mt-1 text-xs text-muted-foreground">Ref {o.payment_ref}</p>}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</h3>
            <AttachmentPanel entityKind="order" entityId={o.id} compact />
          </section>
        </div>
      )}
      {cancelOpen && o && <CancelDialog order={o} onClose={() => setCancelOpen(false)} onDone={(x) => { setCancelOpen(false); onChanged(x); void load(); }} notify={notify} />}
      {refundOpen && o && <RefundDialog order={o} refundable={refundable} onClose={() => setRefundOpen(false)} onDone={(x) => { setRefundOpen(false); onChanged(x); void load(); }} notify={notify} />}
    </Drawer>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-4", strong && "border-t border-border pt-1 font-semibold")}>
      <dt className={cn(!strong && "text-muted-foreground")}>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}

function CancelDialog({ order, onClose, onDone, notify }: { order: OrderDTO; onClose: () => void; onDone: (o: OrderDTO) => void; notify: (n: Notice) => void }) {
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const paid = order.status !== "pending_payment";
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ order: OrderDTO; refunded_minor: number; released: number }>(`/api/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", reason: reason || null, restock: paid ? restock : undefined }) });
      notify({ tone: "success", text: paid ? `Order ${order.number} cancelled and ${fmtMoney(r.refunded_minor, order.currency)} refunded.` : `Order ${order.number} cancelled; reserved stock released.` });
      onDone(r.order);
    } catch (err) {
      notify({ tone: "error", text: err instanceof Error ? err.message : "Could not cancel the order." });
      setBusy(false);
    }
  }
  return (
    <Dialog title={paid ? `Cancel and refund ${order.number}?` : `Cancel ${order.number}?`} description={paid ? "Every payment on the linked invoice is refunded through its provider." : "The stock reservation is released and the invoice is voided."} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Reason (optional)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} /></Field>
        {paid && <Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} label="Return the goods to stock" />}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Keep order</Button>
        <Button type="button" variant="destructive" onClick={() => void go()} disabled={busy}>{busy ? spinner : null}{paid ? "Cancel & refund" : "Cancel order"}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function RefundDialog({ order, refundable, onClose, onDone, notify }: { order: OrderDTO; refundable: number; onClose: () => void; onDone: (o: OrderDTO) => void; notify: (n: Notice) => void }) {
  const [amount, setAmount] = useState(fromMinor(refundable));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const minor = toMinor(amount);
      const r = await api<{ order: OrderDTO; refunded_minor: number }>(`/api/orders/${order.id}/refund`, { method: "POST", body: JSON.stringify({ amount_minor: minor, reason: reason || null }) });
      notify({ tone: "success", text: `Refunded ${fmtMoney(r.refunded_minor, order.currency)} on ${order.number}.` });
      onDone(r.order);
    } catch (err) {
      notify({ tone: "error", text: err instanceof Error ? err.message : "Could not refund." });
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Refund ${order.number}`} description={`Up to ${fmtMoney(refundable, order.currency)} can be refunded through the payment provider.`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={`Amount (${order.currency})`} required><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason (optional)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} /></Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Close</Button>
        <Button type="button" onClick={() => void go()} disabled={busy || toMinor(amount) <= 0}>{busy ? spinner : null}Refund</Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ─────────────────────────── Storefront tab ─────────────────────────── */

function StorefrontTab({ notify }: { notify: (n: Notice) => void }) {
  const [sf, setSf] = useState<StorefrontDTO | null>(null);
  const [publicUrl, setPublicUrl] = useState("");
  const [products, setProducts] = useState<StorefrontProductDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<{ title: string; slug: string; intro_md: string; terms_md: string; currency: string; collect_shipping: boolean; shipping_flat: string; pickup_enabled: boolean; max_qty: string } | null>(null);
  const [imageFor, setImageFor] = useState<StorefrontProductDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([api<{ storefront: StorefrontDTO; public_url: string }>("/api/storefront"), api<{ products: StorefrontProductDTO[] }>("/api/storefront/products")]);
      setSf(s.storefront);
      setPublicUrl(s.public_url);
      setProducts(p.products);
      setDraft({ title: s.storefront.title ?? "", slug: s.storefront.slug, intro_md: s.storefront.intro_md ?? "", terms_md: s.storefront.terms_md ?? "", currency: s.storefront.currency, collect_shipping: s.storefront.collect_shipping, shipping_flat: fromMinor(s.storefront.shipping_flat_minor), pickup_enabled: s.storefront.pickup_enabled, max_qty: String(s.storefront.settings.max_qty_per_line) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the storefront.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, ok: string) {
    setSaving(true);
    try {
      const r = await api<{ storefront: StorefrontDTO; public_url: string }>("/api/storefront", { method: "PATCH", body: JSON.stringify(body) });
      setSf(r.storefront);
      setPublicUrl(r.public_url);
      notify({ tone: "success", text: ok });
    } catch (err) {
      notify({ tone: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    await patch(
      {
        title: draft.title || null,
        slug: draft.slug,
        intro_md: draft.intro_md || null,
        terms_md: draft.terms_md || null,
        currency: draft.currency.toUpperCase(),
        collect_shipping: draft.collect_shipping,
        shipping_flat_minor: toMinor(draft.shipping_flat),
        pickup_enabled: draft.pickup_enabled,
        settings: { max_qty_per_line: Math.max(1, Number(draft.max_qty) || 20) },
      },
      "Storefront settings saved."
    );
  }

  async function setProduct(p: StorefrontProductDTO, body: Record<string, unknown>) {
    try {
      const r = await api<{ product: StorefrontProductDTO }>("/api/storefront/products", { method: "PUT", body: JSON.stringify({ product_id: p.id, ...body }) });
      setProducts((rows) => rows.map((x) => (x.id === p.id ? r.product : x)));
      return r.product;
    } catch (err) {
      notify({ tone: "error", text: err instanceof Error ? err.message : "Could not update the product." });
      return null;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify({ tone: "error", text: "Could not copy; select the link and copy it manually." });
    }
  }

  const visibleCount = useMemo(() => products.filter((p) => p.visible).length, [products]);

  if (loading) return <Loading label="Loading storefront…" />;
  if (error || !sf || !draft) return <ErrorState message={error ?? "Could not load the storefront."} onRetry={() => void load()} />;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Store className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">Public shop {sf.enabled ? <Pill tone="success" className="ml-1">Live</Pill> : <Pill tone="neutral" className="ml-1">Off</Pill>}</p>
            <p className="text-xs text-muted-foreground">{visibleCount} product{visibleCount === 1 ? "" : "s"} listed · <a href={publicUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">{publicUrl}</a></p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()} aria-live="polite">{copied ? <Check className="mr-1.5 h-4 w-4" aria-hidden /> : <Copy className="mr-1.5 h-4 w-4" aria-hidden />}{copied ? "Copied" : "Copy link"}</Button>
          <Button asChild variant="outline" size="sm"><a href={publicUrl} target="_blank" rel="noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />Open</a></Button>
          <Button type="button" size="sm" variant={sf.enabled ? "secondary" : "default"} disabled={saving} onClick={() => void patch({ enabled: !sf.enabled }, sf.enabled ? "Storefront switched off." : "Storefront is live.")}>{sf.enabled ? "Switch off" : "Enable shop"}</Button>
        </div>
      </section>

      <form onSubmit={saveSettings} className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
        <h2 className="text-sm font-semibold sm:col-span-2">Settings</h2>
        <Field label="Shop title" hint="Defaults to your organisation name."><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} /></Field>
        <Field label="URL slug" hint="/shop/<slug>"><Input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })} pattern="[a-z0-9-]+" maxLength={64} required /></Field>
        <Field label="Currency" hint="ISO code; product prices are shown as stored."><Input value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} maxLength={3} className="uppercase" required /></Field>
        <Field label="Max quantity per product"><Input inputMode="numeric" value={draft.max_qty} onChange={(e) => setDraft({ ...draft, max_qty: e.target.value })} /></Field>
        <Field label="Intro (markdown)" className="sm:col-span-2"><Textarea value={draft.intro_md} onChange={(e) => setDraft({ ...draft, intro_md: e.target.value })} rows={3} /></Field>
        <Field label="Terms & conditions (markdown)" hint="Shoppers must accept these at checkout when set." className="sm:col-span-2"><Textarea value={draft.terms_md} onChange={(e) => setDraft({ ...draft, terms_md: e.target.value })} rows={4} /></Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox checked={draft.collect_shipping} onChange={(e) => setDraft({ ...draft, collect_shipping: e.target.checked })} label="Collect a shipping address and charge a flat shipping fee" />
          {draft.collect_shipping && (
            <div className="grid gap-3 pl-6 sm:grid-cols-2">
              <Field label={`Flat shipping (${draft.currency || sf.currency})`}><Input inputMode="decimal" value={draft.shipping_flat} onChange={(e) => setDraft({ ...draft, shipping_flat: e.target.value })} /></Field>
              <div className="flex items-end pb-2"><Checkbox checked={draft.pickup_enabled} onChange={(e) => setDraft({ ...draft, pickup_enabled: e.target.checked })} label="Also offer free collection in person" /></div>
            </div>
          )}
        </div>
        <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={saving}>{saving ? spinner : null}Save settings</Button></div>
      </form>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">Products</h2>
            <p className="text-xs text-muted-foreground">Tick what shoppers can buy. Prices, tax and stock come from <Link href="/inventory" className="text-primary underline-offset-4 hover:underline">Inventory</Link>.</p>
          </div>
        </div>
        {products.length === 0 ? (
          <Empty title="No products yet" text="Add products to your pricebook first." action={<Button asChild variant="outline"><Link href="/inventory">Open inventory</Link></Button>} className="m-4" />
        ) : (
          <TableScroller label="Storefront products">
            <table className="w-full min-w-[720px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Listed</th>
                  <th className={TH}>Product</th>
                  <th className={cn(TH, "text-right")}>Price</th>
                  <th className={TH}>Stock</th>
                  <th className={TH}>Sort</th>
                  <th className={TH}>Image</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2"><Checkbox checked={p.visible} onChange={(e) => void setProduct(p, { visible: e.target.checked })} label={<span className="sr-only">List {p.name}</span>} /></td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.sku ?? "no SKU"} · {p.kind}</p>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(p.unit_price_minor, p.currency)}</td>
                    <td className="px-3 py-2 text-xs">{p.track_stock ? <span className={cn(p.stock_available <= 0 && "text-destructive")}>{p.stock_available} available</span> : <span className="text-muted-foreground">untracked</span>}</td>
                    <td className="px-3 py-2"><Input type="number" aria-label={`Sort order for ${p.name}`} defaultValue={p.sort} className="h-8 w-20" onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== p.sort) void setProduct(p, { sort: n }); }} /></td>
                    <td className="px-3 py-2"><Button type="button" variant="outline" size="sm" onClick={() => setImageFor(p)}>{p.image_url ? "Change image" : "Add image"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>
      {imageFor && <ImageDialog product={imageFor} onClose={() => setImageFor(null)} onSave={async (body) => { const r = await setProduct(imageFor, body); if (r) setImageFor(null); }} />}
    </div>
  );
}

function ImageDialog({ product, onClose, onSave }: { product: StorefrontProductDTO; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [url, setUrl] = useState(product.image_url && !product.image_url.startsWith("attachment:") ? product.image_url : "");
  const [description, setDescription] = useState(product.description_md ?? "");
  const [attachments, setAttachments] = useState<Array<{ id: string; file_name: string; content_type: string; visibility: string }>>([]);
  const [picked, setPicked] = useState(product.image_url?.startsWith("attachment:") ? product.image_url.slice("attachment:".length) : "");
  const [busy, setBusy] = useState(false);
  const images = attachments.filter((a) => a.content_type.startsWith("image/"));
  async function save() {
    setBusy(true);
    const image_url = picked ? `attachment:${picked}` : url.trim() || null;
    await onSave({ image_url, description_md: description.trim() || null });
    setBusy(false);
  }
  return (
    <Dialog title={`Image & description — ${product.name}`} description="Upload an image to the product (set it visible in the portal) or paste an image URL." onClose={onClose} size="lg">
      <div className="space-y-4">
        <AttachmentPanel entityKind="product" entityId={product.id} allowPortal compact onChange={(files) => setAttachments(files)} />
        {images.length > 0 && (
          <Field label="Use an uploaded image" hint="Only images marked visible in the client portal can be shown publicly.">
            <Select value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">— none —</option>
              {images.map((a) => (
                <option key={a.id} value={a.id} disabled={a.visibility !== "portal"}>{a.file_name}{a.visibility !== "portal" ? " (not public)" : ""}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Or image URL" hint="https://… (ignored when an uploaded image is chosen)"><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/photo.jpg" /></Field>
        <Field label="Shop description (markdown)" hint="Falls back to the pricebook description."><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={10_000} /></Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="button" onClick={() => void save()} disabled={busy}>{busy ? spinner : null}Save</Button>
      </DialogFooter>
    </Dialog>
  );
}
