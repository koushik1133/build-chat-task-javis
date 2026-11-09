import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cached: { body: string; at: number } | null = null;
const TTL = process.env.NODE_ENV === "production" ? 5 * 60_000 : 0;

async function script(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL) return cached.body;
  const body = await readFile(join(process.cwd(), "public", "kh-widget.js"), "utf8");
  cached = { body, at: Date.now() };
  return body;
}

const HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}

/** GET /api/widget.js — the embeddable widget script (same file as /kh-widget.js, with CORS + cache headers). */
export async function GET() {
  try {
    return new Response(await script(), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error("[widget] script read failed:", err);
    return new Response("/* widget unavailable */", { status: 500, headers: HEADERS });
  }
}
