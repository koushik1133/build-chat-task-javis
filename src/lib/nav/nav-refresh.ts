"use client";

import { useEffect, useState } from "react";

/**
 * Tiny client event bus so connecting or disconnecting an account regrows the
 * sidebar immediately, instead of only on the next full page load.
 */
const EVENT = "javis:nav-refresh";

export function requestNavRefresh() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Increments whenever a refresh is requested; use as a useEffect dependency. */
export function useNavRefreshSignal(): number {
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    const onRefresh = () => setSignal((n) => n + 1);
    window.addEventListener(EVENT, onRefresh);
    return () => window.removeEventListener(EVENT, onRefresh);
  }, []);

  return signal;
}
