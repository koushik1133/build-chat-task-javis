import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { KERNELHUB_NAME } from "@/lib/brand";
import { brandingToCssVars, resolvePublicBranding } from "@/lib/branding";

export const metadata: Metadata = {
  title: `Crew · ${KERNELHUB_NAME}`,
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Crew" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f97316",
};

/**
 * Token-scoped crew mode: no app shell, no auth, mobile-first. Picks up the
 * org's brand colours through the same CSS variables as the other public surfaces.
 */
export default async function CrewLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname");
  const branding = await resolvePublicBranding(pathname);
  const vars = brandingToCssVars(branding) as React.CSSProperties;

  return (
    <main style={vars} className="min-h-dvh bg-background text-foreground [padding-bottom:env(safe-area-inset-bottom)]">
      {branding.favicon_url && <link rel="icon" href={branding.favicon_url} />}
      {children}
    </main>
  );
}
