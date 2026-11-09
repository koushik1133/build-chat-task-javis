import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { KERNELHUB_NAME, KERNELHUB_TAGLINE } from "@/lib/brand";
import "./globals.css";
import { RegisterServiceWorker } from "@/components/pwa/register-sw";
import { WebVitals } from "@/components/web-vitals";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: KERNELHUB_NAME,
  description: KERNELHUB_TAGLINE,
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.svg", type: "image/svg+xml" }],
  },
};

/** Applies the stored or system theme before first paint (Tailwind darkMode: "class"). */
const THEME_BOOTSTRAP =
  "try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased font-sans">
        {children}
        <RegisterServiceWorker />
        <WebVitals />
      </body>
    </html>
  );
}
