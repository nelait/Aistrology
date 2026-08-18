/**
 * Pre-deploy sanity check. Run locally against a Railway environment
 * (`railway run npm run deploy:check`) or in the release step.
 *
 * Exits non-zero on anything that would be unsafe or broken in production, so a
 * bad config fails loudly instead of silently shipping (e.g. dev login left on,
 * or the placeholder session secret still in place).
 */
import "dotenv/config"; // convenience for local runs; `railway run` vars still win
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULTS = new Set([
  "change-me-to-a-long-random-string",
  "change-me-to-another-long-random-string",
  "dev-insecure-secret-change-me",
]);

const errors: string[] = [];
const warnings: string[] = [];
const notes: string[] = [];

const env = (k: string) => (process.env[k] ?? "").trim();
const isProd = env("NODE_ENV") === "production";

// ── Required ───────────────────────────────────────────────────────────────
if (!env("DATABASE_URL")) {
  errors.push("DATABASE_URL is not set. Add a Postgres service in Railway and reference ${{Postgres.DATABASE_URL}}.");
} else if (/@(localhost|127\.0\.0\.1)/.test(env("DATABASE_URL")) && isProd) {
  errors.push("DATABASE_URL points at localhost in production.");
}

for (const key of ["SESSION_SECRET", "LLM_ENC_SECRET"]) {
  const v = env(key);
  if (!v) {
    (key === "LLM_ENC_SECRET" ? warnings : errors).push(
      `${key} is not set.${key === "LLM_ENC_SECRET" ? " Falls back to SESSION_SECRET; set its own value." : ""}`,
    );
  } else if (DEFAULTS.has(v)) {
    errors.push(`${key} still holds the placeholder value from .env.example.`);
  } else if (v.length < 32) {
    warnings.push(`${key} is only ${v.length} chars — use 32+ random characters.`);
  }
}

const appUrl = env("APP_URL");
if (!appUrl) {
  errors.push("APP_URL is not set. Use your Railway public domain, e.g. https://<app>.up.railway.app");
} else if (isProd && !appUrl.startsWith("https://")) {
  errors.push(`APP_URL must be https in production (got "${appUrl}"). OAuth redirects and secure cookies depend on it.`);
} else if (appUrl.endsWith("/")) {
  warnings.push("APP_URL has a trailing slash — drop it to avoid double slashes in redirects.");
}

// ── Safety ─────────────────────────────────────────────────────────────────
if (isProd && env("ALLOW_DEV_LOGIN") === "true") {
  errors.push("ALLOW_DEV_LOGIN=true in production — this lets anyone sign in as any name. Remove it.");
}
if (!isProd) {
  warnings.push(`NODE_ENV is "${env("NODE_ENV") || "unset"}", not "production". Static SPA serving and dev-login hardening key off it.`);
}

// ── Scheduler ──────────────────────────────────────────────────────────────
if (env("RUN_SCHEDULER") === "false") {
  notes.push("Scheduler:       in-process OFF — a cron must run `npm run scheduler:run` hourly, or reminders and promo expiry never fire.");
} else {
  notes.push("Scheduler:       in-process (hourly) — keep this service at ONE replica and non-sleeping.");
}

// ── Admin module ───────────────────────────────────────────────────────────
const adminSet = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_ACCESS_CODE"].filter((k) => env(k));
if (adminSet.length === 0) {
  warnings.push("No ADMIN_* variables — the admin console will be unreachable (no super-admin seeded).");
} else if (adminSet.length < 3) {
  errors.push(`Admin partially configured (${adminSet.join(", ")}). All three of ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_ACCESS_CODE are required.`);
} else if (env("ADMIN_PASSWORD").length < 12) {
  warnings.push("ADMIN_PASSWORD is under 12 characters.");
}

// ── Optional integrations (report state, never fail) ───────────────────────
notes.push(`Stripe billing:  ${env("STRIPE_SECRET_KEY") ? "configured" : "off (checkout returns 503)"}`);
if (env("STRIPE_SECRET_KEY") && !env("STRIPE_WEBHOOK_SECRET")) {
  warnings.push("STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — cancellations, refunds and disputes will not be processed.");
}
notes.push(`Google OAuth:    ${env("GOOGLE_CLIENT_ID") ? "configured" : "off"}`);
notes.push(`GitHub OAuth:    ${env("GITHUB_CLIENT_ID") ? "configured" : "off"}`);
notes.push(`Reminder email:  ${env("RESEND_API_KEY") ? "configured" : "off (in-app notifications only)"}`);

// ── Build output ───────────────────────────────────────────────────────────
const distIndex = resolve(process.cwd(), "dist/index.html");
if (!existsSync(distIndex)) {
  (isProd ? errors : warnings).push("dist/index.html is missing — run `npm run build` before starting.");
}

// ── Report ─────────────────────────────────────────────────────────────────
const out = (label: string, items: string[]) => {
  if (!items.length) return;
  console.log(`\n${label}`);
  for (const i of items) console.log(`  • ${i}`);
};
console.log("Shastri deploy check");
out("Integrations", notes);
out("⚠ Warnings", warnings);
out("✖ Errors", errors);

if (errors.length) {
  console.log(`\n${errors.length} blocking issue(s). Fix before deploying.\n`);
  process.exit(1);
}
console.log(`\n✓ No blocking issues${warnings.length ? ` (${warnings.length} warning(s))` : ""}.\n`);
