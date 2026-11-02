import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";

type PageContainerProps = {
  children: React.ReactNode;
  className?: string;
  /** Wider content area for dashboards */
  wide?: boolean;
  title?: string;
  description?: string;
  /** Plain-English tooltip for the page title */
  tooltip?: string;
  /** Small line above the title, e.g. a back link */
  eyebrow?: React.ReactNode;
  /** Icon shown beside the title */
  icon?: React.ReactNode;
  /** Primary actions, aligned to the end of the header on wide screens */
  actions?: React.ReactNode;
};

export function PageContainer({
  children,
  className,
  wide = false,
  title,
  description,
  tooltip,
  eyebrow,
  icon,
  actions,
}: PageContainerProps) {
  const hasHeader = Boolean(title || description || eyebrow || actions);
  return (
    <div
      className={cn(
        "h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8",
        className
      )}
    >
      <div className={cn("mx-auto w-full", wide ? "max-w-7xl" : "max-w-3xl")}>
        {hasHeader && (
          <header className="mb-6 sm:mb-8">
            {eyebrow && <div className="mb-2">{eyebrow}</div>}
            <div className={cn(actions && "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between")}>
              <div className={cn("min-w-0", icon && "flex items-start gap-3")}>
                {icon && (
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground" aria-hidden>
                    {icon}
                  </span>
                )}
                <div className="min-w-0">
                  {title && (
                    <h1 className="flex items-center gap-2 break-words text-xl font-semibold tracking-tight sm:text-2xl">
                      {title}
                      {tooltip && <InfoTooltip text={tooltip} />}
                    </h1>
                  )}
                  {description && (
                    <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
                  )}
                </div>
              </div>
              {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
            </div>
          </header>
        )}
        {children}
      </div>
    </div>
  );
}
