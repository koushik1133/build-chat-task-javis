"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Boxes, Loader2, Package, Pencil, Plus, RefreshCw, Trash2, Undo2, Wrench } from "lucide-react";
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
import { api, Banner, Dialog, DialogFooter, Empty, Field, fromMinor, Loading, TabPanel, Tabs, toMinor } from "@/components/finance/shared";

interface Product {
  id: string; sku: string | null; name: string; description: string | null; kind: "product" | "service" | "rental"; unit: string;
  unit_price_minor: number; cost_minor: number; currency: string; tax_rate_bp: number; track_stock: boolean;
  stock_on_hand: number; stock_reserved: number; stock_available: number; reorder_point: number; low_stock: boolean; active: boolean;
}
interface Checkout {
  id: string; product_id: string; product_name: string; product_sku: string | null; qty: number; checked_out_to: string | null;
  due_back_at: string | null; returned_at: string | null; created_at: string; overdue: boolean;
}

type Tab = "products" | "equipment";
const KIND_TONE: Record<Product["kind"], Tone> = { product: "neutral", service: "info", rental: "violet" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

export default function InventoryPage() {
  const [tab, setTab] = useState<Tab>("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [p, c] = await Promise.all([
        api<{ products: Product[]; next_cursor: string | null }>(`/api/products?inactive=1&order=created&limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}${lowOnly ? "&low=1" : ""}`, { signal }),
        api<{ checkouts: Checkout[] }>("/api/equipment", { signal }),
      ]);
      setProducts(p.products);
      setCursor(p.next_cursor ?? null);
      setCheckouts(c.checkouts);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load inventory.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [query, lowOnly, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await api<{ products: Product[]; next_cursor: string | null }>(
        `/api/products?inactive=1&order=created&limit=50&cursor=${encodeURIComponent(cursor)}${query ? `&q=${encodeURIComponent(query)}` : ""}${lowOnly ? "&low=1" : ""}`
      );
      setProducts((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...p.products.filter((x) => !seen.has(x.id))];
      });
      setCursor(p.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more products.");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query, lowOnly]);

  const lowCount = useMemo(() => products.filter((p) => p.low_stock).length, [products]);
  const openCheckouts = useMemo(() => checkouts.filter((c) => !c.returned_at), [checkouts]);

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

  const onEdit = useCallback((p: Product) => setEditing(p), []);
  const onAdjust = useCallback((p: Product) => setAdjusting(p), []);
  const onDelete = useCallback(
    (p: Product) => {
      if (!window.confirm(`Delete “${p.name}”? It will disappear from the pricebook.`)) return;
      void act(p.id, async () => {
        await api(`/api/products/${p.id}`, { method: "DELETE" });
        return `Deleted ${p.name}.`;
      });
    },
    [act]
  );
  const onCheckin = useCallback(
    (c: Checkout) =>
      void act(c.id, async () => {
        await api(`/api/equipment?id=${encodeURIComponent(c.id)}`, { method: "PATCH" });
        return `${c.product_name} checked back in.`;
      }),
    [act]
  );

  const filtered = Boolean(q || lowOnly);

  return (
    <PageContainer
      wide
      title="Inventory & pricebook"
      description="Products, services and rentals you sell, what they cost you, and what’s on the shelf."
      tooltip="Track stock so accepted quotes reserve it and invoices consume it. Low-stock items show up here and in the agent’s low-stock tool."
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          {tab === "products" ? (
            <Button touch onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" aria-hidden /> New product
            </Button>
          ) : (
            <Button touch onClick={() => setCheckingOut(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Check out
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Tabs
          id="inventory"
          label="Inventory sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "products", label: "Products", count: products.length },
            { id: "equipment", label: "Equipment out", count: openCheckouts.length },
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
      {lowCount > 0 && tab === "products" && !lowOnly && (
        <Banner tone="warn">
          {lowCount} product{lowCount === 1 ? " is" : "s are"} at or below the reorder point.{" "}
          <button type="button" className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setLowOnly(true)}>
            Show only low stock
          </button>
          {" · "}
          <Link href="/procurement?tab=reorder" className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Reorder from suppliers
          </Link>
        </Banner>
      )}

      {tab === "products" ? (
        <TabPanel id="inventory" value="products">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchField value={q} onChange={setQ} label="Search products" placeholder="Search name, SKU or description" className="sm:max-w-xs sm:flex-1" />
            <Checkbox checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} label="Low stock only" />
          </div>
          {loading && products.length === 0 ? (
            <Loading label="Loading products…" />
          ) : products.length === 0 ? (
            <Empty
              icon={<Package className="h-5 w-5" />}
              title={filtered ? "Nothing matches that filter" : "No products yet"}
              text={filtered ? "Try a different search or clear the filters." : "Add what you sell so quotes and invoices can pull prices and stock from one place."}
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQ("");
                      setLowOnly(false);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button onClick={() => setEditing("new")}>
                    <Plus className="h-4 w-4" aria-hidden /> Add a product
                  </Button>
                )
              }
            />
          ) : (
            <>
              <ProductTable products={products} busyId={busyId} onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete} />
              <LoadMore hasMore={Boolean(cursor)} loading={loadingMore} count={products.length} onMore={loadMore} noun="products" />
            </>
          )}
        </TabPanel>
      ) : (
        <TabPanel id="inventory" value="equipment">
          {loading && checkouts.length === 0 ? (
            <Loading label="Loading equipment…" />
          ) : (
            <EquipmentList checkouts={checkouts} busyId={busyId} onCheckin={onCheckin} onCheckout={() => setCheckingOut(true)} />
          )}
        </TabPanel>
      )}

      {editing && (
        <ProductDialog
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            void load();
          }}
        />
      )}
      {adjusting && (
        <StockDialog
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={(msg) => {
            setAdjusting(null);
            setNotice(msg);
            void load();
          }}
        />
      )}
      {checkingOut && (
        <CheckoutDialog
          products={products.filter((p) => p.active)}
          onClose={() => setCheckingOut(false)}
          onSaved={(msg) => {
            setCheckingOut(false);
            setNotice(msg);
            setTab("equipment");
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

function KindPill({ kind }: { kind: Product["kind"] }) {
  return (
    <Pill tone={KIND_TONE[kind]} className="capitalize">
      {kind}
    </Pill>
  );
}

function StockCell({ p }: { p: Product }) {
  if (!p.track_stock) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("tabular-nums", p.low_stock && "font-semibold text-amber-800 dark:text-amber-300")}>
      {p.stock_available}
      <span className="text-xs text-muted-foreground">
        {" "}
        / {p.stock_on_hand}
        {p.stock_reserved > 0 ? ` (${p.stock_reserved} held)` : ""}
      </span>
      {p.low_stock && (
        <>
          <AlertTriangle className="ml-1 inline h-3.5 w-3.5" aria-hidden />
          <span className="sr-only"> Low stock</span>
        </>
      )}
    </span>
  );
}

type RowHandlers = { onEdit: (p: Product) => void; onAdjust: (p: Product) => void; onDelete: (p: Product) => void };

function ProductTable({ products, busyId, onEdit, onAdjust, onDelete }: { products: Product[]; busyId: string | null } & RowHandlers) {
  return (
    <>
      {/* Phones: cards */}
      <ul className="space-y-2 sm:hidden">
        {products.map((p) => (
          <ProductCard key={p.id} p={p} busy={busyId === p.id} onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete} />
        ))}
      </ul>
      {/* Tablet and up: table */}
      <div className="hidden sm:block">
        <TableScroller label="Products">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>Product</th>
                <th scope="col" className={TH}>Kind</th>
                <th scope="col" className={cn(TH, "text-right")}>Price</th>
                <th scope="col" className={cn(TH, "text-right")}>Cost</th>
                <th scope="col" className={cn(TH, "text-right")}>Available / on hand</th>
                <th scope="col" className={cn(TH, "text-right")}>Reorder at</th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {products.map((p) => (
                <ProductRow key={p.id} p={p} busy={busyId === p.id} onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </TableScroller>
      </div>
    </>
  );
}

const ProductCard = memo(function ProductCard({ p, busy, onEdit, onAdjust, onDelete }: { p: Product; busy: boolean } & RowHandlers) {
  return (
    <li className={cn("rounded-xl border border-border bg-card p-3", !p.active && "opacity-60")} aria-busy={busy || undefined}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {p.name}
            {!p.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(inactive)</span>}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{p.sku ?? "No SKU"}</span>
            <KindPill kind={p.kind} />
          </p>
        </div>
        <span className="shrink-0 font-medium tabular-nums">{fmtMoney(p.unit_price_minor, p.currency)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          Stock: <StockCell p={p} />
        </span>
        <RowActions p={p} busy={busy} onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete} />
      </div>
    </li>
  );
});

const ProductRow = memo(function ProductRow({ p, busy, onEdit, onAdjust, onDelete }: { p: Product; busy: boolean } & RowHandlers) {
  return (
    <tr className={cn(!p.active && "opacity-60")} aria-busy={busy || undefined}>
      <td className="px-3 py-2">
        <p className="font-medium">
          {p.name}
          {!p.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(inactive)</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {p.sku ?? "No SKU"} · per {p.unit}
        </p>
      </td>
      <td className="px-3 py-2">
        <KindPill kind={p.kind} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(p.unit_price_minor, p.currency)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtMoney(p.cost_minor, p.currency)}</td>
      <td className="px-3 py-2 text-right">
        <StockCell p={p} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.track_stock ? p.reorder_point : "—"}</td>
      <td className="px-3 py-2 text-right">
        <RowActions p={p} busy={busy} onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete} />
      </td>
    </tr>
  );
});

function RowActions({ p, busy, onEdit, onAdjust, onDelete }: { p: Product; busy: boolean } & RowHandlers) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onAdjust(p)} title="Receive, consume or correct stock">
        <Boxes className="h-3.5 w-3.5" aria-hidden /> Stock
      </Button>
      <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onEdit(p)} aria-label={`Edit ${p.name}`}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(p)} aria-label={`Delete ${p.name}`}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {busy && spinner}
    </div>
  );
}

function EquipmentList({ checkouts, busyId, onCheckin, onCheckout }: { checkouts: Checkout[]; busyId: string | null; onCheckin: (c: Checkout) => void; onCheckout: () => void }) {
  if (checkouts.length === 0) {
    return (
      <Empty
        icon={<Wrench className="h-5 w-5" />}
        title="Nothing is checked out"
        text="Check equipment out to a job or a person so it can’t be double-booked."
        action={
          <Button onClick={onCheckout}>
            <Plus className="h-4 w-4" aria-hidden /> Check out equipment
          </Button>
        }
      />
    );
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {checkouts.map((c) => (
        <li key={c.id} className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", c.returned_at && "opacity-60")} aria-busy={busyId === c.id || undefined}>
          <div className="min-w-0">
            <p className="font-medium">
              {c.product_name} <span className="text-muted-foreground">× {c.qty}</span>
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {c.checked_out_to ? `Out to ${c.checked_out_to}` : "Checked out"} · {fmtDate(c.created_at)}
              {c.due_back_at && (
                <>
                  {" "}
                  · due back <span className={cn(c.overdue && "font-semibold text-red-700 dark:text-red-300")}>{fmtDate(c.due_back_at)}</span>
                </>
              )}
              {c.returned_at && ` · returned ${fmtDate(c.returned_at)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {c.overdue && !c.returned_at && (
              <Pill tone="danger">
                <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
              </Pill>
            )}
            {c.returned_at && <Pill>Returned</Pill>}
            {!c.returned_at && (
              <Button size="sm" variant="outline" touch disabled={busyId === c.id} onClick={() => onCheckin(c)}>
                <Undo2 className="h-3.5 w-3.5" aria-hidden /> Check in
              </Button>
            )}
            {busyId === c.id && spinner}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ProductDialog({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({
    name: product?.name ?? "", sku: product?.sku ?? "", description: product?.description ?? "", kind: product?.kind ?? "product",
    unit: product?.unit ?? "each", price: fromMinor(product?.unit_price_minor ?? 0), cost: fromMinor(product?.cost_minor ?? 0),
    currency: product?.currency ?? "USD", tax: ((product?.tax_rate_bp ?? 0) / 100).toString(), track: product?.track_stock ?? false,
    onHand: String(product?.stock_on_hand ?? 0), reorder: String(product?.reorder_point ?? 0), active: product?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(), sku: form.sku.trim() || null, description: form.description.trim() || null, kind: form.kind, unit: form.unit.trim() || "each",
        unit_price_minor: toMinor(form.price), cost_minor: toMinor(form.cost), currency: form.currency.toUpperCase(),
        tax_rate_bp: Math.round((Number(form.tax) || 0) * 100), track_stock: form.track, reorder_point: Math.max(0, Math.trunc(Number(form.reorder) || 0)), active: form.active,
      };
      if (!product) body.stock_on_hand = Math.max(0, Math.trunc(Number(form.onHand) || 0));
      const r = await api<{ product: Product }>(product ? `/api/products/${product.id}` : "/api/products", { method: product ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved(`${product ? "Updated" : "Added"} ${r.product.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the product.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={product ? "Edit product" : "New product"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required className="sm:col-span-2">
            <Input data-autofocus required maxLength={200} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="SKU" hint="Optional">
            <Input maxLength={64} value={form.sku} onChange={(e) => set("sku", e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => set("kind", e.target.value as Product["kind"])}>
              <option value="product">Product</option>
              <option value="service">Service</option>
              <option value="rental">Rental</option>
            </Select>
          </Field>
          <Field label="Unit">
            <Input maxLength={32} value={form.unit} onChange={(e) => set("unit", e.target.value)} placeholder="each, hour, day" />
          </Field>
          <Field label="Currency">
            <Input maxLength={3} value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Sell price">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={form.price} onChange={(e) => set("price", e.target.value)} />
          </Field>
          <Field label="Your cost" hint="Used for job costing">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={form.cost} onChange={(e) => set("cost", e.target.value)} />
          </Field>
          <Field label="Tax %">
            <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={form.tax} onChange={(e) => set("tax", e.target.value)} />
          </Field>
          <Field label="Description" className="sm:col-span-3">
            <Textarea rows={2} maxLength={4000} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        <fieldset className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">Stock</legend>
          <Checkbox checked={form.track} onChange={(e) => set("track", e.target.checked)} label="Track stock for this item" />
          {form.track && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {!product && (
                <Field label="Opening stock">
                  <Input type="number" inputMode="numeric" min={0} step={1} value={form.onHand} onChange={(e) => set("onHand", e.target.value)} />
                </Field>
              )}
              {product && (
                <p className="text-sm text-muted-foreground sm:self-end">
                  On hand {product.stock_on_hand}, held {product.stock_reserved}. Use the Stock button to change counts.
                </p>
              )}
              <Field label="Reorder point" hint="Warn when available stock drops to this">
                <Input type="number" inputMode="numeric" min={0} step={1} value={form.reorder} onChange={(e) => set("reorder", e.target.value)} />
              </Field>
            </div>
          )}
        </fieldset>
        {product && <Checkbox checked={form.active} onChange={(e) => set("active", e.target.checked)} label="Active (shown in the pricebook)" />}
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">
            {error}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !form.name.trim()}>
            {saving && spinner} {product ? "Save changes" : "Add product"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function StockDialog({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: (msg: string) => void }) {
  const [kind, setKind] = useState<"receive" | "consume" | "adjust">("receive");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const n = Math.trunc(Number(qty));
      if (!n) throw new Error("Enter a quantity other than zero.");
      const r = await api<{ product: Product }>(`/api/products/${product.id}/stock`, { method: "POST", body: JSON.stringify({ kind, qty: n, note: note.trim() || null }) });
      onSaved(`${product.name}: ${r.product.stock_available} available (${r.product.stock_on_hand} on hand).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update stock.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Adjust stock" description={product.name} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          On hand {product.stock_on_hand} · held {product.stock_reserved} · available {product.stock_available}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Movement">
            <Select data-autofocus value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="receive">Receive (stock in)</option>
              <option value="consume">Consume (stock out)</option>
              <option value="adjust">Correct count (+/−)</option>
            </Select>
          </Field>
          <Field label="Quantity" hint={kind === "adjust" ? "Negative removes stock" : undefined}>
            <Input type="number" inputMode="numeric" step={1} min={kind === "adjust" ? undefined : 1} value={qty} onChange={(e) => setQty(e.target.value)} required />
          </Field>
          <Field label="Note" className="sm:col-span-2">
            <Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="PO number, reason, job" />
          </Field>
        </div>
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
            {saving && spinner} Apply
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function CheckoutDialog({ products, onClose, onSaved }: { products: Product[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const rentals = useMemo(() => [...products].sort((a, b) => Number(b.kind === "rental") - Number(a.kind === "rental") || a.name.localeCompare(b.name)), [products]);
  const [productId, setProductId] = useState(rentals[0]?.id ?? "");
  const [qty, setQty] = useState("1");
  const [to, setTo] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!productId) throw new Error("Pick a product.");
      const r = await api<{ checkout: Checkout }>("/api/equipment", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, qty: Math.max(1, Math.trunc(Number(qty) || 1)), checked_out_to: to.trim() || null, due_back_at: due ? new Date(due + "T18:00:00").toISOString() : null }),
      });
      onSaved(`Checked out ${r.checkout.product_name} × ${r.checkout.qty}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check out.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Check out equipment" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {rentals.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add a product first (ideally of kind “rental”).</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Item" className="sm:col-span-2">
              <Select data-autofocus value={productId} onChange={(e) => setProductId(e.target.value)}>
                {rentals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.track_stock ? ` (${p.stock_available} available)` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quantity">
              <Input type="number" inputMode="numeric" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Field label="Due back">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Checked out to" className="sm:col-span-2">
              <Input maxLength={200} value={to} onChange={(e) => setTo(e.target.value)} placeholder="Crew member, client or job" />
            </Field>
          </div>
        )}
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">
            {error}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !productId}>
            {saving && spinner} Check out
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
