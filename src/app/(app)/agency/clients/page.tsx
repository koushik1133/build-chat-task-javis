"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeftRight, Building2, Check, Copy, Loader2, Mail, Plus, RefreshCw, RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { ROLES, canManageRole, type Role } from "@/lib/auth/roles";
import { fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";

interface Client {
  id: string; name: string; slug: string; dataId: string; kind: string; archived: boolean; archivedAt: string | null; createdAt: string; members: number; pendingInvites: number;
}
interface RollupRow {
  org: { id: string }; currency: string; revenue_minor: number; paid_invoices: number; open_quotes: number; open_quotes_minor: number; bookings: number; open_tickets: number; ai_cost_micros: number;
}
interface ListResponse { clients: Client[]; org: { id: string; name: string; kind: string }; canEdit: boolean }

const ASSIGNABLE = ROLES.filter((r) => r !== "owner") as Exclude<Role, "owner">[];
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const fieldErr = data?.detail?.fieldErrors ? Object.entries(data.detail.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`)[0] : null;
    throw new Error(data?.detail?.formErrors?.[0] ?? fieldErr ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export default function AgencyClientsPage() {
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [kpis, setKpis] = useState<Map<string, RollupRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviteFor, setInviteFor] = useState<Client | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [list, roll] = await Promise.all([
        api<ListResponse>(`/api/agency/workspaces${showArchived ? "?archived=1" : ""}`, { signal }),
        api<{ report: { rows: RollupRow[] } }>("/api/agency/rollup", { signal }).catch((e) => {
          if (isAbortError(e)) throw e;
          return { report: { rows: [] as RollupRow[] } };
        }),
      ]);
      setData(list);
      setKpis(new Map(roll.report.rows.map((r) => [r.org.id, r])));
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load client workspaces.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal, showArchived]);
  useEffect(() => {
    void load();
  }, [load]);

  async function switchTo(c: Client) {
    setBusyId(c.id);
    setError(null);
    try {
      await api("/api/agency/switch", { method: "POST", body: JSON.stringify({ orgId: c.id }) });
      router.push("/chat");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch workspace.");
      setBusyId(null);
    }
  }

  async function setArchived(c: Client, archived: boolean) {
    if (archived && !window.confirm(`Archive ${c.name}? Its data is kept and it can be restored later.`)) return;
    setBusyId(c.id);
    setError(null);
    try {
      await api(`/api/agency/workspaces/${c.id}`, { method: "PATCH", body: JSON.stringify({ archived }) });
      setNotice(archived ? `${c.name} archived.` : `${c.name} restored.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the workspace.");
    } finally {
      setBusyId(null);
    }
  }

  const clients = data?.clients ?? [];
  const canEdit = data?.canEdit ?? false;
  const isClientOrg = data?.org.kind === "client";

  return (
    <PageContainer
      wide
      title="Client workspaces"
      description="Each client gets its own isolated workspace. Switch into one to work in it, invite their team, and roll numbers up here."
      tooltip="A client workspace is a separate organization owned by this agency. Its CRM, billing, calendar and helpdesk data stay separate; you see the totals on Reports."
      eyebrow={<Link href="/agency" className="text-xs text-muted-foreground underline-offset-2 hover:underline">← Agency Command</Link>}
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          {canEdit && !isClientOrg && (
            <Button touch onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New client
            </Button>
          )}
        </>
      }
    >
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {isClientOrg && <Banner tone="info">You are inside a client workspace. Switch back to your agency workspace from the sidebar to manage clients.</Banner>}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          <Users className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden />
          {data ? `${clients.length} workspace${clients.length === 1 ? "" : "s"} under ${data.org.name}` : "Client workspaces"}
        </p>
        <Checkbox label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      </div>

      {loading && !data ? (
        <SkeletonList count={3} itemClassName="h-40" label="Loading client workspaces…" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : clients.length === 0 ? (
        <Empty
          icon={<Building2 className="h-5 w-5" />}
          title={isClientOrg ? "This is a client workspace" : "No client workspaces yet"}
          text={isClientOrg ? "Client workspaces are created from the agency workspace." : "Create one per client. You can switch into it, invite their people and see their numbers roll up on Reports."}
          action={canEdit && !isClientOrg ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New client</Button> : undefined}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy={loading || undefined}>
          {clients.map((c) => {
            const k = kpis.get(c.id);
            const busy = busyId === c.id;
            return (
              <li key={c.id} className={cn("flex flex-col rounded-xl border border-border bg-card p-4", c.archived && "opacity-70")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold">{c.name}</h2>
                    <p className="truncate font-mono text-xs text-muted-foreground">{c.slug}</p>
                  </div>
                  {c.archived ? <Pill tone="neutral">Archived</Pill> : <Pill tone="success">Active</Pill>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <Kpi label="Revenue (30d)" value={k ? fmtMoney(k.revenue_minor, k.currency) : "—"} />
                  <Kpi label="Open quotes" value={k ? `${k.open_quotes} · ${fmtMoney(k.open_quotes_minor, k.currency)}` : "—"} />
                  <Kpi label="Bookings (30d)" value={k ? String(k.bookings) : "—"} />
                  <Kpi label="Open tickets" value={k ? String(k.open_tickets) : "—"} />
                  <Kpi label="AI spend (30d)" value={k ? `$${(k.ai_cost_micros / 1e6).toFixed(2)}` : "—"} />
                  <Kpi label="People" value={`${c.members}${c.pendingInvites ? ` · ${c.pendingInvites} invited` : ""}`} />
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!c.archived && (
                    <Button size="sm" touch disabled={busy} onClick={() => void switchTo(c)}>
                      {busy ? spinner : <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />} Open workspace
                    </Button>
                  )}
                  {canEdit && !c.archived && (
                    <Button size="sm" variant="outline" touch disabled={busy} onClick={() => setInviteFor(c)}>
                      <Mail className="h-3.5 w-3.5" aria-hidden /> Invite
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => void setArchived(c, !c.archived)} aria-label={c.archived ? `Restore ${c.name}` : `Archive ${c.name}`}>
                      {c.archived ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> : <Archive className="h-3.5 w-3.5" aria-hidden />}
                      {c.archived ? "Restore" : "Archive"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <CreateClientDialog
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            setNotice(`Created ${name}.`);
            void load();
          }}
        />
      )}
      {inviteFor && (
        <InviteDialog
          client={inviteFor}
          onClose={() => setInviteFor(null)}
          onInvited={() => {
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums" title={value}>{value}</dd>
    </div>
  );
}

function CreateClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: name.trim() };
      if (slug.trim()) body.slug = slug.trim().toLowerCase();
      const r = await api<{ client: Client }>("/api/agency/workspaces", { method: "POST", body: JSON.stringify(body) });
      onCreated(r.client.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the workspace.");
      setBusy(false);
    }
  }

  return (
    <Dialog title="New client workspace" description="An isolated workspace for one client. You become its owner." onClose={onClose} size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Client name" required>
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Acme Dental" />
        </Field>
        <Field label="Slug" hint="Optional. Used in public booking and portal links.">
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={40} pattern="[a-z0-9-]+" placeholder="acme-dental" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={busy || !name.trim()}>{busy && spinner} Create workspace</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function InviteDialog({ client, onClose, onInvited }: { client: Client; onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("member");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { email: email.trim(), role };
      if (message.trim()) body.message = message.trim();
      const r = await api<{ inviteUrl: string }>(`/api/agency/workspaces/${client.id}/invite`, { method: "POST", body: JSON.stringify(body) });
      setLink(r.inviteUrl);
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invite.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy. Select the link and copy it manually.");
    }
  }

  return (
    <Dialog title={`Invite to ${client.name}`} description="The invite is emailed through the outbox and the link is shown here too." onClose={onClose} size="sm">
      {link ? (
        <div className="space-y-4">
          <Banner tone="success">Invite created for {email.trim()}.</Banner>
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{link}</code>
            <Button size="sm" variant="outline" touch onClick={() => void copy()} aria-label="Copy invite link">
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Links expire after 7 days and can only be used once.</p>
          <DialogFooter>
            <Button type="button" touch onClick={onClose}>Done</Button>
          </DialogFooter>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Field label="Email" required>
            <Input data-autofocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} placeholder="cto@client.com" />
          </Field>
          <Field label="Role" hint="Admins manage their team; members and viewers get scoped access.">
            <Select value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)}>
              {ASSIGNABLE.filter((r) => canManageRole("owner", r)).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="Message" hint="Optional note added to the invite email.">
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
            <Button type="submit" touch disabled={busy || !email.trim()}>{busy && spinner} Send invite</Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
