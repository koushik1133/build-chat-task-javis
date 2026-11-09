import { describe, expect, it } from "vitest";
import { resolveAttachmentType } from "@/lib/attachments/types";
import { isReservedSignedPdfName } from "@/lib/documents/documents";

/** SEC: the declared MIME must agree with the file extension; reserved signed-copy names are refused on uploads. */
describe("attachment type / extension consistency", () => {
  it("refuses a declared type that disagrees with the extension", () => {
    expect(resolveAttachmentType("text/plain", "payload.html")).toBeNull();
    expect(resolveAttachmentType("application/pdf", "evil.html")).toBeNull();
    expect(resolveAttachmentType("image/png", "shot.jpg")).toBeNull();
    expect(resolveAttachmentType("text/csv", "data.txt")).toBeNull();
  });

  it("still accepts matching pairs and names without an extension", () => {
    expect(resolveAttachmentType("application/pdf", "x.pdf")?.ext).toBe("pdf");
    expect(resolveAttachmentType("image/jpeg", "photo.jpeg")?.ext).toBe("jpg");
    expect(resolveAttachmentType("image/jpeg", "photo.JPG")?.ext).toBe("jpg");
    expect(resolveAttachmentType("text/plain", "notes")?.ext).toBe("txt");
    expect(resolveAttachmentType("", "report.docx")?.ext).toBe("docx");
  });

  it("reserves the completion writer's file names", () => {
    expect(isReservedSignedPdfName("contract-signed.pdf")).toBe(true);
    expect(isReservedSignedPdfName("Contract-Signed-Public.PDF")).toBe(true);
    expect(isReservedSignedPdfName("contract.pdf")).toBe(false);
    expect(isReservedSignedPdfName("signed-notes.pdf")).toBe(false);
  });
});
