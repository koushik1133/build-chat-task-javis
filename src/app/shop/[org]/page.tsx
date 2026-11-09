"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Banner } from "@/components/ui/feedback";
import { renderMarkdown } from "@/lib/privacy/markdown";
import { money, PageState, ProductImage, ShopNav, StockBadge, TaxNote, useCart, useShop, type ShopItem } from "@/components/shop/shop-ui";

export default function ShopCatalogPage() {
  const { org } = useParams<{ org: string }>();
  const { shop, items, loading, error, reload } = useShop(org);
  const cart = useCart(org);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function add(item: ShopItem) {
    setBusy(item.id);
    setNotice(null);
    try {
      await cart.add(item.id, 1);
      setAdded(item.id);
      setTimeout(() => setAdded((v) => (v === item.id ? null : v)), 1500);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not add to cart.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <PageState><Loading label="Loading shop…" /></PageState>;
  if (error || !shop) return <PageState><ErrorState message={error ?? "This shop is not available."} onRetry={reload} /></PageState>;

  return (
    <>
      <ShopNav org={org} title={shop.name} units={cart.cart?.units ?? null} current="shop" />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{shop.name}</h1>
          {shop.intro_md && <div className="prose prose-sm mt-2 max-w-none text-muted-foreground dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(shop.intro_md) }} />}
          <TaxNote inclusive={shop.prices_include_tax} className="mt-2" />
        </header>
        {notice && <Banner tone="error" className="mb-4">{notice}</Banner>}
        {items.length === 0 ? (
          <Empty title="Nothing for sale yet" text="Check back soon." />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Products">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                <ProductImage src={item.image_url} alt={item.name} className="aspect-[4/3] w-full" />
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-base font-medium leading-snug">{item.name}</h2>
                    <StockBadge item={item} />
                  </div>
                  {item.description && <p className="line-clamp-3 text-sm text-muted-foreground">{item.description}</p>}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-2">
                    <p className="text-lg font-semibold tabular-nums">
                      {money(item.price_minor, item.currency)}
                      {item.unit !== "each" && <span className="ml-1 text-xs font-normal text-muted-foreground">/ {item.unit}</span>}
                    </p>
                    <Button type="button" size="sm" touch disabled={!item.in_stock || busy === item.id} onClick={() => void add(item)} aria-label={`Add ${item.name} to cart`}>
                      {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : added === item.id ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                      <span className="ml-1">{added === item.id ? "Added" : "Add"}</span>
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {shop.terms_md && (
          <details className="mt-10 rounded-lg border border-border p-4 text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Terms &amp; conditions</summary>
            <div className="prose prose-sm mt-2 max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(shop.terms_md) }} />
          </details>
        )}
      </div>
    </>
  );
}
