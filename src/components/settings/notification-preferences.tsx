"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, Checkbox, Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { TableScroller } from "@/components/ui/table-scroller";

/**
 * Settings → Notifications: category × channel matrix, digest cadence/hour and quiet hours.
 * Saves on each change (PATCH /api/notifications/preferences) with an inline status.
 */

type Channel = "in_app" | "email" | "push" | "sms";
interface Prefs {
  channels: Record<string, Record<Channel, boolean>>;
  digest: "daily" | "weekly" | "off";
  digest_hour: number;
  digest_weekday: number | null;
  quiet_hours: { start: string | null; end: string | null } | null;
}
interface Payload {
  preferences: Prefs;
  categories: Array<{ key: string; label: string }>;
  channels: Channel[];
  channel_status: Record<string, "live" | "simulated">;
}

const CHANNEL_LABELS: Record<Channel, string> = { in_app: "In-app", email: "Email", push: "Push", sms: "SMS" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function NotificationPreferences() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const res = await fetch("/api/notifications/preferences", { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load preferences (${res.status})`);
      setData((await res.json()) as Payload);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load preferences.");
    }
  }, [nextSignal]);
  useEffect(() => { void load(); }, [load]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/notifications/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.detail ?? d?.error ?? `Save failed (${res.status})`);
      }
      const d = (await res.json()) as { preferences: Prefs };
      setData((cur) => (cur ? { ...cur, preferences: d.preferences } : cur));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <SkeletonList count={3} itemClassName="h-12" label="Loading preferences…" />;
  const p = data.preferences;

  return (
    <div className="space-y-6">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      <section aria-labelledby="matrix-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="matrix-heading" className="text-sm font-semibold">What reaches you, and where</h2>
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">{saving ? "Saving…" : savedAt ? "Saved" : ""}</p>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Untick a channel to stop that kind of alert there. Simulated channels write to the Outbox only.</p>
        <TableScroller label="Notification categories by channel" className="mt-4">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Notification categories by channel</caption>
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">Category</th>
                {data.channels.map((c) => (
                  <th key={c} scope="col" className="px-2 py-2 text-center font-medium">
                    {CHANNEL_LABELS[c]}
                    {data.channel_status[c] === "simulated" && <span className="block text-[10px] normal-case text-muted-foreground">Simulated</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.categories.map((cat) => (
                <tr key={cat.key}>
                  <th scope="row" className="px-3 py-2 text-start font-medium">{cat.label}</th>
                  {data.channels.map((ch) => (
                    <td key={ch} className="px-2 py-1 text-center">
                      <Checkbox
                        label={<span className="sr-only">{cat.label} via {CHANNEL_LABELS[ch]}</span>}
                        checked={Boolean(p.channels[cat.key]?.[ch])}
                        onChange={(e) => void patch({ channels: { [cat.key]: { [ch]: e.target.checked } } })}
                        labelClassName="justify-center"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </section>

      <section aria-labelledby="digest-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="digest-heading" className="flex items-center gap-2 text-sm font-semibold">Digest email <Pill tone={p.digest === "off" ? "neutral" : "info"}>{p.digest === "off" ? "Off" : p.digest === "daily" ? "Daily" : "Weekly"}</Pill></h2>
        <p className="mt-1 text-sm text-muted-foreground">A summary of what needs you, your KPIs with deltas, and your scheduled reports — sent on the Email channel of “Scheduled reports”.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Cadence">
            <Select value={p.digest} onChange={(e) => void patch({ digest: e.target.value })}>
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          <Field label="Send at">
            <Select value={p.digest_hour} onChange={(e) => void patch({ digest_hour: Number(e.target.value) })} disabled={p.digest === "off"}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
              ))}
            </Select>
          </Field>
          {p.digest === "weekly" && (
            <Field label="Weekday">
              <Select value={p.digest_weekday ?? 1} onChange={(e) => void patch({ digest_weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </section>

      <section aria-labelledby="quiet-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="quiet-heading" className="text-sm font-semibold">Quiet hours</h2>
        <p className="mt-1 text-sm text-muted-foreground">Push and SMS alerts raised during quiet hours are delivered when they end. In-app and email are not delayed.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="time" value={p.quiet_hours?.start ?? ""} onChange={(e) => void patch({ quiet_hours: { start: e.target.value || null, end: p.quiet_hours?.end ?? null } })} />
          </Field>
          <Field label="To">
            <Input type="time" value={p.quiet_hours?.end ?? ""} onChange={(e) => void patch({ quiet_hours: { start: p.quiet_hours?.start ?? null, end: e.target.value || null } })} />
          </Field>
          {p.quiet_hours && (
            <Button type="button" variant="outline" touch onClick={() => void patch({ quiet_hours: null })}>Clear</Button>
          )}
        </div>
      </section>
    </div>
  );
}
