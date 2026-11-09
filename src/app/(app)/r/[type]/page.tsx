"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRightLeft, Boxes, Clock, Columns3, Link2, Loader2, MessageSquare, Pencil, Plus, RefreshCw, Search, Table2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { LoadMore } from "@/components/ui/load-more";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/money/format";
import {
  Banner,
  Empty,
  FieldInput,
  Skeleton,
  StagePill,
  TypeIcon,
  api,
  emptyForm,
  formFromRecord,
  formToData,
  formatValue,
  stageDot,
  type FormValues,
} from "@/components/records/shared";
import type { ActivityRow, FieldDef, LinkRow, RecordItem, RecordType } from "@/lib/records/types";
import { LINK_KINDS } from "@/lib/records/types";
import { AttachmentPanel } from "@/components/attachments/attachment-panel";

type View = "board" | "table";

const ACTIVITY_ICON: Record<string, React.ReactNode> = {
  created: <Plus className="h-3.5 w-3.5" aria-hidden />,
  moved: <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />,
  updated: <Pencil className="h-3.5 w-3.5" aria-hidden />,
  comment: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
  linked: <Link2 className="h-3.5 w-3.5" aria-hidden />,
};

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const singular = (name: string) => name.replace(/s$/i, "").toLowerCase();

const BACK_LINK =
  "inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0";

export default function RecordTypePage() {
  const params = useParams<{ type: string }>();
  const typeParam = params?.type ?? "";

  const [type, setType] = useState<RecordType | null>(null);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>("board");
  const [q, setQ] = useState("");
  const search = useDebouncedValue(q.trim(), 300);
  const [mobileStage, setMobileStage] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextSignal = useAbortable();

  // Board: every record (grouped client-side). Table: keyset pages of 50, newest first.
  const load = useCallback(async () => {
    if (!typeParam) return;
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (view === "table") {
        params.set("order", "created");
        params.set("limit", "50");
      }
      const qs = params.size ? `?${params}` : "";
      const r = await api<{ type: RecordType; records: RecordItem[]; counts: Record<string, number>; next_cursor: string | null }>(`/api/records/${encodeURIComponent(typeParam)}${qs}`, { signal });
      setType(r.type);
      setRecords(r.records);
      setCursor(r.next_cursor ?? null);
      setCounts(r.counts);
      setMobileStage((s) => s || r.type.stages[0]?.key || "");
    } catch (e) {
      if (isAbortError(e)) return;
      const msg = e instanceof Error ? e.message : "Could not load records.";
      if (/not found/i.test(msg)) setNotFound(true);
      else setError(msg);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [typeParam, search, view, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || !typeParam) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ order: "created", limit: "50", cursor });
      if (search) params.set("q", search);
      const r = await api<{ records: RecordItem[]; next_cursor: string | null }>(`/api/records/${encodeURIComponent(typeParam)}?${params}`);
      setRecords((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...r.records.filter((x) => !seen.has(x.id))];
      });
      setCursor(r.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more records.");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, typeParam, search]);

  // Remember the preferred view per type.
  useEffect(() => {
    try {
      const v = localStorage.getItem(`records.view.${typeParam}`);
      if (v === "board" || v === "table") setView(v);
    } catch {
      /* ignore */
    }
  }, [typeParam]);
  function pickView(v: View) {
    setView(v);
    try {
      localStorage.setItem(`records.view.${typeParam}`, v);
    } catch {
      /* ignore */
    }
  }

  const slug = type?.slug;
  const move = useCallback(
    async (rec: RecordItem, stage: string) => {
      if (!slug || stage === rec.stage) return;
      const from = rec.stage;
      setBusyId(rec.id);
      setError(null);
      setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, stage } : r)));
      try {
        const r = await api<{ record: RecordItem }>(`/api/records/${slug}/${rec.id}/move`, { method: "POST", body: JSON.stringify({ stage }) });
        setRecords((rs) => rs.map((x) => (x.id === r.record.id ? r.record : x)));
        setCounts((c) => ({ ...c, [from]: Math.max(0, (c[from] ?? 1) - 1), [stage]: (c[stage] ?? 0) + 1 }));
      } catch (e) {
        setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, stage: from } : r)));
        setError(e instanceof Error ? e.message : "Could not move the record.");
      } finally {
        setBusyId(null);
      }
    },
    [slug]
  );
  const open = useCallback((id: string) => setOpenId(id), []);

  const byStage = useMemo(() => {
    const m = new Map<string, RecordItem[]>();
    for (const s of type?.stages ?? []) m.set(s.key, []);
    for (const r of records) {
      if (!m.has(r.stage)) m.set(r.stage, []);
      m.get(r.stage)!.push(r);
    }
    return m;
  }, [records, type]);

  const openRecord = openId ? records.find((r) => r.id === openId) ?? null : null;

  if (notFound) {
    return (
      <PageContainer
        wide
        title="Record type not found"
        eyebrow={
          <Link href="/r" className={BACK_LINK}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All records
          </Link>
        }
      >
        <Empty
          icon={<Boxes className="h-5 w-5" />}
          title="This record type does not exist in your workspace"
          text="It may have been deleted, or its pack may not be installed yet."
          action={
            <Button asChild variant="outline">
              <Link href="/r">Back to records</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      wide
      className="pb-24"
      eyebrow={
        <>
          <Link href="/r" className={BACK_LINK}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All records
          </Link>
          {/* Grounds the copilot drawer in this record type (see src/lib/copilot/modules.ts). */}
          {type ? <span hidden data-copilot-type={type.slug} /> : null}
        </>
      }
      icon={<TypeIcon name={type?.icon} className="h-5 w-5" />}
      title={type?.name ?? (loading ? "Loading…" : "Records")}
      description={type?.description || undefined}
      actions={
        <>
          <SearchField value={q} onChange={setQ} label="Search records" placeholder="Search…" className="w-full sm:w-56" />
          <div className="flex items-center gap-1 rounded-lg border border-border p-1" role="group" aria-label="View">
            <ViewButton active={view === "board"} onClick={() => pickView("board")} label="Board view">
              <Columns3 className="h-4 w-4" aria-hidden />
            </ViewButton>
            <ViewButton active={view === "table"} onClick={() => pickView("table")} label="Table view">
              <Table2 className="h-4 w-4" aria-hidden />
            </ViewButton>
          </div>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button touch onClick={() => setCreating(true)} disabled={!type}>
            <Plus className="h-4 w-4" aria-hidden /> New
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {loading && !type ? (
        <div className="flex gap-3 overflow-hidden" role="status" aria-busy="true" aria-label="Loading records">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full shrink-0 rounded-xl sm:w-72" />
          ))}
        </div>
      ) : !type ? null : records.length === 0 && !search ? (
        <Empty
          icon={<TypeIcon name={type.icon} className="h-5 w-5" />}
          title={`No ${type.name.toLowerCase()} yet`}
          text={`Create your first record to start moving it through ${type.stages.map((s) => s.label).join(" → ")}.`}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New {singular(type.name)}
            </Button>
          }
        />
      ) : records.length === 0 ? (
        <Empty
          icon={<Search className="h-5 w-5" />}
          title="No matches"
          text={`Nothing matches “${search}”.`}
          action={
            <Button variant="outline" onClick={() => setQ("")}>
              Clear search
            </Button>
          }
        />
      ) : view === "board" ? (
        <>
          {/* Phones: one stage at a time. */}
          <div className="mb-3 sm:hidden">
            <label htmlFor="mobile-stage" className="sr-only">
              Stage
            </label>
            <Select id="mobile-stage" value={mobileStage} onChange={(e) => setMobileStage(e.target.value)}>
              {type.stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label} ({byStage.get(s.key)?.length ?? 0})
                </option>
              ))}
            </Select>
          </div>
          <div className="scrollbar-thin flex gap-3 sm:overflow-x-auto sm:pb-3" role="list" aria-label="Board" aria-busy={loading || undefined}>
            {type.stages.map((s) => {
              const items = byStage.get(s.key) ?? [];
              return (
                <section
                  key={s.key}
                  role="listitem"
                  aria-labelledby={`col-${s.key}`}
                  className={cn("w-full shrink-0 rounded-xl border border-border bg-secondary/30 sm:w-72", mobileStage !== s.key && "hidden sm:block")}
                >
                  <header className="flex items-center justify-between px-3 py-2.5">
                    <h2 id={`col-${s.key}`} className="flex items-center gap-2 text-sm font-medium">
                      <span className={cn("h-2 w-2 rounded-full", stageDot(s.color))} aria-hidden />
                      {s.label}
                    </h2>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                      <span className="sr-only">{items.length} records</span>
                      <span aria-hidden>{counts[s.key] ?? items.length}</span>
                    </span>
                  </header>
                  <ul className="flex flex-col gap-2 px-2 pb-2 sm:max-h-[65dvh] sm:overflow-y-auto sm:overscroll-contain">
                    {items.length === 0 && <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">Nothing here yet</li>}
                    {items.map((r) => (
                      <li key={r.id}>
                        <RecordCard type={type} rec={r} busy={busyId === r.id} onOpen={open} onMove={move} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <RecordTable type={type} records={records} busyId={busyId} onOpen={open} onMove={move} />
          <LoadMore hasMore={Boolean(cursor)} loading={loadingMore} count={records.length} onMore={loadMore} noun="records" />
        </>
      )}

      {creating && type && (
        <CreateDialog
          type={type}
          onClose={() => setCreating(false)}
          onCreated={(rec) => {
            setRecords((rs) => [rec, ...rs]);
            setCounts((c) => ({ ...c, [rec.stage]: (c[rec.stage] ?? 0) + 1 }));
            setCreating(false);
            setNotice(`Created “${rec.title}”.`);
          }}
        />
      )}

      {openRecord && type && (
        <DetailDrawer
          type={type}
          rec={openRecord}
          onClose={() => setOpenId(null)}
          onMove={(stage) => void move(openRecord, stage)}
          onSaved={(rec) => {
            setRecords((rs) => rs.map((x) => (x.id === rec.id ? rec : x)));
            setNotice(`Saved “${rec.title}”.`);
          }}
          onDeleted={() => {
            setRecords((rs) => rs.filter((x) => x.id !== openRecord.id));
            setCounts((c) => ({ ...c, [openRecord.stage]: Math.max(0, (c[openRecord.stage] ?? 1) - 1) }));
            setOpenId(null);
            setNotice(`Deleted “${openRecord.title}”.`);
          }}
        />
      )}
    </PageContainer>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-11 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:h-7 sm:w-8",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/* ─── Card ─────────────────────────────────────────────────────────────── */

function cardFields(type: RecordType): FieldDef[] {
  const keys = type.views.cardFields?.length ? type.views.cardFields : type.fields.slice(0, 2).map((f) => f.key);
  return keys.map((k) => type.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
}

const STAGE_SELECT = "h-11 w-auto px-1.5 text-xs sm:h-7 sm:text-xs";

const RecordCard = memo(function RecordCard({
  type,
  rec,
  busy,
  onOpen,
  onMove,
}: {
  type: RecordType;
  rec: RecordItem;
  busy: boolean;
  onOpen: (id: string) => void;
  onMove: (rec: RecordItem, stage: string) => void;
}) {
  const fields = cardFields(type);
  return (
    <article className={cn("rounded-lg border border-border bg-card p-3 shadow-sm transition-opacity motion-reduce:transition-none", busy && "opacity-60")} aria-busy={busy || undefined}>
      <button type="button" onClick={() => onOpen(rec.id)} className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <h3 className="break-words text-sm font-medium leading-snug">{rec.title}</h3>
        {rec.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{rec.summary}</p>}
        {fields.length > 0 && (
          <dl className="mt-2 space-y-0.5">
            {fields.map((f) => (
              <div key={f.key} className="flex items-baseline justify-between gap-2 text-xs">
                <dt className="truncate text-muted-foreground">{f.label}</dt>
                <dd className="truncate text-right tabular-nums">{formatValue(f, rec.data[f.key], rec.currency)}</dd>
              </div>
            ))}
          </dl>
        )}
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-[11px] text-muted-foreground">{fmtDate(rec.updated_at)}</span>
        <label className="sr-only" htmlFor={`move-${rec.id}`}>
          Move {rec.title} to stage
        </label>
        <Select id={`move-${rec.id}`} value={rec.stage} disabled={busy} onChange={(e) => onMove(rec, e.target.value)} className={cn(STAGE_SELECT, "max-w-[55%]")}>
          {type.stages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
    </article>
  );
});

/* ─── Table ────────────────────────────────────────────────────────────── */

function RecordTable({
  type,
  records,
  busyId,
  onOpen,
  onMove,
}: {
  type: RecordType;
  records: RecordItem[];
  busyId: string | null;
  onOpen: (id: string) => void;
  onMove: (r: RecordItem, stage: string) => void;
}) {
  const keys = type.views.tableColumns?.length ? type.views.tableColumns : type.fields.slice(0, 4).map((f) => f.key);
  const cols = keys.map((k) => type.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  return (
    <TableScroller label={`${type.name} table`}>
      <table className="w-full min-w-[40rem] text-sm">
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Title
            </th>
            <th scope="col" className={TH}>
              Stage
            </th>
            {cols.map((f) => (
              <th key={f.key} scope="col" className={TH}>
                {f.label}
              </th>
            ))}
            <th scope="col" className={TH}>
              Updated
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {records.map((r) => (
            <RecordRow key={r.id} type={type} rec={r} cols={cols} busy={busyId === r.id} onOpen={onOpen} onMove={onMove} />
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

const RecordRow = memo(function RecordRow({
  type,
  rec,
  cols,
  busy,
  onOpen,
  onMove,
}: {
  type: RecordType;
  rec: RecordItem;
  cols: FieldDef[];
  busy: boolean;
  onOpen: (id: string) => void;
  onMove: (r: RecordItem, stage: string) => void;
}) {
  return (
    <tr className={cn("hover:bg-secondary/30", busy && "opacity-60")} aria-busy={busy || undefined}>
      <td className="px-3 py-2">
        <button type="button" onClick={() => onOpen(rec.id)} className="rounded text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {rec.title}
        </button>
      </td>
      <td className="px-3 py-2">
        <label className="sr-only" htmlFor={`tmove-${rec.id}`}>
          Move {rec.title} to stage
        </label>
        <Select id={`tmove-${rec.id}`} value={rec.stage} disabled={busy} onChange={(e) => onMove(rec, e.target.value)} className={STAGE_SELECT}>
          {type.stages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
      </td>
      {cols.map((f) => (
        <td key={f.key} className="max-w-[220px] truncate px-3 py-2 tabular-nums">
          {formatValue(f, rec.data[f.key], rec.currency)}
        </td>
      ))}
      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtDate(rec.updated_at)}</td>
    </tr>
  );
});

/* ─── Generated form ───────────────────────────────────────────────────── */

function GeneratedFields({
  type,
  values,
  onChange,
  idPrefix,
  disabled,
}: {
  type: RecordType;
  values: FormValues;
  onChange: (key: string, v: string | boolean | string[]) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {type.fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const wide = f.type === "textarea" || f.type === "multiselect";
        return (
          <Field key={f.key} id={id} label={f.label} required={f.required} className={cn(wide && "sm:col-span-2")}>
            <FieldInput id={id} field={f} value={values[f.key] ?? ""} onChange={(v) => onChange(f.key, v)} disabled={disabled} />
          </Field>
        );
      })}
    </div>
  );
}

function CreateDialog({ type, onClose, onCreated }: { type: RecordType; onClose: () => void; onCreated: (rec: RecordItem) => void }) {
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState(type.stages[0]?.key ?? "");
  const [values, setValues] = useState<FormValues>(() => emptyForm(type));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ record: RecordItem }>(`/api/records/${type.slug}`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), stage, data: formToData(type, values) }),
      });
      onCreated(r.record);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the record.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`New ${singular(type.name)}`} onClose={onClose}>
      <form onSubmit={submit}>
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Title" required>
            <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
          </Field>
          <Field label="Stage">
            <Select value={stage} onChange={(e) => setStage(e.target.value)}>
              {type.stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <GeneratedFields type={type} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} idPrefix="create" disabled={saving} />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !title.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Create {singular(type.name)}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ─── Detail drawer ────────────────────────────────────────────────────── */

function DetailDrawer({
  type,
  rec,
  onClose,
  onMove,
  onSaved,
  onDeleted,
}: {
  type: RecordType;
  rec: RecordItem;
  onClose: () => void;
  onMove: (stage: string) => void;
  onSaved: (rec: RecordItem) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(rec.title);
  const [summary, setSummary] = useState(rec.summary ?? "");
  const [values, setValues] = useState<FormValues>(() => formFromRecord(type, rec));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [linkKind, setLinkKind] = useState<(typeof LINK_KINDS)[number]>("contact");
  const [linkId, setLinkId] = useState("");
  const [linking, setLinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ activity: ActivityRow[]; links: LinkRow[] }>(`/api/records/${type.slug}/${rec.id}`);
      setActivity(r.activity);
      setLinks(r.links);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load activity.");
    }
  }, [type.slug, rec.id]);
  // Load on open and keep the timeline fresh after a stage move from the drawer.
  useEffect(() => {
    void refresh();
  }, [refresh, rec.stage]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ record: RecordItem }>(`/api/records/${type.slug}/${rec.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), summary: summary.trim() || null, data: formToData(type, values) }),
      });
      onSaved(r.record);
      setEditing(false);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the record.");
    } finally {
      setSaving(false);
    }
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    setErr(null);
    try {
      await api(`/api/records/${type.slug}/${rec.id}/activity`, { method: "POST", body: JSON.stringify({ body: comment.trim() }) });
      setComment("");
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not post the comment.");
    } finally {
      setPosting(false);
    }
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linkId.trim()) return;
    setLinking(true);
    setErr(null);
    try {
      await api(`/api/records/${type.slug}/${rec.id}/links`, { method: "POST", body: JSON.stringify({ target_kind: linkKind, target_id: linkId.trim() }) });
      setLinkId("");
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add the link.");
    } finally {
      setLinking(false);
    }
  }

  async function remove() {
    setSaving(true);
    setErr(null);
    try {
      await api(`/api/records/${type.slug}/${rec.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete the record.");
      setSaving(false);
    }
  }

  const linkHref = (l: LinkRow): string | null => {
    switch (l.target_kind) {
      case "contact":
        return `/crm?contact=${encodeURIComponent(l.target_id)}`;
      case "task":
        return "/tasks";
      case "quote":
      case "invoice":
        return "/billing";
      case "booking":
        return "/calendar";
      case "record":
        return null;
    }
  };

  return (
    <Drawer
      labelledBy="drawer-title"
      onClose={onClose}
      header={
        <div className="min-w-0 flex-1">
          <h2 id="drawer-title" className={cn("break-words text-base font-semibold", editing && "sr-only")}>
            {rec.title}
          </h2>
          {editing && (
            <>
              <label htmlFor="drawer-title-input" className="sr-only">
                Title
              </label>
              <Input id="drawer-title-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required />
            </>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StagePill stage={rec.stage} stages={type.stages} />
            <label htmlFor="drawer-stage" className="sr-only">
              Move to stage
            </label>
            <Select id="drawer-stage" value={rec.stage} onChange={(e) => onMove(e.target.value)} className={STAGE_SELECT}>
              {type.stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      }
      footer={
        <>
          <span className="text-xs text-muted-foreground">Created {fmtDate(rec.created_at)}</span>
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
              <span className="text-xs">Delete this record?</span>
              <Button variant="outline" size="sm" touch onClick={() => setConfirmDelete(false)} disabled={saving}>
                Keep
              </Button>
              <Button variant="destructive" size="sm" touch onClick={() => void remove()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Delete
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" touch onClick={() => setConfirmDelete(true)} className="text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </Button>
          )}
        </>
      }
    >
      {err && (
        <Banner tone="error" onDismiss={() => setErr(null)}>
          {err}
        </Banner>
      )}

      <section aria-labelledby="fields-heading" className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="fields-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Fields
          </h3>
          {!editing && (
            <Button variant="ghost" size="sm" touch onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
            </Button>
          )}
        </div>
        {editing ? (
          <>
            <Field label="Summary" className="mb-3">
              <Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={4000} />
            </Field>
            <GeneratedFields type={type} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} idPrefix="edit" disabled={saving} />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                touch
                onClick={() => {
                  setEditing(false);
                  setTitle(rec.title);
                  setSummary(rec.summary ?? "");
                  setValues(formFromRecord(type, rec));
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button touch onClick={() => void save()} disabled={saving || !title.trim()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Save changes
              </Button>
            </div>
          </>
        ) : (
          <>
            {rec.summary && <p className="mb-3 rounded-md bg-secondary/40 px-3 py-2 text-sm">{rec.summary}</p>}
            {type.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">This type has no fields.</p>
            ) : (
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {type.fields.map((f) => (
                  <div key={f.key} className={cn("min-w-0", f.type === "textarea" && "sm:col-span-2")}>
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className={cn("break-words text-sm", f.type === "textarea" && "whitespace-pre-wrap")}>{formatValue(f, rec.data[f.key], rec.currency)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="links-heading" className="mb-6">
        <h3 id="links-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Links
        </h3>
        {links.length === 0 ? (
          <p className="mb-2 text-sm text-muted-foreground">Not linked to anything yet.</p>
        ) : (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {links.map((l) => {
              const href = linkHref(l);
              const label = (
                <>
                  <Link2 className="h-3 w-3" aria-hidden /> {l.target_kind}: {l.target_id.length > 14 ? `${l.target_id.slice(0, 12)}…` : l.target_id}
                </>
              );
              return (
                <li key={l.id}>
                  {href ? (
                    <Link href={href} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border px-2.5 text-xs hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {label}
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border px-2.5 text-xs">{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <form onSubmit={addLink} className="flex flex-wrap gap-2">
          <label htmlFor="link-kind" className="sr-only">
            Link kind
          </label>
          <Select id="link-kind" value={linkKind} onChange={(e) => setLinkKind(e.target.value as (typeof LINK_KINDS)[number])} className="w-auto capitalize">
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <label htmlFor="link-id" className="sr-only">
            Linked item ID
          </label>
          <Input id="link-id" value={linkId} onChange={(e) => setLinkId(e.target.value)} placeholder="Paste the item’s ID" className="min-w-0 flex-1" maxLength={200} spellCheck={false} />
          <Button type="submit" variant="outline" touch disabled={linking || !linkId.trim()}>
            {linking ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />} Link
          </Button>
        </form>
      </section>

      <section aria-label="Files" className="mb-6">
        <AttachmentPanel entityKind="record" entityId={rec.id} allowPortal compact />
      </section>

      <section aria-labelledby="activity-heading">
        <h3 id="activity-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Activity
        </h3>
        <form onSubmit={postComment} className="mb-4">
          <label htmlFor="comment" className="sr-only">
            Comment
          </label>
          <Textarea id="comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" maxLength={8000} />
          <div className="mt-2 flex justify-end">
            <Button type="submit" size="sm" touch disabled={posting || !comment.trim()}>
              {posting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <MessageSquare className="h-4 w-4" aria-hidden />} Post comment
            </Button>
          </div>
        </form>
        {activity === null ? (
          <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading activity">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ol className="relative ml-2 border-l border-border pl-4">
            {activity.map((a) => (
              <li key={a.id} className="mb-4">
                <span className="absolute -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                  {ACTIVITY_ICON[a.kind] ?? <Clock className="h-3.5 w-3.5" aria-hidden />}
                </span>
                <p className={cn("break-words text-sm", a.kind === "comment" && "whitespace-pre-wrap rounded-md bg-secondary/40 px-3 py-2")}>{a.body ?? a.kind}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="capitalize">{a.kind}</span> · <time dateTime={a.created_at}>{dateTime.format(new Date(a.created_at))}</time>
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Drawer>
  );
}
