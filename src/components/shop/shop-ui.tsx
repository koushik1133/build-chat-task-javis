"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Lock, Mail, ShoppingBag, ShoppingCart, Store, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/money/format";

/* eslint-disable @next/next/no-img-element -- product images are org-supplied URLs / attachments; next/image needs an allow-list */

/** Client-safe shapes mirrored from the public /api/shop/[org] routes. */
export interface ShopInfo {
  slug: string;
  name: string;
  brand_name: string;
  intro_md: string | null;
  terms_md: string | null;
  currency: string;
  collect_shipping: boolean;
  shipping_flat_minor: number;
  pickup_enabled: boolean;
  prices_include_tax: boolean;
  max_qty_per_line: number;
  support_email: string | null;
}
export interface ShopItem {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  price_minor: number;
  currency: string;
  tax_rate_bp: number;
  stock_available: number | null;
  in_stock: boolean;
  low_stock: boolean;
  image_url: string | null;
}
export interface CartLine extends ShopItem {
  qty: number;
  line_minor: number;
}
export interface CartData {
  id: string;
  items: CartLine[];
  units: number;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  prices_include_tax: boolean;
  unavailable: Array<{ product_id: string; reason: "unavailable" | "insufficient_stock"; available: number | null }>;
  email: string | null;
  expires_at: string;
}

export async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  if (d && typeof d.detail === "string") return d.detail;
  if (d?.detail?.formErrors?.[0]) return String(d.detail.formErrors[0]);
  if (d?.detail?.fieldErrors) {
    const first = Object.entries(d.detail.fieldErrors as Record<string, string[]>)[0];
    if (first) return `${first[0]}: ${first[1].join(", ")}`;
  }
  return d?.error ? String(d.error).replace(/_/g, " ") : `${fallback} (${res.status})`;
}

export function useShop(org: string) {
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [items, setItems] = useState<ShopItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shop/${encodeURIComponent(org)}`, { cache: "no-store" });
      if (res.status === 404) throw new Error("This shop is not available.");
      if (!res.ok) throw new Error(await readError(res, "Could not load the shop"));
      const json = (await res.json()) as { shop: ShopInfo; items: ShopItem[] };
      setShop(json.shop);
      setItems(json.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the shop.");
    } finally {
      setLoading(false);
    }
  }, [org]);
  useEffect(() => {
    void load();
  }, [load]);
  return { shop, items, loading, error, reload: load };
}

export function useCart(org: string, opts: { pickup?: boolean } = {}) {
  const [cart, setCart] = useState<CartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/shop/${encodeURIComponent(org)}/cart`;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = opts.pickup === undefined ? "" : `?pickup=${opts.pickup ? 1 : 0}`;
      const res = await fetch(`${base}${qs}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(await readError(res, "Could not load your cart"));
      setCart(((await res.json()) as { cart: CartData }).cart);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your cart.");
    } finally {
      setLoading(false);
    }
  }, [base, opts.pickup]);
  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
      const res = await fetch(base, { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readError(res, "Could not update your cart"));
      const json = (await res.json()) as { cart: CartData };
      setCart(json.cart);
      return json.cart;
    },
    [base]
  );
  return {
    cart,
    loading,
    error,
    reload: load,
    add: (product_id: string, qty = 1) => mutate("POST", { product_id, qty }),
    setQty: (product_id: string, qty: number) => mutate("PATCH", { product_id, qty, ...(opts.pickup === undefined ? {} : { pickup: opts.pickup }) }),
    remove: (product_id: string) => mutate("DELETE", { product_id }),
    setEmail: (email: string | null) => mutate("PATCH", { email }),
  };
}

export function money(minor: number, currency: string): string {
  return fmtMoney(minor, currency);
}

/** Shared page width for every storefront surface (header, nav, content, footer). */
export const SHOP_WIDTH = "mx-auto w-full max-w-5xl px-4 sm:px-6";

/** Sticky sub-header: shop name, catalog link and cart badge. */
export function ShopNav({ org, title, units, current }: { org: string; title: string; units: number | null; current: "shop" | "cart" | "checkout" | "order" }) {
  const base = `/shop/${encodeURIComponent(org)}`;
  const link =
    "inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <nav aria-label="Shop" className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
      <div className={cn(SHOP_WIDTH, "flex items-center justify-between gap-3")}>
        <Link href={base} className={cn(link, "-ml-3 min-w-0")} aria-current={current === "shop" ? "page" : undefined}>
          <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
        </Link>
        <Link href={`${base}/cart`} className={cn(link, "-mr-3 shrink-0", current === "cart" && "bg-secondary/60")} aria-current={current === "cart" ? "page" : undefined}>
          <ShoppingCart className="h-4 w-4" aria-hidden />
          <span>Cart</span>
          {units !== null && units > 0 && (
            <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
              {units}
              <span className="sr-only"> {units === 1 ? "item" : "items"} in cart</span>
            </span>
          )}
        </Link>
      </div>
    </nav>
  );
}

/**
 * Trust strip under the catalog header: the three things a first-time buyer
 * wants to know before adding anything — payment, delivery and who to contact.
 */
export function TrustStrip({ shop, className }: { shop: ShopInfo; className?: string }) {
  const delivery = shop.collect_shipping
    ? shop.pickup_enabled
      ? "Delivery or collection"
      : shop.shipping_flat_minor > 0
        ? `Delivery ${money(shop.shipping_flat_minor, shop.currency)}`
        : "Free delivery"
    : "Collect in person";
  const item = "flex min-w-0 items-center gap-2 text-sm text-muted-foreground";
  return (
    <ul className={cn("flex flex-wrap gap-x-6 gap-y-2", className)} aria-label="Shop information">
      <li className={item}>
        <Lock className="h-4 w-4 shrink-0" aria-hidden />
        Secure card payment
      </li>
      <li className={item}>
        {shop.collect_shipping ? <Truck className="h-4 w-4 shrink-0" aria-hidden /> : <Store className="h-4 w-4 shrink-0" aria-hidden />}
        {delivery}
      </li>
      {shop.support_email && (
        <li className={item}>
          <Mail className="h-4 w-4 shrink-0" aria-hidden />
          <a
            href={`mailto:${shop.support_email}`}
            className="truncate rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {shop.support_email}
          </a>
        </li>
      )}
    </ul>
  );
}

/**
 * Phone-only sticky bar pinned above the home indicator. Used for the cart
 * total + primary action so the next step is always one thumb away.
 */
export function StickyBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur lg:hidden",
        "px-4 pt-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]",
        className
      )}
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">{children}</div>
    </div>
  );
}

export function ProductImage({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-secondary/50 text-muted-foreground", className)} aria-hidden>
        <ShoppingBag className="h-8 w-8" />
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("bg-secondary/50 object-cover", className)} />;
}

export function StockBadge({ item }: { item: Pick<ShopItem, "in_stock" | "low_stock" | "stock_available"> }) {
  if (!item.in_stock) return <Pill tone="danger">Sold out</Pill>;
  if (item.low_stock && item.stock_available !== null) return <Pill tone="warning">Only {item.stock_available} left</Pill>;
  return <Pill tone="success">In stock</Pill>;
}

export function TaxNote({ inclusive, className }: { inclusive: boolean; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{inclusive ? "Prices include tax." : "Prices exclude tax; tax is added at checkout."}</p>;
}

export function Totals({ cart, showShipping = true }: { cart: Pick<CartData, "subtotal_minor" | "tax_minor" | "shipping_minor" | "total_minor" | "currency" | "prices_include_tax">; showShipping?: boolean }) {
  const row = "flex items-center justify-between gap-4 text-sm";
  return (
    <dl className="space-y-1.5">
      <div className={row}>
        <dt className="text-muted-foreground">Subtotal{cart.prices_include_tax ? " (excl. tax)" : ""}</dt>
        <dd className="tabular-nums">{money(cart.subtotal_minor, cart.currency)}</dd>
      </div>
      <div className={row}>
        <dt className="text-muted-foreground">Tax</dt>
        <dd className="tabular-nums">{money(cart.tax_minor, cart.currency)}</dd>
      </div>
      {showShipping && (
        <div className={row}>
          <dt className="text-muted-foreground">Shipping</dt>
          <dd className="tabular-nums">{cart.shipping_minor > 0 ? money(cart.shipping_minor, cart.currency) : "Free"}</dd>
        </div>
      )}
      <div className={cn(row, "border-t border-border pt-2 text-base font-semibold")}>
        <dt>Total</dt>
        <dd className="tabular-nums">{money(cart.total_minor, cart.currency)}</dd>
      </div>
    </dl>
  );
}

/** Centred error / fallback container for a storefront page. */
export function PageState({ children }: { children: React.ReactNode }) {
  return <div className={cn(SHOP_WIDTH, "py-12 text-center text-sm text-muted-foreground")}>{children}</div>;
}

/** Loading skeleton shaped like the catalog (header, trust strip, 3-up card grid) so the real page lands without a jump. */
export function CatalogSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn(SHOP_WIDTH, "py-6 sm:py-8")}>
      <div className="h-11" aria-hidden />
      <Skeleton className="h-8 w-56 max-w-full" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <Skeleton className="mt-4 h-4 w-64 max-w-full" />
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="overflow-hidden rounded-xl border border-border bg-card">
            <Skeleton className="aspect-[4/3] w-full rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <div className="flex items-center justify-between pt-2">
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-11 w-24 sm:h-9" />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <span className="sr-only">Loading shop…</span>
    </div>
  );
}

/** Loading skeleton shaped like the cart / checkout two-column layout. */
export function CartSkeleton({ label = "Loading cart…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn(SHOP_WIDTH, "py-6 sm:py-8")}>
      <div className="h-11" aria-hidden />
      <Skeleton className="h-8 w-40" />
      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]" aria-hidden>
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Primary call to action that is either a real link or a disabled button — never a disabled-looking anchor. */
export function CtaLink({ href, disabled, children, className }: { href: string; disabled?: boolean; children: React.ReactNode; className?: string }) {
  if (disabled) {
    return (
      <Button type="button" size="lg" disabled className={className}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild size="lg" className={className}>
      <Link href={href}>{children}</Link>
    </Button>
  );
}
