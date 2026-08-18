import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { config, providerConfigured, redirectUri, adminConfigured, type Provider } from "./config";
import {
  upsertUser,
  getUser,
  findUserByEmail,
  createPasswordUser,
  ensureAdminUser,
  createVerificationToken,
  verifyEmailToken,
  isEmailVerified,
  markEmailVerified,
  type UserRow,
} from "./db";
import { hashPassword, verifyPassword } from "./password";
import { getFeatures } from "./features";
import { checkRateLimit } from "./rateLimit";

const SESSION_COOKIE = "aistro_session";
const STATE_COOKIE = "aistro_oauth_state";

function setSession(res: Response, userId: string, opts?: { admin?: boolean }): void {
  // `adm` marks an admin-elevated session, obtained only via the admin login
  // (which requires the access code). Regular logins never set it.
  const token = jwt.sign({ uid: userId, adm: opts?.admin ? 1 : 0 }, config.sessionSecret, {
    expiresIn: "30d",
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  });
}

export function currentUserId(req: Request): string | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return (jwt.verify(token, config.sessionSecret) as { uid: string }).uid;
  } catch {
    return null;
  }
}

/** Whether the current session was elevated through the admin login. */
export function isAdminSession(req: Request): boolean {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;
  try {
    return (jwt.verify(token, config.sessionSecret) as { adm?: number }).adm === 1;
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uid = currentUserId(req);
  if (!uid) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  (req as Request & { userId: string }).userId = uid;
  next();
}

/**
 * Gate for the admin module. Requires BOTH an admin-elevated session (access
 * code was supplied at login) AND the user's role to still be 'admin'.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const uid = currentUserId(req);
  if (!uid) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!isAdminSession(req)) {
    res.status(403).json({ error: "Admin sign-in required", needAdminLogin: true });
    return;
  }
  const user = await getUser(uid);
  if (!user || user.role !== "admin" || user.suspended) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  (req as Request & { userId: string }).userId = uid;
  next();
}

/** Seed / repair the super-admin from env. Called once at startup. */
export async function seedAdmin(): Promise<void> {
  if (!adminConfigured()) return;
  await ensureAdminUser({
    email: config.admin.email,
    name: "Administrator",
    passwordHash: hashPassword(config.admin.password),
  });
}

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, premium: 2 };

/** Middleware that requires the user to have at least the specified plan. */
export function requirePlan(...plans: string[]) {
  const minRank = Math.min(...plans.map((p) => PLAN_RANK[p] ?? 0));
  return async (req: Request, res: Response, next: NextFunction) => {
    const uid = (req as Request & { userId: string }).userId;
    if (!uid) { res.status(401).json({ error: "Not signed in" }); return; }
    const { getUserPlan } = await import("./db");
    const userPlan = await getUserPlan(uid);
    if ((PLAN_RANK[userPlan] ?? 0) < minRank) {
      res.status(403).json({ error: `This feature requires a ${plans[0]} plan or higher.`, requiredPlan: plans[0] });
      return;
    }
    next();
  };
}

function publicUser(u: UserRow) {
  return {
    id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url,
    provider: u.provider, plan: u.plan ?? "free", role: u.role ?? "user",
    emailVerified: u.email_verified ?? false,
    planExpiresAt: u.plan_expires_at ? Number(u.plan_expires_at) : null,
  };
}

// --- Provider profile normalisation ---------------------------------------

async function fetchGoogleProfile(accessToken: string) {
  const r = await fetch(config.providers.google.userUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error("Failed to fetch Google profile");
  const p = (await r.json()) as { sub: string; name?: string; email?: string; picture?: string };
  return { providerId: p.sub, name: p.name ?? null, email: p.email ?? null, avatarUrl: p.picture ?? null };
}

async function fetchGithubProfile(accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}`, "User-Agent": "shastri" };
  const r = await fetch(config.providers.github.userUrl, { headers });
  if (!r.ok) throw new Error("Failed to fetch GitHub profile");
  const p = (await r.json()) as { id: number; login: string; name?: string; email?: string; avatar_url?: string };
  let email = p.email ?? null;
  if (!email) {
    const er = await fetch("https://api.github.com/user/emails", { headers });
    if (er.ok) {
      const emails = (await er.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
    }
  }
  return {
    providerId: String(p.id),
    name: p.name ?? p.login,
    email,
    avatarUrl: p.avatar_url ?? null,
  };
}

async function exchangeCode(provider: Provider, code: string): Promise<string> {
  const cfg = config.providers[provider];
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri(provider),
    grant_type: "authorization_code",
  });
  const r = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
  const data = (await r.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(data.error ?? "No access token returned");
  return data.access_token;
}

// --- Routes ----------------------------------------------------------------

export const authRouter = Router();

/** Which providers are usable, so the UI can show only working buttons. */
authRouter.get("/providers", (_req, res) => {
  res.json({
    google: providerConfigured("google"),
    github: providerConfigured("github"),
    devLogin: config.allowDevLogin,
  });
});

authRouter.get("/me", async (req, res) => {
  const uid = currentUserId(req);
  const user = uid ? await getUser(uid) : undefined;
  const features = await getFeatures();
  // A suspended user is signed out on their next load.
  if (user?.suspended) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ user: null, admin: false, features });
    return;
  }
  res.json({
    user: user ? publicUser(user) : null,
    admin: Boolean(user && user.role === "admin" && isAdminSession(req)),
    features,
  });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// --- Email + password (database-driven) auth -------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRouter.post("/register", async (req, res) => {
  // IP-based rate limit: max 3 registrations per hour
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const rl = checkRateLimit(`reg:${ip}`, 3, 60 * 60_000);
  if (!rl.allowed) {
    res.status(429).json({ error: `Too many registrations. Try again in ${Math.ceil(rl.retryAfterMs / 60_000)} minutes.` });
    return;
  }
  try {
    const { email, password, name } = (req.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };
    if (!email || !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "A valid email is required" });
      return;
    }
    // The admin email is reserved and can never be claimed via public signup.
    if (config.admin.email && email.trim().toLowerCase() === config.admin.email) {
      res.status(403).json({ error: "This email address is reserved." });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    if (await findUserByEmail(email)) {
      res.status(409).json({ error: "That email is already registered" });
      return;
    }
    const user = await createPasswordUser({
      email,
      name: name?.trim() || email.split("@")[0],
      passwordHash: hashPassword(password),
    });
    // Generate verification token
    const token = await createVerificationToken(user.id);
    setSession(res, user.id);
    res.status(201).json({
      user: publicUser(user),
      verificationToken: token,
      verificationNote: "Please check your email to verify your account. Until verified, some features are restricted.",
    });
  } catch {
    res.status(500).json({ error: "Registration failed" });
  }
});

// --- Email verification ----------------------------------------------------

authRouter.get("/verify-email", async (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) {
    res.status(400).json({ error: "Verification token is required" });
    return;
  }
  const result = await verifyEmailToken(token);
  if (result.success) {
    // Redirect to app with success message
    res.redirect(`${config.appUrl}?email_verified=true`);
  } else {
    res.redirect(`${config.appUrl}?email_verify_error=${encodeURIComponent(result.error ?? "Verification failed")}`);
  }
});

authRouter.post("/verify-email", async (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ error: "Verification token is required" });
    return;
  }
  const result = await verifyEmailToken(token);
  if (result.success) {
    res.json({ verified: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

authRouter.post("/resend-verification", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;
  // Rate limit: max 3 resends per hour
  const rl = checkRateLimit(`resend:${userId}`, 3, 60 * 60_000);
  if (!rl.allowed) {
    res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(rl.retryAfterMs / 60_000)} minutes.` });
    return;
  }
  const verified = await isEmailVerified(userId);
  if (verified) {
    res.json({ verified: true, message: "Email is already verified." });
    return;
  }
  const token = await createVerificationToken(userId);
  res.json({
    verificationToken: token,
    message: "A new verification link has been generated.",
  });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
});

// --- Admin login (separate gate: password + access code) -------------------

authRouter.post("/admin/login", async (req, res) => {
  // Rate limit admin login: max 5 attempts per 15 minutes
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const rl = checkRateLimit(`admin-login:${ip}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(rl.retryAfterMs / 60_000)} minutes.` });
    return;
  }
  if (!adminConfigured()) {
    res.status(503).json({ error: "The admin module is not configured on this server." });
    return;
  }
  const { email, password, accessCode } = (req.body ?? {}) as {
    email?: string;
    password?: string;
    accessCode?: string;
  };
  if (!email || !password || !accessCode) {
    res.status(400).json({ error: "Email, password and access code are required" });
    return;
  }
  // Uniform "Invalid credentials" for every failure so we never reveal which
  // factor was wrong (which account exists, whether the code matched, etc.).
  const fail = () => res.status(401).json({ error: "Invalid credentials" });
  if (accessCode !== config.admin.accessCode) return fail();
  const user = await findUserByEmail(String(email).trim().toLowerCase());
  if (!user || user.role !== "admin" || !verifyPassword(password, user.password_hash)) return fail();
  if (user.suspended) {
    res.status(403).json({ error: "Account suspended" });
    return;
  }
  setSession(res, user.id, { admin: true });
  res.json({ user: publicUser(user), admin: true });
});

// Begin OAuth: redirect the browser to the provider's consent screen.
authRouter.get("/:provider/login", (req, res) => {
  const provider = req.params.provider as Provider;
  if (provider !== "google" && provider !== "github") {
    res.status(404).send("Unknown provider");
    return;
  }
  if (!providerConfigured(provider)) {
    res.status(503).send(`${provider} sign-in is not configured on this server.`);
    return;
  }
  const cfg = config.providers[provider];
  const state = randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 600_000, path: "/" });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  res.redirect(`${cfg.authUrl}?${params}`);
});

// OAuth callback: verify state, exchange the code, upsert the user, set session.
authRouter.get("/:provider/callback", async (req, res) => {
  const provider = req.params.provider as Provider;
  try {
    if (provider !== "google" && provider !== "github") throw new Error("Unknown provider");
    const { code, state } = req.query as { code?: string; state?: string };
    const expected = req.cookies?.[STATE_COOKIE];
    if (!code || !state || !expected || state !== expected) throw new Error("Invalid OAuth state");
    res.clearCookie(STATE_COOKIE, { path: "/" });

    const accessToken = await exchangeCode(provider, code);
    const profile =
      provider === "google"
        ? await fetchGoogleProfile(accessToken)
        : await fetchGithubProfile(accessToken);

    const user = await upsertUser({ provider, ...profile });
    // OAuth users are auto-verified (their email is confirmed by the provider)
    if (!user.email_verified) await markEmailVerified(user.id);
    setSession(res, user.id);
    res.redirect(config.appUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sign-in failed";
    res.redirect(`${config.appUrl}?auth_error=${encodeURIComponent(msg)}`);
  }
});

// Development-only sign-in so the signed-in experience works without OAuth apps.
authRouter.post("/dev/login", async (req, res) => {
  if (!config.allowDevLogin) {
    res.status(403).json({ error: "Dev login disabled" });
    return;
  }
  const name = (req.body?.name as string | undefined)?.trim() || "Dev User";
  const user = await upsertUser({
    provider: "dev",
    providerId: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.dev`,
    avatarUrl: null,
  });
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
});
