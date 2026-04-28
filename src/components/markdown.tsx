"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { useEffect, useRef } from "react";

export function Markdown({ children }: { children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll("pre code").forEach((el) => {
      hljs.highlightElement(el as HTMLElement);
    });
  }, [children]);

  return (
    <div
      ref={ref}
      className="prose max-w-none text-sm leading-relaxed
                 [&>*]:my-2 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2
                 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground
                 [&_p]:text-foreground [&_li]:text-foreground [&_strong]:text-foreground
                 [&_blockquote]:text-muted-foreground [&_blockquote]:border-border
                 [&_pre]:my-3 [&_pre]:!bg-transparent [&_pre]:!p-0
                 [&_code]:rounded [&_:not(pre)>code]:bg-secondary
                 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5
                 [&_:not(pre)>code]:text-[0.85em]
                 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4
                 [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1
                 [&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
