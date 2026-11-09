"use client";

import { useEffect } from "react";

/**
 * Counts a public help-article view once per page load. The article page is
 * served from the ISR cache, so the increment cannot happen during render;
 * `sendBeacon` fires after paint and never blocks navigation.
 */
export function ArticleViewBeacon({ org, slug }: { org: string; slug: string }) {
  useEffect(() => {
    const body = JSON.stringify({ org, slug });
    try {
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/help/view", new Blob([body], { type: "application/json" }));
        return;
      }
    } catch {
      /* fall through to fetch */
    }
    void fetch("/api/help/view", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  }, [org, slug]);
  return null;
}
