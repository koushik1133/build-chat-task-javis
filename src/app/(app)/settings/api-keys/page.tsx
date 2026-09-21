"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, AlertTriangle, Plus, Copy, Check, Trash2, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
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
    <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={label}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [newKey, setNewKey] = useState<{ key: string; record: ApiKeyView } | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null);
  const [revoking, setRevoking] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = `${origin}/api/mcp`;

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
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, scopes: ["mcp"] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.key) throw new Error(data?.error ?? "Could not create API key.");
      setNewKey({ key: data.key, record: data.record });
      setCreating(false);
      setName("");
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

  const configSnippet = newKey
    ? JSON.stringify(
        {
          mcpServers: {
            kernelhub: {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${newKey.key}` },
            },
          },
        },
        null,
        2
      )
    : "";

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);

  return (
    <PageContainer
      title="API keys"
      description="Connect Claude, Cursor, or any MCP client to your workspace. Keys carry the same permissions as your account, so treat them like passwords."
      tooltip="MCP (Model Context Protocol) lets external AI tools call your workspace tools securely."
    >
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="rounded p-0.5 hover:bg-red-500/10">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4" /> MCP endpoint
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Point your MCP client here and authenticate with a key below.</p>
          </div>
          <CopyButton text={mcpUrl} label="Copy MCP endpoint URL" />
        </div>
        <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{mcpUrl}</code>
      </section>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Your keys</h2>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh keys">
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New key
            </Button>
          </div>
        </div>

        {loading && keys.length === 0 ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading keys…
          </div>
        ) : active.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No active keys yet. Create one to connect an MCP client.
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {active.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{k.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.key_prefix}…</code>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {fmtDate(k.created_at)} · Last used {fmtDate(k.last_used_at)}
                    {k.scopes.length > 0 && <> · Scopes: {k.scopes.join(", ")}</>}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setRevokeTarget(k)} aria-label={`Revoke key ${k.name}`}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        {revoked.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Revoked keys ({revoked.length})</summary>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !submitting && setCreating(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-key-title"
            onSubmit={create}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
          >
            <h3 id="create-key-title" className="text-base font-semibold">Create API key</h3>
            <p className="mt-1 text-xs text-muted-foreground">Give it a name you will recognise, like the client that will use it.</p>
            <label className="mt-4 block text-xs font-medium" htmlFor="key-name">Name</label>
            <input
              id="key-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              placeholder="Claude Desktop"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setCreating(false)} disabled={submitting}>Cancel</Button>
              <Button type="submit" disabled={submitting || !name.trim()}>
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Create
              </Button>
            </div>
          </form>
        </div>
      )}

      {newKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="new-key-title" className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 id="new-key-title" className="text-base font-semibold">Copy your new key</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              This is the only time the full key is shown. Store it somewhere safe.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{newKey.key}</code>
              <CopyButton text={newKey.key} label="Copy API key" />
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs font-medium">MCP client config</span>
              <CopyButton text={configSnippet} label="Copy MCP client config" />
            </div>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{configSnippet}</pre>
            <div className="mt-5 flex justify-end">
              <Button type="button" onClick={() => setNewKey(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}

      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !revoking && setRevokeTarget(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="revoke-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 id="revoke-title" className="text-base font-semibold">Revoke “{revokeTarget.name}”?</h3>
            <p className="mt-1 text-sm text-muted-foreground">Any client using this key will stop working immediately. This cannot be undone.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRevokeTarget(null)} disabled={revoking}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={revoke} disabled={revoking}>
                {revoking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Revoke
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
