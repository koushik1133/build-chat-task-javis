import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicNoticeBySlug } from "@/lib/privacy/notices";
import { renderMarkdown } from "@/lib/privacy/markdown";
import { cn } from "@/lib/utils";

/** Public privacy notice by org slug. Rendering mode: dynamic (per-org content, no auth). */

type Props = { params: Promise<{ org: string }>; searchParams: Promise<{ lang?: string }> };
type Locale = "en" | "es" | "hi";

const LANGS: ReadonlyArray<{ id: Locale; label: string; native: string }> = [
  { id: "en", label: "English", native: "English" },
  { id: "es", label: "Spanish", native: "Español" },
  { id: "hi", label: "Hindi", native: "हिन्दी" },
];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { org } = await params;
  const data = await publicNoticeBySlug(org);
  return { title: data ? `Privacy notice · ${data.org.name}` : "Privacy notice", robots: { index: true, follow: false } };
}

export default async function PublicPrivacyNoticePage({ params, searchParams }: Props) {
  const [{ org }, { lang }] = await Promise.all([params, searchParams]);
  const locale: Locale = lang === "es" || lang === "hi" ? lang : "en";
  const data = await publicNoticeBySlug(org, locale);
  if (!data) notFound();

  const hasContact = Boolean(data.grievance.grievance_officer_name || data.grievance.grievance_officer_email);

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground [overflow-wrap:anywhere]">{data.org.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Privacy notice</h1>
        </div>
        <nav aria-label="Language" className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-xs">
          {LANGS.map((l) => {
            const active = l.id === locale;
            return (
              <a
                key={l.id}
                href={`/p/privacy/${encodeURIComponent(org)}?lang=${l.id}`}
                hrefLang={l.id}
                lang={l.id}
                aria-label={l.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )}
              >
                {l.native}
              </a>
            );
          })}
        </nav>
      </div>
      {data.notice ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Version {data.notice.version} · published {new Date(data.notice.published_at).toLocaleDateString()}
          </p>
          <div
            lang={locale}
            className="mt-6 space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere] [&_a]:underline [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(data.notice.body_md) }}
          />
        </>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {data.org.name} has not published a privacy notice in this language yet. Try another language above, or use the contact details below to ask how your personal data is handled.
        </p>
      )}
      <section className="mt-10 rounded-xl border border-border bg-card p-5 text-sm">
        <h2 className="font-semibold">Your rights and how to exercise them</h2>
        <p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">
          You can ask for a copy of your personal data, have it corrected or erased, nominate someone to act for you, or raise a grievance.
          {hasContact ? (
            <>
              {" "}
              Contact {data.grievance.grievance_officer_name ?? "the grievance officer"}
              {data.grievance.grievance_officer_email && (
                <>
                  {" "}
                  at <a className="underline" href={`mailto:${data.grievance.grievance_officer_email}`}>{data.grievance.grievance_officer_email}</a>
                </>
              )}
              .
            </>
          ) : (
            <> Contact {data.org.name} through the channel you normally use with them and ask for the person responsible for privacy.</>
          )}{" "}
          Requests are answered within {data.grievance.dsr_due_days} days.
        </p>
      </section>
    </article>
  );
}
