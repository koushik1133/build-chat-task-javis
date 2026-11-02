"use client";

import { cloneElement, isValidElement, useId, type ReactElement } from "react";
import { cn } from "@/lib/utils";

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * Label + control + hint/error. Pass a single form control as the child; the
 * field wires `htmlFor`, `aria-describedby` and `aria-invalid` for you.
 */
export function Field({
  label,
  hint,
  error,
  required,
  id: idProp,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const auto = useId();
  const child = isValidElement<ControlProps>(children) ? (children as ReactElement<ControlProps>) : null;
  const id = idProp ?? child?.props.id ?? auto;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const control = child
    ? cloneElement(child, { id, "aria-describedby": child.props["aria-describedby"] ?? describedBy, "aria-invalid": error ? true : child.props["aria-invalid"] })
    : children;
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label}
        {required && (
          <span className="text-destructive" aria-hidden>
            {" "}
            *
          </span>
        )}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
