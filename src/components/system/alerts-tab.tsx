"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller } from "@/components/ui/table-scroller";
import { describeCondition, type AlertCondition } from "@/lib/alerts/evaluate";
import { timeAgo } from "@/lib/utils";

interface Rule { id: string; key: string; name: string; condition: AlertCondition; channel_ids: string[]; enabled: boolean; last_fired_at: string | null; cooldown_min: number }
interface EventRow { id: string; rule_id: string; rule_name: string | null; fired_at: string; resolved_at: string | null; value: number | null; message: string | null }
interface Integration { id: string; name: string; provider: string }

export function AlertsTab() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, e, c] = await Promise.all([
        fetch("/api/alerts/rules", { cache: "no-store" }),
        fetch("/api/alerts/events?limit=25", { cache: "no-store" }),
        fetch("/api/chat-integrations", { cache: "no-store" }),
      ]);
      const rj = await r.json().catch(() => null);
      if (!r.ok) throw new Error(r.status === 403 ? "You do not have access to alert settings." : (rj?.error ?? "Could not load alert rules."));
      setRules(rj.rules ?? []);
      setEmail(typeof rj.email === "string" ? rj.email : null);
      const ej = await e.json().catch(() => null);
      setEvents(e.ok ? (ej?.events ?? []) : []);
      const cj = await c.json().catch(() => null);
      setIntegrations(c.ok ? (cj?.integrations ?? []) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alert rules.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function patch(rule: Rule, body: Record<string, unknown>) {
    setBusy(rule.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/alerts/rules/${rule.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not update the rule.");
      setRules((prev) => (prev ?? []).map((x) => (x.id === rule.id && data.rule ? data.rule : x)));
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the rule.");
    } finally {
      setBusy(null);
    }
  }

  function toggleChannel(rule: Rule, channel: string) {
    const has = rule.channel_ids.includes(channel);
    void patch(rule, { channel_ids: has ? rule.channel_ids.filter((c) => c !== channel) : [...rule.channel_ids, channel] });
  }

  if (error && !rules) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!rules) return <SkeletonList count={3} itemClassName="h-16" label="Loading alert rules…" />;

  return (
    <div className="space-y-8">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <section aria-labelledby="alert-rules-heading">
        <h2 id="alert-rules-heading" className="text-sm font-semibold">Alert rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">Rules are checked every minute by the background tick. Notifications go to the chosen chat channels or your email, at most once per cooldown.</p>
        <TableScroller label="Alert rules" className="mt-3">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="px-2 py-2 font-medium">Rule</th><th className="px-2 py-2 font-medium">Threshold</th><th className="px-2 py-2 font-medium">Notify</th><th className="px-2 py-2 text-right font-medium">On</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => {
                const draft = drafts[r.id] ?? String(r.condition.threshold);
                return (
                  <tr key={r.id}>
                    <td className="px-2 py-2 align-top"><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{describeCondition(r.condition)}{r.last_fired_at ? ` · last notified ${timeAgo(r.last_fired_at)}` : ""}</div></td>
                    <td className="px-2 py-2 align-top">
                      <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const n = Number(draft); if (Number.isFinite(n) && n >= 0) void patch(r, { threshold: n }); }}>
                        <input aria-label={`Threshold for ${r.name}`} inputMode="decimal" value={draft} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))} className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm tabular-nums" />
                        <Button type="submit" variant="outline" size="sm" disabled={busy === r.id || draft === String(r.condition.threshold)}>Save</Button>
                      </form>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {email && (
                          <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={r.channel_ids.includes(`email:${email}`)} onChange={() => toggleChannel(r, `email:${email}`)} disabled={busy === r.id} /> Email me</label>
                        )}
                        {integrations.map((i) => (
                          <label key={i.id} className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={r.channel_ids.includes(i.id)} onChange={() => toggleChannel(r, i.id)} disabled={busy === r.id} /> {i.name}</label>
                        ))}
                        {!email && integrations.length === 0 && <span className="text-xs text-muted-foreground">No channels available</span>}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right align-top">
                      <input type="checkbox" role="switch" aria-label={`Enable ${r.name}`} checked={r.enabled} disabled={busy === r.id} onChange={(e) => void patch(r, { enabled: e.target.checked })} className="h-5 w-5" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      </section>

      <section aria-labelledby="alert-events-heading">
        <h2 id="alert-events-heading" className="text-sm font-semibold">Recent alerts</h2>
        {events.length === 0 ? (
          <Empty title="No alerts yet" text="Alerts appear here when a rule fires and resolve on their own when the condition clears." />
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0"><div className="font-medium">{e.rule_name ?? "Rule"}</div><div className="break-words text-xs text-muted-foreground">{e.message}</div></div>
                <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{timeAgo(e.fired_at)}</span><Pill tone={e.resolved_at ? "success" : "danger"}>{e.resolved_at ? "Resolved" : "Firing"}</Pill></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
