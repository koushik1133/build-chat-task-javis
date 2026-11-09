"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Fingerprint, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Loading } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { timeAgo } from "@/lib/utils";

/** Client-portal "Privacy" tab: consent toggles, download my data, request deletion — via /api/p/portal/[token]/privacy. */

type Consent = { purpose: string; label: string; granted: boolean; at: string | null };
type Req = { id: string; kind: string; status: string; requested_at: string; due_at: string; completed_at: string | null };
type Data = {
  consents: Consent[];
  requests: Req[];
  notice_path: string | null;
  grievance: { name: string | null; email: string | null; response_days: number };
  auto_fulfil_access: boolean;
};

const STATUS_TONE: Record<string, Tone> = { received: "info", verifying: "info", in_progress: "warning", completed: "success", rejected: "danger" };

function downloadJson(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function PrivacyTab({ token }: { token: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/p/portal/${token}/privacy`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load your privacy settings.");
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your privacy settings.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/p/portal/${token}/privacy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Something went wrong.");
    return json as { request?: Req; export?: unknown };
  }

  async function toggle(c: Consent) {
    setBusy(c.purpose);
    setNotice(null);
    try {
      await post({ action: "consent", purpose: c.purpose, granted: !c.granted });
      setNotice(!c.granted ? `You now allow ${c.label.toLowerCase()}.` : `You withdrew consent for ${c.label.toLowerCase()}. This takes effect immediately.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setBusy(null);
    }
  }

  async function request(kind: "access" | "erasure") {
    if (kind === "erasure" && !confirm("Request deletion of your personal data? Invoices required for accounting are kept with your name removed.")) return;
    setBusy(kind);
    setNotice(null);
    try {
      const out = await post({ action: "request", kind });
      if (out.export) {
        downloadJson("my-data.json", out.export);
        setNotice("Your data export has been downloaded.");
      } else {
        setNotice(kind === "access" ? "Your request was received. You will be able to download your data once it is ready." : "Your deletion request was received and will be handled within the published response period.");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the request.");
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Loading label="Loading your privacy settings…" />;

  const openAccess = data.requests.some((r) => r.kind === "access" && !["completed", "rejected"].includes(r.status));
  const openErasure = data.requests.some((r) => r.kind === "erasure" && !["completed", "rejected"].includes(r.status));

  return (
    <div className="space-y-5">
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Fingerprint className="h-4 w-4 text-primary" aria-hidden /> Your consent choices
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">Each purpose is separate. Withdrawing is one tap and takes effect immediately. Service messages about your bookings and invoices are always sent.</p>
        <ul className="divide-y divide-border/60">
          {data.consents.map((c) => (
            <li key={c.purpose} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{c.label}</div>
                <div className="text-xs text-muted-foreground">{c.at ? `${c.granted ? "Granted" : "Withdrawn"} ${timeAgo(c.at)}` : "No choice recorded (treated as not granted)"}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={c.granted}
                aria-label={`${c.label}: ${c.granted ? "allowed" : "not allowed"}`}
                disabled={busy === c.purpose}
                onClick={() => toggle(c)}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${c.granted ? "bg-primary" : "bg-secondary"}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${c.granted ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold">Your data</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" touch disabled={busy === "access" || openAccess} onClick={() => request("access")}>
            {busy === "access" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Download my data
          </Button>
          <Button variant="outline" touch disabled={busy === "erasure" || openErasure} onClick={() => request("erasure")}>
            {busy === "erasure" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Request deletion
          </Button>
        </div>
        {(openAccess || openErasure) && <p className="mt-2 text-xs text-muted-foreground">You have a request in progress; one open request per kind at a time.</p>}
        {data.requests.length > 0 && (
          <ul className="mt-4 divide-y divide-border/60">
            {data.requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium capitalize">{r.kind} request</div>
                  <div className="text-xs text-muted-foreground">Submitted {timeAgo(r.requested_at)} · response due by {new Date(r.due_at).toLocaleDateString()}</div>
                </div>
                <Pill tone={STATUS_TONE[r.status] ?? "neutral"} className="capitalize">{r.status.replace("_", " ")}</Pill>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold">Questions or complaints</h2>
        <p className="text-muted-foreground">
          {data.grievance.name || data.grievance.email ? (
            <>
              Contact {data.grievance.name ?? "the grievance officer"}
              {data.grievance.email && (
                <>
                  {" "}
                  at <a className="underline" href={`mailto:${data.grievance.email}`}>{data.grievance.email}</a>
                </>
              )}
              . Requests are answered within {data.grievance.response_days} days.
            </>
          ) : (
            <>Requests are answered within {data.grievance.response_days} days.</>
          )}
          {data.notice_path && (
            <>
              {" "}
              Read the <a className="underline" href={data.notice_path}>privacy notice</a>.
            </>
          )}
        </p>
      </section>
    </div>
  );
}
