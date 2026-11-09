import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { INCIDENT_SEVERITIES } from "@/lib/privacy/constants";
import { createIncident, listIncidents } from "@/lib/privacy/incidents";
import { privacyError, privacyScope } from "../_lib";

export const runtime = "nodejs";

const Schema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).nullable().optional(),
    severity: z.enum(INCIDENT_SEVERITIES),
    detected_at: z.string().datetime(),
    affected_count: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export async function GET() {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    return NextResponse.json({ incidents: await listIncidents(s.scope.dataId) });
  } catch (err) {
    return privacyError(err, "list incidents");
  }
}

export async function POST(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    return NextResponse.json({ incident: await createIncident(s.scope.dataId, parsed.data, s.scope.userId) }, { status: 201 });
  } catch (err) {
    return privacyError(err, "create incident");
  }
}
