import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/onboarding");

  const profile = await queryOne(
    "SELECT completed FROM business_profile WHERE user_id = $1",
    [session.user.id]
  ).catch(() => null);

  if (profile?.completed) {
    redirect("/chat");
  }

  return children;
}
