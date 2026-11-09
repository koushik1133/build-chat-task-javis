"use client";

import { useCallback, useEffect, useState } from "react";
import { UpgradePrompt } from "@/components/plans/upgrade-prompt";
import { Users, Loader2, RefreshCw, Copy, Check, Trash2, X, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { ROLES, canManageRole, type Role } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

interface Member { id: string; userId: string | null; email: string | null; role: Role; isOwner: boolean; isSelf: boolean; joinedAt: string }
interface Invite { id: string; email: string | null; role: Role; createdAt: string; expired: boolean }
interface TeamData { orgId: string; role: Role; members: Member[]; invites: Invite[] }

const ASSIGNABLE: Role[] = ROLES.filter((r) => r !== "owner");

export default function TeamSettingsPage() {
  const [data, setData] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviting, setInviting] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/team");
      if (res.status === 403) throw new Error("Your role cannot view the team.");
      if (!res.ok) throw new Error("Could not load the team.");
      setData((await res.json()) as TeamData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the team.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const myRole: Role = data?.role ?? "viewer";
  const canEdit = myRole === "owner" || myRole === "admin";

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setNotice(null);
    setLastLink(null);
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const body = (await res.json().catch(() => null)) as { inviteUrl?: string; error?: string; detail?: string } | null;
      if (!res.ok) throw new Error(body?.detail ?? body?.error ?? "Could not create the invite.");
      setLastLink(body?.inviteUrl ?? null);
      setNotice(`Invite created for ${inviteEmail.trim()}. Share the link below.`);
      setInviteEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invite.");
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(id: string, role: Role) {
    setError(null);
    const res = await fetch(`/api/team/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
      setError(body?.detail ?? body?.error ?? "Could not change the role.");
      return;
    }
    await load();
  }

  async function remove(id: string, label: string, pending: boolean) {
    const ok = window.confirm(pending ? `Revoke the invite for ${label}?` : `Remove ${label} from this workspace?`);
    if (!ok) return;
    setError(null);
    const res = await fetch(`/api/team/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
      setError(body?.detail ?? body?.error ?? "Could not remove this member.");
      return;
    }
    setNotice(pending ? "Invite revoked." : "Member removed.");
    await load();
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy the link. Select it and copy manually.");
    }
  }

  return (
    <PageContainer
      wide
      title="Team"
      description="Invite teammates to this workspace and control what each role can see and change."
      tooltip="Members share this workspace's data. Owners and admins manage the team; managers, members and viewers get scoped access."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4" aria-hidden />
          {data ? `${data.members.length} member${data.members.length === 1 ? "" : "s"} · your role: ${data.role}` : "Workspace members"}
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading} aria-label="Refresh team">
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="info" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {canEdit && (
        <section className="mb-8 rounded-xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="h-4 w-4" aria-hidden /> Invite a teammate
          </h2>
          <UpgradePrompt metric="seats" className="mt-3" />
          <form onSubmit={(e) => void sendInvite(e)} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-medium text-muted-foreground">
              Email
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground sm:w-40"
              >
                {ASSIGNABLE.filter((r) => canManageRole(myRole, r)).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={inviting || !inviteEmail.trim()}>
              {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Create invite link
            </Button>
          </form>
          {lastLink && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{lastLink}</code>
              <Button size="sm" variant="outline" onClick={() => void copyLink(lastLink)}>
                {copied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Invite links expire after 7 days and can only be used once.</p>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-5 py-3 text-sm font-semibold">Members</header>
        {loading && !data ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading team…
          </div>
        ) : !data || data.members.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.members.map((m) => {
              const manageable = canEdit && !m.isOwner && !m.isSelf && canManageRole(myRole, m.role);
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {m.email ?? (m.isSelf ? "You" : "Member")}
                      {m.isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">Joined {new Date(m.joinedAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.isOwner ? (
                      <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">owner</span>
                    ) : (
                      <select
                        value={m.role}
                        disabled={!manageable}
                        onChange={(e) => void changeRole(m.id, e.target.value as Role)}
                        className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60"
                        aria-label={`Role for ${m.email ?? "member"}`}
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r} disabled={!canManageRole(myRole, r)}>{r}</option>
                        ))}
                      </select>
                    )}
                    {manageable && (
                      <Button size="icon" variant="ghost" aria-label="Remove member" onClick={() => void remove(m.id, m.email ?? "this member", false)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {data && data.invites.length > 0 && (
        <section className="mt-6 rounded-xl border border-border bg-card">
          <header className="border-b border-border px-5 py-3 text-sm font-semibold">Pending invites</header>
          <ul className="divide-y divide-border">
            {data.invites.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{inv.email ?? "Invite"}</p>
                  <p className="text-xs text-muted-foreground">
                    {inv.role} · sent {new Date(inv.createdAt).toLocaleDateString()}
                    {inv.expired && <span className="ml-2 text-destructive">expired</span>}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Link shown once at creation; re-invite to get a new one.</span>
                    <Button size="icon" variant="ghost" aria-label="Revoke invite" onClick={() => void remove(inv.id, inv.email ?? "this invite", true)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}

function Banner({ tone, onDismiss, children }: { tone: "error" | "info"; onDismiss?: () => void; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/30 bg-primary/10 text-foreground"
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 hover:bg-background/60">
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
