"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Copy, Home, RefreshCw } from "lucide-react";
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
  homeHref = "/home",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  route: string;
  title?: string;
  /** Where "Go home" leads; the root boundary points at "/" (login / public). */
  homeHref?: string;
}) {
  const [errorId, setErrorId] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    window.setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div role="alert" className="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground" aria-hidden>
        <AlertTriangle className="h-7 w-7" />
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="mt-5 text-balance text-xl font-semibold tracking-tight focus-visible:outline-none sm:text-2xl">
        {title}
      </h1>
      <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
        The page hit a problem it couldn&apos;t recover from. It has been logged. Try again, go back to your dashboard, or share the reference below with support.
      </p>

      <dl className="mt-5 w-full rounded-xl border border-border bg-card p-3 text-left text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-xs font-medium text-muted-foreground">Reference</dt>
          <dd className="min-w-0 flex-1 break-all text-right font-mono text-xs" aria-live="polite">
            {reference ?? <span className="text-muted-foreground">Logging…</span>}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center">
        <Button touch onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
        <Button touch variant="outline" asChild>
          <Link href={homeHref}>
            <Home className="h-4 w-4" aria-hidden /> Go home
          </Link>
        </Button>
        <Button touch variant="outline" onClick={() => void copy()} disabled={!reference} aria-label="Copy error reference">
          {copied === "ok" ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied === "ok" ? "Copied" : copied === "fail" ? "Couldn't copy" : "Copy reference"}
        </Button>
      </div>
      <p className="sr-only" role="status">
        {copied === "ok" ? "Error reference copied to the clipboard." : copied === "fail" ? "Copying failed. Select the reference and copy it by hand." : ""}
      </p>
    </div>
  );
}
