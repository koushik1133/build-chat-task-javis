"use client";

import { useEffect, useState } from "react";

type State = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * Tells a person testing the demo page what the widget script is doing. The
 * script itself stays silent on failure (a broken embed must never break the
 * host site), so it emits `kh-widget:ready` / `kh-widget:error` window events
 * that this status line listens for.
 */
export function WidgetStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    const onReady = () => setState({ kind: "ready" });
    const onError = (e: Event) => {
      const d = (e as CustomEvent<{ status?: number; message?: string }>).detail ?? {};
      setState({
        kind: "error",
        message:
          d.status === 404
            ? "No widget is configured for this site id. Check the ?site= value or enable the widget in Settings → Website widgets."
            : d.status === 0
              ? (d.message ?? "The widget is disabled for this site.")
              : `The widget could not load${d.message ? ` (${d.message})` : ""}. Try again in a moment.`,
      });
    };
    window.addEventListener("kh-widget:ready", onReady);
    window.addEventListener("kh-widget:error", onError);
    // If the script never reports in, say so rather than leaving a blank corner.
    const t = window.setTimeout(() => setState((s) => (s.kind === "loading" ? { kind: "error", message: "The widget script did not respond. Reload the page to try again." } : s)), 12000);
    return () => {
      window.removeEventListener("kh-widget:ready", onReady);
      window.removeEventListener("kh-widget:error", onError);
      window.clearTimeout(t);
    };
  }, []);

  if (state.kind === "ready") return null;
  return (
    <p role={state.kind === "error" ? "alert" : "status"} aria-live="polite" className="mx-auto max-w-4xl px-5 pb-10 text-sm text-zinc-600">
      {state.kind === "loading" ? "Loading the widget…" : state.message}
    </p>
  );
}
