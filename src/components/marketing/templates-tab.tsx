"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { timeAgo } from "@/lib/utils";
import type { TemplateRow } from "@/lib/marketing/templates";
import { TEMPLATE_CATEGORIES } from "@/lib/marketing/types";
import { ContentEditor, ContentPreview, jsonFetch, type ContentValue, type Notice } from "./shared";

export function TemplatesTab({ notify }: { notify: (tone: Notice["tone"], text: string) => void }) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TemplateRow | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await jsonFetch<{ templates: TemplateRow[] }>("/api/marketing/templates", undefined, "Could not load templates")).templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load templates");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(t: TemplateRow) {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await jsonFetch(`/api/marketing/templates/${t.id}`, { method: "DELETE" }, "Could not delete");
      notify("success", "Template deleted.");
      void load();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not delete");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Reusable content with merge fields. Pick one in the campaign wizard or in a sequence step.</p>
        <Button type="button" touch onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> New template
        </Button>
      </div>
      {loading ? (
        <SkeletonList count={3} label="Loading templates…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <Empty icon={<FileText className="h-5 w-5" />} title="No templates yet" text="Write once, reuse in campaigns and sequences." action={<Button type="button" touch onClick={() => setEditing("new")}>Create a template</Button>} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Templates">
          {rows.map((t) => (
            <li key={t.id} className="rounded-lg border border-border bg-card p-3 sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.subject || "(no subject)"}</p>
                </div>
                <Pill tone="neutral">{t.category}</Pill>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{t.body_md}</p>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Updated {timeAgo(t.updated_at)}</span>
                <span className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Delete ${t.name}`} onClick={() => remove(t)} className="text-red-600">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <TemplateDialog
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify("success", msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: TemplateRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState<string>(template?.category ?? "general");
  const [content, setContent] = useState<ContentValue>({ subject: template?.subject ?? "", preheader: template?.preheader ?? "", body_md: template?.body_md ?? "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const channel = category === "sms" ? "sms" : "email";

  async function save() {
    if (!name.trim()) return setErr("Name the template.");
    if (!content.body_md.trim()) return setErr("Write the body.");
    setBusy(true);
    setErr(null);
    const payload = { name: name.trim(), subject: content.subject, preheader: content.preheader || null, body_md: content.body_md, category };
    try {
      if (template) await jsonFetch(`/api/marketing/templates/${template.id}`, { method: "PATCH", body: JSON.stringify(payload) }, "Could not save");
      else await jsonFetch("/api/marketing/templates", { method: "POST", body: JSON.stringify(payload) }, "Could not save");
      onSaved(template ? "Template updated." : "Template created.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={template ? "Edit template" : "New template"} onClose={onClose} size="xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} autoFocus />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ContentEditor value={content} onChange={setContent} channel={channel} compact />
          <div>
            <p className="mb-1 text-xs font-medium">Preview (sample contact)</p>
            <ContentPreview value={content} channel={channel} />
          </div>
        </div>
        {err && (
          <p role="alert" className="text-sm text-red-600">
            {err}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save template
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
