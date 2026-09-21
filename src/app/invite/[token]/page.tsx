import Link from "next/link";
import { getServerSession } from "@/lib/supabase/server";
import { JoinWorkspaceButton } from "./join-button";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getServerSession();
  const nextPath = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">You have been invited to a workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {session
            ? `Accept the invitation to join as ${session.user.email ?? "this account"}.`
            : "Sign in or create an account to accept the invitation."}
        </p>
        <div className="mt-6">
          {session ? (
            <JoinWorkspaceButton token={token} />
          ) : (
            <Link
              href={`/login?next=${encodeURIComponent(nextPath)}`}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign in to continue
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
