"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Mail, Lock, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Mode = "magic" | "password";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [mode, setMode] = useState<Mode>("magic");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("error");
    if (e && e !== "missing_code") setError(decodeURIComponent(e));

    const supabase = createClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      if (session) router.push("/chat");
    });
    return () => subscription.unsubscribe();
  }, [router]);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // If no account yet, try to sign up instead
      if (error.message.toLowerCase().includes("invalid login") ||
          error.message.toLowerCase().includes("user not found")) {
        const { error: upErr } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        setBusy(false);
        if (upErr) setError(upErr.message);
        else setSent(true); // confirm email sent (Supabase sends confirmation)
      } else {
        setBusy(false);
        setError(error.message);
      }
    }
    // success → auth state listener pushes to /chat
  }

  async function google() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-orange-500/25">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Javis</h1>
          <p className="text-sm text-muted-foreground">Your everyday AI assistant</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-7 shadow-sm">
          <h2 className="text-lg font-semibold">Sign in</h2>

          {/* Mode toggle */}
          <div className="mt-4 flex rounded-lg border border-border bg-secondary/40 p-0.5">
            <button
              onClick={() => { setMode("magic"); setError(null); setSent(false); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all",
                mode === "magic"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Mail className="h-3.5 w-3.5" /> Magic link
            </button>
            <button
              onClick={() => { setMode("password"); setError(null); setSent(false); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all",
                mode === "password"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Lock className="h-3.5 w-3.5" /> Password
            </button>
          </div>

          {sent ? (
            <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700">
              {mode === "magic"
                ? <>Check <span className="font-semibold">{email}</span> for a sign-in link.</>
                : <>Check <span className="font-semibold">{email}</span> to confirm your account.</>}
            </div>
          ) : mode === "magic" ? (
            <form onSubmit={sendMagicLink} className="mt-5 space-y-3">
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
              <p className="text-center text-[11px] text-muted-foreground">
                Hit rate limit? Switch to{" "}
                <button
                  type="button"
                  onClick={() => setMode("password")}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  password login
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={signInWithPassword} className="mt-5 space-y-3">
              <Input
                type="email"
                required
                placeholder="you@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  required
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button type="submit" className="w-full" disabled={busy || !email || !password}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in / Sign up"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                New here? Enter any email + password to create an account.
              </p>
            </form>
          )}

          <div className="my-5 flex items-center gap-3 text-[11px] text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
          </div>

          <Button onClick={google} variant="outline" className="w-full" disabled={busy}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </Button>
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
