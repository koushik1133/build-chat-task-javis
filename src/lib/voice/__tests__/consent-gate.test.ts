import { beforeEach, describe, expect, it, vi } from "vitest";

/** addTargets: raw `phones` must pass the marketing_voice consent gate like contacts do. */
const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), grantedSubset: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("@/lib/privacy/consent", () => ({ grantedSubset: mocks.grantedSubset }));

import { addTargets } from "@/lib/voice/campaigns";

describe("addTargets consent gate for raw phones", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryOne.mockReset();
    mocks.grantedSubset.mockReset();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM crm_contacts WHERE user_id = $1 AND deleted_at IS NULL AND phone IS NOT NULL")) {
        return [
          { id: "granted-contact", phone: "+1 (555) 010-0001" },
          { id: "silent-contact", phone: "+15550100002" },
        ];
      }
      return [];
    });
  });

  it("skips raw numbers without a consenting contact when require_consent is on (default)", async () => {
    mocks.queryOne.mockResolvedValue({ require_consent: true });
    mocks.grantedSubset.mockResolvedValue(new Set(["granted-contact"]));
    const r = await addTargets("u1", "camp-1", {
      phones: [{ phone: "+15550100001" }, { phone: "+15550100002" }, { phone: "+15550100003", first_name: "Nobody" }],
    });
    expect(r.added).toBe(1);
    expect(r.skipped_no_consent).toBe(2);
    const insert = mocks.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO voice_campaign_targets"));
    expect(insert?.[1]).toEqual(["u1", "camp-1", "granted-contact", "+15550100001", null]);
  });

  it("dials raw numbers as before when the campaign opted out of the consent gate", async () => {
    mocks.queryOne.mockResolvedValue({ require_consent: false });
    const r = await addTargets("u1", "camp-1", { phones: [{ phone: "+15550100003" }] });
    expect(r.added).toBe(1);
    expect(r.skipped_no_consent).toBe(0);
    expect(mocks.grantedSubset).not.toHaveBeenCalled();
  });
});
