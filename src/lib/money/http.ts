import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { CurrencySchema, LineItemsSchema } from "./items";

/** Shared helpers for the billing routes. */

export const QuoteBodySchema = z.object({
  contact_id: z.string().max(100).nullable().optional(),
  currency: CurrencySchema.optional(),
  items: LineItemsSchema.optional(),
  valid_until: z.string().datetime({ offset: true }).nullable().optional(),
  terms_text: z.string().max(20_000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export const InvoiceBodySchema = z.object({
  contact_id: z.string().max(100).nullable().optional(),
  quote_id: z.string().max(100).nullable().optional(),
  currency: CurrencySchema.optional(),
  items: LineItemsSchema.optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  terms_days: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export const SendBodySchema = z.object({
  to: z.string().email().max(200).optional(),
  message: z.string().max(2000).optional(),
});

/** Parse a JSON body with a byte cap and a zod schema. Returns a NextResponse on failure. */
export async function parseBody<T extends z.ZodTypeAny>(
  req: NextRequest,
  schema: T,
  maxBytes = 64_000
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  const text = await readCappedText(req, maxBytes);
  if (text === null) return { ok: false, res: NextResponse.json({ error: "payload_too_large" }, { status: 413 }) };
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, res: NextResponse.json({ error: "invalid_json" }, { status: 400 }) };
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, res: NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

/** Map errors: scope errors → 401/403; known domain errors → 400; else 500. */
export function errorResponse(err: unknown, log: string): NextResponse {
  const scoped = scopeErrorResponse(err);
  if (scoped) return scoped;
  const msg = err instanceof Error ? err.message : "error";
  if (/not found/i.test(msg)) return NextResponse.json({ error: "not_found", detail: msg }, { status: 404 });
  if (err instanceof Error && !/DSQL|relation|syntax|connect/i.test(msg) && err.name !== "DbError") {
    return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
  }
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null) ?? null;
}

/** 60 requests / minute / ip for anonymous token routes. Returns a 429 response or null. */
export async function publicRateLimit(req: NextRequest, bucket: string, limit = 60): Promise<NextResponse | null> {
  const ip = clientIp(req) ?? "unknown";
  const r = await rateLimitAsync(`p:${bucket}:${ip}`, limit, 60_000);
  if (!r.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return null;
}

export async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  return (await ctx.params).id;
}
export async function paramToken(ctx: { params: Promise<{ token: string }> }): Promise<string> {
  return (await ctx.params).token;
}
