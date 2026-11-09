"use client";

import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { useRef } from "react";

/**
 * Samples Core Web Vitals (LCP, CLS, INP, TTFB, FCP) from 10% of page loads
 * and posts them to /api/vitals. Anonymous by design: only the metric, the
 * normalised route and the navigation type leave the browser.
 *
 * Mount once in the root layout:  <WebVitals />
 * Set NEXT_PUBLIC_VITALS_SAMPLE (0..1) to change the sampling rate.
 */
const WANTED = new Set(["LCP", "CLS", "INP", "TTFB", "FCP"]);
const SAMPLE = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_VITALS_SAMPLE ?? "0.1");
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.1;
})();

export function WebVitals() {
  const pathname = usePathname();
  // Decide once per page load so a sampled visit reports every metric (needed for coherent p75s).
  const sampled = useRef<boolean | null>(null);
  if (sampled.current === null) sampled.current = Math.random() < SAMPLE;

  useReportWebVitals((metric) => {
    if (!sampled.current || !WANTED.has(metric.name)) return;
    const body = JSON.stringify({
      name: metric.name,
      value: Math.round(metric.value * 1000) / 1000,
      rating: metric.rating,
      path: pathname || "/",
      navigation_type: metric.navigationType,
    });
    try {
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/vitals", new Blob([body], { type: "application/json" }));
        return;
      }
    } catch {
      /* fall through */
    }
    void fetch("/api/vitals", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => undefined);
  });

  return null;
}
