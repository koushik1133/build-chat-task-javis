import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandingToCssVars, resolvePublicBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";

/** Public booking pages: no app shell, just a centred column — branded per org. */
export const metadata: Metadata = { title: "Book a time" };

export default async function BookLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname");
  const branding = await resolvePublicBranding(pathname);
  const vars = brandingToCssVars(branding) as React.CSSProperties;

  return (
    <div style={vars} className="min-h-screen bg-background text-foreground">
      {branding.favicon_url && <link rel="icon" href={branding.favicon_url} />}
      <PublicBrandHeader branding={branding} subtitle="Book a time" />
      {children}
    </div>
  );
}
