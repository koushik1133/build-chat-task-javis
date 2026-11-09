import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_DSR_DUE_DAYS } from "@/lib/privacy/constants";
import { getPrivacySettings, updatePrivacySettings } from "@/lib/privacy/settings";
import { privacyError, privacyScope } from "../_lib";

export const runtime = "nodejs";

const Schema = z
  .object({
    grievance_officer_name: z.string().trim().max(200).nullable().optional(),
    grievance_officer_email: z.string().trim().email().max(320).nullable().optional(),
    dsr_due_days: z.number().int().min(1).max(MAX_DSR_DUE_DAYS).optional(),
    auto_fulfil_access: z.boolean().optional(),
  })
  .strict();

export async function GET() {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    return NextResponse.json({ settings: await getPrivacySettings(s.scope.dataId), slug: s.scope.orgSlug });
  } catch (err) {
    return privacyError(err, "get settings");
  }
}

export async function PATCH(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    return NextResponse.json({ settings: await updatePrivacySettings(s.scope.dataId, parsed.data) });
  } catch (err) {
    return privacyError(err, "update settings");
  }
}
