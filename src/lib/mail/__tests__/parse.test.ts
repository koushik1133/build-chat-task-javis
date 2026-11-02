import { describe, expect, it } from "vitest";
import {
  buildRawEmail,
  decodeBase64Url,
  encodeHeader,
  extractAddress,
  extractName,
  htmlToText,
  mailToTurn,
  normalizeSubject,
  parseGmailMessage,
  parseGraphMessage,
  replySubject,
  splitAddresses,
  stripQuotedReply,
  threadKeyFor,
  type GmailMessage,
} from "@/lib/mail/parse";
import { createOauthState, verifyOauthState } from "@/lib/mail/oauth";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** Fixture: a multipart/alternative Gmail message as `messages.get?format=full` returns it. */
const GMAIL_FIXTURE: GmailMessage = {
  id: "18f1a2b3c4d5e6f7",
  threadId: "18f1a2b3c4d5e000",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  snippet: "Hi there, I'd like a quote for a kitchen remodel…",
  internalDate: "1730000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Jane Doe" <Jane.Doe@Example.com>' },
      { name: "To", value: "Office <office@acme.test>, cc-person@acme.test" },
      { name: "Cc", value: "boss@acme.test" },
      { name: "Subject", value: "Re: Quote for kitchen remodel" },
      { name: "Message-ID", value: "<abc@example.com>" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64url("Hi there,\n\nI'd like a quote for a kitchen remodel — ~20m².\n\nOn Mon, Jane wrote:\n> old stuff") } },
      { mimeType: "text/html", body: { data: b64url("<p>Hi there,</p><p>I'd like a quote for a <b>kitchen remodel</b> — ~20m².</p>") } },
      { mimeType: "application/pdf", filename: "plan.pdf", body: { attachmentId: "att1", size: 1234 } },
    ],
  },
};

describe("base64url + headers", () => {
  it("decodes base64url with and without padding, including unicode", () => {
    expect(decodeBase64Url(b64url("héllo — wörld"))).toBe("héllo — wörld");
    expect(decodeBase64Url("aGk")).toBe("hi");
    expect(decodeBase64Url("")).toBe("");
    expect(decodeBase64Url(null)).toBe("");
  });

  it("extracts addresses and names", () => {
    expect(extractAddress('"Jane Doe" <Jane.Doe@Example.com>')).toBe("jane.doe@example.com");
    expect(extractAddress("plain@x.com")).toBe("plain@x.com");
    expect(extractName('"Jane Doe" <jane@x.com>')).toBe("Jane Doe");
    expect(extractName("jane@x.com")).toBeNull();
    expect(splitAddresses("A <a@x.com>, b@x.com ,")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("encodes non-ASCII subjects per RFC 2047 and strips CRLF injection", () => {
    expect(encodeHeader("Plain subject")).toBe("Plain subject");
    expect(encodeHeader("Evil\r\nBcc: x@y.z")).toBe("Evil Bcc: x@y.z");
    expect(encodeHeader("Grüße")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe("parseGmailMessage", () => {
  it("parses headers, bodies, labels and direction from the fixture", () => {
    const m = parseGmailMessage(GMAIL_FIXTURE, "office@acme.test");
    expect(m.providerMessageId).toBe("18f1a2b3c4d5e6f7");
    expect(m.threadId).toBe("18f1a2b3c4d5e000");
    expect(m.from).toBe("jane.doe@example.com");
    expect(m.fromName).toBe("Jane Doe");
    expect(m.to).toEqual(["office@acme.test", "cc-person@acme.test", "boss@acme.test"]);
    expect(m.subject).toBe("Re: Quote for kitchen remodel");
    expect(m.bodyText).toContain("kitchen remodel — ~20m²");
    expect(m.bodyHtml).toContain("<b>kitchen remodel</b>");
    expect(m.direction).toBe("in");
    expect(m.isRead).toBe(false);
    expect(m.labels).toContain("INBOX");
    expect(m.receivedAt).toBe(new Date(1730000000000).toISOString());
  });

  it("treats mail from the account itself / SENT label as outbound and falls back to html→text", () => {
    const sent: GmailMessage = {
      id: "x",
      labelIds: ["SENT"],
      payload: { mimeType: "text/html", headers: [{ name: "From", value: "office@acme.test" }, { name: "To", value: "jane@x.com" }], body: { data: b64url("<div>Thanks<br>Jane</div>") } },
    };
    const m = parseGmailMessage(sent, "office@acme.test");
    expect(m.direction).toBe("out");
    expect(m.bodyText).toBe("Thanks\nJane");
    expect(m.isRead).toBe(true);
  });

  it("builds a raw RFC 2822 message for messages.send", () => {
    const raw = Buffer.from(buildRawEmail({ from: "office@acme.test", to: ["jane@x.com"], subject: "Re: Quote", text: "Hello\nJane", inReplyTo: "<abc@example.com>" }), "base64url").toString("utf8");
    expect(raw).toContain("From: office@acme.test\r\nTo: jane@x.com\r\nSubject: Re: Quote");
    expect(raw).toContain("In-Reply-To: <abc@example.com>");
    expect(raw.endsWith("\r\n\r\nHello\nJane")).toBe(true);
  });
});

describe("parseGraphMessage", () => {
  it("maps Graph fields and converts HTML bodies", () => {
    const m = parseGraphMessage(
      {
        id: "AAMk1",
        conversationId: "AAQk1",
        subject: "Hello",
        bodyPreview: "Hi",
        receivedDateTime: "2025-01-01T10:00:00Z",
        isRead: false,
        from: { emailAddress: { address: "Bob@Contoso.com", name: "Bob" } },
        toRecipients: [{ emailAddress: { address: "me@acme.test" } }],
        body: { contentType: "html", content: "<p>Hi &amp; bye</p>" },
      },
      "me@acme.test"
    );
    expect(m.from).toBe("bob@contoso.com");
    expect(m.fromName).toBe("Bob");
    expect(m.threadId).toBe("AAQk1");
    expect(m.bodyText).toBe("Hi & bye");
    expect(m.direction).toBe("in");
    expect(m.isRead).toBe(false);
  });
});

describe("thread → conversation mapping", () => {
  const base = { threadId: null, subject: "Re: RE: Fwd: Quote", from: "jane@x.com", to: ["me@acme.test"], direction: "in" as const };

  it("prefers the provider thread id, else subject + counterpart (Re:/Fwd: folded)", () => {
    expect(threadKeyFor("acc1", { ...base, threadId: "t1" })).toBe("email:acc1:t1");
    expect(threadKeyFor("acc1", base)).toBe("email:acc1:jane@x.com:quote");
    expect(threadKeyFor("acc1", { ...base, subject: "Quote" })).toBe(threadKeyFor("acc1", base));
    // an outbound reply to the same person lands in the same thread
    expect(threadKeyFor("acc1", { ...base, direction: "out", from: "me@acme.test", to: ["jane@x.com"], subject: "RE: Quote" })).toBe(threadKeyFor("acc1", base));
    expect(normalizeSubject("  Re: re: AW: Hello ")).toBe("hello");
  });

  it("turns inbound mail into a customer turn and outbound into an assistant turn", () => {
    const t = mailToTurn({ direction: "in", subject: "Quote", bodyText: "Body text\n\nOn Mon, x wrote:\n> quoted", receivedAt: "2025-01-01T00:00:00Z" });
    expect(t).toEqual({ role: "user", content: "Quote\n\nBody text", ts: "2025-01-01T00:00:00Z" });
    const o = mailToTurn({ direction: "out", subject: "Re: Quote", bodyText: "Sure", receivedAt: "2025-01-02T00:00:00Z" }, { includeSubject: false });
    expect(o.role).toBe("assistant");
    expect(o.content).toBe("Sure");
    expect(mailToTurn({ direction: "in", subject: "", bodyText: "", receivedAt: "x" }).content).toBe("(empty message)");
  });

  it("strips quoted history and builds reply subjects", () => {
    expect(stripQuotedReply("new\n> old\n> older\nmore")).toBe("new\nmore");
    expect(replySubject("Quote")).toBe("Re: Quote");
    expect(replySubject("re: Quote")).toBe("re: Quote");
    expect(replySubject("")).toBe("Re: (no subject)");
    expect(htmlToText("<style>p{}</style><p>a</p><p>b</p>")).toBe("a\nb");
  });
});

describe("oauth state", () => {
  it("round-trips, binds to provider and cookie, and expires", () => {
    const s = createOauthState("gmail", 1_000_000);
    expect(verifyOauthState(s, s, "gmail", 1_000_000 + 1000)).toBe(true);
    expect(verifyOauthState(s, s, "outlook", 1_000_000 + 1000)).toBe(false);
    expect(verifyOauthState(s, "other", "gmail", 1_000_000 + 1000)).toBe(false);
    expect(verifyOauthState(s, s, "gmail", 1_000_000 + 11 * 60_000)).toBe(false);
    const tampered = s.slice(0, -2) + "zz";
    expect(verifyOauthState(tampered, tampered, "gmail", 1_000_000 + 1000)).toBe(false);
    expect(verifyOauthState(null, s, "gmail")).toBe(false);
  });
});
