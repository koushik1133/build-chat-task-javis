"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Textarea } from "@/components/ui/input";
import { Banner, Empty, Loading } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import type { Question } from "@/lib/engagement/pure";

interface PublicSurvey {
  org_name: string;
  name: string;
  kind: "nps" | "csat" | "custom";
  questions: Question[];
  already_completed: boolean;
}
type Answers = Record<string, string | number>;

/** One scale question as an accessible radio group (arrow keys move the choice, each option is a 44px target). */
function Scale({ q, min, max, value, onChange, lowLabel, highLabel }: { q: Question; min: number; max: number; value: number | undefined; onChange: (n: number) => void; lowLabel: string; highLabel: string }) {
  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <fieldset className="space-y-2">
      <legend className="text-base font-medium">
        {q.label}
        {q.required && <span className="text-destructive"> *</span>}
      </legend>
      <div role="radiogroup" aria-label={q.label} className={cn("grid gap-1.5", max > 5 ? "grid-cols-6 sm:grid-cols-11" : "grid-cols-5")}>
        {options.map((n) => (
          <label
            key={n}
            className={cn(
              "flex min-h-11 cursor-pointer touch-manipulation items-center justify-center rounded-md border text-sm font-medium tabular-nums transition-colors motion-reduce:transition-none",
              "focus-within:ring-2 focus-within:ring-ring",
              value === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/40 hover:bg-secondary"
            )}
          >
            <input type="radio" name={q.id} value={n} checked={value === n} onChange={() => onChange(n)} className="sr-only" />
            <span aria-hidden>{n}</span>
            <span className="sr-only">{n} out of {max}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </fieldset>
  );
}

export default function SurveyPage() {
  const { token } = useParams<{ token: string }>();
  const [survey, setSurvey] = useState<PublicSurvey | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "done">("loading");
  const [answers, setAnswers] = useState<Answers>({});
  const [publicOk, setPublicOk] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ thank_you: string; review_url: string | null } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/s/${encodeURIComponent(token)}`, { signal: ac.signal, cache: "no-store" });
        if (!res.ok) { setState("missing"); return; }
        const json = (await res.json()) as { survey: PublicSurvey };
        setSurvey(json.survey);
        setState(json.survey.already_completed ? "done" : "ready");
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") setState("missing");
      }
    })();
    return () => ac.abort();
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!survey) return;
    setError(null);
    const missing = survey.questions.find((q) => q.required && (answers[q.id] === undefined || answers[q.id] === ""));
    if (missing) { setError(`Please answer: ${missing.label}`); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/s/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers, public_ok: publicOk }) });
      const json = (await res.json().catch(() => ({}))) as { thank_you?: string; review_url?: string | null; detail?: string; error?: string };
      if (res.status === 409) { setState("done"); return; }
      if (!res.ok) throw new Error(json.detail ?? "Could not send your feedback. Please try again.");
      setResult({ thank_you: json.thank_you ?? "Thank you for your feedback!", review_url: json.review_url ?? null });
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") return <Loading label="Loading survey…" />;
  if (state === "missing" || !survey) return <Empty title="This survey is no longer available" text="The link may have expired or already been used." />;
  if (state === "done") {
    return (
      <div className="space-y-4 text-center" role="status">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">{result ? "Thank you!" : "Already received"}</h1>
        <p className="whitespace-pre-line text-sm text-muted-foreground">{result?.thank_you ?? "We already have your feedback for this. Thank you!"}</p>
        {result?.review_url && (
          <Button asChild touch>
            <a href={result.review_url} target="_blank" rel="noopener noreferrer">
              Share it publicly <ExternalLink className="ml-1 h-4 w-4" aria-hidden />
            </a>
          </Button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{survey.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your feedback helps {survey.org_name} improve. It takes about a minute.</p>
      </div>
      {survey.questions.map((q) => {
        if (q.type === "nps") return <Scale key={q.id} q={q} min={0} max={10} value={answers[q.id] as number | undefined} onChange={(n) => setAnswers((a) => ({ ...a, [q.id]: n }))} lowLabel="Not likely" highLabel="Very likely" />;
        if (q.type === "rating") return <Scale key={q.id} q={q} min={1} max={5} value={answers[q.id] as number | undefined} onChange={(n) => setAnswers((a) => ({ ...a, [q.id]: n }))} lowLabel="Poor" highLabel="Excellent" />;
        if (q.type === "choice")
          return (
            <fieldset key={q.id} className="space-y-2">
              <legend className="text-base font-medium">{q.label}{q.required && <span className="text-destructive"> *</span>}</legend>
              {(q.options ?? []).map((o) => (
                <label key={o} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm focus-within:ring-2 focus-within:ring-ring">
                  <input type="radio" name={q.id} value={o} checked={answers[q.id] === o} onChange={() => setAnswers((a) => ({ ...a, [q.id]: o }))} className="h-4 w-4 accent-primary" />
                  {o}
                </label>
              ))}
            </fieldset>
          );
        return (
          <div key={q.id} className="space-y-1.5">
            <label htmlFor={`q-${q.id}`} className="text-base font-medium">{q.label}{q.required && <span className="text-destructive"> *</span>}</label>
            <Textarea id={`q-${q.id}`} rows={4} maxLength={2000} value={(answers[q.id] as string | undefined) ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
          </div>
        );
      })}
      <Checkbox checked={publicOk} onChange={(e) => setPublicOk(e.target.checked)} label="OK to display my feedback publicly (first name and last initial only)." />
      {error && <Banner tone="error">{error}</Banner>}
      <Button type="submit" size="lg" className="w-full" disabled={submitting} aria-busy={submitting || undefined}>
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        Send feedback
      </Button>
    </form>
  );
}
