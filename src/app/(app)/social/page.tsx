"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BarChart2, Bot, Calendar, CheckCircle2, Edit2, Image as ImageIcon,
  Lightbulb, Link2, Loader2, Plus, RefreshCw, Send, Settings, Share2,
  Sparkles, Trash2, TrendingUp, Users, Zap, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostCard, type SocialPost } from "@/components/social/post-card";
import { PlatformBadge, ALL_PLATFORMS } from "@/components/social/platform-badge";
import { ContentCalendar } from "@/components/social/content-calendar";
import { ALL_CHANNELS, toChannelId } from "@/lib/channels/registry";
import { requestNavRefresh } from "@/lib/nav/nav-refresh";

// ─── Types ─────────────────────────────────────────────────────────────────────

type SocialBrand = {
  id: string;
  name: string;
  website: string;
  industry: string;
  products: string;
  tone: string;
  brand_colors: string;
  target_audience: string;
  posting_frequency: string;
};

type SocialAccount = {
  id: string;
  platform: string;
  handle: string;
  display_name: string;
  connected: boolean;
};

type Analytics = {
  summary: {
    total_posts: number;
    published: number;
    total_impressions: number;
    total_engagements: number;
    avg_engagement_rate: number;
  };
  by_platform: { platform: string; posts: number; impressions: number; engagements: number }[];
};

type Tab = "overview" | "posts" | "calendar" | "analytics" | "accounts" | "brand";

const TONES = ["professional", "casual", "humorous", "inspirational", "educational", "bold", "friendly"];
const FREQUENCIES = ["daily", "3x/week", "5x/week", "twice daily", "weekly"];
const CONTENT_TYPES = ["post", "reel", "story", "thread", "short"];

// ─── Main Component ────────────────────────────────────────────────────────────

export default function SocialPage() {
  const [tab, setTab] = useState<Tab>("overview");

  // Data state
  const [brand, setBrand]       = useState<SocialBrand | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [posts, setPosts]       = useState<SocialPost[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [calPosts, setCalPosts] = useState<SocialPost[]>([]);

  // Loading
  const [loadingPosts, setLoadingPosts]       = useState(false);
  const [loadingGenerate, setLoadingGenerate] = useState(false);
  const [loadingPublish, setLoadingPublish]   = useState(false);
  const [savingBrand, setSavingBrand]         = useState(false);
  const [savingAccount, setSavingAccount]     = useState(false);

  // Generate form
  const [showGenerate, setShowGenerate] = useState(false);
  const [genPlatforms, setGenPlatforms] = useState<string[]>(["instagram", "x", "linkedin"]);
  const [genTypes, setGenTypes]         = useState<string[]>(["post"]);
  const [genCount, setGenCount]         = useState(7);
  const [genTopics, setGenTopics]       = useState("");

  // Brand form
  const [brandForm, setBrandForm] = useState({
    name: "", website: "", industry: "", products: "", tone: "professional",
    brand_colors: "", target_audience: "", posting_frequency: "daily",
  });

  // Account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accForm, setAccForm] = useState({ platform: "instagram", handle: "", display_name: "" });

  // Edit post modal
  const [editPost, setEditPost]   = useState<SocialPost | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editHashtags, setEditHashtags] = useState("");
  const [editSchedule, setEditSchedule] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // ─── Fetch data ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    setLoadingPosts(true);
    try {
      const [brandRes, accRes, postsRes, analyticsRes] = await Promise.all([
        fetch("/api/social/brands").then(r => r.json()).catch(() => ({})),
        fetch("/api/social/accounts").then(r => r.json()).catch(() => ({})),
        fetch("/api/social/posts").then(r => r.json()).catch(() => ({})),
        fetch("/api/social/analytics").then(r => r.json()).catch(() => ({})),
      ]);
      if (brandRes.brands?.[0]) {
        setBrand(brandRes.brands[0]);
        setBrandForm({
          name: brandRes.brands[0].name ?? "",
          website: brandRes.brands[0].website ?? "",
          industry: brandRes.brands[0].industry ?? "",
          products: brandRes.brands[0].products ?? "",
          tone: brandRes.brands[0].tone ?? "professional",
          brand_colors: brandRes.brands[0].brand_colors ?? "",
          target_audience: brandRes.brands[0].target_audience ?? "",
          posting_frequency: brandRes.brands[0].posting_frequency ?? "daily",
        });
      } else if (brandRes.profile) {
        setBrandForm(f => ({
          ...f,
          name: brandRes.profile.company_name ?? "",
          industry: brandRes.profile.industry ?? "",
        }));
      }
      setAccounts(accRes.accounts ?? []);
      const allPosts = postsRes.posts ?? [];
      setPosts(allPosts);
      setCalPosts(allPosts.filter((p: SocialPost) => p.scheduled_at));
      // The .catch above yields {} which is truthy; only accept a real payload.
      setAnalytics(analyticsRes?.summary ? analyticsRes : null);
    } finally {
      setLoadingPosts(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Deep links: /social?tab=accounts and /social?connect=<channel>.
  // Read from window.location rather than useSearchParams — this page has no
  // Suspense boundary, so the hook would opt the whole route out of static rendering.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const TABS: Tab[] = ["overview", "posts", "calendar", "analytics", "accounts", "brand"];
    if (tabParam && (TABS as string[]).includes(tabParam)) setTab(tabParam as Tab);
    const connect = toChannelId(params.get("connect"));
    if (connect) {
      setAccForm(f => ({ ...f, platform: connect }));
      setShowAddAccount(true);
    }
  }, []);

  // ─── Actions ─────────────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!brand) { alert("Please complete Brand Setup first."); setTab("brand"); return; }
    setLoadingGenerate(true);
    setShowGenerate(false);
    try {
      const res = await fetch("/api/social/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_id: brand.id,
          platforms: genPlatforms,
          content_types: genTypes,
          count: genCount,
          topics: genTopics.split(",").map(t => t.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (data.posts) {
        setPosts(prev => [...data.posts, ...prev]);
        setCalPosts(prev => [...data.posts.filter((p: SocialPost) => p.scheduled_at), ...prev]);
        setTab("posts");
      } else {
        alert(data.error ?? "Generation failed.");
      }
    } finally {
      setLoadingGenerate(false);
    }
  }

  async function handleApprove(postId: string) {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const scheduledAt = post.scheduled_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`/api/social/posts/${postId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "scheduled", scheduled_at: scheduledAt }),
    });
    const data = await res.json();
    if (data.post) {
      setPosts(prev => prev.map(p => p.id === postId ? data.post : p));
      setCalPosts(prev => {
        const filtered = prev.filter(p => p.id !== postId);
        return data.post.scheduled_at ? [...filtered, data.post] : filtered;
      });
    }
  }

  async function handleDelete(postId: string) {
    await fetch(`/api/social/posts/${postId}`, { method: "DELETE" });
    setPosts(prev => prev.filter(p => p.id !== postId));
    setCalPosts(prev => prev.filter(p => p.id !== postId));
  }

  async function handlePublish() {
    setLoadingPublish(true);
    try {
      const res = await fetch("/api/social/publish", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        alert(data?.error ?? "Publishing failed. Please try again.");
        return;
      }
      if (typeof data?.failed === "number" && data.failed > 0) {
        const errors: { error?: string }[] = Array.isArray(data.errors) ? data.errors : [];
        const lines = errors.map(e => e?.error).filter(Boolean);
        alert([data.message ?? "Some posts failed to publish.", ...lines].join("\n"));
      } else {
        alert(data?.message ?? "Done!");
      }
      await fetchAll();
    } catch {
      alert("Network error while publishing. Please check your connection and try again.");
    } finally {
      setLoadingPublish(false);
    }
  }

  async function handleSaveBrand() {
    setSavingBrand(true);
    try {
      const method = brand ? "PATCH" : "POST";
      const body   = brand ? { ...brandForm, id: brand.id } : brandForm;
      const res = await fetch("/api/social/brands", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.brand) {
        alert(data?.error ?? "Could not save your brand profile.");
        return;
      }
      setBrand(data.brand);
      setTab("overview");
    } finally {
      setSavingBrand(false);
    }
  }

  async function handleAddAccount() {
    if (!accForm.handle) return;
    setSavingAccount(true);
    try {
      const res = await fetch("/api/social/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...accForm, brand_id: brand?.id }),
      });
      const data = await res.json();
      if (data.account) {
        setAccounts(a => [...a, data.account]);
        setShowAddAccount(false);
        setAccForm({ platform: "instagram", handle: "", display_name: "" });
        requestNavRefresh();
      }
    } finally {
      setSavingAccount(false);
    }
  }

  async function handleDisconnect(id: string) {
    await fetch(`/api/social/accounts?id=${id}`, { method: "DELETE" });
    setAccounts(a => a.filter(acc => acc.id !== id));
    requestNavRefresh();
  }

  function openEdit(post: SocialPost) {
    setEditPost(post);
    setEditCaption(post.caption);
    setEditHashtags(post.hashtags ?? "");
    setEditSchedule(post.scheduled_at ? post.scheduled_at.slice(0, 16) : "");
  }

  async function saveEdit() {
    if (!editPost) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/social/posts/${editPost.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: editCaption,
          hashtags: editHashtags,
          scheduled_at: editSchedule || null,
        }),
      });
      const data = await res.json();
      if (data.post) {
        setPosts(prev => prev.map(p => p.id === editPost.id ? data.post : p));
        setCalPosts(prev => {
          const f = prev.filter(p => p.id !== editPost.id);
          return data.post.scheduled_at ? [...f, data.post] : f;
        });
        setEditPost(null);
      }
    } finally {
      setSavingEdit(false);
    }
  }

  // ─── Computed stats ───────────────────────────────────────────────────────────

  const draftCount     = posts.filter(p => p.status === "draft").length;
  const scheduledCount = posts.filter(p => p.status === "scheduled").length;
  const publishedCount = posts.filter(p => p.status === "published").length;

  // ─── Tabs config ─────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "overview",  label: "Overview",  icon: <Share2 className="h-3.5 w-3.5" /> },
    { id: "posts",     label: "Posts",     icon: <ImageIcon className="h-3.5 w-3.5" /> },
    { id: "calendar",  label: "Calendar",  icon: <Calendar className="h-3.5 w-3.5" /> },
    { id: "analytics", label: "Analytics", icon: <BarChart2 className="h-3.5 w-3.5" /> },
    { id: "accounts",  label: "Accounts",  icon: <Link2 className="h-3.5 w-3.5" /> },
    { id: "brand",     label: "Brand Setup",icon: <Settings className="h-3.5 w-3.5" /> },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">

        {/* ── Page header ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl flex items-center gap-2">
              <Share2 className="h-5 w-5 text-primary" />
              AI Social Media Employee
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your autonomous social media team — researches, creates, schedules, and publishes every day.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setShowGenerate(true)} disabled={loadingGenerate}>
              {loadingGenerate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {loadingGenerate ? "Generating…" : "Generate Content"}
            </Button>
            <Button size="sm" onClick={handlePublish} disabled={loadingPublish || scheduledCount === 0}>
              {loadingPublish ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Publish Now
            </Button>
          </div>
        </div>

        {/* ── No brand setup banner ── */}
        {!brand && (
          <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">Get started — Set up your brand profile</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Tell the AI about your business, tone, and audience so it can generate on-brand content automatically.
              </p>
            </div>
            <Button size="sm" onClick={() => setTab("brand")}>
              <Settings className="h-3.5 w-3.5" /> Set up Brand
            </Button>
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0 -mb-6">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        <div className="pt-2">

          {/* ════════════════════════════════════════ OVERVIEW TAB */}
          {tab === "overview" && (
            <div className="space-y-6">
              {/* Stats cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: "Total Posts",   value: posts.length,   icon: <ImageIcon className="h-4 w-4" />, color: "text-primary" },
                  { label: "In Queue",      value: draftCount,     icon: <Edit2 className="h-4 w-4" />,     color: "text-yellow-600" },
                  { label: "Scheduled",     value: scheduledCount, icon: <Calendar className="h-4 w-4" />, color: "text-blue-600" },
                  { label: "Published",     value: publishedCount, icon: <CheckCircle2 className="h-4 w-4" />, color: "text-green-600" },
                ].map(stat => (
                  <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
                    <div className={`${stat.color} mb-2`}>{stat.icon}</div>
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <div className="text-xs text-muted-foreground">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* AI Pipeline */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  AI Content Pipeline
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    { icon: <TrendingUp className="h-3.5 w-3.5" />, label: "Research Trends" },
                    { icon: <Lightbulb className="h-3.5 w-3.5" />, label: "Generate Ideas" },
                    { icon: <Edit2 className="h-3.5 w-3.5" />,    label: "Write Captions" },
                    { icon: <ImageIcon className="h-3.5 w-3.5" />,label: "Create Images" },
                    { icon: <Zap className="h-3.5 w-3.5" />,      label: "Add Hashtags" },
                    { icon: <Calendar className="h-3.5 w-3.5" />, label: "Schedule" },
                    { icon: <Send className="h-3.5 w-3.5" />,     label: "Publish" },
                    { icon: <BarChart2 className="h-3.5 w-3.5" />,label: "Analyze" },
                  ].map((step, i, arr) => (
                    <div key={step.label} className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded-lg bg-primary/5 border border-primary/20 px-2.5 py-1.5 text-xs text-primary">
                        {step.icon}{step.label}
                      </div>
                      {i < arr.length - 1 && (
                        <span className="text-muted-foreground text-sm">→</span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Click <strong>Generate Content</strong> above to run the full AI pipeline for your brand.
                </p>
              </div>

              {/* Connected accounts */}
              {accounts.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" /> Connected Accounts
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {accounts.map(acc => (
                      <div key={acc.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5">
                        <PlatformBadge platform={acc.platform} />
                        <span className="text-xs text-muted-foreground">@{acc.handle}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent posts */}
              {posts.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold">Recent Posts</h2>
                    <button onClick={() => setTab("posts")} className="text-xs text-primary hover:underline">View all</button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {posts.slice(0, 3).map(post => (
                      <PostCard
                        key={post.id}
                        post={post}
                        onApprove={handleApprove}
                        onDelete={handleDelete}
                        onEdit={openEdit}
                        onSchedule={openEdit}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ POSTS TAB */}
          {tab === "posts" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{posts.length} posts</span>
                  {draftCount > 0 && (
                    <span className="text-xs bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400 rounded-full px-2 py-0.5">
                      {draftCount} need approval
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={fetchAll} disabled={loadingPosts}>
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingPosts ? "animate-spin" : ""}`} />
                  </Button>
                  <Button size="sm" onClick={() => setShowGenerate(true)}>
                    <Plus className="h-3.5 w-3.5" /> Generate More
                  </Button>
                </div>
              </div>

              {loadingPosts ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : posts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <ImageIcon className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No posts yet</p>
                  <p className="text-xs text-muted-foreground mb-4">Generate your first batch of AI content to get started.</p>
                  <Button size="sm" onClick={() => setShowGenerate(true)}>
                    <Sparkles className="h-3.5 w-3.5" /> Generate Content
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {posts.map(post => (
                    <PostCard
                      key={post.id}
                      post={post}
                      onApprove={handleApprove}
                      onDelete={handleDelete}
                      onEdit={openEdit}
                      onSchedule={openEdit}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ CALENDAR TAB */}
          {tab === "calendar" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{calPosts.length} scheduled posts this month</p>
                <Button size="sm" variant="outline" onClick={() => setTab("posts")}>
                  <Calendar className="h-3.5 w-3.5" /> Manage Posts
                </Button>
              </div>
              <ContentCalendar
                posts={calPosts}
                onPostClick={(post) => { openEdit(post as SocialPost); }}
              />
            </div>
          )}

          {/* ════════════════════════════════════════ ANALYTICS TAB */}
          {tab === "analytics" && analytics && (
            <div className="space-y-5">
              {/* Summary stats */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                {[
                  { label: "Total Posts",      value: analytics.summary.total_posts,      icon: <ImageIcon className="h-4 w-4" /> },
                  { label: "Published",        value: analytics.summary.published,         icon: <CheckCircle2 className="h-4 w-4" /> },
                  { label: "Impressions",      value: analytics.summary.total_impressions.toLocaleString(), icon: <TrendingUp className="h-4 w-4" /> },
                  { label: "Engagements",      value: analytics.summary.total_engagements.toLocaleString(), icon: <Zap className="h-4 w-4" /> },
                  { label: "Avg. Eng. Rate",   value: `${analytics.summary.avg_engagement_rate}%`, icon: <BarChart2 className="h-4 w-4" /> },
                ].map(stat => (
                  <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
                    <div className="text-primary mb-2">{stat.icon}</div>
                    <div className="text-xl font-bold">{stat.value}</div>
                    <div className="text-xs text-muted-foreground">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* By platform */}
              {analytics.by_platform.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <h2 className="text-sm font-semibold mb-4">Performance by Platform</h2>
                  <div className="space-y-3">
                    {analytics.by_platform.map(p => {
                      const pct = analytics.summary.total_impressions > 0
                        ? Math.round((p.impressions / analytics.summary.total_impressions) * 100)
                        : 0;
                      return (
                        <div key={p.platform}>
                          <div className="flex items-center justify-between mb-1">
                            <PlatformBadge platform={p.platform} />
                            <span className="text-xs text-muted-foreground">{p.impressions.toLocaleString()} impressions • {p.posts} posts</span>
                          </div>
                          <div className="h-2 rounded-full bg-secondary overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                📊 Analytics are simulated in V1. Connect real platform APIs in V2 for live data.
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════ ACCOUNTS TAB */}
          {tab === "accounts" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{accounts.length} connected accounts</p>
                <Button size="sm" onClick={() => setShowAddAccount(true)}>
                  <Plus className="h-3.5 w-3.5" /> Connect Account
                </Button>
              </div>

              {accounts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <Link2 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No accounts connected</p>
                  <p className="text-xs text-muted-foreground mb-4">Connect your social accounts so posts can be published automatically.</p>
                  <Button size="sm" onClick={() => setShowAddAccount(true)}>
                    <Plus className="h-3.5 w-3.5" /> Connect First Account
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {accounts.map(acc => (
                    <div key={acc.id} className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <PlatformBadge platform={acc.platform} size="md" />
                        <div>
                          <div className="text-sm font-medium">@{acc.handle}</div>
                          <div className="text-xs text-muted-foreground">{acc.display_name}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400 rounded-full px-2 py-0.5">
                          Connected
                        </span>
                        <button onClick={() => handleDisconnect(acc.id)} className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Platform status */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold mb-3">Platform API Status</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {ALL_CHANNELS.map(c => ({
                    platform: c.id,
                    note: c.capabilities.publishable ? "Publishing supported" : "Publishing not supported yet",
                  })).map(p => (
                    <div key={p.platform} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                      <PlatformBadge platform={p.platform} />
                      <span className="text-[9px] text-muted-foreground">{p.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════ BRAND SETUP TAB */}
          {tab === "brand" && (
            <div className="space-y-5 max-w-2xl">
              <div>
                <h2 className="text-sm font-semibold mb-1">Brand Profile</h2>
                <p className="text-xs text-muted-foreground">
                  This profile is fed to the AI on every content generation. The more detail you add, the better the results.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { key: "name", label: "Business Name *", placeholder: "Acme Corp" },
                    { key: "website", label: "Website", placeholder: "https://acme.com" },
                    { key: "industry", label: "Industry", placeholder: "SaaS / E-commerce / Healthcare…" },
                    { key: "target_audience", label: "Target Audience", placeholder: "Startup founders, aged 25–45" },
                    { key: "brand_colors", label: "Brand Colors", placeholder: "#6366f1, #0ea5e9" },
                  ].map(field => (
                    <div key={field.key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">{field.label}</label>
                      <input
                        value={(brandForm as Record<string,string>)[field.key] ?? ""}
                        onChange={e => setBrandForm(f => ({ ...f, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Products / Services</label>
                  <textarea
                    value={brandForm.products}
                    onChange={e => setBrandForm(f => ({ ...f, products: e.target.value }))}
                    placeholder="Describe your main products or services…"
                    rows={3}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Brand Tone</label>
                    <select
                      value={brandForm.tone}
                      onChange={e => setBrandForm(f => ({ ...f, tone: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {TONES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Posting Frequency</label>
                    <select
                      value={brandForm.posting_frequency}
                      onChange={e => setBrandForm(f => ({ ...f, posting_frequency: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                </div>

                <Button className="w-full" onClick={handleSaveBrand} disabled={savingBrand || !brandForm.name.trim()}>
                  {savingBrand ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  {brand ? "Save Changes" : "Save Brand Profile"}
                </Button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ════════════════════════════════════════ GENERATE MODAL */}
      {showGenerate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowGenerate(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Generate AI Content</h2>
              <button onClick={() => setShowGenerate(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            {/* Platform selection */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Platforms</label>
              <div className="flex flex-wrap gap-2">
                {ALL_PLATFORMS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setGenPlatforms(prev =>
                      prev.includes(p.value) ? prev.filter(x => x !== p.value) : [...prev, p.value]
                    )}
                    className={`text-xs rounded-full px-3 py-1 border transition-colors ${
                      genPlatforms.includes(p.value)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {p.emoji} {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Content types */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Content Types</label>
              <div className="flex flex-wrap gap-2">
                {CONTENT_TYPES.map(ct => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setGenTypes(prev =>
                      prev.includes(ct) ? prev.filter(x => x !== ct) : [...prev, ct]
                    )}
                    className={`text-xs rounded-full px-3 py-1 border capitalize transition-colors ${
                      genTypes.includes(ct)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {ct}
                  </button>
                ))}
              </div>
            </div>

            {/* Count */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Number of posts: {genCount}</label>
              <input
                type="range" min={3} max={14} value={genCount}
                onChange={e => setGenCount(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                <span>3</span><span>14</span>
              </div>
            </div>

            {/* Topics */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Focus topics <span className="text-muted-foreground/60">(optional — comma separated)</span>
              </label>
              <input
                value={genTopics}
                onChange={e => setGenTopics(e.target.value)}
                placeholder="e.g. product launch, industry tips, behind the scenes"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowGenerate(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleGenerate}
                disabled={genPlatforms.length === 0 || genTypes.length === 0 || loadingGenerate}>
                <Sparkles className="h-3.5 w-3.5" /> Generate {genCount} Posts
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════ ADD ACCOUNT MODAL */}
      {showAddAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddAccount(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Connect Account</h2>
              <button onClick={() => setShowAddAccount(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Platform</label>
              <select
                value={accForm.platform}
                onChange={e => setAccForm(f => ({ ...f, platform: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
              >
                {ALL_PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.emoji} {p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Handle / Username</label>
              <input
                value={accForm.handle}
                onChange={e => setAccForm(f => ({ ...f, handle: e.target.value }))}
                placeholder="yourbrand"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Display Name</label>
              <input
                value={accForm.display_name}
                onChange={e => setAccForm(f => ({ ...f, display_name: e.target.value }))}
                placeholder="Your Brand Name"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowAddAccount(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleAddAccount} disabled={savingAccount || !accForm.handle.trim()}>
                {savingAccount ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                Connect
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════ EDIT POST MODAL */}
      {editPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEditPost(null)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-xl shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Edit Post</h2>
              <button onClick={() => setEditPost(null)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="flex items-center gap-2">
              <PlatformBadge platform={editPost.platform} size="md" />
              <span className="text-xs text-muted-foreground capitalize">{editPost.content_type}</span>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Caption</label>
              <textarea
                value={editCaption}
                onChange={e => setEditCaption(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-y"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Hashtags</label>
              <input
                value={editHashtags}
                onChange={e => setEditHashtags(e.target.value)}
                placeholder="#hashtag1 #hashtag2"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Schedule Date & Time</label>
              <input
                type="datetime-local"
                value={editSchedule}
                onChange={e => setEditSchedule(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditPost(null)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={saveEdit} disabled={savingEdit}>
                {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
