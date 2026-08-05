import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { hashPassword, verifyPassword } from "./password";
import { requireFeature } from "./features";
import {
  listApprovedTemples, getTemple, getTempleByEmail, createTempleAccount, updateTemple,
  listTempleServices, createTempleService, updateTempleService, deleteTempleService,
  listTempleEvents, createTempleEvent, updateTempleEvent, deleteTempleEvent,
} from "./db";

export const templesRouter = Router();

// Whole temple feature is admin-toggleable.
templesRouter.use(requireFeature("temples"));

// ── Temple auth realm ──────────────────────────────────────────────────
// Temples are their own accounts, entirely separate from astrology users.
// They authenticate with their own credentials and get a dedicated cookie.

const TEMPLE_COOKIE = "aistro_temple";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setTempleSession(res: Response, templeId: string): void {
  const token = jwt.sign({ tid: templeId, kind: "temple" }, config.sessionSecret, { expiresIn: "30d" });
  res.cookie(TEMPLE_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: config.isProduction,
    maxAge: 30 * 24 * 3600 * 1000, path: "/",
  });
}

function currentTempleId(req: Request): string | null {
  const token = req.cookies?.[TEMPLE_COOKIE];
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.sessionSecret) as { tid?: string; kind?: string };
    return p.kind === "temple" && p.tid ? p.tid : null;
  } catch {
    return null;
  }
}

function requireTemple(req: Request, res: Response, next: NextFunction): void {
  const tid = currentTempleId(req);
  if (!tid) { res.status(401).json({ error: "Temple sign-in required" }); return; }
  (req as Request & { templeId: string }).templeId = tid;
  next();
}
function tid(req: Request): string {
  return (req as Request & { templeId: string }).templeId;
}

/** Public shape — never leak the password hash. */
function toPublicTemple(t: { password_hash?: string | null } & Record<string, unknown>) {
  const { password_hash, ...rest } = t;
  return rest;
}

async function withChildren(t: Awaited<ReturnType<typeof getTemple>>) {
  if (!t) return null;
  const [services, events] = await Promise.all([listTempleServices(t.id), listTempleEvents(t.id)]);
  return { ...toPublicTemple(t), services, events };
}

// ── Public: browse approved temples ─────────────────────────────────────

templesRouter.get("/", async (_req: Request, res: Response) => {
  const temples = await listApprovedTemples();
  const out = await Promise.all(temples.map((t) => withChildren(t)));
  res.json({ temples: out });
});

// ── Temple auth: register / login / logout ──────────────────────────────

templesRouter.post("/register", async (req: Request, res: Response) => {
  const { name, deity, location, description, contactEmail, contactPhone, website, imageUrl, email, password } = req.body ?? {};
  if (!name || !deity || !location) {
    res.status(400).json({ error: "name, deity, and location are required" }); return;
  }
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "A valid login email is required" }); return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" }); return;
  }
  if (await getTempleByEmail(email)) {
    res.status(409).json({ error: "A temple is already registered with that email" }); return;
  }
  const temple = await createTempleAccount({
    email, passwordHash: hashPassword(password),
    name, deity, location, description: description ?? "",
    contactEmail, contactPhone, website, imageUrl,
  });
  setTempleSession(res, temple.id);
  res.status(201).json({ temple: toPublicTemple(temple) });
});

templesRouter.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }
  const temple = await getTempleByEmail(String(email));
  if (!temple || !verifyPassword(password, temple.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" }); return;
  }
  setTempleSession(res, temple.id);
  res.json({ temple: toPublicTemple(temple) });
});

templesRouter.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(TEMPLE_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ── Temple portal: manage own temple (temple session required) ──────────

templesRouter.get("/me", requireTemple, async (req: Request, res: Response) => {
  const t = await getTemple(tid(req));
  res.json({ temple: await withChildren(t) });
});

templesRouter.put("/me", requireTemple, async (req: Request, res: Response) => {
  const updated = await updateTemple(tid(req), req.body ?? {});
  res.json({ temple: updated ? toPublicTemple(updated) : null });
});

// Services CRUD
templesRouter.post("/me/services", requireTemple, async (req: Request, res: Response) => {
  const { name, description, deity, duration, priceInr } = req.body ?? {};
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const s = await createTempleService(tid(req), { name, description: description ?? "", deity, duration, priceInr });
  res.status(201).json({ service: s });
});

templesRouter.put("/me/services/:sid", requireTemple, async (req: Request, res: Response) => {
  const s = await updateTempleService(req.params.sid, req.body ?? {});
  res.json({ service: s });
});

templesRouter.delete("/me/services/:sid", requireTemple, async (req: Request, res: Response) => {
  await deleteTempleService(req.params.sid);
  res.json({ ok: true });
});

// Events CRUD
templesRouter.post("/me/events", requireTemple, async (req: Request, res: Response) => {
  const { title, description, eventDate, eventTime, recurring } = req.body ?? {};
  if (!title || !eventDate) { res.status(400).json({ error: "title and eventDate are required" }); return; }
  const ev = await createTempleEvent(tid(req), { title, description: description ?? "", eventDate, eventTime, recurring });
  res.status(201).json({ event: ev });
});

templesRouter.put("/me/events/:eid", requireTemple, async (req: Request, res: Response) => {
  const ev = await updateTempleEvent(req.params.eid, req.body ?? {});
  res.json({ event: ev });
});

templesRouter.delete("/me/events/:eid", requireTemple, async (req: Request, res: Response) => {
  await deleteTempleEvent(req.params.eid);
  res.json({ ok: true });
});

// ── Public: single temple detail (keep last so it doesn't shadow /me etc.) ──

templesRouter.get("/:id", async (req: Request, res: Response) => {
  const t = await getTemple(req.params.id);
  if (!t || t.status !== "approved") { res.status(404).json({ error: "Temple not found" }); return; }
  res.json({ temple: await withChildren(t) });
});
