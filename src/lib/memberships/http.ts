import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/money/http";
import { MembershipError } from "./plans";

/** Domain errors → their HTTP status; everything else falls through to the shared billing mapper. */
export function memberErrorResponse(err: unknown, log: string): NextResponse {
  if (err instanceof MembershipError) return NextResponse.json({ error: err.code, detail: err.message }, { status: err.status });
  return errorResponse(err, log);
}
