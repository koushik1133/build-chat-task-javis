"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, MessageSquareText, Pause, Play, Plus, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Pill, StatusPill } from "@/components/ui/pill";
import { LoadMore } from "@/components/ui/load-more";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { cn, timeAgo } from "@/lib/utils";
import type { CampaignRow, RecipientWithContact } from "@/lib/marketing/campaigns";
import type { AudienceRow } from "@/lib/marketing/audiences";
import type { TemplateRow } from "@/lib/marketing/templates";
import { RECIPIENT_STATUSES, type AudienceDefinition, type CampaignStats, type MarketingSendChannel, type RecipientStatus, parseAudienceDefinition, describeAudience } from "@/lib/marketing/types";
import { AudienceBuilder, CAMPAIGN_TONE, ContentEditor, ContentPreview, EligibilitySummary, FunnelBar, RECIPIENT_TONE, jsonFetch, useAudiencePreview, type ContentValue, type Notice } from "./shared";

export type CampaignListRow = CampaignRow & { stats?: CampaignStats };
type Channels = Record<string, "live" | "simulated">;

interface ListResponse {
  campaigns: CampaignListRow[];
  next_cursor: string | null;
  migrated: boolean;
  channels: Channels;
}

export function CampaignsTab({ notify, selectedId, onSelect }: { notify: (tone: Notice["tone"], text: string) => void; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [rows, setRows] = useState<CampaignListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [channels, setChannels] = useState<Channels>({});
  const [migrated, setMigrated] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await jsonFetch<ListResponse>(`/api/marketing/campaigns?limit=50${status ? `&status=${status}` : ""}`, undefined, "Could not load campaigns");
      setRows(d.campaigns);
      setCursor(d.next_cursor);
      setChannels(d.channels ?? {});
      setMigrated(d.migrated !== false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load campaigns");
    } finally {
      setLoading(false);
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const d = await jsonFetch<ListResponse>(`/api/marketing/campaigns?limit=50&cursor=${encodeURIComponent(cursor)}${status ? `&status=${status}` : ""}`);
      setRows((r) => [...r, ...d.campaigns]);
      setCursor(d.next_cursor);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not load more");
    } finally {
      setMore(false);
    }
  };

  const selected = rows.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      {!migrated && <ErrorState message="The marketing tables are not available yet. Apply the Phase 8 marketing migration (aws/phase8/d.sql)." />}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="campaign-status" className="sr-only">
            Filter by status
          </label>
          <Select id="campaign-status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-auto">
            <option value="">All statuses</option>
            {["draft", "scheduled", "sending", "sent", "paused", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
          <Pill tone={channels.email === "live" ? "success" : "neutral"} title="Email provider status">
            <Mail className="h-3 w-3" aria-hidden /> email {channels.email ?? "…"}
          </Pill>
          <Pill tone={channels.sms === "live" ? "success" : "neutral"} title="SMS provider status">
            <MessageSquareText className="h-3 w-3" aria-hidden /> sms {channels.sms ?? "…"}
          </Pill>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="icon" touch onClick={load} aria-label="Refresh campaigns">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
          </Button>
          <Button type="button" touch onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New campaign
          </Button>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <SkeletonList count={4} label="Loading campaigns…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <Empty
          icon={<Send className="h-5 w-5" />}
          title="No campaigns yet"
          text="Send a consent-checked email or SMS to an audience. Contacts without marketing consent are always skipped."
          action={
            <Button type="button" touch onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Create your first campaign
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2" aria-label="Campaigns">
          {rows.map((c) => (
            <li key={c.id}>
              <CampaignCard campaign={c} onOpen={() => onSelect(c.id)} />
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={Boolean(cursor)} loading={more} count={rows.length} onMore={loadMore} noun="campaigns" />

      {showNew && (
        <CampaignWizard
          onClose={() => setShowNew(false)}
          onDone={(c, msg) => {
            setShowNew(false);
            notify("success", msg);
            void load();
            onSelect(c.id);
          }}
        />
      )}
      {selectedId && (
        <CampaignDrawer
          id={selectedId}
          initial={selected}
          onClose={() => onSelect(null)}
          notify={notify}
          onChanged={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

function CampaignCard({ campaign: c, onOpen }: { campaign: CampaignListRow; onOpen: () => void }) {
  const s = c.stats;
  const handed = s ? s.sent + s.delivered + s.bounced + s.unsubscribed : c.sent_count;
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{c.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="uppercase">{c.channel}</span>
            <span aria-hidden>·</span>
            <span>{c.status === "scheduled" && c.schedule_at ? `scheduled ${new Date(c.schedule_at).toLocaleString()}` : `updated ${timeAgo(c.updated_at)}`}</span>
          </p>
        </div>
        <StatusPill status={c.status} map={CAMPAIGN_TONE} />
      </div>
      {s && s.total > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
          <Stat label="Sent" value={handed} />
          <Stat label="Delivered" value={s.delivered + s.unsubscribed} />
          <Stat label="Opened" value={s.opened} pct={s.open_rate} />
          <Stat label="Clicked" value={s.clicked} pct={s.click_rate} />
          <Stat label="No consent" value={s.skipped_no_consent} warn={s.skipped_no_consent > 0} />
        </div>
      )}
    </button>
  );
}

function Stat({ label, value, pct, warn }: { label: string; value: number; pct?: number; warn?: boolean }) {
  return (
    <div className="text-xs">
      <p className="text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums font-medium", warn && "text-amber-600")}>
        {value}
        {pct !== undefined && <span className="ml-1 font-normal text-muted-foreground">{pct}%</span>}
      </p>
    </div>
  );
}

/* ---------- wizard ---------- */

const STEPS = ["Channel", "Audience", "Content", "Schedule", "Review"] as const;

function CampaignWizard({ onClose, onDone }: { onClose: () => void; onDone: (c: CampaignRow, message: string) => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<MarketingSendChannel>("email");
  const [audiences, setAudiences] = useState<AudienceRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [audienceId, setAudienceId] = useState<string>("");
  const [newAudience, setNewAudience] = useState<{ name: string; definition: AudienceDefinition } | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [content, setContent] = useState<ContentValue>({ subject: "", preheader: "", body_md: "" });
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState("");

  useEffect(() => {
    void Promise.all([jsonFetch<{ audiences: AudienceRow[] }>("/api/marketing/audiences"), jsonFetch<{ templates: TemplateRow[] }>("/api/marketing/templates")])
      .then(([a, t]) => {
        setAudiences(a.audiences);
        setTemplates(t.templates);
      })
      .catch(() => undefined);
  }, []);

  const pickedAudience = audiences.find((a) => a.id === audienceId) ?? null;
  const previewDef: AudienceDefinition | null = newAudience ? newAudience.definition : pickedAudience ? parseAudienceDefinition(pickedAudience.definition) : null;
  const preview = useAudiencePreview(previewDef, channel);
  const eligible = preview.data?.eligible ?? 0;

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setContent({ subject: t.subject, preheader: t.preheader ?? "", body_md: t.body_md });
  };

  const stepError = (): string | null => {
    if (step === 0 && !name.trim()) return "Give the campaign a name.";
    if (step === 1) {
      if (!audienceId && !newAudience) return "Pick or create an audience.";
      if (newAudience && !newAudience.name.trim()) return "Name the new audience.";
    }
    if (step === 2) {
      if (channel === "email" && !content.subject.trim()) return "Add a subject line.";
      if (!content.body_md.trim()) return "Write the message.";
    }
    if (step === 3 && when === "later" && (!scheduleAt || Number.isNaN(new Date(scheduleAt).getTime()))) return "Pick a date and time.";
    return null;
  };
  const next = () => {
    const e = stepError();
    if (e) return setErr(e);
    setErr(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  async function submit(launch: boolean) {
    setBusy(true);
    setErr(null);
    try {
      let aud = audienceId;
      if (newAudience) {
        const a = await jsonFetch<{ audience: AudienceRow }>("/api/marketing/audiences", { method: "POST", body: JSON.stringify({ name: newAudience.name.trim(), definition: newAudience.definition }) }, "Could not save the audience");
        aud = a.audience.id;
      }
      const d = await jsonFetch<{ campaign: CampaignRow; launch: { queued: number; skipped_no_consent: number } | null }>(
        "/api/marketing/campaigns",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            channel,
            audience_id: aud,
            template_id: templateId || null,
            subject: channel === "email" ? content.subject : null,
            preheader: channel === "email" ? content.preheader || null : null,
            body_md: content.body_md,
            from_name: fromName.trim() || null,
            reply_to: replyTo.trim() || null,
            schedule_at: when === "later" ? new Date(scheduleAt).toISOString() : null,
            launch,
          }),
        },
        "Could not create the campaign"
      );
      onDone(d.campaign, launch ? (d.launch ? `${d.campaign.status === "scheduled" ? "Scheduled" : "Launched"}: ${d.launch.queued} queued, ${d.launch.skipped_no_consent} skipped (no consent).` : "Launched.") : "Draft saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the campaign");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New campaign" description={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} onClose={onClose} size="lg">
      <ol className="mb-4 flex flex-wrap gap-1 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={cn("rounded-full px-2 py-0.5", i === step ? "bg-primary text-primary-foreground" : i < step ? "bg-secondary text-foreground" : "text-muted-foreground")}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step < STEPS.length - 1) next();
        }}
        className="space-y-4"
      >
        {step === 0 && (
          <>
            <Field label="Campaign name" required>
              <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} autoFocus placeholder="Spring newsletter" />
            </Field>
            <fieldset>
              <legend className="mb-1 block text-xs font-medium">Channel</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["email", "sms"] as const).map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    aria-pressed={channel === ch}
                    onClick={() => setChannel(ch)}
                    className={cn("flex min-h-16 items-center gap-3 rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", channel === ch ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/40")}
                  >
                    {ch === "email" ? <Mail className="h-5 w-5" aria-hidden /> : <MessageSquareText className="h-5 w-5" aria-hidden />}
                    <span>
                      <span className="block text-sm font-medium">{ch === "email" ? "Email" : "SMS"}</span>
                      <span className="block text-xs text-muted-foreground">{ch === "email" ? "Markdown body, open & click tracking, one-click unsubscribe." : "Short text with an opt-out link; needs marketing SMS consent."}</span>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        )}
        {step === 1 && (
          <>
            {!newAudience ? (
              <>
                <Field label="Audience" hint="Only contacts with current consent for this channel will be sent to.">
                  <Select value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
                    <option value="">Choose an audience…</option>
                    {audiences.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.size_cache !== null ? ` (${a.size_cache})` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button type="button" variant="outline" size="sm" onClick={() => setNewAudience({ name: "", definition: channel === "email" ? { has_email: true } : { has_phone: true } })}>
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Create a new audience instead
                </Button>
              </>
            ) : (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Field label="New audience name" required className="flex-1">
                    <Input value={newAudience.name} onChange={(e) => setNewAudience({ ...newAudience, name: e.target.value.slice(0, 120) })} />
                  </Field>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setNewAudience(null)}>
                    Use existing
                  </Button>
                </div>
                <AudienceBuilder value={newAudience.definition} onChange={(definition) => setNewAudience({ ...newAudience, definition })} channel={channel} />
              </div>
            )}
            <EligibilitySummary preview={preview.data} loading={preview.loading} channel={channel} className="rounded-lg border border-border px-3 py-2" />
            {preview.data && preview.data.count > 0 && eligible === 0 && <p className="text-xs text-amber-700">Nobody in this audience has consented to marketing by {channel}. Launching will be blocked — record consent under CRM → Privacy first.</p>}
          </>
        )}
        {step === 2 && (
          <>
            {templates.length > 0 && (
              <Field label="Start from a template" hint="Optional — fills the fields below; you can still edit.">
                <Select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">Compose from scratch</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <ContentEditor value={content} onChange={setContent} channel={channel} audienceId={audienceId || null} />
            {channel === "email" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From name" hint="Shown as the sender.">
                  <Input value={fromName} onChange={(e) => setFromName(e.target.value.slice(0, 120))} placeholder="Your business" />
                </Field>
                <Field label="Reply-to email">
                  <Input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value.slice(0, 320))} placeholder="hello@example.com" />
                </Field>
              </div>
            )}
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Preview with a sample contact</summary>
              <div className="p-3">
                <ContentPreview value={content} channel={channel} />
              </div>
            </details>
          </>
        )}
        {step === 3 && (
          <fieldset className="space-y-3">
            <legend className="mb-1 block text-xs font-medium">When should it go out?</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} /> Send as soon as I launch
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="when" checked={when === "later"} onChange={() => setWhen("later")} /> Schedule for later
            </label>
            {when === "later" && (
              <Field label="Date and time" required>
                <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              </Field>
            )}
            <p className="text-xs text-muted-foreground">Sending happens in the background a few at a time; large audiences take a few minutes.</p>
          </fieldset>
        )}
        {step === 4 && (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row k="Name" v={name} />
            <Row k="Channel" v={channel.toUpperCase()} />
            <Row k="Audience" v={newAudience ? `${newAudience.name} (new) — ${describeAudience(newAudience.definition)}` : pickedAudience ? pickedAudience.name : "—"} />
            <Row k="Eligible" v={preview.data ? `${eligible} of ${preview.data.count} contacts` : "…"} />
            {channel === "email" && <Row k="Subject" v={content.subject} />}
            <Row k="Schedule" v={when === "later" && scheduleAt ? new Date(scheduleAt).toLocaleString() : "Immediately"} />
          </dl>
        )}
        {step === 4 && eligible === 0 && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">No eligible recipients — you can save a draft, but launching is blocked until at least one contact has consented to marketing by {channel}.</p>}
        {err && (
          <p role="alert" className="text-sm text-red-600">
            {err}
          </p>
        )}
        <DialogFooter start={step > 0 ? <span className="text-xs text-muted-foreground">Nothing is sent until you launch.</span> : undefined}>
          {step > 0 && (
            <Button type="button" variant="ghost" touch onClick={() => setStep((s) => s - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="submit" touch>
              Next
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" touch disabled={busy} onClick={() => submit(false)}>
                Save draft
              </Button>
              <Button type="button" touch disabled={busy || eligible === 0} onClick={() => submit(true)} title={eligible === 0 ? "No consent-eligible recipients" : undefined}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                {when === "later" ? "Schedule" : "Launch"}
              </Button>
            </>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="[overflow-wrap:anywhere]">{v || "—"}</dd>
    </div>
  );
}

/* ---------- detail drawer ---------- */

interface DetailResponse {
  campaign: CampaignRow;
  stats: CampaignStats;
  links: Array<{ url: string; clicks: number; unique: number }>;
}

function CampaignDrawer({ id, initial, onClose, notify, onChanged }: { id: string; initial: CampaignListRow | null; onClose: () => void; notify: (tone: Notice["tone"], text: string) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<RecipientWithContact[]>([]);
  const [rCursor, setRCursor] = useState<string | null>(null);
  const [rLoading, setRLoading] = useState(false);
  const [rStatus, setRStatus] = useState<RecipientStatus | "">("");
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async () => {
    try {
      setDetail(await jsonFetch<DetailResponse>(`/api/marketing/campaigns/${id}`, undefined, "Could not load the campaign"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the campaign");
    }
  }, [id]);
  const loadRecipients = useCallback(
    async (cursor: string | null) => {
      setRLoading(true);
      try {
        const d = await jsonFetch<{ recipients: RecipientWithContact[]; next_cursor: string | null }>(`/api/marketing/campaigns/${id}/recipients?limit=50${rStatus ? `&status=${rStatus}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        setRecipients((r) => (cursor ? [...r, ...d.recipients] : d.recipients));
        setRCursor(d.next_cursor);
      } catch (e) {
        notify("error", e instanceof Error ? e.message : "Could not load recipients");
      } finally {
        setRLoading(false);
      }
    },
    [id, rStatus, notify]
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadRecipients(null);
  }, [loadRecipients]);

  const c = detail?.campaign ?? initial;
  const s = detail?.stats;

  async function act(action: "launch" | "pause" | "cancel" | "delete" | "test") {
    setBusy(action);
    try {
      if (action === "delete") {
        if (!window.confirm("Delete this campaign and its recipient history?")) return;
        await jsonFetch(`/api/marketing/campaigns/${id}`, { method: "DELETE" }, "Could not delete");
        notify("success", "Campaign deleted.");
        onChanged();
        onClose();
        return;
      }
      if (action === "test") {
        const d = await jsonFetch<{ to: string }>(`/api/marketing/campaigns/${id}/test-send`, { method: "POST", body: JSON.stringify(c?.channel === "sms" ? { phone: testTo } : testTo ? { email: testTo } : {}) }, "Could not send the test");
        notify("success", `Test queued to ${d.to}. Check Settings → Outbox when providers are simulated.`);
        return;
      }
      const d = await jsonFetch<{ campaign: CampaignRow; queued?: number; skipped_no_consent?: number }>(`/api/marketing/campaigns/${id}/${action}`, { method: "POST", body: action === "launch" ? "{}" : undefined }, `Could not ${action}`);
      notify("success", action === "launch" ? `${d.campaign.status === "scheduled" ? "Scheduled" : "Launched"}: ${d.queued ?? 0} queued, ${d.skipped_no_consent ?? 0} skipped (no consent).` : `Campaign ${action === "pause" ? "paused" : "cancelled"}.`);
      await load();
      await loadRecipients(null);
      onChanged();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : `Could not ${action}`);
    } finally {
      setBusy(null);
    }
  }

  const handed = s ? s.sent + s.delivered + s.bounced + s.unsubscribed : 0;
  const funnelMax = useMemo(() => Math.max(1, s ? s.total : 1), [s]);

  return (
    <Drawer
      labelledBy="campaign-drawer-title"
      onClose={onClose}
      header={
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="campaign-drawer-title" className="truncate text-base font-semibold">
              {c?.name ?? "Campaign"}
            </h2>
            {c && <StatusPill status={c.status} map={CAMPAIGN_TONE} />}
          </div>
          {c && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {c.channel.toUpperCase()} · created {timeAgo(c.created_at)}
              {c.finished_at ? ` · finished ${timeAgo(c.finished_at)}` : c.started_at ? ` · started ${timeAgo(c.started_at)}` : ""}
            </p>
          )}
        </div>
      }
      footer={
        c && (
          <div className="flex flex-wrap gap-2">
            {(c.status === "draft" || c.status === "paused" || c.status === "scheduled") && (
              <Button type="button" touch size="sm" disabled={busy !== null} onClick={() => act("launch")}>
                {busy === "launch" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} {c.status === "paused" ? "Resume" : "Launch now"}
              </Button>
            )}
            {(c.status === "sending" || c.status === "scheduled") && (
              <Button type="button" variant="secondary" touch size="sm" disabled={busy !== null} onClick={() => act("pause")}>
                <Pause className="h-4 w-4" aria-hidden /> Pause
              </Button>
            )}
            {c.status !== "sent" && c.status !== "cancelled" && (
              <Button type="button" variant="outline" touch size="sm" disabled={busy !== null} onClick={() => act("cancel")}>
                <Square className="h-4 w-4" aria-hidden /> Cancel
              </Button>
            )}
            {c.status !== "sending" && (
              <Button type="button" variant="ghost" touch size="sm" disabled={busy !== null} onClick={() => act("delete")} className="text-red-600">
                <Trash2 className="h-4 w-4" aria-hidden /> Delete
              </Button>
            )}
          </div>
        )
      }
    >
      {error && <ErrorState message={error} onRetry={load} />}
      {!c && !error && <SkeletonList count={3} />}
      {c && (
        <div className="space-y-5">
          <section aria-labelledby="funnel-h">
            <h3 id="funnel-h" className="mb-2 text-sm font-medium">
              Funnel
            </h3>
            {s ? (
              <div className="space-y-1.5">
                <FunnelBar label="Recipients" value={s.total} max={funnelMax} tone="bg-secondary-foreground/40" />
                <FunnelBar label="Sent" value={handed} max={funnelMax} />
                <FunnelBar label="Delivered" value={s.delivered + s.unsubscribed} max={funnelMax} tone="bg-emerald-500" />
                <FunnelBar label={`Opened (${s.open_rate}%)`} value={s.opened} max={funnelMax} tone="bg-sky-500" />
                <FunnelBar label={`Clicked (${s.click_rate}%)`} value={s.clicked} max={funnelMax} tone="bg-violet-500" />
                <FunnelBar label="Unsubscribed" value={s.unsubscribed} max={funnelMax} tone="bg-rose-400" />
                <FunnelBar label="Bounced" value={s.bounced} max={funnelMax} tone="bg-amber-500" />
                <FunnelBar label="No consent" value={s.skipped_no_consent} max={funnelMax} tone="bg-amber-300" />
                {s.queued > 0 && <p className="text-xs text-muted-foreground">{s.queued} still queued — the background sender picks them up every tick.</p>}
              </div>
            ) : (
              <SkeletonList count={3} itemClassName="h-3" />
            )}
            {detail && detail.links.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium">Top links</p>
                <ul className="space-y-1 text-xs">
                  {detail.links.map((l) => (
                    <li key={l.url} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground" title={l.url}>
                        {l.url}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {l.clicks} click{l.clicks === 1 ? "" : "s"} · {l.unique} unique
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="content-h">
            <h3 id="content-h" className="mb-2 text-sm font-medium">
              Content
            </h3>
            <ContentPreview value={{ subject: c.subject ?? "", preheader: c.preheader ?? "", body_md: c.body_md }} channel={c.channel} />
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input type={c.channel === "email" ? "email" : "tel"} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={c.channel === "email" ? "Send a test to… (defaults to you)" : "Phone for a test SMS"} aria-label="Test recipient" />
              <Button type="button" variant="secondary" touch disabled={busy !== null || (c.channel === "sms" && !testTo)} onClick={() => act("test")}>
                {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Test send
              </Button>
            </div>
          </section>

          <section aria-labelledby="recipients-h">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="recipients-h" className="text-sm font-medium">
                Recipients
              </h3>
              <label className="sr-only" htmlFor="recipient-status">
                Filter recipients by status
              </label>
              <Select id="recipient-status" value={rStatus} onChange={(e) => setRStatus(e.target.value as RecipientStatus | "")} className="h-8 w-auto text-xs">
                <option value="">All</option>
                {RECIPIENT_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
            {recipients.length === 0 && !rLoading ? (
              <p className="text-xs text-muted-foreground">{c.status === "draft" ? "Recipients are materialised when you launch." : "No recipients match."}</p>
            ) : (
              <TableScroller label="Recipients">
                <table className="w-full text-xs">
                  <thead className={THEAD}>
                    <tr>
                      <th className={TH}>Contact</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Opened</th>
                      <th className={TH}>Clicked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <p className="font-medium">{r.full_name ?? "Contact"}</p>
                          <p className="text-muted-foreground">{c.channel === "email" ? r.email : r.phone}</p>
                        </td>
                        <td className="px-3 py-2">
                          <StatusPill status={r.status} map={RECIPIENT_TONE} />
                          {r.error && <p className="mt-0.5 max-w-[12rem] truncate text-muted-foreground" title={r.error}>{r.error}</p>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.opened_at ? timeAgo(r.opened_at) : "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.clicked_at ? timeAgo(r.clicked_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
            <LoadMore hasMore={Boolean(rCursor)} loading={rLoading} count={recipients.length} onMore={() => loadRecipients(rCursor)} noun="recipients" auto={false} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
