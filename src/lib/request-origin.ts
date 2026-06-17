/** Public origin for redirects — Cloud Run binds to 0.0.0.0:8080 internally. */
export function getRequestOrigin(request: Request): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (appUrl) return appUrl;

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host && !host.startsWith("0.0.0.0")) {
      return `${forwardedProto}://${host}`;
    }
  }

  const { origin } = new URL(request.url);
  if (!origin.includes("0.0.0.0")) return origin;

  return appUrl ?? origin;
}
