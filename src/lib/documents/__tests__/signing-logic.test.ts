import { describe, expect, it } from "vitest";
import { allSigned, hashSignOtp, isSignersTurn, signersToNotify } from "@/lib/documents/signing";
import { assertRecipientMatches } from "@/lib/money/acceptance";
import { emailHint } from "@/lib/documents/types";

const signers = [
  { id: "a", order_index: 0, status: "pending" },
  { id: "b", order_index: 1, status: "pending" },
  { id: "c", order_index: 2, status: "pending" },
];

describe("signer order", () => {
  it("parallel: everyone pending may sign and is notified", () => {
    expect(isSignersTurn("parallel", signers, "c")).toBe(true);
    expect(signersToNotify("parallel", signers).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("sequential: only the first unsigned signer may act; later ones are blocked until earlier ones sign", () => {
    expect(isSignersTurn("sequential", signers, "a")).toBe(true);
    expect(isSignersTurn("sequential", signers, "b")).toBe(false);
    expect(signersToNotify("sequential", signers).map((s) => s.id)).toEqual(["a"]);
    const afterA = signers.map((s) => (s.id === "a" ? { ...s, status: "signed" } : s));
    expect(isSignersTurn("sequential", afterA, "b")).toBe(true);
    expect(isSignersTurn("sequential", afterA, "c")).toBe(false);
    expect(signersToNotify("sequential", afterA).map((s) => s.id)).toEqual(["b"]);
  });

  it("signed or declined signers never get another turn; allSigned needs every signer", () => {
    const done = signers.map((s) => ({ ...s, status: "signed" }));
    expect(isSignersTurn("parallel", done, "a")).toBe(false);
    expect(allSigned(done)).toBe(true);
    expect(allSigned(signers)).toBe(false);
    expect(allSigned([])).toBe(false);
    expect(isSignersTurn("sequential", signers.map((s) => (s.id === "a" ? { ...s, status: "declined" } : s)), "a")).toBe(false);
  });
});

describe("OTP hashing and recipient binding", () => {
  it("binds the hash to signer, email, purpose and code", () => {
    const h = hashSignOtp("s1", "Ada@Example.test", "123456", "sign");
    expect(h).toBe(hashSignOtp("s1", "ada@example.test", "123456", "sign")); // case-insensitive email
    expect(h).not.toBe(hashSignOtp("s1", "ada@example.test", "123456", "decline")); // purpose
    expect(h).not.toBe(hashSignOtp("s2", "ada@example.test", "123456", "sign")); // signer
    expect(h).not.toBe(hashSignOtp("s1", "bob@example.test", "123456", "sign")); // email
    expect(h).not.toBe(hashSignOtp("s1", "ada@example.test", "654321", "sign")); // code
  });

  it("rejects an email that differs from the bound recipient", () => {
    expect(() => assertRecipientMatches("other@example.test", "ada@example.test")).toThrow(/different email/);
    expect(() => assertRecipientMatches(" ADA@example.test ", "ada@example.test")).not.toThrow();
  });

  it("masks the signer email for the public page", () => {
    expect(emailHint("ada@example.test")).toMatch(/^ad•+@example\.test$/);
    expect(emailHint("nope")).toBe("•••");
  });
});
