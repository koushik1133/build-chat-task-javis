"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RetryButton() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <div className="mt-5 space-y-2">
      <Button className="h-11 w-full" onClick={() => window.location.reload()}>
        <RefreshCw className="h-4 w-4" aria-hidden /> Try again
      </Button>
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {online ? "Connection detected — tap to reload." : "Still offline."}
      </p>
    </div>
  );
}
