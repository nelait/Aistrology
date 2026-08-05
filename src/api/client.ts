// Thin client for the Aistrology API (see server/). Same-origin in dev thanks to
// the Vite proxy, so session cookies flow automatically.

import { BirthData } from "../astro/types";

export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  provider: string;
  plan: string; // 'free' | 'pro' | 'premium'
  role: string; // 'user' | 'admin'
  emailVerified: boolean;
  planExpiresAt?: number | null; // set when the plan is a temporary promo grant
}

// --- Admin & notifications ---
export interface AdminUser {
  id: string;
  name: string | null;
  email: string | null;
  provider: string;
  plan: string;
  planSource: string | null; // 'stripe' | 'manual' | 'promo' | null
  role: string;
  suspended: boolean;
  emailVerified: boolean;
  totalChartsCreated: number;
  activeCharts: number;
  createdAt: number;
}
export interface AdminOffer {
  id: string;
  displayName: string;
  headline: string;
  bio: string;
  specialties: string | null;
  languages: string | null;
  rateInr: number | null;
  status: string;
  ownerEmail: string | null;
  updatedAt: number;
}
export interface AdminOverview {
  users: number;
  offers: number;
  pendingOffers: number;
  admins: number;
}
export interface AdminUsageStats {
  planDistribution: Record<string, number>;
  charts: { activeTotal: number; lifetimeTotal: number; byPlan: Record<string, number> };
  signups: { last7d: number; last30d: number };
  rateLimit: {
    rateBuckets: number;
    dailyCounters: number;
    llmCacheEntries: number;
    llmCacheMaxEntries: number;
    topDailyUsers: Array<{ userId: string; userName: string; feature: string; count: number }>;
  };
}
export interface AdminUserUsage {
  userId: string;
  name: string | null;
  email: string | null;
  plan: string;
  totalChartsCreated: number;
  activeCharts: number;
  emailVerified: boolean;
  dailyUsage: Record<string, number>;
  charts: Array<{ id: string; label: string; createdAt: number; updatedAt: number }>;
}
export interface VastuLlmRequest {
  chartSummary: string;
  vastuSummary: string;
  references: string[];
  floorPlanBase64?: string;
  language?: string;
}
export interface VastuLlmResponse {
  provider: string;
  analysis: string;
  floorPlanObservations: string | null;
  additionalRemedies: string[];
}
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  level: string;
  read: boolean;
  createdAt: number;
}

// Admin-toggleable feature flags. Default all enabled until /auth/me resolves.
export type FeatureFlags = Record<string, boolean>;
export const DEFAULT_FEATURES: FeatureFlags = { consultation: true, temples: true, vastu: true, reminders: true, chat: true, notes: true };

// --- Astro Chat ---
export interface ChatMessage { role: "user" | "assistant"; content: string; }
export interface ChatContext {
  chart?: { label?: string; summary?: string };
  module?: string;
  /** Derived findings the model should ground answers in (doshas, muhurta, vastu…). */
  findings?: string[];
}
export interface ChatConversation {
  id: string; title: string; chartId: string | null;
  messageCount: number; updatedAt: number; createdAt: number;
}

// --- Notes (per-profile, paid) ---
export interface Note {
  id: string; chartId: string; title: string; body: string;
  createdAt: number; updatedAt: number;
}
export interface FeatureMeta { label: string; description: string; }

// --- Reminders & festivals ---
export interface Reminder {
  id: string; title: string; notes: string; eventDate: string;
  recurrence: string; leadDays: number; enabled: boolean; lastNotified: string | null;
}
export interface ReminderFestival {
  id: string; name: string; description: string; eventDate: string;
  recurring: boolean; subscribed: boolean; leadDays: number;
}
export interface RemindersData { reminders: Reminder[]; festivals: ReminderFestival[]; }
export interface AdminFestival {
  id: string; name: string; description: string; eventDate: string; recurring: boolean;
}
export interface ReminderInput {
  title: string; notes?: string; eventDate: string; recurrence?: string; leadDays?: number; enabled?: boolean;
}

// --- Promo codes ---
export interface AdminPromoCode {
  id: string; code: string; plan: string; expiresAt: number | null;
  maxRedemptions: number | null; durationDays: number;
  enabled: boolean; redemptions: number; createdAt: number;
}

// --- Contact us ---
export const CONTACT_CATEGORIES: { value: string; label: string }[] = [
  { value: "general", label: "General enquiry" },
  { value: "billing", label: "Billing & payments" },
  { value: "technical", label: "Technical / bug" },
  { value: "account", label: "Account & login" },
  { value: "consultation", label: "Consultations" },
  { value: "feedback", label: "Feedback / suggestion" },
  { value: "other", label: "Other" },
];
export interface AdminContactMessage {
  id: string; name: string; email: string | null; category: string;
  message: string; status: string; fromAccount: boolean; createdAt: number;
}

export type PlanLimits = Record<string, Record<string, number>>;
export interface AdminQuotas {
  limits: PlanLimits;
  defaults: PlanLimits;
  plans: string[];
  features: { key: string; label: string }[];
}

export interface AdminBillingEvent {
  id: string;
  kind: string; // refund | dispute_opened | dispute_closed
  detail: string;
  email: string | null;
  amount: number | null; // minor units (cents)
  currency: string | null;
  action: string;
  createdAt: number;
}

// --- Billing status (live Stripe subscription) ---
export interface SubscriptionInfo {
  status: string; // active | trialing | past_due | canceled | unpaid | paused | ...
  plan: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}
export interface BillingStatus {
  plan: string;
  stripeConfigured: boolean;
  subscription: SubscriptionInfo | null;
  reconciled: boolean;
}

export interface SavedChart {
  id: string;
  label: string;
  birth: BirthData;
  createdAt: number;
  updatedAt: number;
}

// --- Temple affiliation (temples are their own accounts) ---
export interface Temple {
  id: string; email?: string | null; name: string; deity: string; location: string;
  description: string; contact_email: string | null; contact_phone: string | null;
  website: string | null; image_url: string | null; status: string;
  created_at: number; updated_at: number;
  services?: TempleService[];
  events?: TempleEvent[];
}
export interface TempleService {
  id: string; temple_id: string; name: string; description: string;
  deity: string | null; duration: string | null; price_inr: number | null;
  available: boolean; created_at: number;
}
export interface TempleEvent {
  id: string; temple_id: string; title: string; description: string;
  event_date: string; event_time: string | null; recurring: string; created_at: number;
}

export interface Providers {
  google: boolean;
  github: boolean;
  devLogin: boolean;
}

export type LlmProviderId = "openai" | "anthropic" | "gemini";
export type ActiveProvider = LlmProviderId | "demo" | null;

export interface LlmProviderPublic {
  configured: boolean;
  hint: string | null;
  model: string;
}
export interface LlmSettings {
  activeProvider: ActiveProvider;
  providers: Record<LlmProviderId, LlmProviderPublic>;
}

export interface Reference {
  source: string;
  text: string;
}
export interface JustifyRequest {
  subject: string;
  basePrediction: string;
  facts: string[];
  references: Reference[];
  language?: string; // English name of target language
  /** Structured analytical guidelines the LLM should follow when framing
   *  its justification — e.g. "check D1 first", "observe current dasha". */
  guidelines?: string[];
}

export interface TranslateResponse {
  provider: string;
  language: string;
  translations: string[];
  translated: boolean;
}
export interface JustifyResponse {
  provider: string;
  model: string;
  justification: string;
  enhancedPrediction: string;
  references: Reference[];
}

// --- Consultation marketplace ---
/** What a provider offers. Drives the directory filter. */
export type ProviderType = "astrologer" | "priest" | "both";
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  astrologer: "Astrologer",
  priest: "Priest",
  both: "Astrologer & Priest",
};

export interface ConsultationProvider {
  id: string;
  displayName: string;
  headline: string;
  bio: string;
  providerType: ProviderType;
  specialties: string | null;
  languages: string | null;
  rateInr: number | null;
  status: string;
}
export interface ConsultationOffer extends ConsultationProvider {
  contactEmail: string | null;
  updatedAt: number;
}
export interface ConsultationBooking {
  id: string;
  offerId: string;
  topic: string;
  preferredTime: string | null;
  message: string | null;
  contactEmail: string | null;
  status: string;
  createdAt: number;
  providerName?: string;
  seekerName?: string | null;
}
export interface ConsultationData {
  plan: string;
  canOffer: boolean;
  providers: ConsultationProvider[];
  offer: ConsultationOffer | null;
  bookings: ConsultationBooking[];
  requests: ConsultationBooking[];
}
export interface OfferInput {
  displayName: string;
  headline: string;
  bio: string;
  providerType?: ProviderType;
  specialties?: string;
  languages?: string;
  rateInr?: number | null;
  contactEmail?: string;
}
export interface BookingInput {
  offerId: string;
  topic: string;
  preferredTime?: string;
  message?: string;
  contactEmail?: string;
}

async function unwrap<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${r.status})`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  async me(): Promise<{ user: AuthUser | null; admin: boolean; features: FeatureFlags }> {
    const r = await unwrap<{ user: AuthUser | null; admin?: boolean; features?: FeatureFlags }>(await fetch("/auth/me"));
    return { user: r.user, admin: Boolean(r.admin), features: r.features ?? DEFAULT_FEATURES };
  },
  async adminLogin(email: string, password: string, accessCode: string): Promise<AuthUser> {
    const r = await fetch("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, accessCode }),
    });
    return (await unwrap<{ user: AuthUser }>(r)).user;
  },
  async providers(): Promise<Providers> {
    return unwrap<Providers>(await fetch("/auth/providers"));
  },
  loginUrl(provider: "google" | "github"): string {
    return `/auth/${provider}/login`;
  },
  async register(email: string, password: string, name: string): Promise<{ user: AuthUser; verificationToken?: string }> {
    const r = await fetch("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    return unwrap<{ user: AuthUser; verificationToken?: string }>(r);
  },
  async login(email: string, password: string): Promise<AuthUser> {
    const r = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return (await unwrap<{ user: AuthUser }>(r)).user;
  },
  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    const r = await fetch("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return unwrap<{ verified: boolean }>(r);
  },
  async resendVerification(): Promise<{ verificationToken?: string; verified?: boolean; message: string }> {
    const r = await fetch("/auth/resend-verification", { method: "POST" });
    return unwrap<{ verificationToken?: string; verified?: boolean; message: string }>(r);
  },
  async devLogin(name: string): Promise<AuthUser> {
    const r = await fetch("/auth/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (await unwrap<{ user: AuthUser }>(r)).user;
  },
  async logout(): Promise<void> {
    await fetch("/auth/logout", { method: "POST" });
  },
  async listCharts(): Promise<SavedChart[]> {
    return (await unwrap<{ charts: SavedChart[] }>(await fetch("/api/charts"))).charts;
  },
  async listChartsWithLimit(): Promise<{ charts: SavedChart[]; plan: string; chartLimit: number }> {
    return unwrap<{ charts: SavedChart[]; plan: string; chartLimit: number }>(await fetch("/api/charts"));
  },
  async createChart(label: string, birth: BirthData): Promise<SavedChart> {
    const r = await fetch("/api/charts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, birth }),
    });
    return (await unwrap<{ chart: SavedChart }>(r)).chart;
  },
  async deleteChart(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/charts/${id}`, { method: "DELETE" }));
  },
  async renameChart(id: string, label: string): Promise<SavedChart> {
    const r = await fetch(`/api/charts/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }),
    });
    return (await unwrap<{ chart: SavedChart }>(r)).chart;
  },
  // --- Vastu settings (per profile) ---
  async getVastuSettings(chartId: string): Promise<{ chartId: string; questionnaire: unknown; floorPlan: string | null; updatedAt: number } | null> {
    const { vastu } = await unwrap<{ vastu: { chartId: string; questionnaire: unknown; floorPlan: string | null; updatedAt: number } | null }>(
      await fetch(`/api/charts/${chartId}/vastu`),
    );
    return vastu;
  },
  async saveVastuSettings(chartId: string, questionnaire: unknown, floorPlan?: string | null): Promise<void> {
    await unwrap<unknown>(
      await fetch(`/api/charts/${chartId}/vastu`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionnaire, floorPlan: floorPlan ?? null }),
      }),
    );
  },

  // --- LLM (read-only; the config is managed globally by admins) ---
  async getSettings(): Promise<LlmSettings> {
    return unwrap<LlmSettings>(await fetch("/api/settings"));
  },
  async justify(req: JustifyRequest): Promise<JustifyResponse> {
    return unwrap<JustifyResponse>(
      await fetch("/api/llm/justify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }),
    );
  },
  async translate(items: string[], language: string): Promise<TranslateResponse> {
    return unwrap<TranslateResponse>(
      await fetch("/api/llm/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, language }),
      }),
    );
  },
  async analyseVastu(req: VastuLlmRequest): Promise<VastuLlmResponse> {
    return unwrap<VastuLlmResponse>(
      await fetch("/api/llm/vastu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }),
    );
  },
  /** Stream a justification token-by-token over Server-Sent Events. */
  async justifyStream(
    req: JustifyRequest,
    handlers: {
      onMeta?: (m: { provider: string; model: string }) => void;
      onDelta: (text: string) => void;
      onDone?: () => void;
      onError?: (message: string) => void;
    },
  ): Promise<void> {
    const res = await fetch("/api/llm/justify/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok || !res.body) {
      handlers.onError?.(`Stream failed (${res.status})`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let data: { delta?: string; error?: string; provider?: string; model?: string };
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (event === "meta") handlers.onMeta?.({ provider: data.provider ?? "", model: data.model ?? "" });
        else if (event === "done") handlers.onDone?.();
        else if (event === "error") handlers.onError?.(data.error ?? "Stream error");
        else if (data.delta) handlers.onDelta(data.delta);
      }
    }
  },

  // --- Astro Chat (streaming, same SSE framing as justifyStream) ---
  async listChatConversations(): Promise<ChatConversation[]> {
    return (await unwrap<{ conversations: ChatConversation[] }>(await fetch("/api/chat/conversations"))).conversations;
  },
  async getChatConversation(id: string): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
    return unwrap<{ conversation: ChatConversation; messages: ChatMessage[] }>(
      await fetch(`/api/chat/conversations/${id}`));
  },
  async deleteChatConversation(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" }));
  },

  // --- Notes ---
  async listNotes(chartId: string): Promise<Note[]> {
    return (await unwrap<{ notes: Note[] }>(await fetch(`/api/notes?chartId=${encodeURIComponent(chartId)}`))).notes;
  },
  async createNote(chartId: string, title: string, body: string): Promise<Note> {
    const r = await fetch("/api/notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chartId, title, body }),
    });
    return (await unwrap<{ note: Note }>(r)).note;
  },
  async updateNote(id: string, title: string, body: string): Promise<Note> {
    const r = await fetch(`/api/notes/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    return (await unwrap<{ note: Note }>(r)).note;
  },
  async deleteNote(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/notes/${id}`, { method: "DELETE" }));
  },
  async chatStream(
    req: { messages: ChatMessage[]; context?: ChatContext; conversationId?: string; chartId?: string },
    handlers: {
      onMeta?: (m: { provider: string; model: string; conversationId?: string }) => void;
      onDelta: (text: string) => void;
      onDone?: (info: { conversationId?: string }) => void;
      onError?: (message: string) => void;
    },
  ): Promise<void> {
    const res = await fetch("/api/llm/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok || !res.body) {
      let msg = `Chat failed (${res.status})`;
      try { msg = (await res.json())?.error ?? msg; } catch { /* non-JSON */ }
      handlers.onError?.(msg);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let data: { delta?: string; error?: string; provider?: string; model?: string; conversationId?: string };
        try { data = JSON.parse(dataStr); } catch { continue; }
        if (event === "meta") handlers.onMeta?.({ provider: data.provider ?? "", model: data.model ?? "", conversationId: data.conversationId });
        else if (event === "done") handlers.onDone?.({ conversationId: data.conversationId });
        else if (event === "error") handlers.onError?.(data.error ?? "Stream error");
        else if (data.delta) handlers.onDelta(data.delta);
      }
    }
  },

  // --- Billing ---
  async billingStatus(): Promise<BillingStatus> {
    return unwrap<BillingStatus>(await fetch("/api/billing/status"));
  },
  async createCheckout(plan: "pro" | "premium"): Promise<{ url: string }> {
    return unwrap<{ url: string }>(await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    }));
  },
  async openPortal(): Promise<{ url: string }> {
    return unwrap<{ url: string }>(await fetch("/api/billing/portal", {
      method: "POST",
    }));
  },

  // --- Consultation ---
  async getConsultation(): Promise<ConsultationData> {
    return unwrap<ConsultationData>(await fetch("/api/consultation"));
  },
  async saveOffer(input: OfferInput): Promise<ConsultationOffer> {
    const r = await fetch("/api/consultation/offer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await unwrap<{ offer: ConsultationOffer }>(r)).offer;
  },
  async createBooking(input: BookingInput): Promise<ConsultationBooking> {
    const r = await fetch("/api/consultation/booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await unwrap<{ booking: ConsultationBooking }>(r)).booking;
  },
  async updateRequestStatus(id: string, status: string): Promise<ConsultationBooking> {
    const r = await fetch(`/api/consultation/request/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return (await unwrap<{ booking: ConsultationBooking }>(r)).booking;
  },

  // --- Notifications (all users) ---
  async getNotifications(): Promise<{ notifications: AppNotification[]; unread: number }> {
    return unwrap<{ notifications: AppNotification[]; unread: number }>(await fetch("/api/notifications"));
  },
  async markNotificationRead(id: string): Promise<{ unread: number }> {
    return unwrap<{ unread: number }>(await fetch(`/api/notifications/${id}/read`, { method: "POST" }));
  },
  async markAllNotificationsRead(): Promise<{ unread: number }> {
    return unwrap<{ unread: number }>(await fetch("/api/notifications/read-all", { method: "POST" }));
  },

  // --- Admin ---
  async getAdminOverview(): Promise<AdminOverview> {
    return unwrap<AdminOverview>(await fetch("/api/admin/overview"));
  },
  async getAdminFeatures(): Promise<{ features: FeatureFlags; meta: Record<string, FeatureMeta> }> {
    return unwrap<{ features: FeatureFlags; meta: Record<string, FeatureMeta> }>(await fetch("/api/admin/features"));
  },

  // --- Reminders (user) ---
  async getReminders(): Promise<RemindersData> {
    return unwrap<RemindersData>(await fetch("/api/reminders"));
  },
  async createReminder(input: ReminderInput): Promise<Reminder> {
    const r = await fetch("/api/reminders/reminders", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    return (await unwrap<{ reminder: Reminder }>(r)).reminder;
  },
  async updateReminder(id: string, patch: Partial<ReminderInput>): Promise<Reminder> {
    const r = await fetch(`/api/reminders/reminders/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    return (await unwrap<{ reminder: Reminder }>(r)).reminder;
  },
  async deleteReminder(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/reminders/reminders/${id}`, { method: "DELETE" }));
  },
  async subscribeFestival(id: string, leadDays: number): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/reminders/festivals/${id}/subscribe`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadDays }),
    }));
  },
  async unsubscribeFestival(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/reminders/festivals/${id}/subscribe`, { method: "DELETE" }));
  },

  // --- Festivals & reminder run (admin) ---
  async getAdminFestivals(): Promise<AdminFestival[]> {
    return (await unwrap<{ festivals: AdminFestival[] }>(await fetch("/api/admin/festivals"))).festivals;
  },
  async createFestival(input: { name: string; description?: string; eventDate: string; recurring?: boolean }): Promise<AdminFestival> {
    const r = await fetch("/api/admin/festivals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    return (await unwrap<{ festival: AdminFestival }>(r)).festival;
  },
  async deleteFestival(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/admin/festivals/${id}`, { method: "DELETE" }));
  },
  async runReminders(): Promise<{ sent: number; downgraded: number }> {
    return unwrap<{ sent: number; downgraded: number }>(await fetch("/api/admin/reminders/run", { method: "POST" }));
  },

  // --- Promo codes ---
  async redeemPromo(code: string): Promise<{ plan: string; planExpiresAt: number }> {
    return unwrap<{ plan: string; planExpiresAt: number }>(await fetch("/api/promo/redeem", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    }));
  },
  async getAdminPromos(): Promise<AdminPromoCode[]> {
    return (await unwrap<{ promos: AdminPromoCode[] }>(await fetch("/api/admin/promos"))).promos;
  },
  async createPromo(input: { code: string; plan: string; expiresAt: number | null; maxRedemptions?: number | null; durationDays?: number; enabled?: boolean }): Promise<AdminPromoCode> {
    const r = await fetch("/api/admin/promos", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    return (await unwrap<{ promo: AdminPromoCode }>(r)).promo;
  },
  async updatePromo(id: string, patch: { plan?: string; expiresAt?: number | null; maxRedemptions?: number | null; durationDays?: number; enabled?: boolean }): Promise<AdminPromoCode> {
    const r = await fetch(`/api/admin/promos/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    return (await unwrap<{ promo: AdminPromoCode }>(r)).promo;
  },
  async deletePromo(id: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/admin/promos/${id}`, { method: "DELETE" }));
  },

  // --- Contact us ---
  async sendContactMessage(input: { name: string; email?: string; category: string; message: string }): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch("/api/contact", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }));
  },
  async getAdminContact(): Promise<AdminContactMessage[]> {
    return (await unwrap<{ messages: AdminContactMessage[] }>(await fetch("/api/admin/contact"))).messages;
  },
  async setContactStatus(id: string, status: string): Promise<AdminContactMessage> {
    const r = await fetch(`/api/admin/contact/${id}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
    return (await unwrap<{ message: AdminContactMessage }>(r)).message;
  },
  async getAdminBillingEvents(): Promise<AdminBillingEvent[]> {
    return (await unwrap<{ events: AdminBillingEvent[] }>(await fetch("/api/admin/billing-events"))).events;
  },
  async getAdminQuotas(): Promise<AdminQuotas> {
    return unwrap<AdminQuotas>(await fetch("/api/admin/quotas"));
  },
  async setAdminQuotas(limits: PlanLimits): Promise<PlanLimits> {
    const r = await fetch("/api/admin/quotas", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limits }),
    });
    return (await unwrap<{ limits: PlanLimits }>(r)).limits;
  },
  async resetAdminQuotas(): Promise<PlanLimits> {
    return (await unwrap<{ limits: PlanLimits }>(await fetch("/api/admin/quotas/reset", { method: "POST" }))).limits;
  },
  async setAdminFeatures(patch: FeatureFlags): Promise<FeatureFlags> {
    const r = await fetch("/api/admin/features", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return (await unwrap<{ features: FeatureFlags }>(r)).features;
  },
  async getAdminUsage(): Promise<AdminUsageStats> {
    return unwrap<AdminUsageStats>(await fetch("/api/admin/usage"));
  },
  async getUserUsage(userId: string): Promise<AdminUserUsage> {
    return unwrap<AdminUserUsage>(await fetch(`/api/admin/users/${userId}/usage`));
  },
  async getAdminUsers(): Promise<AdminUser[]> {
    return (await unwrap<{ users: AdminUser[] }>(await fetch("/api/admin/users"))).users;
  },
  async createAdminUser(input: {
    email: string; password: string; name?: string; plan?: string; role?: string;
  }): Promise<AdminUser> {
    const r = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await unwrap<{ user: AdminUser }>(r)).user;
  },
  async updateAdminUser(
    id: string,
    patch: { plan?: string; role?: string; suspended?: boolean },
  ): Promise<AdminUser> {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return (await unwrap<{ user: AdminUser }>(r)).user;
  },
  async getAdminOffers(): Promise<AdminOffer[]> {
    return (await unwrap<{ offers: AdminOffer[] }>(await fetch("/api/admin/offers"))).offers;
  },
  async setAdminOfferStatus(id: string, status: string): Promise<AdminOffer> {
    const r = await fetch(`/api/admin/offers/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return (await unwrap<{ offer: AdminOffer }>(r)).offer;
  },
  async sendNotification(input: {
    target: "all" | "users"; userIds?: string[]; title: string; body: string; level?: string;
  }): Promise<{ sent: number }> {
    const r = await fetch("/api/admin/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return unwrap<{ sent: number }>(r);
  },
  async getAdminLlm(): Promise<LlmSettings> {
    return unwrap<LlmSettings>(await fetch("/api/admin/llm"));
  },
  async setAdminLlmKey(provider: LlmProviderId, fields: { apiKey?: string; model?: string }): Promise<LlmSettings> {
    return unwrap<LlmSettings>(await fetch(`/api/admin/llm/provider/${provider}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }));
  },
  async removeAdminLlmProvider(provider: LlmProviderId): Promise<LlmSettings> {
    return unwrap<LlmSettings>(await fetch(`/api/admin/llm/provider/${provider}`, { method: "DELETE" }));
  },
  async setAdminLlmActive(provider: ActiveProvider): Promise<LlmSettings> {
    return unwrap<LlmSettings>(await fetch("/api/admin/llm/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    }));
  },

  // --- Temple affiliation (temples authenticate with their own credentials) ---
  async listTemples(): Promise<Temple[]> {
    const { temples } = await unwrap<{ temples: Temple[] }>(await fetch("/api/temples"));
    return temples;
  },
  async getTemple(id: string): Promise<Temple> {
    const { temple } = await unwrap<{ temple: Temple }>(await fetch(`/api/temples/${id}`));
    return temple;
  },
  // Temple auth realm
  async templeRegister(data: {
    name: string; deity: string; location: string; description: string;
    email: string; password: string;
    contactEmail?: string; contactPhone?: string; website?: string; imageUrl?: string;
  }): Promise<Temple> {
    const { temple } = await unwrap<{ temple: Temple }>(await fetch("/api/temples/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }));
    return temple;
  },
  async templeLogin(email: string, password: string): Promise<Temple> {
    const { temple } = await unwrap<{ temple: Temple }>(await fetch("/api/temples/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    }));
    return temple;
  },
  async templeLogout(): Promise<void> {
    await fetch("/api/temples/logout", { method: "POST" });
  },
  /** Current temple from the temple session, or null if not signed in. */
  async templePortal(): Promise<Temple | null> {
    const r = await fetch("/api/temples/me");
    if (r.status === 401) return null;
    const { temple } = await unwrap<{ temple: Temple | null }>(r);
    return temple;
  },
  async updateMyTemple(data: Record<string, unknown>): Promise<Temple> {
    const { temple } = await unwrap<{ temple: Temple }>(await fetch("/api/temples/me", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }));
    return temple;
  },
  // Services (scoped to the signed-in temple)
  async addTempleService(data: { name: string; description: string; deity?: string; duration?: string; priceInr?: number }): Promise<TempleService> {
    const { service } = await unwrap<{ service: TempleService }>(await fetch("/api/temples/me/services", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }));
    return service;
  },
  async deleteTempleService(serviceId: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/temples/me/services/${serviceId}`, { method: "DELETE" }));
  },
  // Events (scoped to the signed-in temple)
  async addTempleEvent(data: { title: string; description: string; eventDate: string; eventTime?: string; recurring?: string }): Promise<TempleEvent> {
    const { event } = await unwrap<{ event: TempleEvent }>(await fetch("/api/temples/me/events", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }));
    return event;
  },
  async deleteTempleEvent(eventId: string): Promise<void> {
    await unwrap<{ ok: boolean }>(await fetch(`/api/temples/me/events/${eventId}`, { method: "DELETE" }));
  },
  // Admin
  async adminListTemples(): Promise<Temple[]> {
    const { temples } = await unwrap<{ temples: Temple[] }>(await fetch("/api/admin/temples"));
    return temples;
  },
  async adminSetTempleStatus(id: string, status: string): Promise<Temple> {
    const { temple } = await unwrap<{ temple: Temple }>(await fetch(`/api/admin/temples/${id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    }));
    return temple;
  },
};
