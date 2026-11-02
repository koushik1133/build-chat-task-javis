"use client";

import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BookOpen, ExternalLink, Eye, Globe, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { Markdown } from "@/components/markdown";
import { cn, timeAgo } from "@/lib/utils";
import type { KbArticleRow, KbCategoryRow } from "@/lib/kb/articles";

type StatusFilter = "all" | "draft" | "published";
type EditorTab = "write" | "preview";

const STATUS_TABS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "published", label: "Published" },
  { id: "draft", label: "Drafts" },
];
const EDITOR_TABS: ReadonlyArray<{ id: EditorTab; label: string }> = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
];
const ARTICLE_TONE: Record<string, Tone> = { published: "success", draft: "neutral" };

type Draft = {
  title: string;
  slug: string;
  body_md: string;
  excerpt: string;
  category: string;
  tags: string;
  status: "draft" | "published";
  is_public: boolean;
};

type Notice = { tone: "success" | "error"; text: string };

function parseArr(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function toDraft(a: KbArticleRow | null): Draft {
  return {
    title: a?.title ?? "",
    slug: a?.slug ?? "",
    body_md: a?.body_md ?? "",
    excerpt: a?.excerpt ?? "",
    category: a?.category ?? "",
    tags: a ? parseArr(a.tags).join(", ") : "",
    status: a?.status ?? "draft",
    is_public: a?.is_public ?? false,
  };
}

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return d?.error ? `${fallback}: ${String(d.error).replace(/_/g, " ")}` : `${fallback} (${res.status})`;
}

export default function KnowledgePage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Knowledge base">
          <Loading label="Loading articles…" />
        </PageContainer>
      }
    >
      <KnowledgeInner />
    </Suspense>
  );
}

function KnowledgeInner() {
  const router = useRouter();
  const search = useSearchParams();
  const selectedId = search.get("article");

  const [articles, setArticles] = useState<KbArticleRow[]>([]);
  const [categories, setCategories] = useState<KbCategoryRow[]>([]);
  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const nextSignal = useAbortable();

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  }, []);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (query) params.set("q", query);
      const res = await fetch(`/api/kb/articles?${params}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load articles"));
      const d = await res.json();
      setArticles(d.articles ?? []);
      setCategories(d.categories ?? []);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load articles");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [filter, query, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOrgSlug(d?.org?.slug ?? null))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  const select = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(search.toString());
      if (id) params.set("article", id);
      else params.delete("article");
      router.replace(`/knowledge${params.size ? `?${params}` : ""}`, { scroll: false });
    },
    [router, search]
  );

  const selected = useMemo(() => articles.find((a) => a.id === selectedId) ?? null, [articles, selectedId]);
  const isNew = selectedId === "new";
  const publicCount = articles.filter((a) => a.status === "published" && a.is_public).length;
  const helpUrl = orgSlug ? `/help/${orgSlug}` : null;

  return (
    <PageContainer
      wide
      title="Knowledge base"
      description="Write once, answer forever. Published articles power the public help center, the client portal and your AI agents."
      tooltip="Articles are markdown. Turn on “Show on public help center” to publish one at /help/<workspace>. Agents search published articles (public or not) before replying to tickets."
      className="pb-24"
      actions={
        <>
          {helpUrl && (
            <Button asChild variant="outline" touch>
              <a href={helpUrl} target="_blank" rel="noreferrer">
                <Globe className="h-4 w-4" aria-hidden /> Help center{publicCount ? ` (${publicCount})` : ""} <ExternalLink className="h-3 w-3" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          )}
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh articles">
            {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button touch onClick={() => select("new")}>
            <Plus className="h-4 w-4" aria-hidden /> New article
          </Button>
        </>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs id="article-status" label="Article status" tabs={STATUS_TABS} value={filter} onChange={setFilter} />
        <SearchField value={q} onChange={setQ} label="Search articles" placeholder="Search titles and content" className="sm:w-72" />
      </div>

      <TabPanel id="article-status" value={filter} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section aria-label="Articles" className={cn("min-w-0", selectedId && "hidden lg:block")} aria-busy={loading || undefined}>
          {loading && articles.length === 0 ? (
            <Loading label="Loading articles…" className="rounded-xl border border-border bg-card py-12" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : articles.length === 0 ? (
            <Empty
              icon={<BookOpen className="h-5 w-5" />}
              title={q ? "No articles match" : "No articles yet"}
              text={q ? "Try another search." : "Write your first article, or draft one from a resolved ticket in the helpdesk."}
              action={
                q ? (
                  <Button variant="outline" onClick={() => setQ("")}>
                    Clear search
                  </Button>
                ) : (
                  <Button onClick={() => select("new")}>
                    <Plus className="h-4 w-4" aria-hidden /> New article
                  </Button>
                )
              }
            />
          ) : (
            <ul className="space-y-2">
              {articles.map((a) => (
                <ArticleListItem key={a.id} article={a} active={a.id === selectedId} onSelect={select} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Editor" className={cn("min-w-0", !selectedId && "hidden lg:block")}>
          {isNew || selected ? (
            <Editor
              key={selectedId}
              article={isNew ? null : selected}
              categories={categories}
              helpUrl={helpUrl}
              onBack={() => select(null)}
              notify={notify}
              onSaved={(a, wasNew) => {
                setArticles((prev) => (wasNew ? [a, ...prev] : prev.map((x) => (x.id === a.id ? a : x))));
                if (wasNew) select(a.id);
              }}
              onDeleted={(id) => {
                setArticles((prev) => prev.filter((x) => x.id !== id));
                select(null);
              }}
            />
          ) : (
            <div className="hidden min-h-[280px] items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground lg:flex">
              Pick an article to edit it, or create a new one.
            </div>
          )}
        </section>
      </TabPanel>
    </PageContainer>
  );
}

const ArticleListItem = memo(function ArticleListItem({ article: a, active, onSelect }: { article: KbArticleRow; active: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(a.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "w-full rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          active ? "border-primary/60 bg-accent/40" : "border-border hover:border-primary/30"
        )}
      >
        <p className="truncate text-sm font-medium">{a.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{a.excerpt || "No excerpt"}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusPill status={a.status} map={ARTICLE_TONE} />
          {a.is_public && (
            <Pill tone="accent">
              <Globe className="h-3 w-3" aria-hidden /> Public
            </Pill>
          )}
          {a.category && <Pill>{a.category}</Pill>}
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" aria-hidden /> {a.views}
            <span className="sr-only"> views</span>
          </span>
          <span>· {timeAgo(a.updated_at)}</span>
        </div>
      </button>
    </li>
  );
});

/* ───────────────────────── editor ───────────────────────── */

function Editor({
  article,
  categories,
  helpUrl,
  onBack,
  onSaved,
  onDeleted,
  notify,
}: {
  article: KbArticleRow | null;
  categories: KbCategoryRow[];
  helpUrl: string | null;
  onBack: () => void;
  onSaved: (a: KbArticleRow, wasNew: boolean) => void;
  onDeleted: (id: string) => void;
  notify: (tone: Notice["tone"], text: string) => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(article));
  const [tab, setTab] = useState<EditorTab>("write");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [localCats, setLocalCats] = useState<KbCategoryRow[]>(categories);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(toDraft(article)), [d, article]);

  useEffect(() => {
    setLocalCats(categories);
  }, [categories]);
  useEffect(() => {
    if (!article) titleRef.current?.focus();
  }, [article]);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function save(overrides: Partial<Draft> = {}) {
    const next = { ...d, ...overrides };
    setBusy(true);
    setErr(null);
    try {
      const body = {
        title: next.title.trim(),
        slug: next.slug.trim() || null,
        body_md: next.body_md,
        excerpt: next.excerpt.trim() || null,
        category: next.category || null,
        tags: next.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        status: next.status,
        is_public: next.is_public,
      };
      if (!body.title) throw new Error("Add a title first.");
      const res = await fetch(article ? `/api/kb/articles/${article.id}` : "/api/kb/articles", {
        method: article ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save the article"));
      const { article: saved } = await res.json();
      setD(toDraft(saved));
      onSaved(saved, !article);
      notify("success", overrides.status === "published" ? "Article published." : overrides.status === "draft" ? "Article unpublished." : "Article saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the article");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!article || !window.confirm(`Delete “${article.title}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/kb/articles/${article.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(await readError(res, "Could not delete the article"));
      notify("success", "Article deleted.");
      onDeleted(article.id);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not delete the article");
    } finally {
      setBusy(false);
    }
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/kb/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) throw new Error(await readError(res, "Could not add the category"));
      const { category } = await res.json();
      setLocalCats((prev) => (prev.some((c) => c.id === category.id) ? prev : [...prev, category]));
      setD((x) => ({ ...x, category: category.slug }));
      setNewCategory("");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not add the category");
    }
  }

  const publicLink = article && helpUrl && article.status === "published" && article.is_public ? `${helpUrl}/${article.slug}` : null;
  const sourceCount = article ? parseArr(article.source_ticket_ids).length : 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={article ? "Edit article" : "New article"}
    >
      <div className="flex items-start gap-2">
        <Button type="button" variant="ghost" size="icon" touch className="-ml-2 lg:hidden" onClick={onBack} aria-label="Back to article list">
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <label htmlFor="kb-title" className="sr-only">
            Title
          </label>
          <Input id="kb-title" ref={titleRef} required maxLength={200} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Article title" className="h-11 text-base font-semibold sm:h-10 sm:text-base" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Slug" hint="Filled in from the title if left blank.">
          <Input maxLength={120} value={d.slug} onChange={(e) => setD({ ...d, slug: e.target.value })} placeholder="reset-your-password" spellCheck={false} autoComplete="off" />
        </Field>
        <div className="min-w-0">
          <Field label="Category">
            <Select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>
              <option value="">None</option>
              {localCats.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-1.5 flex gap-2">
            <label htmlFor="kb-newcat" className="sr-only">
              New category name
            </label>
            <Input
              id="kb-newcat"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Add a category…"
              className="sm:h-8 sm:text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addCategory();
                }
              }}
            />
            <Button type="button" variant="outline" size="sm" touch onClick={() => void addCategory()} disabled={!newCategory.trim()}>
              Add
            </Button>
          </div>
        </div>
      </div>

      <Field label="Excerpt" hint="Shown in lists. Generated from the body if left blank.">
        <Input maxLength={500} value={d.excerpt} onChange={(e) => setD({ ...d, excerpt: e.target.value })} />
      </Field>
      <Field label="Tags" hint="Separate with commas.">
        <Input value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} placeholder="billing, passwords" autoComplete="off" />
      </Field>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <Tabs id="kb-editor" label="Editor mode" tabs={EDITOR_TABS} value={tab} onChange={setTab} />
          <span className="text-[11px] text-muted-foreground">Markdown supported</span>
        </div>
        {tab === "write" ? (
          <TabPanel id="kb-editor" value="write">
            <label htmlFor="kb-body" className="sr-only">
              Article body (markdown)
            </label>
            <Textarea
              id="kb-body"
              rows={16}
              value={d.body_md}
              onChange={(e) => setD({ ...d, body_md: e.target.value })}
              placeholder={"## Problem\n\nDescribe what the customer sees.\n\n## Fix\n\n1. Step one\n2. Step two"}
              className="font-mono leading-relaxed sm:text-xs"
            />
          </TabPanel>
        ) : (
          <TabPanel id="kb-editor" value="preview" className="min-h-[200px] rounded-md border border-border bg-secondary/20 p-4">
            {d.body_md.trim() ? <Markdown>{d.body_md}</Markdown> : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}
          </TabPanel>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
        <Checkbox
          checked={d.is_public}
          onChange={(e) => setD({ ...d, is_public: e.target.checked })}
          label={
            <span className="inline-flex items-center gap-1 text-xs">
              <Globe className="h-3 w-3" aria-hidden /> Show on public help center
            </span>
          }
        />
        <StatusPill status={d.status} map={ARTICLE_TONE} />
        {publicLink && (
          <a href={publicLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View live <ExternalLink className="h-3 w-3" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {sourceCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            Drafted from {sourceCount} ticket{sourceCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {err && (
        <Banner tone="error" onDismiss={() => setErr(null)} className="mb-0">
          {err}
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {article && (
            <Button type="button" variant="ghost" size="sm" touch onClick={() => void remove()} disabled={busy} className="text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {d.status === "published" ? (
            <Button type="button" variant="outline" size="sm" touch disabled={busy} onClick={() => void save({ status: "draft" })}>
              Unpublish
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" touch disabled={busy || !d.title.trim()} onClick={() => void save({ status: "published" })}>
              Publish
            </Button>
          )}
          <Button type="submit" size="sm" touch disabled={busy || (!dirty && !!article)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />} {article ? "Save changes" : "Create draft"}
          </Button>
        </div>
      </div>
    </form>
  );
}
