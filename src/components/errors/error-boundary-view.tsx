"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared body for the Next.js `error.tsx` boundaries. Reports the error once
 * to /api/errors/report (anonymous-safe, size-capped) and shows the returned
 * id so support can find it in Settings → System health.
 */
export function ErrorBoundaryView({
  error,
  reset,
  route,
  title = "Something went wrong",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  route: string;
  title?: string;
}) {
  const [errorId, setErrorId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/errors/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        message: (error.message || error.name || "Error").slice(0, 2_000),
        stack: error.stack?.slice(0, 4_000),
        route,
        digest: error.digest,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (typeof d?.id === "string") setErrorId(d.id);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [error, route]);

  const reference = errorId ?? error.digest ?? null;

  async function copy() {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div role="alert" className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-700 dark:text-red-300" aria-hidden>
        <AlertTriangle className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The page hit an unexpected error. It has been logged. You can try again, or share the error id with support.
      </p>
      {reference && (
        <p className="mt-3 break-all font-mono text-xs text-muted-foreground" aria-live="polite">
          Error id: {reference}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button touch onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
        <Button touch variant="outline" onClick={() => void copy()} disabled={!reference} aria-label="Copy error id">
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied ? "Copied" : "Copy error id"}
        </Button>
      </div>
    </div>
  );
}
