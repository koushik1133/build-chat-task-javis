import Link from "next/link";

/* Rendered outside the reviews layout, so it sets its own surface and text tokens (works in light and dark). */
export default function ReviewsNotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 text-center text-foreground">
      <h1 className="text-xl font-semibold">These reviews are not available</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">The link may be wrong, or the business has not published any reviews.</p>
      <Link href="/" className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Go to home</Link>
    </main>
  );
}
