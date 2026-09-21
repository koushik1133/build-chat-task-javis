import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { getBudget, setBudget } from "@/lib/llm/budgets";
import { usdToMicros } from "@/lib/llm/pricing";

export const dynamic = "force-dynamic";

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ budget: await getBudget(user.id) });
  } catch (err) {
    console.error("[ai/budget] get failed:", err);
    return NextResponse.json({ error: "Could not load AI budget." }, { status: 500 });
  }
}

const Patch = z.object({
  capUsd: z.number().min(0).max(10_000).nullable().optional(),
  hardStop: z.boolean().optional(),
  allowlist: z.array(z.string().min(1).max(64)).max(50).nullable().optional(),
});

export async function PATCH(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { capUsd, hardStop, allowlist } = parsed.data;

  try {
    await setBudget(user.id, {
      ...(capUsd !== undefined ? { capMicros: capUsd === null ? null : usdToMicros(capUsd) } : {}),
      ...(hardStop !== undefined ? { hardStop } : {}),
      ...(allowlist !== undefined ? { allowlist: allowlist === null ? null : allowlist } : {}),
    });
    return NextResponse.json({ budget: await getBudget(user.id) });
  } catch (err) {
    console.error("[ai/budget] patch failed:", err);
    return NextResponse.json({ error: "Could not save AI budget." }, { status: 500 });
  }
}
