"use client";
/** Small accessible UI kit (labels, focus, aria) shared by every page. */
import { forwardRef, useEffect, useId, useRef, useState } from "react";
import type { JobStatus } from "@/lib/types";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// -- Buttons ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 dark:disabled:bg-brand-900",
  secondary:
    "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)] disabled:opacity-50",
  ghost: "text-[var(--text)] hover:bg-[var(--surface-2)] disabled:opacity-50",
  danger: "bg-red-700 text-white hover:bg-red-800 disabled:opacity-50",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
});

// -- Form fields ---------------------------------------------------------------------------

const inputBase =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-2)]/70 disabled:opacity-60";

interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  className?: string;
  srOnlyLabel?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode;
}

export function Field({ label, hint, error, className, srOnlyLabel, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className={cx("text-xs font-medium text-[var(--text-2)]", srOnlyLabel && "sr-only")}>
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && (
        <p id={hintId} className="text-xs text-[var(--text-2)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

type InputAttrs = Omit<React.InputHTMLAttributes<HTMLInputElement>, "id">;

export function TextField({
  label,
  hint,
  error,
  className,
  srOnlyLabel,
  ...rest
}: InputAttrs & { label: React.ReactNode; hint?: React.ReactNode; error?: string | null; srOnlyLabel?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} className={className} srOnlyLabel={srOnlyLabel}>
      {({ id, describedBy, invalid }) => <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={inputBase} {...rest} />}
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className,
  mono,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & { label: React.ReactNode; hint?: React.ReactNode; error?: string | null; mono?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy, invalid }) => (
        <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={cx(inputBase, mono && "font-mono text-xs")} {...rest} />
      )}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function toOptions(values: readonly string[]): Option[] {
  return values.map((v) => ({ value: v, label: v }));
}

export function SelectField({
  label,
  hint,
  error,
  className,
  options,
  placeholder,
  srOnlyLabel,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  options: Option[];
  placeholder?: string;
  srOnlyLabel?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className} srOnlyLabel={srOnlyLabel}>
      {({ id, describedBy, invalid }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={inputBase} {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({ label, hint, className, ...rest }: InputAttrs & { label: React.ReactNode; hint?: React.ReactNode }) {
  const id = useId();
  return (
    <div className={cx("flex items-start gap-2", className)}>
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" aria-describedby={hint ? `${id}-h` : undefined} {...rest} />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint && (
          <span id={`${id}-h`} className="block text-xs text-[var(--text-2)]">
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

/** Accessible multi-select: a searchable checkbox list inside a fieldset. */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  hint,
  maxHeight = 180,
  ordered,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  hint?: string;
  maxHeight?: number;
  /** keep selection order (for reorder steps) */
  ordered?: boolean;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium text-[var(--text-2)]">{label}</legend>
      {hint && <p className="text-xs text-[var(--text-2)]">{hint}</p>}
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1">
          <label htmlFor={`${id}-q`} className="sr-only">
            Search {label}
          </label>
          <input
            id={`${id}-q`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="w-full bg-transparent text-xs outline-none"
          />
          <button type="button" className="text-xs text-brand-600 dark:text-brand-300" onClick={() => onChange(options.map((o) => o.value))}>
            All
          </button>
          <button type="button" className="text-xs text-brand-600 dark:text-brand-300" onClick={() => onChange([])}>
            None
          </button>
        </div>
        <ul className="overflow-auto p-1" style={{ maxHeight }}>
          {shown.map((o) => {
            const checked = value.includes(o.value);
            const idx = value.indexOf(o.value);
            return (
              <li key={o.value}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-[var(--surface-2)]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-600"
                    checked={checked}
                    onChange={() => onChange(checked ? value.filter((v) => v !== o.value) : [...value, o.value])}
                  />
                  <span className="truncate">{o.label}</span>
                  {ordered && checked && <span className="ml-auto text-xs text-[var(--text-2)]">#{idx + 1}</span>}
                </label>
              </li>
            );
          })}
          {!shown.length && <li className="px-2 py-1 text-xs text-[var(--text-2)]">No matches</li>}
        </ul>
      </div>
      <p className="text-xs text-[var(--text-2)]" aria-live="polite">
        {value.length} selected
      </p>
    </fieldset>
  );
}

// -- Layout -------------------------------------------------------------------------

export function Card({ title, actions, children, className, bodyClassName }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("rounded-lg border border-[var(--border)] bg-[var(--surface)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <nav aria-label="Breadcrumb" className="mb-1 text-xs text-[var(--text-2)]">{breadcrumb}</nav>}
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-[var(--text-2)]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "info" | "good" | "warning" | "critical";
const TONES: Record<Tone, string> = {
  neutral: "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--border)]",
  info: "bg-brand-50 text-brand-800 border-brand-200 dark:bg-brand-900/40 dark:text-brand-100 dark:border-brand-800",
  good: "bg-green-50 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-900",
  warning: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900",
  critical: "bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-900",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>{children}</span>;
}

const JOB_TONE: Record<JobStatus, Tone> = { queued: "neutral", running: "info", succeeded: "good", failed: "critical", cancelled: "warning" };
const JOB_ICON: Record<JobStatus, string> = { queued: "◷", running: "↻", succeeded: "✓", failed: "✕", cancelled: "⊘" };

export function StatusBadge({ status }: { status: string }) {
  const s = status as JobStatus;
  return (
    <Badge tone={JOB_TONE[s] ?? "neutral"}>
      <span aria-hidden="true">{JOB_ICON[s] ?? "•"}</span>
      {status}
    </Badge>
  );
}

export function Spinner({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx("flex items-center gap-2 text-sm text-[var(--text-2)]", className)}>
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-[var(--text-2)]">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1">{error instanceof Error ? error.message : String(error)}</p>
      {onRetry && (
        <Button size="sm" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Render loading / error / empty states around query data. */
export function QueryState<TData>({
  query,
  empty,
  children,
  loadingLabel,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data: TData | undefined; refetch: () => unknown };
  empty?: (d: TData) => React.ReactNode | null;
  children: (d: TData) => React.ReactNode;
  loadingLabel?: string;
}) {
  if (query.isLoading) return <Spinner label={loadingLabel} className="p-4" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return null;
  const e = empty?.(query.data);
  if (e) return <>{e}</>;
  return <>{children(query.data)}</>;
}

export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cx("h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatTile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-xs text-[var(--text-2)]">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold tabular-nums", tone === "critical" && "text-red-700 dark:text-red-400")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--text-2)]">{sub}</p>}
    </div>
  );
}

// -- Tabs (WAI-ARIA tabs pattern) -------------------------------------------------------------

export interface TabDef {
  id: string;
  label: React.ReactNode;
  hidden?: boolean;
}

export function Tabs({ tabs, active, onChange, label, className }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string; className?: string }) {
  const visible = tabs.filter((t) => !t.hidden);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % visible.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + visible.length) % visible.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = visible.length - 1;
    else return;
    e.preventDefault();
    onChange(visible[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cx("flex gap-1 overflow-x-auto border-b border-[var(--border)]", className)}>
      {visible.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              selected ? "border-brand-500 font-medium text-[var(--text)]" : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className={cx("pt-4 outline-none", className)}>
      {children}
    </div>
  );
}

// -- Dialogs ---------------------------------------------------------------------------

/** Modal built on <dialog>: native focus trapping, Esc to close, inert background. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  side,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** render as a right-side drawer */
  side?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl", xl: "max-w-6xl" };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        "bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/40",
        side ? "ml-auto mr-0 h-full max-h-full w-full max-w-md rounded-none" : cx("m-auto w-[calc(100%-2rem)] rounded-lg", widths[size]),
      )}
    >
      {open && (
        <div className={cx("flex flex-col", side ? "h-full" : "max-h-[85vh]")}>
          <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded px-2 py-1 text-lg leading-none hover:bg-[var(--surface-2)]">
              ×
            </button>
          </header>
          <div className="flex-1 overflow-auto p-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = "Confirm",
  danger,
  loading,
  typedConfirmation,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** require the user to type this exact text */
  typedConfirmation?: string;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked = typedConfirmation !== undefined && typed !== typedConfirmation;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={blocked} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {children}
        {typedConfirmation !== undefined && (
          <TextField
            label={
              <>
                Type <code className="rounded bg-[var(--surface-2)] px-1">{typedConfirmation}</code> to confirm
              </>
            }
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        )}
      </div>
    </Modal>
  );
}

// -- Misc -------------------------------------------------------------------------------

/** Info icon with a tooltip that also works on keyboard focus (CFG-002). */
export function InfoTip({ text, label = "More information" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="inline-grid h-4 w-4 place-items-center rounded-full border border-[var(--border)] text-[10px] text-[var(--text-2)]"
      >
        i
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute left-1/2 top-5 z-50 w-64 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs font-normal text-[var(--text)] shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      aria-live="polite"
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs" aria-label={label}>
        <code>{code}</code>
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-2)]">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SrOnly({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
