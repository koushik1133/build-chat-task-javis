"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BellOff, BellRing, CheckCircle2, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type State =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: string }
  | { kind: "not_configured" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on"; endpoint: string };

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  // Dev builds may not have registered the worker yet (NEXT_PUBLIC_PWA unset).
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Enable / disable Web Push for this device. */
export function PushToggle({ className }: { className?: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches;
      setState({ kind: "unsupported", reason: ios ? "On iPhone and iPad, add KernelHub to your Home Screen first, then enable notifications from the installed app." : "This browser does not support web push." });
      return;
    }
    try {
      const res = await fetch("/api/push/vapid-public", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { configured?: boolean } | null;
      if (!res.ok || !data?.configured) {
        setState({ kind: "not_configured" });
        return;
      }
    } catch {
      setState({ kind: "not_configured" });
      return;
    }
    if (Notification.permission === "denied") {
      setState({ kind: "denied" });
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    setState(sub ? { kind: "on", endpoint: sub.endpoint } : { kind: "off" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    setBusy(true);
    setNotice(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState({ kind: permission === "denied" ? "denied" : "off" });
        if (permission === "denied") setNotice({ tone: "error", text: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." });
        return;
      }
      const keyRes = await fetch("/api/push/vapid-public", { cache: "no-store" });
      const { publicKey } = (await keyRes.json()) as { publicKey: string | null };
      if (!publicKey) throw new Error("Push is not configured on the server.");
      const reg = await readyRegistration();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
      const save = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!save.ok) {
        await sub.unsubscribe().catch(() => undefined);
        const data = (await save.json().catch(() => null)) as { detail?: string; error?: string } | null;
        if (save.status === 409) throw new Error("This device is already registered to another member of the workspace. Disable notifications there first, or use a different browser profile.");
        throw new Error(data?.detail ?? data?.error ?? "Could not save the subscription.");
      }
      setState({ kind: "on", endpoint: sub.endpoint });
      setNotice({ tone: "ok", text: "Notifications enabled on this device." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not enable notifications." });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setNotice(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setState({ kind: "off" });
      setNotice({ tone: "ok", text: "Notifications turned off for this device." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not disable notifications." });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: true }) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; sent?: number; failed?: number; detail?: string } | null;
      if (!res.ok) throw new Error(data?.detail ?? "Test failed.");
      setNotice(data?.ok ? { tone: "ok", text: `Test sent to ${data.sent} device${data.sent === 1 ? "" : "s"}.` } : { tone: "error", text: "The push service rejected the test. Re-enable notifications and try again." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Test failed." });
    } finally {
      setBusy(false);
    }
  }

  const on = state.kind === "on";
  const canToggle = state.kind === "on" || state.kind === "off";

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4 sm:p-5", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", on ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-secondary text-muted-foreground")} aria-hidden>
            {on ? <BellRing className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <h2 id="push-toggle-label" className="text-sm font-semibold">Push notifications on this device</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.kind === "loading" && "Checking this device…"}
              {state.kind === "unsupported" && state.reason}
              {state.kind === "not_configured" && "Push is not configured on the server yet. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (run node scripts/gen-vapid-keys.mjs)."}
              {state.kind === "denied" && "Notifications are blocked for this site in your browser settings."}
              {state.kind === "off" && "Get approvals, new leads, bookings and crew notes even when the app is closed."}
              {state.kind === "on" && "Enabled. Notifications arrive even when the tab is closed."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {on && (
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => void sendTest()} disabled={busy} aria-label="Send a test notification">
              <Send className="h-4 w-4" aria-hidden /> Test
            </Button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="push-toggle-label"
            disabled={!canToggle || busy}
            onClick={() => void (on ? disable() : enable())}
            className={cn(
              "relative inline-flex h-11 w-[4.5rem] shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:h-7 sm:w-12",
              on ? "bg-primary" : "bg-secondary"
            )}
          >
            <span className="sr-only">{on ? "Disable push notifications" : "Enable push notifications"}</span>
            {busy ? (
              <Loader2 className="mx-auto h-4 w-4 animate-spin text-foreground motion-reduce:animate-none" aria-hidden />
            ) : (
              <span className={cn("inline-block h-9 w-9 transform rounded-full bg-background shadow transition-transform motion-reduce:transition-none sm:h-5 sm:w-5", on ? "translate-x-[2.1rem] sm:translate-x-6" : "translate-x-0.5 sm:translate-x-1")} aria-hidden />
            )}
          </button>
        </div>
      </div>
      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} aria-live="polite" className={cn("mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm", notice.tone === "ok" ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300")}>
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{notice.text}</span>
        </p>
      )}
    </div>
  );
}

export default PushToggle;
