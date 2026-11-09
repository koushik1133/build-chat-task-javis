import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { DbError } from "@/lib/dsql";
import { ReportSpecError, DatasetUnavailableError } from "./query";

/** Shared helpers for /api/reports/* and /api/dashboards/* route handlers. */

export async function parseJson<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: NextResponse.json({ error: "invalid_body", detail: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

export function reportsError(err: unknown, log: string): NextResponse {
  if (err instanceof ReportSpecError || err instanceof ZodError) return NextResponse.json({ error: "invalid_spec", detail: err.message }, { status: 400 });
  if (err instanceof DatasetUnavailableError) return NextResponse.json({ error: "dataset_unavailable", detail: err.message }, { status: 404 });
  console.error(`[${log}]`, err);
  if (err instanceof DbError) return NextResponse.json({ error: "database_error" }, { status: 503 });
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  return (await ctx.params).id;
}
