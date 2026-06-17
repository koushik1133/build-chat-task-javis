"use client";

import { usePathname } from "next/navigation";
import { NotificationBell } from "@/components/notification-bell";

/** Fixed top-right bell on every app page except Production (which has its own inline bell). */
export function GlobalNotificationBell() {
  const pathname = usePathname();
  if (pathname === "/production" || pathname.startsWith("/production/")) {
    return null;
  }
  return <NotificationBell variant="fixed" />;
}
