"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, SkeletonList } from "@/components/ui/feedback";
import type { PortalBooking, PortalData } from "@/lib/portal";
import { EmptyNote, Section, whenIn } from "./portal-ui";

interface SlotsResponse {
  timezone: string;
  durationMinutes: number;
  slots: string[];
}

/** Bookings: list, reschedule with slot picker, cancel with confirmation. */
export function BookingsTab({ data, token, onChanged }: { data: PortalData; token: string; onChanged: () => Promise<void> }) {
  const [resched, setResched] = useState<PortalBooking | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PortalBooking | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const past = data.bookings.filter((b) => !data.upcomingBookings.some((u) => u.id === b.id));

  return (
    <div className="space-y-4">
      {notice && <div role="status"><Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner></div>}
      <Section
        icon={CalendarDays}
        title="Upcoming appointments"
        id="bk-upcoming"
        aside={data.bookPath ? <Button asChild size="sm" variant="outline" touch><a href={data.bookPath}>Book a time</a></Button> : undefined}
      >
        {data.upcomingBookings.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <EmptyNote text="You have no upcoming appointments." />
            {data.bookPath && <Button asChild size="sm" touch><a href={data.bookPath}>Book a time</a></Button>}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.upcomingBookings.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <div className="font-medium">{b.typeName ?? "Appointment"}</div>
                  <div className="text-xs text-muted-foreground">{whenIn(b.startsAt, data.timezone)} ({data.timezone})</div>
                  {!b.canChange && <div className="mt-0.5 text-xs text-muted-foreground">Changes close {data.changeWindowHours}h before the start. Contact us to change this one.</div>}
                </div>
                {b.canChange && (
                  <div className="flex gap-2">
                    {b.hasType && <Button size="sm" variant="outline" touch onClick={() => setResched(b)}>Reschedule</Button>}
                    <Button size="sm" variant="outline" touch onClick={() => setCancelTarget(b)}>Cancel</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {past.length > 0 && (
        <Section icon={CalendarDays} title="Recent" id="bk-past">
          <ul className="divide-y divide-border/60">
            {past.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{b.typeName ?? "Appointment"} · {whenIn(b.startsAt, data.timezone)}</span>
                <span className="text-xs capitalize text-muted-foreground">{b.status.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {resched && (
        <RescheduleDialog
          booking={resched}
          token={token}
          onClose={() => setResched(null)}
          onDone={async () => {
            setResched(null);
            setNotice({ tone: "success", text: "Your appointment was rescheduled. A confirmation is on its way by email." });
            await onChanged();
          }}
        />
      )}
      {cancelTarget && (
        <CancelDialog
          booking={cancelTarget}
          token={token}
          tz={data.timezone}
          onClose={() => setCancelTarget(null)}
          onDone={async () => {
            setCancelTarget(null);
            setNotice({ tone: "success", text: "Your appointment was cancelled." });
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function RescheduleDialog({ booking, token, onClose, onDone }: { booking: PortalBooking; token: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [slots, setSlots] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setSlots(null);
    try {
      const from = new Date();
      const to = new Date(Date.now() + 14 * 86_400_000);
      const r = await fetch(`/api/p/portal/${token}/bookings?bookingId=${encodeURIComponent(booking.id)}&from=${from.toISOString()}&to=${to.toISOString()}`);
      if (!r.ok) throw new Error("Could not load available times.");
      setSlots((await r.json()) as SlotsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load available times.");
    }
  }, [token, booking.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => {
    const out = new Map<string, { label: string; short: string; morning: string[]; afternoon: string[] }>();
    if (!slots) return [] as Array<{ key: string; label: string; short: string; morning: string[]; afternoon: string[] }>;
    const tz = slots.timezone;
    const keyFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz });
    const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz });
    const long = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: tz });
    const short = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: tz });
    for (const s of slots.slots) {
      const d = new Date(s);
      const k = keyFmt.format(d);
      const cur = out.get(k) ?? { label: long.format(d), short: short.format(d), morning: [], afternoon: [] };
      (Number(hourFmt.format(d)) < 12 ? cur.morning : cur.afternoon).push(s);
      out.set(k, cur);
    }
    return [...out.entries()].map(([key, v]) => ({ key, ...v }));
  }, [slots]);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const activeDay = days.find((d) => d.key === dayKey) ?? days[0] ?? null;

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/p/portal/${token}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId: booking.id, startsAt: picked }) });
      if (r.status === 409) {
        setPicked(null);
        setError("That time was just taken. Please pick another.");
        await load();
        return;
      }
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? "Could not reschedule.");
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reschedule.");
    } finally {
      setBusy(false);
    }
  }

  const timeFmt = slots ? new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone: slots.timezone }) : null;

  return (
    <Dialog title="Reschedule appointment" description={`Pick a new time for your ${booking.typeName ?? "appointment"}.`} onClose={onClose}>
      {error && <Banner tone="error">{error}</Banner>}
      {!slots ? (
        <SkeletonList count={3} itemClassName="h-10" label="Loading available times…" />
      ) : days.length === 0 ? (
        <EmptyNote text="No open times in the next two weeks. Please contact us to arrange a time." />
      ) : (
        <div className="space-y-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Globe className="h-3.5 w-3.5" aria-hidden /> Times shown in {slots.timezone}</p>
          <div role="group" aria-label="Choose a day" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
            {days.map((d) => {
              const on = activeDay?.key === d.key;
              const has = picked !== null && [...d.morning, ...d.afternoon].includes(picked);
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  aria-label={d.label}
                  onClick={() => setDayKey(d.key)}
                  className={`relative min-h-11 shrink-0 touch-manipulation rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary/60"}`}
                >
                  {d.short}
                  {has && <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden><Check className="h-3 w-3" /></span>}
                </button>
              );
            })}
          </div>
          {activeDay && (
            <div className="max-h-64 space-y-3 overflow-y-auto" role="group" aria-label={`Available times on ${activeDay.label}`}>
              {([["Morning", activeDay.morning], ["Afternoon and evening", activeDay.afternoon]] as const).map(([title, list]) =>
                list.length === 0 ? null : (
                  <div key={title}>
                    <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {list.map((s) => {
                        const on = picked === s;
                        return (
                          <button
                            key={s}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setPicked(s)}
                            className={`inline-flex min-h-11 touch-manipulation items-center justify-center gap-1 rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 ${on ? "border-primary bg-primary font-semibold text-primary-foreground ring-2 ring-primary/40" : "border-border hover:bg-secondary/60"}`}
                          >
                            {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                            {timeFmt?.format(new Date(s))}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
          <p className="sr-only" role="status">{picked && timeFmt ? `Selected ${timeFmt.format(new Date(picked))}` : ""}</p>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" touch onClick={onClose}>Keep current time</Button>
        <Button touch disabled={!picked || busy} onClick={() => void confirm()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Confirm new time
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function CancelDialog({ booking, token, tz, onClose, onDone }: { booking: PortalBooking; token: string; tz: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/p/portal/${token}/bookings/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId: booking.id }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? "Could not cancel.");
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Cancel this appointment?" description={`${booking.typeName ?? "Appointment"} · ${whenIn(booking.startsAt, tz)}`} onClose={onClose}>
      {error && <Banner tone="error">{error}</Banner>}
      <p className="text-sm text-muted-foreground">We will let the team know. You can book a new time whenever you like.</p>
      <DialogFooter>
        <Button variant="outline" touch onClick={onClose}>Keep appointment</Button>
        <Button variant="destructive" touch disabled={busy} onClick={() => void run()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Cancel appointment
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
