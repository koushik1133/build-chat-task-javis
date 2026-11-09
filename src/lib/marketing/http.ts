import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { CampaignError } from "./campaigns";
import { SequenceError } from "./sequences";

/** Marketing routes live in the `crm` area; writes need edit rights. */
export async function marketingScope(edit: boolean): Promise<{ ok: true; scope: Scope } | { ok: false; res: NextResponse }> {
  try {
    return { ok: true, scope: await requireScope({ area: "crm", edit }) };
  } catch (err) {
    return { ok: false, res: scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

/** Map lib errors to HTTP. Domain errors → 4xx with a code; everything else → 500. */
export function marketingError(err: unknown, log: string): NextResponse {
  if (err instanceof CampaignError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_state" ? 409 : 400;
    return NextResponse.json({ error: err.code, detail: err.message }, { status });
  }
  if (err instanceof SequenceError) {
    return NextResponse.json({ error: err.code, detail: err.message }, { status: err.code === "not_found" ? 404 : 400 });
  }
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error", detail: "Something went wrong. Has the Phase 8 marketing migration been applied?" }, { status: 500 });
}
