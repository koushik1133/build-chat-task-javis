"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, type AttachmentDTO } from "@/lib/attachments/types";

const when = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
const LABEL: Record<string, string> = { contact: "Your account", quote: "Quote", invoice: "Invoice", ticket: "Support ticket", booking: "Appointment", record: "Project", document: "Signed document" };

/** Portal "Files": attachments your provider marked visible to you, across quotes, invoices, tickets, documents… */
export function FilesTab({ token }: { token: string }) {
  const [files, setFiles] = useState<AttachmentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/p/portal/${token}/attachments`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load files.");
        return (await r.json()) as { attachments: AttachmentDTO[] };
      })
      .then((d) => setFiles(d.attachments))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load files."));
  }, [token]);

  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!files) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden /></div>;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Paperclip className="h-4 w-4 text-primary" aria-hidden /> Files shared with you</h2>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files have been shared yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{f.file_name}</div>
                <div className="text-xs text-muted-foreground">{LABEL[f.entity_kind] ?? f.entity_kind} · {formatBytes(f.size_bytes)} · {when(f.created_at)}</div>
              </div>
              <Button asChild variant="outline" size="sm" touch>
                <a href={`/api/p/portal/${token}/attachments?id=${encodeURIComponent(f.id)}`} target="_blank" rel="noopener" aria-label={`Download ${f.file_name}`}>
                  <Download className="h-3.5 w-3.5" aria-hidden /> Download
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
