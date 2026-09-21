import type { Metadata } from "next";

export const metadata: Metadata = { title: "Document", robots: { index: false, follow: false } };

/** Public share pages: no app shell, no nav, no auth. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen bg-background text-foreground">{children}</main>;
}
