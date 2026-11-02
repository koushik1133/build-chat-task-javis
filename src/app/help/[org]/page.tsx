import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { getHelpCenterOrg, listPublicArticles, type PublicArticle } from "@/lib/kb/articles";
import { searchArticles } from "@/lib/kb/search";

// Rendering mode: dynamic (search params + per-org data).
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ org: string }>; searchParams: Promise<{ q?: string; category?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { org: slug } = await params;
  const org = await getHelpCenterOrg(slug).catch(() => null);
  return { title: org ? `${org.name} · Help center` : "Help center" };
}

export default async function HelpCenterPage({ params, searchParams }: Props) {
  const [{ org: slug }, sp] = await Promise.all([params, searchParams]);
  const org = await getHelpCenterOrg(slug);
  if (!org) notFound();

  const q = (sp.q ?? "").trim().slice(0, 200);
  const category = (sp.category ?? "").trim().slice(0, 100) || null;

  let articles: PublicArticle[] = [];
  let categories: { slug: string; name: string; count: number }[] = [];
  let failed = false;
  try {
    const base = await listPublicArticles(org.dataId, { category });
    categories = base.categories;
    articles = q
      ? (await searchArticles(org.dataId, q, 25, { publicOnly: true })).filter((h) => !category || h.category === category)
      : base.articles;
  } catch (err) {
    console.error("[help] page load failed:", err);
    failed = true;
  }

  const catName = category ? categories.find((c) => c.slug === category)?.name ?? category : null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header className="mb-8 text-center">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{org.name}</p>
        <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">How can we help?</h1>
        <form action={`/help/${org.slug}`} method="get" role="search" className="mx-auto mt-5 flex max-w-xl gap-2">
          {category && <input type="hidden" name="category" value={category} />}
          <label htmlFor="help-q" className="sr-only">Search articles</label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id="help-q"
              name="q"
              type="search"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              defaultValue={q}
              placeholder="Search articles"
              className="h-11 w-full rounded-md border border-border bg-card pl-9 pr-3 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:text-sm [&::-webkit-search-cancel-button]:appearance-none"
            />
          </div>
          <button type="submit" className="h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10">
            Search
          </button>
        </form>
      </header>

      {categories.length > 0 && (
        <nav aria-label="Categories" className="mb-6 flex flex-wrap justify-center gap-2">
          <Link
            href={`/help/${org.slug}${q ? `?q=${encodeURIComponent(q)}` : ""}`}
            aria-current={!category ? "page" : undefined}
            className={chip(!category)}
          >
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/help/${org.slug}?category=${encodeURIComponent(c.slug)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              aria-current={category === c.slug ? "page" : undefined}
              className={chip(category === c.slug)}
            >
              {c.name} <span className="text-muted-foreground">({c.count})</span>
            </Link>
          ))}
        </nav>
      )}

      {failed ? (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-8 text-center text-sm text-red-700 dark:text-red-300">
          We could not load articles right now. Please try again in a moment.
        </div>
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">{q ? `No articles match “${q}”` : catName ? `Nothing in ${catName} yet` : "No articles yet"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{q || catName ? "Try different words or browse everything." : "Check back soon."}</p>
          {(q || catName) && <Link href={`/help/${org.slug}`} className="mt-4 inline-flex min-h-11 items-center rounded text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Browse all articles</Link>}
        </div>
      ) : (
        <>
          {q && <p className="mb-3 text-xs text-muted-foreground">{articles.length} result{articles.length === 1 ? "" : "s"} for “{q}”</p>}
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {articles.map((a) => (
              <li key={a.id}>
                <Link href={`/help/${org.slug}/${a.slug}`} className="block px-5 py-4 transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
                  <p className="text-sm font-medium">{a.title}</p>
                  {a.excerpt && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>}
                  {a.category && <p className="mt-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{categories.find((c) => c.slug === a.category)?.name ?? a.category}</p>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <footer className="mt-12 text-center text-[11px] text-muted-foreground">{org.name} help center</footer>
    </div>
  );
}

function chip(active: boolean): string {
  return [
    "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
    active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-secondary/60",
  ].join(" ");
}
