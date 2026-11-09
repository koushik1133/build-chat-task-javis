"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, Loader2, PackageOpen, Plus, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState } from "@/components/ui/feedback";
import { renderMarkdown } from "@/lib/privacy/markdown";
import { CatalogSkeleton, money, PageState, ProductImage, SHOP_WIDTH, ShopNav, StickyBar, StockBadge, TaxNote, TrustStrip, useCart, useShop, type ShopItem } from "@/components/shop/shop-ui";
import { cn } from "@/lib/utils";

export default function ShopCatalogPage() {
  const { org } = useParams<{ org: string }>();
  const { shop, items, loading, error, reload } = useShop(org);
  const cart = useCart(org);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/shop/${encodeURIComponent(org)}`;

  async function add(item: ShopItem) {
    setBusy(item.id);
    setNotice(null);
    try {
      await cart.add(item.id, 1);
      setAdded(item.id);
      setAnnounce(`${item.name} added to your cart.`);
      setTimeout(() => setAdded((v) => (v === item.id ? null : v)), 1500);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not add to cart.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <CatalogSkeleton />;
  if (error || !shop) return <PageState><ErrorState message={error ?? "This shop is not available."} onRetry={reload} /></PageState>;

  const units = cart.cart?.units ?? 0;
  const hasCart = units > 0 && cart.cart;

  return (
    <>
      <ShopNav org={org} title={shop.name} units={cart.cart?.units ?? null} current="shop" />
      <div className={cn(SHOP_WIDTH, "py-6 sm:py-8", hasCart && "pb-28 lg:pb-8")}>
        <header className="mb-6 sm:mb-8">
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">{shop.name}</h1>
          {shop.intro_md && (
            <div className="prose prose-sm mt-2 max-w-prose text-muted-foreground dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(shop.intro_md) }} />
          )}
          <TrustStrip shop={shop} className="mt-4" />
          <TaxNote inclusive={shop.prices_include_tax} className="mt-2" />
        </header>

        {notice && <Banner tone="error" onDismiss={() => setNotice(null)}>{notice}</Banner>}
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>

        {items.length === 0 ? (
          <Empty
            icon={<PackageOpen className="h-5 w-5" aria-hidden />}
            title="Nothing for sale just yet"
            text={shop.support_email ? "Check back soon, or get in touch if you are looking for something specific." : "Check back soon."}
            action={
              shop.support_email ? (
                <Button asChild variant="outline" touch>
                  <a href={`mailto:${shop.support_email}`}>Email {shop.brand_name}</a>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Products">
            {items.map((item) => {
              const isBusy = busy === item.id;
              const isAdded = added === item.id;
              return (
                <li key={item.id} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <ProductImage src={item.image_url} alt={item.image_url ? item.name : ""} className="aspect-[4/3] w-full" />
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="min-w-0 break-words text-base font-medium leading-snug">{item.name}</h2>
                      <span className="shrink-0">
                        <StockBadge item={item} />
                      </span>
                    </div>
                    {item.description && <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>}
                    <div className="mt-auto flex items-center justify-between gap-3 pt-2">
                      <p className="text-lg font-semibold tabular-nums">
                        {money(item.price_minor, item.currency)}
                        {item.unit !== "each" && <span className="ml-1 text-xs font-normal text-muted-foreground">per {item.unit}</span>}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        touch
                        variant={isAdded ? "secondary" : "default"}
                        disabled={!item.in_stock || isBusy}
                        onClick={() => void add(item)}
                        aria-label={item.in_stock ? `Add ${item.name} to cart` : `${item.name} is sold out`}
                        aria-busy={isBusy || undefined}
                      >
                        {isBusy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : isAdded ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                        {!item.in_stock ? "Sold out" : isAdded ? "Added" : "Add to cart"}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {shop.terms_md && (
          <details id="terms" className="mt-10 rounded-lg border border-border p-4 text-sm text-muted-foreground">
            <summary className="-m-2 cursor-pointer rounded-md p-2 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Terms and conditions
            </summary>
            <div className="prose prose-sm mt-3 max-w-prose dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(shop.terms_md) }} />
          </details>
        )}
      </div>

      {hasCart && cart.cart && (
        <StickyBar>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {units} {units === 1 ? "item" : "items"} in your cart
            </p>
            <p className="text-base font-semibold tabular-nums">{money(cart.cart.total_minor, cart.cart.currency)}</p>
          </div>
          <Button asChild size="lg" className="shrink-0">
            <Link href={`${base}/cart`}>
              <ShoppingCart className="h-4 w-4" aria-hidden /> View cart
            </Link>
          </Button>
        </StickyBar>
      )}
    </>
  );
}
