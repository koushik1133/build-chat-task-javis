import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { CommandPalette } from "@/components/command-palette";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    const pathname = (await headers()).get("x-pathname") ?? "/chat";
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const email = session.user.email ?? "(no email)";

  return (
    <>
      <AppShell userEmail={email}>{children}</AppShell>
      <CommandPalette />
    </>
  );
}
