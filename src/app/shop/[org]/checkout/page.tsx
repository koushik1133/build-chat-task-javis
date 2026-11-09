"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2, Lock, Store, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState } from "@/components/ui/feedback";
import { CartSkeleton, money, PageState, readError, SHOP_WIDTH, ShopNav, StickyBar, TaxNote, Totals, useCart, useShop } from "@/components/shop/shop-ui";
import { cn } from "@/lib/utils";

type Delivery = "ship" | "pickup";
const FORM_ID = "checkout-form";

export default function CheckoutPage() {
  const { org } = useParams<{ org: string }>();
  const { shop, loading: shopLoading, error: shopError, reload } = useShop(org);
  const [delivery, setDelivery] = useState<Delivery>("pickup");
  const effective: Delivery = shop ? (shop.collect_shipping ? (shop.pickup_enabled ? delivery : "ship") : "pickup") : delivery;
  const cart = useCart(org, { pickup: effective === "pickup" });
  const [form, setForm] = useState({ name: "", email: "", phone: "", line1: "", line2: "", city: "", region: "", postal_code: "", country: "", notes: "", marketing: false, terms: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const base = `/shop/${encodeURIComponent(org)}`;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!shop) return;
    setError(null);
    setTermsError(null);
    if (shop.terms_md && !form.terms) {
      setTermsError("Please accept the terms to continue.");
      return;
    }
    setSubmitting(true);
    try {
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

  if (shopLoading || cart.loading) return <CartSkeleton label="Loading checkout…" />;
  if (shopError || !shop) return <PageState><ErrorState message={shopError ?? "This shop is not available."} onRetry={reload} /></PageState>;
  const c = cart.cart;
  if (!c || c.items.length === 0) {
    return (
      <>
        <ShopNav org={org} title={shop.name} units={0} current="checkout" />
        <div className={cn(SHOP_WIDTH, "py-8")}>
          <Empty
            title="Your cart is empty"
            text="Add something to the cart before checking out."
            action={
              <Button asChild touch>
                <Link href={base}>Browse the shop</Link>
              </Button>
            }
          />
        </div>
      </>
    );
  }
  const showDeliveryChoice = shop.collect_shipping && shop.pickup_enabled;
  const blocked = c.unavailable.length > 0;
  const payLabel = `Pay ${money(c.total_minor, c.currency)}`;
  const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

  return (
    <>
      <ShopNav org={org} title={shop.name} units={c.units} current="checkout" />
      <div className={cn(SHOP_WIDTH, "py-6 pb-32 sm:py-8 lg:pb-8")}>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
          <Link href={`${base}/cart`} className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
            Edit cart
          </Link>
        </div>
        {blocked && <Banner tone="error">Some items in your cart are no longer available. Go back to the cart to fix them before paying.</Banner>}
        <form id={FORM_ID} onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="co-details">
              <h2 id="co-details" className="mb-3 text-sm font-semibold">
                Your details
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" required>
                  <Input value={form.name} onChange={set("name")} autoComplete="name" required maxLength={200} enterKeyHint="next" />
                </Field>
                <Field label="Email" required hint="Your receipt and order updates go here.">
                  <Input type="email" inputMode="email" value={form.email} onChange={set("email")} autoComplete="email" required maxLength={320} enterKeyHint="next" />
                </Field>
                <Field label="Phone" hint="Only if we need to reach you about the order.">
                  <Input type="tel" inputMode="tel" value={form.phone} onChange={set("phone")} autoComplete="tel" maxLength={40} enterKeyHint="next" />
                </Field>
              </div>
            </section>

            {shop.collect_shipping && (
              <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="co-delivery">
                <h2 id="co-delivery" className="mb-3 text-sm font-semibold">
                  Delivery
                </h2>
                {showDeliveryChoice && (
                  <fieldset className="mb-4 grid gap-2 sm:grid-cols-2">
                    <legend className="sr-only">Delivery method</legend>
                    {(["pickup", "ship"] as const).map((d) => {
                      const on = effective === d;
                      return (
                        <label
                          key={d}
                          className={cn(
                            "flex min-h-11 cursor-pointer touch-manipulation items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors motion-reduce:transition-none",
                            "focus-within:ring-2 focus-within:ring-ring",
                            on ? "border-primary bg-accent/40" : "border-border hover:bg-secondary/40"
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input type="radio" name="delivery" value={d} checked={on} onChange={() => setDelivery(d)} className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-none" />
                            {d === "pickup" ? <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <Truck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                            <span className="font-medium">{d === "pickup" ? "Collect in person" : "Ship to me"}</span>
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">{d === "pickup" ? "Free" : shop.shipping_flat_minor > 0 ? money(shop.shipping_flat_minor, shop.currency) : "Free"}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                {effective === "ship" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Address line 1" required className="sm:col-span-2">
                      <Input value={form.line1} onChange={set("line1")} autoComplete="shipping address-line1" required maxLength={200} />
                    </Field>
                    <Field label="Address line 2" className="sm:col-span-2">
                      <Input value={form.line2} onChange={set("line2")} autoComplete="shipping address-line2" maxLength={200} />
                    </Field>
                    <Field label="City" required>
                      <Input value={form.city} onChange={set("city")} autoComplete="shipping address-level2" required maxLength={100} />
                    </Field>
                    <Field label="State or region">
                      <Input value={form.region} onChange={set("region")} autoComplete="shipping address-level1" maxLength={100} />
                    </Field>
                    <Field label="Postal code">
                      <Input value={form.postal_code} onChange={set("postal_code")} autoComplete="shipping postal-code" maxLength={32} />
                    </Field>
                    <Field label="Country" required>
                      <Input value={form.country} onChange={set("country")} autoComplete="shipping country-name" required maxLength={64} />
                    </Field>
                  </div>
                )}
              </section>
            )}

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="co-extra">
              <h2 id="co-extra" className="mb-3 text-sm font-semibold">
                Anything else?
              </h2>
              <Field label="Notes for the shop" hint="Optional — delivery instructions, gift message, anything we should know.">
                <Textarea value={form.notes} onChange={set("notes")} rows={3} maxLength={2000} />
              </Field>
              <div className="mt-3 space-y-1">
                <Checkbox checked={form.marketing} onChange={set("marketing")} label="Email me about new products and offers (optional)." />
                {shop.terms_md && (
                  <div>
                    <Checkbox
                      checked={form.terms}
                      onChange={(e) => {
                        setTermsError(null);
                        set("terms")(e);
                      }}
                      required
                      aria-invalid={termsError ? true : undefined}
                      aria-describedby={termsError ? "co-terms-error" : undefined}
                      label={
                        <span>
                          I accept the{" "}
                          <Link href={`${base}#terms`} className="rounded underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            terms and conditions
                          </Link>
                          .
                        </span>
                      }
                    />
                    {termsError && (
                      <p id="co-terms-error" role="alert" className="text-xs text-destructive">
                        {termsError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-16" aria-labelledby="co-summary">
            <h2 id="co-summary" className="mb-3 text-sm font-semibold">
              Order summary
            </h2>
            <ul className="mb-3 divide-y divide-border text-sm">
              {c.items.map((l) => (
                <li key={l.id} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0 break-words">
                    <span className="tabular-nums text-muted-foreground">{l.qty} ×</span> {l.name}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(l.line_minor, l.currency)}</span>
                </li>
              ))}
            </ul>
            <Totals cart={c} showShipping={shop.collect_shipping} />
            <TaxNote inclusive={c.prices_include_tax} className="mt-2" />
            {error && (
              <Banner tone="error" className="mb-0 mt-3">
                {error}
              </Banner>
            )}
            <Button type="submit" size="lg" className="mt-4 hidden w-full lg:inline-flex" disabled={submitting || blocked} aria-busy={submitting || undefined}>
              {submitting ? spinner : <Lock className="h-4 w-4" aria-hidden />}
              {submitting ? "Taking you to payment…" : payLabel}
            </Button>
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              You will pay on a secure payment page. Card details are never stored by {shop.brand_name}.
            </p>
          </aside>
        </form>
      </div>

      <StickyBar>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-base font-semibold tabular-nums">{money(c.total_minor, c.currency)}</p>
        </div>
        <Button type="submit" form={FORM_ID} size="lg" className="shrink-0" disabled={submitting || blocked} aria-busy={submitting || undefined}>
          {submitting ? spinner : <Lock className="h-4 w-4" aria-hidden />}
          {submitting ? "One moment…" : payLabel}
        </Button>
      </StickyBar>
    </>
  );
}
