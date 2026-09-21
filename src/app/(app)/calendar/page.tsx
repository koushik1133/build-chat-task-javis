"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";

interface Rule { id?: string; weekday: number; start_minute: number; end_minute: number }
interface Calendar { id: string; name: string; timezone: string; color: string | null; rules: Rule[] }
interface BookingType {
  id: string; slug: string; name: string; description: string | null; duration_minutes: number; buffer_before: number;
  buffer_after: number; min_notice_minutes: number; max_days_ahead: number; price_minor: number | null; currency: string | null; active: boolean;
}
interface Booking {
  id: string; name: string; email: string | null; phone: string | null; starts_at: string; ends_at: string;
  status: string; source: string; booking_type_id: string | null; notes: string | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  cancelled: "bg-secondary text-muted-foreground line-through",
  no_show: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromHHMM = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };
const fmtTime = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
const dayKey = (iso: string, tz: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  return p; // YYYY-MM-DD
};

export default function CalendarPage() {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [types, setTypes] = useState<BookingType[]>([]);
  const [orgSlug, setOrgSlug] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Availability editor
  const [rules, setRules] = useState<Rule[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [savingRules, setSavingRules] = useState(false);

  // Booking type editor
  const [showType, setShowType] = useState(false);
  const [typeForm, setTypeForm] = useState({ name: "", slug: "", description: "", duration_minutes: 30, buffer_before: 0, buffer_after: 0, min_notice_minutes: 60, max_days_ahead: 30, price: "", currency: "USD" });
  const [savingType, setSavingType] = useState(false);

  // Manual booking dialog
  const [showBooking, setShowBooking] = useState(false);
  const [bookingForm, setBookingForm] = useState({ name: "", email: "", phone: "", date: "", time: "09:00", durationMinutes: 30, bookingTypeId: "", notes: "" });
  const [savingBooking, setSavingBooking] = useState(false);

  const calendar = calendars[0] ?? null;

  const loadStatic = useCallback(async () => {
    const [c, t] = await Promise.all([fetch("/api/calendar"), fetch("/api/calendar/booking-types")]);
    if (!c.ok || !t.ok) throw new Error("Could not load the calendar.");
    const cj = await c.json();
    const tj = await t.json();
    setCalendars(cj.calendars ?? []);
    setCanEdit(Boolean(cj.canEdit));
    const first: Calendar | undefined = cj.calendars?.[0];
    if (first) { setRules(first.rules); setTimezone(first.timezone); }
    setTypes(tj.types ?? []);
    setOrgSlug(tj.orgSlug ?? "");
  }, []);

  const loadBookings = useCallback(async () => {
    const from = weekStart.toISOString();
    const to = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString();
    const res = await fetch(`/api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!res.ok) throw new Error("Could not load bookings.");
    setBookings((await res.json()).bookings ?? []);
  }, [weekStart]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try { await loadStatic(); } catch (err) { setError(err instanceof Error ? err.message : "Could not load the calendar."); }
      finally { setLoading(false); }
    })();
  }, [loadStatic]);

  useEffect(() => { loadBookings().catch((err) => setError(err instanceof Error ? err.message : "Could not load bookings.")); }, [loadBookings]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000)), [weekStart]);
  const byDay = useMemo(() => {
    const m: Record<string, Booking[]> = {};
    for (const b of bookings) (m[dayKey(b.starts_at, timezone)] ??= []).push(b);
    return m;
  }, [bookings, timezone]);
  const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function flash(msg: string) { setNotice(msg); setTimeout(() => setNotice(null), 2500); }

  async function saveRules() {
    if (!calendar) return;
    setSavingRules(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarId: calendar.id, timezone, rules }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Could not save availability.");
      setRules(j.rules);
      flash("Availability saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save availability."); }
    finally { setSavingRules(false); }
  }

  async function saveType() {
    setSavingType(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/booking-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...typeForm,
          price_minor: typeForm.price.trim() ? Math.round(Number(typeForm.price) * 100) : null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error("That link slug is already in use.");
      if (!res.ok) throw new Error(j.error ?? "Could not create the booking type.");
      setTypes((t) => [...t, j.type]);
      setShowType(false);
      setTypeForm({ name: "", slug: "", description: "", duration_minutes: 30, buffer_before: 0, buffer_after: 0, min_notice_minutes: 60, max_days_ahead: 30, price: "", currency: "USD" });
      flash("Booking type created.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create the booking type."); }
    finally { setSavingType(false); }
  }

  async function toggleType(t: BookingType) {
    const res = await fetch(`/api/calendar/booking-types/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !t.active }) });
    if (res.ok) setTypes((all) => all.map((x) => (x.id === t.id ? { ...x, active: !t.active } : x)));
  }

  async function deleteType(id: string) {
    if (!confirm("Delete this booking type? Existing bookings are kept.")) return;
    const res = await fetch(`/api/calendar/booking-types/${id}`, { method: "DELETE" });
    if (res.ok) setTypes((all) => all.filter((x) => x.id !== id));
  }

  async function copyLink(t: BookingType) {
    const url = `${window.location.origin}/book/${orgSlug}/${t.slug}`;
    try { await navigator.clipboard.writeText(url); flash("Public link copied."); } catch { prompt("Copy this link:", url); }
  }

  async function createBooking() {
    setSavingBooking(true);
    setError(null);
    try {
      if (!bookingForm.date) throw new Error("Pick a date.");
      const startsAt = new Date(`${bookingForm.date}T${bookingForm.time}:00`).toISOString();
      const type = types.find((t) => t.id === bookingForm.bookingTypeId);
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: bookingForm.name, email: bookingForm.email || undefined, phone: bookingForm.phone || undefined,
          startsAt, durationMinutes: type ? undefined : bookingForm.durationMinutes,
          bookingTypeId: type?.id, notes: bookingForm.notes || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error("That time clashes with another booking.");
      if (!res.ok) throw new Error(j.error ?? "Could not create the booking.");
      setShowBooking(false);
      setBookingForm({ name: "", email: "", phone: "", date: "", time: "09:00", durationMinutes: 30, bookingTypeId: "", notes: "" });
      await loadBookings();
      flash("Booking created.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create the booking."); }
    finally { setSavingBooking(false); }
  }

  async function setStatus(b: Booking, action: "cancel" | "complete" | "no_show") {
    if (action === "cancel" && !confirm(`Cancel the booking with ${b.name}?`)) return;
    const res = await fetch(`/api/bookings/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    if (res.ok) await loadBookings();
  }

  const inputCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <PageContainer wide title="Calendar" description="Bookings, weekly availability and public booking links." tooltip="Customers book through your public links; the AI receptionist can book here too.">
      {error && <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><span>{error}</span><button onClick={() => setError(null)}><X className="h-4 w-4" /></button></div>}
      {notice && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</div>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading calendar…</div>
      ) : (
        <div className="space-y-6">
          {/* ── Week view ── */}
          <section className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => setWeekStart((w) => new Date(w.getTime() - 7 * 86_400_000))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
                <span className="text-sm font-medium">
                  {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(weekDays[0])} – {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(weekDays[6])}
                </span>
                <Button variant="ghost" size="icon" onClick={() => setWeekStart((w) => new Date(w.getTime() + 7 * 86_400_000))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{timezone}</span>
                {canEdit && <Button size="sm" onClick={() => setShowBooking(true)}><Plus className="h-3.5 w-3.5" /> New booking</Button>}
              </div>
            </div>
            <div className="grid grid-cols-1 divide-y divide-border/60 md:grid-cols-7 md:divide-x md:divide-y-0">
              {weekDays.map((d) => {
                const k = localKey(d);
                const items = (byDay[k] ?? []).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
                const isToday = k === localKey(new Date());
                return (
                  <div key={k} className="min-h-[9rem] p-2">
                    <div className={cn("mb-2 text-xs font-medium", isToday ? "text-primary" : "text-muted-foreground")}>
                      {DAY_NAMES[d.getDay()]} <span className="ml-1">{d.getDate()}</span>
                    </div>
                    <div className="space-y-1.5">
                      {items.map((b) => (
                        <div key={b.id} className={cn("group rounded-md px-2 py-1.5 text-xs", STATUS_STYLE[b.status] ?? "bg-secondary")}>
                          <div className="font-medium truncate">{fmtTime(b.starts_at, timezone)} · {b.name}</div>
                          <div className="truncate opacity-80">{types.find((t) => t.id === b.booking_type_id)?.name ?? "Appointment"} · {b.source}</div>
                          {canEdit && b.status === "confirmed" && (
                            <div className="mt-1 hidden gap-1 group-hover:flex">
                              <button onClick={() => setStatus(b, "complete")} className="rounded bg-background/70 px-1.5 py-0.5 hover:bg-background">Done</button>
                              <button onClick={() => setStatus(b, "no_show")} className="rounded bg-background/70 px-1.5 py-0.5 hover:bg-background">No-show</button>
                              <button onClick={() => setStatus(b, "cancel")} className="rounded bg-background/70 px-1.5 py-0.5 hover:bg-background">Cancel</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* ── Availability editor ── */}
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Weekly availability</h2>
                {canEdit && <Button size="sm" onClick={saveRules} disabled={savingRules}>{savingRules ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save</Button>}
              </div>
              <label className="mb-3 block text-xs text-muted-foreground">
                Timezone
                <input value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit} placeholder="e.g. America/New_York" className={cn(inputCls, "mt-1")} />
              </label>
              <div className="space-y-2">
                {DAY_NAMES.map((name, weekday) => {
                  const dayRules = rules.map((r, i) => ({ r, i })).filter(({ r }) => r.weekday === weekday);
                  return (
                    <div key={weekday} className="flex items-start gap-3 text-sm">
                      <span className="w-10 pt-1.5 text-xs font-medium text-muted-foreground">{name}</span>
                      <div className="flex-1 space-y-1.5">
                        {dayRules.length === 0 && <span className="block pt-1.5 text-xs text-muted-foreground">Unavailable</span>}
                        {dayRules.map(({ r, i }) => (
                          <div key={i} className="flex items-center gap-2">
                            <input type="time" value={toHHMM(r.start_minute)} disabled={!canEdit} onChange={(e) => setRules((all) => all.map((x, j) => (j === i ? { ...x, start_minute: fromHHMM(e.target.value) } : x)))} className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
                            <span className="text-xs text-muted-foreground">to</span>
                            <input type="time" value={toHHMM(r.end_minute)} disabled={!canEdit} onChange={(e) => setRules((all) => all.map((x, j) => (j === i ? { ...x, end_minute: fromHHMM(e.target.value) } : x)))} className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
                            {canEdit && <button onClick={() => setRules((all) => all.filter((_, j) => j !== i))} className="rounded p-1 hover:bg-secondary" aria-label="Remove"><X className="h-3.5 w-3.5 text-muted-foreground" /></button>}
                          </div>
                        ))}
                      </div>
                      {canEdit && <button onClick={() => setRules((all) => [...all, { weekday, start_minute: 9 * 60, end_minute: 17 * 60 }])} className="rounded p-1.5 hover:bg-secondary" aria-label="Add window"><Plus className="h-3.5 w-3.5 text-muted-foreground" /></button>}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ── Booking types ── */}
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Booking types</h2>
                {canEdit && <Button size="sm" variant="outline" onClick={() => setShowType(true)}><Plus className="h-3.5 w-3.5" /> New type</Button>}
              </div>
              {types.length === 0 ? (
                <p className="text-sm text-muted-foreground">No booking types yet. Create one to get a public booking link.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {types.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{t.name}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[10px]", t.active ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-secondary text-muted-foreground")}>{t.active ? "live" : "off"}</span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {t.duration_minutes} min · /book/{orgSlug}/{t.slug}
                          {t.price_minor != null && ` · ${new Intl.NumberFormat(undefined, { style: "currency", currency: t.currency ?? "USD" }).format(t.price_minor / 100)}`}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => copyLink(t)} aria-label="Copy public link"><Copy className="h-3.5 w-3.5" /></Button>
                        {canEdit && <Button variant="ghost" size="icon" onClick={() => toggleType(t)} aria-label={t.active ? "Turn off" : "Turn on"}>{t.active ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}</Button>}
                        {canEdit && <Button variant="ghost" size="icon" onClick={() => deleteType(t.id)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {/* ── New booking type dialog ── */}
      {showType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowType(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold">New booking type</h3><button onClick={() => setShowType(false)}><X className="h-4 w-4" /></button></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-xs text-muted-foreground">Name<input value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} className={cn(inputCls, "mt-1")} placeholder="Intro call" /></label>
              <label className="col-span-2 text-xs text-muted-foreground">Link slug (optional)<input value={typeForm.slug} onChange={(e) => setTypeForm({ ...typeForm, slug: e.target.value })} className={cn(inputCls, "mt-1")} placeholder="intro-call" /></label>
              <label className="col-span-2 text-xs text-muted-foreground">Description<textarea rows={2} value={typeForm.description} onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Duration (min)<input type="number" min={5} value={typeForm.duration_minutes} onChange={(e) => setTypeForm({ ...typeForm, duration_minutes: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Min notice (min)<input type="number" min={0} value={typeForm.min_notice_minutes} onChange={(e) => setTypeForm({ ...typeForm, min_notice_minutes: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Buffer before (min)<input type="number" min={0} value={typeForm.buffer_before} onChange={(e) => setTypeForm({ ...typeForm, buffer_before: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Buffer after (min)<input type="number" min={0} value={typeForm.buffer_after} onChange={(e) => setTypeForm({ ...typeForm, buffer_after: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Max days ahead<input type="number" min={1} value={typeForm.max_days_ahead} onChange={(e) => setTypeForm({ ...typeForm, max_days_ahead: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Price (optional)<div className="mt-1 flex gap-2"><input value={typeForm.price} onChange={(e) => setTypeForm({ ...typeForm, price: e.target.value })} className={inputCls} placeholder="0.00" /><input value={typeForm.currency} onChange={(e) => setTypeForm({ ...typeForm, currency: e.target.value })} className={cn(inputCls, "w-20")} /></div></label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowType(false)}>Cancel</Button>
              <Button onClick={saveType} disabled={savingType || !typeForm.name.trim()}>{savingType && <Loader2 className="h-4 w-4 animate-spin" />} Create</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── New booking dialog ── */}
      {showBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowBooking(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-primary" /> New booking</h3><button onClick={() => setShowBooking(false)}><X className="h-4 w-4" /></button></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-xs text-muted-foreground">Customer name<input value={bookingForm.name} onChange={(e) => setBookingForm({ ...bookingForm, name: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Email<input type="email" value={bookingForm.email} onChange={(e) => setBookingForm({ ...bookingForm, email: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Phone<input value={bookingForm.phone} onChange={(e) => setBookingForm({ ...bookingForm, phone: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Date<input type="date" value={bookingForm.date} onChange={(e) => setBookingForm({ ...bookingForm, date: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Time (your local time)<input type="time" value={bookingForm.time} onChange={(e) => setBookingForm({ ...bookingForm, time: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
              <label className="text-xs text-muted-foreground">Booking type<select value={bookingForm.bookingTypeId} onChange={(e) => setBookingForm({ ...bookingForm, bookingTypeId: e.target.value })} className={cn(inputCls, "mt-1")}><option value="">Custom</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes} min)</option>)}</select></label>
              {!bookingForm.bookingTypeId && <label className="text-xs text-muted-foreground">Duration (min)<input type="number" min={5} value={bookingForm.durationMinutes} onChange={(e) => setBookingForm({ ...bookingForm, durationMinutes: Number(e.target.value) })} className={cn(inputCls, "mt-1")} /></label>}
              <label className="col-span-2 text-xs text-muted-foreground">Notes<textarea rows={2} value={bookingForm.notes} onChange={(e) => setBookingForm({ ...bookingForm, notes: e.target.value })} className={cn(inputCls, "mt-1")} /></label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowBooking(false)}>Cancel</Button>
              <Button onClick={createBooking} disabled={savingBooking || !bookingForm.name.trim() || !bookingForm.date}>{savingBooking && <Loader2 className="h-4 w-4 animate-spin" />} Book</Button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
