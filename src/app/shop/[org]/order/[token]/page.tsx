"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, Clock, Loader2, PackageCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Skeleton } from "@/components/ui/feedback";
import { money, PageState, readError, SHOP_WIDTH, ShopNav, Totals, useShop } from "@/components/shop/shop-ui";
import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/storefront/pure";

interface PublicOrder {
  number: string;
  status: OrderStatus;
  status_label: string;
  customer_name: string;
  customer_email: string;
  shipping_text: string;
  items: Array<{ description: string; qty: number; unit_minor: number; line_minor: number }>;
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: string;
  notes: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

const ICON: Record<OrderStatus, React.ReactNode> = {
  pending_payment: <Clock className="h-5 w-5 text-amber-700 dark:text-amber-300" aria-hidden />,
  paid: <CheckCircle2 className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden />,
  fulfilled: <PackageCheck className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden />,
  cancelled: <XCircle className="h-5 w-5 text-muted-foreground" aria-hidden />,
  refunded: <XCircle className="h-5 w-5 text-muted-foreground" aria-hidden />,
};
const BLURB: Record<OrderStatus, string> = {
  pending_payment: "We are waiting for your payment. Pay now to confirm the order.",
  paid: "Payment received. We are getting your order ready.",
  fulfilled: "Your order has been dispatched or is ready for collection.",
  cancelled: "This order was cancelled.",
  refunded: "This order was cancelled and refunded.",
};

const when = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default function OrderStatusPage() {
  const { org, token } = useParams<{ org: string; token: string }>();
  const { shop } = useShop(org);
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [canPay, setCanPay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const url = `/api/shop/${encodeURIComponent(org)}/orders/${encodeURIComponent(token)}`;
  const base = `/shop/${encodeURIComponent(org)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) throw new Error("This order link is invalid or has expired. Check the link in your confirmation email.");
      if (!res.ok) throw new Error(await readError(res, "Could not load the order"));
      const json = (await res.json()) as { order: PublicOrder; can_pay: boolean };
      setOrder(json.order);
      setCanPay(json.can_pay);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the order.");
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);

  async function payAgain() {
    setPaying(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Could not start payment"));
      const json = (await res.json()) as { pay_url: string };
      window.location.assign(json.pay_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start payment.");
      setPaying(false);
    }
  }

  if (loading) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" className={cn(SHOP_WIDTH, "max-w-3xl py-6 sm:py-8")}>
        <div className="h-11" aria-hidden />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="mt-2 h-8 w-48" />
        <Skeleton className="mt-4 h-20 w-full rounded-xl" />
        <div className="mt-6 grid gap-6 sm:grid-cols-[1fr_280px]" aria-hidden>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
        <span className="sr-only">Loading order…</span>
      </div>
    );
  }
  if (error && !order) {
    return (
      <PageState>
        <ErrorState message={error} onRetry={load} />
        <Link href={base} className="mt-4 inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Back to the shop
        </Link>
      </PageState>
    );
  }
  if (!order) return null;

  return (
    <>
      <ShopNav org={org} title={shop?.name ?? "Shop"} units={null} current="order" />
      <div className={cn(SHOP_WIDTH, "max-w-3xl py-6 sm:py-8")}>
        <p className="text-sm text-muted-foreground">Order</p>
        <h1 className="break-words text-2xl font-semibold tracking-tight">{order.number}</h1>

        <div className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-border bg-card p-4" role="status">
          <span className="mt-0.5 shrink-0">{ICON[order.status]}</span>
          <div className="min-w-0 flex-1 basis-48">
            <p className="font-medium">{order.status_label}</p>
            <p className="text-sm text-muted-foreground">{BLURB[order.status]}</p>
            {order.paid_at && <p className="mt-1 text-xs text-muted-foreground">Paid {when(order.paid_at)}</p>}
            {order.fulfilled_at && <p className="mt-1 text-xs text-muted-foreground">Fulfilled {when(order.fulfilled_at)}</p>}
          </div>
          {canPay && (
            <Button type="button" touch className="w-full shrink-0 sm:ml-auto sm:w-auto" onClick={() => void payAgain()} disabled={paying} aria-busy={paying || undefined}>
              {paying && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              Pay {money(order.total_minor, order.currency)}
            </Button>
          )}
        </div>
        {error && <Banner tone="error" className="mb-0 mt-3">{error}</Banner>}

        <section className="mt-6 grid gap-6 sm:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <h2 className="mb-2 text-sm font-semibold">Items</h2>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
              {order.items.map((it, i) => (
                <li key={i} className="flex justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 break-words">
                    <span className="tabular-nums text-muted-foreground">{it.qty} ×</span> {it.description}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(it.line_minor, order.currency)}</span>
                </li>
              ))}
            </ul>
            <h2 className="mb-2 mt-6 text-sm font-semibold">Delivery</h2>
            <p className="whitespace-pre-line break-words text-sm text-muted-foreground">{order.shipping_text || "Collection in person"}</p>
            {order.notes && (
              <>
                <h2 className="mb-2 mt-6 text-sm font-semibold">Your notes</h2>
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{order.notes}</p>
              </>
            )}
          </div>
          <aside className="h-fit rounded-xl border border-border bg-card p-4" aria-label="Order totals">
            <Totals cart={{ ...order, prices_include_tax: false }} showShipping={order.shipping_minor > 0 || Boolean(order.shipping_text)} />
            <p className="mt-3 text-xs text-muted-foreground">
              Placed {when(order.created_at)} by {order.customer_name}.
            </p>
            {shop?.support_email && (
              <p className="mt-2 text-xs text-muted-foreground">
                Questions?{" "}
                <a href={`mailto:${shop.support_email}?subject=Order ${order.number}`} className="rounded underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Email {shop.brand_name}
                </a>
              </p>
            )}
          </aside>
        </section>
        <Link href={base} className="mt-8 inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Back to the shop
        </Link>
      </div>
    </>
  );
}
