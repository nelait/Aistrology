import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  getUserPlan,
  listApprovedOffers,
  getMyOffer,
  getOffer,
  upsertOffer,
  createBooking,
  listMyBookings,
  listRequestsForProvider,
  updateBookingStatus,
  type OfferRow,
  type BookingRow,
} from "./db";
import { checkDailyQuota, getPlanDailyLimit } from "./rateLimit";
import { requireFeature } from "./features";

export const consultationRouter = Router();

consultationRouter.use(requireFeature("consultation"));
consultationRouter.use(requireAuth);

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

/** What a provider offers, so seekers can filter the directory. */
const PROVIDER_TYPES = ["astrologer", "priest", "both"];

/** Public directory shape — hide the internal owner id and contact email. */
function toPublicOffer(o: OfferRow) {
  return {
    id: o.id,
    displayName: o.display_name,
    headline: o.headline,
    bio: o.bio,
    providerType: o.provider_type,
    specialties: o.specialties,
    languages: o.languages,
    rateInr: o.rate_inr,
    status: o.status,
  };
}

/** The owner's view of their own offer — includes contact + status. */
function toOwnOffer(o: OfferRow) {
  return {
    id: o.id,
    displayName: o.display_name,
    headline: o.headline,
    bio: o.bio,
    providerType: o.provider_type,
    specialties: o.specialties,
    languages: o.languages,
    rateInr: o.rate_inr,
    contactEmail: o.contact_email,
    status: o.status,
    updatedAt: Number(o.updated_at),
  };
}

function toBooking(b: BookingRow & { provider_name?: string; seeker_name?: string | null }) {
  return {
    id: b.id,
    offerId: b.offer_id,
    topic: b.topic,
    preferredTime: b.preferred_time,
    message: b.message,
    contactEmail: b.contact_email,
    status: b.status,
    createdAt: Number(b.created_at),
    providerName: b.provider_name,
    seekerName: b.seeker_name,
  };
}

/** Everything the Consultation tab needs in one round-trip. */
consultationRouter.get("/", async (req: Request, res: Response) => {
  const userId = uid(req);
  const plan = await getUserPlan(userId);
  const [providers, myOffer, bookings] = await Promise.all([
    listApprovedOffers(),
    getMyOffer(userId),
    listMyBookings(userId),
  ]);
  // Incoming requests only matter for providers (Premium with an offer).
  const requests = myOffer ? await listRequestsForProvider(userId) : [];
  res.json({
    plan,
    canOffer: plan === "premium",
    providers: providers.map(toPublicOffer),
    offer: myOffer ? toOwnOffer(myOffer) : null,
    bookings: bookings.map(toBooking),
    requests: requests.map(toBooking),
  });
});

/** Premium-only: create or update the provider profile. */
consultationRouter.put("/offer", async (req: Request, res: Response) => {
  const userId = uid(req);
  const plan = await getUserPlan(userId);
  if (plan !== "premium") {
    res.status(403).json({ error: "Offering consultations requires a Premium plan.", requiredPlan: "premium" });
    return;
  }
  const { displayName, headline, bio, providerType, specialties, languages, rateInr, contactEmail } = req.body ?? {};
  if (typeof displayName !== "string" || !displayName.trim()) {
    res.status(400).json({ error: "A display name is required." });
    return;
  }
  if (typeof headline !== "string" || !headline.trim()) {
    res.status(400).json({ error: "A short headline is required." });
    return;
  }
  if (typeof bio !== "string" || !bio.trim()) {
    res.status(400).json({ error: "Please describe your services." });
    return;
  }
  const rate =
    rateInr === null || rateInr === undefined || rateInr === ""
      ? null
      : Number.isFinite(Number(rateInr)) && Number(rateInr) >= 0
        ? Math.round(Number(rateInr))
        : NaN;
  if (Number.isNaN(rate)) {
    res.status(400).json({ error: "Rate must be a non-negative number." });
    return;
  }
  const offer = await upsertOffer(userId, {
    displayName: displayName.trim(),
    headline: headline.trim(),
    bio: bio.trim(),
    providerType: PROVIDER_TYPES.includes(providerType) ? providerType : "astrologer",
    specialties: typeof specialties === "string" ? specialties.trim() || null : null,
    languages: typeof languages === "string" ? languages.trim() || null : null,
    rateInr: rate,
    contactEmail: typeof contactEmail === "string" ? contactEmail.trim() || null : null,
  });
  res.json({ offer: toOwnOffer(offer) });
});

/** Any signed-in user: request a booking against an approved offer. */
consultationRouter.post("/booking", async (req: Request, res: Response) => {
  const userId = uid(req);

  // Daily booking quota check
  const plan = await getUserPlan(userId);
  const dailyLimit = getPlanDailyLimit(plan, "booking");
  const quota = checkDailyQuota(userId, "booking", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily booking limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  const { offerId, topic, preferredTime, message, contactEmail } = req.body ?? {};
  if (typeof offerId !== "string") {
    res.status(400).json({ error: "An offer is required." });
    return;
  }
  if (typeof topic !== "string" || !topic.trim()) {
    res.status(400).json({ error: "Please describe what you'd like to discuss." });
    return;
  }
  const offer = await getOffer(offerId);
  if (!offer || offer.status !== "approved") {
    res.status(404).json({ error: "This provider is no longer available." });
    return;
  }
  if (offer.user_id === userId) {
    res.status(400).json({ error: "You can't book a consultation with yourself." });
    return;
  }
  const booking = await createBooking(userId, offerId, {
    topic: topic.trim(),
    preferredTime: typeof preferredTime === "string" ? preferredTime.trim() || null : null,
    message: typeof message === "string" ? message.trim() || null : null,
    contactEmail: typeof contactEmail === "string" ? contactEmail.trim() || null : null,
  });
  res.status(201).json({ booking: toBooking(booking) });
});

/** Provider: update the status of an incoming request on their own offer. */
consultationRouter.post("/request/:id/status", async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  const allowed = ["confirmed", "declined", "completed"];
  if (typeof status !== "string" || !allowed.includes(status)) {
    res.status(400).json({ error: "Invalid status." });
    return;
  }
  const booking = await updateBookingStatus(uid(req), req.params.id, status);
  if (!booking) {
    res.status(404).json({ error: "Request not found." });
    return;
  }
  res.json({ booking: toBooking(booking) });
});
