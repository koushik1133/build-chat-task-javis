import { cn } from "@/lib/utils";

type PageContainerProps = {
  children: React.ReactNode;
  className?: string;
  /** Wider content area for dashboards */
  wide?: boolean;
  title?: string;
  description?: string;
};

export function PageContainer({
  children,
  className,
  wide = false,
  title,
  description,
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8",
        className
      )}
    >
      <div className={cn("mx-auto w-full", wide ? "max-w-7xl" : "max-w-3xl")}>
        {(title || description) && (
          <header className="mb-6 sm:mb-8">
            {title && (
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
            )}
            {description && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
            )}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}
