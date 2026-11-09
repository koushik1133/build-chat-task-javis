import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSession } from "@/lib/webchat/session";
import { requestHandoff } from "@/lib/webchat/service";
import { clientIp, enforceLimits, isUuid, jsonWith, parseBody, sessionTokenFrom, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ siteId: string }> };

const HandoffSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    message: z.string().trim().max(2000).optional(),
    consent: z.object({ marketing: z.boolean() }).strict().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone), { message: "email or phone is required" });

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** POST { name, email?, phone?, message?, consent? } — leave details → contact + lead, session handed off. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const session = await resolveSession(siteId, sessionTokenFrom(req));
    if (!session) return jsonWith(cors, { error: "unauthorized" }, 401);
    if (session.status === "closed") return jsonWith(cors, { error: "session_closed" }, 410);
    const limited = await enforceLimits(cors, [
      { key: `webchat:handoff:${session.id}`, limit: 5, windowMs: 60 * 60 * 1000 },
      { key: `webchat:handoff:ip:${clientIp(req)}`, limit: 20, windowMs: 60 * 60 * 1000 },
    ]);
    if (limited) return limited;
    const body = await parseBody(req, HandoffSchema, cors, 8_192);
    if ("res" in body) return body.res;

    const out = await requestHandoff(session, {
      name: body.data.name,
      email: body.data.email || null,
      phone: body.data.phone || null,
      message: body.data.message ?? null,
      consent: body.data.consent ?? null,
      evidence: { ip: clientIp(req), ua: req.headers.get("user-agent") },
    });
    return jsonWith(cors, { ok: true, status: "handed_off", messages: out.messages }, 201);
  } catch (err) {
    console.error("[webchat] handoff failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
