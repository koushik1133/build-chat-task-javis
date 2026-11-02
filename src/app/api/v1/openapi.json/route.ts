import { buildOpenApiDocument } from "@/lib/public-api/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public (no auth): the OpenAPI 3.1 document generated from the route registry. */
export async function GET(req: Request) {
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  const doc = buildOpenApiDocument({ serverUrl: `${origin}/api/v1` });
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
