import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { config, providerConfigured, adminConfigured } from "./config";
import { initDb, pool } from "./db";
import { authRouter, seedAdmin } from "./auth";
import { chartsRouter } from "./charts";
import { settingsRouter, llmRouter } from "./llm";
import { billingRouter } from "./stripe";
import { consultationRouter } from "./consultation";
import { adminRouter } from "./admin";
import { notificationsRouter } from "./notifications";
import { templesRouter } from "./temples";
import { remindersRouter } from "./reminders";
import { startReminderScheduler } from "./reminderScheduler";
import { loadQuotas } from "./quotas";
import { promoRouter } from "./promo";
import { contactRouter } from "./contact";
import { chatRouter } from "./chat";
import { notesRouter } from "./notes";
import { feedbackRouter } from "./feedback";

const app = express();

// Stripe webhook needs raw body for signature verification — mount BEFORE json parser
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

// Global per-IP rate limiter: 100 requests per minute per IP.
// Acts as a safety net against automated abuse (scripts, bots).
import { checkRateLimit } from "./rateLimit";
app.use((req, res, next) => {
  // Skip health check and static asset requests
  if (req.path === "/api/health") return next();
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const rl = checkRateLimit(`global:${ip}`, 100, 60_000);
  if (!rl.allowed) {
    res.status(429).json({ error: "Too many requests. Please slow down." });
    return;
  }
  next();
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up", time: Date.now() });
  } catch {
    res.status(500).json({ ok: false, db: "down" });
  }
});

app.use("/auth", authRouter);
app.use("/api/charts", chartsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/llm", llmRouter);
app.use("/api/billing", billingRouter);
app.use("/api/consultation", consultationRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/temples", templesRouter);
app.use("/api/reminders", remindersRouter);
app.use("/api/promo", promoRouter);
app.use("/api/contact", contactRouter);
app.use("/api/chat", chatRouter);
app.use("/api/notes", notesRouter);
app.use("/api/feedback", feedbackRouter);

// ── Static SPA (production) ────────────────────────────────────────────────
// In dev, Vite serves the app on :5173 and proxies /api + /auth here. In
// production there is no Vite, so this process serves the built SPA too — one
// origin, which keeps the same-site session cookie and relative fetch() paths
// working with no CORS. Mounted AFTER the API routes so it never shadows them.
if (config.serveStatic) {
  const dist = path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  // Client-side routing: hand any non-API GET to index.html.
  app.get(/^(?!\/(api|auth)\/).*/, (req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

/**
 * Connection string with the password removed, safe to print.
 * Deploy logs are routinely pasted into chats, issues and screenshots, so the
 * startup banner must never carry the credential.
 */
function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<unparseable connection string>";
  }
}

/**
 * Fail fast, and legibly, when the database is misconfigured in production.
 * Without this the localhost fallback is used inside the container and the only
 * symptom is an ECONNREFUSED stack trace against 127.0.0.1:5432, which says
 * nothing about the actual cause (an unset or unresolved DATABASE_URL).
 */
function assertDatabaseConfigured(): void {
  if (!config.isProduction) return;
  const raw = process.env.DATABASE_URL;
  const pointsAtLocalhost = /(^|@|\/\/)(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(config.databaseUrl);
  const unresolvedRef = raw !== undefined && raw.includes("${{");
  if (raw && !pointsAtLocalhost && !unresolvedRef) return;

  // Show what actually arrived (host only — never the password) so the cause is
  // visible from the deploy log instead of being guessed at.
  let seen: string;
  if (raw === undefined) {
    seen = "<not set — using the built-in localhost default>";
  } else {
    let host = "<unparseable>";
    try { host = new URL(raw).hostname || "<empty host>"; } catch { /* keep */ }
    seen = `host="${host}"  (length ${raw.length}, starts "${raw.slice(0, 12)}…")`;
  }

  console.error(
    "\nFATAL: the database is not configured for production.\n" +
    `  DATABASE_URL as received by the app: ${seen}\n` +
    (raw === undefined
      ? "  DATABASE_URL is not set, so the server fell back to localhost —\n" +
        "  which is nothing at all inside a container.\n"
      : unresolvedRef
        ? "  DATABASE_URL still contains an unresolved reference (${{ ... }}).\n" +
          "  It was stored as literal text instead of a variable reference.\n"
        : "  DATABASE_URL points at localhost, which is not reachable from the container.\n") +
    "\n  On Railway: open the APP service (not Postgres) -> Variables, and add\n" +
    "      DATABASE_URL = ${{Postgres.DATABASE_URL}}\n" +
    "  using the variable-reference picker so it resolves to the Postgres service.\n" +
    "  Both services must live in the SAME Railway project.\n" +
    "  Verify locally first with:  railway run npm run deploy:check\n",
  );
  process.exit(1);
}

async function start() {
  assertDatabaseConfigured();
  await initDb();
  await seedAdmin();
  await loadQuotas();
  // Skipped when a platform cron owns the sweep (see scripts/run-scheduled.ts).
  if (config.runScheduler) startReminderScheduler();
  app.listen(config.port, () => {
    const flags = [
      providerConfigured("google") ? "google✓" : "google✗",
      providerConfigured("github") ? "github✓" : "github✗",
      "password✓",
      config.allowDevLogin ? "dev-login✓" : "dev-login✗",
      adminConfigured() ? "admin✓" : "admin✗",
      config.runScheduler ? "scheduler✓" : "scheduler✗(cron)",
    ].join(" ");
    console.log(`Aistrology API on http://localhost:${config.port}  [${flags}]`);
    // NEVER log the connection string itself — it carries the password, and
    // deploy logs get copied into chats, issues and screenshots.
    console.log(`Postgres: ${redactDbUrl(config.databaseUrl)}`);
    console.log(`App origin (APP_URL): ${config.appUrl}`);
    if (config.sessionSecret === "dev-insecure-secret-change-me") {
      console.warn("⚠  Using the default SESSION_SECRET — set one in .env for anything real.");
    }
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
