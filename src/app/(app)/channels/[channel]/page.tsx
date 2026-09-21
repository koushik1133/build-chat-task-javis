import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { resolveDataId } from "@/lib/auth/session-scope";
import { PageContainer } from "@/components/page-container";
import { PostCard } from "@/components/social/post-card";
import { loadChannelSnapshot } from "@/lib/channels/channel-data";
import { toChannelId, iconFor } from "@/lib/channels/registry";
import { cn } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel: raw } = await params;

  // Unknown segments 404 before any query runs.
  const channelId = toChannelId(raw);
  if (!channelId) notFound();

  // A legacy spelling canonicalises rather than rendering a duplicate page.
  if (channelId !== raw.toLowerCase()) redirect(`/channels/${channelId}`);

  const session = await getServerSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/channels/${channelId}`)}`);

  const snapshot = await loadChannelSnapshot(await resolveDataId(session.user.id), channelId);
  if (!snapshot) notFound();

  const { channel, accounts, posts, counts } = snapshot;
  const Icon = iconFor(channel.id);
  const connected = accounts.length > 0;
  const { capabilities: caps } = channel;

  return (
    <PageContainer
      wide
      title={channel.label}
      description={`Everything published to ${channel.label} from this workspace.`}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className={cn("flex h-10 w-10 items-center justify-center rounded-xl", channel.accent.bg)}>
          <Icon className={cn("h-5 w-5", channel.accent.text)} aria-hidden />
        </span>
        <ul className="flex flex-wrap gap-1.5" aria-label={`${channel.label} capabilities`}>
          {caps.contentTypes.map((t) => (
            <li key={t} className="rounded-full bg-secondary px-2.5 py-1 text-xs capitalize text-muted-foreground">
              {t}
            </li>
          ))}
          <li className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
            {caps.captionLimit.toLocaleString()} char caption
          </li>
        </ul>
      </div>

      {!caps.publishable && (
        <p
          role="status"
          className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Publishing to {channel.label} is not supported yet — posts can be drafted and scheduled here,
          but they must be published manually.
        </p>
      )}

      {!connected ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Icon className={cn("mx-auto mb-3 h-8 w-8", channel.accent.text)} aria-hidden />
          <h2 className="font-semibold">No {channel.label} account connected</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Add your {channel.label} handle to track posts and publish from this workspace.
          </p>
          <Link
            href={`${channel.connectHref}&connect=${channel.id}`}
            className="mt-4 inline-flex items-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Connect {channel.label}
          </Link>
        </div>
      ) : (
        <>
          <section className="mb-6 rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-5 py-4 font-semibold">
              {accounts.length === 1 ? "Account" : "Accounts"}
            </h2>
            <ul className="divide-y divide-border">
              {accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
                  <div className="min-w-0">
                    <p className="font-medium">{a.display_name || a.handle}</p>
                    <p className="truncate text-xs text-muted-foreground">@{a.handle}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                      Handle added
                    </span>
                    {!a.has_token && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                        No API token
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Total posts", value: counts.total },
              { label: "Drafts", value: counts.draft },
              { label: "Scheduled", value: counts.scheduled },
              { label: "Published", value: counts.published },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>

          {counts.failed > 0 && (
            <div className="mb-6 overflow-x-auto rounded-xl border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
              <table className="w-full min-w-[420px] text-sm">
                <caption className="px-5 py-3 text-left font-semibold text-red-800 dark:text-red-300">
                  {counts.failed} post(s) failed to publish
                </caption>
                <tbody>
                  {posts.filter((p) => p.status === "failed").map((p) => (
                    <tr key={p.id} className="border-t border-red-200 dark:border-red-900">
                      <td className="px-5 py-2 text-red-900 dark:text-red-300">{p.caption.slice(0, 60)}…</td>
                      <td className="px-5 py-2 text-red-700 dark:text-red-400">{p.publish_error ?? "Unknown error"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {posts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <h2 className="font-semibold">No {channel.label} posts yet</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Generate or write a post and it will show up here.
              </p>
              <Link
                href="/social?tab=posts"
                className="mt-4 inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm font-medium"
              >
                Open the composer
              </Link>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {posts.map((p) => (
                <PostCard key={p.id} post={p} />
              ))}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
