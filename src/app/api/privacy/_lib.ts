import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { DsrError } from "@/lib/privacy/dsr";

/** Shared guard for /api/privacy/*: settings area, edit for writes. */
export async function privacyScope(edit: boolean): Promise<{ scope: Scope } | { res: NextResponse }> {
  try {
    return { scope: await requireScope({ area: "settings", edit }) };
  } catch (err) {
    return { res: scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

export function privacyError(err: unknown, label: string): NextResponse {
  if (err instanceof DsrError) return NextResponse.json({ error: err.message }, { status: err.status });
  const scoped = scopeErrorResponse(err);
  if (scoped) return scoped;
  console.error(`[privacy] ${label} failed:`, err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
