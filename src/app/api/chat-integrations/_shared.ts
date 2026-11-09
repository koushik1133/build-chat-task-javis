import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { CHAT_PROVIDERS } from "@/lib/chatops/types";

export async function chatScope(edit: boolean): Promise<Scope | NextResponse> {
  try {
    return await requireScope({ area: "settings", edit });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}

const Events = z.array(z.string().min(1).max(100)).max(100);

export const CreateBody = z
  .object({
    provider: z.enum(CHAT_PROVIDERS),
    name: z.string().trim().min(1).max(80),
    webhook_url: z.string().trim().min(10).max(2048),
    channel_label: z.string().trim().max(80).nullable().optional(),
    events: Events.default([]),
    enabled: z.boolean().optional(),
  })
  .strict();

export const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    webhook_url: z.string().trim().min(10).max(2048).optional(),
    channel_label: z.string().trim().max(80).nullable().optional(),
    events: Events.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
