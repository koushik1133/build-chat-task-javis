import { NextResponse } from "next/server";
import { dbUnavailableResponse } from "@/lib/api-db";
import { requireDemoActor } from "@/lib/demo/auth";
import { clearDemoData } from "@/lib/demo/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DELETE /api/demo/clear — remove only the rows the demo seeder created. */
export async function DELETE(req: Request) {
  const actor = await requireDemoActor(req);
  if (actor instanceof NextResponse) return actor;
  try {
    const result = await clearDemoData(actor.dataId, actor.userId);
    return NextResponse.json(result);
  } catch (err) {
    return dbUnavailableResponse(err, "demo/clear");
  }
}
