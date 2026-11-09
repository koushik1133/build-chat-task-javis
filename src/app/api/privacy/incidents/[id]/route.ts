import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from "@/lib/privacy/constants";
import { updateIncident } from "@/lib/privacy/incidents";
import { privacyError, privacyScope } from "../../_lib";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const Schema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    status: z.enum(INCIDENT_STATUSES).optional(),
    contained_at: z.string().datetime().nullable().optional(),
    notified_authority_at: z.string().datetime().nullable().optional(),
    notified_subjects_at: z.string().datetime().nullable().optional(),
    affected_count: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const { id } = await ctx.params;
    const incident = await updateIncident(s.scope.dataId, id, parsed.data, s.scope.userId);
    if (!incident) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ incident });
  } catch (err) {
    return privacyError(err, "update incident");
  }
}
