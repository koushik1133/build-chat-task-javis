"use client";

import { useState, useEffect, useCallback } from "react";
import { Lightbulb, ThumbsUp, Loader2, Send, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";

type Category = "feature" | "integration" | "improvement" | "bug";

interface FeatureRequest {
  id: string;
  domain: string;
  title: string;
  description: string;
  category: Category;
  status: string;
  upvotes: number;
  created_at: string;
  is_mine?: boolean;
  has_voted?: boolean;
}

const CATEGORY_LABELS: Record<Category, { label: string; color: string }> = {
  feature: { label: "New Feature", color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  integration: { label: "Integration", color: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400" },
  improvement: { label: "Improvement", color: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400" },
  bug: { label: "Bug Report", color: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400" },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: "Open", color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  reviewing: { label: "Reviewing", color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  planned: { label: "Planned", color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" },
  done: { label: "Done", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
};

const CATEGORIES: Category[] = ["feature", "integration", "improvement", "bug"];

export default function RequestDomainPage() {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category>("feature");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [votingId, setVotingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/feature-requests");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not load requests.");
      setRequests(data.requests ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, category, domain: "general" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not submit that request.");
      setTitle("");
      setDescription("");
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 4000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit that request.");
    } finally {
      setSubmitting(false);
    }
  }

  async function upvote(id: string) {
    setVotingId(id);
    try {
      const res = await fetch("/api/feature-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record that vote.");
      setRequests((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, upvotes: data.request?.upvotes ?? r.upvotes, has_voted: true } : r
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that vote.");
    } finally {
      setVotingId(null);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <PageContainer
      wide
      title="Request a domain or feature"
      description="Tell us what to build next. The most-upvoted requests get prioritised."
    >
      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <form onSubmit={submit} className="h-fit space-y-4 rounded-xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden /> Submit a request
          </h2>

          {submitted && (
            <p role="status" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Check className="h-4 w-4" aria-hidden /> Thanks — your request was submitted.
            </p>
          )}

          <div>
            <label htmlFor="fr-title" className="mb-1 block text-sm font-medium">Title</label>
            <input id="fr-title" required maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Hospitality domain hub" className={inputClass} />
          </div>

          <div>
            <label htmlFor="fr-category" className="mb-1 block text-sm font-medium">Category</label>
            <select id="fr-category" value={category} onChange={(e) => setCategory(e.target.value as Category)} className={inputClass}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c].label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="fr-description" className="mb-1 block text-sm font-medium">What should it do?</label>
            <textarea id="fr-description" required rows={5} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the workflow you'd like automated." className={cn(inputClass, "resize-y")} />
          </div>

          <Button type="submit" disabled={submitting || !title.trim() || !description.trim()} className="w-full">
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Send className="mr-2 h-4 w-4" aria-hidden />}
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </form>

        <section className="rounded-xl border border-border bg-card">
          <h2 className="border-b border-border px-5 py-4 font-semibold">Community roadmap</h2>

          {loading ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading requests…</p>
          ) : requests.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No requests yet — be the first.</p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => {
                const cat = CATEGORY_LABELS[r.category] ?? CATEGORY_LABELS.feature;
                const status = STATUS_LABELS[r.status] ?? STATUS_LABELS.open;
                return (
                  <li key={r.id} className="flex items-start gap-4 px-5 py-4">
                    <button type="button"
                      onClick={() => upvote(r.id)}
                      disabled={votingId === r.id || r.has_voted}
                      aria-label={r.has_voted ? `Already upvoted ${r.title}` : `Upvote ${r.title}`}
                      className={cn(
                        "flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-xs transition-colors",
                        r.has_voted
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400"
                          : "border-border hover:bg-muted"
                      )}
                    >
                      {votingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ThumbsUp className="h-3.5 w-3.5" aria-hidden />}
                      <span className="font-semibold tabular-nums">{r.upvotes}</span>
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{r.title}</p>
                      <p className="mt-0.5 line-clamp-3 text-sm text-muted-foreground">{r.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", cat.color)}>{cat.label}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", status.color)}>{status.label}</span>
                        {r.is_mine && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Yours</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
