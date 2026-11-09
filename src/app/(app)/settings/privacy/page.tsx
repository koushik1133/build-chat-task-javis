"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, Download, Fingerprint, Inbox, Loader2, Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { ExportEverythingCard } from "@/components/snapshots/export-everything-card";
import {
  breachHoursRemaining,
  CONSENT_PURPOSE_LABELS,
  CONSENT_PURPOSES,
  daysUntil,
  DSR_KINDS,
  INCIDENT_SEVERITIES,
  MAX_DSR_DUE_DAYS,
  RETENTION_META,
  type ConsentPurpose,
  type PrivacySettings,
  type RetentionKind,
} from "@/lib/privacy/constants";
import type { DsrRow } from "@/lib/privacy/dsr";
import type { ConsentRow } from "@/lib/privacy/consent";
import type { RetentionPolicyRow } from "@/lib/privacy/retention";
import type { IncidentRow } from "@/lib/privacy/incidents";
import type { NoticeRow } from "@/lib/privacy/notices";
import { timeAgo } from "@/lib/utils";

type Tab = "requests" | "consents" | "retention" | "notices" | "incidents" | "grievance";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "requests", label: "Requests" },
  { id: "consents", label: "Consents" },
  { id: "retention", label: "Retention" },
  { id: "notices", label: "Notices" },
  { id: "incidents", label: "Incidents" },
  { id: "grievance", label: "Grievance contact" },
];

const STATUS_TONE: Record<string, Tone> = { received: "info", verifying: "info", in_progress: "warning", completed: "success", rejected: "danger" };
const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : s);
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d && (d.detail || d.error) ? String(d.detail ?? d.error) : `${fallback} (${res.status})`;
}
async function api<T>(url: string, init?: RequestInit, fallback = "Request failed"): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return res.json() as Promise<T>;
}

function DuePill({ dueAt, status }: { dueAt: string; status: string }) {
  if (status === "completed" || status === "rejected") return <Pill tone="neutral">Closed</Pill>;
  const d = daysUntil(dueAt);
  if (d < 0) return <Pill tone="danger">{Math.abs(d)}d overdue</Pill>;
  if (d <= 5) return <Pill tone="warning">Due in {d}d</Pill>;
  return <Pill tone="info">Due in {d}d</Pill>;
}

/* ================= Requests ================= */

function RequestsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [rows, setRows] = useState<DsrRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [open, setOpen] = useState<DsrRow | null>(null);
  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [notes, setNotes] = useState("");
  const [eraseMode, setEraseMode] = useState<"anonymize" | "delete" | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ subject_kind: "contact", subject_id: "", kind: "access", email: "" });
  const titleId = useId();
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const d = await api<{ requests: DsrRow[] }>(`/api/privacy/requests${filter === "open" ? "?status=open" : ""}`, { signal }, "Could not load requests");
      setRows(d.requests);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load requests.");
    }
  }, [filter, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  async function openDrawer(r: DsrRow) {
    setOpen(r);
    setNotes(r.notes ?? "");
    setCode("");
    try {
      const d = await api<{ request: DsrRow; consents: ConsentRow[] }>(`/api/privacy/requests/${r.id}`);
      setOpen(d.request);
      setConsents(d.consents);
    } catch {
      setConsents([]);
    }
  }
  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      await fn();
      onNotice({ tone: "success", text: ok });
      await load();
      if (open) {
        const d = await api<{ request: DsrRow; consents: ConsentRow[] }>(`/api/privacy/requests/${open.id}`).catch(() => null);
        if (d) setOpen(d.request);
      }
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Action failed." });
    } finally {
      setBusy(null);
    }
  }
  const patch = (body: Record<string, unknown>, ok: string) => open && act("patch", () => api(`/api/privacy/requests/${open.id}`, { method: "PATCH", body: JSON.stringify(body) }), ok);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as "open" | "all")} aria-label="Filter requests" className="w-auto">
          <option value="open">Open requests</option>
          <option value="all">All requests</option>
        </Select>
        <Button touch onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New request
        </Button>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty
          icon={<Inbox className="h-5 w-5" />}
          title={filter === "open" ? "No open requests" : "No requests yet"}
          text="Access, erasure and correction requests from clients appear here with their due dates. You can also open one on a subject's behalf."
          action={
            <Button touch onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New request
            </Button>
          }
        />
      ) : (
        <TableScroller label="Data subject requests">
          <table className="w-full min-w-[640px] text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Kind</th>
                <th className={TH}>Subject</th>
                <th className={TH}>Status</th>
                <th className={TH}>Due</th>
                <th className={TH}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${r.kind} request for ${r.subject_email ?? r.subject_id}`}
                  className="cursor-pointer border-t border-border/60 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => void openDrawer(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void openDrawer(r);
                    }
                  }}
                >
                  <td className="px-3 py-2">{cap(r.kind)}</td>
                  <td className="px-3 py-2">
                    <div className="max-w-[16rem] break-all">{r.subject_email ?? r.subject_id}</div>
                    <div className="text-xs text-muted-foreground">{r.subject_kind} · {timeAgo(r.requested_at)}</div>
                  </td>
                  <td className="px-3 py-2"><Pill tone={STATUS_TONE[r.status] ?? "neutral"}>{cap(r.status)}</Pill></td>
                  <td className="px-3 py-2"><DuePill dueAt={r.due_at} status={r.status} /></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{cap(r.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      {creating && (
        <Dialog title="Open a request on behalf of a subject" onClose={() => setCreating(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                "create",
                () => api("/api/privacy/requests", { method: "POST", body: JSON.stringify({ subject_kind: form.subject_kind, subject_id: form.subject_id.trim(), kind: form.kind, email: form.email.trim() || null }) }),
                "Request opened."
              ).then(() => setCreating(false));
            }}
          >
            <Field label="Subject type">
              <Select value={form.subject_kind} onChange={(e) => setForm({ ...form, subject_kind: e.target.value })}>
                <option value="contact">Contact</option>
                <option value="lead">Lead</option>
              </Select>
            </Field>
            <Field label="Subject id" hint="Contact or lead id from the CRM / Leads page" required>
              <Input value={form.subject_id} onChange={(e) => setForm({ ...form, subject_id: e.target.value })} required />
            </Field>
            <Field label="Request kind">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {DSR_KINDS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}
              </Select>
            </Field>
            <Field label="Verification email" hint="Defaults to the email on file">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" touch onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" touch disabled={busy === "create" || !form.subject_id.trim()}>{busy === "create" && spinner} Open request</Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      {open && (
        <Drawer
          labelledBy={titleId}
          onClose={() => setOpen(null)}
          header={
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold">{cap(open.kind)} request</h2>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">{cap(open.subject_kind)} {open.subject_id} · {open.subject_email ?? "no email"}</p>
            </div>
          }
        >
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              <Pill tone={STATUS_TONE[open.status] ?? "neutral"}>{cap(open.status)}</Pill>
              <DuePill dueAt={open.due_at} status={open.status} />
              {open.verified_at ? <Pill tone="success">Verified {timeAgo(open.verified_at)}</Pill> : <Pill tone="warning">Unverified</Pill>}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <dt className="text-muted-foreground">Requested</dt><dd>{fmt(open.requested_at)}</dd>
              <dt className="text-muted-foreground">Due</dt><dd>{fmt(open.due_at)}</dd>
              <dt className="text-muted-foreground">Completed</dt><dd>{fmt(open.completed_at)}</dd>
              <dt className="text-muted-foreground">Source</dt><dd>{cap(open.source)}</dd>
            </dl>

            {!open.verified_at && open.status !== "completed" && open.status !== "rejected" && (
              <section className="rounded-lg border border-border p-3">
                <h3 className="font-medium">1. Verify the subject</h3>
                <p className="mt-1 text-xs text-muted-foreground">Email a one-time code to {open.subject_email ?? "the subject"}, then enter the code they read back. Or mark in progress if you verified another way.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" touch disabled={busy !== null || !open.subject_email} onClick={() => act("otp", () => api(`/api/privacy/requests/${open.id}/verify`, { method: "POST", body: "{}" }), "Code sent.")}>{busy === "otp" && spinner} Send code</Button>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" className="w-32" aria-label="Verification code" />
                  <Button size="sm" touch disabled={busy !== null || !/^\d{6}$/.test(code)} onClick={() => act("verify", () => api(`/api/privacy/requests/${open.id}/verify`, { method: "POST", body: JSON.stringify({ code }) }), "Subject verified.")}>{busy === "verify" && spinner} Verify</Button>
                  <Button size="sm" variant="ghost" touch disabled={busy !== null} onClick={() => patch({ status: "in_progress" }, "Marked in progress (manually verified).")}>Mark in progress</Button>
                </div>
              </section>
            )}

            <section className="rounded-lg border border-border p-3">
              <h3 className="font-medium">2. Fulfil</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" touch asChild>
                  <a href={`/api/privacy/requests/${open.id}/export`} download><Download className="h-3.5 w-3.5" aria-hidden /> Export JSON</a>
                </Button>
                {open.status !== "completed" && open.status !== "rejected" && (
                  <Button size="sm" variant="destructive" touch disabled={busy !== null || !open.verified_at} onClick={() => setEraseMode("anonymize")} title={open.verified_at ? undefined : "Verify first"}>
                    Erase subject…
                  </Button>
                )}
              </div>
              {open.result && <pre className="mt-2 max-h-40 overflow-auto rounded bg-secondary/40 p-2 text-[11px]">{open.result}</pre>}
            </section>

            <section className="rounded-lg border border-border p-3">
              <h3 className="font-medium">3. Close</h3>
              <Field label="Notes" className="mt-2">
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" touch disabled={busy !== null} onClick={() => patch({ notes }, "Notes saved.")}>Save notes</Button>
                {open.status !== "completed" && open.status !== "rejected" && (
                  <>
                    <Button size="sm" touch disabled={busy !== null} onClick={() => patch({ status: "completed", notes }, "Request completed.")}>Complete</Button>
                    <Button size="sm" variant="destructive" touch disabled={busy !== null} onClick={() => patch({ status: "rejected", notes }, "Request rejected.")}>Reject</Button>
                  </>
                )}
              </div>
            </section>

            <section>
              <h3 className="font-medium">Consent history</h3>
              {consents.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">No consent records for this subject.</p>
              ) : (
                <ul className="mt-1 divide-y divide-border/60 text-xs">
                  {consents.map((c) => (
                    <li key={c.id} className="flex justify-between gap-2 py-1.5">
                      <span>{CONSENT_PURPOSE_LABELS[c.purpose] ?? c.purpose}</span>
                      <span className="text-muted-foreground">{cap(c.status)} · {c.source} · {timeAgo(c.occurred_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Drawer>
      )}

      {eraseMode && open && (
        <Dialog title="Erase this subject's personal data" onClose={() => setEraseMode(null)}>
          <p className="text-sm text-muted-foreground">
            Invoices and quotes keep their amounts with the customer label replaced. Everything else is anonymised in place or deleted. Opt-outs stay effective via hashed tombstones. This cannot be undone.
          </p>
          <Field label="Mode" className="mt-3">
            <Select value={eraseMode} onChange={(e) => setEraseMode(e.target.value as "anonymize" | "delete")}>
              <option value="anonymize">Anonymise in place (keeps counts and history)</option>
              <option value="delete">Delete rows (contact, bookings, tickets, conversations)</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" touch disabled={busy === "erase"} onClick={() => setEraseMode(null)}>Cancel</Button>
            <Button variant="destructive" touch disabled={busy !== null} onClick={() => act("erase", () => api(`/api/privacy/requests/${open.id}/erase`, { method: "POST", body: JSON.stringify({ mode: eraseMode }) }), "Subject erased and request completed.").then(() => setEraseMode(null))}>
              {busy === "erase" && spinner} Erase permanently
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/* ================= Consents ================= */

type ContactHit = { id: string; full_name: string; email: string | null; phone: string | null; consent: Partial<Record<ConsentPurpose, { status: string; at: string }>> };

function ConsentsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 300);
  const [hits, setHits] = useState<ContactHit[] | null>(null);
  const [history, setHistory] = useState<ConsentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      if (dq.trim()) {
        const d = await api<{ contacts: ContactHit[] }>(`/api/privacy/consents?q=${encodeURIComponent(dq.trim())}`, { signal }, "Search failed");
        setHits(d.contacts);
      } else {
        setHits(null);
        const d = await api<{ history: ConsentRow[] }>(`/api/privacy/consents`, { signal }, "Could not load consents");
        setHistory(d.history);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load consents.");
    }
  }, [dq, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  async function set(contactId: string, purpose: ConsentPurpose, status: "granted" | "withdrawn") {
    setBusy(`${contactId}:${purpose}`);
    try {
      await api("/api/privacy/consents", { method: "POST", body: JSON.stringify({ subject_kind: "contact", subject_id: contactId, purpose, status }) });
      onNotice({ tone: "success", text: `Consent ${status}.` });
      await load();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not record consent." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <SearchField value={q} onChange={setQ} placeholder="Search contacts by name, email or phone" label="Search contacts" />
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : hits ? (
        hits.length === 0 ? (
          <Empty title="No contacts match" text="Try a different name, email or phone number. Only CRM contacts are searched here." />
        ) : (
          <ul className="space-y-3">
            {hits.map((c) => (
              <li key={c.id} className="rounded-xl border border-border bg-card p-4">
                <div className="font-medium">{c.full_name}</div>
                <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{[c.email, c.phone].filter(Boolean).join(" · ") || "No contact details"}</div>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {CONSENT_PURPOSES.map((p) => {
                    const cur = c.consent[p];
                    const granted = cur?.status === "granted";
                    return (
                      <li key={p} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate">{CONSENT_PURPOSE_LABELS[p]}</div>
                          <div className="text-[11px] text-muted-foreground">{cur ? `${cap(cur.status)} ${timeAgo(cur.at)}` : "No record"}</div>
                        </div>
                        <Button size="sm" touch variant={granted ? "outline" : "default"} disabled={busy === `${c.id}:${p}`} onClick={() => set(c.id, p, granted ? "withdrawn" : "granted")} aria-label={`${granted ? "Withdraw" : "Grant"} ${CONSENT_PURPOSE_LABELS[p]} for ${c.full_name}`}>
                          {busy === `${c.id}:${p}` && spinner}
                          {granted ? "Withdraw" : "Grant"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )
      ) : history === null ? (
        <Loading />
      ) : history.length === 0 ? (
        <Empty title="No consent records yet" text="Consent is captured from forms, the client portal, imports and manual entries. Search a contact to grant or withdraw." />
      ) : (
        <TableScroller label="Recent consent ledger">
          <table className="w-full min-w-[640px] text-sm">
            <thead className={THEAD}>
              <tr><th className={TH}>When</th><th className={TH}>Subject</th><th className={TH}>Purpose</th><th className={TH}>Status</th><th className={TH}>Source</th></tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(r.occurred_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs" title={r.subject_id}>{cap(r.subject_kind)} {r.subject_id.slice(0, 8)}…</td>
                  <td className="px-3 py-2">{CONSENT_PURPOSE_LABELS[r.purpose] ?? r.purpose}</td>
                  <td className="px-3 py-2"><Pill tone={r.status === "granted" ? "success" : "warning"}>{cap(r.status)}</Pill></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{cap(r.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </div>
  );
}

/* ================= Retention ================= */

function RetentionTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [policies, setPolicies] = useState<RetentionPolicyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<RetentionPolicyRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicies((await api<{ policies: RetentionPolicyRow[] }>("/api/privacy/retention")).policies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load policies.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      await api("/api/privacy/retention", { method: "PUT", body: JSON.stringify({ entity_kind: edit.entity_kind, keep_days: Number(edit.keep_days), action: edit.action, enabled: edit.enabled }) });
      onNotice({ tone: "success", text: "Policy saved. Floors are enforced automatically." });
      setEdit(null);
      await load();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!policies) return <Loading />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">The nightly sweep applies enabled policies. Invoices, quotes and payments are never purged. Audit log has a statutory floor of 365 days.</p>
      <TableScroller label="Retention policies">
        <table className="w-full min-w-[720px] text-sm">
          <thead className={THEAD}><tr><th className={TH}>Data</th><th className={TH}>Keep</th><th className={TH}>Then</th><th className={TH}>Status</th><th className={TH}>Last run</th><th className={TH}><span className="sr-only">Edit</span></th></tr></thead>
          <tbody>
            {policies.map((p) => {
              const meta = RETENTION_META[p.entity_kind as RetentionKind];
              return (
                <tr key={p.entity_kind} className="border-t border-border/60">
                  <td className="px-3 py-2"><div className="font-medium">{meta.label}</div><div className="text-xs text-muted-foreground">{meta.description}</div></td>
                  <td className="px-3 py-2 tabular-nums">{p.keep_days} days</td>
                  <td className="px-3 py-2">{cap(p.action)}</td>
                  <td className="px-3 py-2">{p.enabled ? <Pill tone="success">Enabled</Pill> : <Pill tone="neutral">Off</Pill>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.last_run_at ? `${timeAgo(p.last_run_at)} · ${p.last_affected ?? 0} rows` : "Never"}</td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant="outline" touch onClick={() => setEdit({ ...p })} aria-label={`Edit retention for ${meta.label}`}>Edit</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroller>
      {edit && (
        <Dialog title={`Retention: ${RETENTION_META[edit.entity_kind as RetentionKind].label}`} onClose={() => setEdit(null)}>
          <div className="space-y-3">
            <Field label="Keep for (days)" hint={`Minimum ${RETENTION_META[edit.entity_kind as RetentionKind].minDays} days`}>
              <Input type="number" min={RETENTION_META[edit.entity_kind as RetentionKind].minDays} value={edit.keep_days} onChange={(e) => setEdit({ ...edit, keep_days: Number(e.target.value) })} />
            </Field>
            <Field label="Then">
              <Select value={edit.action} onChange={(e) => setEdit({ ...edit, action: e.target.value as RetentionPolicyRow["action"] })}>
                {RETENTION_META[edit.entity_kind as RetentionKind].actions.map((a) => <option key={a} value={a}>{cap(a)}</option>)}
              </Select>
            </Field>
            <Checkbox label="Enabled" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />
          </div>
          <DialogFooter>
            <Button variant="outline" touch disabled={busy} onClick={() => setEdit(null)}>Cancel</Button>
            <Button touch disabled={busy} onClick={save}>{busy && spinner} Save</Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/* ================= Notices ================= */

function NoticesTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [notices, setNotices] = useState<NoticeRow[] | null>(null);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<"en" | "es" | "hi">("en");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<{ notices: NoticeRow[]; slug: string }>("/api/privacy/notices");
      setNotices(d.notices);
      setSlug(d.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notices.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const latest = notices?.find((n) => n.locale === locale);
    setBody(latest?.body_md ?? "");
  }, [notices, locale]);

  async function publish() {
    setBusy(true);
    try {
      await api("/api/privacy/notices", { method: "POST", body: JSON.stringify({ locale, body_md: body }) });
      onNotice({ tone: "success", text: "New version published." });
      await load();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not publish." });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!notices) return <Loading />;
  const versions = notices.filter((n) => n.locale === locale);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={locale} onChange={(e) => setLocale(e.target.value as "en" | "es" | "hi")} aria-label="Notice language" className="w-auto">
            <option value="en">English</option><option value="es">Español</option><option value="hi">हिन्दी</option>
          </Select>
          {slug && <a className="inline-flex min-h-11 items-center text-xs underline sm:min-h-0" href={`/p/privacy/${slug}?lang=${locale}`} target="_blank" rel="noreferrer">View public page</a>}
        </div>
        <Field label="Notice (Markdown)" hint="Publishing creates a new immutable version; past versions stay on record so consent evidence can reference them.">
          <Textarea rows={18} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"## What we collect\n- Name, email, phone…\n\n## Why\n…\n\n## Your rights\n…"} />
        </Field>
        <Button touch disabled={busy || body.trim().length < 20} onClick={publish}>{busy && spinner} Publish version {(versions[0]?.version ?? 0) + 1}</Button>
      </div>
      <aside className="rounded-xl border border-border bg-card p-4 text-sm">
        <h3 className="font-medium">Versions</h3>
        {versions.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">Nothing published yet.</p> : (
          <ul className="mt-2 divide-y divide-border/60 text-xs">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <button type="button" className="inline-flex min-h-11 items-center rounded px-1 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8" onClick={() => setBody(v.body_md)} aria-label={`Load version ${v.version} into the editor`}>v{v.version}</button>
                <span className="text-muted-foreground">{fmt(v.published_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

/* ================= Incidents ================= */

function Countdown({ detectedAt, notifiedAt }: { detectedAt: string; notifiedAt: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (notifiedAt) return <Pill tone="success">Authority notified {timeAgo(notifiedAt)}</Pill>;
  const h = breachHoursRemaining(detectedAt);
  if (h < 0) return <Pill tone="danger">72h exceeded by {Math.abs(h).toFixed(0)}h</Pill>;
  const tone: Tone = h < 12 ? "danger" : h < 36 ? "warning" : "info";
  return <Pill tone={tone}>{Math.floor(h)}h {Math.floor((h % 1) * 60)}m left to notify</Pill>;
}

function IncidentsTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [rows, setRows] = useState<IncidentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", description: "", severity: "medium", detected_at: new Date().toISOString().slice(0, 16), affected_count: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api<{ incidents: IncidentRow[] }>("/api/privacy/incidents")).incidents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load incidents.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create");
    try {
      await api("/api/privacy/incidents", {
        method: "POST",
        body: JSON.stringify({ title: form.title.trim(), description: form.description.trim() || null, severity: form.severity, detected_at: new Date(form.detected_at).toISOString(), affected_count: form.affected_count ? Number(form.affected_count) : null }),
      });
      onNotice({ tone: "success", text: "Incident logged. The 72-hour clock is running." });
      setCreating(false);
      setForm({ title: "", description: "", severity: "medium", detected_at: new Date().toISOString().slice(0, 16), affected_count: "" });
      await load();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not log the incident." });
    } finally {
      setBusy(null);
    }
  }
  async function mark(id: string, patch: Record<string, unknown>, ok: string) {
    setBusy(id);
    try {
      await api(`/api/privacy/incidents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onNotice({ tone: "success", text: ok });
      await load();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Update failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">Log a suspected breach the moment it is detected. Affected people must be told without delay; the authority within 72 hours.</p>
        <Button touch onClick={() => setCreating(true)}><ShieldAlert className="h-4 w-4" aria-hidden /> Log incident</Button>
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : rows === null ? <Loading /> : rows.length === 0 ? (
        <Empty
          icon={<ShieldAlert className="h-5 w-5" />}
          title="No incidents logged"
          text="When you suspect a breach, log it here to start the 72-hour notification clock and record who was told and when."
          action={
            <Button touch onClick={() => setCreating(true)}>
              <ShieldAlert className="h-4 w-4" aria-hidden /> Log incident
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((i) => {
            const now = new Date().toISOString();
            return (
              <li key={i.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words font-medium">{i.title}</h3>
                      <Pill tone={i.severity === "critical" || i.severity === "high" ? "danger" : i.severity === "medium" ? "warning" : "neutral"}>{cap(i.severity)}</Pill>
                      <Pill tone="neutral">{cap(i.status)}</Pill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Detected {fmt(i.detected_at)}{i.affected_count !== null ? ` · ${i.affected_count} affected` : ""}</p>
                    {i.description && <p className="mt-2 text-sm">{i.description}</p>}
                  </div>
                  <Countdown detectedAt={i.detected_at} notifiedAt={i.notified_authority_at} />
                </div>
                {i.status !== "closed" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!i.contained_at && <Button size="sm" variant="outline" touch disabled={busy === i.id} onClick={() => mark(i.id, { contained_at: now, status: "contained" }, "Marked contained.")}>Mark contained</Button>}
                    {!i.notified_subjects_at && <Button size="sm" variant="outline" touch disabled={busy === i.id} onClick={() => mark(i.id, { notified_subjects_at: now }, "Recorded: affected people notified.")}>Affected people notified</Button>}
                    {!i.notified_authority_at && <Button size="sm" touch disabled={busy === i.id} onClick={() => mark(i.id, { notified_authority_at: now, status: "notified" }, "Recorded: authority notified.")}>Authority notified</Button>}
                    <Button size="sm" variant="ghost" touch disabled={busy === i.id} onClick={() => mark(i.id, { status: "closed" }, "Incident closed.")} aria-label={`Close incident ${i.title}`}>Close</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <Dialog title="Log a security incident" onClose={() => setCreating(false)}>
          <form className="space-y-3" onSubmit={create}>
            <Field label="Title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={3} /></Field>
            <Field label="What happened"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Severity"><Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</Select></Field>
              <Field label="Detected at"><Input type="datetime-local" value={form.detected_at} onChange={(e) => setForm({ ...form, detected_at: e.target.value })} required /></Field>
              <Field label="People affected"><Input type="number" min={0} value={form.affected_count} onChange={(e) => setForm({ ...form, affected_count: e.target.value })} /></Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" touch disabled={busy === "create"} onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" touch disabled={busy === "create"}>{busy === "create" && spinner} Log incident</Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
    </div>
  );
}

/* ================= Grievance / settings ================= */

function GrievanceTab({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [s, setS] = useState<PrivacySettings | null>(null);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ settings: PrivacySettings; slug: string }>("/api/privacy/settings");
      setS(d.settings);
      setSlug(d.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    try {
      const d = await api<{ settings: PrivacySettings }>("/api/privacy/settings", { method: "PATCH", body: JSON.stringify({ ...s, grievance_officer_email: s.grievance_officer_email || null, grievance_officer_name: s.grievance_officer_name || null }) });
      setS(d.settings);
      onNotice({ tone: "success", text: "Saved." });
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!s) return <Loading />;
  return (
    <form onSubmit={save} className="max-w-xl space-y-4">
      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">Shown on the public privacy notice{slug && <> (<a className="underline" href={`/p/privacy/${slug}`} target="_blank" rel="noreferrer">/p/privacy/{slug}</a>)</>} and in the client portal.</p>
      <Field label="Grievance officer name"><Input value={s.grievance_officer_name ?? ""} onChange={(e) => setS({ ...s, grievance_officer_name: e.target.value })} /></Field>
      <Field label="Grievance officer email"><Input type="email" value={s.grievance_officer_email ?? ""} onChange={(e) => setS({ ...s, grievance_officer_email: e.target.value })} /></Field>
      <Field label="Published response period (days)" hint={`Requests are due this many days after receipt. Maximum ${MAX_DSR_DUE_DAYS}.`}>
        <Input type="number" min={1} max={MAX_DSR_DUE_DAYS} value={s.dsr_due_days} onChange={(e) => setS({ ...s, dsr_due_days: Number(e.target.value) })} />
      </Field>
      <Checkbox label={<span>Auto-fulfil portal access requests <span className="text-xs text-muted-foreground">— the client downloads their data instantly; otherwise staff export it from Requests.</span></span>} checked={s.auto_fulfil_access} onChange={(e) => setS({ ...s, auto_fulfil_access: e.target.checked })} />
      <Button type="submit" touch disabled={busy}>{busy && spinner} Save</Button>
    </form>
  );
}

/* ================= Page ================= */

type Notice = { tone: "success" | "error"; text: string };

export default function PrivacySettingsPage() {
  const [tab, setTab] = useState<Tab>("requests");
  const [notice, setNotice] = useState<Notice | null>(null);
  const onNotice = useCallback((n: Notice) => setNotice(n), []);

  return (
    <PageContainer
      wide
      title="Privacy & data"
      description="Consent, data-subject requests, retention, notices and breach log — the controls behind DPDP and GDPR duties."
      icon={<Fingerprint className="h-5 w-5" aria-hidden />}
      actions={
        <Button variant="outline" touch asChild>
          <a href="/docs/PRIVACY.md" target="_blank" rel="noreferrer"><AlertTriangle className="h-4 w-4" aria-hidden /> How this maps to the law</a>
        </Button>
      }
    >
      <Tabs id="privacy" label="Privacy sections" tabs={TABS} value={tab} onChange={(t) => { setTab(t); setNotice(null); }} className="mb-4" />
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>
      )}
      <TabPanel id="privacy" value={tab}>
        {tab === "requests" && <RequestsTab onNotice={onNotice} />}
        {tab === "consents" && <ConsentsTab onNotice={onNotice} />}
        {tab === "retention" && <RetentionTab onNotice={onNotice} />}
        {tab === "notices" && <NoticesTab onNotice={onNotice} />}
        {tab === "incidents" && <IncidentsTab onNotice={onNotice} />}
        {tab === "grievance" && <GrievanceTab onNotice={onNotice} />}
      </TabPanel>
      <div className="mt-6">
        <ExportEverythingCard />
      </div>
    </PageContainer>
  );
}
