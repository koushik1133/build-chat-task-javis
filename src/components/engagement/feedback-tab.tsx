"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { defaultQuestions, type Question, type SurveyKind } from "@/lib/engagement/pure";
import type { SurveyDTO, SurveyResults } from "@/lib/engagement/surveys";
import { apiJson, errMsg } from "./shared";

const TRIGGERS = [
  { v: "", l: "Manual / link only" },
  { v: "order.fulfilled", l: "Order fulfilled" },
  { v: "shipment.delivered", l: "Shipment delivered" },
  { v: "invoice.paid", l: "Invoice paid" },
  { v: "ticket.resolved", l: "Ticket resolved" },
  { v: "booking.completed", l: "Booking completed (2h after end)" },
];

/** Inline SVG sparkline with a table fallback for screen readers. */
function Trend({ points, label }: { points: Array<{ week: string; value: number | null }>; label: string }) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length < 2) return <p className="text-xs text-muted-foreground">Not enough data for a trend yet.</p>;
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 1);
  const w = 240;
  const h = 56;
  const real = points.filter((p) => p.value !== null);
  const last = real[real.length - 1];
  const summary = `${label}: ${real.length} weeks, from ${real[0].value} to ${last.value}, low ${Math.min(...vals)}, high ${Math.max(...vals)}`;
  const xy = points.filter((p) => p.value !== null).map((p, i, a) => `${(i / (a.length - 1)) * w},${h - (((p.value as number) - min) / (max - min || 1)) * (h - 6) - 3}`);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={summary} className="h-14 w-full max-w-xs text-primary">
        <polyline points={xy.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xy[xy.length - 1].split(",")[0]} cy={xy[xy.length - 1].split(",")[1]} r="3.5" fill="currentColor" stroke="hsl(var(--card))" strokeWidth="2" />
      </svg>
      <p className="text-xs text-muted-foreground">Latest <strong className="font-semibold text-foreground tabular-nums">{last.value}</strong> · low <span className="tabular-nums">{Math.min(...vals)}</span> · high <span className="tabular-nums">{Math.max(...vals)}</span></p>
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Show as table</summary>
        <table className="mt-1"><caption className="sr-only">{label}</caption><tbody>{points.map((p) => <tr key={p.week}><th scope="row" className="pr-3 text-left font-normal">{p.week}</th><td>{p.value ?? "-"}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

function Results({ id }: { id: string }) {
  const [r, setR] = useState<SurveyResults | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setR(await apiJson<SurveyResults>(`/api/engagement/surveys/${id}/results`)); setErr(null); } catch (e) { setErr(errMsg(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function publish(responseId: string) {
    try { await apiJson("/api/engagement/responses", { method: "PATCH", json: { id: responseId, action: "publish" } }); setNote("Published as a testimonial."); await load(); } catch (e) { setNote(errMsg(e)); }
  }
  if (err) return <ErrorState message={err} onRetry={() => void load()} />;
  if (!r) return <Loading label="Loading results…" />;
  const headline = r.nps ? r.nps.nps : r.csat ? r.csat.csat : r.average;
  const dist = r.distribution;
  const maxCount = Math.max(1, ...dist.counts);
  return (
    <div className="space-y-4">
      {note && <Banner tone="info" onDismiss={() => setNote(null)}>{note}</Banner>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">{r.survey.kind === "nps" ? "Net Promoter Score" : r.survey.kind === "csat" ? "CSAT (% 4-5)" : "Average"}</p><p className="text-3xl font-semibold tabular-nums">{headline ?? "-"}</p></div>
        <div className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">Responses</p><p className="text-3xl font-semibold tabular-nums">{r.responses}</p></div>
        <div className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">Response rate</p><p className="text-3xl font-semibold tabular-nums">{r.response_rate === null ? "-" : `${r.response_rate}%`}</p></div>
      </div>
      {r.nps && (() => {
        const n = r.nps;
        const tot = Math.max(1, n.promoters + n.passives + n.detractors);
        const seg = [
          { k: "Detractors", v: n.detractors, cls: "bg-red-600", mark: "▼" },
          { k: "Passives", v: n.passives, cls: "bg-slate-400", mark: "●" },
          { k: "Promoters", v: n.promoters, cls: "bg-emerald-600", mark: "▲" },
        ];
        return (
          <div>
            <div role="img" aria-label={`Score breakdown: ${seg.map((s) => `${s.v} ${s.k.toLowerCase()}`).join(", ")}`} className="flex h-3 overflow-hidden rounded-full bg-secondary">
              {seg.map((s) => s.v > 0 && <span key={s.k} className={s.cls} style={{ width: `${(s.v / tot) * 100}%`, marginInlineEnd: 2 }} />)}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {seg.map((s) => <li key={s.k}><span aria-hidden>{s.mark}</span> {s.k}: <span className="tabular-nums font-medium text-foreground">{s.v}</span> ({Math.round((s.v / tot) * 100)}%)</li>)}
            </ul>
          </div>
        );
      })()}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Score distribution">
          <h3 className="mb-1 text-sm font-semibold">Distribution</h3>
          <ul className="space-y-1">
            {dist.counts.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-right tabular-nums">{dist.min + i}</span>
                <span className="h-3 flex-1 overflow-hidden rounded bg-secondary" aria-hidden><span className="block h-full bg-primary" style={{ width: `${(c / maxCount) * 100}%` }} /></span>
                <span className="w-8 tabular-nums">{c}</span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Trend"><h3 className="mb-1 text-sm font-semibold">Weekly trend</h3><Trend points={r.trend} label={`${r.survey.name} weekly trend`} /></section>
      </div>
      <section aria-label="Comments">
        <h3 className="mb-1 text-sm font-semibold">Comments</h3>
        {r.comments.length === 0 ? <p className="text-sm text-muted-foreground">No comments yet.</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {r.comments.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm">
                <div className="min-w-0">
                  <p className="break-words">{c.comment}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.contact_name ?? "Anonymous"} · score {c.score ?? "-"} · {new Date(c.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  {c.testimonial_id ? <Pill tone="success">Testimonial</Pill> : c.public ? <Button size="sm" variant="outline" touch onClick={() => void publish(c.id)}><Star className="mr-1 h-4 w-4" aria-hidden />Publish</Button> : <Pill tone="neutral" title="The customer did not tick the public-display box">Private</Pill>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Editor({ survey, onClose, onSaved }: { survey: SurveyDTO | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(survey?.name ?? "");
  const [kind, setKind] = useState<SurveyKind>(survey?.kind ?? "nps");
  const [questions, setQuestions] = useState<Question[]>(survey?.questions ?? defaultQuestions("nps"));
  const [trigger, setTrigger] = useState(survey?.trigger_event ?? "order.fulfilled");
  const [delay, setDelay] = useState(String(survey?.delay_hours ?? 24));
  const [channel, setChannel] = useState(survey?.channel ?? "email");
  const [thanks, setThanks] = useState(survey?.thank_you_md ?? "Thank you for your feedback!");
  const [prompt, setPrompt] = useState(survey?.public_review_prompt ?? false);
  const [reviewUrl, setReviewUrl] = useState(survey?.review_url ?? "");
  const [active, setActive] = useState(survey?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const json = { name, kind, questions, trigger_event: trigger || null, delay_hours: Number(delay) || 0, channel, thank_you_md: thanks || null, public_review_prompt: prompt, review_url: reviewUrl || null, active };
      if (survey) await apiJson(`/api/engagement/surveys/${survey.id}`, { method: "PATCH", json }); else await apiJson("/api/engagement/surveys", { method: "POST", json });
      onSaved(); onClose();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Dialog title={survey ? "Edit survey" : "New survey"} size="lg" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
          <Field label="Type"><Select value={kind} onChange={(e) => { const k = e.target.value as SurveyKind; setKind(k); if (!survey) setQuestions(defaultQuestions(k)); }}><option value="nps">NPS (0-10)</option><option value="csat">CSAT (1-5)</option><option value="custom">Custom</option></Select></Field>
          <Field label="Send after"><Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>{TRIGGERS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</Select></Field>
          <Field label="Delay (hours)"><Input type="number" min={0} max={1440} value={delay} onChange={(e) => setDelay(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Channel" hint="SMS is only sent to contacts who consented to SMS marketing."><Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}><option value="email">Email</option><option value="sms">SMS</option><option value="link">Link only</option></Select></Field>
        </div>
        <fieldset className="space-y-2"><legend className="text-xs font-medium">Questions</legend>
          {questions.map((q, i) => (
            <div key={q.id} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
              <Input aria-label={`Question ${i + 1} text`} value={q.label} onChange={(e) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={300} />
              <Select aria-label={`Question ${i + 1} type`} value={q.type} onChange={(e) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, type: e.target.value as Question["type"] } : x)))}><option value="nps">NPS 0-10</option><option value="rating">Rating 1-5</option><option value="text">Free text</option></Select>
              <Button type="button" variant="ghost" size="sm" touch disabled={questions.length <= 1} onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          {questions.length < 12 && <Button type="button" variant="outline" size="sm" touch onClick={() => setQuestions((qs) => [...qs, { id: `q${Date.now().toString(36)}`, type: "text", label: "New question" }])}><Plus className="mr-1 h-4 w-4" aria-hidden />Add question</Button>}
        </fieldset>
        <Field label="Thank-you message"><Textarea rows={2} value={thanks} onChange={(e) => setThanks(e.target.value)} maxLength={2000} /></Field>
        <Checkbox checked={prompt} onChange={(e) => setPrompt(e.target.checked)} label="Invite happy customers (9-10 / 5 stars) to leave a public review" />
        {prompt && <Field label="Review link (https)" hint="Google or Facebook review URL."><Input type="url" value={reviewUrl} onChange={(e) => setReviewUrl(e.target.value)} placeholder="https://g.page/r/..." /></Field>}
        <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} label="Active" />
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save survey"}</Button></DialogFooter>
      </form>
    </Dialog>
  );
}

export function FeedbackTab() {
  const [surveys, setSurveys] = useState<SurveyDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<SurveyDTO | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const j = await apiJson<{ surveys: SurveyDTO[] }>("/api/engagement/surveys"); setSurveys(j.surveys); setErr(null); setSelected((s) => s ?? j.surveys[0]?.id ?? null); } catch (e) { setErr(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (err) return <ErrorState message={err} onRetry={() => void load()} />;
  if (!surveys) return <Loading label="Loading surveys…" />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Ask customers how they did after an order, invoice, booking or support ticket.</p>
        <Button touch onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" aria-hidden />New survey</Button>
      </div>
      {surveys.length === 0 ? <Empty title="No surveys yet" text="Create an NPS or CSAT survey to start collecting feedback." /> : (
        <TableScroller label="Surveys">
          <table className="w-full text-sm"><thead className={THEAD}><tr><th className={TH}>Name</th><th className={TH}>Type</th><th className={TH}>Trigger</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">
              {surveys.map((s) => (
                <tr key={s.id} className={selected === s.id ? "bg-accent/30" : ""}>
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2 uppercase">{s.kind}</td>
                  <td className="px-3 py-2">{s.trigger_event ? `${s.trigger_event} +${s.delay_hours}h` : "Manual"}</td>
                  <td className="px-3 py-2"><Pill tone={s.active ? "success" : "neutral"}>{s.active ? "Active" : "Paused"}</Pill></td>
                  <td className="space-x-1 px-3 py-2 text-right"><Button size="sm" variant="outline" touch aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>Results</Button><Button size="sm" variant="ghost" touch onClick={() => setEditing(s)}>Edit</Button></td>
                </tr>
              ))}
            </tbody></table>
        </TableScroller>
      )}
      {selected && <Results id={selected} key={selected} />}
      {editing && <Editor survey={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </div>
  );
}
