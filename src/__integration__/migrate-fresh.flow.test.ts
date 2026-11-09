import { describe, expect, it } from "vitest";

/**
 * Builds the whole schema from an EMPTY database with the in-app migrator.
 * Opt-in (needs a throwaway database): MIGRATE_FRESH=1 DB_NAME=<empty db> DB_INTEGRATION=1 vitest run src/__integration__/migrate-fresh.flow.test.ts
 */
const enabled = process.env.MIGRATE_FRESH === "1" && process.env.DB_INTEGRATION === "1";

describe.skipIf(!enabled)("in-app migrator on an empty database", () => {
  it("applies everything with no failures and leaves nothing pending", async () => {
    const { runPendingMigrations, migrationStatus } = await import("@/lib/db/migrate");
    let last = await runPendingMigrations({ budgetMs: 120_000 });
    for (let i = 0; i < 10 && last.remaining > 0 && last.failed.length === 0; i++) last = await runPendingMigrations({ budgetMs: 120_000 });
    expect(last.failed).toEqual([]);
    expect(last.remaining).toBe(0);
    const st = await migrationStatus();
    expect(st.pending).toBe(0);
  }, 600_000);

  it("creates the core tables the app reads on every request", async () => {
    const { query } = await import("@/lib/dsql");
    for (const t of ["organizations", "memberships", "chats", "tasks", "sites", "agents", "automations", "crm_contacts", "notification_outbox"]) {
      const r = await query<{ n: string }>("SELECT to_regclass($1) IS NOT NULL AS ok", [t]);
      expect((r[0] as unknown as { ok: boolean }).ok, `table ${t}`).toBe(true);
    }
  });
});
