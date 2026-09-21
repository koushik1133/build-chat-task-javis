export const PASSWORD_MIN_LENGTH = 10;

/** Returns a user-facing reason when the password is unacceptable, else null. */
export function passwordPolicyError(password: string, email?: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 128) return "Password is too long.";
  const e = (email ?? "").trim().toLowerCase();
  const p = password.toLowerCase();
  if (e && (p === e || p === e.split("@")[0])) return "Password must not be your email address.";
  return null;
}
