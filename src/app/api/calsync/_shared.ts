import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";

/** Calendar sync is a settings-level feature: reads need settings access, writes need edit. */
export async function syncScope(edit: boolean): Promise<Scope | NextResponse> {
  try {
    return await requireScope({ area: "settings", edit });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}
