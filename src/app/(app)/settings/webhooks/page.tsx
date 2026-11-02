"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw, RotateCw, Send, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox, Input } from "@/components/ui/input";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import type { SubscriptionDTO } from "@/lib/webhooks/subscriptions";
import type { DeliveryDTO } from "@/lib/webhooks/dispatch";
import { cn, timeAgo } from "@/lib/utils";

type Notice = { tone: "success" | "error"; text: string };

const DELIVERY_TONE: Record<string, Tone> = { queued: "info", delivering: "info", delivered: "success", failed: "warning", dead: "danger" };

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return (d && (d.detail || d.error)) ? String(d.detail ?? d.error) : `${fallback} (${res.status})`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" touch onClick={copy} aria-label={label}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** Event-type picker: "All events" or an explicit set grouped by prefix. */
function EventTypePicker({ all, value, onChange, disabled }: { all: readonly string[]; value: Set<string>; onChange: (v: Set<string>) => void; disabled?: boolean }) {
  const wildcard = value.has("*");
  const groups = new Map<string, string[]>();
  for (const t of all) {
    const g = t.split(".")[0];
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  function toggle(t: string, on: boolean) {
    const next = new Set(value);
    next.delete("*");
    if (on) next.add(t);
    else next.delete(t);
    onChange(next);
  }
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1 block text-xs font-medium">Events</legend>
      <Checkbox
        label={<span className="font-medium">All events (including ones added later)</span>}
        checked={wildcard}
        onChange={(e) => onChange(e.target.checked ? new Set(["*"]) : new Set())}
      />
      <div className={cn("mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2", wildcard && "opacity-50")}>
        {[...groups.entries()].map(([g, types]) => (
          <div key={g} className="min-w-0">
            <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</p>
            {types.map((t) => (
              <Checkbox key={t} label={<code className="text-xs">{t}</code>} checked={!wildcard && value.has(t)} disabled={wildcard} onChange={(e) => toggle(t, e.target.checked)} />
            ))}
          </div>
        ))}
      </div>
      {!wildcard && value.size === 0 && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Choose at least one event, or select all.
        </p>
      )}
    </fieldset>
  );
}

export default function WebhooksSettingsPage() {
  const [subs, setSubs] = useState<SubscriptionDTO[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(["*"]));
  const [submitting, setSubmitting] = useState(false);
  const [secretShown, setSecretShown] = useState<{ secret: string; url: string } | null>(null);

  const [open, setOpen] = useState<SubscriptionDTO | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryDTO[] | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubscriptionDTO | null>(null);
  const drawerTitleId = useId();
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/webhooks", { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load webhooks"));
      const data = await res.json();
      setSubs(data.subscriptions ?? []);
      setEventTypes(data.event_types ?? []);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load webhooks.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDeliveries = useCallback(async (id: string) => {
    setDrawerError(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load deliveries"));
      const data = await res.json();
      setOpen(data.subscription);
      setDeliveries(data.deliveries ?? []);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : "Could not load deliveries.");
    }
  }, []);

  function openDrawer(s: SubscriptionDTO) {
    setOpen(s);
    setDeliveries(null);
    setExpanded(null);
    void loadDeliveries(s.id);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || picked.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), description: description.trim() || null, event_types: [...picked] }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not create the webhook"));
      const data = await res.json();
      setSecretShown({ secret: data.secret, url: data.subscription.url });
      setCreating(false);
      setUrl("");
      setDescription("");
      setPicked(new Set(["*"]));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the webhook.");
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, ok: string) {
    setBusy(`patch:${id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readError(res, "Update failed"));
      const data = await res.json();
      if (data.secret) setSecretShown({ secret: data.secret, url: data.subscription.url });
      setNotice({ tone: "success", text: ok });
      await load();
      if (open?.id === id) setOpen(data.subscription);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Update failed." });
    } finally {
      setBusy(null);
    }
  }

  async function test(id: string) {
    setBusy(`test:${id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Test failed"));
      const data = (await res.json()) as { delivery: DeliveryDTO };
      const d = data.delivery;
      setNotice(
        d.status === "delivered"
          ? { tone: "success", text: `Test delivered (HTTP ${d.response_status}, ${d.response_ms} ms).` }
          : { tone: "error", text: `Test failed: ${d.error ?? `HTTP ${d.response_status ?? "—"}`}` }
      );
      if (open?.id === id) await loadDeliveries(id);
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Test failed." });
    } finally {
      setBusy(null);
    }
  }

  async function retry(subId: string, deliveryId: string) {
    setBusy(`retry:${deliveryId}`);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(subId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Retry failed"));
      setNotice({ tone: "success", text: "Queued — it will be sent on the next worker tick (within a minute)." });
      await loadDeliveries(subId);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(`delete:${deleteTarget.id}`);
    try {
      const res = await fetch(`/api/webhooks/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Delete failed"));
      setDeleteTarget(null);
      if (open?.id === deleteTarget.id) setOpen(null);
      setNotice({ tone: "success", text: "Webhook deleted." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Delete failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Webhooks"
      description="Get an HTTPS POST whenever something happens — new contacts, paid invoices, bookings, tickets and more."
      tooltip="Every delivery is signed with the subscription secret (X-KernelHub-Signature). Failed deliveries retry for ~15 hours; 20 failures in a row disable the endpoint."
      actions={
        <>
          <Button type="button" variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh webhooks">
            {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button type="button" touch onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Add endpoint
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <div className="mb-4 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        Verify signatures and see payload shapes on the{" "}
        <Link href="/settings/developers" className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Developers
        </Link>{" "}
        page. Zapier and Make can subscribe themselves through <code className="rounded bg-muted px-1">POST /api/v1/webhooks</code>.
      </div>

      {loading && subs.length === 0 ? (
        <Loading label="Loading webhooks…" />
      ) : error && subs.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : subs.length === 0 ? (
        <Empty
          icon={<Webhook className="h-5 w-5" aria-hidden />}
          title="No endpoints yet"
          text="Add an HTTPS URL and pick the events you care about. You will get a signing secret to verify each delivery."
          action={
            <Button type="button" size="sm" touch onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add endpoint
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-busy={loading || undefined}>
          {subs.map((s) => (
            <li key={s.id} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 break-all text-sm font-medium">{s.url}</code>
                    <Pill tone={s.active ? "success" : "danger"}>{s.active ? "active" : "disabled"}</Pill>
                    {s.failure_count > 0 && <Pill tone="warning" title="Consecutive failures">{s.failure_count} failing</Pill>}
                  </div>
                  {s.description && <p className="mt-0.5 text-sm text-muted-foreground">{s.description}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {s.event_types.map((t) => (
                      <Pill key={t} tone={t === "*" ? "accent" : "neutral"}>
                        {t === "*" ? "all events" : t}
                      </Pill>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Created {fmt(s.created_at)} · Last success {s.last_success_at ? timeAgo(s.last_success_at) : "never"} · Last failure {s.last_failure_at ? timeAgo(s.last_failure_at) : "never"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button type="button" variant="outline" size="sm" touch onClick={() => openDrawer(s)} aria-label={`Deliveries for ${s.url}`}>
                    Deliveries
                  </Button>
                  <Button type="button" variant="outline" size="sm" touch onClick={() => void test(s.id)} disabled={busy === `test:${s.id}` || !s.active} aria-label={`Send test to ${s.url}`}>
                    {busy === `test:${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />} Test
                  </Button>
                  <Button type="button" variant="outline" size="sm" touch onClick={() => void patch(s.id, { active: !s.active }, s.active ? "Endpoint disabled." : "Endpoint enabled.")} disabled={busy === `patch:${s.id}`} aria-label={`${s.active ? "Disable" : "Enable"} ${s.url}`}>
                    {busy === `patch:${s.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
                    {s.active ? "Disable" : "Enable"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" touch onClick={() => setDeleteTarget(s)} aria-label={`Delete ${s.url}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <Dialog title="Add endpoint" description="We POST a signed JSON body to this URL for each selected event." onClose={() => !submitting && setCreating(false)} size="lg">
          <form onSubmit={create} className="space-y-4">
            <Field label="Endpoint URL" required hint="Public HTTPS only. IP addresses and internal hosts are refused.">
              <Input data-autofocus type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://hooks.example.com/kernelhub" maxLength={2048} />
            </Field>
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Sync paid invoices to accounting" />
            </Field>
            <EventTypePicker all={eventTypes} value={picked} onChange={setPicked} disabled={submitting} />
            <DialogFooter>
              <Button type="button" variant="ghost" touch onClick={() => setCreating(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" touch disabled={submitting || !url.trim() || picked.size === 0}>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />} Create
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      {secretShown && (
        <Dialog title="Signing secret" description="Shown once. Use it to verify X-KernelHub-Signature on every delivery." onClose={() => setSecretShown(null)}>
          <p className="mb-2 break-all text-xs text-muted-foreground">{secretShown.url}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{secretShown.secret}</code>
            <CopyButton text={secretShown.secret} label="Copy signing secret" />
          </div>
          <DialogFooter>
            <Button type="button" touch onClick={() => setSecretShown(null)}>
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {deleteTarget && (
        <Dialog title="Delete this endpoint?" description="Pending deliveries are dropped and the subscriber stops receiving events." onClose={() => busy !== `delete:${deleteTarget.id}` && setDeleteTarget(null)} size="sm">
          <p className="break-all text-sm">{deleteTarget.url}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" touch onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch onClick={() => void remove()} disabled={busy === `delete:${deleteTarget.id}`}>
              {busy === `delete:${deleteTarget.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />} Delete
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {open && (
        <Drawer
          labelledBy={drawerTitleId}
          onClose={() => setOpen(null)}
          header={
            <div className="min-w-0">
              <h2 id={drawerTitleId} className="break-all text-base font-semibold leading-snug">
                {open.url}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Last 50 deliveries</p>
            </div>
          }
          footer={
            <>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="sm" touch onClick={() => void test(open.id)} disabled={busy === `test:${open.id}` || !open.active}>
                  <Send className="h-3.5 w-3.5" aria-hidden /> Send test
                </Button>
                <Button type="button" variant="outline" size="sm" touch onClick={() => void patch(open.id, { rotate_secret: true }, "Secret rotated. Update your receiver.")} disabled={busy === `patch:${open.id}`}>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden /> Rotate secret
                </Button>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" touch onClick={() => void loadDeliveries(open.id)} aria-label="Refresh deliveries">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </>
          }
        >
          {drawerError && <ErrorState message={drawerError} onRetry={() => void loadDeliveries(open.id)} />}
          {!drawerError && deliveries === null && <Loading label="Loading deliveries…" />}
          {!drawerError && deliveries && deliveries.length === 0 && (
            <Empty
              title="No deliveries yet"
              text="Send a test or wait for a matching event."
              action={
                <Button type="button" variant="outline" touch onClick={() => void test(open.id)} disabled={busy === `test:${open.id}` || !open.active}>
                  <Send className="h-3.5 w-3.5" aria-hidden /> Send test
                </Button>
              }
            />
          )}
          {!drawerError && deliveries && deliveries.length > 0 && (
            <TableScroller label="Deliveries">
              <table className="w-full min-w-[640px] text-sm">
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>Status</th>
                    <th scope="col" className={TH}>Event</th>
                    <th scope="col" className={TH}>Attempts</th>
                    <th scope="col" className={TH}>Response</th>
                    <th scope="col" className={TH}>When</th>
                    <th scope="col" className={cn(TH, "text-right")}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {deliveries.map((d) => (
                    <tr key={d.id} className="align-top">
                      <td className="px-3 py-2">
                        <StatusPill status={d.status} map={DELIVERY_TONE} />
                        {d.error && <p className="mt-1 max-w-[220px] break-words text-xs text-muted-foreground">{d.error}</p>}
                      </td>
                      <td className="px-3 py-2">
                        <code className="text-xs">{d.event_type}</code>
                        <button
                          type="button"
                          onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                          aria-expanded={expanded === d.id}
                          className="mt-0.5 block rounded-sm text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {expanded === d.id ? "Hide payload" : "Show payload"}
                        </button>
                        {expanded === d.id && <pre className="mt-1 max-h-48 max-w-[280px] overflow-auto rounded-md bg-muted p-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} aria-label={`Payload for ${d.event_type}`}>{JSON.stringify(d.payload, null, 2)}</pre>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {d.attempts}
                        {d.status === "failed" && d.next_attempt_at && <p className="text-xs text-muted-foreground">next {timeAgo(d.next_attempt_at)}</p>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {d.response_status ?? "—"}
                        {d.response_ms !== null && <span className="text-xs text-muted-foreground"> · {d.response_ms} ms</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        <time dateTime={d.created_at} title={fmt(d.created_at)}>
                          {timeAgo(d.created_at)}
                        </time>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {d.status !== "queued" && d.status !== "delivering" && (
                          <Button type="button" variant="outline" size="sm" touch onClick={() => void retry(open.id, d.id)} disabled={busy === `retry:${d.id}`} aria-label={`Retry delivery ${d.id}`}>
                            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}
        </Drawer>
      )}
    </PageContainer>
  );
}
