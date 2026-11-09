import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC: a visitor types an email; that email is unverified. The handoff must
 * not attach the session (transcript, consent changes) to an existing CRM
 * contact that happens to share the address.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/receptionist/inbound-agent", () => ({ handleInboundMessage: vi.fn() }));
vi.mock("@/lib/twilio-webhook", () => ({
  parseConversation: () => [],
  saveConversation: vi.fn(async () => ({ id: "conv1" })),
}));
const consent = vi.hoisted(() => ({ recordConsent: vi.fn<(dataId: string, subject: { kind: string; id: string }, ...rest: unknown[]) => Promise<void>>(async () => undefined) }));
vi.mock("@/lib/privacy/consent", () => consent);

import { requestHandoff } from "@/lib/webchat/service";
import type { ChatSessionRow } from "@/lib/webchat/session";

const session: ChatSessionRow = { id: "s1", user_id: "org1", site_id: "site1", visitor_id: null, conversation_id: "conv1", contact_id: null, lead_id: null, status: "open", page_url: null, user_agent: null, expires_at: "2099-01-01T00:00:00Z", started_at: "", last_seen_at: "", closed_at: null };

describe("webchat handoff never adopts an existing contact", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    consent.recordConsent.mockClear();
  });

  it("creates a fresh contact, records the match as a hint and keeps contact consent off the existing record", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "c-existing" }); // email lookup
    db.queryOne.mockResolvedValueOnce({ id: "c-new" }); // INSERT crm_contacts RETURNING
    db.queryOne.mockResolvedValueOnce({ messages: null }); // loadTurns
    const out = await requestHandoff(session, { name: "Eve", email: "ceo@victim.test", consent: { marketing: false } });

    expect(out.contactId).toBe("c-new");
    const insertLead = db.query.mock.calls.find(([sql]) => /INSERT INTO site_leads/.test(sql));
    expect(insertLead).toBeDefined();
    const leadData = JSON.parse(String(insertLead?.[1]?.[3])) as { possible_contact_id: string | null; email: string };
    expect(leadData.possible_contact_id).toBe("c-existing");
    const link = db.query.mock.calls.find(([sql]) => /UPDATE chat_sessions SET contact_id/.test(sql));
    expect(link?.[1]?.[1]).toBe("c-new");

    const subjects = consent.recordConsent.mock.calls.map((c) => c[1]);
    expect(subjects.some((s) => s.id === "c-existing")).toBe(false);
    expect(subjects.some((s) => s.kind === "contact" && s.id === "c-new")).toBe(true);
    expect(subjects.some((s) => s.kind === "lead")).toBe(true);
  });

  it("re-uses the contact the session itself created earlier", async () => {
    db.queryOne.mockResolvedValueOnce({ messages: null }); // loadTurns
    const out = await requestHandoff({ ...session, contact_id: "c-mine" }, { name: "Eve", phone: "+15550000000", consent: { marketing: true } });
    expect(out.contactId).toBe("c-mine");
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO crm_contacts/.test(sql))).toBe(false);
    expect(consent.recordConsent.mock.calls.some((c) => c[1].id === "c-mine")).toBe(true);
  });
});
