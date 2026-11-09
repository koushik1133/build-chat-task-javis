import { describe, expect, it } from "vitest";
import { outboundUrlRefusal } from "@/lib/webhooks/url";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const privateLookup = async () => [{ address: "10.0.0.5" }];

describe("outboundUrlRefusal (legacy webhook destinations)", () => {
  it("allows a public https host", async () => {
    expect(await outboundUrlRefusal("https://hooks.example.com/x", { lookup: publicLookup, env: {} })).toBeNull();
  });
  it("refuses http, IP literals and localhost in production", async () => {
    const env = { NODE_ENV: "production" };
    expect(await outboundUrlRefusal("http://hooks.example.com/x", { lookup: publicLookup, env })).toMatch(/public https/);
    expect(await outboundUrlRefusal("https://169.254.169.254/latest", { lookup: publicLookup, env })).toMatch(/public https/);
    expect(await outboundUrlRefusal("http://localhost:3000/hook", { lookup: publicLookup, env: { ...env, WEBHOOKS_ALLOW_INSECURE: "1" } })).toMatch(/public https/);
  });
  it("refuses a public name that resolves privately (rebinding)", async () => {
    expect(await outboundUrlRefusal("https://evil.example.com/x", { lookup: privateLookup, env: {} })).toMatch(/private or internal/);
  });
  it("allows http://localhost only in dev with WEBHOOKS_ALLOW_INSECURE=1", async () => {
    expect(await outboundUrlRefusal("http://localhost:3000/hook", { env: { NODE_ENV: "development", WEBHOOKS_ALLOW_INSECURE: "1" } })).toBeNull();
    expect(await outboundUrlRefusal("http://localhost:3000/hook", { env: { NODE_ENV: "development" } })).not.toBeNull();
  });
});
