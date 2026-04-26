"use client";

import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : process.env.NEXT_PUBLIC_APP_URL!;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function google() {
    setBusy(true);
    const supabase = createClient();
    const origin = window.location.origin;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback` },
    });
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="card-glow w-full max-w-sm rounded-2xl p-8">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold">Javis</span>
        </div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Magic link or Google. We never store your password.
        </p>

        {sent ? (
          <p className="mt-6 rounded-md border border-border bg-card/40 p-3 text-sm">
            Check <span className="font-medium">{email}</span> for a sign-in link.
          </p>
        ) : (
          <>
            <form onSubmit={sendMagicLink} className="mt-6 space-y-3">
              <Input
                type="email"
                required
                placeholder="you@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" className="w-full" disabled={busy || !email}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send magic link"}
              </Button>
            </form>

            <div className="my-4 flex items-center gap-3 text-[11px] text-muted-foreground">
              <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
            </div>

            <Button onClick={google} variant="outline" className="w-full" disabled={busy}>
              Continue with Google
            </Button>
          </>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
    </main>
  );
}
