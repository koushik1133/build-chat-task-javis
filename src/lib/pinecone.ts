import { Pinecone } from "@pinecone-database/pinecone";

// Single shared client. Pinecone handles embeddings inline via "integrated
// inference" — we never send vectors ourselves, just text + metadata.
let _pc: Pinecone | null = null;
function pc() {
  if (!_pc) _pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  return _pc;
}

const INDEX = process.env.PINECONE_INDEX ?? "javis-rag";
const EMBED_MODEL = "multilingual-e5-large"; // 1024-dim, hosted by Pinecone

// Idempotent index bootstrap. Called lazily so cold starts don't pay this cost.
export async function ensureIndex() {
  const list = await pc().listIndexes();
  if (list.indexes?.some((i) => i.name === INDEX)) return;
  await pc().createIndexForModel({
    name: INDEX,
    cloud: "aws",
    region: "us-east-1",
    embed: { model: EMBED_MODEL, fieldMap: { text: "chunk_text" } },
    waitUntilReady: true,
  });
}

type ChunkRecord = {
  id: string;
  chunk_text: string;
  file_id: string;
  file_name: string;
  user_id: string;
};

export async function upsertChunks(userId: string, records: ChunkRecord[]) {
  if (records.length === 0) return;
  await ensureIndex();
  const ns = pc().index(INDEX).namespace(userId);
  // upsertRecords runs the model server-side and stores vectors for us.
  for (let i = 0; i < records.length; i += 96) {
    await ns.upsertRecords({ records: records.slice(i, i + 96) });
  }
}

export type RetrievedChunk = {
  text: string;
  fileName: string;
  fileId: string;
  score: number;
};

export async function searchChunks(
  userId: string,
  query: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  await ensureIndex();
  const ns = pc().index(INDEX).namespace(userId);
  const res = await ns.searchRecords({
    query: { topK, inputs: { text: query } },
    fields: ["chunk_text", "file_name", "file_id"],
  });
  return (res.result?.hits ?? []).map((h) => {
    const f = (h.fields ?? {}) as Record<string, unknown>;
    return {
      text: String(f.chunk_text ?? ""),
      fileName: String(f.file_name ?? ""),
      fileId: String(f.file_id ?? ""),
      score: h._score ?? 0,
    };
  });
}

export async function deleteFile(userId: string, fileId: string) {
  await ensureIndex();
  const ns = pc().index(INDEX).namespace(userId);
  // listPaginated → deleteMany by id is the safe path for hosted indexes.
  let pageToken: string | undefined;
  do {
    const page = await ns.listPaginated({ prefix: `${fileId}:`, paginationToken: pageToken });
    const ids = (page.vectors ?? []).map((v) => v.id!).filter(Boolean);
    if (ids.length) await ns.deleteMany(ids);
    pageToken = page.pagination?.next;
  } while (pageToken);
}
