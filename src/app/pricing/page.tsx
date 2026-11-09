import type { Metadata } from "next";
import Link from "next/link";
import { PlanGrid } from "@/components/plans/plan-grid";

export const metadata: Metadata = {
  title: "Pricing | KernelHub",
  description: "Simple plans for every team. Start with a 14-day Growth trial.",
};

/** Public pricing page (no auth). Add `/pricing` to the middleware public paths. */
export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8 max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">KernelHub</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Plans that grow with your team</h1>
        <p className="mt-2 text-muted-foreground">Every new workspace starts with a 14-day Growth trial. No card needed. After the trial you keep your data and move to Free unless you pick a plan.</p>
      </header>
      <PlanGrid currency="USD" publicMode />
      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account? <Link className="underline underline-offset-2" href="/login">Sign in</Link> to manage your plan.
      </p>
    </main>
  );
}
