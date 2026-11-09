import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicNoticeBySlug } from "@/lib/privacy/notices";
import { renderMarkdown } from "@/lib/privacy/markdown";

/** Public privacy notice by org slug. Rendering mode: dynamic (per-org content, no auth). */

type Props = { params: Promise<{ org: string }>; searchParams: Promise<{ lang?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { org } = await params;
  const data = await publicNoticeBySlug(org);
  return { title: data ? `Privacy notice · ${data.org.name}` : "Privacy notice", robots: { index: true, follow: false } };
}

export default async function PublicPrivacyNoticePage({ params, searchParams }: Props) {
  const [{ org }, { lang }] = await Promise.all([params, searchParams]);
  const locale = lang === "es" || lang === "hi" ? lang : "en";
  const data = await publicNoticeBySlug(org, locale);
  if (!data) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{data.org.name}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Privacy notice</h1>
      {data.notice ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Version {data.notice.version} · published {new Date(data.notice.published_at).toLocaleDateString()}
          </p>
          <div className="mt-6 space-y-3 text-sm leading-relaxed [&_a]:underline [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.notice.body_md) }} />
        </>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">This organisation has not published a privacy notice yet.</p>
      )}
      <section className="mt-10 rounded-xl border border-border bg-card p-5 text-sm">
        <h2 className="font-semibold">Your rights and how to exercise them</h2>
        <p className="mt-2 text-muted-foreground">
          You can ask for a copy of your personal data, have it corrected or erased, nominate someone to act for you, or raise a grievance.
          {data.grievance.grievance_officer_name || data.grievance.grievance_officer_email ? (
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
          ) : null}{" "}
          Requests are answered within {data.grievance.dsr_due_days} days.
        </p>
      </section>
    </article>
  );
}
