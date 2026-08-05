import { Router, type Request, type Response } from "express";
import { currentUserId } from "./auth";
import { createContactMessage } from "./db";

export const contactRouter = Router();

// Predefined contact categories (must match the client dropdown).
export const CONTACT_CATEGORIES = [
  "general", "billing", "technical", "account", "consultation", "feedback", "other",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public: anyone can send a message. If they're signed in, we link the account.
contactRouter.post("/", async (req: Request, res: Response) => {
  const { name, email, category, message } = (req.body ?? {}) as Record<string, string>;
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Please enter your name." }); return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Please enter a message." }); return;
  }
  if (email && !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Please enter a valid email address." }); return;
  }
  const cat = CONTACT_CATEGORIES.includes(category) ? category : "general";
  await createContactMessage({
    userId: currentUserId(req), // null if not signed in
    name: name.trim(),
    email: typeof email === "string" && email.trim() ? email.trim() : null,
    category: cat,
    message: message.trim().slice(0, 5000),
  });
  res.status(201).json({ ok: true });
});
