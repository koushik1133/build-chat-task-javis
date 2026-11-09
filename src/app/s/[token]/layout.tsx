import type { Metadata } from "next";
import { brandingToCssVars, DEFAULT_BRANDING, getBranding } from "@/lib/branding";
import { PublicBrandHeader } from "@/components/branding/public-brand-header";
import { surveyOrgId } from "@/lib/engagement/surveys";

export const metadata: Metadata = { title: "Share your feedback", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Public survey pages: no app shell, branded per org (resolved from the signed link). */
export default async function SurveyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  const dataId = await surveyOrgId(token).catch(() => null);
  const branding = dataId ? await getBranding(dataId).catch(() => DEFAULT_BRANDING) : DEFAULT_BRANDING;
  const vars = brandingToCssVars(branding) as React.CSSProperties;
  return (
    <div style={vars} className="flex min-h-dvh flex-col bg-background text-foreground">
      <PublicBrandHeader branding={branding} subtitle="Feedback" />
      <main id="main" className="mx-auto w-full max-w-xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
