"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Link2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Select } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import type { CalendarConnectionView, CalendarProviderInfo } from "@/lib/calsync/types";
import { timeAgo } from "@/lib/utils";

type Notice = { tone: "success" | "error" | "info"; text: string };
type CalendarOption = { id: string; name: string; primary: boolean };

const STATUS_TONE: Record<string, Tone> = { connected: "success", error: "danger", disabled: "neutral" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d?.error ? String(d.error) : `${fallback} (${res.status})`;
}

export default function CalendarSyncPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Calendar sync"><Loading label="Loading calendar sync…" /></PageContainer>}>
      <CalendarSync_ />
    </Suspense>
  );
}

function CalendarSync_() {
  const router = useRouter();
  const search = useSearchParams();
  const nextSignal = useAbortable();
  const [connections, setConnections] = useState<CalendarConnectionView[]>([]);
  const [providers, setProviders] = useState<CalendarProviderInfo[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<CalendarConnectionView | null>(null);
  const [feedUrl, setFeedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    try {
      const res = await fetch("/api/calsync/connections", { signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load calendar connections"));
      const d = await res.json();
      setConnections(d.connections ?? []);
      setProviders(d.providers ?? []);
      setMigrated(d.migrated !== false);
      setCanEdit(d.canEdit !== false);
      setError(null);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "Could not load calendar connections.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const err = search.get("error");
    const ok = search.get("connected");
    if (err) setNotice({ tone: "error", text: err });
    else if (ok) setNotice({ tone: "success", text: "Calendar connected." });
    if (err || ok) router.replace("/settings/calendar-sync");
  }, [search, router]);

  async function syncNow(c: CalendarConnectionView) {
    setBusy(`sync:${c.id}`);
    try {
      const res = await fetch(`/api/calsync/connections/${encodeURIComponent(c.id)}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Sync failed"));
      const d = await res.json();
      setNotice({ tone: "success", text: `Synced: ${d.pushed ?? 0} booking(s) pushed, ${d.busy ?? 0} busy block(s) pulled.` });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Sync failed." });
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function confirmDisconnect() {
    if (!disconnect) return;
    setBusy(`del:${disconnect.id}`);
    try {
      const res = await fetch(`/api/calsync/connections?id=${encodeURIComponent(disconnect.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not disconnect"));
      setDisconnect(null);
      setNotice({ tone: "success", text: "Calendar disconnected." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect." });
    } finally {
      setBusy(null);
    }
  }

  async function createFeed(rotate: boolean) {
    setBusy("feed");
    try {
      const res = await fetch("/api/calendar/feed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }) });
      if (!res.ok) throw new Error(await readError(res, "Could not create the feed link"));
      setFeedUrl((await res.json()).url);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not create the feed link." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Calendar sync"
      icon={<CalendarClock className="h-5 w-5" aria-hidden />}
      description="Push bookings to Google or Outlook and keep your busy time out of your booking page."
      tooltip="Bookings are pushed with the customer's first name only. Busy time is pulled for the next 60 days as times only; titles and attendees are never stored."
    >
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      {!migrated && !loading && <Banner tone="warn">The calendar sync tables are not in this database yet. Apply <code>aws/phase9/c.sql</code> and reload.</Banner>}
      {!canEdit && !loading && <Banner tone="info">You can view calendar sync but not change it.</Banner>}

      <section aria-labelledby="cs-providers" className="mb-6">
        <h2 id="cs-providers" className="mb-2 text-sm font-semibold">Calendars</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => {
            const n = connections.filter((c) => c.provider === p.id).length;
            const can = p.configured && migrated && canEdit && busy === null;
            return (
              <div key={p.id} className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{p.label}</h3>
                    <Pill tone={p.configured ? (n ? "success" : "info") : "neutral"}>{n ? `${n} connected` : p.configured ? "Ready" : "Not configured"}</Pill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.id === "simulated" ? "An in-app calendar for demos and tests. Nothing leaves the server." : p.reason ?? `Two-way sync with ${p.label}.`}
                  </p>
                </div>
                <Button asChild={can} variant={n ? "outline" : "default"} size="sm" touch disabled={!can}>
                  {can ? <a href={`/api/calsync/connect/${p.id}`}>{n ? "Connect another" : "Connect"}</a> : <span>Connect</span>}
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      {loading ? (
        <Loading label="Loading connections…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : connections.length === 0 ? (
        <Empty icon={<CalendarClock className="h-5 w-5" />} title="No calendar connected" text="Connect Google or Outlook above, or try the simulated calendar." />
      ) : (
        <div className="space-y-4">
          {connections.map((c) => (
            <ConnectionCard key={c.id} c={c} busy={busy} canEdit={canEdit} onSync={() => void syncNow(c)} onDisconnect={() => setDisconnect(c)} onNotice={setNotice} onChanged={load} />
          ))}
        </div>
      )}

      <section aria-labelledby="cs-feed" className="mt-8 rounded-xl border border-border bg-card p-4">
        <h2 id="cs-feed" className="text-sm font-semibold">Subscribe by link (ICS)</h2>
        <p className="mt-1 text-xs text-muted-foreground">A private read-only feed of upcoming bookings for any calendar app. Anyone with the link can read it; rotate it to revoke the old one.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" touch disabled={busy !== null || !canEdit} onClick={() => void createFeed(false)}>
            {busy === "feed" ? spinner : <Link2 className="h-4 w-4" aria-hidden />} Create link
          </Button>
          <Button size="sm" variant="ghost" touch disabled={busy !== null || !canEdit} onClick={() => void createFeed(true)}>Rotate link</Button>
        </div>
        {feedUrl && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input readOnly aria-label="ICS feed link" value={feedUrl} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs" />
            <Button size="sm" touch onClick={() => void navigator.clipboard?.writeText(feedUrl).then(() => setNotice({ tone: "success", text: "Feed link copied." }))}>Copy</Button>
          </div>
        )}
      </section>

      {disconnect && (
        <Dialog title="Disconnect this calendar?" description="Busy time from it stops blocking your slots. Events already pushed stay in the external calendar." onClose={() => busy === null && setDisconnect(null)} size="sm">
          <DialogFooter>
            <Button variant="ghost" touch onClick={() => setDisconnect(null)} disabled={busy !== null}>Cancel</Button>
            <Button variant="destructive" touch onClick={() => void confirmDisconnect()} disabled={busy !== null}>
              {busy === `del:${disconnect.id}` && spinner}
              Disconnect
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

function ConnectionCard({ c, busy, canEdit, onSync, onDisconnect, onNotice, onChanged }: {
  c: CalendarConnectionView; busy: string | null; canEdit: boolean; onSync: () => void; onDisconnect: () => void; onNotice: (n: Notice | null) => void; onChanged: () => Promise<void>;
}) {
  const [options, setOptions] = useState<CalendarOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/calsync/calendars?connection_id=${encodeURIComponent(c.id)}`, { signal: ctrl.signal })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readError(r, "Could not list calendars")))))
      .then((d) => setOptions(d.calendars ?? []))
      .catch((e) => !isAbortError(e) && setOptionsError(e instanceof Error ? e.message : "Could not list calendars"));
    return () => ctrl.abort();
  }, [c.id]);

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/calsync/connections/${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) onNotice({ tone: "error", text: await readError(res, "Could not save") });
    await onChanged();
  }

  const label = c.provider === "google" ? "Google Calendar" : c.provider === "outlook" ? "Outlook Calendar" : "Simulated calendar";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{label} <span className="font-normal text-muted-foreground">{c.account_email}</span></h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {c.last_sync_at ? `Synced ${timeAgo(c.last_sync_at)}` : "Not synced yet"} · {c.busy_count} busy block{c.busy_count === 1 ? "" : "s"}
          </p>
        </div>
        <Pill tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Pill>
      </div>
      {c.last_error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{c.last_error}</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="External calendar">
          <Select value={c.settings.calendar_id ?? c.external_calendar_id ?? ""} disabled={!canEdit || options.length === 0} onChange={(e) => void patch({ settings: { calendar_id: e.target.value } })}>
            {options.length === 0 && <option value="">{optionsError ?? "Loading…"}</option>}
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.primary ? " (primary)" : ""}</option>)}
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-2">
          <Checkbox label="Push bookings to this calendar" checked={c.settings.push_bookings} disabled={!canEdit} onChange={(e) => void patch({ settings: { push_bookings: e.target.checked } })} />
          <Checkbox label="Block my booking slots when I am busy here" checked={c.settings.pull_busy} disabled={!canEdit} onChange={(e) => void patch({ settings: { pull_busy: e.target.checked } })} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" touch disabled={busy !== null || !canEdit || c.status === "disabled"} onClick={onSync}>
          {busy === `sync:${c.id}` ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />} Sync now
        </Button>
        <Button size="sm" variant="ghost" touch disabled={busy !== null || !canEdit} onClick={() => void patch({ status: c.status === "disabled" ? "connected" : "disabled" })}>
          {c.status === "disabled" ? "Enable" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" touch disabled={busy !== null || !canEdit} onClick={onDisconnect}>
          <Trash2 className="h-4 w-4" aria-hidden /> Disconnect
        </Button>
      </div>
    </div>
  );
}
