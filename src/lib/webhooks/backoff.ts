/**
 * Retry policy for webhook deliveries (pure; client-safe).
 *
 * After a failed attempt the delivery waits 1m, 5m, 30m, 2h, 12h, then is
 * marked dead. A subscription that fails 20 times in a row is disabled.
 */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length + 1; // 6 total: first try + 5 retries
export const AUTO_DISABLE_AFTER = 20;
export const DELIVERY_TIMEOUT_MS = 10_000;

export type DeliveryStatus = "queued" | "delivering" | "delivered" | "failed" | "dead";

/**
 * Given the number of attempts already made (including the one that just
 * failed), return the delay before the next try, or null when exhausted.
 */
export function nextRetryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade < 1) return BACKOFF_SCHEDULE_MS[0];
  const idx = attemptsMade - 1;
  return idx < BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[idx] : null;
}

/** Status + next attempt instant after a failure. */
export function afterFailure(attemptsMade: number, now = Date.now()): { status: "failed" | "dead"; nextAttemptAt: Date | null } {
  const delay = nextRetryDelayMs(attemptsMade);
  if (delay === null) return { status: "dead", nextAttemptAt: null };
  return { status: "failed", nextAttemptAt: new Date(now + delay) };
}

/** True when a 2xx came back. 3xx are failures: deliveries never follow redirects. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function shouldAutoDisable(consecutiveFailures: number): boolean {
  return consecutiveFailures >= AUTO_DISABLE_AFTER;
}

/** Short, human description for the UI. */
export function describeDelay(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
