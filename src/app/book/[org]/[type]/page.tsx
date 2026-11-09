"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Payload {
  org: { name: string; slug: string };
  type: { slug: string; name: string; description: string | null; durationMinutes: number; priceMinor: number | null; currency: string | null; maxDaysAhead: number };
  timezone: string;
  slots: string[];
  byDay: Record<string, string[]>;
}

const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
const fmtDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
const fmtMoney = (minor: number, currency: string | null) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(minor / 100);

export default function PublicBookingPage() {
  const params = useParams<{ org: string; type: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState(() => new Date());
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ startsAt: string; cancelPath: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = weekStart.toISOString();
      const to = new Date(weekStart.getTime() + 14 * 86_400_000).toISOString();
      const res = await fetch(`/api/book/${params.org}/${params.type}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (res.status === 404) throw new Error("This booking page is not available.");
      if (!res.ok) throw new Error("Could not load availability.");
      const json: Payload = await res.json();
      setData(json);
      const first = Object.keys(json.byDay)[0] ?? null;
      setDay((d) => (d && json.byDay[d] ? d : first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load availability.");
    } finally {
      setLoading(false);
    }
  }, [params.org, params.type, weekStart]);

  useEffect(() => { void load(); }, [load]);

  const days = useMemo(() => Object.keys(data?.byDay ?? {}), [data]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slot) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/book/${params.org}/${params.type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, startsAt: slot }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setSlot(null);
        await load();
        throw new Error("Sorry, that time was just taken. Please pick another.");
      }
      if (!res.ok) throw new Error(json.error ?? "Could not complete the booking.");
      setDone({ startsAt: json.booking.startsAt, cancelPath: json.cancelPath });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete the booking.");
    } finally {
      setSubmitting(false);
    }
  }

  const tz = data?.timezone ?? "UTC";

  if (done) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <Check className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold">You&apos;re booked</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data?.type.name} with {data?.org.name} on{" "}
            <span className="font-medium text-foreground">
              {new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(new Date(done.startsAt))}
            </span>{" "}
            ({tz}).
          </p>
          <p className="mt-4 text-xs text-muted-foreground">A confirmation has been sent to {form.email}.</p>
          <a href={done.cancelPath} className="mt-6 inline-block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Need to cancel? Use this link.
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{data?.org.name ?? ""}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarDays className="h-6 w-6 text-primary" />
          {data?.type.name ?? "Book a time"}
        </h1>
        {data?.type.description && <p className="mt-2 text-sm text-muted-foreground">{data.type.description}</p>}
        {data && (
          <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {data.type.durationMinutes} min</span>
            {data.type.priceMinor != null && <span>{fmtMoney(data.type.priceMinor, data.type.currency)}</span>}
            <span>Times shown in {tz}</span>
          </p>
        )}
      </header>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

      <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">Pick a day</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => setWeekStart((w) => new Date(Math.max(Date.now(), w.getTime() - 14 * 86_400_000)))} aria-label="Earlier">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => setWeekStart((w) => new Date(w.getTime() + 14 * 86_400_000))} aria-label="Later">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : days.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">No openings in this range. Try later dates.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {days.map((k) => (
                <button type="button"
                  key={k}
                  onClick={() => { setDay(k); setSlot(null); }}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    day === k ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/60"
                  )}
                >
                  <div className="font-medium">{fmtDay(k)}</div>
                  <div className="text-[11px] text-muted-foreground">{data?.byDay[k].length} open</div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <span className="text-sm font-medium">{day ? fmtDay(day) : "Pick a time"}</span>
          <div className="mt-3 grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pr-1">
            {(day ? data?.byDay[day] ?? [] : []).map((iso) => (
              <button type="button"
                key={iso}
                onClick={() => setSlot(iso)}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-sm transition-colors",
                  slot === iso ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary/60"
                )}
              >
                {fmtTime(iso, tz)}
              </button>
            ))}
          </div>

          {slot && (
            <form onSubmit={submit} className="mt-5 space-y-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                Booking {fmtDay(day ?? "")} at {fmtTime(slot, tz)}
              </p>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone (optional)"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything we should know? (optional)" rows={2}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirm booking
              </Button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
