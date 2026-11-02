"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, Plus, Copy, Check, Trash2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, Loading } from "@/components/ui/feedback";
import { Checkbox, Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { PageContainer } from "@/components/page-container";
import { AREAS, type Area } from "@/lib/auth/roles";
import { AREA_LABELS, API_AREAS, FULL_ACCESS_SCOPE, readScope, writeScope, type ApiScope } from "@/lib/public-api/scopes";
import { cn } from "@/lib/utils";

interface ApiKeyView {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

const fmtDate = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "Never";

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
    <Button type="button" variant="outline" size="sm" touch onClick={copy} aria-label={label}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** Areas with v1 routes first, then the rest. */
const ORDERED_AREAS: readonly Area[] = [...API_AREAS, ...AREAS.filter((a) => !API_AREAS.includes(a))];

function ScopeGrid({ value, onChange, disabled }: { value: Set<ApiScope>; onChange: (next: Set<ApiScope>) => void; disabled?: boolean }) {
  const full = value.has(FULL_ACCESS_SCOPE);
  function toggle(scope: ApiScope, on: boolean) {
    const next = new Set(value);
    if (on) next.add(scope);
    else next.delete(scope);
    // Writing implies reading; dropping read also drops write.
    const p = /^(read|write):(.+)$/.exec(scope);
    if (p && on && p[1] === "write") next.add(readScope(p[2] as Area));
    if (p && !on && p[1] === "read") next.delete(writeScope(p[2] as Area));
    onChange(next);
  }
  function setAll(mode: "read" | "write" | "none") {
    const next = new Set<ApiScope>();
    if (mode !== "none") {
      for (const a of AREAS) {
        next.add(readScope(a));
        if (mode === "write") next.add(writeScope(a));
      }
    }
    onChange(next);
  }
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1 block text-xs font-medium">Scopes</legend>
      <p className="mb-2 text-xs text-muted-foreground">Grant the least access the client needs. Write includes read.</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={() => setAll("read")}>
          All read
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setAll("write")}>
          All read + write
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAll("none")}>
          Clear
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Area
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
                Read
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
                Write
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ORDERED_AREAS.map((a) => {
              const r = readScope(a);
              const w = writeScope(a);
              const reserved = !API_AREAS.includes(a);
              return (
                <tr key={a} className={cn(reserved && "text-muted-foreground")}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {AREA_LABELS[a]}
                    {reserved && <span className="ml-1 text-[11px]">(no v1 routes yet)</span>}
                  </th>
                  <td className="px-2 py-1 text-center">
                    <Checkbox label={<span className="sr-only">Read {AREA_LABELS[a]}</span>} checked={full || value.has(r)} disabled={full} onChange={(e) => toggle(r, e.target.checked)} labelClassName="justify-center" />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <Checkbox label={<span className="sr-only">Write {AREA_LABELS[a]}</span>} checked={full || value.has(w)} disabled={full} onChange={(e) => toggle(w, e.target.checked)} labelClassName="justify-center" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3">
        <Checkbox
          label={
            <span>
              <span className="font-medium">Full access</span>{" "}
              <span className="text-muted-foreground">
                — for MCP clients (Claude, Cursor); the legacy <code className="rounded bg-muted px-1">mcp</code> scope
              </span>
            </span>
          }
          checked={full}
          onChange={(e) => {
            const next = new Set(value);
            if (e.target.checked) next.add(FULL_ACCESS_SCOPE);
            else next.delete(FULL_ACCESS_SCOPE);
            onChange(next);
          }}
        />
      </div>
    </fieldset>
  );
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(() => new Set<ApiScope>([FULL_ACCESS_SCOPE]));
  const [submitting, setSubmitting] = useState(false);
  const [newKey, setNewKey] = useState<{ key: string; record: ApiKeyView } | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null);
  const [revoking, setRevoking] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = `${origin}/api/mcp`;
  const apiUrl = `${origin}/api/v1`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not load API keys.");
      setKeys(Array.isArray(data?.keys) ? data.keys : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || scopes.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, scopes: [...scopes] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.key) throw new Error(data?.error ?? "Could not create API key.");
      setNewKey({ key: data.key, record: data.record });
      setCreating(false);
      setName("");
      setScopes(new Set<ApiScope>([FULL_ACCESS_SCOPE]));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create API key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    setError(null);
    try {
      const res = await fetch(`/api/api-keys?id=${encodeURIComponent(revokeTarget.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not revoke API key.");
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke API key.");
    } finally {
      setRevoking(false);
    }
  }

  const configSnippet = useMemo(
    () => (newKey ? JSON.stringify({ mcpServers: { kernelhub: { url: mcpUrl, headers: { Authorization: `Bearer ${newKey.key}` } } } }, null, 2) : ""),
    [newKey, mcpUrl]
  );
  const curlSnippet = newKey ? `curl ${apiUrl}/me -H "Authorization: Bearer ${newKey.key}"` : "";

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);

  return (
    <PageContainer
      title="API keys"
      description="Keys authenticate MCP clients (Claude, Cursor) and the REST API. Treat them like passwords."
      tooltip="Each key carries scopes: read/write per area, or full access for MCP clients. Revoking a key stops it immediately."
      actions={
        <Button type="button" size="sm" touch onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> New key
        </Button>
      }
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="h-4 w-4" aria-hidden /> MCP endpoint
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">Point Claude Desktop, Cursor or any MCP client here.</p>
            </div>
            <CopyButton text={mcpUrl} label="Copy MCP endpoint URL" />
          </div>
          <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{mcpUrl}</code>
        </section>
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4" aria-hidden /> REST API base URL
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Reference, scopes and examples on the{" "}
                <Link href="/settings/developers" className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Developers
                </Link>{" "}
                page.
              </p>
            </div>
            <CopyButton text={apiUrl} label="Copy API base URL" />
          </div>
          <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{apiUrl}</code>
        </section>
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Your keys</h2>
          <Button type="button" variant="ghost" size="sm" touch onClick={() => void load()} disabled={loading} aria-label="Refresh keys">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin motion-reduce:animate-none")} aria-hidden />
          </Button>
        </div>

        {loading && keys.length === 0 ? (
          <Loading label="Loading keys…" />
        ) : active.length === 0 ? (
          <Empty
            icon={<KeyRound className="h-5 w-5" aria-hidden />}
            title="No active keys yet"
            text="Create one to connect an MCP client or call the REST API."
            action={
              <Button type="button" size="sm" touch onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> New key
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {active.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{k.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.key_prefix}…</code>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {fmtDate(k.created_at)} · Last used {fmtDate(k.last_used_at)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {k.scopes.includes(FULL_ACCESS_SCOPE) ? (
                      <Pill tone="accent">full access</Pill>
                    ) : k.scopes.length === 0 ? (
                      <Pill tone="warning">no scopes</Pill>
                    ) : (
                      k.scopes.map((s) => (
                        <Pill key={s} tone={s.startsWith("write:") ? "info" : "neutral"}>
                          {s}
                        </Pill>
                      ))
                    )}
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" touch onClick={() => setRevokeTarget(k)} aria-label={`Revoke key ${k.name}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        {revoked.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Revoked keys ({revoked.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {revoked.map((k) => (
                <li key={k.id}>
                  {k.name} ({k.key_prefix}…) · revoked {fmtDate(k.revoked_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {creating && (
        <Dialog title="Create API key" description="Name it after the client that will use it, then choose what it may access." onClose={() => !submitting && setCreating(false)} size="lg">
          <form onSubmit={create} className="space-y-4">
            <Field label="Name" required>
              <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Zapier, Claude Desktop, billing sync…" />
            </Field>
            <ScopeGrid value={scopes} onChange={setScopes} disabled={submitting} />
            {scopes.size === 0 && (
              <p role="alert" className="text-xs text-destructive">
                Pick at least one scope.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" touch onClick={() => setCreating(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" touch disabled={submitting || !name.trim() || scopes.size === 0}>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />} Create key
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      {newKey && (
        <Dialog title="Copy your new key" description="This is the only time the full key is shown. Store it somewhere safe." onClose={() => setNewKey(null)} size="lg">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{newKey.key}</code>
            <CopyButton text={newKey.key} label="Copy API key" />
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-xs font-medium">REST API example</span>
            <CopyButton text={curlSnippet} label="Copy curl example" />
          </div>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 text-xs">{curlSnippet}</pre>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-xs font-medium">MCP client config</span>
            <CopyButton text={configSnippet} label="Copy MCP client config" />
          </div>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{configSnippet}</pre>
          <DialogFooter>
            <Button type="button" touch onClick={() => setNewKey(null)}>
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {revokeTarget && (
        <Dialog title={`Revoke “${revokeTarget.name}”?`} description="Any client using this key will stop working immediately. This cannot be undone." onClose={() => !revoking && setRevokeTarget(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="ghost" touch onClick={() => setRevokeTarget(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch onClick={revoke} disabled={revoking}>
              {revoking && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />} Revoke
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}
