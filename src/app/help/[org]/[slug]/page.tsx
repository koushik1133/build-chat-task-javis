import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { getHelpCenterOrg, getPublicArticle } from "@/lib/kb/articles";

// Rendering mode: dynamic (per-org data; view counter).
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ org: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { org: orgSlug, slug } = await params;
  const org = await getHelpCenterOrg(orgSlug).catch(() => null);
  if (!org) return { title: "Help center" };
  const article = await getPublicArticle(org.dataId, slug, { countView: false }).catch(() => null);
  if (!article) return { title: `${org.name} · Help center` };
  return {
    title: `${article.title} · ${org.name}`,
    description: article.excerpt ?? undefined,
    openGraph: { type: "article", title: article.title, description: article.excerpt ?? undefined },
  };
}

export default async function HelpArticlePage({ params }: Props) {
  const { org: orgSlug, slug } = await params;
  const org = await getHelpCenterOrg(orgSlug);
  if (!org) notFound();
  const article = await getPublicArticle(org.dataId, slug);
  if (!article) notFound();

  const updated = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(article.published_at ?? article.updated_at));

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Link href={`/help/${org.slug}`} className="inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {org.name} help center
      </Link>
      <article className="mt-5 rounded-xl border border-border bg-card p-5 sm:p-8">
        <header className="mb-6 border-b border-border pb-5">
          {article.category && <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{article.category.replace(/-/g, " ")}</p>}
          <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight">{article.title}</h1>
          <p className="mt-2 text-xs text-muted-foreground">Updated <time dateTime={article.published_at ?? article.updated_at}>{updated}</time></p>
        </header>
        <Markdown>{article.body_md}</Markdown>
        {article.tags.length > 0 && (
          <ul aria-label="Tags" className="mt-8 flex flex-wrap gap-1.5">
            {article.tags.map((t) => <li key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{t}</li>)}
          </ul>
        )}
      </article>
      <footer className="mt-10 text-center text-[11px] text-muted-foreground">{org.name} help center</footer>
    </div>
  );
}
