"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { money, PageState, ProductImage, ShopNav, TaxNote, Totals, useCart, useShop } from "@/components/shop/shop-ui";

export default function CartPage() {
  const { org } = useParams<{ org: string }>();
  const { shop, loading: shopLoading, error: shopError, reload } = useShop(org);
  const cart = useCart(org);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/shop/${encodeURIComponent(org)}`;

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update your cart.");
    } finally {
      setBusy(null);
    }
  }

  if (shopLoading || cart.loading) return <PageState><Loading label="Loading cart…" /></PageState>;
  if (shopError || !shop) return <PageState><ErrorState message={shopError ?? "This shop is not available."} onRetry={reload} /></PageState>;
  const c = cart.cart;

  return (
    <>
      <ShopNav org={org} title={shop.name} units={c?.units ?? null} current="cart" />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Your cart</h1>
        {cart.error && <Banner tone="error" className="mb-4">{cart.error}</Banner>}
        {notice && <Banner tone="error" className="mb-4">{notice}</Banner>}
        {!c || c.items.length === 0 ? (
          <Empty icon={<ShoppingCart className="h-6 w-6" aria-hidden />} title="Your cart is empty" action={<Button asChild><Link href={base}>Browse the shop</Link></Button>} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Cart items">
              {c.items.map((line) => {
                const warn = c.unavailable.find((u) => u.product_id === line.id);
                const atMax = line.qty >= shop.max_qty_per_line || (line.stock_available !== null && line.qty >= line.stock_available);
                return (
                  <li key={line.id} className="flex gap-3 p-3 sm:gap-4 sm:p-4">
                    <ProductImage src={line.image_url} alt="" className="h-20 w-20 shrink-0 rounded-lg" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{line.name}</p>
                          <p className="text-xs text-muted-foreground">{money(line.price_minor, line.currency)} each</p>
                          {warn && <p className="mt-1 text-xs text-destructive">{warn.reason === "unavailable" ? "No longer available" : `Only ${warn.available} in stock`}</p>}
                        </div>
                        <p className="shrink-0 font-semibold tabular-nums">{money(line.line_minor, line.currency)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="inline-flex items-center rounded-md border border-border" role="group" aria-label={`Quantity of ${line.name}`}>
                          <Button type="button" variant="ghost" size="icon" aria-label="Decrease quantity" disabled={busy !== null} onClick={() => void run(line.id, () => cart.setQty(line.id, line.qty - 1))}>
                            <Minus className="h-4 w-4" aria-hidden />
                          </Button>
                          <span className="min-w-[2ch] text-center text-sm tabular-nums" aria-live="polite">{line.qty}</span>
                          <Button type="button" variant="ghost" size="icon" aria-label="Increase quantity" disabled={busy !== null || atMax} onClick={() => void run(line.id, () => cart.setQty(line.id, line.qty + 1))}>
                            <Plus className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                        <Button type="button" variant="ghost" size="sm" className="ml-auto text-muted-foreground" disabled={busy !== null} onClick={() => void run(line.id, () => cart.remove(line.id))}>
                          <Trash2 className="mr-1 h-4 w-4" aria-hidden /> Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-16">
              <h2 className="mb-3 text-sm font-semibold">Summary</h2>
              <Totals cart={c} showShipping={shop.collect_shipping} />
              {shop.collect_shipping && <p className="mt-2 text-xs text-muted-foreground">Shipping is confirmed at checkout{shop.pickup_enabled ? " (free for collection)" : ""}.</p>}
              <TaxNote inclusive={c.prices_include_tax} className="mt-2" />
              <Button asChild className="mt-4 w-full" size="lg" disabled={c.unavailable.length > 0}>
                <Link href={`${base}/checkout`} aria-disabled={c.unavailable.length > 0}>Checkout</Link>
              </Button>
              {c.unavailable.length > 0 && <p className="mt-2 text-xs text-destructive">Fix the highlighted items to continue.</p>}
              <Link href={base} className="mt-3 block text-center text-sm text-muted-foreground underline-offset-4 hover:underline">Continue shopping</Link>
            </aside>
          </div>
        )}
      </div>
    </>
  );
}
