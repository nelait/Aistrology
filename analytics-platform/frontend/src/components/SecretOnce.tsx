"use client";
/** Dialog that shows a freshly created secret exactly once (OAuth clients, SCIM tokens, inbound hooks). */
import { Button, CopyButton, Modal } from "./ui";

export function SecretOnce({
  open,
  onClose,
  title,
  secrets,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  secrets: { label: string; value: string }[];
  children?: React.ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      }
    >
      <p role="alert" className="mb-3 text-sm text-amber-900 dark:text-amber-200">
        ⚠ Copy it now: it is shown only once and only a hash is stored.
      </p>
      <dl className="space-y-3">
        {secrets.map((s) => (
          <div key={s.label}>
            <dt className="mb-1 text-xs font-medium text-[var(--text-2)]">{s.label}</dt>
            <dd className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-[var(--surface-2)] p-2 font-mono text-xs">{s.value}</code>
              <CopyButton text={s.value} label={`Copy ${s.label.toLowerCase()}`} />
            </dd>
          </div>
        ))}
      </dl>
      {children && <div className="mt-4">{children}</div>}
    </Modal>
  );
}
