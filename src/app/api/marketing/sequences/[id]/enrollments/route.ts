import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { getSequence, listEnrollments } from "@/lib/marketing/sequences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { ENROLLMENT_STATUSES, type EnrollmentStatus } from "@/lib/marketing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    if (!(await getSequence(s.scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const raw = req.nextUrl.searchParams.get("status");
    const status = (ENROLLMENT_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as EnrollmentStatus) : null;
    const enrollments = await listEnrollments(s.scope.dataId, id, { status, limit: 200 });
    return NextResponse.json({ enrollments });
  } catch (err) {
    return marketingError(err, "marketing/sequences.enrollments");
  }
}
