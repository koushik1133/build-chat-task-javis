"use client";

import { ErrorBoundaryView } from "@/components/errors/error-boundary-view";

/** Root error boundary (public pages, login). */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const route = typeof window !== "undefined" ? window.location.pathname : "/";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <ErrorBoundaryView error={error} reset={reset} route={route} homeHref="/" />
    </main>
  );
}
