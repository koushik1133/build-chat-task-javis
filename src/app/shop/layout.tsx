import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandingToCssVars, resolvePublicBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";

export const metadata: Metadata = { title: "Shop", robots: { index: true, follow: true } };

/** Public storefront pages: no app shell, no auth — branded per org (resolved from /shop/<slug>). */
export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname");
  const branding = await resolvePublicBranding(pathname);
  const vars = brandingToCssVars(branding) as React.CSSProperties;
  return (
    <div style={vars} className="min-h-screen bg-background text-foreground">
      {branding.favicon_url && <link rel="icon" href={branding.favicon_url} />}
      <PublicBrandHeader branding={branding} subtitle="Shop" />
      <main>{children}</main>
    </div>
  );
}
