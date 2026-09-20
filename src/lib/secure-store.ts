import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

/**
 * Symmetric encryption for third-party credentials held at rest.
 *
 * Ad platform access tokens are bearer credentials that can spend a customer's
 * money, so they are never written to the database in the clear. Format is
 * `v1:<iv>:<authTag>:<ciphertext>`, all base64url.
 */

const PREFIX = "v1";

function key(): Buffer {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
    );
  }
  // Accept any sufficiently long passphrase; derive a stable 32-byte key.
  if (secret.length < 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

/** True when encryption is available, so callers can fail with a clear message. */
export function isEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

/**
 * Returns null for anything that cannot be authenticated — a tampered value, a
 * row written under a different key, or a legacy plaintext value.
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Render a credential for display without revealing it. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/**
 * Strip credentials out of text before it is stored or shown.
 *
 * Ad platforms echo the offending access token back in their error bodies, so
 * an unredacted upstream message would put the very secret we encrypt at rest
 * straight into a database column and onto the screen.
 */
export function redactSecrets(
  text: string,
  secrets: (string | null | undefined)[] = []
): string {
  let out = text;

  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }

  // Catch-all for token-shaped strings the caller didn't know about.
  out = out
    .replace(/\b(EAA|ya29\.|1\/\/|sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9._\-]{6,}/g, "[redacted]")
    .replace(/("?(?:access_token|refresh_token|developer[-_]?token|api[-_]?key|authorization)"?\s*[:=]\s*"?)[^"&,\s}]{6,}/gi,
      "$1[redacted]");

  return out;
}
