"use client";

import { Fragment } from "react";
import { parseMarkdown, type InlineRun } from "@/lib/documents/render";
import { cn } from "@/lib/utils";

/** Renders the same markdown subset the PDF renderer understands — no HTML passthrough, so bodies can never inject markup. */
function Runs({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <Fragment key={i}>{r.bold ? <strong>{r.text}</strong> : r.text}</Fragment>
      ))}
    </>
  );
}

export function MarkdownView({ body, className }: { body: string; className?: string }) {
  const blocks = parseMarkdown(body);
  if (blocks.length === 0) return <p className={cn("text-sm text-muted-foreground", className)}>Nothing to show yet.</p>;
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed", className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading": {
            const cls = b.level === 1 ? "text-xl font-semibold tracking-tight" : b.level === 2 ? "text-base font-semibold" : "text-sm font-semibold uppercase tracking-wide text-muted-foreground";
            return b.level === 1 ? (
              <h2 key={i} className={cls}>
                <Runs runs={b.runs} />
              </h2>
            ) : b.level === 2 ? (
              <h3 key={i} className={cls}>
                <Runs runs={b.runs} />
              </h3>
            ) : (
              <h4 key={i} className={cls}>
                <Runs runs={b.runs} />
              </h4>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                <Runs runs={b.runs} />
              </p>
            );
          case "list":
            return b.ordered ? (
              <ol key={i} className="list-decimal space-y-1 pl-5">
                {b.items.map((runs, j) => (
                  <li key={j}>
                    <Runs runs={runs} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {b.items.map((runs, j) => (
                  <li key={j}>
                    <Runs runs={runs} />
                  </li>
                ))}
              </ul>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className={cn("border-b border-border/60", r === 0 && "bg-secondary/40 font-medium")}>
                        {row.map((cell, c) => (
                          <td key={c} className="px-2 py-1.5 align-top">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={i} className="border-border" />;
        }
      })}
    </div>
  );
}
