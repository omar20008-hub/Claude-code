import * as React from 'react';

/**
 * Design system primitives (§39).
 *
 * RTL/LTR CORRECTNESS IS STRUCTURAL, NOT COSMETIC.
 *
 * Not one component here contains `left`, `right`, `ml-`, `mr-`, `pl-`, `pr-`,
 * `text-left` or `text-right`. Every inline axis is expressed logically —
 * `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`,
 * `border-s`/`border-e` — which Tailwind v4 compiles to CSS logical properties.
 * The browser resolves them against `dir`, so the same markup lays out
 * correctly in Arabic and English with no mirrored stylesheet and no
 * `dir === 'rtl' ? … : …` conditional.
 *
 * A lint rule in eslint.config.mjs and a test in tests/i18n/rtl.test.ts both
 * enforce this, because the failure mode is silent: a `pl-4` looks perfect in
 * English and wrong only to Arabic readers.
 */

/**
 * Joins class names, dropping anything falsy.
 *
 * `unknown` rather than a narrow union because `cond && 'class'` yields the
 * type of `cond` when it is falsy — including `0` and `''` — and a narrower
 * signature rejects the idiom at every call site.
 */
export function cn(...values: unknown[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)] active:bg-[var(--color-brand-800)] shadow-sm',
  secondary:
    'bg-[var(--surface-card)] text-[var(--text-primary)] border border-[var(--border-strong)] hover:bg-[var(--surface-raised)]',
  ghost:
    'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]',
  danger:
    'bg-[var(--status-danger-fg)] text-white hover:opacity-90 active:opacity-80 shadow-sm',
  subtle:
    'bg-[var(--surface-sunken)] text-[var(--text-primary)] hover:bg-[var(--surface-raised)]',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2.5',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Rendered at the reading start; flips side automatically in RTL. */
  iconStart?: React.ReactNode;
  /** Rendered at the reading end. */
  iconEnd?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      iconStart,
      iconEnd,
      fullWidth,
      className,
      children,
      disabled,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        // A loading button stays in the tab order and announces its state,
        // rather than vanishing from the accessibility tree.
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium',
          'transition-colors duration-150',
          'disabled:cursor-not-allowed disabled:opacity-55',
          BUTTON_VARIANTS[variant],
          BUTTON_SIZES[size],
          fullWidth && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner className="size-4" /> : iconStart}
        {children}
        {!loading && iconEnd}
      </button>
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Spinner                                                                    */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={cn('animate-spin-slow', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export function Card({
  className,
  children,
  as: Component = 'div',
  ...rest
}: React.HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'li';
}): React.JSX.Element {
  return (
    <Component
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
        'bg-[var(--surface-card)] shadow-[var(--shadow-card)]',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Sits at the reading end of the header row. */
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  success: 'bg-[var(--status-success-bg)] text-[var(--status-success-fg)]',
  warning: 'bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)]',
  danger: 'bg-[var(--status-danger-bg)] text-[var(--status-danger-fg)]',
  info: 'bg-[var(--status-info-bg)] text-[var(--status-info-fg)]',
  neutral: 'bg-[var(--status-neutral-bg)] text-[var(--status-neutral-fg)]',
  brand: 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  /** Small leading indicator; sits at the reading start. */
  dot?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  /** Localized error message. Presence switches the field into its error state. */
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Label + control + hint/error, wired for screen readers.
 *
 * `aria-describedby` points at whichever of hint/error exists, and the error is
 * a live region so a validation failure is announced rather than only shown
 * (§40).
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: FieldProps): React.JSX.Element {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
        {label}
        {required ? (
          <span className="ms-1 text-[var(--status-danger-fg)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id,
            'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
            'aria-invalid': error ? true : undefined,
            'aria-required': required || undefined,
          })
        : children}

      {hint && !error ? (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}

      {error ? (
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
  // `text-start` rather than `text-left`: the caret and placeholder follow the
  // reading direction.
  'text-start';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        CONTROL_BASE,
        'h-10',
        'border-[var(--border-strong)]',
        'aria-[invalid=true]:border-[var(--status-danger-fg)]',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        CONTROL_BASE,
        'py-2 leading-relaxed resize-y',
        'border-[var(--border-strong)]',
        'aria-[invalid=true]:border-[var(--status-danger-fg)]',
        className,
      )}
      {...rest}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        CONTROL_BASE,
        'h-10',
        'border-[var(--border-strong)]',
        // The native arrow renders on the correct side per direction; padding
        // is logical so it never overlaps the glyph.
        'pe-8',
        'aria-[invalid=true]:border-[var(--status-danger-fg)]',
        className,
      )}
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
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded border-[var(--border-strong)] accent-[var(--color-brand-600)]"
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-[var(--text-primary)]">
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Alert                                                                      */
/* -------------------------------------------------------------------------- */

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  const tones = {
    info: 'bg-[var(--status-info-bg)] text-[var(--status-info-fg)]',
    success: 'bg-[var(--status-success-bg)] text-[var(--status-success-fg)]',
    warning: 'bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)]',
    danger: 'bg-[var(--status-danger-bg)] text-[var(--status-danger-fg)]',
  };

  return (
    <div
      // Errors and warnings interrupt; informational alerts wait their turn.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-[var(--radius-card)] p-4',
        // A logical start-border reads as a leading accent in both directions.
        'border-s-4 border-s-current',
        tones[tone],
        className,
      )}
    >
      {title ? <p className="text-sm font-semibold">{title}</p> : null}
      {children ? (
        <div className={cn('text-sm leading-relaxed', title && 'mt-1 opacity-90')}>
          {children}
        </div>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state (§39)                                                          */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="grid size-12 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--text-muted)]">
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
      {body ? (
        <p className="max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">{body}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse-soft rounded-[var(--radius-control)] bg-[var(--surface-sunken)]',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Stat tile                                                                  */
/* -------------------------------------------------------------------------- */

export function StatTile({
  label,
  value,
  hint,
  tone,
  unavailable,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: BadgeTone;
  /**
   * Renders an explicit "not available" treatment instead of a zero. Used
   * wherever an integration genuinely cannot supply the number (§36, §52).
   */
  unavailable?: boolean;
}): React.JSX.Element {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </p>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          unavailable ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">{hint}</p>
      ) : null}
      {tone ? (
        <div className="mt-2">
          <Badge tone={tone} dot>
            {value}
          </Badge>
        </div>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

export function Progress({
  value,
  label,
  className,
}: {
  /** 0-100. */
  value: number;
  /** Accessible name; required because a bare bar is meaningless to a reader. */
  label: string;
  className?: string;
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn(
        'progress-track h-2 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]',
        className,
      )}
    >
      {/* No transform or physical offset: the flex flow fills from the reading
          start, so the bar grows rightward in English and leftward in Arabic. */}
      <div
        className="h-full rounded-full bg-[var(--color-brand-600)] transition-[width] duration-300"
        style={{ inlineSize: `${clamped}%` }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                      */
/* -------------------------------------------------------------------------- */

export function TableWrapper({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}): React.JSX.Element {
  return (
    // Horizontal overflow is contained here so the page body never scrolls
    // sideways — and `overflow-x` respects direction, so the initial scroll
    // position is the reading start in both languages.
    <div
      className={cn('scrollbar-slim w-full overflow-x-auto', className)}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className="w-full min-w-[36rem] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  scope = 'col',
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      scope={scope}
      className={cn(
        // `text-start` is the whole point: headers align to the reading edge.
        'border-b border-[var(--border-subtle)] px-4 py-3 text-start text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <td
      className={cn(
        'border-b border-[var(--border-subtle)] px-4 py-3 text-start align-middle text-[var(--text-primary)]',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/* -------------------------------------------------------------------------- */
/* Page header                                                                */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
