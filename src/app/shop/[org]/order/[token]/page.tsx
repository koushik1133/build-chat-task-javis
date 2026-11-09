"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, Clock, Loader2, PackageCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { money, PageState, readError, ShopNav, Totals, useShop } from "@/components/shop/shop-ui";
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
  pending_payment: <Clock className="h-5 w-5 text-amber-600" aria-hidden />,
  paid: <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />,
  fulfilled: <PackageCheck className="h-5 w-5 text-emerald-600" aria-hidden />,
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

export default function OrderStatusPage() {
  const { org, token } = useParams<{ org: string; token: string }>();
  const { shop } = useShop(org);
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [canPay, setCanPay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const url = `/api/shop/${encodeURIComponent(org)}/orders/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) throw new Error("This order link is invalid or has expired.");
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

  if (loading) return <PageState><Loading label="Loading order…" /></PageState>;
  if (error && !order) return <PageState><ErrorState message={error} onRetry={load} /></PageState>;
  if (!order) return null;

  return (
    <>
      <ShopNav org={org} title={shop?.name ?? "Shop"} units={null} current="order" />
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Order</p>
        <h1 className="text-2xl font-semibold tracking-tight">{order.number}</h1>
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          {ICON[order.status]}
          <div>
            <p className="font-medium">{order.status_label}</p>
            <p className="text-sm text-muted-foreground">{BLURB[order.status]}</p>
            {order.fulfilled_at && <p className="mt-1 text-xs text-muted-foreground">Fulfilled {new Date(order.fulfilled_at).toLocaleString()}</p>}
          </div>
          {canPay && (
            <Button type="button" className="ml-auto shrink-0" onClick={() => void payAgain()} disabled={paying}>
              {paying && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              Pay now
            </Button>
          )}
        </div>
        {error && <Banner tone="error" className="mt-3">{error}</Banner>}
        <section className="mt-6 grid gap-6 sm:grid-cols-[1fr_280px]">
          <div>
            <h2 className="mb-2 text-sm font-semibold">Items</h2>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
              {order.items.map((it, i) => (
                <li key={i} className="flex justify-between gap-3 px-4 py-2.5">
                  <span>{it.qty} × {it.description}</span>
                  <span className="tabular-nums">{money(it.line_minor, order.currency)}</span>
                </li>
              ))}
            </ul>
            <h2 className="mb-2 mt-6 text-sm font-semibold">Delivery</h2>
            <p className="text-sm text-muted-foreground">{order.shipping_text || "Collection in person"}</p>
            {order.notes && (
              <>
                <h2 className="mb-2 mt-6 text-sm font-semibold">Your notes</h2>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.notes}</p>
              </>
            )}
          </div>
          <aside className="h-fit rounded-xl border border-border bg-card p-4">
            <Totals cart={{ ...order, prices_include_tax: false }} showShipping={order.shipping_minor > 0 || Boolean(order.shipping_text)} />
            <p className="mt-3 text-xs text-muted-foreground">Placed {new Date(order.created_at).toLocaleString()} by {order.customer_name}.</p>
          </aside>
        </section>
        <Link href={`/shop/${encodeURIComponent(org)}`} className="mt-8 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline">Back to the shop</Link>
      </div>
    </>
  );
}
