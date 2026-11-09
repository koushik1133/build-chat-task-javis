"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Fingerprint, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Loading } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { cn, timeAgo } from "@/lib/utils";

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
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : s);

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
  const [confirmErasure, setConfirmErasure] = useState(false);

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

  // Success notices clear themselves; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/p/portal/${token}/privacy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Something went wrong.");
    return json as { request?: Req; export?: unknown };
  }

  async function toggle(c: Consent) {
    setBusy(c.purpose);
    setNotice(null);
    setError(null);
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
    setBusy(kind);
    setNotice(null);
    setError(null);
    try {
      const out = await post({ action: "request", kind });
      if (out.export) {
        downloadJson("my-data.json", out.export);
        setNotice("Your data export has been downloaded.");
      } else {
        setNotice(kind === "access" ? "Your request was received. You will be able to download your data once it is ready." : "Your deletion request was received and will be handled within the published response period.");
      }
      setConfirmErasure(false);
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
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Fingerprint className="h-4 w-4 text-primary" aria-hidden /> Your consent choices
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">Each purpose is separate. Withdrawing is one tap and takes effect immediately. Service messages about your bookings and invoices are always sent.</p>
        <ul className="divide-y divide-border/60">
          {data.consents.map((c) => (
            <li key={c.purpose} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{c.label}</div>
                <div className="text-xs text-muted-foreground">{c.at ? `${c.granted ? "Granted" : "Withdrawn"} ${timeAgo(c.at)}` : "No choice recorded (treated as not granted)"}</div>
              </div>
              {/* The visual track stays 28x48; the button itself is padded to a 44px tap target on phones. */}
              <button
                type="button"
                role="switch"
                aria-checked={c.granted}
                aria-label={`${c.label}: ${c.granted ? "allowed" : "not allowed"}`}
                disabled={busy === c.purpose}
                onClick={() => toggle(c)}
                className="-my-1 flex min-h-11 shrink-0 touch-manipulation items-center rounded-full px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-0"
              >
                <span className={cn("relative inline-flex h-7 w-12 items-center rounded-full transition-colors motion-reduce:transition-none", c.granted ? "bg-primary" : "bg-secondary")}>
                  <span className={cn("inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform motion-reduce:transition-none", c.granted ? "translate-x-6" : "translate-x-1")} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-semibold">Your data</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" touch disabled={busy === "access" || openAccess} onClick={() => request("access")}>
            {busy === "access" ? spinner : <Download className="h-4 w-4" aria-hidden />} Download my data
          </Button>
          <Button variant="outline" touch disabled={busy === "erasure" || openErasure} onClick={() => setConfirmErasure(true)}>
            <Trash2 className="h-4 w-4" aria-hidden /> Request deletion
          </Button>
        </div>
        {(openAccess || openErasure) && <p role="status" className="mt-2 text-xs text-muted-foreground">You have a request in progress; one open request per kind at a time.</p>}
        {data.requests.length > 0 && (
          <ul className="mt-4 divide-y divide-border/60">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{cap(r.kind)} request</div>
                  <div className="text-xs text-muted-foreground">Submitted {timeAgo(r.requested_at)} · response due by {new Date(r.due_at).toLocaleDateString()}</div>
                </div>
                <Pill tone={STATUS_TONE[r.status] ?? "neutral"}>{cap(r.status)}</Pill>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 text-sm sm:p-5">
        <h2 className="mb-2 text-sm font-semibold">Questions or complaints</h2>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
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

      {confirmErasure && (
        <Dialog
          title="Request deletion of your personal data?"
          description="Invoices required for accounting are kept with your name removed. Everything else is erased within the published response period. This cannot be undone."
          onClose={() => busy !== "erasure" && setConfirmErasure(false)}
          size="sm"
        >
          <DialogFooter>
            <Button type="button" variant="outline" touch disabled={busy === "erasure"} onClick={() => setConfirmErasure(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch disabled={busy === "erasure"} onClick={() => request("erasure")}>
              {busy === "erasure" && spinner} Request deletion
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
