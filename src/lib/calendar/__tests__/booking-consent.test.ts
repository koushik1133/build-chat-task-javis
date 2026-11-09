import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), withRetry: (fn: () => unknown) => fn() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn(async () => "n") }));
const consent = vi.hoisted(() => ({ recordConsent: vi.fn(async () => ({})) }));
vi.mock("@/lib/privacy/consent", () => consent);

import { consentSubjectForBooking, recordBookingConsent } from "@/lib/calendar/booking";
import { CONSENT_SUBJECT_KINDS } from "@/lib/privacy/constants";

describe("booking consent subject", () => {
  it("binds consent to the contact only when the booking created it, else to the booking itself", () => {
    expect(consentSubjectForBooking({ id: "b1", contact_id: "c1", contactCreated: true })).toEqual({ kind: "contact", id: "c1" });
    // Existing customer matched by email: a public form must not flip their consent.
    expect(consentSubjectForBooking({ id: "b1", contact_id: "c1", contactCreated: false })).toEqual({ kind: "booking", id: "b1" });
    expect(consentSubjectForBooking({ id: "b1", contact_id: null, contactCreated: false })).toEqual({ kind: "booking", id: "b1" });
    expect(CONSENT_SUBJECT_KINDS).toContain("booking");
  });

  it("records email + sms purposes against the chosen subject", async () => {
    const booking = { id: "b9", contact_id: "c9" } as unknown as Parameters<typeof recordBookingConsent>[1]["booking"];
    const subject = await recordBookingConsent("org-1", { booking, contactCreated: false }, true, { ip: "1.2.3.4", text_version: "booking:intro" });
    expect(subject).toEqual({ kind: "booking", id: "b9" });
    expect(consent.recordConsent).toHaveBeenCalledTimes(2);
    expect(consent.recordConsent).toHaveBeenCalledWith("org-1", { kind: "booking", id: "b9" }, "marketing_email", "granted", "form", expect.objectContaining({ ip: "1.2.3.4" }));
    expect(consent.recordConsent).toHaveBeenCalledWith("org-1", { kind: "booking", id: "b9" }, "marketing_sms", "granted", "form", expect.anything());
  });
});
