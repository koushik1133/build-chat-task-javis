import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandingToCssVars, resolvePublicBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";

export const metadata: Metadata = { title: "Help center", robots: { index: true, follow: true } };

/**
 * Public help center: no app shell, no nav, no auth. Branded per org the same
 * way as src/app/p/layout.tsx (theme tokens come from the org's branding).
 */
export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname");
  const branding = await resolvePublicBranding(pathname);
  const vars = brandingToCssVars(branding) as React.CSSProperties;

  return (
    <div style={vars} className="min-h-dvh bg-background text-foreground">
      {branding.favicon_url && <link rel="icon" href={branding.favicon_url} />}
      <a href="#help-main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring">
        Skip to content
      </a>
      <PublicBrandHeader branding={branding} subtitle="Help center" />
      <main id="help-main">{children}</main>
    </div>
  );
}
