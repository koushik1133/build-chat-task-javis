"use client";

import { memo, Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Boxes, Download, Loader2, RefreshCw, Star, Store, Trash2, Upload, Workflow, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { Markdown } from "@/components/markdown";
import { api } from "@/components/records/shared";
import { CATEGORIES, KIND_LABELS, KIND_PLURALS, LISTING_KINDS, SORTS, VISIBILITIES, isListingKind, type ListingDTO, type ListingKind, type ReviewDTO, type Sort, type Visibility } from "@/lib/marketplace/types";

/* Rendering mode: client page; all data via /api/marketplace/* (authenticated). */

type Tab = "all" | ListingKind | "mine";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", label: "All" },
  ...LISTING_KINDS.map((k) => ({ id: k, label: KIND_PLURALS[k] })),
  { id: "mine", label: "My listings" },
];

const KIND_ICON: Record<ListingKind, LucideIcon> = { agent: Bot, playbook: Zap, automation: Workflow, pack: Boxes };
const KIND_TONE: Record<ListingKind, Tone> = { agent: "info", playbook: "violet", automation: "warning", pack: "success" };
const PUBLISHER_LABEL = { builtin: "Built-in", you: "Yours", community: "Community" } as const;
const SORT_LABEL: Record<Sort, string> = { popular: "Most installed", newest: "Newest", rating: "Top rated", title: "A → Z" };
const VIS_LABEL: Record<Visibility, string> = { private: "Private (only me)", org: "My organisation", public: "Public" };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Rating({ avg, count }: { avg: number | null; count: number }) {
  if (avg === null) return <span className="text-xs text-muted-foreground">No reviews yet</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-label={`Rated ${avg} out of 5 from ${count} review${count === 1 ? "" : "s"}`}>
      <Star className="h-3.5 w-3.5 fill-current text-primary" aria-hidden />
      <span className="tabular-nums">{avg.toFixed(1)}</span>
      <span>({count})</span>
    </span>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Marketplace" description="Install ready-made agents, playbooks, automations and record packs, or publish your own.">
          <SkeletonList count={6} itemClassName="h-36" />
        </PageContainer>
      }
    >
      <MarketplaceInner />
    </Suspense>
  );
}

function MarketplaceInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialKind = params.get("kind");
  const [tab, setTab] = useState<Tab>(isListingKind(initialKind) ? initialKind : "all");
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebouncedValue(q, 250);
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<Sort>("popular");
  const [listings, setListings] = useState<ListingDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get("id"));
  const [publishing, setPublishing] = useState(false);
  const tabsId = useId();
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      if (tab === "mine") {
        const r = await api<{ listings: ListingDTO[] }>("/api/marketplace/mine", { signal });
        setListings(r.listings);
      } else {
        const sp = new URLSearchParams();
        if (dq.trim()) sp.set("q", dq.trim());
        if (tab !== "all") sp.set("kind", tab);
        if (category) sp.set("category", category);
        sp.set("sort", sort);
        const r = await api<{ listings: ListingDTO[] }>(`/api/marketplace?${sp.toString()}`, { signal });
        setListings(r.listings);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load the marketplace.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [tab, dq, category, sort, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the URL shareable (kind + search + open listing) without adding history entries.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (tab !== "all" && tab !== "mine") sp.set("kind", tab);
    if (dq.trim()) sp.set("q", dq.trim());
    if (selected) sp.set("id", selected);
    const qs = sp.toString();
    router.replace(qs ? `/marketplace?${qs}` : "/marketplace", { scroll: false });
  }, [tab, dq, selected, router]);

  const visible = useMemo(() => {
    if (tab !== "mine") return listings;
    const needle = dq.trim().toLowerCase();
    return listings.filter((l) => !needle || `${l.title} ${l.summary ?? ""}`.toLowerCase().includes(needle));
  }, [listings, tab, dq]);

  const onChanged = useCallback((msg: string | null, patch?: ListingDTO | null, removedId?: string) => {
    if (msg) setNotice(msg);
    if (removedId) setListings((xs) => xs.filter((x) => x.id !== removedId));
    else if (patch) setListings((xs) => (xs.some((x) => x.id === patch.id) ? xs.map((x) => (x.id === patch.id ? patch : x)) : [patch, ...xs]));
  }, []);
  const open = useCallback((id: string) => setSelected(id), []);

  return (
    <PageContainer
      wide
      title="Marketplace"
      description="Install ready-made agents, playbooks, automations and record packs, or publish your own for your team and the community."
      tooltip="Built-in listings ship with the product. Anything you publish stays private until you set it to organisation or public visibility. Installs are idempotent: installing the same version twice is a no-op."
      icon={<Store className="h-5 w-5" aria-hidden />}
      actions={
        <>
          <Button touch onClick={() => setPublishing(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Publish from my workspace</span>
            <span className="sm:hidden">Publish</span>
          </Button>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh listings">
            {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      <div className="mb-4 flex flex-col gap-3">
        <Tabs id={tabsId} tabs={TABS} value={tab} onChange={setTab} label="Listing kind" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <SearchField value={q} onChange={setQ} label="Search listings" placeholder="Search by name, tag or category…" />
          <label className="sr-only" htmlFor="mk-category">
            Category
          </label>
          <Select id="mk-category" value={category} onChange={(e) => setCategory(e.target.value)} disabled={tab === "mine"} className="sm:w-44">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {cap(c)}
              </option>
            ))}
          </Select>
          <label className="sr-only" htmlFor="mk-sort">
            Sort
          </label>
          <Select id="mk-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} disabled={tab === "mine"} className="sm:w-44">
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {loading ? "Loading listings…" : `${visible.length} listing${visible.length === 1 ? "" : "s"} shown`}
      </p>

      <TabPanel id={tabsId} value={tab}>
        {loading && listings.length === 0 ? (
          <SkeletonList count={6} itemClassName="h-36" label="Loading listings…" />
        ) : error && listings.length === 0 ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : visible.length === 0 ? (
          tab === "mine" ? (
            <Empty
              icon={<Upload className="h-5 w-5" />}
              title="You have not published anything yet"
              text="Turn an agent, automation or record type from your workspace into a listing. It stays private until you share it."
              action={<Button onClick={() => setPublishing(true)}>Publish from my workspace</Button>}
            />
          ) : (
            <Empty icon={<Store className="h-5 w-5" />} title="No listings match" text="Try another search term, category or kind." action={<Button variant="outline" onClick={() => { setQ(""); setCategory(""); }}>Clear filters</Button>} />
          )
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy={loading || undefined}>
            {visible.map((l) => (
              <li key={l.id}>
                <ListingCard listing={l} onOpen={open} />
              </li>
            ))}
          </ul>
        )}
      </TabPanel>

      {selected && <ListingDrawer id={selected} onClose={() => setSelected(null)} onChanged={onChanged} />}
      {publishing && (
        <PublishDialog
          onClose={() => setPublishing(false)}
          onPublished={(l, msg) => {
            setPublishing(false);
            onChanged(msg, l);
            setTab("mine");
            setSelected(l.id);
          }}
        />
      )}
    </PageContainer>
  );
}

const ListingCard = memo(function ListingCard({ listing: l, onOpen }: { listing: ListingDTO; onOpen: (id: string) => void }) {
  const Icon = KIND_ICON[l.kind];
  return (
    <button
      type="button"
      onClick={() => onOpen(l.id)}
      aria-label={`Open ${l.title} (${KIND_LABELS[l.kind]})`}
      className="flex h-full w-full flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground" aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex flex-wrap justify-end gap-1">
          <Pill tone={KIND_TONE[l.kind]}>{KIND_LABELS[l.kind]}</Pill>
          {l.installed && <Pill tone="success">Installed</Pill>}
          {l.owner && l.visibility !== "public" && <Pill tone="neutral">{l.visibility === "org" ? "Org" : "Private"}</Pill>}
        </div>
      </div>
      <h3 className="line-clamp-1 w-full break-words font-medium">{l.title}</h3>
      <p className="line-clamp-2 w-full text-sm text-muted-foreground">{l.summary ?? "No summary."}</p>
      <div className="mt-auto flex w-full flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
        <span>{PUBLISHER_LABEL[l.publisher]}</span>
        {l.category && <span>· {cap(l.category)}</span>}
        <span className="inline-flex items-center gap-1">
          <Download className="h-3 w-3" aria-hidden /> <span className="tabular-nums">{l.install_count}</span>
          <span className="sr-only"> installs</span>
        </span>
        <Rating avg={l.rating_avg} count={l.rating_count} />
      </div>
    </button>
  );
});

function ListingDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (msg: string | null, patch?: ListingDTO | null, removedId?: string) => void }) {
  const titleId = useId();
  const [listing, setListing] = useState<ListingDTO | null>(null);
  const [reviews, setReviews] = useState<ReviewDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"install" | "review" | "visibility" | "delete" | null>(null);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ listing: ListingDTO; reviews: ReviewDTO[] }>(`/api/marketplace/${encodeURIComponent(id)}`, { signal });
      setListing(r.listing);
      setReviews(r.reviews);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load the listing.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [id, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  async function install() {
    if (!listing) return;
    setBusy("install");
    setError(null);
    try {
      const r = await api<{ install: { created: boolean; note: string | null }; listing: ListingDTO }>(`/api/marketplace/${encodeURIComponent(listing.id)}/install`, { method: "POST" });
      setListing(r.listing);
      setInstallNote(r.install.note ?? (r.install.created ? "Installed." : "Already installed."));
      onChanged(r.install.created ? `Installed "${r.listing.title}". ${r.install.note ?? ""}`.trim() : null, r.listing);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed.");
    } finally {
      setBusy(null);
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!listing) return;
    setBusy("review");
    setError(null);
    try {
      const r = await api<{ review: ReviewDTO; listing: ListingDTO | null }>(`/api/marketplace/${encodeURIComponent(listing.id)}/reviews`, {
        method: "POST",
        body: JSON.stringify({ rating, body: body.trim() || null }),
      });
      setReviews((xs) => [r.review, ...xs.filter((x) => !x.mine)]);
      if (r.listing) {
        setListing(r.listing);
        onChanged(null, r.listing);
      }
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your review.");
    } finally {
      setBusy(null);
    }
  }

  async function changeVisibility(v: Visibility) {
    if (!listing) return;
    setBusy("visibility");
    setError(null);
    try {
      const r = await api<{ listing: ListingDTO }>(`/api/marketplace/mine?id=${encodeURIComponent(listing.id)}`, { method: "PATCH", body: JSON.stringify({ visibility: v }) });
      setListing(r.listing);
      onChanged(`Visibility set to ${VIS_LABEL[v].toLowerCase()}.`, r.listing);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update visibility.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!listing) return;
    setConfirmDelete(false);
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/marketplace/mine?id=${encodeURIComponent(listing.id)}`, { method: "DELETE" });
      onChanged(`Deleted "${listing.title}".`, null, listing.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the listing.");
      setBusy(null);
    }
  }

  const Icon = listing ? KIND_ICON[listing.kind] : Store;
  const myReview = reviews.find((r) => r.mine);

  return (
    <Drawer
      labelledBy={titleId}
      onClose={onClose}
      header={
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground" aria-hidden>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-base font-semibold leading-snug">
              {listing?.title ?? "Listing"}
            </h2>
            {listing && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Pill tone={KIND_TONE[listing.kind]}>{KIND_LABELS[listing.kind]}</Pill>
                <span>{PUBLISHER_LABEL[listing.publisher]}</span>
                <span>· v{listing.version}</span>
                {listing.category && <span>· {cap(listing.category)}</span>}
              </div>
            )}
          </div>
        </div>
      }
      footer={
        listing && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Download className="h-3.5 w-3.5" aria-hidden /> {listing.install_count} install{listing.install_count === 1 ? "" : "s"}
              </span>
              <Rating avg={listing.rating_avg} count={listing.rating_count} />
            </div>
            <Button touch onClick={() => void install()} disabled={busy !== null}>
              {busy === "install" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              {listing.installed ? "Reinstall" : "Install"}
            </Button>
          </div>
        )
      }
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {installNote && (
        <Banner tone="success" onDismiss={() => setInstallNote(null)}>
          {installNote}
        </Banner>
      )}
      {loading && !listing ? (
        <SkeletonList count={4} itemClassName="h-10" label="Loading listing…" />
      ) : !listing ? (
        <ErrorState message={error ?? "Listing not found."} onRetry={() => void load()} />
      ) : (
        <div className="space-y-6">
          {listing.summary && <p className="text-sm text-muted-foreground">{listing.summary}</p>}
          {listing.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Tags">
              {listing.tags.map((t) => (
                <li key={t}>
                  <Pill tone="neutral">#{t}</Pill>
                </li>
              ))}
            </ul>
          )}

          {listing.description_md ? <Markdown>{listing.description_md}</Markdown> : <p className="text-sm text-muted-foreground">No description.</p>}

          <details className="rounded-lg border border-border p-3 text-sm">
            <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Portable definition (JSON)</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-secondary/40 p-2 text-xs" tabIndex={0}>{JSON.stringify(listing.definition, null, 2)}</pre>
          </details>

          {listing.owner && (
            <section className="rounded-lg border border-border p-3" aria-labelledby={`${titleId}-manage`}>
              <h3 id={`${titleId}-manage`} className="mb-2 text-sm font-medium">
                Manage your listing
              </h3>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Visibility" className="min-w-[12rem] flex-1">
                  <Select value={listing.visibility} disabled={busy !== null} onChange={(e) => void changeVisibility(e.target.value as Visibility)}>
                    {VISIBILITIES.map((v) => (
                      <option key={v} value={v}>
                        {VIS_LABEL[v]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button variant="destructive" size="sm" touch onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
                  {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Delete
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Re-publish the same entity to ship a new version; installers see the latest one.</p>
            </section>
          )}

          <section aria-labelledby={`${titleId}-reviews`}>
            <h3 id={`${titleId}-reviews`} className="mb-2 text-sm font-medium">
              Reviews
            </h3>
            {reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reviews yet.</p>
            ) : (
              <ul className="space-y-2">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span role="img" aria-label={`${r.rating} out of 5 stars`} className="text-primary">
                        {"★".repeat(r.rating)}
                        <span className="text-muted-foreground/40">{"★".repeat(5 - r.rating)}</span>
                      </span>
                      {r.mine && <Pill tone="info">You</Pill>}
                      <span>{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                    {r.body && <p className="mt-1 whitespace-pre-wrap">{r.body}</p>}
                  </li>
                ))}
              </ul>
            )}
            {!listing.owner && (
              <form className="mt-3 space-y-2" onSubmit={(e) => void submitReview(e)}>
                <Field label={myReview ? "Update your review" : "Leave a review"}>
                  <Select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {n} star{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Comment" hint="Optional, up to 2000 characters.">
                  <Textarea rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
                </Field>
                <Button type="submit" size="sm" variant="outline" touch disabled={busy !== null}>
                  {busy === "review" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} {myReview ? "Update review" : "Post review"}
                </Button>
              </form>
            )}
          </section>
        </div>
      )}
      {confirmDelete && listing && (
        <Dialog title="Delete this listing?" description={`"${listing.title}" is removed from the marketplace. Copies already installed in other workspaces are not affected.`} onClose={() => setConfirmDelete(false)} size="sm">
          <DialogFooter>
            <Button variant="outline" touch onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" touch onClick={() => void remove()}>
              Delete listing
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </Drawer>
  );
}

type Publishable = Record<ListingKind, Array<{ id: string; label: string; hint?: string }>>;

function PublishDialog({ onClose, onPublished }: { onClose: () => void; onPublished: (l: ListingDTO, msg: string) => void }) {
  const [options, setOptions] = useState<Publishable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<ListingKind>("agent");
  const [entityId, setEntityId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ publishable: Publishable }>("/api/marketplace/publish")
      .then((r) => setOptions(r.publishable))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load your workspace entities."));
  }, []);

  const choices = options?.[kind] ?? [];
  useEffect(() => {
    setEntityId("");
  }, [kind]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!entityId) {
      setError("Pick what to publish.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ listing: ListingDTO; scrubbed: string[]; updated: boolean }>("/api/marketplace/publish", {
        method: "POST",
        body: JSON.stringify({
          kind,
          entityId,
          visibility,
          title: title.trim() || null,
          summary: summary.trim() || null,
          description_md: description.trim() || null,
          category: category || null,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 12),
        }),
      });
      const scrubbed = r.scrubbed.length ? ` Removed workspace-specific settings: ${r.scrubbed.join(", ")}.` : "";
      onPublished(r.listing, `${r.updated ? "Re-published" : "Published"} "${r.listing.title}" as v${r.listing.version} (${VIS_LABEL[r.listing.visibility].toLowerCase()}).${scrubbed}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed.");
      setBusy(false);
    }
  }

  return (
    <Dialog title="Publish from my workspace" description="Export an agent, playbook, automation or record pack as a portable listing. Ids, recipients and webhook URLs are stripped automatically." onClose={onClose} size="lg">
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {loadError && <Banner tone="error">{loadError}</Banner>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value as ListingKind)}>
              {LISTING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Which ${KIND_LABELS[kind].toLowerCase()}`} required hint={!options ? "Loading your workspace…" : choices.length === 0 ? `Nothing to publish of this kind yet.` : undefined}>
            <Select value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={!options || choices.length === 0} required>
              <option value="">Select…</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.hint ? ` — ${c.hint}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Title" hint="Defaults to the entity's name.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Summary" hint="One line shown on the card.">
          <Input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Description (Markdown)" hint="Defaults to an auto-generated description of the definition.">
          <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20_000} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Auto</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {cap(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sales, outreach" />
          </Field>
          <Field label="Visibility">
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              {VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {VIS_LABEL[v]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <DialogFooter start={visibility === "public" ? "Public listings are visible to every workspace." : "You can change visibility later."}>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy || !entityId}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />} Publish
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
