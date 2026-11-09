import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { createAudience, listAudiences } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { AudienceCreateSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const migrated = await tableExists("audiences");
    const audiences = migrated ? await listAudiences(s.scope.dataId) : [];
    return NextResponse.json({ audiences, migrated });
  } catch (err) {
    return marketingError(err, "marketing/audiences.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, AudienceCreateSchema, 32_000);
  if (!body.ok) return body.res;
  try {
    const audience = await createAudience(s.scope.dataId, body.data);
    await recordAudit(s.scope, { action: "marketing.audience.created", entity: "audience", entityId: audience.id, after: { summary: audience.name } });
    return NextResponse.json({ audience }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/audiences.create");
  }
}
