import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { TOKEN_PREFIX, VERIFICATION_LABEL, verificationRecord, verifyDomainDns } from "@/lib/sso/verify";

const token = "abc123TOKEN";

describe("verifyDomainDns", () => {
  it("matches the record on the verification subdomain", async () => {
    const resolver = vi.fn(async (host: string) => (host === `${VERIFICATION_LABEL}.acme.com` ? [[`${TOKEN_PREFIX}${token}`]] : []));
    expect(await verifyDomainDns("Acme.COM", token, resolver)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith("_kernelhub-verification.acme.com");
  });
  it("falls back to the apex and joins chunked TXT strings", async () => {
    const resolver = vi.fn(async (host: string) => {
      if (host.startsWith(VERIFICATION_LABEL)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [["v=spf1 -all"], [`${TOKEN_PREFIX}abc123`, "TOKEN"]];
    });
    expect(await verifyDomainDns("acme.com", token, resolver)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it("fails on a wrong token, reporting the last error", async () => {
    const resolver = vi.fn(async () => [[`${TOKEN_PREFIX}other`]]);
    const r = await verifyDomainDns("acme.com", token, resolver);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no matching/);
  });
  it("fails when every lookup errors", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("ESERVFAIL");
    });
    const r = await verifyDomainDns("acme.com", token, resolver);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ESERVFAIL/);
  });
  it("describes the record to publish", () => {
    expect(verificationRecord("Acme.com", token)).toEqual({ host: "_kernelhub-verification.acme.com", value: `kernelhub-verification=${token}` });
  });
});
