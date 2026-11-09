"use client";

import { useEffect, useState } from "react";
import { FileSignature } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import { Banner, SkeletonList } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import type { PortalDocumentItem } from "@/lib/portal-rules";

interface PortalDoc {
  id: string;
  title: string;
  kind: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  pending_signers: string[];
}

const TONE = { sent: "info", viewed: "info", signed: "success", declined: "danger", expired: "warning" } as const;
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "");

/** Portal "Documents": pending signatures first, then signed. Signing itself happens through the emailed per-signer link. */
export function DocumentsTab({ token, signLinks = [] }: { token: string; signLinks?: PortalDocumentItem[] }) {
  const [docs, setDocs] = useState<PortalDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/p/portal/${token}/documents`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load documents.");
        return (await r.json()) as { documents: PortalDoc[] };
      })
      .then((d) => setDocs(d.documents))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load documents."));
  }, [token]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!docs) return <SkeletonList count={2} itemClassName="h-28 rounded-xl" label="Loading documents…" />;

  const pending = docs.filter((d) => d.status === "sent" || d.status === "viewed");
  const done = docs.filter((d) => d.status !== "sent" && d.status !== "viewed");

  const Item = ({ d }: { d: PortalDoc }) => (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium">{d.title}</div>
        <div className="text-xs text-muted-foreground">
          <span className="capitalize">{d.kind}</span>
          {d.status === "signed" && d.completed_at ? ` · signed ${date(d.completed_at)}` : d.sent_at ? ` · sent ${date(d.sent_at)}` : ""}
          {d.pending_signers.length > 0 && d.status !== "signed" ? ` · waiting on ${d.pending_signers.join(", ")}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {signLinks.find((s) => s.id === d.id)?.signPath && (
          <Button asChild size="sm" touch><a href={signLinks.find((s) => s.id === d.id)?.signPath ?? "#"}>Sign now</a></Button>
        )}
        <Pill tone={TONE[d.status as keyof typeof TONE] ?? "neutral"} className="capitalize">{d.status}</Pill>
      </div>
    </li>
  );

  return (
    <div className="space-y-5">
      <section aria-labelledby="portal-docs-pending" className="rounded-xl border border-border bg-card p-5">
        <h2 id="portal-docs-pending" className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileSignature className="h-4 w-4 text-primary" aria-hidden /> Awaiting signature</h2>
        {pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting for your signature. Signing links arrive by email.</p> : <ul className="divide-y divide-border/60">{pending.map((d) => <Item key={d.id} d={d} />)}</ul>}
      </section>
      <section aria-labelledby="portal-docs-done" className="rounded-xl border border-border bg-card p-5">
        <h2 id="portal-docs-done" className="mb-3 text-sm font-semibold">Completed documents</h2>
        {done.length === 0 ? <p className="text-sm text-muted-foreground">No signed documents yet. Signed copies also appear under Files.</p> : <ul className="divide-y divide-border/60">{done.map((d) => <Item key={d.id} d={d} />)}</ul>}
      </section>
    </div>
  );
}
