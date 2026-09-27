"use client";
/** Drag-and-drop zone with a keyboard-accessible file picker (ING-001). */
import { useId, useRef, useState } from "react";
import { cx } from "./ui";

export function FileDrop({ onFiles, multiple = true, accept, label = "Drop files here or browse", hint, disabled }: { onFiles: (files: File[]) => void; multiple?: boolean; accept?: string; label?: string; hint?: string; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={cx(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors",
        over ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30" : "border-[var(--border)] bg-[var(--surface)]",
        disabled && "opacity-60",
      )}
    >
      <p className="text-sm font-medium">{label}</p>
      {hint && <p className="text-xs text-[var(--text-2)]" id={`${id}-hint`}>{hint}</p>}
      <label htmlFor={id} className="cursor-pointer rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 focus-within:outline focus-within:outline-2 focus-within:outline-brand-500">
        Browse files
        <input
          ref={input}
          id={id}
          type="file"
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onFiles(files);
            if (input.current) input.current.value = "";
          }}
        />
      </label>
    </div>
  );
}
