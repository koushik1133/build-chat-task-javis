"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in production (or when NEXT_PUBLIC_PWA=1 for local testing).
 * Mount once in the root layout. Renders nothing.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    const enabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_PWA === "1";
    if (!enabled || typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          // Pick up a new worker on the next load without nagging the user.
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            next?.addEventListener("statechange", () => {
              if (next.state === "installed" && navigator.serviceWorker.controller) {
                console.info("[pwa] update ready; it will activate on next launch");
              }
            });
          });
        })
        .catch((err) => console.warn("[pwa] service worker registration failed:", err));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);
  return null;
}

export default RegisterServiceWorker;
