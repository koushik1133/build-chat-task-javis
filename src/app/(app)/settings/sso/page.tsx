"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";

interface TokenView { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface TokensResponse { tokens: TokenView[]; baseUrl: string; canEdit: boolean; sso: { enabled: boolean; supabaseUrl: string } }
interface DomainRow {
  id: string; domain: string; provider_id: string | null; created_at: string;
  verified_at: string | null; last_verify_error: string | null;
  record: { host: string; value: string } | null;
}

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const fmtDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "Never");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const fieldErr = data?.detail?.fieldErrors ? Object.entries(data.detail.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`)[0] : null;
    throw new Error(data?.detail?.formErrors?.[0] ?? fieldErr ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" touch onClick={() => void copy()} aria-label={label}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
      <dt className="w-40 shrink-0 text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-secondary/60 px-2 py-1 font-mono text-xs">{value || "—"}</code>
        {value && <CopyButton text={value} label={`Copy ${label}`} />}
      </dd>
    </div>
  );
}

export default function SsoSettingsPage() {
  const [data, setData] = useState<TokensResponse | null>(null);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ token: string; record: TokenView } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [providerInput, setProviderInput] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<TokenView | null>(null);
  const [domainTarget, setDomainTarget] = useState<DomainRow | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [t, d] = await Promise.all([
        api<TokensResponse>("/api/scim/tokens", { signal }),
        api<{ domains: DomainRow[] }>("/api/sso/domains", { signal }).catch((e) => {
          if (isAbortError(e)) throw e;
          return { domains: [] as DomainRow[] };
        }),
      ]);
      setData(t);
      setDomains(d.domains);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load SSO settings.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(t: TokenView) {
    setBusyId(t.id);
    setError(null);
    try {
      await api(`/api/scim/tokens?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
      setNotice(`Revoked ${t.name}.`);
      setRevokeTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke the token.");
    } finally {
      setBusyId(null);
    }
  }

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    setAddingDomain(true);
    setError(null);
    try {
      const body: Record<string, string> = { domain: domainInput.trim().toLowerCase() };
      if (providerInput.trim()) body.providerId = providerInput.trim();
      await api("/api/sso/domains", { method: "POST", body: JSON.stringify(body) });
      setDomainInput("");
      setProviderInput("");
      setNotice("Domain saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the domain.");
    } finally {
      setAddingDomain(false);
    }
  }

  async function verifyDomain(d: DomainRow) {
    setBusyId(d.id);
    setError(null);
    try {
      const r = await api<{ verified: boolean; domain: { last_verify_error: string | null } }>(`/api/sso/domains/${encodeURIComponent(d.id)}/verify`, { method: "POST" });
      setNotice(r.verified ? `${d.domain} is verified. Logins for this domain now route to SSO.` : `Could not verify ${d.domain} yet: ${r.domain.last_verify_error ?? "TXT record not found"}. DNS changes can take a few minutes.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the domain.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeDomain(d: DomainRow) {
    setBusyId(d.id);
    setError(null);
    try {
      await api(`/api/sso/domains?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
      setNotice(`Removed ${d.domain}.`);
      setDomainTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the domain.");
    } finally {
      setBusyId(null);
    }
  }

  const canEdit = data?.canEdit ?? false;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const supabaseUrl = data?.sso.supabaseUrl ?? "";
  const live = data?.tokens.filter((t) => !t.revoked_at) ?? [];
  const verifiedDomains = domains.filter((d) => d.verified_at);
  const ssoReady = Boolean(data?.sso.enabled && supabaseUrl && verifiedDomains.length > 0);

  return (
    <PageContainer
      title="SSO & SCIM"
      description="Let your identity provider sign people in and provision them automatically."
      tooltip="SCIM lets Okta, Entra ID or Google provision and deprovision members. SSO uses Supabase SAML so your team signs in with the company identity provider."
      actions={
        <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh SSO settings">
          {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      }
    >
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {loading && !data ? (
        <SkeletonList count={3} itemClassName="h-28" label="Loading SSO settings…" />
      ) : !data && error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data ? (
        <div className="space-y-8" aria-busy={loading || undefined}>
          {/* SCIM */}
          <section aria-labelledby="scim-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="scim-heading" className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="h-4 w-4" aria-hidden /> SCIM 2.0 provisioning
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Paste the base URL and a bearer token into your identity provider. Provisioned users receive an invite email; deactivation removes them.</p>
              </div>
              {canEdit && (
                <Button touch onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Generate token
                </Button>
              )}
            </div>
            <dl className="mt-4 divide-y divide-border">
              <Row label="SCIM base URL" value={data.baseUrl} />
              <Row label="Authentication" value="OAuth Bearer Token (header: Authorization: Bearer <token>)" />
              <Row label="Supported" value="Users (GET, POST, PUT, PATCH, DELETE), Groups = roles (GET, PATCH members), filter userName eq" />
            </dl>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tokens</h3>
            {data.tokens.length === 0 ? (
              <Empty
                className="mt-2 py-8"
                icon={<KeyRound className="h-5 w-5" aria-hidden />}
                title="No SCIM tokens yet"
                text="Generate one and paste it into your identity provider. It is shown only once."
                action={
                  canEdit ? (
                    <Button touch onClick={() => setCreating(true)}>
                      <Plus className="h-4 w-4" aria-hidden /> Generate token
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {data.tokens.map((t) => (
                  <li key={t.id} className={cn("flex flex-wrap items-center justify-between gap-3 px-3 py-2.5", t.revoked_at && "opacity-60")}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 break-words text-sm font-medium">
                        {t.name} {t.revoked_at ? <Pill tone="neutral">Revoked</Pill> : <Pill tone="success">Active</Pill>}
                      </p>
                      <p className="text-xs text-muted-foreground">Created {fmtDate(t.created_at)} · Last used {fmtDate(t.last_used_at)}</p>
                    </div>
                    {canEdit && !t.revoked_at && (
                      <Button size="sm" variant="ghost" touch disabled={busyId === t.id} onClick={() => setRevokeTarget(t)} aria-label={`Revoke ${t.name}`}>
                        {busyId === t.id ? spinner : <Trash2 className="h-3.5 w-3.5" aria-hidden />} Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {live.length > 1 && <p className="mt-2 text-xs text-muted-foreground">{live.length} active tokens. Revoke ones you no longer use.</p>}
          </section>

          {/* SSO */}
          <section aria-labelledby="sso-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="sso-heading" className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4" aria-hidden /> Single sign-on (SAML)
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Sign-in is handled by Supabase Auth SAML. Register your identity provider with these values, then map your email domains below.</p>
              </div>
              <div className="flex items-center gap-2" role="status">
                <span className={cn("h-2.5 w-2.5 rounded-full", ssoReady ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
                <span className="text-xs font-medium">{ssoReady ? "Sign in with SSO is ready" : "Sign in with SSO is not ready"}</span>
              </div>
            </div>

            <ol className="mt-4 space-y-1.5 text-sm">
              <Check1 ok={Boolean(data.sso.enabled)} text="SSO_ENABLED=1 is set on the server (shows the “Sign in with SSO” button on the login page)." />
              <Check1 ok={Boolean(supabaseUrl)} text="NEXT_PUBLIC_SUPABASE_URL is configured." />
              <Check1 ok={verifiedDomains.length > 0} text="At least one email domain is mapped and DNS-verified below." />
              <Check1 ok={false} text="SAML provider added in Supabase (CLI: supabase sso add --type saml --metadata-url … --domains …). Not checked automatically." neutral />
            </ol>

            <dl className="mt-4 divide-y divide-border">
              <Row label="ACS URL" value={supabaseUrl ? `${supabaseUrl}/auth/v1/sso/saml/acs` : ""} />
              <Row label="Entity ID" value={supabaseUrl ? `${supabaseUrl}/auth/v1/sso/saml/metadata` : ""} />
              <Row label="SP metadata" value={supabaseUrl ? `${supabaseUrl}/auth/v1/sso/saml/metadata?download=true` : ""} />
              <Row label="Redirect / callback" value={origin ? `${origin}/auth/callback` : ""} />
              <Row label="NameID format" value="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" />
            </dl>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email domains</h3>
            <p className="mt-1 text-sm text-muted-foreground">When someone enters an email with one of these domains and clicks “Sign in with SSO”, they are sent to your identity provider. A domain only routes logins once you prove ownership by publishing the TXT record shown.</p>
            {canEdit && (
              <form onSubmit={(e) => void addDomain(e)} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label="Domain" className="flex-1">
                  <Input value={domainInput} onChange={(e) => setDomainInput(e.target.value)} required placeholder="company.com" maxLength={253} inputMode="url" autoCapitalize="none" />
                </Field>
                <Field label="Provider ID" hint="Optional. The Supabase SSO provider UUID; domain lookup is used when empty." className="flex-1">
                  <Input value={providerInput} onChange={(e) => setProviderInput(e.target.value)} placeholder="uuid" maxLength={100} />
                </Field>
                <Button type="submit" touch disabled={addingDomain || !domainInput.trim()}>
                  {addingDomain ? spinner : <Globe2 className="h-4 w-4" aria-hidden />} Add domain
                </Button>
              </form>
            )}
            {domains.length === 0 ? (
              <Empty className="mt-3 py-8" icon={<Globe2 className="h-5 w-5" aria-hidden />} title="No domains mapped" text={canEdit ? "Add your company email domain above so the login page can route people to SSO." : "An admin needs to add your company email domain so the login page can route people to SSO."} />
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                {domains.map((d) => (
                  <li key={d.id} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
                          <span className="break-all">{d.domain}</span>
                          {d.verified_at ? <Pill tone="success">Verified</Pill> : <Pill tone="warning">Pending verification</Pill>}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">
                          {d.provider_id ? `Provider ${d.provider_id}` : "Resolved by domain"} · added {fmtDate(d.created_at)}
                          {d.verified_at ? ` · verified ${fmtDate(d.verified_at)}` : ""}
                        </p>
                      </div>
                      {canEdit && (
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant={d.verified_at ? "ghost" : "outline"} touch disabled={busyId === d.id} onClick={() => void verifyDomain(d)} aria-label={`${d.verified_at ? "Re-check" : "Verify"} ${d.domain}`}>
                            {busyId === d.id ? spinner : <BadgeCheck className="h-3.5 w-3.5" aria-hidden />} {d.verified_at ? "Re-check" : "Verify"}
                          </Button>
                          <Button size="sm" variant="ghost" touch disabled={busyId === d.id} onClick={() => setDomainTarget(d)} aria-label={`Remove ${d.domain}`}>
                            {busyId === d.id ? spinner : <Trash2 className="h-3.5 w-3.5" aria-hidden />} Remove
                          </Button>
                        </div>
                      )}
                    </div>
                    {!d.verified_at && d.record && (
                      <dl className="mt-2 rounded-md border border-dashed border-border bg-secondary/30 px-3">
                        <Row label="TXT record host" value={d.record.host} />
                        <Row label="TXT record value" value={d.record.value} />
                        {d.last_verify_error && <p role="status" className="pb-2 text-xs text-amber-800 dark:text-amber-300 [overflow-wrap:anywhere]">Last check: {d.last_verify_error}</p>}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setNewToken(t);
            void load();
          }}
        />
      )}
      {revokeTarget && (
        <Dialog title={`Revoke “${revokeTarget.name}”?`} description="Your identity provider will stop being able to provision or deprovision users with this token. This cannot be undone." onClose={() => busyId !== revokeTarget.id && setRevokeTarget(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="ghost" touch onClick={() => setRevokeTarget(null)} disabled={busyId === revokeTarget.id}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch onClick={() => void revoke(revokeTarget)} disabled={busyId === revokeTarget.id}>
              {busyId === revokeTarget.id && spinner} Revoke token
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {domainTarget && (
        <Dialog title={`Remove ${domainTarget.domain}?`} description="People with that email domain will no longer be offered single sign-on on the login page." onClose={() => busyId !== domainTarget.id && setDomainTarget(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="ghost" touch onClick={() => setDomainTarget(null)} disabled={busyId === domainTarget.id}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch onClick={() => void removeDomain(domainTarget)} disabled={busyId === domainTarget.id}>
              {busyId === domainTarget.id && spinner} Remove domain
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {newToken && (
        <Dialog title="Your SCIM token" description="Copy it now. For security it is never shown again." onClose={() => setNewToken(null)} size="sm">
          <div className="space-y-3">
            <Banner tone="warn">Store this token in your identity provider only. Anyone holding it can add and remove members.</Banner>
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{newToken.token}</code>
              <CopyButton text={newToken.token} label="Copy SCIM token" />
            </div>
            <p className="text-xs text-muted-foreground">Base URL: <code className="break-all font-mono">{data?.baseUrl}</code></p>
            <DialogFooter>
              <Button touch onClick={() => setNewToken(null)}>Done</Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
    </PageContainer>
  );
}

function Check1({ ok, text, neutral }: { ok: boolean; text: string; neutral?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={cn("mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", neutral ? "bg-secondary text-muted-foreground" : ok ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/15 text-amber-800 dark:text-amber-300")}
        aria-hidden
      >
        {neutral ? "?" : ok ? "✓" : "!"}
      </span>
      <span className="sr-only">{neutral ? "Manual step:" : ok ? "Done:" : "Missing:"}</span>
      <span>{text}</span>
    </li>
  );
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: { token: string; record: TokenView }) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; record: TokenView }>("/api/scim/tokens", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      onCreated(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the token.");
      setBusy(false);
    }
  }
  return (
    <Dialog title="Generate SCIM token" description="Name it after the identity provider that will use it." onClose={onClose} size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Name" required>
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Okta production" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={busy || !name.trim()}>{busy && spinner} Generate</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
