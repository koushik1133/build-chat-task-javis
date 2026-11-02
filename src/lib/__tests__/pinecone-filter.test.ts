import { describe, expect, it } from "vitest";
import { CORRECTION_FILE_PREFIX, filterRetrieved } from "@/lib/pinecone";

const hits = [
  { text: "kb", fileName: "guide.pdf", fileId: "f1", score: 0.9 },
  { text: "Instead of: crm.create_contact {…}", fileName: "correction x", fileId: `${CORRECTION_FILE_PREFIX}abc`, score: 0.95 },
];

describe("filterRetrieved", () => {
  it("hides correction memories from knowledge searches by default", () => {
    expect(filterRetrieved(hits).map((h) => h.fileId)).toEqual(["f1"]);
  });
  it("keeps them only when the corrections recall asks", () => {
    expect(filterRetrieved(hits, { includeCorrections: true })).toHaveLength(2);
  });
});
