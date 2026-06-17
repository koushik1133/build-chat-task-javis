import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/onboarding");

  return children;
}
