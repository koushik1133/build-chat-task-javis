import { describe, expect, it } from "vitest";
import { sniffOffice, verifyDeclaredType } from "@/lib/attachments/sniff";
import { BodyTooLargeError, byteCapTransform, isBodyTooLarge } from "@/lib/attachments/body-limit";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function zip(entries: string[]): Buffer {
  // Minimal fake: local file header signature followed by entry names (what the sniffer reads).
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(entries.join("\0"), "latin1")]);
}
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

describe("office MIME sniffing", () => {
  it("recognises docx/xlsx by the ZIP header + [Content_Types].xml + part names", () => {
    expect(sniffOffice(zip(["[Content_Types].xml", "word/document.xml"]))).toBe("docx");
    expect(sniffOffice(zip(["[Content_Types].xml", "xl/workbook.xml"]))).toBe("xlsx");
    expect(sniffOffice(zip(["[Content_Types].xml"]))).toBe("ooxml");
    expect(sniffOffice(zip(["evil.exe"]))).toBe("zip");
    expect(sniffOffice(OLE)).toBe("ole");
    expect(sniffOffice(Buffer.from("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffOffice(Buffer.from("plain text"))).toBeNull();
  });

  it("accepts matching declarations and rejects mismatches", () => {
    expect(verifyDeclaredType(DOCX, zip(["[Content_Types].xml", "word/document.xml"]))).toBeNull();
    expect(verifyDeclaredType(XLSX, zip(["[Content_Types].xml", "xl/workbook.xml"]))).toBeNull();
    expect(verifyDeclaredType("application/msword", OLE)).toBeNull();
    expect(verifyDeclaredType("application/pdf", Buffer.from("%PDF-1.4"))).toBeNull();
    expect(verifyDeclaredType("text/csv", Buffer.from("a,b\n1,2\n"))).toBeNull();

    expect(verifyDeclaredType(DOCX, zip(["[Content_Types].xml", "xl/workbook.xml"]))).toMatch(/not a valid DOCX/);
    expect(verifyDeclaredType(DOCX, zip(["payload.bin"]))).toMatch(/not a valid DOCX/);
    expect(verifyDeclaredType(XLSX, OLE)).toMatch(/legacy Office/);
    expect(verifyDeclaredType("application/msword", Buffer.from("MZ\x90\x00"))).toMatch(/not a valid legacy/);
    expect(verifyDeclaredType("application/pdf", zip(["[Content_Types].xml"]))).toMatch(/not a valid PDF/);
    expect(verifyDeclaredType("text/plain", OLE)).toMatch(/must not contain/);
    expect(verifyDeclaredType("text/csv", Buffer.from("ab\0cd"))).toMatch(/binary/);
  });
});

describe("streaming byte cap", () => {
  async function pump(chunks: number[], cap: number): Promise<number> {
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n));
        c.close();
      },
    });
    const reader = src.pipeThrough(byteCapTransform(cap)).getReader();
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) return total;
      total += r.value.byteLength;
    }
  }

  it("passes bodies under the cap and aborts once accumulated bytes exceed it", async () => {
    await expect(pump([100, 100, 100], 300)).resolves.toBe(300);
    await expect(pump([200, 200], 300)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(isBodyTooLarge(new BodyTooLargeError(5))).toBe(true);
    expect(isBodyTooLarge(new Error("nope"))).toBe(false);
  });
});
