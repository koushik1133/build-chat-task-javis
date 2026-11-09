/** Display name for the identity provider button ("Sign in with <name>"). Client-safe. */
export function ssoProviderName(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SSO_PROVIDER_NAME?.trim() ?? "";
  return raw ? raw.slice(0, 60) : "SSO";
}
