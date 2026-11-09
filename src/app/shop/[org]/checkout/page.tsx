"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { money, PageState, readError, ShopNav, TaxNote, Totals, useCart, useShop } from "@/components/shop/shop-ui";

type Delivery = "ship" | "pickup";

export default function CheckoutPage() {
  const { org } = useParams<{ org: string }>();
  const { shop, loading: shopLoading, error: shopError, reload } = useShop(org);
  const [delivery, setDelivery] = useState<Delivery>("pickup");
  const effective: Delivery = shop ? (shop.collect_shipping ? (shop.pickup_enabled ? delivery : "ship") : "pickup") : delivery;
  const cart = useCart(org, { pickup: effective === "pickup" });
  const [form, setForm] = useState({ name: "", email: "", phone: "", line1: "", line2: "", city: "", region: "", postal_code: "", country: "", notes: "", marketing: false, terms: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/shop/${encodeURIComponent(org)}`;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!shop) return;
    setSubmitting(true);
    setError(null);
    try {
      if (shop.terms_md && !form.terms) throw new Error("Please accept the terms to continue.");
      const shipping = effective === "ship" ? { line1: form.line1, line2: form.line2 || undefined, city: form.city, region: form.region || undefined, postal_code: form.postal_code || undefined, country: form.country } : null;
      const res = await fetch(`/api/shop/${encodeURIComponent(org)}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: form.name, email: form.email, phone: form.phone || undefined, shipping, consent: { marketing: form.marketing }, notes: form.notes || undefined }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not place the order"));
      const json = (await res.json()) as { pay_url: string; status_url: string };
      window.location.assign(json.pay_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not place the order.");
      setSubmitting(false);
    }
  }

  if (shopLoading || cart.loading) return <PageState><Loading label="Loading checkout…" /></PageState>;
  if (shopError || !shop) return <PageState><ErrorState message={shopError ?? "This shop is not available."} onRetry={reload} /></PageState>;
  const c = cart.cart;
  if (!c || c.items.length === 0) {
    return (
      <>
        <ShopNav org={org} title={shop.name} units={0} current="checkout" />
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"><Empty title="Your cart is empty" action={<Button asChild><Link href={base}>Browse the shop</Link></Button>} /></div>
      </>
    );
  }
  const showDeliveryChoice = shop.collect_shipping && shop.pickup_enabled;

  return (
    <>
      <ShopNav org={org} title={shop.name} units={c.units} current="checkout" />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Checkout</h1>
        <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold">Your details</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" required><Input value={form.name} onChange={set("name")} autoComplete="name" required maxLength={200} /></Field>
                <Field label="Email" required hint="Your order confirmation goes here."><Input type="email" value={form.email} onChange={set("email")} autoComplete="email" required maxLength={320} /></Field>
                <Field label="Phone"><Input type="tel" value={form.phone} onChange={set("phone")} autoComplete="tel" maxLength={40} /></Field>
              </div>
            </section>
            {shop.collect_shipping && (
              <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
                <h2 className="mb-3 text-sm font-semibold">Delivery</h2>
                {showDeliveryChoice && (
                  <fieldset className="mb-4 grid gap-2 sm:grid-cols-2">
                    <legend className="sr-only">Delivery method</legend>
                    {(["pickup", "ship"] as const).map((d) => (
                      <label key={d} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-sm ${effective === d ? "border-primary ring-1 ring-primary" : "border-border"}`}>
                        <span className="flex items-center gap-2">
                          <input type="radio" name="delivery" value={d} checked={effective === d} onChange={() => setDelivery(d)} className="h-4 w-4 accent-[var(--brand-primary)]" />
                          {d === "pickup" ? "Collect in person" : "Ship to me"}
                        </span>
                        <span className="text-muted-foreground tabular-nums">{d === "pickup" ? "Free" : shop.shipping_flat_minor > 0 ? money(shop.shipping_flat_minor, shop.currency) : "Free"}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {effective === "ship" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Address line 1" required className="sm:col-span-2"><Input value={form.line1} onChange={set("line1")} autoComplete="address-line1" required maxLength={200} /></Field>
                    <Field label="Address line 2" className="sm:col-span-2"><Input value={form.line2} onChange={set("line2")} autoComplete="address-line2" maxLength={200} /></Field>
                    <Field label="City" required><Input value={form.city} onChange={set("city")} autoComplete="address-level2" required maxLength={100} /></Field>
                    <Field label="State / region"><Input value={form.region} onChange={set("region")} autoComplete="address-level1" maxLength={100} /></Field>
                    <Field label="Postal code"><Input value={form.postal_code} onChange={set("postal_code")} autoComplete="postal-code" maxLength={32} /></Field>
                    <Field label="Country" required><Input value={form.country} onChange={set("country")} autoComplete="country-name" required maxLength={64} /></Field>
                  </div>
                )}
              </section>
            )}
            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold">Anything else?</h2>
              <Field label="Notes for the shop"><Textarea value={form.notes} onChange={set("notes")} rows={3} maxLength={2000} /></Field>
              <div className="mt-3 space-y-2">
                <Checkbox checked={form.marketing} onChange={set("marketing")} label="Email me about new products and offers (optional)." />
                {shop.terms_md && (
                  <Checkbox checked={form.terms} onChange={set("terms")} required label={<span>I accept the <Link href={base} className="underline underline-offset-4">terms &amp; conditions</Link>.</span>} />
                )}
              </div>
            </section>
          </div>
          <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-16">
            <h2 className="mb-3 text-sm font-semibold">Order summary</h2>
            <ul className="mb-3 divide-y divide-border text-sm">
              {c.items.map((l) => (
                <li key={l.id} className="flex justify-between gap-3 py-1.5">
                  <span className="truncate">{l.qty} × {l.name}</span>
                  <span className="shrink-0 tabular-nums">{money(l.line_minor, l.currency)}</span>
                </li>
              ))}
            </ul>
            <Totals cart={c} showShipping={shop.collect_shipping} />
            <TaxNote inclusive={c.prices_include_tax} className="mt-2" />
            {error && <Banner tone="error" className="mt-3">{error}</Banner>}
            <Button type="submit" size="lg" className="mt-4 w-full" disabled={submitting || c.unavailable.length > 0}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Lock className="mr-2 h-4 w-4" aria-hidden />}
              Pay {money(c.total_minor, c.currency)}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">You will be taken to a secure payment page.</p>
          </aside>
        </form>
      </div>
    </>
  );
}
