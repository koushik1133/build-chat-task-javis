import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    const pathname = (await headers()).get("x-pathname") ?? "/chat";
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const email = session.user.email ?? "(no email)";

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar userEmail={email} />
      <main className="min-w-0 flex-1 overflow-hidden bg-background">{children}</main>
      <CommandPalette />
    </div>
  );
}
