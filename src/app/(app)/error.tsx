"use client";

import { ErrorBoundaryView } from "@/components/errors/error-boundary-view";

/** In-app error boundary: keeps the sidebar/layout, replaces only the page body. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const route = typeof window !== "undefined" ? window.location.pathname : "/app";
  return <ErrorBoundaryView error={error} reset={reset} route={route} title="This page could not load" />;
}
