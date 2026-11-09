"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, MessageCircle, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import type { ChatIntegrationView, ChatProviderId } from "@/lib/chatops/types";

type Notice = { tone: "success" | "error" | "info"; text: string };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d?.error ? String(d.error) : `${fallback} (${res.status})`;
}

const URL_HINT: Record<ChatProviderId, string> = {
  slack: "https://hooks.slack.com/services/…",
  teams: "https://…webhook.office.com/… or …logic.azure.com/…",
  discord: "https://discord.com/api/webhooks/…",
  webhook: "Any public https URL",
};

export default function ChatAppsPage() {
  const nextSignal = useAbortable();
  const [items, setItems] = useState<ChatIntegrationView[]>([]);
  const [providers, setProviders] = useState<Array<{ id: ChatProviderId; label: string }>>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<ChatIntegrationView | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    try {
      const res = await fetch("/api/chat-integrations", { signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load chat apps"));
      const d = await res.json();
      setItems(d.integrations ?? []);
      setProviders(d.providers ?? []);
      setEventTypes(d.event_types ?? []);
      setMigrated(d.migrated !== false);
      setCanEdit(d.canEdit !== false);
      setError(null);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "Could not load chat apps.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(i: ChatIntegrationView, body: Record<string, unknown>) {
    setBusy(`patch:${i.id}`);
    try {
      const res = await fetch(`/api/chat-integrations/${encodeURIComponent(i.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readError(res, "Could not save"));
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(null);
    }
  }

  async function test(i: ChatIntegrationView) {
    setBusy(`test:${i.id}`);
    try {
      const res = await fetch(`/api/chat-integrations/${encodeURIComponent(i.id)}/test`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      setNotice(res.ok ? { tone: "success", text: `Test message sent to ${i.name}.` } : { tone: "error", text: `Test failed: ${d.error ?? res.status}` });
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function confirmRemove() {
    if (!remove) return;
    setBusy(`del:${remove.id}`);
    try {
      const res = await fetch(`/api/chat-integrations/${encodeURIComponent(remove.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not delete"));
      setRemove(null);
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not delete." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Chat apps"
      icon={<MessageCircle className="h-5 w-5" aria-hidden />}
      description="Send KernelHub events to Slack, Microsoft Teams, Discord or any webhook."
      tooltip="Pick which events to relay. Messages are short and carry no more than the event itself. Up to 30 messages per minute per channel; extras are dropped."
      actions={<Button touch onClick={() => setAdding(true)} disabled={!migrated || !canEdit}>Add integration</Button>}
    >
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      {!migrated && !loading && <Banner tone="warn">The chat tables are not in this database yet. Apply <code>aws/phase9/c.sql</code> and reload.</Banner>}
      {loading ? (
        <Loading label="Loading chat apps…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <Empty icon={<MessageCircle className="h-5 w-5" />} title="No chat apps connected" text="Add an incoming webhook from Slack, Teams or Discord to get notified in your channel." />
      ) : (
        <ul className="space-y-3">
          {items.map((i) => (
            <li key={i.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{i.name} <span className="font-normal text-muted-foreground">{providers.find((p) => p.id === i.provider)?.label ?? i.provider}{i.channel_label ? ` · ${i.channel_label}` : ""}</span></h3>
                  <p className="mt-0.5 break-all text-xs text-muted-foreground">{i.webhook_url_masked}</p>
                </div>
                <Pill tone={i.last_status === "ok" ? "success" : i.last_status === "error" ? "danger" : "neutral"}>{i.last_status ?? "not used yet"}</Pill>
              </div>
              {i.last_error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{i.last_error}</p>}
              <p className="mt-2 text-xs text-muted-foreground">{i.events.length ? `Events: ${i.events.slice(0, 6).join(", ")}${i.events.length > 6 ? ` +${i.events.length - 6} more` : ""}` : "No events selected, so nothing is sent."}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Checkbox label="Enabled" checked={i.enabled} disabled={!canEdit || busy !== null} onChange={(e) => void patch(i, { enabled: e.target.checked })} />
                <Button size="sm" variant="outline" touch disabled={!canEdit || busy !== null} onClick={() => void test(i)}>
                  {busy === `test:${i.id}` ? spinner : <Send className="h-4 w-4" aria-hidden />} Send test
                </Button>
                <Button size="sm" variant="ghost" touch disabled={!canEdit || busy !== null} onClick={() => setRemove(i)}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding && <AddDialog providers={providers} eventTypes={eventTypes} onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); setNotice({ tone: "success", text: "Integration added." }); await load(); }} />}

      {remove && (
        <Dialog title={`Delete ${remove.name}?`} description="Notifications to this channel stop. The channel itself is not touched." onClose={() => busy === null && setRemove(null)} size="sm">
          <DialogFooter>
            <Button variant="ghost" touch onClick={() => setRemove(null)} disabled={busy !== null}>Cancel</Button>
            <Button variant="destructive" touch onClick={() => void confirmRemove()} disabled={busy !== null}>{busy === `del:${remove.id}` && spinner}Delete</Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

function AddDialog({ providers, eventTypes, onClose, onSaved }: { providers: Array<{ id: ChatProviderId; label: string }>; eventTypes: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<ChatProviderId>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [events, setEvents] = useState<string[]>(["booking.created", "invoice.paid"]);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const shown = useMemo(() => eventTypes.filter((t) => t.includes(filter.trim().toLowerCase())), [eventTypes, filter]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/chat-integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, name, webhook_url: url, channel_label: label || null, events }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save"));
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Add chat integration" onClose={() => !saving && onClose()} size="md">
      <div className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <Field label="App">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as ChatProviderId)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Sales channel" /></Field>
        <Field label="Webhook URL" required hint={`Stored encrypted and shown masked afterwards. ${URL_HINT[provider]}`}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Channel label (optional)"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="#sales" /></Field>
        <fieldset>
          <legend className="mb-1 text-xs font-medium">Events ({events.length} selected)</legend>
          <Input aria-label="Filter events" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-2" />
          <div className="max-h-48 overflow-y-auto rounded-md border border-border p-2">
            {shown.map((t) => (
              <Checkbox key={t} label={t} checked={events.includes(t)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))} />
            ))}
            {shown.length === 0 && <p className="text-xs text-muted-foreground">No matching events.</p>}
          </div>
        </fieldset>
      </div>
      <DialogFooter>
        <Button variant="ghost" touch onClick={onClose} disabled={saving}>Cancel</Button>
        <Button touch onClick={() => void save()} disabled={saving || !name.trim() || !url.trim()}>{saving && spinner}Save</Button>
      </DialogFooter>
    </Dialog>
  );
}
