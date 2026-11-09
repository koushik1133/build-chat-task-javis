import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";

/** Billing area: reads for everyone with billing access, writes need edit. */
export async function billingScope(edit: boolean): Promise<Scope | NextResponse> {
  try {
    return await requireScope({ area: "billing", edit });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

/** Connect / disconnect are settings-level actions. */
export async function settingsScope(): Promise<Scope | NextResponse> {
  try {
    return await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}
