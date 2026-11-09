import type { Metadata } from "next";
import { CheckCircle2, Circle, ExternalLink, PackageCheck, RotateCcw, Truck } from "lucide-react";
import { resolveTracking, type PublicShipment } from "@/lib/shipping/public";
import { hexToHslTriplet } from "@/lib/branding";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Track your order", robots: { index: false, follow: false } };

const when = (iso: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso)) + " UTC";

const STEPS = ["label_purchased", "in_transit", "out_for_delivery", "delivered"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { label_purchased: "Label created", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered" };

function Progress({ s }: { s: PublicShipment }) {
  const idx = Math.max(0, STEPS.indexOf(s.status as (typeof STEPS)[number]));
  const exception = s.status === "exception";
  return (
    <ol className="mt-4 grid grid-cols-4 gap-1 text-center text-xs" aria-label="Delivery progress">
      {STEPS.map((st, i) => {
        const done = !exception && i <= idx;
        return (
          <li key={st} className="flex flex-col items-center gap-1" aria-current={i === idx && !exception ? "step" : undefined}>
            {done ? <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden /> : <Circle className="h-5 w-5 text-muted-foreground" aria-hidden />}
            <span className={done ? "font-medium" : "text-muted-foreground"}>{STEP_LABEL[st]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await resolveTracking(token).catch(() => null);
  if (!t) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-4 text-center">
        <h1 className="text-xl font-semibold">This tracking link is not valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">It may have expired. Use the link in your latest order email.</p>
      </main>
    );
  }
  const primary = hexToHslTriplet(t.branding.primary_color);
  return (
    <main className="min-h-screen bg-background" style={primary ? ({ "--primary": primary } as React.CSSProperties) : undefined}>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          {t.branding.logo_url ? <span role="img" aria-label={t.shop_name} className="block h-8 w-24 bg-contain bg-left bg-no-repeat" style={{ backgroundImage: `url(${JSON.stringify(t.branding.logo_url)})` }} /> : <Truck className="h-5 w-5 text-primary" aria-hidden />}
          <span className="font-semibold">{t.shop_name}</span>
        </div>
      </header>
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8">
        <p className="text-sm text-muted-foreground">Tracking</p>
        <h1 className="break-words text-2xl font-semibold tracking-tight">{t.order_number ? `Order ${t.order_number}` : "Your package"}</h1>
        {t.shipments.length === 0 && (
          <p className="mt-6 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Your order has not shipped yet. We will email you the moment it does.</p>
        )}
        {t.shipments.map((s) => (
          <section key={s.id} className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-label={`Shipment ${s.tracking_number ?? ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-lg font-semibold">
                  {s.is_return ? <RotateCcw className="h-5 w-5 text-primary" aria-hidden /> : s.status === "delivered" ? <PackageCheck className="h-5 w-5 text-primary" aria-hidden /> : <Truck className="h-5 w-5 text-primary" aria-hidden />}
                  {s.is_return ? `Return: ${s.status_label}` : s.status_label}
                </p>
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {[s.carrier, s.service].filter(Boolean).join(" ")}
                  {s.tracking_number ? ` · ${s.tracking_number}` : ""}
                  {s.destination ? ` · to ${s.destination}` : ""}
                </p>
              </div>
              {s.tracking_url && (
                <a href={s.tracking_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-md text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Carrier page <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              )}
            </div>
            {!s.is_return && <Progress s={s} />}
            {s.can_download_label && (
              <a href={`/api/track/${encodeURIComponent(token)}/label`} className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Download return label
              </a>
            )}
            {s.items.length > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                {s.items.map((i) => `${i.qty} × ${i.description}`).join(", ")}
              </p>
            )}
            <h2 className="mb-2 mt-5 text-sm font-semibold">History</h2>
            {s.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scans yet.</p>
            ) : (
              <ol className="space-y-3 border-l border-border pl-4">
                {[...s.events].reverse().map((e, i) => (
                  <li key={`${e.occurred_at}-${i}`} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
                    <p className="font-medium">{e.description ?? e.status.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {when(e.occurred_at)}
                      {e.location ? ` · ${e.location}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
        {t.branding.support_email && (
          <p className="mt-8 text-xs text-muted-foreground">
            Questions? <a className="underline underline-offset-4" href={`mailto:${t.branding.support_email}`}>Email {t.shop_name}</a>
          </p>
        )}
      </div>
    </main>
  );
}
