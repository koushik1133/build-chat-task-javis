import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { resolveDataId } from "@/lib/auth/session-scope";
import { AppShell } from "@/components/app-shell";
import { buildChannelNav } from "@/lib/nav/channel-nav";
import { CommandPalette } from "@/components/command-palette";
import { FeatureRequestButton } from "@/components/feature-request-button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    const pathname = (await headers()).get("x-pathname") ?? "/chat";
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const email = session.user.email ?? "(no email)";

  // Server-rendered so the CHANNELS group is present in the first paint.
  const channels = await buildChannelNav(await resolveDataId(session.user.id));

  return (
    <>
      <AppShell userEmail={email} channels={channels}>
        {children}
      </AppShell>
      <CommandPalette />
      <FeatureRequestButton />
    </>
  );
}
