import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { deleteInBatches } from "@/lib/db/batch";

export const runtime = "nodejs";

/** Rows returned to the client — never includes token material. */
const SAFE_COLUMNS = `id, platform, account_id, account_name, login_customer_id,
  connected, last_synced_at, last_sync_error, created_at,
  (access_token_enc IS NOT NULL) AS has_token`;

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "ads", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const accounts = await query(
    `SELECT ${SAFE_COLUMNS} FROM ad_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [scope.dataId]
  ).catch(() => []);

  return NextResponse.json({ accounts, encryptionReady: isEncryptionConfigured() });
}

const CreateSchema = z.object({
  platform: z.enum(["meta_ads", "google_ads"]),
  account_id: z.string().trim().min(1).max(64),
  account_name: z.string().trim().max(120).optional(),
  access_token: z.string().trim().min(10).max(4096),
  developer_token: z.string().trim().max(512).optional(),
  login_customer_id: z.string().trim().max(64).optional(),
});

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "ads", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "Credential encryption is not configured. Set CREDENTIAL_ENCRYPTION_KEY." },
      { status: 503 }
    );
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const input = parsed.data;

  if (input.platform === "google_ads" && !input.developer_token) {
    return NextResponse.json(
      { error: "Google Ads requires a developer token." },
      { status: 400 }
    );
  }

  // One row per (user, platform, account) — reconnecting replaces credentials.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM ad_accounts WHERE user_id = $1 AND platform = $2 AND account_id = $3`,
    [scope.dataId, input.platform, input.account_id]
  );

  const accessEnc = encryptSecret(input.access_token);
  const devEnc = input.developer_token ? encryptSecret(input.developer_token) : null;

  if (existing) {
    await query(
      `UPDATE ad_accounts
       SET account_name = $3, access_token_enc = $4, developer_token_enc = $5,
           login_customer_id = $6, connected = TRUE, last_sync_error = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [existing.id, scope.dataId, input.account_name ?? null, accessEnc, devEnc, input.login_customer_id ?? null]
    );
  } else {
    await query(
      `INSERT INTO ad_accounts
         (id, user_id, platform, account_id, account_name, access_token_enc,
          developer_token_enc, login_customer_id, connected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`,
      [
        randomUUID(), scope.dataId, input.platform, input.account_id,
        input.account_name ?? null, accessEnc, devEnc, input.login_customer_id ?? null,
      ]
    );
  }

  const accounts = await query(
    `SELECT ${SAFE_COLUMNS} FROM ad_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [scope.dataId]
  );
  return NextResponse.json({ accounts });
}

export async function DELETE(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "ads", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Both statements are user-scoped, so one tenant can never delete another's rows.
  await deleteInBatches("ad_stats", "user_id = $1 AND ad_account_id = $2", [scope.dataId, id]);
  await query(`DELETE FROM ad_accounts WHERE user_id = $1 AND id = $2`, [scope.dataId, id]);

  return NextResponse.json({ success: true });
}
