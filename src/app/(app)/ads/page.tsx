"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Megaphone, RefreshCw, Plus, Trash2, Loader2, AlertTriangle,
  TrendingUp, MousePointerClick, Eye, DollarSign, Target, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";

type PlatformId = "meta_ads" | "google_ads";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
};

const PLATFORM_STYLE: Record<PlatformId, string> = {
  meta_ads: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  google_ads: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
};

interface AdAccount {
  id: string;
  platform: PlatformId;
  account_id: string;
  account_name: string | null;
  connected: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
  has_token: boolean;
}

interface Totals {
  impressions: number; reach: number; clicks: number; spend: number;
  conversions: number; conversionValue: number;
  ctr: number; cpc: number; cpm: number; cpa: number; roas: number;
}

interface Campaign extends Totals { id: string; name: string; platform: PlatformId }
interface SeriesPoint extends Totals { date: string }

interface Report {
  since: string; until: string; days: number; hasData: boolean;
  totals: Totals;
  series: SeriesPoint[];
  platforms: (Totals & { platform: PlatformId })[];
  campaigns: Campaign[];
}

const RANGES = [7, 30, 90];

const fmtInt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtMoney = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    .format(n || 0);
const fmtPct = (n: number) => `${(n || 0).toFixed(2)}%`;

export default function AdsPage() {
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState<PlatformId | "all">("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [encryptionReady, setEncryptionReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/ads/accounts");
      if (!res.ok) throw new Error("Could not load connected ad accounts.");
      const data = await res.json();
      setAccounts(data.accounts ?? []);
      setEncryptionReady(data.encryptionReady !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load connected ad accounts.");
    }
  }, []);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (platform !== "all") qs.set("platform", platform);
      const res = await fetch(`/api/ads?${qs.toString()}`);
      if (!res.ok) throw new Error("Could not load ad performance.");
      setReport(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load ad performance.");
    } finally {
      setLoading(false);
    }
  }, [days, platform]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void loadReport(); }, [loadReport]);

  async function syncNow() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/ads/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Sync failed.");

      if (data.failed?.length) {
        setError(
          `${data.failed.length} account(s) failed to sync: ${data.failed
            .map((f: { platform: string; error: string }) => `${PLATFORM_LABEL[f.platform as PlatformId] ?? f.platform} — ${f.error}`)
            .join("; ")}`
        );
      } else {
        setNotice(`Synced ${data.synced} account(s), ${fmtInt(data.rows)} rows.`);
      }
      await Promise.all([loadAccounts(), loadReport()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect(account: AdAccount) {
    const label = account.account_name || account.account_id;
    if (!confirm(`Disconnect ${label}? Its stored performance data will be removed.`)) return;
    try {
      const res = await fetch(`/api/ads/accounts?id=${encodeURIComponent(account.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not disconnect that account.");
      await Promise.all([loadAccounts(), loadReport()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect that account.");
    }
  }

  const totals = report?.totals;
  const maxSpend = Math.max(1, ...(report?.series ?? []).map((p) => p.spend));

  return (
    <PageContainer
      wide
      title="Ads"
      description="Meta and Google campaign performance in one report."
      tooltip="Connect your ad accounts, then sync to pull daily spend, clicks and conversions into a single unified view."
    >
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Date range">
            {RANGES.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  days === d ? "bg-foreground text-background" : "hover:bg-muted"
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          <label className="sr-only" htmlFor="ads-platform">Platform</label>
          <select
            id="ads-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as PlatformId | "all")}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="all">All platforms</option>
            <option value="meta_ads">Meta Ads</option>
            <option value="google_ads">Google Ads</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={syncNow} disabled={syncing || accounts.length === 0}>
            {syncing
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
          <Button onClick={() => setShowConnect(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden /> Connect
          </Button>
        </div>
      </div>

      {!encryptionReady && (
        <Banner tone="warn">
          Credential encryption is not configured, so new ad accounts cannot be connected.
          Set <code className="font-mono">CREDENTIAL_ENCRYPTION_KEY</code> in your environment.
        </Banner>
      )}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="ok" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label="Spend" value={fmtMoney(totals?.spend ?? 0)} icon={DollarSign} loading={loading} />
        <Tile label="Impressions" value={fmtInt(totals?.impressions ?? 0)} icon={Eye} loading={loading} />
        <Tile label="Clicks" value={fmtInt(totals?.clicks ?? 0)} icon={MousePointerClick} loading={loading} />
        <Tile label="CTR" value={fmtPct(totals?.ctr ?? 0)} icon={TrendingUp} loading={loading} />
        <Tile label="Conversions" value={fmtInt(totals?.conversions ?? 0)} icon={Target} loading={loading} />
        <Tile label="ROAS" value={`${(totals?.roas ?? 0).toFixed(2)}×`} icon={TrendingUp} loading={loading} />
      </div>

      {!loading && accounts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Megaphone className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
          <h2 className="font-semibold">No ad accounts connected</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Connect a Meta Ads or Google Ads account to pull spend, clicks and conversions
            into one report.
          </p>
          <Button className="mt-4" onClick={() => setShowConnect(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden /> Connect an account
          </Button>
        </div>
      )}

      {!loading && accounts.length > 0 && report && !report.hasData && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <h2 className="font-semibold">No data for this range</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run a sync to pull the last {days} days from your connected accounts.
          </p>
        </div>
      )}

      {report?.hasData && (
        <section className="mb-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">Daily spend</h2>
          <div className="flex h-40 items-end gap-1 overflow-x-auto">
            {report.series.map((p) => (
              <div
                key={p.date}
                className="group relative flex min-w-[6px] flex-1 flex-col justify-end"
                title={`${p.date} — ${fmtMoney(p.spend)}, ${fmtInt(p.clicks)} clicks`}
              >
                <div
                  className="rounded-t bg-foreground/80 transition-colors group-hover:bg-foreground"
                  style={{ height: `${Math.max(2, (p.spend / maxSpend) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {report.since} → {report.until}
          </p>
        </section>
      )}

      {report?.hasData && report.campaigns.length > 0 && (
        <section className="mb-6 rounded-xl border border-border bg-card">
          <h2 className="border-b border-border px-5 py-4 font-semibold">Campaigns</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="px-5 py-3">Campaign</th>
                  <th scope="col" className="px-3 py-3 text-right">Spend</th>
                  <th scope="col" className="px-3 py-3 text-right">Impr.</th>
                  <th scope="col" className="px-3 py-3 text-right">Clicks</th>
                  <th scope="col" className="px-3 py-3 text-right">CTR</th>
                  <th scope="col" className="px-3 py-3 text-right">CPC</th>
                  <th scope="col" className="px-3 py-3 text-right">Conv.</th>
                  <th scope="col" className="px-5 py-3 text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {report.campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{c.name}</div>
                      <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs", PLATFORM_STYLE[c.platform])}>
                        {PLATFORM_LABEL[c.platform]}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">{fmtMoney(c.spend)}</td>
                    <td className="px-3 py-3 text-right">{fmtInt(c.impressions)}</td>
                    <td className="px-3 py-3 text-right">{fmtInt(c.clicks)}</td>
                    <td className="px-3 py-3 text-right">{fmtPct(c.ctr)}</td>
                    <td className="px-3 py-3 text-right">{fmtMoney(c.cpc)}</td>
                    <td className="px-3 py-3 text-right">{fmtInt(c.conversions)}</td>
                    <td className="px-5 py-3 text-right">{c.roas.toFixed(2)}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {accounts.length > 0 && (
        <section className="rounded-xl border border-border bg-card">
          <h2 className="border-b border-border px-5 py-4 font-semibold">Connected accounts</h2>
          <ul className="divide-y divide-border">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.account_name || a.account_id}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", PLATFORM_STYLE[a.platform])}>
                      {PLATFORM_LABEL[a.platform]}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {a.account_id}
                    {a.last_synced_at
                      ? ` • last synced ${new Date(a.last_synced_at).toLocaleString()}`
                      : " • never synced"}
                  </p>
                  {a.last_sync_error && (
                    <p className="mt-1 flex items-start gap-1 text-xs text-red-600 dark:text-red-400">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      <span className="break-words">{a.last_sync_error}</span>
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={() => disconnect(a)}
                  aria-label={`Disconnect ${a.account_name || a.account_id}`}
                  className="shrink-0"
                >
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Disconnect
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showConnect && (
        <ConnectDialog
          onClose={() => setShowConnect(false)}
          onConnected={async () => {
            setShowConnect(false);
            await loadAccounts();
          }}
        />
      )}
    </PageContainer>
  );
}

function Banner({
  tone, children, onDismiss,
}: {
  tone: "error" | "warn" | "ok";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
    warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  }[tone];

  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm", styles)}>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

function Tile({
  label, value, icon: Icon, loading,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <p className="mt-2 truncate text-xl font-semibold tabular-nums" title={value}>
        {loading ? <span className="text-muted-foreground">—</span> : value}
      </p>
    </div>
  );
}

function ConnectDialog({
  onClose, onConnected,
}: {
  onClose: () => void;
  onConnected: () => void | Promise<void>;
}) {
  const [platform, setPlatform] = useState<PlatformId>("meta_ads");
  const [accountId, setAccountId] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [developerToken, setDeveloperToken] = useState("");
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/ads/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          account_id: accountId.trim(),
          account_name: accountName.trim() || undefined,
          access_token: accessToken.trim(),
          developer_token: platform === "google_ads" ? developerToken.trim() : undefined,
          login_customer_id: loginCustomerId.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not connect that account.");
      await onConnected();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not connect that account.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-ads-title"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="connect-ads-title" className="text-lg font-semibold">Connect an ad account</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="opacity-70 hover:opacity-100">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {err && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {err}
          </p>
        )}

        <div>
          <label htmlFor="platform" className="mb-1 block text-sm font-medium">Platform</label>
          <select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value as PlatformId)} className={inputClass}>
            <option value="meta_ads">Meta Ads</option>
            <option value="google_ads">Google Ads</option>
          </select>
        </div>

        <div>
          <label htmlFor="accountId" className="mb-1 block text-sm font-medium">
            {platform === "meta_ads" ? "Ad account ID" : "Customer ID"}
          </label>
          <input id="accountId" required value={accountId} onChange={(e) => setAccountId(e.target.value)}
            placeholder={platform === "meta_ads" ? "act_1234567890" : "123-456-7890"} className={inputClass} />
        </div>

        <div>
          <label htmlFor="accountName" className="mb-1 block text-sm font-medium">
            Label <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input id="accountName" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Main brand account" className={inputClass} />
        </div>

        <div>
          <label htmlFor="accessToken" className="mb-1 block text-sm font-medium">Access token</label>
          <input id="accessToken" required type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} className={inputClass} />
          <p className="mt-1 text-xs text-muted-foreground">Stored encrypted and never sent back to the browser.</p>
        </div>

        {platform === "google_ads" && (
          <>
            <div>
              <label htmlFor="developerToken" className="mb-1 block text-sm font-medium">Developer token</label>
              <input id="developerToken" required type="password" autoComplete="off" value={developerToken} onChange={(e) => setDeveloperToken(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="loginCustomerId" className="mb-1 block text-sm font-medium">
                Manager account ID <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input id="loginCustomerId" value={loginCustomerId} onChange={(e) => setLoginCustomerId(e.target.value)} placeholder="123-456-7890" className={inputClass} />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {saving ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </div>
  );
}
