"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, Loader2, Mail, Eye, EyeOff, UserPlus, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Tab = "magic" | "signin" | "signup";

const PASSWORD_MIN_LENGTH = 8;

function passwordRules(password: string) {
  return [
    {
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      ok: password.length >= PASSWORD_MIN_LENGTH,
    },
    { label: "One uppercase letter", ok: /[A-Z]/.test(password) },
    { label: "One lowercase letter", ok: /[a-z]/.test(password) },
    { label: "One number", ok: /\d/.test(password) },
  ];
}

function safeNext(raw: string | null): string {
  if (!raw) return "/chat";
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("/") && !decoded.startsWith("//") && !decoded.startsWith("/login")) {
      return decoded;
    }
  } catch {
    // Ignore malformed values and use the default app landing page.
  }
  return "/chat";
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));

  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const rules = passwordRules(password);
  const passwordValid = rules.every((rule) => rule.ok);

  async function serverHasSession(retries = 0): Promise<boolean> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const authenticated = await fetch("/api/auth/session", { cache: "no-store" })
        .then((res) => res.ok ? res.json() : { authenticated: false })
        .then((data) => !!data.authenticated)
        .catch(() => false);

      if (authenticated) return true;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return false;
  }

  useEffect(() => {
    let active = true;
    const urlError = searchParams.get("error");
    if (urlError && urlError !== "missing_code") setError(decodeURIComponent(urlError));

    const supabase = createClient();

    // Only auto-enter the app if the server can see the session cookie.
    // This avoids stale browser auth state bouncing /login <-> /chat.
    serverHasSession().then(async (authenticated) => {
      if (!active) return;
      if (authenticated) {
        router.replace(next);
      } else {
        await supabase.auth.signOut().catch(() => {});
        setChecking(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) {
        const authenticated = await serverHasSession(5);
        if (!active) return;
        if (authenticated) {
          router.replace(next);
        } else {
          setBusy(false);
          setChecking(false);
          setError("Session could not be confirmed. Please try signing in again.");
        }
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setError(null);
    setSent(false);
    setPassword("");
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setBusy(false);
      setError(
        error.message.toLowerCase().includes("invalid login credentials")
          ? "Wrong email or password. New here? Switch to Create account."
          : error.message
      );
    }
    // success → onAuthStateChange SIGNED_IN fires → router.replace(next)
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordValid) {
      setError("Please meet all password requirements before creating an account.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      setBusy(false);
      setError(
        error.message.toLowerCase().includes("already registered")
          ? "Account already exists — switch to Sign in."
          : error.message
      );
      return;
    }
    // Email confirmation disabled → session returned immediately
    if (data.session) {
      const authenticated = await serverHasSession(5);
      if (authenticated) {
        router.replace(next);
        return;
      }
    }
    setBusy(false);
    setSent(true);
  }

  async function googleSignIn() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) { setBusy(false); setError(error.message); }
  }

  const tabs: { id: Tab; icon: React.ReactNode; label: string }[] = [
    { id: "signin",  icon: <LogIn className="h-3.5 w-3.5" />,    label: "Sign in" },
    { id: "signup",  icon: <UserPlus className="h-3.5 w-3.5" />, label: "Create account" },
    { id: "magic",   icon: <Mail className="h-3.5 w-3.5" />,     label: "Magic link" },
  ];

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
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
          <h2 className="text-lg font-semibold mb-4">Welcome</h2>

          {/* Tab row */}
          <div className="flex rounded-lg border border-border bg-secondary/40 p-0.5 mb-5">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); resetForm(); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all",
                  tab === t.id
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {sent ? (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-400 space-y-1">
              {tab === "magic" ? (
                <>
                  <p><strong>{email}</strong> — check your inbox for a sign-in link.</p>
                  <p className="text-xs opacity-80">Check spam if it doesn&apos;t arrive within a minute.</p>
                </>
              ) : (
                <>
                  <p><strong>{email}</strong> — check your inbox to confirm your account.</p>
                  <p className="text-xs opacity-80">
                    Confirmation emails are sent by Supabase. Check spam, or ask your admin to
                    configure SMTP under Supabase → Authentication → Email.
                  </p>
                </>
              )}
            </div>

          ) : tab === "signin" ? (
            <form onSubmit={signIn} className="space-y-3">
              <Input id="signin-email" name="email" type="email" required autoFocus
                autoComplete="email" placeholder="you@domain.com"
                value={email} onChange={e => setEmail(e.target.value)} />
              <div className="relative">
                <Input id="signin-password" name="password"
                  type={showPw ? "text" : "password"} required
                  autoComplete="current-password" placeholder="Password"
                  value={password} onChange={e => setPassword(e.target.value)} className="pr-10" />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button type="submit" className="w-full" disabled={busy || !email || !password}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                No account?{" "}
                <button type="button" onClick={() => { setTab("signup"); resetForm(); }}
                  className="underline underline-offset-2 hover:text-foreground">Create one</button>
              </p>
            </form>

          ) : tab === "signup" ? (
            <form onSubmit={signUp} className="space-y-3">
              <Input id="signup-email" name="email" type="email" required autoFocus
                autoComplete="email" placeholder="you@domain.com"
                value={email} onChange={e => setEmail(e.target.value)} />
              <div className="relative">
                <Input id="signup-password" name="password"
                  type={showPw ? "text" : "password"} required
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password" placeholder="Create a strong password"
                  value={password} onChange={e => setPassword(e.target.value)} className="pr-10" />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-3 text-[11px] text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Password requirements</p>
                <div className="grid gap-1">
                  {rules.map((rule) => (
                    <div key={rule.label} className={cn("flex items-center gap-1.5", rule.ok && "text-emerald-600")}>
                      <span aria-hidden>{rule.ok ? "✓" : "•"}</span>
                      {rule.label}
                    </div>
                  ))}
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={busy || !email || !passwordValid}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create account"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Have an account?{" "}
                <button type="button" onClick={() => { setTab("signin"); resetForm(); }}
                  className="underline underline-offset-2 hover:text-foreground">Sign in</button>
              </p>
            </form>

          ) : (
            <form onSubmit={sendMagicLink} className="space-y-3">
              <Input id="magic-email" name="email" type="email" required autoFocus
                autoComplete="email" placeholder="you@domain.com"
                value={email} onChange={e => setEmail(e.target.value)} />
              <Button type="submit" className="w-full" disabled={busy || !email}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send magic link"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                We email a one-click sign-in link — no password needed.
              </p>
            </form>
          )}

          <div className="my-5 flex items-center gap-3 text-[11px] text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
          </div>

          <Button onClick={googleSignIn} variant="outline" className="w-full" disabled={busy}>
            <svg className="mr-2 h-4 w-4 shrink-0" viewBox="0 0 24 24">
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

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    }>
      <LoginForm />
    </Suspense>
  );
}
