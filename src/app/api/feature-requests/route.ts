import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * The roadmap is shared across the workspace, so rows are deliberately not
 * filtered by owner — but `user_id` is never returned, since who asked for what
 * is not something other users need to see.
 */
export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  try {
    const rows = await query(
      `SELECT r.id, r.domain, r.title, r.description, r.category, r.status,
              r.upvotes, r.created_at,
              (r.user_id = $1) AS is_mine,
              EXISTS (
                SELECT 1 FROM domain_feature_request_votes v
                WHERE v.request_id = r.id AND v.user_id = $1
              ) AS has_voted
       FROM domain_feature_requests r
       ORDER BY r.upvotes DESC, r.created_at DESC
       LIMIT 100`,
      [user.id]
    );
    return NextResponse.json({ requests: rows });
  } catch (err) {
    console.error("[feature-requests] list failed:", err);
    return NextResponse.json({ error: "Could not load feature requests." }, { status: 500 });
  }
}

const CreateSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(3).max(4000),
  category: z.enum(["feature", "integration", "improvement", "bug"]).default("feature"),
  domain: z.string().trim().max(40).default("general"),
});

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Title and description are required.", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { title, description, category, domain } = parsed.data;

  try {
    const request = await queryOne(
      `INSERT INTO domain_feature_requests
         (id, user_id, domain, title, description, category, status, upvotes)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', 0)
       RETURNING id, domain, title, description, category, status, upvotes, created_at`,
      [randomUUID(), user.id, domain, title, description, category]
    );
    return NextResponse.json({ request }, { status: 201 });
  } catch (err) {
    console.error("[feature-requests] create failed:", err);
    return NextResponse.json({ error: "Could not submit that request." }, { status: 500 });
  }
}

/**
 * PATCH — upvote. A vote row is claimed first, so a user can only ever add one
 * vote per request no matter how many times the button is pressed.
 */
export async function PATCH(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    const exists = await queryOne<{ id: string }>(
      `SELECT id FROM domain_feature_requests WHERE id = $1`,
      [id]
    );
    if (!exists) return NextResponse.json({ error: "Request not found" }, { status: 404 });

    const already = await queryOne<{ id: string }>(
      `SELECT id FROM domain_feature_request_votes WHERE request_id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (!already) {
      await query(
        `INSERT INTO domain_feature_request_votes (id, request_id, user_id) VALUES ($1, $2, $3)`,
        [randomUUID(), id, user.id]
      );
      await query(
        `UPDATE domain_feature_requests SET upvotes = upvotes + 1 WHERE id = $1`,
        [id]
      );
    }

    const request = await queryOne(
      `SELECT id, domain, title, description, category, status, upvotes, created_at
       FROM domain_feature_requests WHERE id = $1`,
      [id]
    );
    return NextResponse.json({ request, hasVoted: true, counted: !already });
  } catch (err) {
    console.error("[feature-requests] upvote failed:", err);
    return NextResponse.json({ error: "Could not record that vote." }, { status: 500 });
  }
}
