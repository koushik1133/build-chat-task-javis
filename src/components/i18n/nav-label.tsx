"use client";

import { useT } from "@/components/i18n/provider";
import { navGroupLabel, navLabel } from "@/lib/i18n/nav";

/**
 * Drop-in translated sidebar label: `<NavLabel href={href} fallback={label} />`.
 * Renders the static English label when the href has no catalog key.
 */
export function NavLabel({ href, fallback }: { href: string; fallback: string }) {
  const t = useT();
  return <>{navLabel(href, t, fallback)}</>;
}

/** Translated group heading: `<NavGroupLabel title={group.title} />`. */
export function NavGroupLabel({ title }: { title: string }) {
  const t = useT();
  return <>{navGroupLabel(title, t)}</>;
}
