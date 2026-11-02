import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));

import { isAllowedWebhookUrl, isPrivateAddress, resolvesToPublicAddress } from "@/lib/webhooks/url";
import { sendWebhook } from "@/lib/webhooks/dispatch";
import { sealSecret, WebhookValidationError } from "@/lib/webhooks/subscriptions";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.queryOne.mockReset();
});

describe("isPrivateAddress", () => {
  it("flags loopback, RFC1918, link-local/metadata, CGNAT, multicast and v6 equivalents", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("accepts public addresses and rejects garbage", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("resolvesToPublicAddress (DNS rebinding guard)", () => {
  it("rejects a public-looking hostname that resolves to a private address", async () => {
    const lookup = vi.fn(async () => [{ address: "169.254.169.254" }]);
    expect(await resolvesToPublicAddress("https://metadata.attacker.example/hook", { lookup })).toBe(false);
    expect(lookup).toHaveBeenCalledWith("metadata.attacker.example");
  });
  it("rejects when ANY answer is private (dual answers), when the answer is empty, and when lookup throws", async () => {
    expect(await resolvesToPublicAddress("https://h.example/", { lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }] })).toBe(false);
    expect(await resolvesToPublicAddress("https://h.example/", { lookup: async () => [] })).toBe(false);
    expect(await resolvesToPublicAddress("https://h.example/", { lookup: async () => { throw new Error("ENOTFOUND"); } })).toBe(false);
  });
  it("accepts a host whose every answer is public", async () => {
    expect(await resolvesToPublicAddress("https://hooks.example.com/x", { lookup: async () => [{ address: "93.184.216.34" }, { address: "2606:2800:220:1:248:1893:25c8:1946" }] })).toBe(true);
  });
  it("still honours the string guard for IP literals and the dev loopback override", async () => {
    const lookup = vi.fn();
    expect(await resolvesToPublicAddress("https://10.0.0.1/", { lookup })).toBe(false);
    expect(await resolvesToPublicAddress("http://localhost:3000/hook", { lookup, env: { WEBHOOKS_ALLOW_INSECURE: "1", NODE_ENV: "test" } })).toBe(true);
    expect(await resolvesToPublicAddress("http://localhost:3000/hook", { lookup, env: { WEBHOOKS_ALLOW_INSECURE: "1", NODE_ENV: "production" } })).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(isAllowedWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
  });
});

describe("sendWebhook", () => {
  it("never issues the request when the endpoint resolves to a private address", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const out = await sendWebhook("https://rebind.example.com/hook", "whsec_x", "{}", { event: "webhook.test", delivery: "d1" }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: async () => [{ address: "127.0.0.1" }],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/private or unresolvable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("delivers (with redirect: error) when the host is public", async () => {
    const fetchImpl = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response("ok", { status: 200 }));
    const out = await sendWebhook("https://hooks.example.com/hook", "whsec_x", "{}", { event: "webhook.test", delivery: "d1" }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: async () => [{ address: "93.184.216.34" }],
    });
    expect(out.ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

describe("sealSecret", () => {
  it("refuses to store a plaintext secret in production when encryption is not configured", () => {
    const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      expect(() => sealSecret("whsec_abc", { NODE_ENV: "production" })).toThrow(WebhookValidationError);
      expect(sealSecret("whsec_abc", { NODE_ENV: "test" })).toBe("plain:whsec_abc");
    } finally {
      if (saved !== undefined) process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    }
  });
});
