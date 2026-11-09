import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
const storage = vi.hoisted(() => ({ getObject: vi.fn() }));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/attachments/storage", () => storage);
vi.mock("@/lib/attachments/store", () => ({ entityExists: vi.fn(async () => true) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/money/quotes", () => ({ businessName: vi.fn(async () => "Acme") }));
vi.mock("@/lib/pdf/documents", () => ({ orgTimezone: vi.fn(async () => "UTC") }));
vi.mock("@/lib/branding", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/branding")>();
  return { ...mod, getBranding: vi.fn(async () => mod.DEFAULT_BRANDING) };
});

import { loadSignedPdf, SignedPdfIntegrityError } from "@/lib/documents/documents";
import { documentHash } from "@/lib/documents/render";
import type { DocumentDTO } from "@/lib/documents/types";

const signedBytes = Buffer.from("%PDF-1.4 signed legal record");
const signedHash = documentHash(new Uint8Array(signedBytes));

const doc: DocumentDTO = {
  id: "d1",
  template_id: null,
  title: "NDA",
  kind: "nda",
  body_md: "# Terms\n\nBe nice.",
  merge_data: {},
  status: "signed",
  signing_order: "parallel",
  contact_id: null,
  contact_name: null,
  record_id: null,
  quote_id: null,
  pdf_hash: "abc",
  signed_pdf_hash: signedHash,
  sent_at: "2026-01-01T00:00:00.000Z",
  viewed_at: null,
  completed_at: "2026-01-02T00:00:00.000Z",
  expires_at: null,
  created_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  signers: [],
};

describe("loadSignedPdf", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    storage.getObject.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("serves the stored, hash-verified full copy", async () => {
    db.queryOne.mockResolvedValueOnce({ storage_path: "p/full.pdf", content_type: "application/pdf", file_name: "NDA-signed.pdf", sha256: signedHash });
    storage.getObject.mockResolvedValueOnce({ bytes: signedBytes, contentType: "application/pdf" });
    const out = await loadSignedPdf("org-1", doc);
    expect(out.hash).toBe(signedHash);
    expect(out.filename).toBe("NDA-signed.pdf");
  });

  it("rejects a tampered full copy", async () => {
    db.queryOne.mockResolvedValueOnce({ storage_path: "p/full.pdf", content_type: "application/pdf", file_name: "NDA-signed.pdf", sha256: signedHash });
    storage.getObject.mockResolvedValueOnce({ bytes: Buffer.from("different"), contentType: "application/pdf" });
    await expect(loadSignedPdf("org-1", doc)).rejects.toBeInstanceOf(SignedPdfIntegrityError);
  });

  it("falls back to a redacted render (with a warning) when only the pre-change full copy exists", async () => {
    db.queryOne.mockResolvedValueOnce(null); // no -signed-public.pdf row
    db.queryOne.mockResolvedValueOnce({ storage_path: "p/full.pdf", content_type: "application/pdf", file_name: "NDA-signed.pdf", sha256: signedHash });
    storage.getObject.mockResolvedValueOnce({ bytes: signedBytes, contentType: "application/pdf" });
    db.query.mockResolvedValueOnce([]); // listSignersWithEvidence
    const out = await loadSignedPdf("org-1", doc, { redacted: true });
    expect(out.signed).toBe(true);
    expect(out.bytes.byteLength).toBeGreaterThan(0);
    expect(out.hash).not.toBe(signedHash);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no stored public signed copy"));
  });

  it("still fails closed when neither copy is stored", async () => {
    db.queryOne.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce(null);
    await expect(loadSignedPdf("org-1", doc, { redacted: true })).rejects.toBeInstanceOf(SignedPdfIntegrityError);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
