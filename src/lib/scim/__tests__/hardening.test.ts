import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { scimBaseUrl } from "@/lib/scim/auth";
import { MAX_FILTER_LENGTH, parseFilter } from "@/lib/scim/schema";

describe("SCIM hardening", () => {
  it("rejects over-long filters before touching the regex", () => {
    const long = `userName eq "${"a".repeat(MAX_FILTER_LENGTH)}"`;
    expect(parseFilter(long)).toBeNull();
    expect(parseFilter('userName eq "ada@example.com"')).toEqual({ attr: "username", op: "eq", value: "ada@example.com" });
    // Pathological escape-heavy input must still return promptly.
    const started = Date.now();
    expect(parseFilter(`userName eq "${"\\\\".repeat(250)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
  it("uses the configured app origin for resource locations, ignoring forwarded host headers", () => {
    const req = new Request("https://internal:3000/api/scim/v2/Users", { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } });
    expect(scimBaseUrl(req, { NEXT_PUBLIC_APP_URL: "https://app.example.com/" })).toBe("https://app.example.com/api/scim/v2");
    expect(scimBaseUrl(req, {})).toBe("http://evil.example/api/scim/v2");
  });
});
