import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

/**
 * Route-level `loading.tsx` body shared by the (app) segments. Mirrors the
 * PageContainer layout (eyebrow/title/description, optional stat tiles, then a
 * list or table) so the real page replaces it without layout shift.
 */
export function PageSkeleton({
  stats = 0,
  rows = 6,
  wide = false,
  label = "Loading…",
}: {
  /** Number of KPI tiles to sketch above the list. */
  stats?: number;
  /** Number of list rows. */
  rows?: number;
  wide?: boolean;
  label?: string;
}) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div role="status" aria-live="polite" aria-busy="true" className={cn("mx-auto w-full space-y-6", wide ? "max-w-7xl" : "max-w-5xl")}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
        {stats > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: stats }, (_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1 sm:max-w-xs" />
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}
