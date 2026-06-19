"use client";

import { usePathname } from "next/navigation";
import { NotificationBell } from "@/components/notification-bell";

/** Fixed top-right bell on every app page except Production and Build/AI Studio (which have their own inline bells). */
export function GlobalNotificationBell() {
  const pathname = usePathname();
  if (
    pathname === "/production" || pathname.startsWith("/production/") ||
    pathname === "/build" || pathname.startsWith("/build/")
  ) {
    return null;
  }
  return <NotificationBell variant="fixed" />;
}
