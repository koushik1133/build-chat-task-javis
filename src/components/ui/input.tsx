import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Form controls. Text is 16px on phones so iOS Safari does not zoom on focus,
 * and controls are 44px tall there for comfortable tapping.
 */

const controlCls =
  "flex h-11 w-full rounded-md border border-border bg-secondary/40 px-3 py-1 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:text-sm";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(controlCls, className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

/** Native select styled like Input. Explicit background and text colour keep it legible in Windows dark mode. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(controlCls, "bg-secondary/40 text-foreground [&>option]:bg-card [&>option]:text-foreground", className)} {...props}>
    {children}
  </select>
));
Select.displayName = "Select";

/** Checkbox with its label in one hit target. */
export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: React.ReactNode; labelClassName?: string }>(
  ({ className, label, labelClassName, ...props }, ref) => (
    <label className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0", props.disabled && "cursor-not-allowed opacity-60", labelClassName)}>
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          "h-4 w-4 shrink-0 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className
        )}
        {...props}
      />
      <span className="min-w-0">{label}</span>
    </label>
  )
);
Checkbox.displayName = "Checkbox";
