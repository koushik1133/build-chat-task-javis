"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileIcon, FileImage, FileSpreadsheet, FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Banner, Empty, Skeleton } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { ATTACHMENT_ACCEPT, formatBytes, validateAttachmentMeta, type AttachmentDTO, type AttachmentEntityKind } from "@/lib/attachments/types";

/**
 * Files on any entity: list, drag-and-drop / picker upload with progress,
 * delete with confirmation. Mount anywhere with the entity kind + id.
 */
export interface AttachmentPanelProps {
  entityKind: AttachmentEntityKind;
  entityId: string;
  /** Hide upload + delete for read-only roles. */
  canEdit?: boolean;
  /** Show the "visible in client portal" toggle (entities a contact can see). */
  allowPortal?: boolean;
  compact?: boolean;
  className?: string;
  /** Called after the list changes (count badge etc). */
  onChange?: (files: AttachmentDTO[]) => void;
}

interface UploadState {
  name: string;
  progress: number;
  error: string | null;
}

function iconFor(type: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type.includes("spreadsheet") || type === "text/csv") return FileSpreadsheet;
  if (type === "application/pdf" || type.includes("word") || type === "text/plain") return FileText;
  return FileIcon;
}

const when = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** XHR so we can report upload progress (fetch has no upload progress events). */
function uploadWithProgress(form: FormData, onProgress: (pct: number) => void): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

export function AttachmentPanel({ entityKind, entityId, canEdit = true, allowPortal = false, compact = false, className, onChange }: AttachmentPanelProps) {
  const [files, setFiles] = useState<AttachmentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [portal, setPortal] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `attach-${entityKind}-${entityId}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/attachments?entity_kind=${encodeURIComponent(entityKind)}&entity_id=${encodeURIComponent(entityId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { attachments?: AttachmentDTO[]; error?: string } | null;
      if (!res.ok) throw new Error(data?.error === "forbidden" ? "You do not have access to these files." : "Could not load files.");
      const list = data?.attachments ?? [];
      setFiles(list);
      onChange?.(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load files.");
      setFiles([]);
    }
  }, [entityKind, entityId, onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(list: FileList | File[]) {
    const picked = Array.from(list);
    if (picked.length === 0) return;
    for (const file of picked) {
      const problem = validateAttachmentMeta(file);
      const state: UploadState = { name: file.name, progress: 0, error: problem };
      setUploads((u) => [...u, state]);
      if (problem) continue;
      const form = new FormData();
      form.set("file", file);
      form.set("entity_kind", entityKind);
      form.set("entity_id", entityId);
      form.set("visibility", portal ? "portal" : "internal");
      try {
        const res = await uploadWithProgress(form, (pct) => setUploads((u) => u.map((x) => (x === state || x.name === state.name ? { ...x, progress: pct } : x))));
        if (res.status >= 400) {
          const body = res.body as { detail?: unknown; error?: string } | null;
          const detail = typeof body?.detail === "string" ? body.detail : body?.error === "payload_too_large" ? "File must be 20 MB or smaller" : "Upload failed";
          setUploads((u) => u.map((x) => (x.name === state.name ? { ...x, error: detail } : x)));
          continue;
        }
        setUploads((u) => u.filter((x) => x.name !== state.name));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.name === state.name ? { ...x, error: err instanceof Error ? err.message : "Upload failed" } : x)));
      }
    }
    await load();
  }

  async function remove(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete the file.");
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the file.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section aria-label="Files" className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Paperclip className="h-4 w-4 text-muted-foreground" aria-hidden /> Files
          {files && files.length > 0 && <Pill tone="neutral">{files.length}</Pill>}
        </h3>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {allowPortal && (
              <Checkbox checked={portal} onChange={(e) => setPortal(e.target.checked)} label={<span className="text-xs">Visible in client portal</span>} />
            )}
            <Button type="button" size="sm" variant="outline" touch onClick={() => inputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" aria-hidden /> Upload
            </Button>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="sr-only"
              aria-label="Choose files to upload"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {canEdit && !compact && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop files here or press Enter to choose files"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            dragging ? "border-primary bg-primary/5 text-foreground" : "border-border hover:border-primary/60"
          )}
        >
          <Upload className="h-4 w-4" aria-hidden /> Drop files here or click to browse · PDF, Word, Excel, CSV, text, images · up to 20 MB
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="space-y-1.5" aria-live="polite">
          {uploads.map((u, i) => (
            <li key={`${u.name}-${i}`} className="rounded-md border border-border px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{u.name}</span>
                {u.error ? (
                  <button type="button" className="text-muted-foreground underline" onClick={() => setUploads((x) => x.filter((_, j) => j !== i))}>
                    Dismiss
                  </button>
                ) : (
                  <span className="tabular-nums text-muted-foreground">{u.progress}%</span>
                )}
              </div>
              {u.error ? (
                <p className="mt-1 text-destructive">{u.error}</p>
              ) : (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-secondary" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.name}`}>
                  <div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${u.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {files === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : files.length === 0 ? (
        <Empty icon={<Paperclip className="h-5 w-5" aria-hidden />} title="No files yet" text={canEdit ? "Upload contracts, photos, spreadsheets or anything else related to this record." : undefined} className="py-6" />
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border">
          {files.map((f) => {
            const Icon = iconFor(f.content_type);
            return (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{f.file_name}</span>
                    {f.visibility === "portal" && <Pill tone="info">Portal</Pill>}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(f.size_bytes)} · <time dateTime={f.created_at}>{when(f.created_at)}</time>
                  </p>
                </div>
                <Button asChild size="icon-sm" variant="ghost" touch title="Download">
                  <a href={`/api/attachments/${f.id}`} target="_blank" rel="noopener" aria-label={`Download ${f.file_name}`}>
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </Button>
                {canEdit &&
                  (confirmId === f.id ? (
                    <span className="flex items-center gap-1 text-xs">
                      <Button type="button" size="sm" variant="destructive" touch disabled={deleting === f.id} onClick={() => void remove(f.id)}>
                        {deleting === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : "Delete"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" touch onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" size="icon-sm" variant="ghost" touch aria-label={`Delete ${f.file_name}`} title="Delete" onClick={() => setConfirmId(f.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
