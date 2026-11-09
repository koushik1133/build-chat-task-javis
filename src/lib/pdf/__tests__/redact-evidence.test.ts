import { describe, expect, it } from "vitest";
import { REDACTED_EVIDENCE, renderQuotePdf, type QuoteDocInput, type SignatureStamp } from "@/lib/pdf/quote-document";

const quote: QuoteDocInput = {
  number: "Q-77",
  status: "accepted",
  currency: "USD",
  items: [{ description: "Design", quantity: 1, unit_minor: 10_000, total_minor: 10_000 }],
  subtotal_minor: 10_000,
  tax_minor: 0,
  total_minor: 10_000,
  valid_until: null,
  terms_version: "v1",
  terms_text: "Pay in 30 days",
  notes: null,
  contact_name: "Ada",
  contact_email: "ada@example.com",
  created_at: "2026-01-01T00:00:00Z",
  sent_at: null,
  current_version: 1,
} as unknown as QuoteDocInput;

const stamp: SignatureStamp = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  signature_text: "Ada",
  signed_at: "2026-01-02T10:00:00Z",
  ip: "203.0.113.9",
  user_agent: "Mozilla/5.0 TestBrowser",
  consent_terms_version: "v1",
  consent_terms_text: "Pay in 30 days",
  document_hash: "a".repeat(64),
} as SignatureStamp;

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("quote PDF evidence redaction", () => {
  it("prints the raw IP and user agent by default (authenticated PDF)", () => {
    const pdf = text(renderQuotePdf(quote, stamp, { brand_name: "Acme" }, {}));
    expect(pdf).toContain("203.0.113.9");
    expect(pdf).toContain("TestBrowser");
    expect(pdf).not.toContain(REDACTED_EVIDENCE);
  });
  it("replaces them with a generic line when redactEvidence is set (public PDF)", () => {
    const pdf = text(renderQuotePdf(quote, stamp, { brand_name: "Acme" }, { redactEvidence: true }));
    expect(pdf).toContain(REDACTED_EVIDENCE);
    expect(pdf).not.toContain("203.0.113.9");
    expect(pdf).not.toContain("TestBrowser");
    // Signature + fingerprint are untouched.
    expect(pdf).toContain("Ada Lovelace");
    expect(pdf).toContain("a".repeat(64));
  });
});
