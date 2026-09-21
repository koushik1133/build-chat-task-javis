/**
 * Regression guard: every authenticated API route must resolve the caller via
 * `requireScope()` so data is read under the org owner's id. Only the routes
 * listed below may still call `requireUser()` directly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(__dirname, "..");

/** Path prefixes (relative to src/app/api) that legitimately use requireUser or are public. */
const ALLOWLIST = [
  "auth/",
  "health",
  "cron/",
  "hooks/",
  "mcp",
  "api-keys",
  "integrations/", // OAuth callbacks + webhooks share this folder; scoped handlers there are checked separately
  "leads/capture",
  "orgs/",
  "team/",
  "billing/",
  "quotes/",
  "invoices/",
  "payments/",
  "calendar/",
  "bookings/",
  "portal/",
  "audit/",
  "notifications/",
  "__tests__/",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function isAllowlisted(rel: string): boolean {
  return ALLOWLIST.some((p) => rel === p || rel.startsWith(p));
}

describe("API routes use requireScope instead of requireUser", () => {
  const routes = walk(API_ROOT).map((f) => ({ file: f, rel: relative(API_ROOT, f).split("\\").join("/") }));

  it("finds route files", () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it("no migrated route still calls requireUser()", () => {
    const offenders = routes
      .filter((r) => !isAllowlisted(r.rel))
      .filter((r) => readFileSync(r.file, "utf8").includes("requireUser("))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it("migrated routes that read data reference scope.dataId, not user.id", () => {
    const offenders = routes
      .filter((r) => !isAllowlisted(r.rel))
      .filter((r) => /\buser\.id\b/.test(readFileSync(r.file, "utf8")))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it("integrations routes that authenticate use requireScope", () => {
    const offenders = routes
      .filter((r) => r.rel.startsWith("integrations/"))
      .filter((r) => readFileSync(r.file, "utf8").includes("requireUser("))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });
});
