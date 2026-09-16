'use client';

import * as React from 'react';
import { cn } from './primitives';

/**
 * Form controls (§39, §40).
 *
 * WHY THESE LIVE APART FROM primitives.tsx, AND WHY THEY USE CONTEXT.
 *
 * `Field` used to wire its control by cloning its child and injecting `id`,
 * `aria-describedby`, `aria-invalid` and `aria-required` onto it. That works
 * only when the child IS the control. The moment a field needs a wrapper — the
 * password field, which positions a reveal button over the input — the id lands
 * on the wrapper `<div>`, the `<label for>` points at a non-labelable element,
 * and the whole association silently disappears. The field still looks correct;
 * it just stops being announced.
 *
 * That bug was live in the sign-in form and was caught by an end-to-end test,
 * not by review — which is the point: it is invisible unless you are using a
 * screen reader or a tool that resolves labels.
 *
 * Context fixes it structurally. `Field` publishes the wiring; whichever
 * control renders inside consumes it, at any depth, through any wrapper. There
 * is no arrangement of markup that can quietly break the association.
 *
 * React context requires a Client Component, and every one of these controls is
 * interactive anyway, so they live in their own `'use client'` module. Card,
 * Badge and the rest stay in primitives.tsx so Server Components can use them
 * without pulling the whole design system across the boundary.
 */

interface FieldWiring {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = React.createContext<FieldWiring | null>(null);

/**
 * Attributes a control should adopt from its surrounding Field.
 *
 * Returns nothing outside a Field, so these controls remain usable standalone
 * (a search box with its own `aria-label`, for instance).
 */
function useFieldWiring(): Record<string, unknown> {
  const wiring = React.useContext(FieldContext);
  if (!wiring) return {};

  return {
    id: wiring.id,
    'aria-describedby': wiring.describedBy,
    'aria-invalid': wiring.invalid || undefined,
    'aria-required': wiring.required || undefined,
  };
}

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  /** Localized message. Its presence switches the field into its error state. */
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
  className,
}: FieldProps): React.JSX.Element {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  const wiring = React.useMemo<FieldWiring>(
    () => ({
      id,
      describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
      invalid: Boolean(error),
      required,
    }),
    [id, hintId, errorId, error, required],
  );

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* The required marker sits outside the <label>, so the label's text is
          exactly the field name. Screen readers learn the requirement from
          `aria-required` on the control instead. */}
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </label>
        {required ? (
          <span className="text-[var(--status-danger-fg)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </div>

      <FieldContext.Provider value={wiring}>{children}</FieldContext.Provider>

      {hint && !error ? (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}

      {error ? (
        // A live region, so a validation failure is announced rather than only
        // rendered (§40).
        <p
          id={errorId}
          role="alert"
          className="text-xs font-medium text-[var(--status-danger-fg)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE =
  'w-full rounded-[var(--radius-control)] border bg-[var(--surface-card)] px-3 text-sm ' +
  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] ' +
  'transition-colors duration-150 ' +
  'disabled:cursor-not-allowed disabled:bg-[var(--surface-sunken)] disabled:opacity-70 ' +
  // Logical alignment, so the caret and placeholder follow the reading
  // direction rather than being pinned to one physical edge.
  'text-start ' +
  'border-[var(--border-strong)] aria-[invalid=true]:border-[var(--status-danger-fg)]';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  const wiring = useFieldWiring();
  // `rest` last: an explicit prop at the call site always wins over the Field.
  return <input ref={ref} className={cn(CONTROL_BASE, 'h-10', className)} {...wiring} {...rest} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...rest }, ref) {
  const wiring = useFieldWiring();
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(CONTROL_BASE, 'py-2 leading-relaxed resize-y', className)}
      {...wiring}
      {...rest}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  const wiring = useFieldWiring();
  return (
    <select
      ref={ref}
      // `pe-8` reserves room for the native arrow on whichever side the
      // direction puts it.
      className={cn(CONTROL_BASE, 'h-10 pe-8', className)}
      {...wiring}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Checkbox({
  id,
  label,
  description,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}): React.JSX.Element {
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={descriptionId}
        className="mt-0.5 size-4 shrink-0 rounded border-[var(--border-strong)] accent-[var(--color-brand-600)]"
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-[var(--text-primary)]">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-0.5 text-xs text-[var(--text-muted)]">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
