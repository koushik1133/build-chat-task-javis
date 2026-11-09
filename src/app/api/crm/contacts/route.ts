import { NextRequest, NextResponse } from "next/server";
import { planGate } from "@/lib/plans/http";
import { query, queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { emitEvent } from "@/lib/events/bus";
import { keysetClause, keysetOrder, normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

/**
 * Normalise a tags value into a flat string[] so it is JSON-encoded exactly
 * once when stored (clients sometimes send an already-stringified array).
 */
function normaliseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
      } catch {
        // fall through to comma split
      }
    }
    return trimmed.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * GET /api/crm/contacts?q=&domain=&lifecycle=&cursor=&limit=
 *
 * Keyset-paginated (created_at DESC, id DESC; see src/lib/public-api/pagination.ts).
 * Without `cursor`/`limit` the first page (50 rows) is returned together with
 * `next_cursor`, so existing callers keep working and can opt into paging.
 */
export async function GET(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "crm", edit: false });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const { searchParams } = url;
    const domain = searchParams.get("domain");
    const lifecycle = searchParams.get("lifecycle");
    const list = parseListParams(url, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const search = list.q;

    let sql = `SELECT * FROM crm_contacts WHERE user_id = $1`;
    const params: unknown[] = [scope.dataId];

    if (domain) { sql += ` AND domain = $${params.length + 1}`; params.push(domain); }
    if (lifecycle) { sql += ` AND lifecycle = $${params.length + 1}`; params.push(lifecycle); }
    if (search) {
      const idx = params.length + 1;
      sql += ` AND (full_name ILIKE $${idx} OR email ILIKE $${idx + 1} OR company ILIKE $${idx + 2})`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += keysetClause(list.cursor, params);
    sql += ` ORDER BY ${keysetOrder()} LIMIT ${list.limit + 1}`;

    const rows = await query<{ id: string; created_at: string | Date }>(sql, params);
    const pg = page(rows, list.limit, (r) => normaliseCursor(r));
    return NextResponse.json({ contacts: pg.data, next_cursor: pg.next_cursor });
  } catch (err: unknown) {
    console.error("[crm/contacts] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/crm/contacts
export async function POST(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "crm", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const gate = await planGate(scope, { metric: "contacts" });
    if (gate) return gate;

    const body = await req.json();
    const {
      full_name, email = null, phone = null, company = null, role = null,
      tags = [], lifecycle = "lead", notes = null, deal_value = 0, domain = "general"
    } = body;

    if (!full_name?.trim()) return NextResponse.json({ error: "full_name required" }, { status: 400 });

    const rows = await query(
      `INSERT INTO crm_contacts (user_id, domain, full_name, email, phone, company, role, tags, lifecycle, notes, deal_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [scope.dataId, domain, full_name.trim(), email, phone, company, role, JSON.stringify(normaliseTags(tags)), lifecycle, notes, deal_value]
    );
    if (rows[0]) void emitEvent(scope.dataId, { type: "crm.contact.created", entity: "crm_contact", entityId: String((rows[0] as { id: string }).id), data: { lifecycle } });
    return NextResponse.json({ contact: rows[0] }, { status: 201 });
  } catch (err: unknown) {
    console.error("[crm/contacts] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/crm/contacts — update a contact
export async function PATCH(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "crm", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const allowed = ["full_name", "email", "phone", "company", "role", "tags", "lifecycle", "notes", "deal_value", "last_contact", "tax_number", "billing_address", "invoice_reminders_opt_out"];
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k)) {
        fields.push(`${k} = $${values.length + 1}`);
        values.push(k === "tags" ? JSON.stringify(normaliseTags(v)) : k === "billing_address" && v && typeof v === "object" ? JSON.stringify(v) : v);
      }
    }

    if (!fields.length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const prevLifecycle = typeof updates.lifecycle === "string"
      ? (await queryOne<{ lifecycle: string }>(`SELECT lifecycle FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, scope.dataId]).catch(() => null))?.lifecycle ?? null
      : null;

    fields.push(`updated_at = now()`);
    values.push(id, scope.dataId);

    const sql = `UPDATE crm_contacts SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING *`;
    const rows = await query(sql, values);
    if (rows[0] && prevLifecycle !== null && prevLifecycle !== updates.lifecycle) void emitEvent(scope.dataId, { type: "crm.contact.stage_changed", entity: "crm_contact", entityId: String(id), data: { from: prevLifecycle, to: updates.lifecycle } });
    return NextResponse.json({ contact: rows[0] });
  } catch (err: unknown) {
    console.error("[crm/contacts] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/crm/contacts?id=xxx
export async function DELETE(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "crm", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await query(`DELETE FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, scope.dataId]);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error("[crm/contacts] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
