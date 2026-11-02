import type { Branding } from "@/lib/branding";

/* eslint-disable @next/next/no-img-element -- logo hosts are org-supplied; next/image needs an allow-list */

/**
 * Slim header for public, unauthenticated surfaces (/p/*, /book/*).
 * Server component: receives resolved branding, renders no client JS.
 */
export function PublicBrandHeader({ branding, subtitle }: { branding: Branding; subtitle?: string }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
        {branding.logo_url ? (
          <img
            src={branding.logo_url}
            alt={branding.brand_name}
            className="h-8 w-auto max-w-[160px] object-contain"
            height={32}
          />
        ) : (
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: "var(--brand-primary)", color: "var(--brand-primary-foreground)" }}
          >
            {branding.brand_name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">{branding.brand_name}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {branding.support_email && (
          <a
            href={`mailto:${branding.support_email}`}
            className="ml-auto hidden truncate text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
          >
            {branding.support_email}
          </a>
        )}
      </div>
    </header>
  );
}
