"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Boxes, Check, Download, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { Banner, Empty, Skeleton, TypeIcon, api } from "@/components/records/shared";
import type { RecordType } from "@/lib/records/types";

interface PackView {
  slug: string;
  name: string;
  description: string;
  icon: string;
  installed: boolean;
  installedTypes: string[];
  recordTypes: Array<{ slug: string; name: string; icon: string; description: string }>;
}

export default function RecordsHomePage() {
  const [types, setTypes] = useState<RecordType[]>([]);
  const [packs, setPacks] = useState<PackView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, p] = await Promise.all([api<{ types: RecordType[] }>("/api/records/types"), api<{ packs: PackView[] }>("/api/records/packs")]);
      setTypes(t.types);
      setPacks(p.packs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load records.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function install(slug: string) {
    setBusy(slug);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ types: RecordType[] }>("/api/records/packs", { method: "POST", body: JSON.stringify({ slug }) });
      setNotice(`Installed ${r.types.map((t) => t.name).join(" and ")}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not install the pack.");
    } finally {
      setBusy(null);
    }
  }

  async function migrate() {
    setBusy("migrate");
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ created: number; skipped: number; results: Array<{ errors: string[] }> }>("/api/records/migrate-legacy", { method: "POST", body: "{}" });
      const errs = r.results.flatMap((x) => x.errors).length;
      setNotice(
        `Imported ${r.created} record${r.created === 1 ? "" : "s"} from the old hubs${r.skipped ? `, ${r.skipped} already imported` : ""}${errs ? `, ${errs} skipped with errors` : ""}.`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import from the old hubs.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Records"
      description="Configurable record types with their own fields and workflow stages. Install a template pack or build your own."
      tooltip="Each record type is a board of records that move through stages. Packs give you ready-made types for your industry; every field and stage can be changed later."
      actions={
        <>
          <Button variant="outline" touch onClick={() => void migrate()} disabled={busy !== null}>
            {busy === "migrate" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            <span className="hidden sm:inline">Import from old hubs</span>
            <span className="sm:hidden">Import</span>
          </Button>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
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

      <section aria-labelledby="installed-heading" className="mb-10">
        <h2 id="installed-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your record types
        </h2>
        {loading && types.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label="Loading record types">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : types.length === 0 ? (
          <Empty
            icon={<Boxes className="h-5 w-5" />}
            title="No record types yet"
            text="Install a template pack to get started, or import what you had in the old domain hubs."
            action={
              <Button asChild>
                <a href="#packs-heading">
                  <Sparkles className="h-4 w-4" aria-hidden /> Choose a pack
                </a>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {types.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/r/${t.slug}`}
                  className="group flex h-full min-h-[4.5rem] items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground" aria-hidden>
                    <TypeIcon name={t.icon} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 font-medium">
                      <span className="truncate">{t.name}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none" aria-hidden />
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{t.description || `${t.fields.length} fields · ${t.stages.length} stages`}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="packs-heading">
        <h2 id="packs-heading" className="mb-1 scroll-mt-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Template packs
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">Ready-made record types for your industry. Installing never overwrites a type you already have.</p>
        {loading && packs.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label="Loading packs">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((p) => (
              <li key={p.slug} className="flex flex-col rounded-xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary" aria-hidden>
                    <TypeIcon name={p.icon} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                  </div>
                </div>
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={`${p.name} record types`}>
                  {p.recordTypes.map((t) => {
                    const has = p.installedTypes.includes(t.slug);
                    return (
                      <li key={t.slug}>
                        {has ? (
                          <Link
                            href={`/r/${t.slug}`}
                            className="inline-flex min-h-8 items-center gap-1 rounded-full border border-primary/40 bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Check className="h-3 w-3" aria-hidden /> {t.name}
                            <span className="sr-only"> (installed)</span>
                          </Link>
                        ) : (
                          <span className="inline-flex min-h-8 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">{t.name}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 flex items-center justify-end">
                  {p.installed ? (
                    <Button asChild variant="outline" size="sm" touch>
                      <Link href={`/r/${p.recordTypes[0]?.slug ?? ""}`}>Open</Link>
                    </Button>
                  ) : (
                    <Button size="sm" touch onClick={() => void install(p.slug)} disabled={busy !== null} aria-label={`Install ${p.name} pack`}>
                      {busy === p.slug ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                      {p.installedTypes.length ? "Install missing" : "Install"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
