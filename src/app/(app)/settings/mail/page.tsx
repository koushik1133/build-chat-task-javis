"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FlaskConical, Inbox, Loader2, Mail, Plug, RefreshCw, Trash2 } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import type { MailAccountView, MailProviderInfo, MailProviderId } from "@/lib/mail/types";
import { timeAgo } from "@/lib/utils";

const STATUS_TONE: Record<string, Tone> = { connected: "success", error: "danger", disabled: "neutral" };

const PROVIDER_BLURB: Record<MailProviderId, string> = {
  gmail: "Sign in with Google. New inbox mail is pulled every 2 minutes and replies go out from this address.",
  outlook: "Sign in with Microsoft. Works with Outlook.com and Microsoft 365 mailboxes.",
  imap: "Generic IMAP/SMTP mailboxes.",
  simulated: "A fake mailbox for demos and development — push test emails into it below.",
};

type Notice = { tone: "success" | "error" | "info"; text: string };

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : `${fallback} (${res.status})`;
}

export default function MailSettingsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Email Inbox">
          <Loading label="Loading mailboxes…" />
        </PageContainer>
      }
    >
      <MailSettingsInner />
    </Suspense>
  );
}

function MailSettingsInner() {
  const router = useRouter();
  const search = useSearchParams();
  const nextSignal = useAbortable();

  const [accounts, setAccounts] = useState<MailAccountView[]>([]);
  const [providers, setProviders] = useState<MailProviderInfo[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<MailAccountView | null>(null);
  const [tester, setTester] = useState<MailAccountView | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mail/accounts", { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load mailboxes."));
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setProviders(Array.isArray(data.providers) ? data.providers : []);
      setMigrated(data.migrated !== false);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load mailboxes.");
    } finally {
      setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  // OAuth callback lands here with ?connected= or ?error=.
  useEffect(() => {
    const connected = search.get("connected");
    const err = search.get("error");
    if (!connected && !err) return;
    if (err) setNotice({ tone: "error", text: err });
    else setNotice({ tone: "success", text: `${connected === "simulated" ? "Simulated inbox" : "Mailbox"} connected. A first sync has run.` });
    router.replace("/settings/mail");
  }, [search, router]);

  async function syncNow(a: MailAccountView) {
    setBusy(`sync:${a.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/mail/accounts/${encodeURIComponent(a.id)}/sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Sync failed (${res.status})`);
      setNotice({ tone: "success", text: `Synced ${a.email}: ${data.imported ?? 0} new, ${data.skipped ?? 0} already known${data.replied ? `, ${data.replied} auto-replied` : ""}.` });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Sync failed." });
    } finally {
      setBusy(null);
    }
  }

  async function confirmDisconnect() {
    if (!disconnect) return;
    setBusy(`del:${disconnect.id}`);
    try {
      const res = await fetch(`/api/mail/accounts?id=${encodeURIComponent(disconnect.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not disconnect."));
      setNotice({ tone: "info", text: `${disconnect.email} disconnected.` });
      setDisconnect(null);
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Email Inbox"
      icon={<Mail className="h-5 w-5" aria-hidden />}
      description="Connect mailboxes so customer email lands in Messages next to SMS and WhatsApp, with the AI receptionist drafting replies."
      tooltip="Each connected mailbox is synced every 2 minutes. Threads become conversations in Messages; replies you type there go back out through the same mailbox."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/messaging">Open Messages</Link>
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}
      {!migrated && !loading && (
        <Banner tone="warn">
          The mail tables are missing. Apply <code className="font-mono">aws/phase4/d.sql</code> to enable mailbox sync.
        </Banner>
      )}

      <section aria-labelledby="providers-heading" className="mb-8">
        <h2 id="providers-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Connect a mailbox
        </h2>
        {loading && providers.length === 0 ? (
          <Loading label="Checking providers…" />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Mail providers">
            {providers.map((p) => (
              <li key={p.id} className="flex flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-medium">{p.label}</span>
                  <Pill tone={p.configured ? "success" : "neutral"}>{p.configured ? "ready" : "not configured"}</Pill>
                </div>
                <p className="mb-4 flex-1 text-xs text-muted-foreground">{PROVIDER_BLURB[p.id]}</p>
                {p.configured ? (
                  <Button asChild size="sm" touch disabled={!migrated}>
                    <a href={`/api/mail/connect/${p.id}`} aria-label={`Connect ${p.label}`}>
                      <Plug className="h-3.5 w-3.5" aria-hidden />
                      {p.id === "simulated" ? "Create simulated inbox" : `Connect ${p.label}`}
                    </a>
                  </Button>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300" role="note">
                    {p.reason ?? "Not available."}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="accounts-heading">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="accounts-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Connected mailboxes
          </h2>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh mailboxes">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Refresh
          </Button>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : loading && accounts.length === 0 ? (
          <Loading label="Loading mailboxes…" />
        ) : accounts.length === 0 ? (
          <Empty
            icon={<Inbox className="h-5 w-5" />}
            title="No mailboxes connected"
            text="Connect Gmail or Outlook above, or create a simulated inbox to try the flow without any credentials."
          />
        ) : (
          <TableScroller label="Connected mailboxes">
            <table className="w-full min-w-[720px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Mailbox</th>
                  <th className={TH}>Provider</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Messages</th>
                  <th className={TH}>Last sync</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{a.email}</div>
                      {a.display_name && <div className="text-xs text-muted-foreground">{a.display_name}</div>}
                    </td>
                    <td className="px-3 py-2 capitalize">{a.provider}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={a.status} map={STATUS_TONE} />
                      {a.last_error && (
                        <div className="mt-1 max-w-xs text-xs text-red-700 dark:text-red-300 [overflow-wrap:anywhere]" title={a.last_error}>
                          {a.last_error.slice(0, 120)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{a.message_count}</td>
                    <td className="px-3 py-2 text-muted-foreground">{a.last_sync_at ? timeAgo(a.last_sync_at) : "Never"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {a.provider === "simulated" && (
                          <Button size="sm" variant="outline" onClick={() => setTester(a)}>
                            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
                            Test email
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => void syncNow(a)} disabled={busy !== null} aria-label={`Sync ${a.email} now`}>
                          {busy === `sync:${a.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                          Sync now
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDisconnect(a)} disabled={busy !== null} aria-label={`Disconnect ${a.email}`}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Disconnect
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {disconnect && (
        <Dialog title={`Disconnect ${disconnect.email}?`} description="Synced messages for this mailbox are removed from the inbox. Existing conversations stay but can no longer be replied to by email." onClose={() => setDisconnect(null)} size="sm">
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnect(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDisconnect()} disabled={busy !== null}>
              {busy === `del:${disconnect.id}` && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Disconnect
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {tester && (
        <SimulateMailDialog
          account={tester}
          onClose={() => setTester(null)}
          onDone={(text) => {
            setTester(null);
            setNotice({ tone: "success", text });
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

function SimulateMailDialog({ account, onClose, onDone }: { account: MailAccountView; onClose: () => void; onDone: (text: string) => void }) {
  const [from, setFrom] = useState("jane.doe@example.com");
  const [subject, setSubject] = useState("Quote for a kitchen remodel");
  const [body, setBody] = useState("Hi,\n\nCould you send me a quote for a ~20 m² kitchen remodel? We're hoping to start next month.\n\nThanks,\nJane");
  const [thread, setThread] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/mail/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, from: from.trim(), subject: subject.trim(), body: body.trim(), ...(thread.trim() ? { threadId: thread.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not simulate that email.");
      onDone(`Delivered to the simulated inbox: ${data.imported ?? 0} new message${data.replied ? ", auto-replied by the receptionist" : ""}. Open Messages to see the thread.`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not simulate that email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Send a test email" description={`Pushes an inbound email into ${account.email} and runs the receptionist, exactly like a real mailbox sync.`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From" required>
            <Input type="email" value={from} onChange={(e) => setFrom(e.target.value)} required maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Thread id" hint="Optional — reuse one to append to an existing thread.">
            <Input value={thread} onChange={(e) => setThread(e.target.value)} maxLength={200} autoComplete="off" />
          </Field>
        </div>
        <Field label="Subject" required>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} />
        </Field>
        <Field label="Body" required>
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={10_000} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !from.trim() || !subject.trim() || !body.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? "Delivering…" : "Deliver to inbox"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
