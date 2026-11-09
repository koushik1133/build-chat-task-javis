import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DSR_KINDS, DSR_STATUSES, DSR_SUBJECT_KINDS } from "@/lib/privacy/constants";
import { listRequests, openRequest } from "@/lib/privacy/dsr";
import { privacyError, privacyScope } from "../_lib";

export const runtime = "nodejs";

const CreateSchema = z
  .object({
    subject_kind: z.enum(DSR_SUBJECT_KINDS),
    subject_id: z.string().min(1).max(80),
    kind: z.enum(DSR_KINDS),
    email: z.string().trim().email().max(320).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/** GET /api/privacy/requests?status=open|<status> */
export async function GET(req: NextRequest) {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    const status = new URL(req.url).searchParams.get("status");
    const ok = status === "open" || (DSR_STATUSES as readonly string[]).includes(status ?? "");
    const requests = await listRequests(s.scope.dataId, { status: ok ? (status as "open") : null });
    return NextResponse.json({ requests });
  } catch (err) {
    return privacyError(err, "list requests");
  }
}

/** POST /api/privacy/requests — staff opens a request on behalf of a subject. */
export async function POST(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const request = await openRequest(s.scope.dataId, {
      subject: { kind: parsed.data.subject_kind, id: parsed.data.subject_id },
      kind: parsed.data.kind,
      email: parsed.data.email ?? null,
      notes: parsed.data.notes ?? null,
      source: "staff",
      handledBy: s.scope.userId,
    });
    return NextResponse.json({ request }, { status: 201 });
  } catch (err) {
    return privacyError(err, "open request");
  }
}
