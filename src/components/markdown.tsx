"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/feedback";

/**
 * Markdown renderer, code-split. `react-markdown` + `remark-gfm` +
 * `highlight.js/lib/common` weigh well over 100 kB gzipped and are only needed
 * on surfaces that actually show rich text (chat, knowledge, help center,
 * marketplace, strategy). Rendering still happens on the server (no `ssr:false`)
 * so public help articles keep their SEO-visible HTML; the chunk simply loads
 * on demand for the client bundle.
 */
const MarkdownImpl = dynamic(() => import("./markdown-impl"), {
  loading: () => (
    <div role="status" aria-live="polite" className="space-y-2 py-1">
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
      <span className="sr-only">Rendering…</span>
    </div>
  ),
});

export function Markdown({ children }: { children: string }) {
  return <MarkdownImpl>{children}</MarkdownImpl>;
}
