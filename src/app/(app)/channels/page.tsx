import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { resolveDataId } from "@/lib/auth/session-scope";
import { PageContainer } from "@/components/page-container";
import { buildChannelNav } from "@/lib/nav/channel-nav";
import { PAGE_CHANNELS, iconFor, channelHref } from "@/lib/channels/registry";
import { cn } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Index of every channel, showing which the user has connected. */
export default async function ChannelsIndexPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=%2Fchannels");

  const connected = new Set((await buildChannelNav(await resolveDataId(session.user.id))).map((c) => c.id));

  return (
    <PageContainer
      wide
      title="Channels"
      description="Connect a network and it gets its own page in the sidebar."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PAGE_CHANNELS.map((c) => {
          const Icon = iconFor(c.id);
          const isConnected = connected.has(c.id);
          return (
            <Link
              key={c.id}
              href={isConnected ? channelHref(c.id) : `${c.connectHref}&connect=${c.id}`}
              className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20"
            >
              <div className="flex items-center gap-3">
                <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", c.accent.bg)}>
                  <Icon className={cn("h-4 w-4", c.accent.text)} aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="font-medium">{c.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {isConnected ? "Connected" : "Not connected"}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs capitalize text-muted-foreground">
                {c.capabilities.contentTypes.join(" · ")}
              </p>
            </Link>
          );
        })}
      </div>
    </PageContainer>
  );
}
