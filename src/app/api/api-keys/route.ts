import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-keys";

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(60, "Name must be 60 characters or fewer"),
  scopes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const deleteSchema = z.object({ id: z.string().min(1).max(100) });

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ keys: await listApiKeys(user.id) });
  } catch (err) {
    console.error("[api-keys] list failed:", err);
    return NextResponse.json({ error: "Could not load API keys." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  try {
    const { key, record } = await createApiKey(user.id, parsed.data.name, parsed.data.scopes ?? ["mcp"]);
    return NextResponse.json({ key, record }, { status: 201 });
  } catch (err) {
    console.error("[api-keys] create failed:", err);
    return NextResponse.json({ error: "Could not create the API key." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("id");
  const body = fromQuery ? { id: fromQuery } : await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Missing key id" }, { status: 400 });
  try {
    const ok = await revokeApiKey(user.id, parsed.data.id);
    if (!ok) return NextResponse.json({ error: "Key not found or already revoked" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api-keys] revoke failed:", err);
    return NextResponse.json({ error: "Could not revoke the API key." }, { status: 500 });
  }
}
