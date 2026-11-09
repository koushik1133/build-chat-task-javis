import { describe, expect, it } from "vitest";
import { objectKey } from "@/lib/attachments/storage";

describe("objectKey (SEC: tenant prefix cannot be escaped)", () => {
  it("builds tenant-first keys from plain ids", () => {
    expect(objectKey("org_1", "contact", "c_123", "f-1")).toBe("org_1/contact/c_123/f-1");
    expect(objectKey("5f1c8e1a-0f3b-4c1e-9a0b-0c7a4d9e1a2b", "document", "d:1", "a@b")).toMatch(/^5f1c8e1a-/);
  });

  it("rejects traversal, separators and empty segments", () => {
    for (const bad of ["../../victim/contact/x", "..", ".", "", "a/b", "a\\b", "c%2e%2e", " c", "c 1", "x".repeat(201)]) {
      expect(() => objectKey("org_1", "record", bad, "f-1"), bad).toThrow(/invalid storage key segment/);
    }
    expect(() => objectKey("../org_2", "record", "r1", "f-1")).toThrow(/invalid storage key segment/);
  });
});
