"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2, MailX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";

interface Info {
  business: string | null;
  channel: "email" | "sms";
  already_unsubscribed: boolean;
}

/** Public one-click unsubscribe. No auth, no app shell; a bad token renders a calm explanation. */
export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "busy" | "done" | "error">("loading");
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/t/u/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (!res.ok) {
        setState("invalid");
        return;
      }
      const d = (await res.json()) as Info;
      setInfo(d);
      setState(d.already_unsubscribed ? "done" : "ready");
    } catch {
      setState("invalid");
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    setState("busy");
    try {
      const res = await fetch(`/api/t/u/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all }) });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  const channelLabel = info?.channel === "sms" ? "text messages" : "emails";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-20">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground" aria-hidden>
            {state === "done" ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <MailX className="h-5 w-5" />}
          </div>
          {state === "loading" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking your link…
            </p>
          )}
          {state === "invalid" && (
            <>
              <h1 className="text-lg font-semibold">This link is not valid</h1>
              <p className="mt-2 text-sm text-muted-foreground">The unsubscribe link may be incomplete or expired. Reply to the message you received and ask to be removed — the sender is required to honour that.</p>
            </>
          )}
          {(state === "ready" || state === "busy" || state === "error") && (
            <>
              <h1 className="text-lg font-semibold">Unsubscribe from marketing {channelLabel}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {info?.business ? `${info.business} will stop sending you marketing ${channelLabel}.` : `You will stop receiving marketing ${channelLabel} from this sender.`} Service messages about things you have bought or booked are not affected.
              </p>
              <div className="mt-4">
                <Checkbox label="Also stop marketing on every other channel (email and SMS)" checked={all} onChange={(e) => setAll(e.target.checked)} />
              </div>
              {state === "error" && (
                <p role="alert" className="mt-3 text-sm text-red-600">
                  Something went wrong. Please try again.
                </p>
              )}
              <div className="mt-5">
                <Button type="button" touch onClick={confirm} disabled={state === "busy"}>
                  {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {state === "busy" ? "Updating…" : "Unsubscribe"}
                </Button>
              </div>
            </>
          )}
          {state === "done" && (
            <>
              <h1 className="text-lg font-semibold">You are unsubscribed</h1>
              <p className="mt-2 text-sm text-muted-foreground">Your preference was recorded{info?.business ? ` with ${info.business}` : ""}. It can take a short while for messages already queued to stop.</p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
