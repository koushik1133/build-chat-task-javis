import { brandingToCssVars, DEFAULT_BRANDING, getBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";
import { queryOne } from "@/lib/dsql";

export const dynamic = "force-dynamic";

/** Public testimonials page chrome, branded per org slug. */
export default async function ReviewsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  const owner = /^[a-z0-9][a-z0-9-]{0,62}$/i.test(org) ? await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE lower(slug) = lower($1)`, [org]).catch(() => null) : null;
  const branding = owner ? await getBranding(owner.owner_user_id).catch(() => DEFAULT_BRANDING) : DEFAULT_BRANDING;
  const vars = brandingToCssVars(branding) as React.CSSProperties;
  return (
    <div style={vars} className="flex min-h-dvh flex-col bg-background text-foreground">
      <PublicBrandHeader branding={branding} subtitle="Reviews" />
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
