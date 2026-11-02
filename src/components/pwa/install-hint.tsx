"use client";

import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** "Add to Home Screen" guidance; uses the native prompt where the browser offers one. */
export function InstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [platform, setPlatform] = useState<"ios" | "android" | "desktop">("desktop");

  useEffect(() => {
    const ua = navigator.userAgent;
    setPlatform(/iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : "desktop");
    setInstalled(window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setDeferred(null);
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden>
          <Smartphone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Install the app</h2>
          {installed ? (
            <p className="mt-1 text-sm text-muted-foreground">KernelHub is installed on this device. Launch it from your home screen or app list.</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">Installed, KernelHub opens full-screen, loads faster and can receive push notifications.</p>
              {deferred ? (
                <Button className="mt-3" touch onClick={() => void install()}>
                  <Download className="h-4 w-4" aria-hidden /> Install KernelHub
                </Button>
              ) : (
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {platform === "ios" && (
                    <>
                      <li>Open this page in Safari.</li>
                      <li>Tap the Share button, then <strong className="text-foreground">Add to Home Screen</strong>.</li>
                      <li>Open KernelHub from the home screen and enable notifications above.</li>
                    </>
                  )}
                  {platform === "android" && (
                    <>
                      <li>Open the browser menu (⋮).</li>
                      <li>Tap <strong className="text-foreground">Install app</strong> or <strong className="text-foreground">Add to Home screen</strong>.</li>
                    </>
                  )}
                  {platform === "desktop" && (
                    <>
                      <li>In Chrome or Edge, click the install icon at the right of the address bar.</li>
                      <li>Or open the browser menu and choose <strong className="text-foreground">Install KernelHub</strong>.</li>
                    </>
                  )}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default InstallHint;
