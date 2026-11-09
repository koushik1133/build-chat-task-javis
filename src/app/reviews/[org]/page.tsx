import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Star } from "lucide-react";
import { publicTestimonials } from "@/lib/engagement/reviews";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ org: string }> }): Promise<Metadata> {
  const { org } = await params;
  const data = await publicTestimonials(org).catch(() => null);
  return { title: data ? `What customers say about ${data.org_name}` : "Reviews", description: data ? `Real feedback from ${data.org_name} customers.` : undefined, robots: { index: true, follow: true } };
}

function Stars({ rating }: { rating: number }) {
  return (
    <span role="img" aria-label={`${rating} out of 5 stars`} className="inline-flex text-amber-500">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`h-4 w-4 ${n <= rating ? "fill-current" : "opacity-30"}`} aria-hidden />
      ))}
    </span>
  );
}

export default async function ReviewsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const data = await publicTestimonials(org).catch(() => null);
  if (!data) notFound();
  const ld = data.items.length
    ? { "@context": "https://schema.org", "@type": "Organization", name: data.org_name, ...(data.average !== null ? { aggregateRating: { "@type": "AggregateRating", ratingValue: data.average, reviewCount: data.items.filter((i) => i.rating !== null).length, bestRating: 5 } } : {}), review: data.items.slice(0, 20).map((i) => ({ "@type": "Review", reviewBody: i.quote, author: { "@type": "Person", name: i.author_name }, ...(i.rating !== null ? { reviewRating: { "@type": "Rating", ratingValue: i.rating, bestRating: 5 } } : {}) })) }
    : null;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">What customers say about {data.org_name}</h1>
      {data.average !== null && (
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Stars rating={Math.round(data.average)} /> {data.average} average
        </p>
      )}
      {data.items.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No reviews have been published yet.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.items.map((t, i) => (
            <li key={i} className="rounded-xl border border-border bg-card p-4 sm:p-5">
              {t.rating !== null && <Stars rating={t.rating} />}
              <blockquote className="mt-2 whitespace-pre-line text-base">{t.quote}</blockquote>
              <p className="mt-2 text-sm text-muted-foreground">{t.author_name}</p>
            </li>
          ))}
        </ul>
      )}
      {ld && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} />}
    </>
  );
}
