"use client";
/** Textarea with `@` autocomplete of tenant users (WAI-ARIA combobox with a listbox popup). */
import { useId, useMemo, useRef, useState } from "react";
import { activeMention, insertMention, matchUsers, type ActiveMention, type MentionUser } from "@/lib/mentions";
import { cx } from "../ui";

export function MentionTextarea({
  label,
  value,
  onChange,
  users,
  onSubmit,
  placeholder,
  rows = 3,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  users: MentionUser[];
  /** Ctrl/⌘+Enter */
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  hint?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const options = useMemo(() => (mention ? matchUsers(users, mention.query) : []), [mention, users]);
  const open = !!mention && options.length > 0;

  const sync = (el: HTMLTextAreaElement) => {
    const c = el.selectionStart ?? el.value.length;
    setCaret(c);
    const m = activeMention(el.value, c);
    setMention(m);
    if (!m) setActive(0);
  };

  const choose = (u: MentionUser) => {
    if (!mention) return;
    const r = insertMention(value, mention, caret, u.id);
    onChange(r.text);
    setMention(null);
    setActive(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      }
    });
  };

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-[var(--text-2)]">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={5000}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-hint`}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm"
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target);
        }}
        onClick={(e) => sync(e.currentTarget)}
        onKeyUp={(e) => {
          if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) sync(e.currentTarget);
        }}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % options.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + options.length) % options.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(options[Math.min(active, options.length - 1)]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-[var(--text-2)]">
        {hint ?? "Type @ to mention someone. Ctrl/⌘ + Enter to post."}
      </p>
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label="Mention suggestions" className="absolute left-0 top-full z-50 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg">
          {options.map((u, i) => (
            <li
              key={u.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx("cursor-pointer rounded px-2 py-1 text-sm", i === active ? "bg-brand-50 dark:bg-brand-900/40" : "hover:bg-[var(--surface-2)]")}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(u);
              }}
            >
              <span className="font-medium">{u.label}</span>
              {u.sub && <span className="block text-xs text-[var(--text-2)]">{u.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
