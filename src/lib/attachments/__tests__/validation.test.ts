import { describe, expect, it } from "vitest";
import { ATTACHMENT_ENTITY_KINDS, AREA_FOR_ENTITY, MAX_ATTACHMENT_BYTES, formatBytes, resolveAttachmentType, safeFileName, validateAttachmentMeta } from "@/lib/attachments/types";
import { objectKey, storageMode } from "@/lib/attachments/storage";
import { sniffImage } from "@/lib/image-sniff";

describe("attachment validation", () => {
  it("accepts the allowed document and image types by declared MIME or extension", () => {
    expect(resolveAttachmentType("application/pdf", "x.pdf")?.ext).toBe("pdf");
    expect(resolveAttachmentType("", "report.docx")?.ext).toBe("docx");
    expect(resolveAttachmentType("application/octet-stream", "data.csv")?.mime).toBe("text/csv");
    expect(resolveAttachmentType("application/vnd.ms-excel", "data.csv")?.mime).toBe("text/csv");
    expect(resolveAttachmentType("image/jpeg", "photo.JPG")?.ext).toBe("jpg");
  });

  it("refuses executables, scripts, svg and unknown types", () => {
    expect(resolveAttachmentType("application/x-msdownload", "evil.exe")).toBeNull();
    expect(resolveAttachmentType("text/html", "page.html")).toBeNull();
    expect(resolveAttachmentType("image/svg+xml", "logo.svg")).toBeNull();
    expect(resolveAttachmentType("application/octet-stream", "blob.bin")).toBeNull();
    expect(validateAttachmentMeta({ name: "a.exe", size: 10, type: "" })).toMatch(/Allowed types/);
  });

  it("enforces size limits and names", () => {
    expect(validateAttachmentMeta({ name: "a.pdf", size: 0, type: "application/pdf" })).toMatch(/empty/);
    expect(validateAttachmentMeta({ name: "a.pdf", size: MAX_ATTACHMENT_BYTES + 1, type: "application/pdf" })).toMatch(/20 MB/);
    expect(validateAttachmentMeta({ name: "a.pdf", size: MAX_ATTACHMENT_BYTES, type: "application/pdf" })).toBeNull();
    expect(validateAttachmentMeta({ name: "", size: 10, type: "application/pdf" })).toMatch(/name/);
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\inv\u0000oice.pdf")).toBe("invoice.pdf");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
  });

  it("image bytes are sniffed, not trusted from the declared type", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    expect(sniffImage(png, null)?.mime).toBe("image/png");
    expect(sniffImage(Buffer.from("<script>alert(1)</script>"), "image/png")).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), null)?.mime).toBe("image/jpeg");
  });

  it("maps every entity kind to a permission area and builds tenant-first object keys", () => {
    for (const k of ATTACHMENT_ENTITY_KINDS) expect(AREA_FOR_ENTITY[k]).toBeTruthy();
    expect(objectKey("org1", "quote", "q1", "a1")).toBe("org1/quote/q1/a1");
  });

  it("falls back to local storage only outside production and when storage is unconfigured or forced", () => {
    expect(storageMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("supabase");
    expect(storageMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("local");
    expect(storageMode({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv)).toBe("supabase");
    expect(storageMode({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", ATTACHMENTS_LOCAL_DIR: ".data/a" } as NodeJS.ProcessEnv)).toBe("local");
  });
});
