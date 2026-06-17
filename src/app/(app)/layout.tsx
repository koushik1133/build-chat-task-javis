import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { NotificationBell } from "@/components/notification-bell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Read session from cookie — no network call, no redirect loop.
  // Token freshness is guaranteed by the middleware running before this layout.
  const session = await getServerSession();
  if (!session) redirect("/login");

  const email = session.user.email ?? "(no email)";

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar userEmail={email} />
      <section className="relative flex-1 overflow-hidden bg-background">
        <NotificationBell />
        {children}
      </section>
      <CommandPalette />
    </div>
  );
}
