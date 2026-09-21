import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sites = await query(
    `SELECT id, title, persona, updated_at
     FROM sites
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [scope.dataId]
  ).catch((err) => {
    console.error("[sites] list failed:", err);
    return [];
  });

  return NextResponse.json({ sites });
}
