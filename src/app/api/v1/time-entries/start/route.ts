import { createTimeEntry, TimeEntryInputSchema } from "@/lib/finance/time";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a running timer: a time entry with no end. */
export const POST = op(ROUTES.startTimer, async ({ principal, body }) => {
  const input = TimeEntryInputSchema.parse({ ...body, started_at: new Date().toISOString() });
  return { data: await libCall(() => createTimeEntry(principal.dataId, input, `api_key:${principal.keyId}`)), status: 201 };
});
