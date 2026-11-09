"use client";

import { useState } from "react";
import { Lightbulb, X, Send, ThumbsUp, Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Category = "feature" | "integration" | "improvement" | "bug";

type FeatureRequest = {
  id: string;
  domain: string;
  title: string;
  description: string;
  category: Category;
  status: string;
  upvotes: number;
  created_at: string;
};

const CATEGORY_LABELS: Record<Category, { label: string; color: string }> = {
  feature:     { label: "New Feature", color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  integration: { label: "Integration", color: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400" },
  improvement: { label: "Improvement", color: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400" },
  bug:         { label: "Bug Report", color: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400" },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open:      { label: "Open", color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  reviewing: { label: "Reviewing", color: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  planned:   { label: "Planned ✓", color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" },
  done:      { label: "Done ✅", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
};

interface FeatureRequestButtonProps {
  domain?: string;
  className?: string;
}

export function FeatureRequestButton({ domain = "general", className }: FeatureRequestButtonProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"form" | "list">("form");

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category>("feature");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // List state
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [upvoting, setUpvoting] = useState<string | null>(null);

  async function handleSubmit() {
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), category, domain }),
      });
      if (res.ok) {
        setSubmitted(true);
        setTitle(""); setDescription(""); setCategory("feature");
        setTimeout(() => setSubmitted(false), 3000);
      }
    } finally { setSubmitting(false); }
  }

  async function loadRequests() {
    setLoadingList(true);
    try {
      const res = await fetch("/api/feature-requests");
      const data = await res.json().catch(() => ({}));
      setRequests(data.requests ?? []);
    } finally { setLoadingList(false); }
  }

  function switchToList() {
    setView("list");
    loadRequests();
  }

  async function handleUpvote(id: string) {
    setUpvoting(id);
    try {
      const res = await fetch("/api/feature-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.request) {
        setRequests(r => r.map(req => req.id === id ? { ...req, upvotes: data.request.upvotes } : req));
      }
    } finally { setUpvoting(null); }
  }

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg px-4 py-2.5 text-sm font-medium hover:bg-primary/90 transition-all hover:shadow-xl hover:scale-105 active:scale-95",
          className
        )}
        title="Request a Feature"
      >
        <Lightbulb className="h-4 w-4" />
        <span className="hidden sm:block">Request Feature</span>
      </button>

      {/* Modal */}
      {open && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-border/60">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center">
                  <Lightbulb className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm">Feature Requests</h2>
                  <p className="text-xs text-muted-foreground">Help us build what you need</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex gap-1 bg-secondary rounded-lg p-1">
                  <button
                    onClick={() => setView("form")}
                    className={cn("px-2.5 py-1 rounded text-xs font-medium transition-colors", view === "form" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    Submit
                  </button>
                  <button
                    onClick={switchToList}
                    className={cn("px-2.5 py-1 rounded text-xs font-medium transition-colors", view === "list" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    View All
                  </button>
                </div>
                <button aria-label="Close" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-5 max-h-[70vh] overflow-y-auto">
              {view === "form" ? (
                submitted ? (
                  <div className="py-8 text-center space-y-2">
                    <div className="h-12 w-12 rounded-full bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center mx-auto">
                      <Send className="h-5 w-5 text-emerald-500" />
                    </div>
                    <p className="font-semibold text-sm">Request submitted!</p>
                    <p className="text-xs text-muted-foreground">Thank you for helping us improve KernelHub.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Category selector */}
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-2">Category</label>
                      <div className="grid grid-cols-2 gap-2">
                        {(Object.entries(CATEGORY_LABELS) as [Category, { label: string; color: string }][]).map(([key, cfg]) => (
                          <button
                            key={key}
                            onClick={() => setCategory(key)}
                            className={cn(
                              "rounded-lg border px-3 py-2 text-xs font-medium text-left transition-colors",
                              category === key
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border bg-background hover:border-primary/40"
                            )}
                          >
                            {cfg.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Title */}
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Feature Title *</label>
                      <input aria-label="Title"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        placeholder="e.g. Add Slack notification integration"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                        maxLength={120}
                      />
                    </div>

                    {/* Description */}
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Description *</label>
                      <textarea aria-label="Description"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        placeholder="Describe what you need and why it would be valuable..."
                        rows={4}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                        maxLength={1000}
                      />
                      <div className="text-[10px] text-muted-foreground mt-1 text-right">{description.length}/1000</div>
                    </div>

                    {/* Domain context note */}
                    {domain !== "general" && (
                      <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-xs text-muted-foreground">
                        This request will be tagged for the <strong className="text-foreground capitalize">{domain}</strong> domain.
                      </div>
                    )}

                    <button
                      onClick={handleSubmit}
                      disabled={submitting || !title.trim() || !description.trim()}
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors"
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      {submitting ? "Submitting..." : "Submit Feature Request"}
                    </button>
                  </div>
                )
              ) : (
                <div className="space-y-3">
                  {loadingList ? (
                    <div className="py-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading requests...
                    </div>
                  ) : requests.length === 0 ? (
                    <div className="py-8 text-center">
                      <Lightbulb className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No feature requests yet. Be the first!</p>
                    </div>
                  ) : (
                    requests.map(req => (
                      <div key={req.id} className="rounded-xl border border-border bg-card/50 p-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full", CATEGORY_LABELS[req.category as Category]?.color ?? "bg-secondary text-muted-foreground")}>
                                {CATEGORY_LABELS[req.category as Category]?.label ?? req.category}
                              </span>
                              <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full", STATUS_LABELS[req.status]?.color ?? "bg-secondary text-muted-foreground")}>
                                {STATUS_LABELS[req.status]?.label ?? req.status}
                              </span>
                            </div>
                            <h4 className="font-semibold text-sm">{req.title}</h4>
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{req.description}</p>
                          </div>
                          <button
                            onClick={() => handleUpvote(req.id)}
                            disabled={upvoting === req.id}
                            className="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 transition-colors shrink-0"
                          >
                            {upvoting === req.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                            ) : (
                              <ThumbsUp className="h-3.5 w-3.5 text-muted-foreground hover:text-primary transition-colors" />
                            )}
                            <span className="text-[10px] font-semibold">{req.upvotes}</span>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Footer tip */}
            {view === "form" && !submitted && (
              <div className="px-5 pb-4 pt-0">
                <button
                  onClick={switchToList}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                >
                  <ChevronDown className="h-3 w-3" /> View existing requests and upvote
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
