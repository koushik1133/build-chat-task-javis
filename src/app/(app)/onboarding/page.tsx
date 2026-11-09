import { requireUser } from "@/lib/supabase/server";
import nextDynamic from "next/dynamic";
import { Loading } from "@/components/ui/feedback";

// 500+ line wizard used once per workspace: code-split so /onboarding does not inflate the shared (app) chunk.
const OnboardingWizard = nextDynamic(() => import("./onboarding-wizard").then((m) => m.OnboardingWizard), { loading: () => <Loading label="Loading setup…" /> });

export const dynamic = "force-dynamic";

/** /onboarding — guided setup wizard. Re-runnable; every step is idempotent server-side. */
export default async function OnboardingPage() {
  await requireUser();
  return <OnboardingWizard />;
}
