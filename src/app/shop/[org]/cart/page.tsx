"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Lock, Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState } from "@/components/ui/feedback";
import { CartSkeleton, CtaLink, money, PageState, ProductImage, SHOP_WIDTH, ShopNav, StickyBar, TaxNote, Totals, useCart, useShop } from "@/components/shop/shop-ui";
import { cn } from "@/lib/utils";

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

  if (shopLoading || cart.loading) return <CartSkeleton />;
  if (shopError || !shop) return <PageState><ErrorState message={shopError ?? "This shop is not available."} onRetry={reload} /></PageState>;
  const c = cart.cart;
  const blocked = Boolean(c && c.unavailable.length > 0);
  const hasItems = Boolean(c && c.items.length > 0);

  return (
    <>
      <ShopNav org={org} title={shop.name} units={c?.units ?? null} current="cart" />
      <div className={cn(SHOP_WIDTH, "py-6 sm:py-8", hasItems && "pb-28 lg:pb-8")}>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Your cart</h1>
        {cart.error && <Banner tone="error">{cart.error}</Banner>}
        {notice && <Banner tone="error" onDismiss={() => setNotice(null)}>{notice}</Banner>}
        {!c || c.items.length === 0 ? (
          <Empty
            icon={<ShoppingCart className="h-5 w-5" aria-hidden />}
            title="Your cart is empty"
            text="Anything you add will show up here, ready for checkout."
            action={
              <Button asChild touch>
                <Link href={base}>Browse the shop</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <ul className="min-w-0 divide-y divide-border rounded-xl border border-border bg-card" aria-label="Cart items">
              {c.items.map((line) => {
                const warn = c.unavailable.find((u) => u.product_id === line.id);
                const atMax = line.qty >= shop.max_qty_per_line || (line.stock_available !== null && line.qty >= line.stock_available);
                const lineBusy = busy === line.id;
                return (
                  <li key={line.id} className={cn("flex gap-3 p-3 sm:gap-4 sm:p-4", warn && "bg-destructive/5")}>
                    <ProductImage src={line.image_url} alt="" className="h-20 w-20 shrink-0 rounded-lg" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words font-medium">{line.name}</p>
                          <p className="text-xs text-muted-foreground">{money(line.price_minor, line.currency)} each</p>
                          {warn && (
                            <p className="mt-1 text-xs font-medium text-destructive" role="alert">
                              {warn.reason === "unavailable" ? "No longer available — remove it to continue." : `Only ${warn.available} in stock — lower the quantity to continue.`}
                            </p>
                          )}
                        </div>
                        <p className="shrink-0 font-semibold tabular-nums">{money(line.line_minor, line.currency)}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex items-center rounded-md border border-border" role="group" aria-label={`Quantity of ${line.name}`}>
                          <Button type="button" variant="ghost" size="icon" touch aria-label={`Decrease quantity of ${line.name}`} disabled={busy !== null} onClick={() => void run(line.id, () => cart.setQty(line.id, line.qty - 1))}>
                            <Minus className="h-4 w-4" aria-hidden />
                          </Button>
                          <span className="min-w-[2.5ch] text-center text-sm font-medium tabular-nums" aria-live="polite" aria-atomic="true">
                            {line.qty}
                            <span className="sr-only"> in cart</span>
                          </span>
                          <Button type="button" variant="ghost" size="icon" touch aria-label={`Increase quantity of ${line.name}`} disabled={busy !== null || atMax} onClick={() => void run(line.id, () => cart.setQty(line.id, line.qty + 1))}>
                            <Plus className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                        {atMax && !warn && <span className="text-xs text-muted-foreground">Maximum reached</span>}
                        <Button type="button" variant="ghost" size="sm" touch className="ml-auto text-muted-foreground" disabled={busy !== null} aria-busy={lineBusy || undefined} onClick={() => void run(line.id, () => cart.remove(line.id))}>
                          <Trash2 className="h-4 w-4" aria-hidden /> Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-16" aria-label="Order summary">
              <h2 className="mb-3 text-sm font-semibold">Summary</h2>
              <Totals cart={c} showShipping={shop.collect_shipping} />
              {shop.collect_shipping && <p className="mt-2 text-xs text-muted-foreground">Shipping is confirmed at checkout{shop.pickup_enabled ? " (free for collection)" : ""}.</p>}
              <TaxNote inclusive={c.prices_include_tax} className="mt-2" />
              <CtaLink href={`${base}/checkout`} disabled={blocked} className="mt-4 hidden w-full lg:inline-flex">
                <Lock className="h-4 w-4" aria-hidden /> Checkout
              </CtaLink>
              {blocked && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  Fix the highlighted items to continue.
                </p>
              )}
              <Link href={base} className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-md text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0 lg:py-1">
                Continue shopping
              </Link>
            </aside>
          </div>
        )}
      </div>

      {hasItems && c && (
        <StickyBar>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Total{shop.collect_shipping ? " (before shipping)" : ""}</p>
            <p className="text-base font-semibold tabular-nums">{money(c.total_minor, c.currency)}</p>
          </div>
          <CtaLink href={`${base}/checkout`} disabled={blocked} className="shrink-0">
            <Lock className="h-4 w-4" aria-hidden /> Checkout
          </CtaLink>
        </StickyBar>
      )}
    </>
  );
}
