"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Download, FileText, Loader2, X, Pencil,
  RefreshCw, CheckCircle2, Send, History, AlertCircle,
  ChevronRight, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { STRATEGY_TYPES, type StrategyType } from "@/lib/strategy";

type Proposal = {
  id: string;
  title: string;
  type: string;
  status: "draft" | "published" | "archived";
  content?: string;
  created_at: string;
};

type Profile = {
  company_name: string;
  industry: string;
  product_desc?: string;
};

type Version = { id: string; created_at: string };

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  published: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  archived: "bg-secondary text-muted-foreground",
};

export default function StrategyPage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<"all" | "drafts" | "published" | "archived">("all");
  const [generating, setGenerating] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [detail, setDetail] = useState<Proposal | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [suggestedTasks, setSuggestedTasks] = useState<string[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/strategy").then(r => r.json()).catch(() => null);
    if (!res || res.error) {
      setError("Could not load strategies. Check you're signed in and DSQL is connected.");
      setLoading(false);
      return;
    }
    setProposals(res.proposals ?? []);
    setProfile(res.profile ?? null);
    setLoading(false);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  async function generate(type: StrategyType, label: string) {
    setGenerating(type);
    const title = profile?.company_name
      ? `${profile.company_name} — ${label}`
      : label;
    const res = await fetch("/api/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, title }),
    }).then(r => r.json()).catch(() => null);

    if (res?.proposal) {
      setProposals(p => [res.proposal, ...p]);
      showToast("Strategy generated!");
      openDetail(res.proposal.id);
    } else {
      showToast(res?.error ?? "Generation failed");
    }
    setGenerating(null);
  }

  async function openDetail(id: string) {
    setDetailLoading(true);
    setEditing(false);
    setShowVersions(false);
    const res = await fetch(`/api/strategy/${id}`).then(r => r.json()).catch(() => null);
    if (res?.proposal) {
      setDetail(res.proposal);
      setEditContent(res.proposal.content ?? "");
      setEditTitle(res.proposal.title);
      setSuggestedTasks(res.suggested_tasks ?? []);
    }
    setDetailLoading(false);
  }

  async function updateStatus(id: string, status: Proposal["status"]) {
    await fetch(`/api/strategy/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setProposals(p => p.map(x => x.id === id ? { ...x, status } : x));
    if (detail?.id === id) setDetail(d => d ? { ...d, status } : d);
    showToast(`Marked as ${status}`);
    setMenuOpen(null);
  }

  async function saveEdit() {
    if (!detail) return;
    setSaving(true);
    const res = await fetch(`/api/strategy/${detail.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editContent, title: editTitle }),
    }).then(r => r.json()).catch(() => null);
    if (res?.proposal) {
      setDetail(res.proposal);
      setProposals(p => p.map(x => x.id === detail.id ? { ...x, title: editTitle } : x));
      setEditing(false);
      showToast("Saved");
    }
    setSaving(false);
  }

  async function regenerate() {
    if (!detail) return;
    setRegenerating(true);
    const res = await fetch(`/api/strategy/${detail.id}/regenerate`, { method: "POST" })
      .then(r => r.json()).catch(() => null);
    if (res?.proposal) {
      setDetail(res.proposal);
      setEditContent(res.proposal.content ?? "");
      setProposals(p => p.map(x => x.id === detail.id ? { ...x, status: "draft" } : x));
      showToast("Regenerated with latest Business DNA");
    } else {
      showToast("Regeneration failed");
    }
    setRegenerating(false);
  }

  async function remove(id: string) {
    if (!confirm("Delete this strategy permanently?")) return;
    await fetch(`/api/strategy/${id}`, { method: "DELETE" });
    setProposals(p => p.filter(x => x.id !== id));
    if (detail?.id === id) setDetail(null);
    setMenuOpen(null);
    showToast("Deleted");
  }

  async function exportPptx(p: Proposal) {
    const res = await fetch("/api/strategy/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${p.title}.pptx`;
      a.click();
    } else {
      showToast("Export failed");
    }
  }

  async function exportAll() {
    const res = await fetch("/api/strategy/export-all");
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "kernelhub-strategies-export.json";
      a.click();
    }
  }

  async function pushToProduction() {
    if (!detail) return;
    setPushing(true);
    const res = await fetch(`/api/strategy/${detail.id}/production`, { method: "POST" })
      .then(r => r.json()).catch(() => null);
    if (res?.ok) {
      showToast(`Added ${res.created} task(s) to Production — view on Production board`);
    } else {
      showToast(res?.error ?? "Could not create production tasks");
    }
    setPushing(false);
  }

  async function loadVersions() {
    if (!detail) return;
    const res = await fetch(`/api/strategy/${detail.id}/versions`).then(r => r.json()).catch(() => null);
    setVersions(res?.versions ?? []);
    setShowVersions(true);
  }

  async function restoreVersion(versionId: string) {
    if (!detail) return;
    const res = await fetch(`/api/strategy/${detail.id}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId }),
    }).then(r => r.json()).catch(() => null);
    if (res?.proposal) {
      setDetail(res.proposal);
      setEditContent(res.proposal.content ?? "");
      showToast("Version restored");
      setShowVersions(false);
    }
  }

  const tabCount = (t: typeof tab) => {
    if (t === "all") return proposals.length;
    if (t === "drafts") return proposals.filter(p => p.status === "draft").length;
    if (t === "published") return proposals.filter(p => p.status === "published").length;
    return proposals.filter(p => p.status === "archived").length;
  };

  const filtered = proposals.filter(p => {
    if (tab === "drafts") return p.status === "draft";
    if (tab === "published") return p.status === "published";
    if (tab === "archived") return p.status === "archived";
    return true;
  });

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-[60] rounded-lg bg-foreground text-background px-4 py-2 text-sm shadow-lg">
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Strategy Hub</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              AI strategy documents tailored to your Business DNA — read, edit, publish, and push tasks to Production.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={exportAll} disabled={proposals.length === 0}>
              <Download className="h-3.5 w-3.5" /> Export All
            </Button>
          </div>
        </div>

        {/* Profile banner */}
        {!loading && !profile?.company_name && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Complete your Business DNA for better strategies</p>
              <p className="text-xs text-muted-foreground mt-1">
                Strategies use your company profile for personalized output.
              </p>
              <Link href="/onboarding" className="text-xs text-primary underline mt-2 inline-block">
                Set up Business DNA →
              </Link>
            </div>
          </div>
        )}

        {profile?.company_name && (
          <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            <span>
              Generating for <strong>{profile.company_name}</strong>
              {profile.industry ? ` · ${profile.industry}` : ""}
            </span>
          </div>
        )}

        {/* Strategy type cards — all 6 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {STRATEGY_TYPES.map(({ type, label, desc, emoji }) => (
            <button
              key={type}
              type="button"
              disabled={!!generating}
              onClick={() => generate(type, label)}
              className="rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 hover:shadow-sm transition-all group disabled:opacity-60"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{emoji}</span>
                <span className="font-medium text-sm">{label}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
              {generating === type && (
                <div className="mt-2 flex items-center gap-1 text-xs text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" /> Generating…
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border">
          {(["all", "drafts", "published", "archived"] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? "border-primary text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "all" ? "All" : t}
              <span className="ml-1 text-[10px] text-muted-foreground">({tabCount(t)})</span>
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading strategies…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={loadList}>Retry</Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium mb-1">No strategies yet</p>
            <p className="text-xs text-muted-foreground">Pick a template above to generate your first document.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(p => {
              const meta = STRATEGY_TYPES.find(t => t.type === p.type);
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-4 hover:border-primary/30 transition-colors"
                >
                  <button
                    type="button"
                    className="flex items-center gap-3 text-left flex-1 min-w-0"
                    onClick={() => openDetail(p.id)}
                  >
                    <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-base">
                      {meta?.emoji ?? "📄"}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{p.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {meta?.label ?? p.type} · {new Date(p.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 ml-auto" />
                  </button>
                  <div className="flex items-center gap-1 shrink-0 relative">
                    <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 capitalize ${STATUS_COLORS[p.status]}`}>
                      {p.status}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => exportPptx(p)} title="Export PPTX">
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setMenuOpen(menuOpen === p.id ? null : p.id)}>
                      ···
                    </Button>
                    {menuOpen === p.id && (
                      <div className="absolute right-0 top-full mt-1 z-10 rounded-lg border border-border bg-card shadow-lg py-1 min-w-[140px]">
                        {p.status !== "published" && (
                          <button type="button" className="w-full px-3 py-1.5 text-xs text-left hover:bg-secondary" onClick={() => updateStatus(p.id, "published")}>
                            Publish
                          </button>
                        )}
                        {p.status !== "archived" && (
                          <button type="button" className="w-full px-3 py-1.5 text-xs text-left hover:bg-secondary" onClick={() => updateStatus(p.id, "archived")}>
                            Archive
                          </button>
                        )}
                        {p.status !== "draft" && (
                          <button type="button" className="w-full px-3 py-1.5 text-xs text-left hover:bg-secondary" onClick={() => updateStatus(p.id, "draft")}>
                            Mark draft
                          </button>
                        )}
                        <button type="button" className="w-full px-3 py-1.5 text-xs text-left text-destructive hover:bg-destructive/10" onClick={() => remove(p.id)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {detail && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={() => setDetail(null)} />
          <div className="w-full max-w-2xl bg-card border-l border-border flex flex-col shadow-2xl">
            {/* Panel header */}
            <div className="px-5 py-4 border-b border-border shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full font-semibold text-sm bg-transparent border-b border-border pb-1 outline-none"
                    />
                  ) : (
                    <h2 className="font-semibold text-sm truncate">{detail.title}</h2>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 capitalize ${STATUS_COLORS[detail.status]}`}>
                      {detail.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {STRATEGY_TYPES.find(t => t.type === detail.type)?.label ?? detail.type}
                    </span>
                  </div>
                </div>
                <button type="button" onClick={() => setDetail(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {!editing ? (
                  <>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)}>
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={regenerating} onClick={regenerate}>
                      {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Regenerate
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => exportPptx(detail)}>
                      <Download className="h-3 w-3" /> PPTX
                    </Button>
                    {detail.status !== "published" && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => updateStatus(detail.id, "published")}>
                        <CheckCircle2 className="h-3 w-3" /> Publish
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={loadVersions}>
                      <History className="h-3 w-3" /> History
                    </Button>
                    {suggestedTasks.length > 0 && (
                      <Button size="sm" className="h-7 text-xs" disabled={pushing} onClick={pushToProduction}>
                        {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        Push {suggestedTasks.length} to Production
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={saveEdit}>
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setEditing(false); setEditContent(detail.content ?? ""); setEditTitle(detail.title); }}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailLoading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : showVersions ? (
                <div className="space-y-2">
                  <button type="button" className="text-xs text-primary mb-2" onClick={() => setShowVersions(false)}>
                    ← Back to document
                  </button>
                  <p className="text-xs text-muted-foreground mb-3">Click a version to restore it.</p>
                  {versions.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => restoreVersion(v.id)}
                      className="w-full text-left rounded-lg border border-border p-3 text-xs hover:border-primary/40 hover:bg-primary/5"
                    >
                      {new Date(v.created_at).toLocaleString()}
                    </button>
                  ))}
                  {versions.length === 0 && (
                    <p className="text-xs text-muted-foreground">No version history yet.</p>
                  )}
                </div>
              ) : editing ? (
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  className="w-full h-full min-h-[400px] rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono leading-relaxed outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              ) : (
                <div className="space-y-4">
                  <Markdown>{detail.content ?? ""}</Markdown>
                  {suggestedTasks.length > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 mt-6">
                      <p className="text-xs font-medium mb-2">Suggested Production Tasks</p>
                      <ul className="space-y-1">
                        {suggestedTasks.map((t, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                            <span className="text-primary">☐</span> {t}
                          </li>
                        ))}
                      </ul>
                      <Button size="sm" className="mt-3 h-7 text-xs" disabled={pushing} onClick={pushToProduction}>
                        {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                        Add to Production board
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
