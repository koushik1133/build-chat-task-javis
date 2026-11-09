"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Download, Eye, FileSignature, FileText, Loader2, Pencil, Plus, RefreshCw, Send, Sparkles, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill, StatusPill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { LoadMore } from "@/components/ui/load-more";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { MarkdownView } from "@/components/documents/markdown-view";
import { AttachmentPanel } from "@/components/attachments/attachment-panel";
import { extractMergeKeys } from "@/lib/documents/render";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_TONE,
  STANDARD_MERGE_FIELDS,
  type DocumentDTO,
  type DocumentKind,
  type DocumentStatus,
  type DocumentTemplateDTO,
  type MergeField,
  type SigningOrder,
} from "@/lib/documents/types";

/* ─── helpers ────────────────────────────────────────────────────────────── */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const fieldErr = data?.detail?.fieldErrors ? Object.entries(data.detail.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`)[0] : null;
    throw new Error(data?.detail?.formErrors?.[0] ?? fieldErr ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const date = (iso: string | null) => (iso ? fmt.format(new Date(iso)) : "—");
const SIGNER_TONE = { pending: "neutral", viewed: "info", signed: "success", declined: "danger" } as const;

interface Contact {
  id: string;
  full_name: string;
  email: string | null;
}
interface Starter {
  slug: string;
  name: string;
  kind: DocumentKind;
  description: string;
  installed: boolean;
}
interface SignerDraft {
  name: string;
  email: string;
  role: string;
}
type Tab = "documents" | "templates";
type Notice = { tone: "success" | "error" | "info"; text: string };

/* ─── page ───────────────────────────────────────────────────────────────── */

export default function DocumentsPage() {
  const [tab, setTab] = useState<Tab>("documents");
  const [docs, setDocs] = useState<DocumentDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DocumentTemplateDTO[]>([]);
  const [starters, setStarters] = useState<Starter[]>([]);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [status, setStatus] = useState<DocumentStatus | "">("");
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 250);
  const [creating, setCreating] = useState(false);
  const [sendFor, setSendFor] = useState<DocumentDTO | null>(null);
  const [preview, setPreview] = useState<DocumentDTO | null>(null);
  const [editTemplate, setEditTemplate] = useState<DocumentTemplateDTO | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; description: string; label: string; run: () => void } | null>(null);
  const nextSignal = useAbortable();

  const loadDocs = useCallback(
    async (cursor: string | null = null) => {
      const signal = nextSignal();
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (dq.trim()) params.set("q", dq.trim());
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/documents?${params}`, { cache: "no-store", signal });
        const data = (await res.json().catch(() => null)) as { documents?: DocumentDTO[]; next_cursor?: string | null; canEdit?: boolean; error?: string } | null;
        if (!res.ok) throw new Error(data?.error === "forbidden" ? "Your role cannot view documents." : "Could not load documents.");
        setDocs((prev) => (cursor ? [...prev, ...(data?.documents ?? [])] : (data?.documents ?? [])));
        setNextCursor(data?.next_cursor ?? null);
        if (typeof data?.canEdit === "boolean") setCanEdit(data.canEdit);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : "Could not load documents.");
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [status, dq, nextSignal]
  );

  const loadTemplates = useCallback(async () => {
    try {
      const data = await api<{ templates: DocumentTemplateDTO[]; starters: Starter[]; canEdit: boolean }>("/api/document-templates");
      setTemplates(data.templates);
      setStarters(data.starters);
      setCanEdit(data.canEdit);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not load templates." });
    }
  }, []);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);
  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  async function act(id: string, fn: () => Promise<string>) {
    setBusyId(id);
    setNotice(null);
    try {
      const text = await fn();
      setNotice({ tone: "success", text });
      await loadDocs();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusyId(null);
    }
  }

  async function installStarters() {
    setBusyId("starters");
    try {
      const out = await api<{ installed: DocumentTemplateDTO[]; skipped: string[] }>("/api/document-templates", { method: "POST", body: JSON.stringify({ install: "starters" }) });
      setNotice({ tone: "success", text: `Installed ${out.installed.length} starter template${out.installed.length === 1 ? "" : "s"}${out.skipped.length ? ` (${out.skipped.length} already present)` : ""}.` });
      await loadTemplates();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Install failed" });
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    const pending = docs.filter((d) => d.status === "sent" || d.status === "viewed").length;
    return { pending };
  }, [docs]);

  return (
    <PageContainer
      eyebrow="Engage"
      title="Documents"
      description="Contracts, proposals, NDAs and forms — drafted from templates, sent for e-signature, filed automatically."
      icon={<FileSignature className="h-5 w-5" aria-hidden />}
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void (tab === "documents" ? loadDocs() : loadTemplates())} disabled={loading} aria-label="Refresh">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin motion-reduce:animate-none" : "h-4 w-4"} aria-hidden />
          </Button>
          {canEdit && tab === "documents" && (
            <Button touch onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New document
            </Button>
          )}
          {canEdit && tab === "templates" && (
            <Button touch onClick={() => setEditTemplate("new")}>
              <Plus className="h-4 w-4" aria-hidden /> New template
            </Button>
          )}
        </>
      }
    >
      <Tabs
        id="documents-tabs"
        label="Documents sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "documents", label: "Documents", count: counts.pending || undefined },
          { id: "templates", label: "Templates", count: templates.length || undefined },
        ]}
        className="mb-4"
      />

      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">
          {notice.text}
        </Banner>
      )}

      <TabPanel id="documents-tabs" value="documents">
        {tab === "documents" && (
          <>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchField value={q} onChange={setQ} label="Search documents" placeholder="Search by title…" className="sm:max-w-xs" />
              <label className="sr-only" htmlFor="doc-status">
                Filter by status
              </label>
              <Select id="doc-status" value={status} onChange={(e) => setStatus(e.target.value as DocumentStatus | "")} className="capitalize sm:w-44">
                <option value="">All statuses</option>
                {DOCUMENT_STATUSES.map((s) => (
                  <option key={s} value={s} className="capitalize">
                    {s}
                  </option>
                ))}
              </Select>
            </div>
            {loading ? (
              <SkeletonList count={5} itemClassName="h-14" label="Loading documents…" />
            ) : error ? (
              <ErrorState message={error} onRetry={() => void loadDocs()} />
            ) : docs.length === 0 ? (
              <Empty
                icon={<FileText className="h-6 w-6" aria-hidden />}
                title={status || q ? "No documents match" : "No documents yet"}
                text={status || q ? "Try a different status or search." : "Create a document from a template, send it for signature and the signed PDF files itself on the contact."}
                action={canEdit && !status && !q ? <Button touch onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New document</Button> : undefined}
              />
            ) : (
              <>
                <TableScroller label="Documents">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className={THEAD}>
                      <tr>
                        <th scope="col" className={TH}>Title</th>
                        <th scope="col" className={TH}>Contact</th>
                        <th scope="col" className={TH}>Status</th>
                        <th scope="col" className={TH}>Signers</th>
                        <th scope="col" className={TH}>Sent</th>
                        <th scope="col" className={`${TH} text-right`}><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {docs.map((d) => (
                        <tr key={d.id} className="align-top">
                          <td className="px-3 py-2">
                            <button type="button" className="rounded text-start font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPreview(d)} aria-label={`Preview ${d.title}`}>
                              {d.title}
                            </button>
                            <div className="text-[11px] capitalize text-muted-foreground">{d.kind}{d.signing_order === "sequential" ? " · in order" : ""}</div>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{d.contact_name ?? "—"}</td>
                          <td className="px-3 py-2">
                            <StatusPill status={d.status} map={DOCUMENT_STATUS_TONE} />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {d.signers.length === 0 ? <span className="text-xs text-muted-foreground">none</span> : d.signers.map((s) => (
                                <Pill key={s.id} tone={SIGNER_TONE[s.status]} title={`${s.email} · ${s.status}`}>
                                  {s.name}
                                </Pill>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{date(d.sent_at)}{d.expires_at && (d.status === "sent" || d.status === "viewed") ? <div className="text-[11px]">due {date(d.expires_at)}</div> : null}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button size="sm" variant="outline" touch onClick={() => setPreview(d)} aria-label={`Preview ${d.title}`}>
                                <Eye className="h-3.5 w-3.5" aria-hidden /> View
                              </Button>
                              <Button asChild size="sm" variant="outline" touch>
                                <a href={`/api/documents/${d.id}/pdf`} target="_blank" rel="noopener" aria-label={`Download PDF for ${d.title}`}>
                                  <Download className="h-3.5 w-3.5" aria-hidden /> PDF
                                </a>
                              </Button>
                              {canEdit && ["draft", "sent", "viewed"].includes(d.status) && (
                                <Button size="sm" variant="outline" touch disabled={busyId === d.id} onClick={() => setSendFor(d)} aria-label={`Send ${d.title}`}>
                                  <Send className="h-3.5 w-3.5" aria-hidden /> {d.status === "draft" ? "Send" : "Resend"}
                                </Button>
                              )}
                              {canEdit && (d.status === "sent" || d.status === "viewed") && (
                                <Button size="sm" variant="ghost" touch disabled={busyId === d.id} aria-label={`Void ${d.title}`} onClick={() => setConfirmAction({ title: `Void “${d.title}”?`, description: "Signing links stop working and signers are told the document was withdrawn. This cannot be undone.", label: "Void document", run: () => void act(d.id, async () => { await api(`/api/documents/${d.id}/void`, { method: "POST", body: "{}" }); return "Document voided."; }) })}>
                                  <Ban className="h-3.5 w-3.5" aria-hidden /> Void
                                </Button>
                              )}
                              {canEdit && (d.status === "draft" || d.status === "void") && (
                                <Button size="sm" variant="ghost" touch disabled={busyId === d.id} aria-label={`Delete ${d.title}`} onClick={() => setConfirmAction({ title: `Delete “${d.title}”?`, description: "The draft and its attachments are removed. This cannot be undone.", label: "Delete document", run: () => void act(d.id, async () => { await api(`/api/documents/${d.id}`, { method: "DELETE" }); return "Document deleted."; }) })}>
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
                <LoadMore hasMore={Boolean(nextCursor)} loading={loadingMore} count={docs.length} noun="documents" onMore={() => loadDocs(nextCursor)} />
              </>
            )}
          </>
        )}
      </TabPanel>

      <TabPanel id="documents-tabs" value="templates">
        {tab === "templates" && (
          <TemplatesTab
            templates={templates}
            starters={starters}
            canEdit={canEdit}
            busy={busyId === "starters"}
            onInstall={() => void installStarters()}
            onEdit={(t) => setEditTemplate(t)}
            onDelete={(t) =>
              setConfirmAction({
                title: `Delete template “${t.name}”?`,
                description: "Existing documents keep their rendered body. This cannot be undone.",
                label: "Delete template",
                run: () => {
                  void (async () => {
                    try {
                      await api(`/api/document-templates/${t.id}`, { method: "DELETE" });
                      setNotice({ tone: "success", text: `Template “${t.name}” deleted.` });
                      await loadTemplates();
                    } catch (err) {
                      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Delete failed" });
                    }
                  })();
                },
              })
            }
          />
        )}
      </TabPanel>

      {creating && (
        <CreateDocumentDialog
          templates={templates}
          onClose={() => setCreating(false)}
          onCreated={(d) => {
            setCreating(false);
            setNotice({ tone: "success", text: `Draft "${d.title}" created.` });
            void loadDocs();
            setSendFor(d);
          }}
        />
      )}
      {sendFor && (
        <SendDialog
          doc={sendFor}
          onClose={() => setSendFor(null)}
          onSent={(text) => {
            setSendFor(null);
            setNotice({ tone: "success", text });
            void loadDocs();
          }}
        />
      )}
      {preview && <PreviewDialog doc={preview} canEdit={canEdit} onClose={() => setPreview(null)} />}
      {confirmAction && (
        <Dialog title={confirmAction.title} description={confirmAction.description} onClose={() => setConfirmAction(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button type="button" variant="destructive" touch onClick={() => { const run = confirmAction.run; setConfirmAction(null); run(); }}>{confirmAction.label}</Button>
          </DialogFooter>
        </Dialog>
      )}
      {editTemplate && (
        <TemplateEditorDialog
          template={editTemplate === "new" ? null : editTemplate}
          onClose={() => setEditTemplate(null)}
          onSaved={() => {
            setEditTemplate(null);
            void loadTemplates();
          }}
        />
      )}
    </PageContainer>
  );
}

/* ─── templates tab ──────────────────────────────────────────────────────── */

function TemplatesTab({ templates, starters, canEdit, busy, onInstall, onEdit, onDelete }: {
  templates: DocumentTemplateDTO[];
  starters: Starter[];
  canEdit: boolean;
  busy: boolean;
  onInstall: () => void;
  onEdit: (t: DocumentTemplateDTO) => void;
  onDelete: (t: DocumentTemplateDTO) => void;
}) {
  const missing = starters.filter((s) => !s.installed);
  return (
    <div className="space-y-4">
      {missing.length > 0 && canEdit && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Starter templates</p>
            <p className="text-xs text-muted-foreground">{missing.map((s) => s.name).join(" · ")}</p>
          </div>
          <Button size="sm" touch disabled={busy} onClick={onInstall}>
            {busy ? spinner : <Plus className="h-3.5 w-3.5" aria-hidden />} Install {missing.length === starters.length ? "all" : `${missing.length} more`}
          </Button>
        </div>
      )}
      {templates.length === 0 ? (
        <Empty
          icon={<FileText className="h-6 w-6" aria-hidden />}
          title="No templates yet"
          text="Install the starters or write your own markdown template with {{merge.fields}}."
          action={canEdit && starters.length > 0 ? <Button touch disabled={busy} onClick={onInstall}>{busy ? spinner : <Plus className="h-4 w-4" aria-hidden />} Install starter templates</Button> : undefined}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">{t.name}</h3>
                  <p className="text-xs capitalize text-muted-foreground">{t.kind} · v{t.version}{t.requires_signature ? " · signature" : ""}</p>
                </div>
                {t.starter_slug && <Pill tone="violet">Starter</Pill>}
              </div>
              <p className="mt-2 line-clamp-3 flex-1 text-xs text-muted-foreground">{t.body_md.replace(/[#*|]/g, "").slice(0, 200)}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">{t.fields.length} merge field{t.fields.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex gap-1">
                <Button size="sm" variant="outline" touch onClick={() => onEdit(t)} aria-label={`${canEdit ? "Edit" : "View"} ${t.name}`}>
                  {canEdit ? <Pencil className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />} {canEdit ? "Edit" : "View"}
                </Button>
                {canEdit && (
                  <Button size="sm" variant="ghost" touch onClick={() => onDelete(t)} aria-label={`Delete ${t.name}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── contact picker ─────────────────────────────────────────────────────── */

function ContactPicker({ value, onChange }: { value: Contact | null; onChange: (c: Contact | null) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 200);
  const [results, setResults] = useState<Contact[]>([]);
  useEffect(() => {
    if (!dq.trim()) {
      setResults([]);
      return;
    }
    let live = true;
    fetch(`/api/crm/contacts?q=${encodeURIComponent(dq.trim())}&limit=8`)
      .then((r) => r.json())
      .then((d: { contacts?: Contact[] }) => live && setResults(d.contacts ?? []))
      .catch(() => live && setResults([]));
    return () => {
      live = false;
    };
  }, [dq]);
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.full_name}</span> {value.email && <span className="text-muted-foreground">· {value.email}</span>}
        </span>
        <Button type="button" size="sm" variant="ghost" touch onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts by name or email…" aria-label="Search contacts" />
      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-card p-1 text-sm shadow-md" role="listbox" aria-label="Matching contacts">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={false} className="flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0" onClick={() => { onChange(c); setQ(""); setResults([]); }}>
                <span className="min-w-0 truncate">{c.full_name}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{c.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── create dialog ──────────────────────────────────────────────────────── */

function CreateDocumentDialog({ templates, onClose, onCreated }: { templates: DocumentTemplateDTO[]; onClose: () => void; onCreated: (d: DocumentDTO) => void }) {
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? "");
  const template = templates.find((t) => t.id === templateId) ?? null;
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocumentKind>("contract");
  const [contact, setContact] = useState<Contact | null>(null);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [instructions, setInstructions] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/documents/merge-defaults${contact ? `?contact_id=${encodeURIComponent(contact.id)}` : ""}`)
      .then((r) => r.json())
      .then((d: { defaults?: Record<string, string> }) => live && setDefaults(d.defaults ?? {}))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [contact]);

  const fields: MergeField[] = useMemo(() => {
    if (template) return template.fields;
    return extractMergeKeys(body).map((key) => STANDARD_MERGE_FIELDS.find((f) => f.key === key) ?? { key, label: key.replace(/[._]/g, " "), source: "custom" as const });
  }, [template, body]);

  const valueFor = (f: MergeField) => custom[f.key] ?? defaults[f.key] ?? "";

  async function draft() {
    if (!instructions.trim()) {
      setError("Describe what the document should say first.");
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const out = await api<{ body_md: string }>("/api/documents/draft", { method: "POST", body: JSON.stringify({ kind, instructions: instructions.trim(), contact_id: contact?.id ?? null, template_id: template?.id ?? null }) });
      setBody(out.body_md);
      setTemplateId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drafting failed");
    } finally {
      setDrafting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const merge: Record<string, string> = {};
      for (const f of fields) merge[f.key] = valueFor(f);
      const out = await api<{ document: DocumentDTO }>("/api/documents", {
        method: "POST",
        body: JSON.stringify({
          template_id: template?.id ?? null,
          title: title.trim() || null,
          kind: template ? null : kind,
          body_md: template ? null : body,
          merge_data: merge,
          contact_id: contact?.id ?? null,
          signers: contact?.email ? [{ name: contact.full_name, email: contact.email, role: template?.signer_roles[0] ?? "client" }] : null,
        }),
      });
      onCreated(out.document);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the document");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="New document" description="Pick a template and fill the merge fields, or let AI draft a body from your instructions." onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Template" hint={templates.length === 0 ? "No templates yet — install the starters under Templates, or write a body below." : undefined}>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Blank / AI draft</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" hint="Defaults to the template name">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={template?.name ?? "e.g. Service agreement — Acme"} />
          </Field>
        </div>
        <Field label="Contact" hint="Fills contact.* fields and becomes the first signer">
          <ContactPicker value={contact} onChange={setContact} />
        </Field>

        {!template && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
                  {DOCUMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tell the AI what this document should say" hint="Scope, price, dates, special clauses…">
                <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} />
              </Field>
            </div>
            <Button type="button" size="sm" variant="outline" touch disabled={drafting} onClick={() => void draft()}>
              {drafting ? spinner : <Sparkles className="h-3.5 w-3.5" aria-hidden />} Draft with AI
            </Button>
            <Field label="Body (markdown)" hint="Use {{contact.full_name}}, {{org.name}} or your own {{keys}}">
              <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>
        )}

        {fields.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Merge fields</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <Field key={f.key} label={f.label} required={f.required} hint={f.source !== "custom" ? `{{${f.key}}} · prefilled from ${f.source}` : `{{${f.key}}}`}>
                  {f.key.endsWith("description") || f.key === "approach" || f.key === "problem" || f.key === "activity" || f.key === "risks" || f.key.includes("scope") ? (
                    <Textarea rows={3} value={valueFor(f)} onChange={(e) => setCustom((c) => ({ ...c, [f.key]: e.target.value }))} />
                  ) : (
                    <Input value={valueFor(f)} onChange={(e) => setCustom((c) => ({ ...c, [f.key]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </div>
          </fieldset>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || (!template && !body.trim())}>
            {saving ? spinner : <FileText className="h-4 w-4" aria-hidden />} Create draft
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ─── send dialog ────────────────────────────────────────────────────────── */

function SendDialog({ doc, onClose, onSent }: { doc: DocumentDTO; onClose: () => void; onSent: (text: string) => void }) {
  const [signers, setSigners] = useState<SignerDraft[]>(doc.signers.length ? doc.signers.map((s) => ({ name: s.name, email: s.email, role: s.role ?? "" })) : [{ name: doc.contact_name ?? "", email: "", role: "client" }]);
  const [order, setOrder] = useState<SigningOrder>(doc.signing_order);
  const [message, setMessage] = useState("");
  const [days, setDays] = useState("30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = doc.status !== "draft";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!locked) {
        await api(`/api/documents/${doc.id}`, {
          method: "PATCH",
          body: JSON.stringify({ signing_order: order, signers: signers.filter((s) => s.name.trim() && s.email.trim()).map((s) => ({ name: s.name.trim(), email: s.email.trim(), role: s.role.trim() || null })) }),
        });
      }
      const out = await api<{ notified: Array<{ email: string }> }>(`/api/documents/${doc.id}/send`, { method: "POST", body: JSON.stringify({ message: message.trim() || null, expires_in_days: locked ? null : Number(days) || null }) });
      onSent(out.notified.length ? `Sent to ${out.notified.map((n) => n.email).join(", ")}.` : "Document sent; waiting on the signing order.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`Send "${doc.title}" for signature`} description={locked ? "The body is frozen; this re-emails the signers whose turn it is." : "Each signer gets a private link bound to their email and verifies with a one-time code."} onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <fieldset className="space-y-2" disabled={locked}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signers</legend>
          {signers.map((s, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_auto] sm:items-center sm:border-0 sm:p-0" role="group" aria-label={`Signer ${i + 1}`}>
              <Input value={s.name} onChange={(e) => setSigners((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} placeholder="Name" aria-label={`Signer ${i + 1} name`} required />
              <Input type="email" value={s.email} onChange={(e) => setSigners((x) => x.map((y, j) => (j === i ? { ...y, email: e.target.value } : y)))} placeholder="email@example.com" aria-label={`Signer ${i + 1} email`} required />
              <Input value={s.role} onChange={(e) => setSigners((x) => x.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))} placeholder="Role" aria-label={`Signer ${i + 1} role`} />
              <Button type="button" size="icon-sm" variant="ghost" touch aria-label={`Remove signer ${i + 1}`} disabled={signers.length === 1} onClick={() => setSigners((x) => x.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          {!locked && signers.length < 10 && (
            <Button type="button" size="sm" variant="outline" touch onClick={() => setSigners((x) => [...x, { name: "", email: "", role: "" }])}>
              <Users className="h-3.5 w-3.5" aria-hidden /> Add signer
            </Button>
          )}
        </fieldset>
        {!locked && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Signing order">
              <Select value={order} onChange={(e) => setOrder(e.target.value as SigningOrder)}>
                <option value="parallel">Everyone at once</option>
                <option value="sequential">In order (one after another)</option>
              </Select>
            </Field>
            <Field label="Sign within (days)">
              <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Message (optional)">
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} placeholder="Hi — here is the agreement we discussed." />
        </Field>
        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving ? spinner : <Send className="h-4 w-4" aria-hidden />} {locked ? "Resend" : "Send for signature"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ─── preview dialog ─────────────────────────────────────────────────────── */

function PreviewDialog({ doc, canEdit, onClose }: { doc: DocumentDTO; canEdit: boolean; onClose: () => void }) {
  return (
    <Dialog title={doc.title} description={<span className="capitalize">{doc.kind} · {doc.status}{doc.pdf_hash ? ` · fingerprint ${doc.pdf_hash.slice(0, 16)}…` : ""}</span>} onClose={onClose} size="lg">
      <div className="space-y-5">
        <div className="max-h-[50dvh] overflow-y-auto rounded-lg border border-border bg-card p-4" tabIndex={0} aria-label="Document body">
          <MarkdownView body={doc.body_md} />
        </div>
        {doc.signers.length > 0 && (
          <section aria-label="Signers">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signers</h3>
            <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
              {doc.signers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">· {s.email}{s.role ? ` · ${s.role}` : ""}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {s.signed_at && <span>{date(s.signed_at)}</span>}
                    <Pill tone={SIGNER_TONE[s.status]}>{s.status}</Pill>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <AttachmentPanel entityKind="document" entityId={doc.id} canEdit={canEdit} compact allowPortal />
        <DialogFooter>
          <Button asChild variant="outline" touch>
            <a href={`/api/documents/${doc.id}/pdf`} target="_blank" rel="noopener">
              <Download className="h-4 w-4" aria-hidden /> {doc.status === "signed" ? "Signed PDF" : "PDF"}
            </a>
          </Button>
          <Button type="button" touch onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

/* ─── template editor ────────────────────────────────────────────────────── */

function TemplateEditorDialog({ template, onClose, onSaved }: { template: DocumentTemplateDTO | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [kind, setKind] = useState<DocumentKind>(template?.kind ?? "contract");
  const [body, setBody] = useState(template?.body_md ?? "# Title\n\nThis agreement is between **{{org.name}}** and **{{contact.full_name}}**.\n\n## Terms\n\n- First term\n- Second term\n");
  const [fields, setFields] = useState<MergeField[]>(template?.fields ?? []);
  const [requires, setRequires] = useState(template?.requires_signature ?? true);
  const [roles, setRoles] = useState((template?.signer_roles ?? ["client"]).join(", "));
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedKeys = useMemo(() => extractMergeKeys(body), [body]);
  const undeclared = usedKeys.filter((k) => !fields.some((f) => f.key === k));

  function addField(f: MergeField) {
    if (fields.some((x) => x.key === f.key)) return;
    setFields((x) => [...x, f]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), kind, body_md: body, fields, requires_signature: requires, signer_roles: roles.split(",").map((r) => r.trim()).filter(Boolean) };
      if (template) await api(`/api/document-templates/${template.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/api/document-templates", { method: "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={template ? `Edit template · ${template.name}` : "New template"} description="Markdown with {{merge.fields}}. Headings, paragraphs, bullet lists, **bold** and simple tables render in the PDF." onClose={onClose} size="xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Checkbox checked={requires} onChange={(e) => setRequires(e.target.checked)} label="Requires signature" />
          <Field label="Signer roles" hint="Comma-separated, in signing order">
            <Input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="client, provider" />
          </Field>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Body</span>
          <Button type="button" size="sm" variant="outline" touch onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>
            <Eye className="h-3.5 w-3.5" aria-hidden /> {showPreview ? "Edit" : "Preview"}
          </Button>
        </div>
        {showPreview ? (
          <div className="max-h-[40dvh] overflow-y-auto rounded-lg border border-border bg-card p-4" tabIndex={0} aria-label="Template preview">
            <MarkdownView body={body} />
          </div>
        ) : (
          <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" aria-label="Template body (markdown)" />
        )}

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Merge fields</legend>
          {undeclared.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Used in the body but not declared:{" "}
              {undeclared.map((k) => (
                <button key={k} type="button" className="me-1 inline-flex min-h-11 items-center rounded font-mono underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0" aria-label={`Declare merge field ${k}`} onClick={() => addField(STANDARD_MERGE_FIELDS.find((f) => f.key === k) ?? { key: k, label: k.replace(/[._]/g, " "), source: "custom" })}>
                  {`{{${k}}}`}
                </button>
              ))}
            </p>
          )}
          {fields.map((f, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_auto_auto] sm:items-center sm:border-0 sm:p-0" role="group" aria-label={`Merge field ${i + 1}`}>
              <Input value={f.key} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)))} placeholder="key" aria-label={`Field ${i + 1} key`} className="font-mono text-xs" />
              <Input value={f.label} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} placeholder="Label" aria-label={`Field ${i + 1} label`} />
              <Select value={f.source} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, source: e.target.value as MergeField["source"] } : y)))} aria-label={`Field ${i + 1} source`}>
                <option value="contact">contact</option>
                <option value="org">org</option>
                <option value="custom">custom</option>
              </Select>
              <Checkbox checked={Boolean(f.required)} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, required: e.target.checked } : y)))} label={<span className="text-xs">Required</span>} />
              <Button type="button" size="icon-sm" variant="ghost" touch aria-label={`Remove field ${f.key}`} onClick={() => setFields((x) => x.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-1">
            <Button type="button" size="sm" variant="outline" touch onClick={() => addField({ key: `field_${fields.length + 1}`, label: "New field", source: "custom" })}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Custom field
            </Button>
            <Select aria-label="Add a standard field" value="" onChange={(e) => { const f = STANDARD_MERGE_FIELDS.find((x) => x.key === e.target.value); if (f) addField(f); }} className="w-auto sm:h-8 sm:text-xs">
              <option value="">Add standard field…</option>
              {STANDARD_MERGE_FIELDS.filter((f) => !fields.some((x) => x.key === f.key)).map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label} ({f.key})
                </option>
              ))}
            </Select>
          </div>
        </fieldset>

        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !name.trim()}>
            {saving ? spinner : null} {template ? "Save template" : "Create template"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
