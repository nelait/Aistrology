"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, CopyButton, PageHeader, TextField } from "@/components/ui";

/** TOTP enrollment (AUTH-006). */
export default function MfaPage() {
  const { me, reloadMe } = useAuth();
  const toast = useToast();
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const setup = useMutation({ mutationFn: api.auth.mfaSetup, onSuccess: (r) => setUri(r.otpauth_uri) });
  const activate = useMutation({
    mutationFn: () => api.auth.mfaActivate(code.replace(/\s/g, "")),
    onSuccess: async () => {
      toast.success("Two-factor authentication is on");
      setUri(null);
      setCode("");
      await reloadMe();
    },
  });

  useEffect(() => {
    if (!uri) return setQr(null);
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then(setQr, () => setQr(null));
  }, [uri]);

  const secret = uri ? new URL(uri).searchParams.get("secret") : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Two-factor authentication" description="Protect your account with a time-based one-time password (TOTP) app." />
      <Card>
        <p className="mb-4 text-sm">
          Status: {me?.mfa_enabled ? <Badge tone="good">✓ Enabled</Badge> : <Badge tone="warning">Not enabled</Badge>}
        </p>
        {!uri ? (
          <Button variant="primary" onClick={() => setup.mutate()} loading={setup.isPending}>
            {me?.mfa_enabled ? "Re-enroll a new device" : "Set up authenticator app"}
          </Button>
        ) : (
          <div className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Scan the QR code with an authenticator app (1Password, Google Authenticator, Authy…).</li>
              <li>Enter the 6-digit code it shows to confirm.</li>
            </ol>
            <div className="flex flex-wrap items-start gap-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr ? <img src={qr} width={220} height={220} alt="QR code for your authenticator app" className="rounded bg-white p-2" /> : <div className="h-[220px] w-[220px] animate-pulse rounded bg-[var(--surface-2)]" />}
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p className="text-[var(--text-2)]">Can&apos;t scan? Enter this key manually:</p>
                <p className="break-all font-mono">{secret}</p>
                {secret && <CopyButton text={secret} label="Copy key" />}
              </div>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                activate.mutate();
              }}
            >
              <TextField label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} className="w-48" />
              <Button type="submit" variant="primary" loading={activate.isPending} disabled={code.replace(/\s/g, "").length < 6}>
                Activate
              </Button>
              <Button onClick={() => setUri(null)}>Cancel</Button>
            </form>
          </div>
        )}
      </Card>
    </div>
  );
}
