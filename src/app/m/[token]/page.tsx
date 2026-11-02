"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CalendarDays, Check, CheckCircle2, Circle, Clock, LifeBuoy, ListTodo, Loader2, MessageSquarePlus, Phone, RefreshCw } from "lucide-react";
import type { CrewDay } from "@/lib/crew";
import { cn } from "@/lib/utils";

type Notice = { tone: "ok" | "error"; text: string };

const time = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
const longDate = (ymd: string) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));

function Skeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label="Loading your day">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-secondary motion-reduce:animate-none" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default function CrewPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [day, setDay] = useState<CrewDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteBooking, setNoteBooking] = useState<string>("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(token)}?tz=${encodeURIComponent(tz)}`, { cache: "no-store" });
      if (res.status === 404) throw new Error("This crew link is not valid any more. Ask the office for a new one.");
      if (!res.ok) throw new Error("Could not load today's schedule.");
      setDay((await res.json()) as CrewDay);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load today's schedule.");
    }
  }, [token, tz]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>, okText: string) {
    setBusy(key);
    setNotice(null);
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "That didn't work. Try again.");
      setNotice({ tone: "ok", text: okText });
      await load();
      return true;
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "That didn't work. Try again." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      noteRef.current?.focus();
      return;
    }
    const ok = await act("note", { action: "add_note", note: note.trim(), bookingId: noteBooking || null }, "Note sent to the office.");
    if (ok) {
      setNote("");
      setNoteBooking("");
    }
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 py-16 text-center">
        <AlertTriangle className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">Link unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <button type="button" onClick={() => void load()} className="mt-6 inline-flex h-12 items-center gap-2 rounded-xl border border-border px-5 text-sm font-medium hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </button>
      </div>
    );
  }

  const openTasks = day?.tasks.filter((t) => !t.done) ?? [];
  const doneTasks = day?.tasks.filter((t) => t.done) ?? [];
  const clockedIn = Boolean(day?.clockedInAt);

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-24 pt-5 sm:max-w-lg">
      <header className="mb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{day?.workspace ?? "Crew mode"}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{day ? longDate(day.date) : "Today"}</h1>
        {day && (
          <p className="mt-1 text-sm text-muted-foreground">
            Hi {day.label}. {openTasks.length} open task{openTasks.length === 1 ? "" : "s"}, {day.bookings.length} booking{day.bookings.length === 1 ? "" : "s"}
            {day.openTickets !== null ? `, ${day.openTickets} open ticket${day.openTickets === 1 ? "" : "s"}` : ""}.
          </p>
        )}
      </header>

      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} aria-live="polite" className={cn("mb-4 flex items-start gap-2 rounded-xl px-4 py-3 text-sm", notice.tone === "ok" ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300")}>
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{notice.text}</span>
        </div>
      )}

      {!day ? (
        <Skeleton />
      ) : (
        <div className="space-y-6">
          {day.timeTracking && (
            <section aria-labelledby="clock-heading" className="rounded-2xl border border-border bg-card p-4">
              <h2 id="clock-heading" className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4 text-primary" aria-hidden /> Time
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{clockedIn ? `Clocked in since ${time(day.clockedInAt as string, day.timezone)}.` : "You are not clocked in."}</p>
              <button
                type="button"
                disabled={busy === "clock"}
                onClick={() => void act("clock", { action: clockedIn ? "clock_out" : "clock_in" }, clockedIn ? "Clocked out. Nice work." : "Clocked in.")}
                className={cn(
                  "mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  clockedIn ? "border border-border bg-background" : "bg-primary text-primary-foreground"
                )}
              >
                {busy === "clock" ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Clock className="h-5 w-5" aria-hidden />}
                {clockedIn ? "Clock out" : "Clock in"}
              </button>
            </section>
          )}

          <section aria-labelledby="bookings-heading">
            <h2 id="bookings-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <CalendarDays className="h-4 w-4 text-primary" aria-hidden /> Today&apos;s bookings
            </h2>
            {day.bookings.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No bookings today.</p>
            ) : (
              <ul className="space-y-2">
                {day.bookings.map((b) => (
                  <li key={b.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold leading-tight">{b.name}</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {time(b.starts_at, day.timezone)} – {time(b.ends_at, day.timezone)}
                          {b.status !== "confirmed" ? ` · ${b.status.replace("_", " ")}` : ""}
                        </p>
                      </div>
                      {b.phone && (
                        <a href={`tel:${b.phone.replace(/[^\d+]/g, "")}`} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Call ${b.name}`}>
                          <Phone className="h-5 w-5" aria-hidden />
                        </a>
                      )}
                    </div>
                    {b.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{b.notes}</p>}
                    <button
                      type="button"
                      onClick={() => {
                        setNoteBooking(b.id);
                        noteRef.current?.focus();
                        noteRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      className="mt-3 inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MessageSquarePlus className="h-4 w-4" aria-hidden /> Add a note
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="tasks-heading">
            <h2 id="tasks-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ListTodo className="h-4 w-4 text-primary" aria-hidden /> Tasks
            </h2>
            {day.tasks.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Nothing on the list. Enjoy the quiet.</p>
            ) : (
              <ul className="space-y-2">
                {[...openTasks, ...doneTasks].map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={t.done}
                      disabled={busy === t.id}
                      onClick={() => void act(t.id, { action: "complete_task", taskId: t.id, done: !t.done }, t.done ? "Task reopened." : "Task completed.")}
                      className={cn(
                        "flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                        t.done && "bg-secondary/60"
                      )}
                    >
                      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2", t.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-border")} aria-hidden>
                        {busy === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : t.done ? <Check className="h-4 w-4" /> : <Circle className="h-0 w-0" />}
                      </span>
                      <span className={cn("min-w-0 flex-1 break-words text-base", t.done && "text-muted-foreground line-through")}>{t.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="note-heading" className="rounded-2xl border border-border bg-card p-4">
            <h2 id="note-heading" className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquarePlus className="h-4 w-4 text-primary" aria-hidden /> Send a note to the office
            </h2>
            <form onSubmit={(e) => void submitNote(e)} className="mt-3 space-y-3">
              {day.bookings.length > 0 && (
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">About</span>
                  <select value={noteBooking} onChange={(e) => setNoteBooking(e.target.value)} className="h-12 w-full rounded-lg border border-border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="">General note</option>
                    {day.bookings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {time(b.starts_at, day.timezone)} · {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Note</span>
                <textarea
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Job done, gate code changed, customer wants a callback…"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <button type="submit" disabled={busy === "note"} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
                {busy === "note" ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <MessageSquarePlus className="h-5 w-5" aria-hidden />} Send note
              </button>
            </form>
          </section>

          {day.openTickets !== null && day.openTickets > 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LifeBuoy className="h-4 w-4" aria-hidden /> {day.openTickets} support ticket{day.openTickets === 1 ? "" : "s"} open at the office.
            </p>
          )}

          <button type="button" onClick={() => void load()} className="mx-auto flex h-11 items-center gap-2 rounded-lg px-4 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </button>
        </div>
      )}
    </div>
  );
}
