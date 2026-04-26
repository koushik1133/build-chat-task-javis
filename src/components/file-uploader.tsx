"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, UploadCloud, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/utils";

type FileRow = {
  id: string;
  name: string;
  mime: string | null;
  size_bytes: number;
  chunk_count: number;
  created_at: string;
};

export function FileUploader() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const r = await fetch("/api/files").then((r) => r.json());
    setFiles(r.files ?? []);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function upload(f: File) {
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/files", { method: "POST", body: fd });
    setUploading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    refresh();
  }

  async function remove(id: string) {
    await fetch("/api/files", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) upload(f);
        }}
        className="card-glow flex flex-col items-center justify-center rounded-xl p-10 text-center"
      >
        <UploadCloud className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm">Drop a file here, or pick one to upload.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          PDF, Markdown, code, or plain text. Max 15&nbsp;MB.
        </p>
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Choose file"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Your files</h2>
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No files yet. Upload one to enable RAG over its contents.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{f.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {f.chunk_count} chunks · {(f.size_bytes / 1024).toFixed(1)} KB · {timeAgo(f.created_at)}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(f.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
