import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { updateTestimonial } from "@/lib/engagement/reviews";

const Patch = z.object({ quote: z.string().trim().min(1).max(1000).optional(), published: z.boolean().optional(), featured: z.boolean().optional() }).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "testimonials");
  if (limited) return limited;
  const b = await body(req, Patch);
  if (!b.ok) return b.res;
  try {
    const id = (await ctx.params).id;
    const t = await updateTestimonial(scope.dataId, id, b.data);
    await recordAudit(scope, { action: "testimonial.update", entity: "testimonial", entityId: id, after: b.data });
    return NextResponse.json({ testimonial: t });
  } catch (err) {
    return fail(err, "engagement.testimonials.PATCH");
  }
}
