"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Plus,
  Download,
  AlertTriangle,
  ArrowLeft,
  Pencil,
  Check,
  ChevronDown,
  Undo2,
  Redo2,
  Code2,
  Github,
  X,
  ExternalLink,
  Copy,
  Image as ImageIcon,
  Inbox,
  LayoutTemplate,
  BarChart,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JarvisMascot } from "@/components/jarvis-mascot";
import { cn } from "@/lib/utils";
import { injectEditScript } from "@/lib/inline-edit";
import { BUILDER_ENGINE_SCRIPT } from "@/lib/builder-engine";

type Site = {
  id: string;
  title: string;
  persona: string | null;
  plan: Record<string, unknown> | null;
  html: string;
  updated_at: string;
};

type Feature = { title: string; why: string };
type Issue = { severity: "low" | "medium" | "high"; title: string; explain: string; fix: string };
type Revision = { id: string; source: string; prompt: string | null; created_at: string };

const QUICK_REFINES = [
  "Make it darker",
  "Make it brighter",
  "Bigger headings",
  "More whitespace",
  "Add a testimonials section",
  "Different font",
  "Shorter copy",
  "Add an FAQ section",
];

export default function LiveStudio({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = use(params);
  const [site, setSite] = useState<Site | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"refine" | "features" | "security" | "images" | "leads" | "components" | "analytics">("refine");
  const [features, setFeatures] = useState<Feature[]>([]);
  const [featuresHeadline, setFeaturesHeadline] = useState<string>("");
  const [addedFeatures, setAddedFeatures] = useState<Set<string>>(new Set());
  const [showAdded, setShowAdded] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [customRefine, setCustomRefine] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [viewSource, setViewSource] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevisionId, setCurrentRevisionId] = useState<string>("");
  const [publishOpen, setPublishOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/build/sites/${siteId}`);
    const data = await r.json();
    if (r.ok) setSite(data.site);
  }, [siteId]);

  const loadHistory = useCallback(async (selectLatest = true) => {
    const r = await fetch(`/api/build/sites/${siteId}/history`);
    const data = await r.json();
    if (r.ok) {
      const revs: Revision[] = data.revisions ?? [];
      setRevisions(revs);
      if (selectLatest && revs.length > 0) {
        setCurrentRevisionId(revs[revs.length - 1].id);
      }
    }
  }, [siteId]);

  useEffect(() => {
    load();
    loadHistory(true);
  }, [load, loadHistory]);

  useEffect(() => {
    if (site && features.length === 0) {
      fetch("/api/build/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      })
        .then((r) => r.json())
        .then((d) => {
          setFeatures(d.features ?? []);
          setFeaturesHeadline(d.headline ?? "");
        })
        .catch(() => {});
    }
  }, [site, siteId, features.length]);

  useEffect(() => {
    if (site && issues === null && !busy) {
      runSecurity();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "jarvis:save" && typeof data.html === "string") {
        fetch("/api/build/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, html: data.html }),
        })
          .then((r) => r.json())
          .then(() => {
            setSite((s) => (s ? { ...s, html: data.html } : s));
            setSavedFlash(true);
            loadHistory(true);
            setTimeout(() => setSavedFlash(false), 1200);
          })
          .catch(() => {});
      } else if (data.type === "jarvis:generate-component" && data.componentType && data.placeholderId) {
        setBusy(`Generating ${data.componentType}...`);
        const instruction = `Replace the <section id='${data.placeholderId}'> element with a beautifully designed [${data.componentType}] component section matching the existing design system. Return the full HTML.`;
        fetch("/api/build/refine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, instruction, source: "feature" }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.error) throw new Error(d.error);
            load();
            loadHistory(true);
          })
          .catch((err) => {
            setError(err.message);
          })
          .finally(() => {
            setBusy(null);
          });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [siteId, loadHistory, load]);

  async function refine(instruction: string, source: "refine" | "feature" = "refine", featureKey?: string) {
    setBusy(instruction);
    setError("");
    try {
      const r = await fetch("/api/build/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, instruction, source }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Refine failed");
      await load();
      await loadHistory(true);
      setCustomRefine("");
      if (featureKey) {
        setAddedFeatures((prev) => {
          const next = new Set(prev);
          next.add(featureKey);
          return next;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runSecurity() {
    setBusy("security");
    try {
      const r = await fetch("/api/build/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      });
      const d = await r.json();
      setIssues(d.issues ?? []);
    } finally {
      setBusy(null);
    }
  }

  async function revertTo(revisionId: string) {
    setBusy("history");
    setError("");
    try {
      const r = await fetch(`/api/build/sites/${siteId}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revisionId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Revert failed");
      setSite((s) => (s ? { ...s, html: data.html } : s));
      setCurrentRevisionId(revisionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const currentIdx = revisions.findIndex((r) => r.id === currentRevisionId);
  const canUndo = currentIdx > 0;
  const canRedo = currentIdx >= 0 && currentIdx < revisions.length - 1;

  function undo() {
    if (canUndo) revertTo(revisions[currentIdx - 1].id);
  }
  function redo() {
    if (canRedo) revertTo(revisions[currentIdx + 1].id);
  }

  function downloadHtml() {
    if (!site) return;
    const blob = new Blob([site.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${site.title.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "site"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const iframeSrc = useMemo(() => {
    if (!site) return "";
    let finalHtml = site.html;
    if (editMode) {
      finalHtml = injectEditScript(finalHtml);
    }
    if (tab === "components") {
      if (/<\/body>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/<\/body>/i, `${BUILDER_ENGINE_SCRIPT}</body>`);
      } else {
        finalHtml += BUILDER_ENGINE_SCRIPT;
      }
    }
    return finalHtml;
  }, [site, editMode, tab]);

  const pendingFeatures = features.filter((f) => !addedFeatures.has(f.title));
  const addedList = features.filter((f) => addedFeatures.has(f.title));

  if (!site) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/build" className="rounded-md p-1 hover:bg-secondary/60">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="truncate text-sm font-semibold">{site.title}</h1>
          {savedFlash && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <IconButton title="Undo" onClick={undo} disabled={!canUndo || !!busy}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Redo" onClick={redo} disabled={!canRedo || !!busy}>
            <Redo2 className="h-3.5 w-3.5" />
          </IconButton>
          <span className="mx-1 text-xs text-muted-foreground">
            {revisions.length > 0 && currentIdx >= 0
              ? `${currentIdx + 1} / ${revisions.length}`
              : ""}
          </span>
          <Button
            size="sm"
            variant={viewSource ? "default" : "outline"}
            onClick={() => setViewSource((v) => !v)}
          >
            <Code2 className="h-3.5 w-3.5" />
            {viewSource ? "Hide code" : "View code"}
          </Button>
          <Button
            size="sm"
            variant={editMode ? "default" : "outline"}
            onClick={() => setEditMode((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {editMode ? "Done editing" : "Edit text"}
          </Button>
          <Button size="sm" variant="outline" onClick={downloadHtml}>
            <Download className="h-3.5 w-3.5" /> Download code
          </Button>
          <Button size="sm" onClick={() => setPublishOpen(true)}>
            <Github className="h-3.5 w-3.5" /> Publish
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="relative flex flex-1 flex-col bg-secondary/30 p-4">
          <div className={cn("h-full overflow-hidden rounded-lg border border-border bg-white shadow-sm", viewSource && "hidden")}>
            <iframe
              key={editMode ? "edit" : "view"}
              ref={iframeRef}
              srcDoc={iframeSrc}
              sandbox={editMode ? "allow-same-origin allow-scripts" : "allow-same-origin"}
              className="h-full w-full"
              title={site.title}
            />
          </div>
          {viewSource && (
            <CodeView html={site.html} />
          )}
          {editMode && !viewSource && (
            <div className="pointer-events-none absolute left-6 top-6 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow">
              Click any text on the page to edit it
            </div>
          )}
          {busy && (
            <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
              <div className="flex items-center gap-3 rounded-full bg-card px-4 py-2 shadow">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm">
                  {busy === "security"
                    ? "Reviewing for issues…"
                    : busy === "history"
                      ? "Switching version…"
                      : `Applying: ${busy}`}
                </span>
              </div>
            </div>
          )}
        </main>

        <aside className="flex w-96 flex-col border-l border-border bg-card">
          <div className="flex border-b border-border flex-wrap">
            <TabButton active={tab === "refine"} onClick={() => setTab("refine")}>
              <RefreshCw className="h-3.5 w-3.5" /> Refine
            </TabButton>
            <TabButton active={tab === "features"} onClick={() => setTab("features")}>
              <Plus className="h-3.5 w-3.5" /> Features
            </TabButton>
            <TabButton active={tab === "components"} onClick={() => setTab("components")}>
              <LayoutTemplate className="h-3.5 w-3.5" /> Components
            </TabButton>
            <TabButton active={tab === "security"} onClick={() => setTab("security")}>
              <ShieldCheck className="h-3.5 w-3.5" /> Review
            </TabButton>
            <TabButton active={tab === "images"} onClick={() => setTab("images")}>
              <ImageIcon className="h-3.5 w-3.5" /> Images
            </TabButton>
            <TabButton active={tab === "leads"} onClick={() => setTab("leads")}>
              <Inbox className="h-3.5 w-3.5" /> Leads
            </TabButton>
            <TabButton active={tab === "analytics"} onClick={() => setTab("analytics")}>
              <BarChart className="h-3.5 w-3.5" /> Analytics
            </TabButton>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {error && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            {tab === "refine" && (
              <div className="space-y-4">
                <JarvisMascot
                  size="sm"
                  message="Tap any chip to apply that change. Or write your own."
                />
                <div className="flex flex-wrap gap-2">
                  {QUICK_REFINES.map((r) => (
                    <button
                      key={r}
                      onClick={() => refine(r)}
                      disabled={!!busy}
                      className="rounded-full border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-secondary/60 disabled:opacity-50"
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="space-y-2 border-t border-border pt-4">
                  <p className="text-xs text-muted-foreground">Or describe your own change:</p>
                  <Input
                    value={customRefine}
                    onChange={(e) => setCustomRefine(e.target.value)}
                    placeholder="e.g. swap the hero headline to..."
                    disabled={!!busy}
                  />
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={!customRefine.trim() || !!busy}
                    onClick={() => refine(customRefine)}
                  >
                    Apply change
                  </Button>
                </div>

                {revisions.length > 1 && (
                  <HistoryPanel
                    revisions={revisions}
                    currentId={currentRevisionId}
                    busy={!!busy}
                    onPick={revertTo}
                  />
                )}
              </div>
            )}

            {tab === "features" && (
              <div className="space-y-3">
                <JarvisMascot
                  size="sm"
                  message="Features picked for your specific site. One click adds it."
                />
                {featuresHeadline && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground">
                    <Sparkles className="mr-1 inline h-3 w-3 text-primary" />
                    {featuresHeadline}
                  </div>
                )}
                {features.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Picking features for your site…
                  </div>
                ) : (
                  <>
                    {pendingFeatures.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        All suggested features added. Try the Refine tab for more changes.
                      </p>
                    ) : (
                      pendingFeatures.map((f) => (
                        <div
                          key={f.title}
                          className="rounded-lg border border-border bg-background p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-sm font-medium">{f.title}</div>
                            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {f.why}
                          </p>
                          <Button
                            size="sm"
                            className="mt-3 w-full"
                            disabled={!!busy}
                            onClick={() =>
                              refine(
                                `Add a "${f.title}" section to this page. ${f.why}`,
                                "feature",
                                f.title
                              )
                            }
                          >
                            <Plus className="h-3.5 w-3.5" /> Add to site
                          </Button>
                        </div>
                      ))
                    )}

                    {addedList.length > 0 && (
                      <div className="rounded-lg border border-border bg-secondary/30">
                        <button
                          type="button"
                          onClick={() => setShowAdded((v) => !v)}
                          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
                        >
                          <span className="flex items-center gap-1.5">
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                            Added ({addedList.length})
                          </span>
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 transition-transform",
                              showAdded && "rotate-180"
                            )}
                          />
                        </button>
                        {showAdded && (
                          <div className="space-y-2 border-t border-border p-2">
                            {addedList.map((f) => (
                              <div
                                key={f.title}
                                className="flex items-center justify-between gap-2 rounded-md bg-background/60 px-2 py-1.5 text-xs opacity-70"
                              >
                                <span className="truncate">{f.title}</span>
                                <Check className="h-3 w-3 shrink-0 text-emerald-600" />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === "security" && (
              <div className="space-y-3">
                <JarvisMascot
                  size="sm"
                  message="Plain-English review of issues a real user might run into. Re-runs after each change."
                />
                {issues === null ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reviewing your site…
                  </div>
                ) : issues.length === 0 ? (
                  <div className="rounded-md border border-border bg-background p-4 text-center text-sm">
                    <ShieldCheck className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
                    No obvious issues found.
                    <div className="mt-3">
                      <Button size="sm" variant="outline" onClick={runSecurity}>
                        Re-run
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {issues.map((iss, i) => (
                      <div
                        key={i}
                        className={cn(
                          "rounded-lg border p-3",
                          iss.severity === "high"
                            ? "border-destructive/40 bg-destructive/5"
                            : iss.severity === "medium"
                              ? "border-amber-500/40 bg-amber-500/5"
                              : "border-border bg-background"
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle
                            className={cn(
                              "mt-0.5 h-4 w-4 shrink-0",
                              iss.severity === "high"
                                ? "text-destructive"
                                : iss.severity === "medium"
                                  ? "text-amber-500"
                                  : "text-muted-foreground"
                            )}
                          />
                          <div className="space-y-1">
                            <div className="text-sm font-medium">{iss.title}</div>
                            <p className="text-xs text-muted-foreground">{iss.explain}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-1"
                              disabled={!!busy}
                              onClick={() => refine(`Fix this issue: ${iss.title}. ${iss.fix}`)}
                            >
                              {iss.fix.length > 32 ? "Apply fix" : iss.fix}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Button size="sm" variant="outline" className="w-full" onClick={runSecurity}>
                      Re-run review
                    </Button>
                  </>
                )}
              </div>
            )}

            {tab === "images" && (
              <div className="space-y-4 text-center mt-12">
                <ImageIcon className="mx-auto h-8 w-8 text-muted-foreground opacity-50" />
                <div className="space-y-1">
                  <h3 className="font-medium text-sm">Coming Soon</h3>
                  <p className="text-xs text-muted-foreground">Add pictures or create pictures using AI.</p>
                </div>
              </div>
            )}

            {tab === "leads" && <LeadsPanel siteId={siteId} />}
            {tab === "components" && <ComponentsPanel />}
            {tab === "analytics" && <AnalyticsPanel siteId={siteId} />}
          </div>
        </aside>
      </div>

      {publishOpen && (
        <PublishModal
          siteId={siteId}
          defaultName={slugify(site.title)}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-background p-1.5 transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HistoryPanel({
  revisions,
  currentId,
  busy,
  onPick,
}: {
  revisions: Revision[];
  currentId: string;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
      >
        <span>History ({revisions.length})</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="max-h-60 space-y-0.5 overflow-y-auto border-t border-border p-2">
          {[...revisions].reverse().map((r) => {
            const active = r.id === currentId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  disabled={busy || active}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-primary/15 text-foreground"
                      : "hover:bg-secondary/60 disabled:opacity-50"
                  )}
                >
                  <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {r.source === "initial"
                        ? "Initial generation"
                        : r.prompt
                          ? r.prompt
                          : r.source}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </span>
                  </span>
                  {active && <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CodeView({ html }: { html: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(html).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }
  return (
    <div className="relative h-full overflow-hidden rounded-lg border border-border bg-zinc-950 text-zinc-100 shadow-sm">
      <div className="absolute right-3 top-3 z-10">
        <Button size="sm" variant="outline" className="border-zinc-600 text-zinc-100 hover:bg-zinc-800" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="h-full overflow-auto p-4 text-xs leading-relaxed">
        <code>{html}</code>
      </pre>
    </div>
  );
}

function PublishModal({
  siteId,
  defaultName,
  onClose,
}: {
  siteId: string;
  defaultName: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [enablePages, setEnablePages] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ repoUrl: string; pagesUrl?: string } | null>(null);

  async function publish() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/build/sites/${siteId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoName: name, enablePages }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Publish failed");
      setResult({ repoUrl: data.repoUrl, pagesUrl: data.pagesUrl });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Github className="h-4 w-4" /> Publish to GitHub
          </h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-secondary/60">
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
              <Check className="mr-1 inline h-3.5 w-3.5" /> Published successfully.
            </div>
            <div className="space-y-2 text-sm">
              <a
                href={result.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-secondary/60"
              >
                <span className="truncate">Repository</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
              {result.pagesUrl && (
                <a
                  href={result.pagesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-secondary/60"
                >
                  <span className="truncate">Live site (Pages — may take ~1 min)</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
              )}
              <a
                href={`https://vercel.com/new/clone?repository-url=${encodeURIComponent(result.repoUrl)}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 flex items-center justify-center gap-2 rounded-md bg-black px-3 py-2 text-white hover:bg-black/90 transition-colors"
              >
                <span className="truncate font-medium">Deploy to Vercel</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            </div>
            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium">Repository name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-awesome-site"
                disabled={busy}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Letters, numbers, dot, dash, underscore. A new public repo will be created on the GitHub account tied to your GITHUB_TOKEN.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={enablePages}
                onChange={(e) => setEnablePages(e.target.checked)}
                disabled={busy}
              />
              Enable GitHub Pages (live URL)
            </label>
            {err && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {err}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={publish} disabled={busy || !name.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />}
                {busy ? "Publishing…" : "Publish"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "my-site"
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

type Lead = {
  id: string;
  created_at: string;
  data: Record<string, unknown>;
};

function LeadsPanel({ siteId }: { siteId: string }) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState("");

  const loadLeads = useCallback(async () => {
    try {
      const r = await fetch(`/api/build/sites/${siteId}/leads`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to load leads");
      setLeads(data.leads ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [siteId]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <JarvisMascot size="sm" message="Form submissions from your generated site will appear here." />
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={loadLeads}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {leads === null ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-background py-12 text-center">
          <Inbox className="mb-2 h-8 w-8 text-muted-foreground/50" />
          <h3 className="text-sm font-medium">No leads yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">When visitors submit the contact form, their data will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {leads.map((lead) => (
            <div key={lead.id} className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
              <div className="border-b border-border bg-secondary/30 px-3 py-2 text-[10px] font-medium text-muted-foreground">
                {new Date(lead.created_at).toLocaleString()}
              </div>
              <div className="p-3 text-xs">
                {Object.entries(lead.data).map(([k, v]) => (
                  <div key={k} className="mb-1.5 last:mb-0">
                    <span className="font-semibold capitalize text-foreground/80">{k}: </span>
                    <span className="text-foreground break-words">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentsPanel() {
  const components = ["Hero", "Features", "Pricing", "Testimonials", "FAQ", "Gallery", "Team", "Stats", "Contact", "Footer"];
  
  return (
    <div className="space-y-4">
      <JarvisMascot size="sm" message="Drag these components into the live preview to insert them! You can also drag existing sections inside the preview to reorder them." />
      <div className="grid grid-cols-2 gap-2">
        {components.map(c => (
          <div
            key={c}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('javis-component', c);
            }}
            className="cursor-grab rounded border border-border bg-background p-3 text-center text-sm font-medium shadow-sm hover:bg-secondary/60 active:cursor-grabbing"
          >
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsPanel({ siteId }: { siteId: string }) {
  const [data, setData] = useState<Array<{ id: string; path: string; user_agent: string; created_at: string }> | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/build/sites/${siteId}/analytics`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load");
      setData(d.analytics ?? []);
    } catch(e) {
      setError((e as Error).message);
    }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="text-destructive text-xs">{error}</div>;
  if (!data) return <div className="flex justify-center py-8"><Loader2 className="animate-spin h-5 w-5 text-muted-foreground" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <JarvisMascot size="sm" message="Here are your real-time page views." />
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      
      <div className="rounded-lg border border-border bg-background p-4 text-center shadow-sm">
        <div className="text-3xl font-bold">{data.length}</div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider">Total Views</div>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground pt-2">Recent Visitors</h4>
        {data.slice(0, 20).map(v => (
          <div key={v.id} className="text-xs border border-border bg-background rounded p-2 shadow-sm">
            <div className="font-medium">{v.path}</div>
            <div className="text-[10px] text-muted-foreground truncate my-0.5" title={v.user_agent}>{v.user_agent}</div>
            <div className="text-[10px] text-muted-foreground/70">{new Date(v.created_at).toLocaleString()}</div>
          </div>
        ))}
        {data.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No page views yet.</p>}
      </div>
    </div>
  );
}
