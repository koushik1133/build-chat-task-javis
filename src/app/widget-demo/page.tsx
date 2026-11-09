import type { Metadata } from "next";
import Script from "next/script";
import { z } from "zod";
import { CONSENT_MODES, WIDGET_MODES, WIDGET_POSITIONS } from "@/lib/webchat/config";

/**
 * Public sample business page with the widget installed. Used by the
 * settings preview iframe and for manual testing. No auth, no data access:
 * everything comes from the public widget config route.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Widget demo — KernelHub", robots: { index: false, follow: false } };

const Params = z.object({
  site: z.string().uuid().optional(),
  mode: z.enum(WIDGET_MODES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  position: z.enum(WIDGET_POSITIONS).optional(),
  consent: z.enum(CONSENT_MODES).optional(),
  greeting: z.string().max(200).optional(),
  v: z.string().max(40).optional(),
});

export default async function WidgetDemoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const flat = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = Params.safeParse(flat);
  const p = parsed.success ? parsed.data : {};

  return (
    <main className="min-h-screen bg-[#faf7f2] text-zinc-900">
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
          <span className="text-lg font-bold tracking-tight">Bluebird Dental</span>
          <nav aria-label="Sample site" className="hidden gap-6 text-sm text-zinc-600 sm:flex">
            <span>Services</span>
            <span>Team</span>
            <span>Contact</span>
          </nav>
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-5 py-14 sm:py-20">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-600">Sample business page</p>
        <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-5xl">Gentle, modern dentistry for the whole family.</h1>
        <p className="mt-4 max-w-xl text-base text-zinc-600 sm:text-lg">
          This page exists so you can see the KernelHub widget exactly as your visitors will. Open the launcher in the corner to try chat, the contact form, booking and help.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {["Same-day appointments", "Transparent pricing", "Evening & weekend hours"].map((t) => (
            <div key={t} className="rounded-xl border border-zinc-200 bg-white p-4 text-sm font-medium shadow-sm">
              {t}
            </div>
          ))}
        </div>
      </section>
      {!p.site ? (
        <p role="status" className="mx-auto max-w-4xl px-5 pb-10 text-sm text-zinc-500">
          Add <code className="rounded bg-zinc-100 px-1">?site=&lt;site id&gt;</code> to the URL to load a widget here.
        </p>
      ) : (
        <Script
          key={`${p.site}-${p.v ?? ""}-${p.mode ?? ""}-${p.color ?? ""}-${p.position ?? ""}-${p.consent ?? ""}`}
          src={`/api/widget.js${p.v ? `?v=${encodeURIComponent(p.v)}` : ""}`}
          strategy="afterInteractive"
          data-site={p.site}
          data-mode={p.mode}
          data-color={p.color}
          data-position={p.position}
          data-consent={p.consent}
          data-greeting={p.greeting}
        />
      )}
    </main>
  );
}
