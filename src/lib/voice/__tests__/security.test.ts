import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/notifications/status", () => ({ twilioIsLive: () => false }));
vi.mock("@/lib/receptionist/inbound-agent", () => ({ handleInboundMessage: vi.fn() }));
vi.mock("@/lib/secure-store", () => ({ decryptSecret: () => null }));

import { twilioSignature } from "@/lib/twilio-webhook";
import { verifyCampaignSignature } from "@/lib/voice/dialer";
import { recordOptOut } from "@/lib/voice/campaigns";

const URL_ = "https://app.example.com/api/voice/campaigns/webhook?target=t1&kind=gather";
const TOKEN = "test-auth-token-not-real";

function req(sig: string | null, url = URL_): Request {
  const headers = new Headers();
  if (sig) headers.set("x-twilio-signature", sig);
  return new Request(url, { method: "POST", headers });
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
});

describe("verifyCampaignSignature", () => {
  it("accepts a signature computed over the full URL including the query string", () => {
    const params = new URLSearchParams({ Digits: "1", CallSid: "CA1" });
    const sig = twilioSignature(URL_, params, TOKEN);
    expect(verifyCampaignSignature(req(sig), params, { TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: "production" })).toBe(true);
    // Tampering with the query (another target) invalidates it.
    expect(verifyCampaignSignature(req(sig, URL_.replace("t1", "t2")), params, { TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: "production" })).toBe(false);
  });
  it("ignores TWILIO_SKIP_SIGNATURE_VERIFICATION in production but honours it elsewhere", () => {
    const params = new URLSearchParams();
    expect(verifyCampaignSignature(req(null), params, { TWILIO_SKIP_SIGNATURE_VERIFICATION: "true", NODE_ENV: "production", TWILIO_AUTH_TOKEN: TOKEN })).toBe(false);
    expect(verifyCampaignSignature(req("bogus"), params, { TWILIO_SKIP_SIGNATURE_VERIFICATION: "true", NODE_ENV: "production", TWILIO_AUTH_TOKEN: TOKEN })).toBe(false);
    expect(verifyCampaignSignature(req(null), params, { TWILIO_SKIP_SIGNATURE_VERIFICATION: "true", NODE_ENV: "development" })).toBe(true);
  });
  it("fails closed without a token or header", () => {
    expect(verifyCampaignSignature(req("x"), new URLSearchParams(), { NODE_ENV: "production" })).toBe(false);
    expect(verifyCampaignSignature(req(null), new URLSearchParams(), { TWILIO_AUTH_TOKEN: TOKEN })).toBe(false);
  });
});

describe("recordOptOut", () => {
  it("drops a contact_id that belongs to another workspace instead of storing it", async () => {
    mocks.queryOne
      .mockResolvedValueOnce(null) // ownership check: not ours
      .mockResolvedValueOnce({ id: "opt-1" }); // insert
    const id = await recordOptOut("org-a", { contact_id: "contact-of-org-b", phone: "+1 (555) 010-0001" });
    expect(id).toBe("opt-1");
    const ownership = mocks.queryOne.mock.calls[0];
    expect(String(ownership[0])).toContain("FROM crm_contacts WHERE id = $1 AND user_id = $2");
    expect(ownership[1]).toEqual(["contact-of-org-b", "org-a"]);
    const insert = mocks.queryOne.mock.calls[1];
    expect(String(insert[0])).toContain("INSERT INTO contact_optouts");
    expect(insert[1][1]).toBeNull(); // contact_id nulled
    expect(insert[1][2]).toBe("+15550100001");
    // No tag write against the foreign contact.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE crm_contacts"))).toBe(false);
  });
  it("links and tags a contact the workspace owns", async () => {
    mocks.queryOne
      .mockResolvedValueOnce({ id: "c1" })
      .mockResolvedValueOnce({ id: "opt-2" })
      .mockResolvedValueOnce({ tags: "[]" });
    await recordOptOut("org-a", { contact_id: "c1" });
    expect(mocks.queryOne.mock.calls[1][1][1]).toBe("c1");
    expect(mocks.query.mock.calls.some(([sql, p]) => String(sql).includes("UPDATE crm_contacts") && (p as unknown[])[1] === "c1")).toBe(true);
  });
});
