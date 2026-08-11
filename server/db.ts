import pg from "pg";
import { randomUUID } from "node:crypto";
import { config } from "./config";

// PostgreSQL-backed persistence. A single pooled connection is shared across the
// server. UUIDs are generated in Node so we don't depend on a pgcrypto extension.

// Managed Postgres reached over a public proxy (Railway, Neon, Supabase…)
// requires TLS, but presents a certificate signed by an internal CA — hence
// rejectUnauthorized:false. Railway's *private* network URL and local Postgres
// need no TLS at all, so only enable it when the host is clearly remote.
const NO_TLS_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"]);

function sslFor(url: string): pg.ConnectionConfig["ssl"] {
  if (process.env.PGSSLMODE === "disable") return undefined;
  if (/[?&]sslmode=disable/i.test(url)) return undefined;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined; // unparseable — let pg surface its own error, don't force TLS
  }
  // Local dev and Railway's private network speak plain TCP.
  if (NO_TLS_HOSTS.has(host) || host.endsWith(".railway.internal")) return undefined;
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: sslFor(config.databaseUrl),
});

export interface UserRow {
  id: string;
  provider: string; // 'password' | 'google' | 'github' | 'dev'
  provider_id: string; // password: the email; oauth: the provider's user id
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  stripe_customer_id: string | null;
  plan: string; // 'free' | 'pro' | 'premium'
  role: string; // 'user' | 'admin'
  suspended: boolean;
  email_verified: boolean;
  plan_expires_at: string | null; // promo grant expiry (null = permanent)
  plan_source: string | null; // 'stripe' | 'manual' (admin comp) | 'promo' | null
  created_at: string; // bigint comes back as a string from pg
}

export interface ChartRow {
  id: string;
  user_id: string;
  label: string;
  birth_json: unknown; // JSONB → already a JS object
  created_at: string;
  updated_at: string;
}

/** Create the schema if it doesn't exist. Call once at startup. */
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY,
      provider      TEXT NOT NULL,
      provider_id   TEXT NOT NULL,
      name          TEXT,
      email         TEXT,
      avatar_url    TEXT,
      password_hash TEXT,
      created_at    BIGINT NOT NULL,
      UNIQUE (provider, provider_id)
    );

    -- Stripe billing + admin columns (idempotent adds)
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_charts_created INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
      -- When set, the plan is a temporary promo grant that reverts to 'free' after this time.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at BIGINT;
      -- How the current plan was granted: 'stripe' | 'manual' (admin comp) | 'promo'.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_source TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS charts (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      birth_json  JSONB NOT NULL,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_charts_user ON charts(user_id, updated_at DESC);

    -- Email verification tokens
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id         UUID PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_verify_token ON email_verification_tokens(token);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (lower(email)) WHERE email IS NOT NULL AND provider = 'password';

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL
    );

    -- Global, admin-managed key/value settings (e.g. the shared LLM config).
    CREATE TABLE IF NOT EXISTS global_settings (
      key        TEXT PRIMARY KEY,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL
    );

    -- In-app notifications. Broadcasts are fanned out to one row per user.
    CREATE TABLE IF NOT EXISTS notifications (
      id         UUID PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      read_at    BIGINT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

    -- Consultation marketplace: Premium users publish a provider profile ("offer"),
    -- and any signed-in user can request a booking against an approved offer.
    CREATE TABLE IF NOT EXISTS consultation_offers (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name  TEXT NOT NULL,
      headline      TEXT NOT NULL,
      bio           TEXT NOT NULL,
      specialties   TEXT,
      languages     TEXT,
      rate_inr      INTEGER,
      contact_email TEXT,
      status        TEXT NOT NULL DEFAULT 'approved',  -- pending | approved | rejected
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
    -- What kind of provider this is, so seekers can filter the directory.
    ALTER TABLE consultation_offers
      ADD COLUMN IF NOT EXISTS provider_type TEXT NOT NULL DEFAULT 'astrologer'; -- astrologer | priest | both

    CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_user ON consultation_offers(user_id);
    CREATE INDEX IF NOT EXISTS idx_offers_status ON consultation_offers(status);

    CREATE TABLE IF NOT EXISTS consultation_bookings (
      id             UUID PRIMARY KEY,
      seeker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      offer_id       UUID NOT NULL REFERENCES consultation_offers(id) ON DELETE CASCADE,
      topic          TEXT NOT NULL,
      preferred_time TEXT,
      message        TEXT,
      contact_email  TEXT,
      status         TEXT NOT NULL DEFAULT 'requested', -- requested | confirmed | declined | completed
      created_at     BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_seeker ON consultation_bookings(seeker_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bookings_offer ON consultation_bookings(offer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS vastu_settings (
      chart_id       UUID PRIMARY KEY REFERENCES charts(id) ON DELETE CASCADE,
      questionnaire  JSONB NOT NULL,
      floor_plan     TEXT,
      updated_at     BIGINT NOT NULL
    );
  `);

  // Migration: add floor_plan column if missing (safe to run repeatedly)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE vastu_settings ADD COLUMN IF NOT EXISTS floor_plan TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  // ── Temple affiliation tables ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS temples (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      deity         TEXT NOT NULL,
      location      TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      contact_email TEXT,
      contact_phone TEXT,
      website       TEXT,
      image_url     TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_temples_user ON temples(user_id);
    CREATE INDEX IF NOT EXISTS idx_temples_status ON temples(status);

    CREATE TABLE IF NOT EXISTS temple_services (
      id          UUID PRIMARY KEY,
      temple_id   UUID NOT NULL REFERENCES temples(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      deity       TEXT,
      duration    TEXT,
      price_inr   INTEGER,
      available   BOOLEAN NOT NULL DEFAULT true,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_temple_services_temple ON temple_services(temple_id);

    CREATE TABLE IF NOT EXISTS temple_events (
      id          UUID PRIMARY KEY,
      temple_id   UUID NOT NULL REFERENCES temples(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_date  TEXT NOT NULL,
      event_time  TEXT,
      recurring   TEXT NOT NULL DEFAULT 'none',
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_temple_events_temple ON temple_events(temple_id);
  `);

  // Migration: temples become self-owned accounts with their own credentials,
  // decoupled from astrology users. user_id becomes optional (legacy rows only).
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE temples ALTER COLUMN user_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL; END $$;
    ALTER TABLE temples ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE temples ADD COLUMN IF NOT EXISTS password_hash TEXT;
    DROP INDEX IF EXISTS idx_temples_user;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_temples_email
      ON temples (lower(email)) WHERE email IS NOT NULL;
  `);

  // ── Reminders (personal) + admin-curated festivals ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      notes         TEXT NOT NULL DEFAULT '',
      event_date    TEXT NOT NULL,                 -- YYYY-MM-DD (annual uses MM-DD each year)
      recurrence    TEXT NOT NULL DEFAULT 'annual', -- annual | once
      lead_days     INTEGER NOT NULL DEFAULT 7,
      enabled       BOOLEAN NOT NULL DEFAULT true,
      last_notified TEXT,                           -- ISO date of the occurrence last notified
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);

    CREATE TABLE IF NOT EXISTS festivals (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_date  TEXT NOT NULL,                    -- YYYY-MM-DD
      recurring   BOOLEAN NOT NULL DEFAULT true,    -- annual by month/day
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS festival_subscriptions (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      festival_id   UUID NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
      lead_days     INTEGER NOT NULL DEFAULT 3,
      last_notified TEXT,
      created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fest_sub_unique ON festival_subscriptions(user_id, festival_id);

    -- Promo codes: redeeming one grants Pro/Premium directly (bypasses Stripe).
    CREATE TABLE IF NOT EXISTS promo_codes (
      id              UUID PRIMARY KEY,
      code            TEXT NOT NULL,
      plan            TEXT NOT NULL,             -- pro | premium
      expires_at      BIGINT,                    -- code redeemable until (null = always)
      max_redemptions INTEGER,                   -- null = unlimited
      duration_days   INTEGER NOT NULL DEFAULT 30, -- how long the grant lasts per user
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_code ON promo_codes (upper(code));
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_redemptions INTEGER;
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 30;

    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id         UUID PRIMARY KEY,
      promo_id   UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemption_unique ON promo_redemptions(promo_id, user_id);

    -- Contact-us messages. user_id is kept (nullable) if the sender is signed in.
    CREATE TABLE IF NOT EXISTS contact_messages (
      id         UUID PRIMARY KEY,
      user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      email      TEXT,
      category   TEXT NOT NULL DEFAULT 'general',
      message    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'new', -- new | read | resolved
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_messages(created_at DESC);

    -- Refunds / disputes surfaced from Stripe webhooks. An audit trail for admins;
    -- the app never issues refunds, it only records the events Stripe reports.
    CREATE TABLE IF NOT EXISTS billing_events (
      id          UUID PRIMARY KEY,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL,             -- refund | dispute_opened | dispute_closed
      detail      TEXT NOT NULL DEFAULT '',  -- human-readable summary
      amount      BIGINT,                    -- minor units (cents), if applicable
      currency    TEXT,
      action      TEXT NOT NULL DEFAULT '',  -- what the app did (e.g. 'access revoked')
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_events_created ON billing_events(created_at DESC);

    -- Astro Chat (Phase 2): persisted conversations + messages, scoped per user.
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chart_id    UUID REFERENCES charts(id) ON DELETE SET NULL,
      title       TEXT NOT NULL DEFAULT 'New chat',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_conv_user ON chat_conversations(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id               UUID PRIMARY KEY,
      conversation_id  UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role             TEXT NOT NULL, -- user | assistant
      content          TEXT NOT NULL,
      created_at       BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, created_at ASC);

    -- Per-profile notes (paid feature). Attached to a saved chart; scoped to the
    -- owner. Useful for Premium users juggling many profiles.
    CREATE TABLE IF NOT EXISTS notes (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chart_id    UUID NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
      title       TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_user_chart ON notes(user_id, chart_id, updated_at DESC);

    -- Per-feature user feedback ("was this helpful?"), surfaced in the admin
    -- console. Append-only: repeat submissions are separate rows so the comment
    -- history is preserved. user_id survives account deletion as NULL so the
    -- aggregate counts stay honest.
    CREATE TABLE IF NOT EXISTS feedback (
      id          UUID PRIMARY KEY,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      feature     TEXT NOT NULL,
      rating      TEXT NOT NULL,              -- up | down
      comment     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'new', -- new | read | actioned
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_feature ON feedback(feature);
  `);
}

/** Per-user settings blob (LLM provider config, etc.). */
export async function getUserSettings(userId: string): Promise<Record<string, unknown>> {
  const r = await pool.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM user_settings WHERE user_id = $1",
    [userId],
  );
  return r.rows[0]?.data ?? {};
}

export async function setUserSettings(
  userId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = $3`,
    [userId, JSON.stringify(data), Date.now()],
  );
}

export async function getUser(id: string): Promise<UserRow | undefined> {
  const r = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return r.rows[0];
}

/** Get user's current plan. */
export async function getUserPlan(userId: string): Promise<string> {
  const r = await pool.query<{ plan: string }>("SELECT plan FROM users WHERE id = $1", [userId]);
  return r.rows[0]?.plan ?? "free";
}

/** Get the lifetime total of charts this user has created. */
export async function getTotalChartsCreated(userId: string): Promise<number> {
  const r = await pool.query<{ total_charts_created: number }>(
    "SELECT total_charts_created FROM users WHERE id = $1", [userId],
  );
  return r.rows[0]?.total_charts_created ?? 0;
}

/** Atomically increment the lifetime chart counter and return the new value. */
export async function incrementChartsCreated(userId: string): Promise<number> {
  const r = await pool.query<{ total_charts_created: number }>(
    "UPDATE users SET total_charts_created = total_charts_created + 1 WHERE id = $1 RETURNING total_charts_created",
    [userId],
  );
  return r.rows[0]?.total_charts_created ?? 1;
}

/** Update plan and optionally set stripe_customer_id. */
/**
 * Set a permanent plan. Always clears any promo expiry — a real/comped plan is
 * never a temporary promo grant, so the promo-expiry scheduler never touches it.
 * `source` records how it was granted ('stripe' by default; 'manual' for admin
 * comps) so the Stripe reconcile-on-load can leave admin comps alone. A `free`
 * plan carries no source.
 */
export async function setUserPlan(
  userId: string,
  plan: string,
  stripeCustomerId?: string,
  source: string = "stripe",
): Promise<void> {
  const planSource = plan === "free" ? null : source;
  if (stripeCustomerId) {
    await pool.query(
      "UPDATE users SET plan = $1, stripe_customer_id = $2, plan_expires_at = NULL, plan_source = $3 WHERE id = $4",
      [plan, stripeCustomerId, planSource, userId],
    );
  } else {
    await pool.query(
      "UPDATE users SET plan = $1, plan_expires_at = NULL, plan_source = $2 WHERE id = $3",
      [plan, planSource, userId],
    );
  }
}

/** Store only the Stripe customer id, without touching plan or promo expiry. */
export async function setStripeCustomerId(userId: string, stripeCustomerId: string): Promise<void> {
  await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [stripeCustomerId, userId]);
}

/** Find user by Stripe customer ID (for webhook lookups). */
export async function findUserByStripeCustomer(stripeCustomerId: string): Promise<UserRow | undefined> {
  const r = await pool.query<UserRow>(
    "SELECT * FROM users WHERE stripe_customer_id = $1",
    [stripeCustomerId],
  );
  return r.rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const r = await pool.query<UserRow>(
    "SELECT * FROM users WHERE provider = 'password' AND lower(email) = lower($1)",
    [email],
  );
  return r.rows[0];
}

// ---------- Email verification ----------

/** Create a verification token. Expires in 24 hours. */
export async function createVerificationToken(userId: string): Promise<string> {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, "");
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60_000; // 24 hours
  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, token, expiresAt, now],
  );
  return token;
}

/** Verify a token — marks user as verified if valid and not expired. */
export async function verifyEmailToken(token: string): Promise<{ success: boolean; error?: string }> {
  const r = await pool.query<{ user_id: string; expires_at: string; used: boolean }>(
    "SELECT user_id, expires_at::text, used FROM email_verification_tokens WHERE token = $1",
    [token],
  );
  const row = r.rows[0];
  if (!row) return { success: false, error: "Invalid verification link." };
  if (row.used) return { success: false, error: "This link has already been used." };
  if (Number(row.expires_at) < Date.now()) return { success: false, error: "This link has expired. Please request a new one." };

  // Mark token as used and user as verified (atomically)
  await pool.query("UPDATE email_verification_tokens SET used = true WHERE token = $1", [token]);
  await pool.query("UPDATE users SET email_verified = true WHERE id = $1", [row.user_id]);
  return { success: true };
}

/** Check if user has verified their email. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const r = await pool.query<{ email_verified: boolean }>(
    "SELECT email_verified FROM users WHERE id = $1",
    [userId],
  );
  return r.rows[0]?.email_verified ?? false;
}

/** Mark an OAuth user as verified (they come pre-verified). */
export async function markEmailVerified(userId: string): Promise<void> {
  await pool.query("UPDATE users SET email_verified = true WHERE id = $1", [userId]);
}

/** Create a password (email) user. Throws if the email is already registered. */
export async function createPasswordUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<UserRow> {
  const id = randomUUID();
  const r = await pool.query<UserRow>(
    `INSERT INTO users (id, provider, provider_id, name, email, password_hash, created_at)
     VALUES ($1, 'password', $2, $3, $2, $4, $5)
     RETURNING *`,
    [id, input.email.toLowerCase(), input.name, input.passwordHash, Date.now()],
  );
  return r.rows[0];
}

/** Find or create a user for an external provider identity (OAuth / dev). */
export async function upsertUser(input: {
  provider: string;
  providerId: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}): Promise<UserRow> {
  const existing = await pool.query<UserRow>(
    "SELECT * FROM users WHERE provider = $1 AND provider_id = $2",
    [input.provider, input.providerId],
  );
  if (existing.rows[0]) {
    const u = existing.rows[0];
    const r = await pool.query<UserRow>(
      "UPDATE users SET name = $1, email = $2, avatar_url = $3 WHERE id = $4 RETURNING *",
      [input.name ?? u.name, input.email ?? u.email, input.avatarUrl ?? u.avatar_url, u.id],
    );
    return r.rows[0];
  }
  const id = randomUUID();
  const r = await pool.query<UserRow>(
    `INSERT INTO users (id, provider, provider_id, name, email, avatar_url, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, input.provider, input.providerId, input.name ?? null, input.email ?? null, input.avatarUrl ?? null, Date.now()],
  );
  return r.rows[0];
}

export async function listCharts(userId: string): Promise<ChartRow[]> {
  const r = await pool.query<ChartRow>(
    "SELECT * FROM charts WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId],
  );
  return r.rows;
}

export async function getChart(userId: string, id: string): Promise<ChartRow | undefined> {
  const r = await pool.query<ChartRow>(
    "SELECT * FROM charts WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return r.rows[0];
}

export async function createChart(
  userId: string,
  label: string,
  birth: unknown,
): Promise<ChartRow> {
  const id = randomUUID();
  const now = Date.now();
  const r = await pool.query<ChartRow>(
    `INSERT INTO charts (id, user_id, label, birth_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
    [id, userId, label, JSON.stringify(birth), now],
  );
  return r.rows[0];
}

export async function updateChart(
  userId: string,
  id: string,
  fields: { label?: string; birth?: unknown },
): Promise<ChartRow | undefined> {
  const existing = await getChart(userId, id);
  if (!existing) return undefined;
  const r = await pool.query<ChartRow>(
    `UPDATE charts SET label = $1, birth_json = $2, updated_at = $3
     WHERE id = $4 AND user_id = $5 RETURNING *`,
    [
      fields.label ?? existing.label,
      fields.birth !== undefined ? JSON.stringify(fields.birth) : existing.birth_json,
      Date.now(),
      id,
      userId,
    ],
  );
  return r.rows[0];
}

export async function deleteChart(userId: string, id: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM charts WHERE id = $1 AND user_id = $2", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

// ---------- Consultation marketplace ----------

export interface OfferRow {
  id: string;
  user_id: string;
  display_name: string;
  headline: string;
  bio: string;
  provider_type: string; // astrologer | priest | both
  specialties: string | null;
  languages: string | null;
  rate_inr: number | null;
  contact_email: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface BookingRow {
  id: string;
  seeker_id: string;
  offer_id: string;
  topic: string;
  preferred_time: string | null;
  message: string | null;
  contact_email: string | null;
  status: string;
  created_at: string;
}

export interface OfferInput {
  displayName: string;
  headline: string;
  bio: string;
  providerType?: string;
  specialties?: string | null;
  languages?: string | null;
  rateInr?: number | null;
  contactEmail?: string | null;
}

/** Approved provider offers, for the public booking directory. */
export async function listApprovedOffers(): Promise<OfferRow[]> {
  const r = await pool.query<OfferRow>(
    "SELECT * FROM consultation_offers WHERE status = 'approved' ORDER BY updated_at DESC",
  );
  return r.rows;
}

/** The signed-in user's own provider profile, whatever its status. */
export async function getMyOffer(userId: string): Promise<OfferRow | undefined> {
  const r = await pool.query<OfferRow>(
    "SELECT * FROM consultation_offers WHERE user_id = $1",
    [userId],
  );
  return r.rows[0];
}

export async function getOffer(id: string): Promise<OfferRow | undefined> {
  const r = await pool.query<OfferRow>("SELECT * FROM consultation_offers WHERE id = $1", [id]);
  return r.rows[0];
}

/**
 * Create or update the user's provider profile. New profiles enter as
 * 'pending' and require admin approval before appearing in the directory;
 * editing an existing profile keeps its current status.
 */
export async function upsertOffer(userId: string, input: OfferInput): Promise<OfferRow> {
  const now = Date.now();
  const r = await pool.query<OfferRow>(
    `INSERT INTO consultation_offers
       (id, user_id, display_name, headline, bio, provider_type, specialties, languages, rate_inr, contact_email, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $11)
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = $3, headline = $4, bio = $5, provider_type = $6, specialties = $7,
       languages = $8, rate_inr = $9, contact_email = $10, updated_at = $11
     RETURNING *`,
    [
      randomUUID(), userId, input.displayName, input.headline, input.bio,
      input.providerType ?? "astrologer",
      input.specialties ?? null, input.languages ?? null, input.rateInr ?? null,
      input.contactEmail ?? null, now,
    ],
  );
  return r.rows[0];
}

/** All offers (admin view), newest first. */
export async function listAllOffers(): Promise<(OfferRow & { owner_email: string | null })[]> {
  const r = await pool.query<OfferRow & { owner_email: string | null }>(
    `SELECT o.*, u.email AS owner_email
       FROM consultation_offers o JOIN users u ON u.id = o.user_id
      ORDER BY (o.status = 'pending') DESC, o.updated_at DESC`,
  );
  return r.rows;
}

/** Admin: set an offer's moderation status. */
export async function setOfferStatus(id: string, status: string): Promise<OfferRow | undefined> {
  const r = await pool.query<OfferRow>(
    "UPDATE consultation_offers SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *",
    [status, Date.now(), id],
  );
  return r.rows[0];
}

export interface BookingInput {
  topic: string;
  preferredTime?: string | null;
  message?: string | null;
  contactEmail?: string | null;
}

export async function createBooking(
  seekerId: string,
  offerId: string,
  input: BookingInput,
): Promise<BookingRow> {
  const r = await pool.query<BookingRow>(
    `INSERT INTO consultation_bookings
       (id, seeker_id, offer_id, topic, preferred_time, message, contact_email, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8) RETURNING *`,
    [
      randomUUID(), seekerId, offerId, input.topic,
      input.preferredTime ?? null, input.message ?? null, input.contactEmail ?? null, Date.now(),
    ],
  );
  return r.rows[0];
}

/** Bookings the user has requested, with the provider's display name. */
export async function listMyBookings(
  seekerId: string,
): Promise<(BookingRow & { provider_name: string })[]> {
  const r = await pool.query<BookingRow & { provider_name: string }>(
    `SELECT b.*, o.display_name AS provider_name
       FROM consultation_bookings b
       JOIN consultation_offers o ON o.id = b.offer_id
      WHERE b.seeker_id = $1
      ORDER BY b.created_at DESC`,
    [seekerId],
  );
  return r.rows;
}

/** Incoming booking requests for the provider's own offer. */
export async function listRequestsForProvider(
  userId: string,
): Promise<(BookingRow & { seeker_name: string | null })[]> {
  const r = await pool.query<BookingRow & { seeker_name: string | null }>(
    `SELECT b.*, u.name AS seeker_name
       FROM consultation_bookings b
       JOIN consultation_offers o ON o.id = b.offer_id
       JOIN users u ON u.id = b.seeker_id
      WHERE o.user_id = $1
      ORDER BY b.created_at DESC`,
    [userId],
  );
  return r.rows;
}

/** Provider updates the status of a booking on their own offer. */
export async function updateBookingStatus(
  providerUserId: string,
  bookingId: string,
  status: string,
): Promise<BookingRow | undefined> {
  const r = await pool.query<BookingRow>(
    `UPDATE consultation_bookings b SET status = $1
       FROM consultation_offers o
      WHERE b.id = $2 AND b.offer_id = o.id AND o.user_id = $3
      RETURNING b.*`,
    [status, bookingId, providerUserId],
  );
  return r.rows[0];
}

// ---------- Admin: user management ----------

export async function listAllUsers(): Promise<UserRow[]> {
  const r = await pool.query<UserRow>("SELECT * FROM users ORDER BY created_at DESC");
  return r.rows;
}

/** Admin-enriched: returns every user with their active chart count. */
export async function listAllUsersWithStats(): Promise<(UserRow & { active_charts: number })[]> {
  const r = await pool.query<UserRow & { active_charts: string }>(
    `SELECT u.*, COUNT(c.id)::text AS active_charts
     FROM users u LEFT JOIN charts c ON c.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
  );
  return r.rows.map((row) => ({ ...row, active_charts: Number(row.active_charts) }));
}

/** Map user IDs to names (for resolving truncated IDs). */
export async function resolveUserNames(userIds: string[]): Promise<Record<string, string>> {
  if (userIds.length === 0) return {};
  const r = await pool.query<{ id: string; name: string | null; email: string | null }>(
    "SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])",
    [userIds],
  );
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.id] = row.name ?? row.email ?? row.id.slice(0, 8);
  return out;
}

export async function countUsers(): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
  return Number(r.rows[0]?.n ?? 0);
}

/** Count users grouped by plan. */
export async function countUsersByPlan(): Promise<Record<string, number>> {
  const r = await pool.query<{ plan: string; n: string }>(
    "SELECT COALESCE(plan, 'free') AS plan, COUNT(*)::text AS n FROM users GROUP BY plan",
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.plan] = Number(row.n);
  return out;
}

/** Total charts across all users + average per user. */
export async function chartStats(): Promise<{ totalCharts: number; totalLifetime: number }> {
  const r = await pool.query<{ tc: string; tl: string }>(
    "SELECT COUNT(*)::text AS tc, COALESCE(SUM(u.total_charts_created), 0)::text AS tl FROM charts c RIGHT JOIN users u ON u.id = c.user_id",
  );
  return {
    totalCharts: Number(r.rows[0]?.tc ?? 0),
    totalLifetime: Number(r.rows[0]?.tl ?? 0),
  };
}

/** Number of users who signed up in the last N days. */
export async function recentSignups(days: number): Promise<number> {
  const since = Date.now() - days * 86_400_000;
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM users WHERE created_at >= $1",
    [since],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Count of active (non-archived/non-deleted) charts per plan. */
export async function chartsPerPlan(): Promise<Record<string, number>> {
  const r = await pool.query<{ plan: string; n: string }>(
    `SELECT COALESCE(u.plan, 'free') AS plan, COUNT(c.id)::text AS n
     FROM users u LEFT JOIN charts c ON c.user_id = u.id
     GROUP BY u.plan`,
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.plan] = Number(row.n);
  return out;
}

/** Admin-created user (email/password). Throws on duplicate email. */
export async function createUserWithRole(input: {
  email: string;
  name: string;
  passwordHash: string;
  plan: string;
  role: string;
}): Promise<UserRow> {
  const id = randomUUID();
  const r = await pool.query<UserRow>(
    `INSERT INTO users (id, provider, provider_id, name, email, password_hash, plan, role, created_at)
     VALUES ($1, 'password', $2, $3, $2, $4, $5, $6, $7)
     RETURNING *`,
    [id, input.email.toLowerCase(), input.name, input.passwordHash, input.plan, input.role, Date.now()],
  );
  return r.rows[0];
}

export async function setUserRole(id: string, role: string): Promise<void> {
  await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
}

export async function setUserSuspended(id: string, suspended: boolean): Promise<void> {
  await pool.query("UPDATE users SET suspended = $1 WHERE id = $2", [suspended, id]);
}

/**
 * Seed / repair the super-admin from env at startup. Creates the password user
 * if missing (with role admin), otherwise just ensures the role is admin. The
 * password is only set on creation, so restarts never clobber a rotated one.
 */
export async function ensureAdminUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<void> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    if (existing.role !== "admin") await setUserRole(existing.id, "admin");
    return;
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, provider, provider_id, name, email, password_hash, plan, role, created_at)
     VALUES ($1, 'password', $2, $3, $2, $4, 'premium', 'admin', $5)`,
    [id, input.email.toLowerCase(), input.name, input.passwordHash, Date.now()],
  );
}

// ---------- Admin: global settings ----------

export async function getGlobalSetting(key: string): Promise<Record<string, unknown>> {
  const r = await pool.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM global_settings WHERE key = $1",
    [key],
  );
  return r.rows[0]?.data ?? {};
}

export async function setGlobalSetting(key: string, data: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO global_settings (key, data, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = $3`,
    [key, JSON.stringify(data), Date.now()],
  );
}

// ---------- Notifications ----------

export interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  level: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationInput {
  title: string;
  body: string;
  level?: string;
}

export async function createNotification(userId: string, n: NotificationInput): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (id, user_id, title, body, level, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, n.title, n.body, n.level ?? "info", Date.now()],
  );
}

/** Fan a notification out to every user (or a given subset). Returns the count. */
export async function createNotificationForUsers(
  userIds: string[],
  n: NotificationInput,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const now = Date.now();
  const values: string[] = [];
  const params: unknown[] = [];
  userIds.forEach((uid, i) => {
    const b = i * 6;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
    params.push(randomUUID(), uid, n.title, n.body, n.level ?? "info", now);
  });
  await pool.query(
    `INSERT INTO notifications (id, user_id, title, body, level, created_at) VALUES ${values.join(", ")}`,
    params,
  );
  return userIds.length;
}

export async function allUserIds(): Promise<string[]> {
  const r = await pool.query<{ id: string }>("SELECT id FROM users");
  return r.rows.map((x) => x.id);
}

export async function listNotifications(userId: string, limit = 30): Promise<NotificationRow[]> {
  const r = await pool.query<NotificationRow>(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return r.rows;
}

export async function countUnread(userId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await pool.query(
    "UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3 AND read_at IS NULL",
    [Date.now(), id, userId],
  );
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await pool.query(
    "UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL",
    [Date.now(), userId],
  );
}

// ─── Vastu settings (one per chart / profile) ──────────────────────────

export interface VastuRow {
  chart_id: string;
  questionnaire: unknown; // JSONB
  floor_plan: string | null;
  updated_at: number;
}

/** Get the Vastu settings for a specific chart (profile). */
export async function getVastuSettings(chartId: string): Promise<VastuRow | null> {
  const { rows } = await pool.query<VastuRow>(
    "SELECT chart_id, questionnaire, floor_plan, updated_at::bigint AS updated_at FROM vastu_settings WHERE chart_id = $1",
    [chartId],
  );
  return rows[0] ?? null;
}

/** Upsert Vastu settings — insert or replace (one per chart). */
export async function upsertVastuSettings(chartId: string, questionnaire: unknown, floorPlan?: string | null): Promise<VastuRow> {
  const now = Date.now();
  const { rows } = await pool.query<VastuRow>(
    `INSERT INTO vastu_settings (chart_id, questionnaire, floor_plan, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chart_id) DO UPDATE SET questionnaire = $2, floor_plan = $3, updated_at = $4
     RETURNING chart_id, questionnaire, floor_plan, updated_at::bigint AS updated_at`,
    [chartId, JSON.stringify(questionnaire), floorPlan ?? null, now],
  );
  return rows[0];
}

/** Delete Vastu settings for a chart. */
export async function deleteVastuSettings(chartId: string): Promise<void> {
  await pool.query("DELETE FROM vastu_settings WHERE chart_id = $1", [chartId]);
}

// ─── Temple affiliation ─────────────────────────────────────────────────

export interface TempleRow {
  id: string; user_id: string | null; email: string | null; password_hash: string | null;
  name: string; deity: string; location: string;
  description: string; contact_email: string | null; contact_phone: string | null;
  website: string | null; image_url: string | null; status: string;
  created_at: number; updated_at: number;
}
export interface TempleServiceRow {
  id: string; temple_id: string; name: string; description: string;
  deity: string | null; duration: string | null; price_inr: number | null;
  available: boolean; created_at: number;
}
export interface TempleEventRow {
  id: string; temple_id: string; title: string; description: string;
  event_date: string; event_time: string | null; recurring: string; created_at: number;
}

// ── Temples ──

export async function listApprovedTemples(): Promise<TempleRow[]> {
  const { rows } = await pool.query<TempleRow>(
    "SELECT *, created_at::bigint AS created_at, updated_at::bigint AS updated_at FROM temples WHERE status = 'approved' ORDER BY name",
  );
  return rows;
}

export async function listAllTemples(): Promise<TempleRow[]> {
  const { rows } = await pool.query<TempleRow>(
    "SELECT *, created_at::bigint AS created_at, updated_at::bigint AS updated_at FROM temples ORDER BY created_at DESC",
  );
  return rows;
}

export async function getTemple(id: string): Promise<TempleRow | null> {
  const { rows } = await pool.query<TempleRow>(
    "SELECT *, created_at::bigint AS created_at, updated_at::bigint AS updated_at FROM temples WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function getTempleByUser(userId: string): Promise<TempleRow | null> {
  const { rows } = await pool.query<TempleRow>(
    "SELECT *, created_at::bigint AS created_at, updated_at::bigint AS updated_at FROM temples WHERE user_id = $1",
    [userId],
  );
  return rows[0] ?? null;
}

/** Look up a temple by its login email (for the temple auth realm). */
export async function getTempleByEmail(email: string): Promise<TempleRow | null> {
  const { rows } = await pool.query<TempleRow>(
    "SELECT *, created_at::bigint AS created_at, updated_at::bigint AS updated_at FROM temples WHERE lower(email) = lower($1)",
    [email],
  );
  return rows[0] ?? null;
}

/**
 * Register a self-owned temple account with its own credentials (no astrology
 * user). Enters as 'pending' until an admin approves it.
 */
export async function createTempleAccount(data: {
  email: string; passwordHash: string;
  name: string; deity: string; location: string; description: string;
  contactEmail?: string; contactPhone?: string; website?: string; imageUrl?: string;
}): Promise<TempleRow> {
  const id = randomUUID();
  const now = Date.now();
  const { rows } = await pool.query<TempleRow>(
    `INSERT INTO temples (id, email, password_hash, name, deity, location, description, contact_email, contact_phone, website, image_url, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$12)
     RETURNING *, created_at::bigint AS created_at, updated_at::bigint AS updated_at`,
    [id, data.email.toLowerCase(), data.passwordHash, data.name, data.deity, data.location, data.description,
     data.contactEmail ?? null, data.contactPhone ?? null, data.website ?? null, data.imageUrl ?? null, now],
  );
  return rows[0];
}

export async function updateTemple(id: string, data: Partial<{
  name: string; deity: string; location: string; description: string;
  contactEmail: string; contactPhone: string; website: string; imageUrl: string; status: string;
}>): Promise<TempleRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
  if (data.deity !== undefined) { sets.push(`deity = $${i++}`); vals.push(data.deity); }
  if (data.location !== undefined) { sets.push(`location = $${i++}`); vals.push(data.location); }
  if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
  if (data.contactEmail !== undefined) { sets.push(`contact_email = $${i++}`); vals.push(data.contactEmail); }
  if (data.contactPhone !== undefined) { sets.push(`contact_phone = $${i++}`); vals.push(data.contactPhone); }
  if (data.website !== undefined) { sets.push(`website = $${i++}`); vals.push(data.website); }
  if (data.imageUrl !== undefined) { sets.push(`image_url = $${i++}`); vals.push(data.imageUrl); }
  if (data.status !== undefined) { sets.push(`status = $${i++}`); vals.push(data.status); }
  if (sets.length === 0) return getTemple(id);
  sets.push(`updated_at = $${i++}`);
  vals.push(Date.now());
  vals.push(id);
  const { rows } = await pool.query<TempleRow>(
    `UPDATE temples SET ${sets.join(", ")} WHERE id = $${i} RETURNING *, created_at::bigint AS created_at, updated_at::bigint AS updated_at`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteTemple(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM temples WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// ── Temple services ──

export async function listTempleServices(templeId: string): Promise<TempleServiceRow[]> {
  const { rows } = await pool.query<TempleServiceRow>(
    "SELECT *, created_at::bigint AS created_at FROM temple_services WHERE temple_id = $1 ORDER BY name",
    [templeId],
  );
  return rows;
}

export async function createTempleService(templeId: string, data: {
  name: string; description: string; deity?: string; duration?: string; priceInr?: number;
}): Promise<TempleServiceRow> {
  const id = randomUUID();
  const { rows } = await pool.query<TempleServiceRow>(
    `INSERT INTO temple_services (id, temple_id, name, description, deity, duration, price_inr, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *, created_at::bigint AS created_at`,
    [id, templeId, data.name, data.description, data.deity ?? null, data.duration ?? null, data.priceInr ?? null, Date.now()],
  );
  return rows[0];
}

export async function updateTempleService(id: string, data: Partial<{
  name: string; description: string; deity: string; duration: string; priceInr: number; available: boolean;
}>): Promise<TempleServiceRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
  if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
  if (data.deity !== undefined) { sets.push(`deity = $${i++}`); vals.push(data.deity); }
  if (data.duration !== undefined) { sets.push(`duration = $${i++}`); vals.push(data.duration); }
  if (data.priceInr !== undefined) { sets.push(`price_inr = $${i++}`); vals.push(data.priceInr); }
  if (data.available !== undefined) { sets.push(`available = $${i++}`); vals.push(data.available); }
  if (sets.length === 0) return null;
  vals.push(id);
  const { rows } = await pool.query<TempleServiceRow>(
    `UPDATE temple_services SET ${sets.join(", ")} WHERE id = $${i} RETURNING *, created_at::bigint AS created_at`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteTempleService(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM temple_services WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// ── Temple events ──

export async function listTempleEvents(templeId: string): Promise<TempleEventRow[]> {
  const { rows } = await pool.query<TempleEventRow>(
    "SELECT *, created_at::bigint AS created_at FROM temple_events WHERE temple_id = $1 ORDER BY event_date",
    [templeId],
  );
  return rows;
}

export async function createTempleEvent(templeId: string, data: {
  title: string; description: string; eventDate: string; eventTime?: string; recurring?: string;
}): Promise<TempleEventRow> {
  const id = randomUUID();
  const { rows } = await pool.query<TempleEventRow>(
    `INSERT INTO temple_events (id, temple_id, title, description, event_date, event_time, recurring, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *, created_at::bigint AS created_at`,
    [id, templeId, data.title, data.description, data.eventDate, data.eventTime ?? null, data.recurring ?? "none", Date.now()],
  );
  return rows[0];
}

export async function updateTempleEvent(id: string, data: Partial<{
  title: string; description: string; eventDate: string; eventTime: string; recurring: string;
}>): Promise<TempleEventRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.title !== undefined) { sets.push(`title = $${i++}`); vals.push(data.title); }
  if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
  if (data.eventDate !== undefined) { sets.push(`event_date = $${i++}`); vals.push(data.eventDate); }
  if (data.eventTime !== undefined) { sets.push(`event_time = $${i++}`); vals.push(data.eventTime); }
  if (data.recurring !== undefined) { sets.push(`recurring = $${i++}`); vals.push(data.recurring); }
  if (sets.length === 0) return null;
  vals.push(id);
  const { rows } = await pool.query<TempleEventRow>(
    `UPDATE temple_events SET ${sets.join(", ")} WHERE id = $${i} RETURNING *, created_at::bigint AS created_at`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteTempleEvent(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM temple_events WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// ─── Reminders + festivals ──────────────────────────────────────────────

export interface ReminderRow {
  id: string; user_id: string; title: string; notes: string;
  event_date: string; recurrence: string; lead_days: number; enabled: boolean;
  last_notified: string | null; created_at: string; updated_at: string;
}
export interface FestivalRow {
  id: string; name: string; description: string; event_date: string;
  recurring: boolean; created_at: string; updated_at: string;
}

export async function listReminders(userId: string): Promise<ReminderRow[]> {
  const { rows } = await pool.query<ReminderRow>(
    "SELECT * FROM reminders WHERE user_id = $1 ORDER BY event_date",
    [userId],
  );
  return rows;
}

export async function createReminder(userId: string, d: {
  title: string; notes: string; eventDate: string; recurrence: string; leadDays: number; enabled: boolean;
}): Promise<ReminderRow> {
  const now = Date.now();
  const { rows } = await pool.query<ReminderRow>(
    `INSERT INTO reminders (id, user_id, title, notes, event_date, recurrence, lead_days, enabled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [randomUUID(), userId, d.title, d.notes, d.eventDate, d.recurrence, d.leadDays, d.enabled, now],
  );
  return rows[0];
}

export async function updateReminder(userId: string, id: string, d: Partial<{
  title: string; notes: string; eventDate: string; recurrence: string; leadDays: number; enabled: boolean;
}>): Promise<ReminderRow | null> {
  const existing = await pool.query<ReminderRow>("SELECT * FROM reminders WHERE id = $1 AND user_id = $2", [id, userId]);
  const cur = existing.rows[0];
  if (!cur) return null;
  const { rows } = await pool.query<ReminderRow>(
    `UPDATE reminders SET title=$1, notes=$2, event_date=$3, recurrence=$4, lead_days=$5, enabled=$6, updated_at=$7
     WHERE id=$8 AND user_id=$9 RETURNING *`,
    [
      d.title ?? cur.title, d.notes ?? cur.notes, d.eventDate ?? cur.event_date,
      d.recurrence ?? cur.recurrence, d.leadDays ?? cur.lead_days,
      d.enabled ?? cur.enabled, Date.now(), id, userId,
    ],
  );
  return rows[0];
}

export async function deleteReminder(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM reminders WHERE id = $1 AND user_id = $2", [id, userId]);
  return (rowCount ?? 0) > 0;
}

export async function markReminderNotified(id: string, occurrence: string): Promise<void> {
  await pool.query("UPDATE reminders SET last_notified = $1 WHERE id = $2", [occurrence, id]);
}

/** All enabled reminders with the owner's email/name, for the scheduler. */
export async function listEnabledRemindersWithUser(): Promise<
  (ReminderRow & { email: string | null; name: string | null })[]
> {
  const { rows } = await pool.query<ReminderRow & { email: string | null; name: string | null }>(
    `SELECT r.*, u.email, u.name FROM reminders r JOIN users u ON u.id = r.user_id
      WHERE r.enabled = true AND NOT u.suspended`,
  );
  return rows;
}

// Festivals (admin)
export async function listFestivals(): Promise<FestivalRow[]> {
  const { rows } = await pool.query<FestivalRow>("SELECT * FROM festivals ORDER BY event_date");
  return rows;
}
export async function createFestival(d: { name: string; description: string; eventDate: string; recurring: boolean }): Promise<FestivalRow> {
  const now = Date.now();
  const { rows } = await pool.query<FestivalRow>(
    `INSERT INTO festivals (id, name, description, event_date, recurring, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [randomUUID(), d.name, d.description, d.eventDate, d.recurring, now],
  );
  return rows[0];
}
export async function updateFestival(id: string, d: Partial<{ name: string; description: string; eventDate: string; recurring: boolean }>): Promise<FestivalRow | null> {
  const cur = (await pool.query<FestivalRow>("SELECT * FROM festivals WHERE id=$1", [id])).rows[0];
  if (!cur) return null;
  const { rows } = await pool.query<FestivalRow>(
    `UPDATE festivals SET name=$1, description=$2, event_date=$3, recurring=$4, updated_at=$5 WHERE id=$6 RETURNING *`,
    [d.name ?? cur.name, d.description ?? cur.description, d.eventDate ?? cur.event_date, d.recurring ?? cur.recurring, Date.now(), id],
  );
  return rows[0];
}
export async function deleteFestival(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM festivals WHERE id=$1", [id]);
  return (rowCount ?? 0) > 0;
}

// Festival subscriptions
export interface FestivalSubRow {
  id: string; user_id: string; festival_id: string; lead_days: number; last_notified: string | null; created_at: string;
}
export async function getSubscription(userId: string, festivalId: string): Promise<FestivalSubRow | null> {
  const { rows } = await pool.query<FestivalSubRow>(
    "SELECT * FROM festival_subscriptions WHERE user_id=$1 AND festival_id=$2", [userId, festivalId]);
  return rows[0] ?? null;
}
export async function listSubscriptions(userId: string): Promise<FestivalSubRow[]> {
  const { rows } = await pool.query<FestivalSubRow>("SELECT * FROM festival_subscriptions WHERE user_id=$1", [userId]);
  return rows;
}
export async function subscribeFestival(userId: string, festivalId: string, leadDays: number): Promise<void> {
  await pool.query(
    `INSERT INTO festival_subscriptions (id, user_id, festival_id, lead_days, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, festival_id) DO UPDATE SET lead_days = $4`,
    [randomUUID(), userId, festivalId, leadDays, Date.now()],
  );
}
export async function unsubscribeFestival(userId: string, festivalId: string): Promise<void> {
  await pool.query("DELETE FROM festival_subscriptions WHERE user_id=$1 AND festival_id=$2", [userId, festivalId]);
}
export async function markSubscriptionNotified(id: string, occurrence: string): Promise<void> {
  await pool.query("UPDATE festival_subscriptions SET last_notified=$1 WHERE id=$2", [occurrence, id]);
}
/** All festival subscriptions joined with festival + user, for the scheduler. */
export async function listSubscriptionsForScheduler(): Promise<
  (FestivalSubRow & { name: string; description: string; event_date: string; recurring: boolean; email: string | null; user_name: string | null })[]
> {
  const { rows } = await pool.query(
    `SELECT s.*, f.name, f.description, f.event_date, f.recurring, u.email, u.name AS user_name
       FROM festival_subscriptions s
       JOIN festivals f ON f.id = s.festival_id
       JOIN users u ON u.id = s.user_id
      WHERE NOT u.suspended`,
  );
  return rows as (FestivalSubRow & { name: string; description: string; event_date: string; recurring: boolean; email: string | null; user_name: string | null })[];
}

// ─── Promo codes ────────────────────────────────────────────────────────

export interface PromoCodeRow {
  id: string; code: string; plan: string; expires_at: string | null;
  max_redemptions: number | null; duration_days: number;
  enabled: boolean; created_at: string; updated_at: string;
}

export async function listPromoCodes(): Promise<(PromoCodeRow & { redemptions: number })[]> {
  const { rows } = await pool.query<PromoCodeRow & { redemptions: number }>(
    `SELECT p.*, COUNT(r.id)::int AS redemptions
       FROM promo_codes p LEFT JOIN promo_redemptions r ON r.promo_id = p.id
      GROUP BY p.id ORDER BY p.created_at DESC`,
  );
  return rows;
}

export async function getPromoByCode(code: string): Promise<PromoCodeRow | null> {
  const { rows } = await pool.query<PromoCodeRow>(
    "SELECT * FROM promo_codes WHERE upper(code) = upper($1)", [code],
  );
  return rows[0] ?? null;
}

export async function createPromoCode(d: {
  code: string; plan: string; expiresAt: number | null;
  maxRedemptions: number | null; durationDays: number; enabled: boolean;
}): Promise<PromoCodeRow> {
  const now = Date.now();
  const { rows } = await pool.query<PromoCodeRow>(
    `INSERT INTO promo_codes (id, code, plan, expires_at, max_redemptions, duration_days, enabled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [randomUUID(), d.code, d.plan, d.expiresAt, d.maxRedemptions, d.durationDays, d.enabled, now],
  );
  return rows[0];
}

export async function updatePromoCode(id: string, d: Partial<{
  plan: string; expiresAt: number | null; maxRedemptions: number | null; durationDays: number; enabled: boolean;
}>): Promise<PromoCodeRow | null> {
  const cur = (await pool.query<PromoCodeRow>("SELECT * FROM promo_codes WHERE id=$1", [id])).rows[0];
  if (!cur) return null;
  const { rows } = await pool.query<PromoCodeRow>(
    `UPDATE promo_codes SET plan=$1, expires_at=$2, max_redemptions=$3, duration_days=$4, enabled=$5, updated_at=$6
     WHERE id=$7 RETURNING *`,
    [
      d.plan ?? cur.plan,
      d.expiresAt !== undefined ? d.expiresAt : (cur.expires_at ? Number(cur.expires_at) : null),
      d.maxRedemptions !== undefined ? d.maxRedemptions : cur.max_redemptions,
      d.durationDays ?? cur.duration_days,
      d.enabled ?? cur.enabled, Date.now(), id,
    ],
  );
  return rows[0];
}

export async function deletePromoCode(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM promo_codes WHERE id=$1", [id]);
  return (rowCount ?? 0) > 0;
}

export async function getPromoRedemption(promoId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2", [promoId, userId]);
  return rows.length > 0;
}

export async function countPromoRedemptions(promoId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM promo_redemptions WHERE promo_id=$1", [promoId]);
  return Number(rows[0]?.n ?? 0);
}

export async function recordPromoRedemption(promoId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO promo_redemptions (id, promo_id, user_id, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (promo_id, user_id) DO NOTHING`,
    [randomUUID(), promoId, userId, Date.now()],
  );
}

/** Set a temporary (promo) plan that reverts to 'free' at expiresAt. */
export async function setUserPlanWithExpiry(userId: string, plan: string, expiresAt: number): Promise<void> {
  await pool.query(
    "UPDATE users SET plan=$1, plan_expires_at=$2, plan_source='promo' WHERE id=$3",
    [plan, expiresAt, userId],
  );
}

/** Users whose promo grant has lapsed and should drop back to the free plan. */
export async function listExpiredPromoUsers(): Promise<{ id: string; email: string | null; name: string | null; plan: string }[]> {
  const { rows } = await pool.query<{ id: string; email: string | null; name: string | null; plan: string }>(
    "SELECT id, email, name, plan FROM users WHERE plan_expires_at IS NOT NULL AND plan_expires_at < $1 AND plan <> 'free'",
    [Date.now()],
  );
  return rows;
}

/** Revert a user to the free (Basic) plan and clear the promo expiry/source. */
export async function downgradeToFree(userId: string): Promise<void> {
  await pool.query("UPDATE users SET plan='free', plan_expires_at=NULL, plan_source=NULL WHERE id=$1", [userId]);
}

/**
 * Downgrade to free due to a chargeback and mark the source 'disputed', so the
 * Stripe reconcile-on-load won't restore the plan while the dispute is open.
 */
export async function markPlanDisputed(userId: string): Promise<void> {
  await pool.query("UPDATE users SET plan='free', plan_expires_at=NULL, plan_source='disputed' WHERE id=$1", [userId]);
}

/** Active admin user ids (for admin-facing in-app notifications). */
export async function listAdminIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE role='admin' AND NOT suspended");
  return rows.map((r) => r.id);
}

// ─── Contact-us messages ────────────────────────────────────────────────

export interface ContactMessageRow {
  id: string; user_id: string | null; name: string; email: string | null;
  category: string; message: string; status: string; created_at: string;
}

export async function createContactMessage(d: {
  userId: string | null; name: string; email: string | null; category: string; message: string;
}): Promise<ContactMessageRow> {
  const { rows } = await pool.query<ContactMessageRow>(
    `INSERT INTO contact_messages (id, user_id, name, email, category, message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), d.userId, d.name, d.email, d.category, d.message, Date.now()],
  );
  return rows[0];
}

/** All messages (admin), newest first, with the signed-in sender's email if any. */
export async function listContactMessages(): Promise<(ContactMessageRow & { account_email: string | null })[]> {
  const { rows } = await pool.query<ContactMessageRow & { account_email: string | null }>(
    `SELECT c.*, u.email AS account_email
       FROM contact_messages c LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.created_at DESC`,
  );
  return rows;
}

export async function setContactStatus(id: string, status: string): Promise<ContactMessageRow | null> {
  const { rows } = await pool.query<ContactMessageRow>(
    "UPDATE contact_messages SET status=$1 WHERE id=$2 RETURNING *", [status, id]);
  return rows[0] ?? null;
}

export async function countNewContactMessages(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM contact_messages WHERE status='new'");
  return Number(rows[0]?.n ?? 0);
}

export interface BillingEventRow {
  id: string; user_id: string | null; kind: string; detail: string;
  amount: string | null; currency: string | null; action: string; created_at: string;
}

/** Record a refund/dispute event for the admin audit trail. */
export async function recordBillingEvent(d: {
  userId: string | null; kind: string; detail?: string;
  amount?: number | null; currency?: string | null; action?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO billing_events (id, user_id, kind, detail, amount, currency, action, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), d.userId, d.kind, d.detail ?? "", d.amount ?? null,
     d.currency ?? null, d.action ?? "", Date.now()],
  );
}

/** Billing events (admin), newest first, with the associated account email if any. */
export async function listBillingEvents(limit = 100): Promise<(BillingEventRow & { account_email: string | null })[]> {
  const { rows } = await pool.query<BillingEventRow & { account_email: string | null }>(
    `SELECT b.*, u.email AS account_email
       FROM billing_events b LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// ── Feature feedback ─────────────────────────────────────────────────────

export interface FeedbackRow {
  id: string; user_id: string | null; feature: string;
  rating: string; comment: string; status: string; created_at: string;
}

export async function createFeedback(d: {
  userId: string | null; feature: string; rating: string; comment: string;
}): Promise<FeedbackRow> {
  const { rows } = await pool.query<FeedbackRow>(
    `INSERT INTO feedback (id, user_id, feature, rating, comment, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [randomUUID(), d.userId, d.feature, d.rating, d.comment, Date.now()],
  );
  return rows[0];
}

/** Feedback entries (admin), newest first, with the submitter's email if any. */
export async function listFeedback(limit = 300): Promise<(FeedbackRow & { account_email: string | null })[]> {
  const { rows } = await pool.query<FeedbackRow & { account_email: string | null }>(
    `SELECT f.*, u.email AS account_email
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Per-feature tallies so the admin console can rank what needs attention. */
export interface FeedbackSummaryRow {
  feature: string;
  total: number;
  up: number;
  down: number;
  comments: number;
}

export async function feedbackSummary(): Promise<FeedbackSummaryRow[]> {
  const { rows } = await pool.query<Record<keyof FeedbackSummaryRow, string>>(
    `SELECT feature,
            COUNT(*)::text                               AS total,
            COUNT(*) FILTER (WHERE rating = 'up')::text   AS up,
            COUNT(*) FILTER (WHERE rating = 'down')::text AS down,
            COUNT(*) FILTER (WHERE comment <> '')::text   AS comments
       FROM feedback
      GROUP BY feature
      ORDER BY COUNT(*) DESC`,
  );
  return rows.map((r) => ({
    feature: r.feature,
    total: Number(r.total),
    up: Number(r.up),
    down: Number(r.down),
    comments: Number(r.comments),
  }));
}

/** Returns the updated row with the submitter's email, so the admin list can
 *  swap it in place without losing the column it renders. */
export async function setFeedbackStatus(
  id: string,
  status: string,
): Promise<(FeedbackRow & { account_email: string | null }) | null> {
  const { rows } = await pool.query<FeedbackRow & { account_email: string | null }>(
    `UPDATE feedback f SET status=$1 WHERE f.id=$2
     RETURNING f.*, (SELECT email FROM users u WHERE u.id = f.user_id) AS account_email`,
    [status, id],
  );
  return rows[0] ?? null;
}

export async function countNewFeedback(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM feedback WHERE status='new'");
  return Number(rows[0]?.n ?? 0);
}

// ── Astro Chat conversations (Phase 2) ───────────────────────────────────

export interface ChatConversationRow {
  id: string; user_id: string; chart_id: string | null;
  title: string; created_at: string; updated_at: string;
}
export interface ChatMessageRow {
  id: string; conversation_id: string; role: string; content: string; created_at: string;
}

export async function createChatConversation(
  userId: string, title: string, chartId: string | null,
): Promise<ChatConversationRow> {
  const now = Date.now();
  const { rows } = await pool.query<ChatConversationRow>(
    `INSERT INTO chat_conversations (id, user_id, chart_id, title, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [randomUUID(), userId, chartId, title.slice(0, 120) || "New chat", now],
  );
  return rows[0];
}

/** Conversations for a user, newest-updated first, with a message count. */
export async function listChatConversations(
  userId: string,
): Promise<(ChatConversationRow & { message_count: number })[]> {
  const { rows } = await pool.query<ChatConversationRow & { message_count: string }>(
    `SELECT c.*, COUNT(m.id) AS message_count
       FROM chat_conversations c
       LEFT JOIN chat_messages m ON m.conversation_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, message_count: Number(r.message_count) }));
}

/** A conversation the user owns, or null. */
export async function getChatConversation(
  userId: string, id: string,
): Promise<ChatConversationRow | null> {
  const { rows } = await pool.query<ChatConversationRow>(
    "SELECT * FROM chat_conversations WHERE id = $1 AND user_id = $2", [id, userId]);
  return rows[0] ?? null;
}

export async function listChatMessages(conversationId: string): Promise<ChatMessageRow[]> {
  const { rows } = await pool.query<ChatMessageRow>(
    "SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [conversationId],
  );
  return rows;
}

export async function addChatMessage(
  conversationId: string, role: string, content: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (id, conversation_id, role, content, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), conversationId, role, content, Date.now()],
  );
  await pool.query("UPDATE chat_conversations SET updated_at = $1 WHERE id = $2",
    [Date.now(), conversationId]);
}

/** Delete a conversation the user owns (messages cascade). Returns true if removed. */
export async function deleteChatConversation(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2", [id, userId]);
  return (rowCount ?? 0) > 0;
}

// ── Per-profile notes ────────────────────────────────────────────────────

export interface NoteRow {
  id: string; user_id: string; chart_id: string;
  title: string; body: string; created_at: string; updated_at: string;
}

/** Notes for one profile the user owns, newest-updated first. */
export async function listNotes(userId: string, chartId: string): Promise<NoteRow[]> {
  const { rows } = await pool.query<NoteRow>(
    "SELECT * FROM notes WHERE user_id = $1 AND chart_id = $2 ORDER BY updated_at DESC",
    [userId, chartId],
  );
  return rows;
}

export async function createNote(
  userId: string, chartId: string, title: string, body: string,
): Promise<NoteRow> {
  const now = Date.now();
  const { rows } = await pool.query<NoteRow>(
    `INSERT INTO notes (id, user_id, chart_id, title, body, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [randomUUID(), userId, chartId, title, body, now],
  );
  return rows[0];
}

/** Update a note the user owns. Returns the row, or null if not found/owned. */
export async function updateNote(
  userId: string, id: string, fields: { title: string; body: string },
): Promise<NoteRow | null> {
  const { rows } = await pool.query<NoteRow>(
    `UPDATE notes SET title = $1, body = $2, updated_at = $3
       WHERE id = $4 AND user_id = $5 RETURNING *`,
    [fields.title, fields.body, Date.now(), id, userId],
  );
  return rows[0] ?? null;
}

export async function deleteNote(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM notes WHERE id = $1 AND user_id = $2", [id, userId]);
  return (rowCount ?? 0) > 0;
}
