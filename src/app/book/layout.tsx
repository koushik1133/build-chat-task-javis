import type { Metadata } from "next";

/** Public booking pages: no app shell, just a centred column. */
export const metadata: Metadata = { title: "Book a time" };

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}
