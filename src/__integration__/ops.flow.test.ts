/**
 * Operability flow (Phase 6 lane C): /api/health public shape, verbose env
 * report gated by CRON_SECRET or owner/admin scope, and the system_state
 * cron tick that Settings → System health reads.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface HealthBase { ok: boolean; database: string; llm: string; time: string }
interface HealthVerbose extends HealthBase {
  latencyMs: number;
  env: { ok: boolean; database: string; missing: string[]; invalid: string[]; warnings: string[]; providers: Array<{ name: string; configured: boolean }> };
}

describeDb("ops flow", () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg("ops");
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("public health probe never includes the env report", async () => {
    setScope(null);
    const health = await import("@/app/api/health/route");
    const r = await api<HealthBase & { env?: unknown }>(health.GET, "/api/health?verbose=1", { expect: 200 });
    expect(r.body.ok).toBe(true);
    expect(r.body.database).toBe("connected");
    expect(r.body.env).toBeUndefined();
  });

  it("CRON_SECRET bearer unlocks the verbose env report (names only, no values)", async () => {
    setScope(null);
    const health = await import("@/app/api/health/route");
    const r = await api<HealthVerbose>(health.GET, "/api/health?verbose=1", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      expect: 200,
    });
    expect(r.body.env.database).toBe("postgres");
    expect(Array.isArray(r.body.env.providers)).toBe(true);
    expect(r.body.env.providers.some((p) => p.name === "twilio")).toBe(true);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(process.env.CRON_SECRET as string);
  });

  it("owner scope unlocks it; member scope does not", async () => {
    const health = await import("@/app/api/health/route");
    setScope(org, { role: "owner" });
    const owner = await api<HealthVerbose>(health.GET, "/api/health?verbose=1", { expect: 200 });
    expect(owner.body.env).toBeDefined();
    setScope(org, { role: "member" });
    const member = await api<HealthBase & { env?: unknown }>(health.GET, "/api/health?verbose=1", { expect: 200 });
    expect(member.body.env).toBeUndefined();
  });

  it("recordCronTick persists the last tick for the System health page", async () => {
    const { recordCronTick, getSystemState, CRON_TICK_KEY } = await import("@/lib/system/state");
    await recordCronTick({ automations: 1, ms: 12 });
    const tick = await getSystemState<Record<string, unknown>>(CRON_TICK_KEY);
    expect(tick).not.toBeNull();
    expect(tick?.value).toMatchObject({ counts: { automations: 1, ms: 12 } });
    expect(typeof tick?.value.at).toBe("string");
  });
});
