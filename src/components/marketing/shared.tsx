"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { useDebouncedValue } from "@/components/ui/hooks";
import { cn } from "@/lib/utils";
import { markdownToHtml, renderMerge, ensureUnsubscribe, SAMPLE_VARS, hasUnsubscribe } from "@/lib/marketing/render";
import { LIFECYCLES, MERGE_FIELDS, type AudienceDefinition, type MarketingSendChannel } from "@/lib/marketing/types";

/* ---------- shared helpers ---------- */

export type Notice = { tone: "success" | "error" | "info"; text: string };

export async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
  if (typeof d.detail === "string") return d.detail;
  const flat = d.detail as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
  const field = flat?.fieldErrors ? Object.entries(flat.fieldErrors)[0] : null;
  if (field) return `${field[0]}: ${field[1][0]}`;
  if (flat?.formErrors?.[0]) return flat.formErrors[0];
  if (typeof d.error === "string") return `${d.error.replace(/_/g, " ")} (${res.status})`;
  return `${fallback} (${res.status})`;
}

export async function jsonFetch<T>(url: string, init?: RequestInit, fallback = "Request failed"): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export const CAMPAIGN_TONE: Record<string, Tone> = { draft: "neutral", scheduled: "info", sending: "accent", sent: "success", paused: "warning", cancelled: "danger" };
export const RECIPIENT_TONE: Record<string, Tone> = { queued: "neutral", skipped_no_consent: "warning", sent: "info", delivered: "success", bounced: "danger", failed: "danger", unsubscribed: "violet" };
export const ENROLLMENT_TONE: Record<string, Tone> = { active: "info", done: "success", exited: "warning" };

export function useNotice(): [Notice | null, (tone: Notice["tone"], text: string) => void, () => void] {
  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 7000);
  }, []);
  return [notice, notify, () => setNotice(null)];
}

export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <Banner tone={notice.tone === "error" ? "error" : notice.tone === "success" ? "success" : "info"} onDismiss={onDismiss}>
      {notice.text}
    </Banner>
  );
}

/* ---------- audience preview (live count) ---------- */

export interface AudiencePreview {
  count: number;
  eligible: number;
  channel: MarketingSendChannel;
  sample: Array<{ id: string; full_name: string; email: string | null; phone: string | null; company: string | null; lifecycle: string }>;
}

export function useAudiencePreview(definition: AudienceDefinition | null, channel: MarketingSendChannel) {
  const key = useDebouncedValue(JSON.stringify({ definition, channel }), 350);
  const [data, setData] = useState<AudiencePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  useEffect(() => {
    const parsed = JSON.parse(key) as { definition: AudienceDefinition | null; channel: MarketingSendChannel };
    if (!parsed.definition) {
      setData(null);
      return;
    }
    const my = ++gen.current;
    setLoading(true);
    setError(null);
    jsonFetch<AudiencePreview>("/api/marketing/preview", { method: "POST", body: JSON.stringify({ definition: parsed.definition, channel: parsed.channel, limit: 6 }) }, "Could not count the audience")
      .then((d) => {
        if (my === gen.current) setData(d);
      })
      .catch((e: unknown) => {
        if (my === gen.current) setError(e instanceof Error ? e.message : "Could not count the audience");
      })
      .finally(() => {
        if (my === gen.current) setLoading(false);
      });
  }, [key]);
  return { data, loading, error };
}

export function EligibilitySummary({ preview, loading, channel, className }: { preview: AudiencePreview | null; loading: boolean; channel: MarketingSendChannel; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm", className)} aria-live="polite">
      <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
      {loading && !preview ? (
        <span className="text-muted-foreground">Counting…</span>
      ) : preview ? (
        <>
          <span>
            <strong className="tabular-nums">{preview.count}</strong> contact{preview.count === 1 ? "" : "s"}
          </span>
          <Pill tone={preview.eligible > 0 ? "success" : "warning"} title={`Contacts with a current marketing_${channel} consent grant, an address on this channel and no opt-out`}>
            {preview.eligible} eligible for {channel}
          </Pill>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}
        </>
      ) : (
        <span className="text-muted-foreground">Pick filters to see the live count.</span>
      )}
    </div>
  );
}

/* ---------- audience builder (filter rows) ---------- */

const DEF_EMPTY: AudienceDefinition = {};

export function AudienceBuilder({ value, onChange, channel }: { value: AudienceDefinition; onChange: (d: AudienceDefinition) => void; channel: MarketingSendChannel }) {
  const def = value ?? DEF_EMPTY;
  const [tagInput, setTagInput] = useState((def.tags ?? []).join(", "));
  const set = (patch: Partial<AudienceDefinition>) => {
    const next: AudienceDefinition = { ...def, ...patch };
    for (const k of Object.keys(next) as Array<keyof AudienceDefinition>) {
      const v = next[k];
      if (v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    onChange(next);
  };
  const toggleLifecycle = (l: (typeof LIFECYCLES)[number]) => {
    const cur = def.lifecycle ?? [];
    set({ lifecycle: cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l] });
  };
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1 block text-xs font-medium">Lifecycle</legend>
        <div className="flex flex-wrap gap-1.5">
          {LIFECYCLES.map((l) => {
            const on = def.lifecycle?.includes(l) ?? false;
            return (
              <button
                key={l}
                type="button"
                aria-pressed={on}
                onClick={() => toggleLifecycle(l)}
                className={cn("min-h-11 touch-manipulation rounded-full border px-3 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:min-h-9", on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary/60")}
              >
                {l}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">None selected = any lifecycle.</p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tags (comma separated)" hint="Contact must carry every tag.">
          <Input
            value={tagInput}
            onChange={(e) => {
              setTagInput(e.target.value);
              set({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 20) });
            }}
            placeholder="vip, newsletter"
          />
        </Field>
        <Field label="Name, company or email contains">
          <Input value={def.q ?? ""} onChange={(e) => set({ q: e.target.value.slice(0, 120) })} placeholder="acme" />
        </Field>
        <Field label="Active in the last (days)" hint="Based on last contact / last update.">
          <Input type="number" min={1} max={3650} value={def.last_activity_days ?? ""} onChange={(e) => set({ last_activity_days: e.target.value ? Math.max(1, Math.min(3650, Number(e.target.value))) : undefined })} />
        </Field>
        <Field label="Consent on file" hint="Filter to contacts with a current grant.">
          <Select value={def.consent_purpose ?? ""} onChange={(e) => set({ consent_purpose: (e.target.value || undefined) as AudienceDefinition["consent_purpose"] })}>
            <option value="">Any (consent is still checked at send time)</option>
            <option value="marketing_email">Marketing email granted</option>
            <option value="marketing_sms">Marketing SMS granted</option>
          </Select>
        </Field>
        <Field label="Linked record type (slug)" hint="Optional: contacts with a record of this type.">
          <Input value={def.record_type ?? ""} onChange={(e) => set({ record_type: e.target.value.slice(0, 80) })} placeholder="deal" />
        </Field>
        <Field label="…in stage">
          <Input value={def.stage ?? ""} onChange={(e) => set({ stage: e.target.value.slice(0, 80) })} placeholder="won" disabled={!def.record_type} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Checkbox label="Has an email address" checked={def.has_email ?? channel === "email"} onChange={(e) => set({ has_email: e.target.checked })} />
        <Checkbox label="Has a phone number" checked={def.has_phone ?? channel === "sms"} onChange={(e) => set({ has_phone: e.target.checked })} />
      </div>
    </div>
  );
}

/* ---------- content composer ---------- */

export interface ContentValue {
  subject: string;
  preheader: string;
  body_md: string;
}

export function ContentEditor({
  value,
  onChange,
  channel,
  audienceId,
  showAi = true,
  compact = false,
}: {
  value: ContentValue;
  onChange: (v: ContentValue) => void;
  channel: MarketingSendChannel;
  audienceId?: string | null;
  showAi?: boolean;
  compact?: boolean;
}) {
  const [goal, setGoal] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insert = (token: string) => {
    const el = bodyRef.current;
    const t = `{{${token}}}`;
    if (!el) return onChange({ ...value, body_md: `${value.body_md}${t}` });
    const start = el.selectionStart ?? value.body_md.length;
    const end = el.selectionEnd ?? start;
    const next = value.body_md.slice(0, start) + t + value.body_md.slice(end);
    onChange({ ...value, body_md: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + t.length, start + t.length);
    });
  };

  async function draft() {
    if (goal.trim().length < 3) return;
    setDrafting(true);
    setAiError(null);
    try {
      const d = await jsonFetch<{ subject: string; preheader: string; body_md: string }>("/api/marketing/draft", { method: "POST", body: JSON.stringify({ goal: goal.trim(), channel, audience_id: audienceId ?? null }) }, "Could not draft");
      onChange({ subject: d.subject || value.subject, preheader: d.preheader || value.preheader, body_md: d.body_md });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Could not draft");
    } finally {
      setDrafting(false);
    }
  }

  const missingUnsub = channel === "email" && value.body_md.trim() && !hasUnsubscribe(value.body_md);

  return (
    <div className="space-y-3">
      {showAi && (
        <div className="rounded-lg border border-dashed border-border p-3">
          <label htmlFor="ai-goal" className="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Draft with AI
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="ai-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={channel === "sms" ? "e.g. 20% off this weekend for returning customers" : "e.g. announce our new Saturday opening hours"} />
            <Button type="button" variant="secondary" touch onClick={draft} disabled={drafting || goal.trim().length < 3}>
              {drafting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              {drafting ? "Drafting…" : "Draft"}
            </Button>
          </div>
          {aiError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {aiError}
            </p>
          )}
        </div>
      )}
      {channel === "email" && (
        <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
          <Field label="Subject" required>
            <Input value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value.slice(0, 300) })} placeholder="{{first_name}}, a quick update from {{org_name}}" />
          </Field>
          <Field label="Preheader" hint="Preview text shown next to the subject in inboxes.">
            <Input value={value.preheader} onChange={(e) => onChange({ ...value, preheader: e.target.value.slice(0, 300) })} />
          </Field>
        </div>
      )}
      <Field label={channel === "sms" ? "Message" : "Body (markdown)"} required hint={channel === "sms" ? "Keep it short; an opt-out link is appended automatically." : "Headings, lists, **bold** and [links](https://…) are supported. An unsubscribe link is added if you leave {{unsubscribe_url}} out."}>
        <Textarea ref={bodyRef} rows={compact ? 6 : 10} value={value.body_md} onChange={(e) => onChange({ ...value, body_md: e.target.value.slice(0, 50_000) })} className="font-mono text-xs" />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert merge field">
        <span className="text-xs text-muted-foreground">Insert:</span>
        {MERGE_FIELDS.filter((f) => channel === "email" || f.key !== "unsubscribe_url").map((f) => (
          <button key={f.key} type="button" onClick={() => insert(f.key)} className="min-h-11 touch-manipulation rounded-md border border-border px-2 font-mono text-[11px] hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8" title={f.label} aria-label={`Insert ${f.label}`}>
            {`{{${f.key}}}`}
          </button>
        ))}
      </div>
      {missingUnsub && <p className="text-xs text-muted-foreground">No {"{{unsubscribe_url}}"} yet — a footer with it will be appended on send.</p>}
      {channel === "sms" && <p className="text-xs text-muted-foreground tabular-nums">{renderMerge(value.body_md, SAMPLE_VARS).length} characters with sample values (160 per SMS segment).</p>}
    </div>
  );
}

/** Rendered preview with sample (or real) contact values. */
export function ContentPreview({ value, channel, vars = SAMPLE_VARS, className }: { value: ContentValue; channel: MarketingSendChannel; vars?: typeof SAMPLE_VARS; className?: string }) {
  const html = useMemo(() => (channel === "email" ? markdownToHtml(renderMerge(ensureUnsubscribe(value.body_md), vars)) : null), [value.body_md, channel, vars]);
  if (channel === "sms") {
    return (
      <div className={cn("rounded-lg border border-border bg-secondary/30 p-3", className)}>
        <p className="mb-1 text-xs font-medium text-muted-foreground">SMS preview</p>
        <p className="whitespace-pre-wrap text-sm">{renderMerge(value.body_md, vars)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Opt out: {vars.unsubscribe_url}</p>
      </div>
    );
  }
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border", className)}>
      <div className="border-b border-border bg-secondary/30 px-3 py-2 text-sm">
        <p className="font-medium [overflow-wrap:anywhere]">{renderMerge(value.subject, vars) || <span className="text-muted-foreground">(no subject)</span>}</p>
        {value.preheader && <p className="text-xs text-muted-foreground">{renderMerge(value.preheader, vars)}</p>}
      </div>
      <div className="prose-sm max-h-80 overflow-y-auto bg-white p-4 text-sm text-neutral-900 [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: html ?? "" }} />
    </div>
  );
}

/* ---------- funnel ---------- */

export const CHANNEL_LABEL: Record<MarketingSendChannel, string> = { email: "Email", sms: "SMS" };

export interface FunnelStage {
  label: string;
  value: number;
  /** Share of the funnel's first stage, 0–100. Computed when omitted. */
  pct?: number;
  /** Optional note shown after the value, e.g. a rate against delivered. */
  note?: string;
  /** Visual grouping: `stage` is the main funnel (one hue), `outcome` is a muted drop-off row. */
  kind?: "stage" | "outcome";
}

const nf = new Intl.NumberFormat();

/**
 * Horizontal funnel: thin bars, one hue for the funnel stages and a muted hue
 * for drop-offs, values in text tokens, direct labels. On phones the label sits
 * above a full-width bar; from `sm` up it is a three-column row. A plain-text
 * summary describes the whole figure to assistive tech and a real table sits
 * behind a disclosure for anyone who prefers numbers.
 */
export function Funnel({ title, stages, className }: { title: string; stages: FunnelStage[]; className?: string }) {
  const max = Math.max(1, stages[0]?.value ?? 1);
  const rows = stages.map((s) => ({ ...s, pct: s.pct ?? Math.min(100, Math.round((s.value / max) * 100)), kind: s.kind ?? "stage" }));
  const summary = `${title}: ${rows.map((r, i) => `${r.label} ${nf.format(r.value)}${i === 0 ? "" : ` (${r.pct}%)`}`).join("; ")}.`;
  return (
    <figure className={cn("min-w-0", className)}>
      <figcaption className="sr-only">{summary}</figcaption>
      <div role="img" aria-label={summary} className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:grid sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-2">
            <span className={cn("min-w-0 flex-1 truncate", r.kind === "outcome" ? "text-muted-foreground" : "text-foreground")}>{r.label}</span>
            <span className="order-2 shrink-0 text-right tabular-nums sm:order-3">
              <span className="font-medium">{nf.format(r.value)}</span>
              {r.note && <span className="ml-1 text-muted-foreground">{r.note}</span>}
            </span>
            <div className="order-3 h-2 w-full basis-full overflow-hidden rounded bg-secondary sm:order-2 sm:w-auto sm:basis-auto" aria-hidden>
              <div className={cn("h-full rounded transition-[width] motion-reduce:transition-none", r.kind === "outcome" ? "bg-muted-foreground/45" : "bg-primary")} style={{ width: `${r.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
      <details className="mt-2 text-xs">
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">Show as table</summary>
        <table className="mt-1 w-full border-collapse">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="py-1 text-left font-medium">
                Stage
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Count
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Of recipients
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-border/60">
                <th scope="row" className="py-1 text-left font-normal">
                  {r.label}
                </th>
                <td className="py-1 text-right tabular-nums">{nf.format(r.value)}</td>
                <td className="py-1 text-right tabular-nums">{r.pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
