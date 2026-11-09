import { describe, expect, it } from "vitest";
import { generateGiftCode, hashGiftCode } from "../giftcards";
import { surveyToken, surveyTokenHash, verifySurveyToken } from "../surveys";

describe("survey tokens", () => {
  it("round-trips and rejects tampering", () => {
    const t = surveyToken("req-1");
    expect(verifySurveyToken(t)).toBe("req-1");
    expect(verifySurveyToken(t.slice(0, -2) + "xx")).toBeNull();
    expect(verifySurveyToken(`${Buffer.from("s|other").toString("base64url")}.${t.split(".")[1]}`)).toBeNull();
    expect(verifySurveyToken("garbage")).toBeNull();
    expect(verifySurveyToken(null)).toBeNull();
    expect(surveyTokenHash(t)).toHaveLength(64);
  });
});

describe("gift card codes", () => {
  it("generates grouped unambiguous codes and hashes per org", () => {
    const c = generateGiftCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(generateGiftCode()).not.toBe(c);
    expect(hashGiftCode("o1", c)).toBe(hashGiftCode("o1", c.toLowerCase().replace(/-/g, " ")));
    expect(hashGiftCode("o1", c)).not.toBe(hashGiftCode("o2", c));
  });
});
