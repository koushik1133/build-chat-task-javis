import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn(async () => "n1") }));

import { createInvite, inviteOrigin } from "@/lib/team";

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
});

describe("invite link origin", () => {
  it("ignores a caller-supplied (Host header) origin when the app URL is configured", () => {
    expect(inviteOrigin("https://evil.example", { NEXT_PUBLIC_APP_URL: "https://app.example.com/" })).toBe("https://app.example.com");
    expect(inviteOrigin("https://dev.local", {})).toBe("https://dev.local");
  });
  it("createInvite builds the link from the configured origin, not the request's", async () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    try {
      const invite = await createInvite("org-a", { email: "Ada@Example.com", role: "member", invitedBy: "u1", origin: "https://phish.example" });
      expect(invite.inviteUrl.startsWith("https://app.example.com/invite/")).toBe(true);
      expect(invite.inviteUrl).not.toContain("phish");
      expect(invite.token).toHaveLength(64);
      // Only the hash is persisted.
      const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO memberships"));
      expect(insert).toBeDefined();
      expect((insert![1] as unknown[]).includes(invite.token)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  });
});
