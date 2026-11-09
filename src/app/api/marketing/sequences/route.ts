import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { createSequence, listSequences } from "@/lib/marketing/sequences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { SequenceCreateSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const migrated = await tableExists("sequences");
    const sequences = migrated ? await listSequences(s.scope.dataId) : [];
    return NextResponse.json({ sequences, migrated });
  } catch (err) {
    return marketingError(err, "marketing/sequences.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, SequenceCreateSchema, 200_000);
  if (!body.ok) return body.res;
  try {
    const sequence = await createSequence(s.scope.dataId, body.data);
    await recordAudit(s.scope, { action: "marketing.sequence.created", entity: "sequence", entityId: sequence.id, after: { summary: sequence.name } });
    return NextResponse.json({ sequence }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/sequences.create");
  }
}
