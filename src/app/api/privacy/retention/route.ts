import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RETENTION_ACTIONS, RETENTION_KINDS, RETENTION_META, RETENTION_NEVER } from "@/lib/privacy/constants";
import { listPolicies, upsertPolicy } from "@/lib/privacy/retention";
import { privacyError, privacyScope } from "../_lib";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

const PutSchema = z
  .object({
    entity_kind: z.enum(RETENTION_KINDS),
    keep_days: z.number().int().min(1).max(36500),
    action: z.enum(RETENTION_ACTIONS),
    enabled: z.boolean(),
  })
  .strict();

export async function GET() {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    return NextResponse.json({ policies: await listPolicies(s.scope.dataId), meta: RETENTION_META, never: RETENTION_NEVER });
  } catch (err) {
    return privacyError(err, "list retention");
  }
}

/** PUT — upsert one policy; keep_days is clamped to the statutory floor. */
export async function PUT(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const { entity_kind, ...rest } = parsed.data;
    const policy = await upsertPolicy(s.scope.dataId, entity_kind, rest);
    await recordAudit(s.scope, { action: "update", entity: "retention_policy", entityId: entity_kind, after: rest as Record<string, unknown>, req });
    return NextResponse.json({ policy });
  } catch (err) {
    return privacyError(err, "upsert retention");
  }
}
