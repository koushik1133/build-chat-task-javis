"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2, MailX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Banner } from "@/components/ui/feedback";

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
  const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

  return (
    <main id="main" className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-20">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm" aria-busy={state === "loading" || state === "busy" || undefined}>
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground" aria-hidden>
            {state === "done" ? <CheckCircle2 className="h-5 w-5 text-emerald-700 dark:text-emerald-300" /> : <MailX className="h-5 w-5" />}
          </div>
          {state === "loading" && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
              {spinner} Checking your link…
            </p>
          )}
          {state === "invalid" && (
            <>
              <h1 className="text-lg font-semibold">This link is not valid</h1>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">
                The unsubscribe link may be incomplete or expired. Reply to the message you received and ask to be removed — the sender is required to honour that.
              </p>
            </>
          )}
          {(state === "ready" || state === "busy" || state === "error") && (
            <>
              <h1 className="text-lg font-semibold">Unsubscribe from marketing {channelLabel}</h1>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">
                {info?.business ? `${info.business} will stop sending you marketing ${channelLabel}.` : `You will stop receiving marketing ${channelLabel} from this sender.`} Service messages about things you have bought or booked are not affected.
              </p>
              <div className="mt-4">
                <Checkbox label="Also stop marketing on every other channel (email and SMS)" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={state === "busy"} />
              </div>
              {state === "error" && (
                <Banner tone="error" className="mb-0 mt-4">
                  Something went wrong and your preference was not saved. Please try again.
                </Banner>
              )}
              <div className="mt-5">
                <Button type="button" touch className="w-full sm:w-auto" onClick={confirm} disabled={state === "busy"} aria-busy={state === "busy" || undefined}>
                  {state === "busy" ? spinner : null}
                  {state === "busy" ? "Updating…" : "Unsubscribe"}
                </Button>
              </div>
            </>
          )}
          {state === "done" && (
            <div role="status" aria-live="polite">
              <h1 className="text-lg font-semibold">You are unsubscribed</h1>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">
                Your preference was recorded{info?.business ? ` with ${info.business}` : ""}. It can take a short while for messages already queued to stop.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
