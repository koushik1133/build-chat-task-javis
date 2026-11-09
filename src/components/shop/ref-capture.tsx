"use client";

import { useEffect } from "react";
import { portalKey, refKey } from "./discount-fields";

/** Remembers `?ref=CODE` (referrals) and `?pt=<portal token>` (rewards members) for the checkout, per shop, for this tab only. */
export function RefCapture({ org }: { org: string }) {
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const ref = p.get("ref");
      if (ref && /^[A-Za-z0-9]{6,12}$/.test(ref)) window.sessionStorage.setItem(refKey(org), ref.toUpperCase());
      const pt = p.get("pt");
      if (pt && /^[A-Za-z0-9_-]{10,128}$/.test(pt)) window.sessionStorage.setItem(portalKey(org), pt);
    } catch {
      /* storage unavailable: referral/points simply do not carry over */
    }
  }, [org]);
  return null;
}
