import { describe, expect, it } from "vitest";
import { gstinCheckChar, lookupVies, validateEuVat, validateGstin, validatePan, validateTaxId, validateUkVat, validateUsState } from "../validators";

describe("GSTIN", () => {
  it("accepts known-valid GSTINs (checksum)", () => {
    expect(validateGstin("27AAPFU0939F1ZV").valid).toBe(true);
    expect(validateGstin(" 27aapfu0939f1zv ").normalized).toBe("27AAPFU0939F1ZV");
    // computed with the published algorithm
    expect(validateGstin("29AABCT1332L1ZA").valid).toBe(true);
    expect(validateGstin("07AAACG1234A1ZG").valid).toBe(true);
  });
  it("rejects bad checksum, structure, length and state", () => {
    expect(validateGstin("27AAPFU0939F1ZX")).toMatchObject({ valid: false, reason: "GSTIN checksum does not match" });
    expect(validateGstin("27AAPFU0939F1Z").valid).toBe(false);
    expect(validateGstin("27AAPFU0939F0ZV").valid).toBe(false); // entity code 0
    expect(validateGstin("00AAPFU0939F1Z0").reason).toMatch(/state code|structure/i);
    expect(validateGstin("").valid).toBe(false);
  });
  it("check char function is stable", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
  });
});

describe("PAN", () => {
  it("validates shape", () => {
    expect(validatePan("ABCPE1234F").valid).toBe(true);
    expect(validatePan("ABCXE1234F").valid).toBe(false); // 4th letter must be a holder type
    expect(validatePan("ABC123").valid).toBe(false);
  });
});

describe("EU VAT", () => {
  it.each([
    ["DE123456789", true],
    ["DE12345678", false],
    ["FR12345678901", true],
    ["NL123456789B01", true],
    ["NL123456789A01", false],
    ["ATU12345678", true],
    ["EL123456789", true],
    ["IE1234567T", true],
    ["ES12345678Z", true],
    ["XX123", false],
    ["PL1234567890", true],
    ["BE0123456789", true],
  ])("%s -> %s", (id, ok) => {
    expect(validateEuVat(id).valid).toBe(ok);
  });
  it("normalises spaces and punctuation", () => {
    expect(validateEuVat("de 123.456.789").normalized).toBe("DE123456789");
  });
});

describe("UK VAT modulus 97", () => {
  it("accepts the HMRC example and rejects a tweaked one", () => {
    expect(validateUkVat("GB980780684").valid).toBe(true);
    expect(validateUkVat("GB980780685").valid).toBe(false);
  });
  it("requires GB prefix and the right length; allows 12-digit branch ids", () => {
    expect(validateUkVat("980780684").valid).toBe(false);
    expect(validateUkVat("GB12345").valid).toBe(false);
    expect(validateUkVat("GB980780684001").valid).toBe(true);
    expect(validateUkVat("GBGD001").valid).toBe(true);
  });
});

describe("US states and dispatch", () => {
  it("validates state codes", () => {
    expect(validateUsState("ca").valid).toBe(true);
    expect(validateUsState("US-TX").normalized).toBe("TX");
    expect(validateUsState("ZZ").valid).toBe(false);
  });
  it("dispatches by regime", () => {
    expect(validateTaxId("india_gst", "27AAPFU0939F1ZV").valid).toBe(true);
    expect(validateTaxId("uk_vat", "GB980780684").valid).toBe(true);
    expect(validateTaxId("generic", "").valid).toBe(false);
  });
});

describe("VIES", () => {
  it("is offline/simulated unless VIES_ENABLED=1", async () => {
    const r = await lookupVies("DE123456789", {});
    expect(r).toMatchObject({ valid: true, checked: "simulated" });
    expect((await lookupVies("DE1", {})).valid).toBe(false);
  });
});
