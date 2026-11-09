import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { gmailProvider } from "./providers/gmail";
import { outlookProvider } from "./providers/outlook";
import { imapProvider } from "./providers/imap";
import { simulatedProvider } from "./providers/simulated";
import { isMailProviderId, type MailAccountRow, type MailAccountView, type MailAuth, type MailProvider, type MailProviderId, type MailProviderInfo } from "./types";
import { deleteInBatches } from "@/lib/db/batch";

export type { MailAccountRow, MailAccountView, MailAuth, MailProvider, MailProviderId, MailProviderInfo, NormalizedMessage, OutboundMail } from "./types";
export { isMailProviderId, MAIL_PROVIDERS } from "./types";

const PROVIDERS: Record<MailProviderId, MailProvider> = {
  gmail: gmailProvider,
  outlook: outlookProvider,
  imap: imapProvider,
  simulated: simulatedProvider,
};

export function getMailProvider(id: string): MailProvider | null {
  return isMailProviderId(id) ? PROVIDERS[id] : null;
}

export function describeMailProviders(): MailProviderInfo[] {
  return (Object.keys(PROVIDERS) as MailProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    const encryptionOk = id === "simulated" || isEncryptionConfigured();
    const configured = p.configured() && encryptionOk;
    const reason = !p.configured() ? p.unavailableReason() : encryptionOk ? null : "Set CREDENTIAL_ENCRYPTION_KEY so mailbox tokens can be stored encrypted.";
    return { id, label: p.label, configured, reason };
  });
}

// ── Accounts ─────────────────────────────────────────────────────────────────

const ACCOUNT_COLS = `id, user_id, provider, email, display_name, auth, sync_cursor, status, last_sync_at, last_error, created_at`;

export async function listMailAccounts(dataId: string): Promise<MailAccountView[]> {
  const rows = await query<MailAccountRow & { message_count: string | number | null }>(
    `SELECT a.id, a.user_id, a.provider, a.email, a.display_name, NULL AS auth, a.sync_cursor, a.status, a.last_sync_at, a.last_error, a.created_at,
            (SELECT COUNT(*) FROM mail_messages m WHERE m.account_id = a.id) AS message_count
       FROM mail_accounts a
      WHERE a.user_id = $1
      ORDER BY a.created_at ASC`,
    [dataId]
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    email: r.email,
    display_name: r.display_name,
    status: r.status,
    last_sync_at: r.last_sync_at,
    last_error: r.last_error,
    created_at: r.created_at,
    message_count: Number(r.message_count ?? 0) || 0,
  }));
}

export async function getMailAccount(dataId: string, id: string): Promise<MailAccountRow | null> {
  return queryOne<MailAccountRow>(`SELECT ${ACCOUNT_COLS} FROM mail_accounts WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

/** Internal (cron) lookup without a tenant check — callers must trust the id source. */
export async function getMailAccountById(id: string): Promise<MailAccountRow | null> {
  return queryOne<MailAccountRow>(`SELECT ${ACCOUNT_COLS} FROM mail_accounts WHERE id = $1`, [id]);
}

export function serializeAuth(auth: MailAuth, provider: MailProviderId): string | null {
  const json = JSON.stringify(auth ?? {});
  if (provider === "simulated") return null;
  if (!isEncryptionConfigured()) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not set — cannot store mailbox credentials.");
  return encryptSecret(json);
}

export function readAuth(row: Pick<MailAccountRow, "auth" | "provider">): MailAuth {
  if (!row.auth) return {};
  const plain = decryptSecret(row.auth);
  if (!plain) throw new Error("Stored mailbox credentials could not be decrypted — reconnect the account.");
  try {
    return JSON.parse(plain) as MailAuth;
  } catch {
    return {};
  }
}

/** Insert or update the account for (user, provider, email). Returns the row id. */
export async function upsertMailAccount(
  dataId: string,
  input: { provider: MailProviderId; email: string; displayName: string | null; auth: MailAuth; cursor: string | null }
): Promise<string> {
  const authEnc = serializeAuth(input.auth, input.provider);
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM mail_accounts WHERE user_id = $1 AND provider = $2 AND email = $3`,
    [dataId, input.provider, input.email.toLowerCase()]
  );
  if (existing) {
    await query(
      `UPDATE mail_accounts SET auth = $1, display_name = COALESCE($2, display_name), sync_cursor = $3, status = 'connected', last_error = NULL WHERE id = $4`,
      [authEnc, input.displayName, input.cursor, existing.id]
    );
    return existing.id;
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO mail_accounts (user_id, provider, email, display_name, auth, sync_cursor, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected', NOW()) RETURNING id`,
    [dataId, input.provider, input.email.toLowerCase(), input.displayName, authEnc, input.cursor]
  );
  return row?.id ?? "";
}

export async function deleteMailAccount(dataId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM mail_accounts WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (!row) return false;
  await deleteInBatches("mail_messages", "account_id = $1 AND user_id = $2", [id, dataId]);
  await query(`DELETE FROM mail_accounts WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

/** Refresh the access token when it is about to expire; persists the new auth. */
export async function ensureFreshAuth(account: MailAccountRow): Promise<MailAuth> {
  const provider = getMailProvider(account.provider);
  if (!provider) throw new Error(`Unknown mail provider ${account.provider}`);
  const auth = readAuth(account);
  if (account.provider === "simulated") return auth;
  const expiresAt = auth.expires_at ?? 0;
  if (auth.access_token && expiresAt > Date.now() + 60_000) return auth;
  const next = await provider.refresh(auth);
  await query(`UPDATE mail_accounts SET auth = $1 WHERE id = $2`, [serializeAuth(next, account.provider), account.id]);
  return next;
}
