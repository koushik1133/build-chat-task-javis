import { requireUser } from "@/lib/supabase/server";
import { HomeDashboard } from "./home-dashboard";
import { YourDashboardLink } from "@/components/reports/your-dashboard-link";

export const dynamic = "force-dynamic";

/**
 * /home — the "today" view. The server shell authenticates; the client
 * widget fetches /api/home/summary (one round-trip) so the shell streams
 * immediately and the role-aware payload hides sections the viewer cannot see.
 */
export default async function HomePage() {
  const { user } = await requireUser();
  const name = (user.user_metadata?.full_name as string | undefined)?.split(" ")[0] ?? user.email?.split("@")[0] ?? null;
  return (
    <>
      <YourDashboardLink />
      <HomeDashboard firstName={name} />
    </>
  );
}
