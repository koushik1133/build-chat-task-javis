import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listNotices, publishNotice } from "@/lib/privacy/notices";
import { privacyError, privacyScope } from "../_lib";

export const runtime = "nodejs";

const Schema = z.object({ locale: z.enum(["en", "es", "hi"]), body_md: z.string().trim().min(20).max(100_000) }).strict();

export async function GET() {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    return NextResponse.json({ notices: await listNotices(s.scope.dataId), slug: s.scope.orgSlug });
  } catch (err) {
    return privacyError(err, "list notices");
  }
}

/** POST — publish a new immutable version. */
export async function POST(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    return NextResponse.json({ notice: await publishNotice(s.scope.dataId, parsed.data, s.scope.userId) }, { status: 201 });
  } catch (err) {
    return privacyError(err, "publish notice");
  }
}
