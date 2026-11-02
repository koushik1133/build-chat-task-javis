"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Pause, PhoneCall, PhoneOutgoing, Play, Plus, RefreshCw, Square, UserPlus } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import type { CallRow, CampaignRow, TargetRow } from "@/lib/voice/campaigns";
import { DEFAULT_VOICE, mergeScript, VOICES } from "@/lib/voice/twiml";
import { emptyStats, type CampaignStats } from "@/lib/voice/window";
import { cn, timeAgo } from "@/lib/utils";

type CampaignListRow = CampaignRow & { stats: CampaignStats };
type Mode = "live" | "simulated";
type Notice = { tone: "success" | "error" | "info"; text: string };

const CAMPAIGN_TONE: Record<string, Tone> = { draft: "neutral", scheduled: "info", running: "success", paused: "warning", done: "violet" };
const TARGET_TONE: Record<string, Tone> = { queued: "neutral", calling: "info", answered: "success", voicemail: "accent", no_answer: "warning", failed: "danger", opted_out: "danger", done: "violet" };
const LIFECYCLES = ["", "lead", "prospect", "customer", "churned", "donor", "patient", "student"];

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : `${fallback} (${res.status})`;
}

function parseOutcome(raw: string | null): { gather?: string; digits?: string | null; simulated?: boolean; error?: string; answered_by?: string | null } {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ReturnType<typeof parseOutcome>;
  } catch {
    return {};
  }
}

function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const list = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  const common = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Madrid", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
  return Array.from(new Set([...common, ...list]));
}

export default function VoicePage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Voice Campaigns">
          <Loading label="Loading campaigns…" />
        </PageContainer>
      }
    >
      <VoiceInner />
    </Suspense>
  );
}

function VoiceInner() {
  const router = useRouter();
  const search = useSearchParams();
  const selectedId = search.get("campaign");
  const nextSignal = useAbortable();

  const [campaigns, setCampaigns] = useState<CampaignListRow[]>([]);
  const [mode, setMode] = useState<Mode>("simulated");
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [wizard, setWizard] = useState(false);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/campaigns", { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load campaigns."));
      const data = await res.json();
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
      setMode(data.mode === "live" ? "live" : "simulated");
      setMigrated(data.migrated !== false);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load campaigns.");
    } finally {
      setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (id: string | null) => router.replace(id ? `/voice?campaign=${encodeURIComponent(id)}` : "/voice");

  return (
    <PageContainer
      wide
      title="Voice Campaigns"
      icon={<PhoneOutgoing className="h-5 w-5" aria-hidden />}
      description="Automated outbound calls that read a script to your contacts and capture a yes/no with one key press."
      tooltip="Calls are placed by the background worker inside the campaign's calling window, in its timezone. Contacts on the do-not-call list are never dialled. Press 2 on a call opts the number out automatically."
      actions={
        <Button onClick={() => setWizard(true)} disabled={!migrated} touch>
          <Plus className="h-4 w-4" aria-hidden />
          New campaign
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}
      {!migrated && !loading && (
        <Banner tone="warn">
          The voice tables are missing. Apply <code className="font-mono">aws/phase4/d.sql</code> to enable campaigns.
        </Banner>
      )}
      {mode === "simulated" && !loading && (
        <Banner tone="info">
          <strong>Simulated dialer.</strong> No real calls are placed; outcomes are drawn at random so you can test the flow. Set{" "}
          <code className="font-mono">TWILIO_ACCOUNT_SID</code>, <code className="font-mono">TWILIO_AUTH_TOKEN</code> and <code className="font-mono">TWILIO_FROM_NUMBER</code> to go live.
        </Banner>
      )}

      {selectedId ? (
        <CampaignDetail id={selectedId} mode={mode} onBack={() => select(null)} onChanged={() => void load()} setNotice={setNotice} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && campaigns.length === 0 ? (
        <Loading label="Loading campaigns…" />
      ) : campaigns.length === 0 ? (
        <Empty
          icon={<PhoneCall className="h-5 w-5" />}
          title="No campaigns yet"
          text="Create one to call a list of contacts with a spoken script, inside a calling window you choose."
          action={
            <Button onClick={() => setWizard(true)} disabled={!migrated}>
              <Plus className="h-4 w-4" aria-hidden />
              New campaign
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh campaigns">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Refresh
            </Button>
          </div>
          <TableScroller label="Campaigns">
            <table className="w-full min-w-[760px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Campaign</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Window</th>
                  <th className={`${TH} text-right`}>Targets</th>
                  <th className={`${TH} text-right`}>Answered</th>
                  <th className={`${TH} text-right`}>Interested</th>
                  <th className={TH}>Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-secondary/40">
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => select(c.id)} className="min-h-11 text-left font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
                        {c.name}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={c.status} map={CAMPAIGN_TONE} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {c.window_start}–{c.window_end} <span className="text-xs">{c.timezone}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.stats.total}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.stats.answered}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.stats.interested}</td>
                    <td className="px-3 py-2 text-muted-foreground">{timeAgo(c.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </>
      )}

      {wizard && (
        <CampaignWizard
          mode={mode}
          onClose={() => setWizard(false)}
          onCreated={(c, text) => {
            setWizard(false);
            setNotice({ tone: "success", text });
            void load();
            select(c.id);
          }}
        />
      )}
    </PageContainer>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function StatTile({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold tabular-nums", tone === "success" && "text-emerald-600 dark:text-emerald-400", tone === "danger" && "text-red-600 dark:text-red-400")}>{value}</div>
    </div>
  );
}

function CampaignDetail({ id, mode, onBack, onChanged, setNotice }: { id: string; mode: Mode; onBack: () => void; onChanged: () => void; setNotice: (n: Notice | null) => void }) {
  const nextSignal = useAbortable();
  const [campaign, setCampaign] = useState<CampaignRow | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [stats, setStats] = useState<CampaignStats>(emptyStats());
  const [windowOpen, setWindowOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const res = await fetch(`/api/voice/campaigns/${encodeURIComponent(id)}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load the campaign."));
      const data = await res.json();
      setCampaign(data.campaign);
      setTargets(Array.isArray(data.targets) ? data.targets : []);
      setCalls(Array.isArray(data.calls) ? data.calls : []);
      setStats(data.stats ?? emptyStats());
      setWindowOpen(Boolean(data.windowOpen));
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load the campaign.");
    } finally {
      setLoading(false);
    }
  }, [id, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live stats while the dialer is working.
  useEffect(() => {
    if (campaign?.status !== "running") return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [campaign?.status, load]);

  async function setStatus(status: "running" | "paused" | "done") {
    setBusy(true);
    try {
      const res = await fetch(`/api/voice/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (!res.ok) throw new Error(await readError(res, "Could not update the campaign."));
      const data = await res.json();
      setCampaign(data.campaign);
      setNotice({ tone: "success", text: `Campaign ${data.campaign?.status === "scheduled" ? "scheduled" : status === "running" ? "started" : status}.` });
      onChanged();
      void load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not update the campaign." });
    } finally {
      setBusy(false);
    }
  }

  const callBySid = useMemo(() => new Map(calls.map((c) => [c.call_sid ?? "", c])), [calls]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (loading || !campaign) return <Loading label="Loading campaign…" />;

  const canStart = campaign.status === "draft" || campaign.status === "paused" || campaign.status === "scheduled";
  const canPause = campaign.status === "running" || campaign.status === "scheduled";
  const canFinish = campaign.status === "running" || campaign.status === "paused";

  return (
    <section aria-labelledby="campaign-heading" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="mb-1 inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All campaigns
          </button>
          <h2 id="campaign-heading" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <span className="break-words">{campaign.name}</span>
            <StatusPill status={campaign.status} map={CAMPAIGN_TONE} />
            {mode === "simulated" && <Pill tone="warning">simulated</Pill>}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Calls {campaign.window_start}–{campaign.window_end} {campaign.timezone} · up to {campaign.max_attempts} attempt{campaign.max_attempts === 1 ? "" : "s"} · voice {campaign.voice}
            {campaign.schedule_at && ` · starts ${new Date(campaign.schedule_at).toLocaleString()}`}
            {campaign.status === "running" && (windowOpen ? " · window open, dialling" : " · outside the calling window, waiting")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} disabled={campaign.status === "done"}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            Add targets
          </Button>
          {canStart && (
            <Button size="sm" onClick={() => void setStatus("running")} disabled={busy || stats.total === 0} title={stats.total === 0 ? "Add targets first" : undefined}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              {campaign.status === "paused" ? "Resume" : "Start"}
            </Button>
          )}
          {canPause && (
            <Button size="sm" variant="outline" onClick={() => void setStatus("paused")} disabled={busy}>
              <Pause className="h-3.5 w-3.5" aria-hidden />
              Pause
            </Button>
          )}
          {canFinish && (
            <Button size="sm" variant="ghost" onClick={() => void setStatus("done")} disabled={busy}>
              <Square className="h-3.5 w-3.5" aria-hidden />
              Finish
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh campaign">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="Campaign stats">
        <StatTile label="Targets" value={stats.total} />
        <StatTile label="Queued" value={stats.queued} />
        <StatTile label="Calling" value={stats.calling} />
        <StatTile label="Answered" value={stats.answered} tone="success" />
        <StatTile label="Interested" value={stats.interested} tone="success" />
        <StatTile label="Voicemail" value={stats.voicemail} />
        <StatTile label="No answer" value={stats.no_answer} />
        <StatTile label="Opted out" value={stats.opted_out} tone="danger" />
      </div>

      <details className="rounded-lg border border-border bg-card p-3">
        <summary className="cursor-pointer text-sm font-medium">Script</summary>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{campaign.script}</p>
      </details>

      {targets.length === 0 ? (
        <Empty icon={<UserPlus className="h-5 w-5" />} title="No targets yet" text="Add contacts or phone numbers to this campaign." action={<Button size="sm" onClick={() => setAddOpen(true)}>Add targets</Button>} />
      ) : (
        <TableScroller label="Campaign targets">
          <table className="w-full min-w-[720px] text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Phone</th>
                <th className={TH}>Name</th>
                <th className={TH}>Status</th>
                <th className={TH}>Result</th>
                <th className={`${TH} text-right`}>Attempts</th>
                <th className={TH}>Last call</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {targets.map((t) => {
                const o = parseOutcome(t.outcome);
                const call = callBySid.get(t.call_sid ?? "");
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-2 font-mono text-xs">{t.phone}</td>
                    <td className="px-3 py-2">{t.first_name ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={t.status} map={TARGET_TONE} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {o.gather === "interested" ? <Pill tone="success">Pressed 1 · interested</Pill> : o.gather === "opted_out" ? <Pill tone="danger">Pressed 2 · opt out</Pill> : o.error ? <span className="text-red-700 dark:text-red-300">{o.error}</span> : o.answered_by?.startsWith("machine") ? "Voicemail" : o.gather === "no_input" ? "No key pressed" : "—"}
                      {o.simulated && <span className="ml-1 text-[10px] uppercase tracking-wide">(simulated)</span>}
                      {call?.duration_s ? <span className="ml-1">· {call.duration_s}s</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.attempts}</td>
                    <td className="px-3 py-2 text-muted-foreground">{t.last_attempt_at ? timeAgo(t.last_attempt_at) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}

      {addOpen && (
        <AddTargetsDialog
          campaignId={id}
          onClose={() => setAddOpen(false)}
          onDone={(text) => {
            setAddOpen(false);
            setNotice({ tone: "success", text });
            void load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

// ── Audience editor (shared by wizard + detail) ──────────────────────────────

interface AudienceState {
  source: "filter" | "phones";
  lifecycle: string;
  tag: string;
  q: string;
  phones: string;
}

function parsePhoneLines(text: string): Array<{ phone: string; first_name: string | null }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [phone, ...rest] = l.split(/[,;\t]/);
      return { phone: phone.trim(), first_name: rest.join(" ").trim() || null };
    })
    .filter((p) => p.phone.length >= 5);
}

function audienceBody(a: AudienceState) {
  if (a.source === "phones") return { phones: parsePhoneLines(a.phones) };
  return { filter: { lifecycle: a.lifecycle || null, tag: a.tag.trim() || null, q: a.q.trim() || null } };
}

function AudienceEditor({ value, onChange }: { value: AudienceState; onChange: (v: AudienceState) => void }) {
  const nextSignal = useAbortable();
  const debouncedQ = useDebouncedValue(value.q, 300);
  const [preview, setPreview] = useState<{ total: number; withPhone: number } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  useEffect(() => {
    if (value.source !== "filter") return;
    const signal = nextSignal();
    const params = new URLSearchParams();
    if (value.lifecycle) params.set("lifecycle", value.lifecycle);
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    fetch(`/api/crm/contacts?${params.toString()}`, { cache: "no-store", signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, "Could not preview contacts."));
        const data = await res.json();
        const rows: Array<{ phone?: string | null; tags?: string | null }> = Array.isArray(data.contacts) ? data.contacts : [];
        const tag = value.tag.trim();
        const matched = tag ? rows.filter((r) => (r.tags ?? "").includes(`"${tag}"`)) : rows;
        setPreview({ total: matched.length, withPhone: matched.filter((r) => (r.phone ?? "").replace(/\D/g, "").length >= 7).length });
        setPreviewErr(null);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setPreviewErr(err instanceof Error ? err.message : "Could not preview contacts.");
      });
  }, [value.source, value.lifecycle, value.tag, debouncedQ, nextSignal]);

  const phones = parsePhoneLines(value.phones);

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 text-xs font-medium">Audience source</legend>
        <div className="flex flex-wrap gap-3">
          {(["filter", "phones"] as const).map((s) => (
            <label key={s} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
              <input type="radio" name="audience-source" value={s} checked={value.source === s} onChange={() => onChange({ ...value, source: s })} className="accent-primary" />
              {s === "filter" ? "CRM contacts" : "Paste phone numbers"}
            </label>
          ))}
        </div>
      </fieldset>

      {value.source === "filter" ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Lifecycle">
              <Select value={value.lifecycle} onChange={(e) => onChange({ ...value, lifecycle: e.target.value })}>
                {LIFECYCLES.map((l) => (
                  <option key={l} value={l}>
                    {l || "Any"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tag" hint="Exact tag, e.g. newsletter">
              <Input value={value.tag} onChange={(e) => onChange({ ...value, tag: e.target.value })} maxLength={60} />
            </Field>
            <Field label="Search" hint="Name, company or email contains">
              <Input value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} maxLength={120} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {previewErr ? (
              <span className="text-red-700 dark:text-red-300">{previewErr}</span>
            ) : preview ? (
              <>
                {preview.total} contact{preview.total === 1 ? "" : "s"} match (first 200 shown), <strong>{preview.withPhone}</strong> with a phone number. Contacts tagged <code className="font-mono">do_not_call</code> or on the opt-out list are skipped.
              </>
            ) : (
              "Counting matching contacts…"
            )}
          </p>
        </>
      ) : (
        <Field label="Phone numbers" hint="One per line: phone, first name (optional). Example: +1 555 010 0200, Ana" required>
          <Textarea rows={6} value={value.phones} onChange={(e) => onChange({ ...value, phones: e.target.value })} placeholder={"+15550100200, Ana\n+15550100201"} />
        </Field>
      )}
      {value.source === "phones" && (
        <p className="text-xs text-muted-foreground" role="status">
          {phones.length} number{phones.length === 1 ? "" : "s"} recognised.
        </p>
      )}
    </div>
  );
}

function AddTargetsDialog({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: (text: string) => void }) {
  const [audience, setAudience] = useState<AudienceState>({ source: "filter", lifecycle: "", tag: "", q: "", phones: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/voice/campaigns/${encodeURIComponent(campaignId)}/targets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(audienceBody(audience)) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not add targets.");
      onDone(`Added ${data.added} target${data.added === 1 ? "" : "s"}${data.skipped_dnc ? `, ${data.skipped_dnc} skipped (do-not-call)` : ""}${data.skipped_duplicate ? `, ${data.skipped_duplicate} already in the campaign` : ""}.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add targets.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add targets" description="Contacts on the do-not-call list are skipped automatically." onClose={onClose} size="lg">
      <form onSubmit={submit}>
        {err && <Banner tone="error">{err}</Banner>}
        <AudienceEditor value={audience} onChange={setAudience} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (audience.source === "phones" && parsePhoneLines(audience.phones).length === 0)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Add targets
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ── Wizard ───────────────────────────────────────────────────────────────────

const STEPS = ["Name", "Script", "Audience", "Window", "Review"] as const;

function CampaignWizard({ mode, onClose, onCreated }: { mode: Mode; onClose: () => void; onCreated: (c: CampaignRow, text: string) => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [script, setScript] = useState("Hi {{first_name}}, this is a quick call from our team. We have a few openings next week and wanted to check whether you'd like to book a visit.");
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  const [audience, setAudience] = useState<AudienceState>({ source: "filter", lifecycle: "lead", tag: "", q: "", phones: "" });
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tzList = useMemo(timezones, []);

  const stepError = (): string | null => {
    if (step === 0 && !name.trim()) return "Give the campaign a name.";
    if (step === 1 && script.trim().length < 10) return "The script needs at least 10 characters.";
    if (step === 2 && audience.source === "phones" && parsePhoneLines(audience.phones).length === 0) return "Add at least one phone number.";
    if (step === 3 && windowStart === windowEnd) return "The window start and end must differ.";
    return null;
  };

  function next() {
    const e = stepError();
    if (e) {
      setErr(e);
      return;
    }
    setErr(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  async function create(start: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        script: script.trim(),
        voice,
        timezone,
        window_start: windowStart,
        window_end: windowEnd,
        max_attempts: maxAttempts,
        schedule_at: scheduleAt ? new Date(scheduleAt).toISOString() : null,
        audience: audienceBody(audience),
        start,
      };
      const res = await fetch("/api/voice/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not create the campaign.");
      const a = data.audience ?? {};
      onCreated(
        data.campaign,
        `Campaign "${data.campaign.name}" ${start ? (data.campaign.status === "scheduled" ? "scheduled" : "started") : "saved as draft"} with ${a.added ?? 0} target${a.added === 1 ? "" : "s"}${a.skipped_dnc ? ` (${a.skipped_dnc} skipped, do-not-call)` : ""}.`
      );
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the campaign.");
    } finally {
      setBusy(false);
    }
  }

  const preview = mergeScript(script, { first_name: "Ana", full_name: "Ana López", company: "Acme" });

  return (
    <Dialog title="New voice campaign" description={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} onClose={onClose} size="lg">
      <ol className="mb-4 flex flex-wrap gap-1 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={cn("rounded-full px-2 py-0.5", i === step ? "bg-primary text-primary-foreground" : i < step ? "bg-secondary text-foreground" : "text-muted-foreground")}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      {err && <Banner tone="error">{err}</Banner>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step < STEPS.length - 1) next();
        }}
      >
        {step === 0 && (
          <Field label="Campaign name" required hint="Internal only — callers never hear it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus required />
          </Field>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <Field label="Script" required hint="Read aloud when the call is answered. Merge fields: {{first_name}}, {{full_name}}, {{company}}. Callers are then asked to press 1 (interested) or 2 (opt out).">
              <Textarea rows={6} value={script} onChange={(e) => setScript(e.target.value)} maxLength={3000} required />
            </Field>
            <Field label="Voice">
              <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Preview for Ana López (Acme)</div>
              <p className="whitespace-pre-wrap">{preview || "…"}</p>
            </div>
          </div>
        )}

        {step === 2 && <AudienceEditor value={audience} onChange={setAudience} />}

        {step === 3 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Timezone" required hint="The window is evaluated in this zone.">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {tzList.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Max attempts per number">
              <Select value={String(maxAttempts)} onChange={(e) => setMaxAttempts(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Window start" required>
              <Input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
            </Field>
            <Field label="Window end" required>
              <Input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} required />
            </Field>
            <Field label="Start on" hint="Leave empty to start as soon as you launch it. Weekends are always skipped." className="sm:col-span-2">
              <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            </Field>
          </div>
        )}

        {step === 4 && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{name}</dd>
            <dt className="text-muted-foreground">Script</dt>
            <dd className="whitespace-pre-wrap">{script}</dd>
            <dt className="text-muted-foreground">Voice</dt>
            <dd>{voice}</dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd>
              {audience.source === "phones"
                ? `${parsePhoneLines(audience.phones).length} pasted number(s)`
                : `CRM contacts${audience.lifecycle ? ` · lifecycle ${audience.lifecycle}` : ""}${audience.tag ? ` · tag ${audience.tag}` : ""}${audience.q ? ` · "${audience.q}"` : ""}`}
            </dd>
            <dt className="text-muted-foreground">Window</dt>
            <dd>
              {windowStart}–{windowEnd} {timezone}, weekdays, up to {maxAttempts} attempt{maxAttempts === 1 ? "" : "s"}
              {scheduleAt && ` · starts ${new Date(scheduleAt).toLocaleString()}`}
            </dd>
            <dt className="text-muted-foreground">Dialer</dt>
            <dd>{mode === "live" ? "Twilio (live calls)" : "Simulated — no real calls"}</dd>
          </dl>
        )}

        <DialogFooter start={step > 0 ? <span>Back to change anything before launch.</span> : undefined}>
          {step > 0 && (
            <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="submit">Next</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void create(false)} disabled={busy}>
                Save as draft
              </Button>
              <Button type="button" onClick={() => void create(true)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                {scheduleAt ? "Schedule" : "Start calling"}
              </Button>
            </>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
