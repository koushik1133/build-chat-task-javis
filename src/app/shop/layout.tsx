import type { Metadata } from "next";
import { headers } from "next/headers";
import { Lock } from "lucide-react";
import { brandingToCssVars, resolvePublicBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";

export const metadata: Metadata = { title: "Shop", robots: { index: true, follow: true } };

/** Public storefront pages: no app shell, no auth — branded per org (resolved from /shop/<slug>). */
export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname");
  const branding = await resolvePublicBranding(pathname);
  const vars = brandingToCssVars(branding) as React.CSSProperties;
  return (
    <div style={vars} className="flex min-h-dvh flex-col bg-background text-foreground">
      {branding.favicon_url && <link rel="icon" href={branding.favicon_url} />}
      <PublicBrandHeader branding={branding} subtitle="Shop" wide />
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 text-xs text-muted-foreground sm:px-6">
          <p className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Secure checkout
          </p>
          <p className="min-w-0 break-words">
            {branding.brand_name}
            {branding.support_email && (
              <>
                {" · "}
                <a href={`mailto:${branding.support_email}`} className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {branding.support_email}
                </a>
              </>
            )}
          </p>
        </div>
      </footer>
    </div>
  );
}
