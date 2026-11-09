import { requireUser } from "@/lib/supabase/server";
import { OnboardingWizard } from "./onboarding-wizard";

export const dynamic = "force-dynamic";

/** /onboarding — guided setup wizard. Re-runnable; every step is idempotent server-side. */
export default async function OnboardingPage() {
  await requireUser();
  return <OnboardingWizard />;
}
