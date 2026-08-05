import { config } from "./config";

// Pluggable mailer. Sends real email through the Resend HTTP API when
// RESEND_API_KEY + REMINDER_FROM_EMAIL are configured; otherwise logs the
// message (reminders still reach the user via an in-app notification).

export function emailConfigured(): boolean {
  return Boolean(config.email.resendApiKey && config.email.from);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ delivered: boolean; via: string }> {
  if (emailConfigured()) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.email.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.email.from,
          to: opts.to,
          subject: opts.subject,
          text: opts.text,
          html: opts.html,
        }),
      });
      if (r.ok) return { delivered: true, via: "resend" };
      console.warn(`[mailer] Resend responded ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    } catch (e) {
      console.warn("[mailer] Resend request failed:", e);
    }
  }
  // Dev / unconfigured fallback — the in-app notification carries the reminder.
  console.log(`[mailer:dev] (no email provider) → ${opts.to} · ${opts.subject}`);
  return { delivered: false, via: "log" };
}
