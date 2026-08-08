import "dotenv/config";

// All configuration comes from environment variables (see .env.example). OAuth
// only works once you register apps with Google / GitHub and supply the client
// id + secret; without them those buttons return a clear "not configured" error.

/**
 * Are we running on a hosting platform? Detected from the markers each provider
 * injects automatically.
 *
 * This exists so that FORGETTING `NODE_ENV=production` cannot produce an
 * insecure deploy. Keying only off NODE_ENV meant a hosted app with it unset
 * would serve no SPA, skip the database guard and — worst of all — leave the
 * passwordless dev login ENABLED in public.
 */
const onHostingPlatform = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||   // Railway
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RENDER ||                 // Render
  process.env.FLY_APP_NAME ||           // Fly.io
  process.env.K_SERVICE ||              // Google Cloud Run
  process.env.DYNO,                     // Heroku
);

/** Treat an explicit NODE_ENV=production OR any hosted environment as production. */
const isProduction = process.env.NODE_ENV === "production" || onHostingPlatform;

export const config = {
  onHostingPlatform,
  port: Number(process.env.PORT ?? 8787),
  // Origin the browser uses (the Vite app). OAuth redirects and the post-login
  // bounce go here; Vite proxies /auth and /api to this server.
  appUrl: process.env.APP_URL ?? "http://localhost:5173",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me",
  // Secret used to encrypt stored LLM API keys at rest (falls back to the
  // session secret in dev). Set your own in production.
  llmEncSecret:
    process.env.LLM_ENC_SECRET ?? process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me",
  // PostgreSQL connection string.
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://localhost:5432/aistrology",
  // A local, provider-less login for development so the signed-in experience is
  // usable without registering OAuth apps. Never enable in production — hence it
  // defaults OFF there and must be opted into explicitly.
  allowDevLogin: isProduction
    ? process.env.ALLOW_DEV_LOGIN === "true"
    : (process.env.ALLOW_DEV_LOGIN ?? "true") !== "false",
  isProduction,
  // Serve the built SPA from this process (single-origin production deploys such
  // as Railway). Defaults on in production; set SERVE_STATIC=false to disable
  // when the frontend is hosted separately on a CDN.
  serveStatic:
    process.env.SERVE_STATIC !== undefined
      ? process.env.SERVE_STATIC === "true"
      : isProduction,
  // Run the reminder/promo-expiry sweep inside this process on an hourly timer.
  // Correct for a single always-on instance. Set RUN_SCHEDULER=false and drive
  // `npm run scheduler:run` from a platform cron once you run more than one
  // replica (otherwise every replica sweeps) or allow the service to sleep
  // (a sleeping process never fires the timer).
  runScheduler: (process.env.RUN_SCHEDULER ?? "true") !== "false",
  // Admin module. The super-admin is seeded from these at startup and can never
  // be created through public registration. Admin login additionally requires
  // the access code, so a leaked password alone can't reach the admin area.
  admin: {
    email: (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD ?? "",
    accessCode: process.env.ADMIN_ACCESS_CODE ?? "",
  },
  // Outbound email (reminders). Uses the Resend HTTP API when configured;
  // otherwise reminders still reach users via in-app notifications.
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.REMINDER_FROM_EMAIL ?? "",
  },
  providers: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid email profile",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userUrl: "https://api.github.com/user",
      scope: "read:user user:email",
    },
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    proPriceId: process.env.STRIPE_PRO_PRICE_ID ?? "",
    premiumPriceId: process.env.STRIPE_PREMIUM_PRICE_ID ?? "",
  },
} as const;

export type Provider = "google" | "github";

export function providerConfigured(p: Provider): boolean {
  return Boolean(config.providers[p].clientId && config.providers[p].clientSecret);
}

export function redirectUri(p: Provider): string {
  return `${config.appUrl}/auth/${p}/callback`;
}

/** Whether an admin can be seeded / the admin login can succeed. */
export function adminConfigured(): boolean {
  return Boolean(config.admin.email && config.admin.password && config.admin.accessCode);
}
