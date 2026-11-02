import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { KERNELHUB_NAME } from "@/lib/brand";
import { RetryButton } from "./retry-button";

export const metadata: Metadata = { title: `Offline · ${KERNELHUB_NAME}`, robots: { index: false, follow: false } };

/** Served by the service worker when a navigation fails without a network. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <WifiOff className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">You&apos;re offline</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {KERNELHUB_NAME} needs a connection to load this page. Anything you already opened stays available; new changes will
          sync once you&apos;re back online.
        </p>
        <RetryButton />
      </div>
    </main>
  );
}
