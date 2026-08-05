import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import { requireFeature } from "./features";
import { getGlobalSetting, setGlobalSetting } from "./db";
import { encrypt, decrypt } from "./crypto";

// LLM configuration is GLOBAL and admin-managed (stored under this key). All
// users' AI features run on these shared, admin-provided keys.
const LLM_SETTINGS_KEY = "llm";
async function getLlmSettings(): Promise<Settings> {
  return (await getGlobalSetting(LLM_SETTINGS_KEY)) as Settings;
}
async function saveLlmSettings(s: Settings): Promise<void> {
  await setGlobalSetting(LLM_SETTINGS_KEY, s as Record<string, unknown>);
}

// LLM settings + a grounded "justification" endpoint. API keys are encrypted at
// rest; the client never receives them back (only a masked hint). The LLM is
// asked to justify a prediction using ONLY the classical references supplied by
// the client's reference knowledge base — no invented citations.

type ProviderId = "openai" | "anthropic" | "gemini";
const KEY_PROVIDERS: ProviderId[] = ["openai", "anthropic", "gemini"];

const DEFAULT_MODEL: Record<ProviderId, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  gemini: "gemini-1.5-flash",
};

interface ProviderCfg {
  keyEnc?: string;
  hint?: string;
  model?: string;
}
interface Settings {
  activeProvider?: ProviderId | "demo";
  providers?: Partial<Record<ProviderId, ProviderCfg>>;
}

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

/** The safe, client-facing view of the settings (no raw keys). */
function publicView(s: Settings) {
  const providers: Record<string, { configured: boolean; hint: string | null; model: string }> = {};
  for (const p of KEY_PROVIDERS) {
    const cfg = s.providers?.[p];
    providers[p] = {
      configured: Boolean(cfg?.keyEnc),
      hint: cfg?.hint ?? null,
      model: cfg?.model ?? DEFAULT_MODEL[p],
    };
  }
  return { activeProvider: s.activeProvider ?? null, providers };
}

// --- Settings routes -------------------------------------------------------

// The regular settings route is now READ-ONLY and reflects the global config,
// so the app can tell whether AI features are available. Only admins can change
// the configuration (see the admin router, which calls the exported helpers).
export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get("/", async (_req, res) => {
  res.json(publicView(await getLlmSettings()));
});

// --- Admin-facing global LLM configuration helpers -------------------------

export async function getLlmPublicView() {
  return publicView(await getLlmSettings());
}

export async function setLlmProviderKey(
  provider: string,
  fields: { apiKey?: string; model?: string },
) {
  if (!KEY_PROVIDERS.includes(provider as ProviderId)) throw new Error("Unknown provider");
  const p = provider as ProviderId;
  const settings = await getLlmSettings();
  settings.providers = settings.providers ?? {};
  const cfg: ProviderCfg = settings.providers[p] ?? {};
  if (typeof fields.apiKey === "string" && fields.apiKey.trim()) {
    const key = fields.apiKey.trim();
    cfg.keyEnc = encrypt(key);
    cfg.hint = key.slice(-4);
  }
  if (typeof fields.model === "string" && fields.model.trim()) cfg.model = fields.model.trim();
  settings.providers[p] = cfg;
  if (!settings.activeProvider && cfg.keyEnc) settings.activeProvider = p;
  await saveLlmSettings(settings);
  return publicView(settings);
}

export async function removeLlmProvider(provider: string) {
  const p = provider as ProviderId;
  const settings = await getLlmSettings();
  if (settings.providers) delete settings.providers[p];
  if (settings.activeProvider === p) settings.activeProvider = undefined;
  await saveLlmSettings(settings);
  return publicView(settings);
}

export async function setLlmActiveProvider(provider: string | null) {
  const settings = await getLlmSettings();
  if (provider === "demo") {
    settings.activeProvider = "demo";
  } else if (provider && KEY_PROVIDERS.includes(provider as ProviderId) && settings.providers?.[provider as ProviderId]?.keyEnc) {
    settings.activeProvider = provider as ProviderId;
  } else if (provider === null || provider === "") {
    settings.activeProvider = undefined;
  } else {
    throw new Error("Provider not configured");
  }
  await saveLlmSettings(settings);
  return publicView(settings);
}

// --- Provider calls --------------------------------------------------------

interface JustifyResult {
  justification: string;
  enhancedPrediction: string;
}

const SYSTEM_PROMPT =
  "You are an expert in classical Indian Vedic astrology (Jyotisha). Justify the " +
  "interpretation using ONLY the classical references provided — cite them by name " +
  "and never invent sources. Be specific to the given chart facts, balanced, and " +
  "non-fatalistic. When the subject is a divisional chart (a D-chart), follow the " +
  "classical method: FIRST weigh the D1 baseline for that life-area (the D1 sets the " +
  "underlying potential), THEN how the divisional chart expresses it, THEN how the " +
  "currently-running dasha lord (if given in the facts) times and colours it now. " +
  "Respond ONLY with a JSON object of the form " +
  '{"justification": string, "enhancedPrediction": string}. ' +
  "justification: 2–4 sentences on WHY the reading holds, citing the sources. " +
  "enhancedPrediction: a richer, personalised 2–4 sentence reading building on the base prediction.";

function buildUserPrompt(p: JustifyRequest): string {
  const parts = [
    `Subject: ${p.subject}`,
    `Base prediction: ${p.basePrediction}`,
  ];
  // Inject D-chart analysis guidelines (if any) before the chart facts so the
  // LLM frames its response around the D1-baseline and dasha-observation rules.
  if (p.guidelines && p.guidelines.length > 0) {
    parts.push("Analytical guidelines (follow these when structuring your response):");
    p.guidelines.forEach((g) => parts.push(`- ${g}`));
  }
  parts.push(
    "Chart facts:",
    ...p.facts.map((f) => `- ${f}`),
    "Classical references (paraphrased):",
    ...p.references.map((r) => `- [${r.source}] ${r.text}`),
    p.language && p.language !== "English"
      ? `Write your entire response in ${p.language}, using its native script (keep planet, sign and yoga names recognisable).`
      : "Now write the response.",
  );
  return parts.join("\n");
}

// Prose variant for streaming (no JSON — natural language flows better token-by-token).
const STREAM_SYSTEM_PROMPT =
  "You are an expert in classical Indian Vedic astrology (Jyotisha). Ground every " +
  "claim in ONLY the classical references provided — cite them by name and never " +
  "invent sources. Be specific to the given chart facts, balanced and non-fatalistic. " +
  "When the subject is a divisional chart (a D-chart), follow the classical method: " +
  "first weigh the D1 baseline for that life-area (the D1 sets the underlying potential), " +
  "then how the divisional chart expresses it, then how the currently-running dasha lord " +
  "(if given in the facts) times and colours it now. " +
  "Write two short paragraphs of plain prose (no markdown, no headings): first a " +
  "justification of the reading citing the sources; then an enhanced, personalised " +
  "prediction. Keep the whole reply under ~180 words.";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseResult(text: string, fallbackBase: string): JustifyResult {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.justification === "string") {
      return {
        justification: obj.justification,
        enhancedPrediction:
          typeof obj.enhancedPrediction === "string" ? obj.enhancedPrediction : fallbackBase,
      };
    }
  } catch {
    /* fall through */
  }
  return { justification: text.trim(), enhancedPrediction: fallbackBase };
}

async function callOpenAI(key: string, model: string, user: string, base: string): Promise<JustifyResult> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  return parseResult(data.choices?.[0]?.message?.content ?? "", base);
}

async function callAnthropic(key: string, model: string, user: string, base: string): Promise<JustifyResult> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { content: Array<{ text: string }> };
  return parseResult(data.content?.[0]?.text ?? "", base);
}

async function callGemini(key: string, model: string, user: string, base: string): Promise<JustifyResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
    }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return parseResult(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "", base);
}

/** Offline demo synthesis from the structured references — no key needed. */
function demoResult(p: JustifyRequest): JustifyResult {
  const sources = [...new Set(p.references.map((r) => r.source))].join(", ");
  const justification =
    (sources ? `Classical authorities (${sources}) support this reading. ` : "") +
    p.references.map((r) => r.text).join(" ") +
    (p.facts.length ? ` In your chart specifically: ${p.facts.join("; ")}.` : "");
  const enhancedPrediction =
    `${p.basePrediction} Taken together, ${p.subject.toLowerCase()} is best worked with ` +
    "consciously — lean into its strengths and give patient effort where it is tested; " +
    "the running dasha and transits set the timing.";
  return { justification, enhancedPrediction };
}

interface JustifyRequest {
  subject: string;
  basePrediction: string;
  facts: string[];
  references: Array<{ source: string; text: string }>;
  language?: string; // English name of the target language (translate output)
  /** Analytical guidelines the LLM should follow when structuring the
   *  justification — e.g. D1-first cross-reference, dasha lord placement. */
  guidelines?: string[];
}

export const llmRouter = Router();
llmRouter.use(requireAuth);

// Block free-plan users from Justify, Translate, and Stream endpoints.
import {
  getUserPlan,
  createChatConversation, getChatConversation, addChatMessage,
} from "./db";
import {
  checkDailyQuota,
  getPlanDailyLimit,
  llmCacheKey,
  getLlmCached,
  setLlmCached,
} from "./rateLimit";

async function requirePaidPlan(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  const userId = (req as import("express").Request & { userId: string }).userId;
  const plan = await getUserPlan(userId);
  if (plan === "free") {
    res.status(403).json({ error: "Upgrade to Pro or Premium to use AI features (Justify, Translate)." });
    return;
  }
  // Attach plan for downstream quota checks
  (req as any)._plan = plan;
  (req as any)._userId = userId;
  next();
}

llmRouter.post("/justify", requirePaidPlan, async (req, res) => {
  const body = (req.body ?? {}) as Partial<JustifyRequest>;
  if (!body.subject || !body.basePrediction || !Array.isArray(body.references)) {
    res.status(400).json({ error: "subject, basePrediction and references are required" });
    return;
  }

  const userId = (req as any)._userId as string;
  const plan = (req as any)._plan as string;

  // Daily quota check
  const dailyLimit = getPlanDailyLimit(plan, "justify");
  const quota = checkDailyQuota(userId, "justify", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily Justify limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  const request: JustifyRequest = {
    subject: body.subject,
    basePrediction: body.basePrediction,
    facts: Array.isArray(body.facts) ? body.facts : [],
    references: body.references,
    language: body.language,
    guidelines: Array.isArray(body.guidelines) ? body.guidelines : undefined,
  };

  // Check LLM response cache
  const cacheKey = llmCacheKey(userId, request.subject, request.basePrediction, request.language);
  const cached = getLlmCached(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const settings = await getLlmSettings();
  const active = settings.activeProvider;

  try {
    if (!active || active === "demo") {
      const result = { provider: "demo", model: "offline", references: request.references, ...demoResult(request) };
      res.json(result);
      return;
    }
    const cfg = settings.providers?.[active];
    if (!cfg?.keyEnc) {
      res.status(400).json({ error: `${active} is not configured` });
      return;
    }
    const key = decrypt(cfg.keyEnc);
    const model = cfg.model ?? DEFAULT_MODEL[active];
    const user = buildUserPrompt(request);
    const result =
      active === "openai"
        ? await callOpenAI(key, model, user, request.basePrediction)
        : active === "anthropic"
          ? await callAnthropic(key, model, user, request.basePrediction)
          : await callGemini(key, model, user, request.basePrediction);
    const response = { provider: active, model, references: request.references, ...result };
    // Cache the response
    setLlmCached(cacheKey, response);
    res.json(response);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "LLM request failed" });
  }
});

// --- Translation -----------------------------------------------------------

async function callOpenAIText(key: string, model: string, system: string, user: string): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
  const data = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropicText(key: string, model: string, system: string, user: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
  const data = (await r.json()) as { content: Array<{ text: string }> };
  return data.content?.[0]?.text ?? "";
}

async function callGeminiText(key: string, model: string, system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}`);
  const data = (await r.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

llmRouter.post("/translate", requirePaidPlan, async (req, res) => {
  const { items, language } = (req.body ?? {}) as { items?: string[]; language?: string };
  if (!Array.isArray(items) || !language) {
    res.status(400).json({ error: "items[] and language are required" });
    return;
  }

  const userId = (req as any)._userId as string;
  const plan = (req as any)._plan as string;

  // Daily quota check
  const dailyLimit = getPlanDailyLimit(plan, "translate");
  const quota = checkDailyQuota(userId, "translate", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily Translate limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  const settings = await getLlmSettings();
  const active = settings.activeProvider;

  // Demo / off: translation needs a real model, so echo back unchanged.
  if (!active || active === "demo") {
    res.json({ provider: "demo", language, translations: items, translated: false });
    return;
  }

  const cfg = settings.providers?.[active as ProviderId];
  if (!cfg?.keyEnc) {
    res.status(400).json({ error: `${active} is not configured` });
    return;
  }

  try {
    const key = decrypt(cfg.keyEnc);
    const model = cfg.model ?? DEFAULT_MODEL[active as ProviderId];
    const system =
      `You are a professional translator of Vedic astrology text into ${language}. ` +
      "Translate each input string into natural, fluent " + language + " using its native script. " +
      "Keep proper nouns (planet, sign, nakshatra and yoga names) recognisable — you may transliterate them. " +
      'Respond ONLY with JSON of the form {"translations": string[]} — the same length and order as the input.';
    const user = JSON.stringify({ items });
    const text =
      active === "openai"
        ? await callOpenAIText(key, model, system, user)
        : active === "anthropic"
          ? await callAnthropicText(key, model, system, user)
          : await callGeminiText(key, model, system, user);

    const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    let translations = items;
    try {
      const parsed = JSON.parse(cleaned) as { translations?: string[] };
      if (Array.isArray(parsed.translations) && parsed.translations.length === items.length) {
        translations = parsed.translations;
      }
    } catch {
      /* keep originals on parse failure */
    }
    res.json({ provider: active, language, translations, translated: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Translation failed" });
  }
});

// --- Streaming justification (Server-Sent Events) --------------------------

type DeltaExtractor = (json: unknown) => string;

/** Read a provider's SSE stream, extract text deltas, and forward them to the client. */
async function pipeStream(
  body: ReadableStream<Uint8Array>,
  extract: DeltaExtractor,
  send: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]" || data === "") continue;
      try {
        const delta = extract(JSON.parse(data));
        if (delta) send(delta);
      } catch {
        /* keep-alive or partial line — ignore */
      }
    }
  }
}

const EXTRACT: Record<ProviderId, DeltaExtractor> = {
  openai: (j) => (j as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "",
  anthropic: (j) => {
    const e = j as { type?: string; delta?: { text?: string } };
    return e.type === "content_block_delta" ? e.delta?.text ?? "" : "";
  },
  gemini: (j) =>
    (j as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      .candidates?.[0]?.content?.parts?.[0]?.text ?? "",
};

async function openProviderStream(
  provider: ProviderId,
  key: string,
  model: string,
  user: string,
): Promise<ReadableStream<Uint8Array>> {
  let r: Response;
  if (provider === "openai") {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.6,
        messages: [
          { role: "system", content: STREAM_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
    });
  } else if (provider === "anthropic") {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 1024,
        system: STREAM_SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
      }),
    });
  } else {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: STREAM_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.6 },
      }),
    });
  }
  if (!r.ok || !r.body) throw new Error(`${provider} error ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.body as ReadableStream<Uint8Array>;
}

llmRouter.post("/justify/stream", requirePaidPlan, async (req, res) => {
  const body = (req.body ?? {}) as Partial<JustifyRequest>;
  if (!body.subject || !body.basePrediction || !Array.isArray(body.references)) {
    res.status(400).json({ error: "subject, basePrediction and references are required" });
    return;
  }

  const userId = (req as any)._userId as string;
  const plan = (req as any)._plan as string;

  // Daily quota check
  const dailyLimit = getPlanDailyLimit(plan, "justify_stream");
  const quota = checkDailyQuota(userId, "justify_stream", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily Justify limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  const request: JustifyRequest = {
    subject: body.subject,
    basePrediction: body.basePrediction,
    facts: Array.isArray(body.facts) ? body.facts : [],
    references: body.references,
    language: body.language,
    guidelines: Array.isArray(body.guidelines) ? body.guidelines : undefined,
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const send = (text: string) => res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);

  try {
    const settings = await getLlmSettings();
    const active = settings.activeProvider;

    if (!active || active === "demo") {
      event("meta", { provider: "demo", model: "offline" });
      const { justification, enhancedPrediction } = demoResult(request);
      const narrative = `${justification}\n\n${enhancedPrediction}`;
      for (const token of narrative.match(/\S+\s*/g) ?? []) {
        if (res.writableEnded) break;
        send(token);
        await sleep(18);
      }
      event("done", {});
      res.end();
      return;
    }

    const cfg = settings.providers?.[active];
    if (!cfg?.keyEnc) {
      event("error", { error: `${active} is not configured` });
      res.end();
      return;
    }
    const key = decrypt(cfg.keyEnc);
    const model = cfg.model ?? DEFAULT_MODEL[active];
    event("meta", { provider: active, model });
    const stream = await openProviderStream(active, key, model, buildUserPrompt(request));
    await pipeStream(stream, EXTRACT[active], send);
    event("done", {});
    res.end();
  } catch (err) {
    event("error", { error: err instanceof Error ? err.message : "LLM stream failed" });
    res.end();
  }
});

// --- Vastu analysis (combines rule-based result with LLM vision) -----------

const VASTU_SYSTEM_PROMPT =
  "You are an expert in Vastu Shastra and Vedic astrology (Jyotisha). Analyze the property " +
  "for Vastu compliance based on the questionnaire answers and the native's birth chart. " +
  "If a floor plan image is provided, examine it for Vastu issues visible in the layout. " +
  "Ground your analysis in classical Vastu texts (Mayamatam, Brihat Samhita, Manasara, Vishwakarma Vastu Shastra). " +
  "Be specific, practical, and balanced. For each issue found, suggest an actionable remedy. " +
  "Respond ONLY with a JSON object: " +
  '{"analysis": string, "floorPlanObservations": string | null, "additionalRemedies": string[]}. ' +
  "analysis: 3-5 sentences summarizing the overall Vastu-Jyotish compatibility. " +
  "floorPlanObservations: if a floor plan was provided, 2-4 sentences on what you observe (null if no plan). " +
  "additionalRemedies: 2-4 concise remedies not already covered by the rule-based analysis.";

interface VastuLlmRequest {
  chartSummary: string;
  vastuSummary: string;
  references: string[];
  floorPlanBase64?: string; // data:image/... or raw base64
  language?: string;
}

interface VastuLlmResult {
  analysis: string;
  floorPlanObservations: string | null;
  additionalRemedies: string[];
}

function buildVastuPrompt(req: VastuLlmRequest): string {
  const parts = [
    "Chart summary:",
    req.chartSummary,
    "",
    "Vastu analysis summary:",
    req.vastuSummary,
    "",
    "Classical references:",
    ...req.references.map((r) => `- ${r}`),
  ];
  if (req.language && req.language !== "English") {
    parts.push("", `Write your entire response in ${req.language}, using its native script.`);
  }
  return parts.join("\n");
}

async function callOpenAIVastu(key: string, model: string, userPrompt: string, imageB64?: string): Promise<VastuLlmResult> {
  const content: any[] = [{ type: "text", text: userPrompt }];
  if (imageB64) {
    const data = imageB64.startsWith("data:") ? imageB64 : `data:image/jpeg;base64,${imageB64}`;
    content.push({ type: "image_url", image_url: { url: data, detail: "low" } });
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: imageB64 ? "gpt-4o" : model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: VASTU_SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data2 = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  return parseVastuResult(data2.choices?.[0]?.message?.content ?? "");
}

async function callAnthropicVastu(key: string, model: string, userPrompt: string, imageB64?: string): Promise<VastuLlmResult> {
  const content: any[] = [];
  if (imageB64) {
    const raw = imageB64.startsWith("data:") ? imageB64.split(",")[1] : imageB64;
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: raw },
    });
  }
  content.push({ type: "text", text: userPrompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: imageB64 ? "claude-sonnet-4-20250514" : model,
      max_tokens: 1024,
      system: VASTU_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data2 = (await r.json()) as { content: Array<{ text: string }> };
  return parseVastuResult(data2.content?.[0]?.text ?? "");
}

async function callGeminiVastu(key: string, model: string, userPrompt: string, imageB64?: string): Promise<VastuLlmResult> {
  const useModel = imageB64 ? "gemini-2.0-flash" : model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(key)}`;
  const parts: any[] = [{ text: VASTU_SYSTEM_PROMPT + "\n\n" + userPrompt }];
  if (imageB64) {
    const raw = imageB64.startsWith("data:") ? imageB64.split(",")[1] : imageB64;
    parts.push({ inline_data: { mime_type: "image/jpeg", data: raw } });
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data2 = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data2.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseVastuResult(text);
}

function parseVastuResult(raw: string): VastuLlmResult {
  const fallback: VastuLlmResult = { analysis: raw.trim(), floorPlanObservations: null, additionalRemedies: [] };
  try {
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      analysis: parsed.analysis ?? raw.trim(),
      floorPlanObservations: parsed.floorPlanObservations ?? null,
      additionalRemedies: Array.isArray(parsed.additionalRemedies) ? parsed.additionalRemedies : [],
    };
  } catch {
    return fallback;
  }
}

llmRouter.post("/vastu", requireFeature("vastu"), requirePaidPlan, async (req, res) => {
  const body = (req.body ?? {}) as Partial<VastuLlmRequest>;
  if (!body.chartSummary || !body.vastuSummary) {
    res.status(400).json({ error: "chartSummary and vastuSummary are required" });
    return;
  }

  const userId = (req as any)._userId as string;
  const plan = (req as any)._plan as string;

  // Daily quota check
  const dailyLimit = getPlanDailyLimit(plan, "vastu");
  const quota = checkDailyQuota(userId, "vastu", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily Vastu analysis limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  // Validate image size if provided (max 2MB base64)
  if (body.floorPlanBase64 && body.floorPlanBase64.length > 2_800_000) {
    res.status(400).json({ error: "Floor plan image is too large (max 2MB)" });
    return;
  }

  const request: VastuLlmRequest = {
    chartSummary: body.chartSummary,
    vastuSummary: body.vastuSummary,
    references: Array.isArray(body.references) ? body.references : [],
    floorPlanBase64: body.floorPlanBase64,
    language: body.language,
  };

  try {
    const settings = await getLlmSettings();
    const active = settings?.activeProvider;
    if (!active || active === "demo") {
      // Demo fallback — no LLM call
      res.json({
        provider: "demo",
        analysis: "Configure an AI provider (OpenAI, Anthropic, or Gemini) in AI Settings to get detailed Vastu-Jyotish analysis with floor plan observations.",
        floorPlanObservations: null,
        additionalRemedies: [
          "Keep the NE corner of your home clean and clutter-free for positive energy flow.",
          "Place a Tulsi plant near the entrance for prosperity.",
          "Ensure the main entrance is well-lit and opens clockwise.",
        ],
      });
      return;
    }

    const cfg = settings.providers?.[active as ProviderId];
    if (!cfg?.keyEnc) {
      res.status(503).json({ error: `${active} is configured but no API key is set` });
      return;
    }
    const key = decrypt(cfg.keyEnc);
    const model = cfg.model ?? DEFAULT_MODEL[active as ProviderId];
    const prompt = buildVastuPrompt(request);

    let result: VastuLlmResult;
    switch (active) {
      case "openai":
        result = await callOpenAIVastu(key, model, prompt, request.floorPlanBase64);
        break;
      case "anthropic":
        result = await callAnthropicVastu(key, model, prompt, request.floorPlanBase64);
        break;
      case "gemini":
        result = await callGeminiVastu(key, model, prompt, request.floorPlanBase64);
        break;
      default:
        res.status(503).json({ error: `Unknown provider: ${active}` });
        return;
    }

    res.json({ provider: active, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Vastu analysis failed" });
  }
});

// ── Astro Chat (Phase 1) ────────────────────────────────────────────────────
// A multi-turn, streaming chat grounded in the user's chart + current module.
// See docs/astro-chat.md. Reuses the provider streaming layer (openChatStream
// mirrors openProviderStream but takes a full message history + custom system).

const CHAT_SYSTEM_PROMPT =
  "You are Astro Chat, a warm, knowledgeable guide to classical Indian Vedic " +
  "astrology (Jyotisha) inside an astrology app. Answer the user's questions about " +
  "their chart and readings in clear, plain language. Ground your answers in the " +
  "chart context provided below when it is relevant; if the context doesn't cover " +
  "the question, reason from standard Jyotisha principles and say so. Be specific, " +
  "balanced and non-fatalistic — never predict death, disease, or catastrophe. " +
  "Politely decline medical, legal, financial or investment advice and suggest a " +
  "qualified professional. Stay within astrology and this app's features; if asked " +
  "something unrelated, gently steer back. Keep replies concise (usually under " +
  "~200 words) and end sensitive readings with a brief reminder to verify with a " +
  "qualified astrologer.";

const CHAT_MAX_HISTORY = 16;       // turns kept (trim older context to bound cost)
const CHAT_MAX_MSG_CHARS = 4000;   // per-message input cap
const CHAT_MAX_TOKENS = 700;       // reply length cap

type ChatRole = "user" | "assistant";
interface ChatMsg { role: ChatRole; content: string; }
interface ChatContext {
  chart?: { label?: string; summary?: string };
  module?: string;
  findings?: string[];
}

function buildChatSystem(ctx: ChatContext | undefined): string {
  const lines: string[] = [CHAT_SYSTEM_PROMPT];
  if (ctx?.chart?.summary) {
    lines.push(
      "",
      `--- Chart context${ctx.chart.label ? ` for ${ctx.chart.label}` : ""} ---`,
      ctx.chart.summary.slice(0, 2000),
    );
  }
  if (Array.isArray(ctx?.findings) && ctx!.findings!.length) {
    lines.push(
      "",
      "--- App-computed findings for this chart (prefer these over generic reasoning) ---",
      ctx!.findings!.slice(0, 40).map((f) => `- ${String(f).slice(0, 300)}`).join("\n"),
    );
  }
  if (ctx?.module) lines.push("", `The user is currently viewing the "${ctx.module}" section; weight your answer toward it.`);
  return lines.join("\n");
}

/** Streaming provider call with a full message history + custom system prompt. */
async function openChatStream(
  provider: ProviderId,
  key: string,
  model: string,
  system: string,
  messages: ChatMsg[],
): Promise<ReadableStream<Uint8Array>> {
  let r: Response;
  if (provider === "openai") {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.6,
        max_tokens: CHAT_MAX_TOKENS,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
  } else if (provider === "anthropic") {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, max_tokens: CHAT_MAX_TOKENS, system, messages }),
    });
  } else {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 0.6, maxOutputTokens: CHAT_MAX_TOKENS },
      }),
    });
  }
  if (!r.ok || !r.body) throw new Error(`${provider} error ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.body as ReadableStream<Uint8Array>;
}

llmRouter.post("/chat/stream", requireFeature("chat"), async (req, res) => {
  const userId = uid(req);
  const body = (req.body ?? {}) as {
    messages?: unknown; context?: ChatContext; conversationId?: string; chartId?: string;
  };

  // Validate + sanitize the message history.
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMsg[] = raw
    .filter((m): m is ChatMsg =>
      !!m && typeof (m as ChatMsg).content === "string" &&
      ((m as ChatMsg).role === "user" || (m as ChatMsg).role === "assistant"))
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_MAX_MSG_CHARS) }))
    .slice(-CHAT_MAX_HISTORY);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    res.status(400).json({ error: "messages must end with a user turn" });
    return;
  }

  // Daily quota (free plan gets a small allowance; no paid gate).
  const plan = await getUserPlan(userId);
  const quota = checkDailyQuota(userId, "chat", getPlanDailyLimit(plan, "chat"));
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily chat limit reached (${quota.limit}/day). ${plan === "free" ? "Upgrade to Pro or Premium for more." : "Try again tomorrow."}`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  // Resolve (or create) the conversation and persist the new user turn.
  const lastUser = messages[messages.length - 1].content;
  let conv = body.conversationId ? await getChatConversation(userId, body.conversationId) : null;
  if (!conv) {
    const title = lastUser.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
    conv = await createChatConversation(userId, title, body.chartId ?? null);
  }
  const conversationId = conv.id;
  await addChatMessage(conversationId, "user", lastUser);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let assistant = "";
  const send = (text: string) => { assistant += text; res.write(`data: ${JSON.stringify({ delta: text })}\n\n`); };

  try {
    const settings = await getLlmSettings();
    const active = settings.activeProvider;
    const system = buildChatSystem(body.context);

    if (!active || active === "demo") {
      event("meta", { provider: "demo", model: "offline", conversationId });
      send("AI chat isn't fully configured yet, so this is a demo reply. ");
      send("Once an AI provider is enabled in admin settings, I can answer questions about your chart in detail.");
      await addChatMessage(conversationId, "assistant", assistant);
      event("done", { conversationId });
      res.end();
      return;
    }

    const cfg = settings.providers?.[active];
    if (!cfg?.keyEnc) {
      event("error", { error: `${active} is not configured` });
      res.end();
      return;
    }
    const key = decrypt(cfg.keyEnc);
    const model = cfg.model ?? DEFAULT_MODEL[active];
    event("meta", { provider: active, model, conversationId });
    const stream = await openChatStream(active, key, model, system, messages);
    await pipeStream(stream, EXTRACT[active], send);
    if (assistant.trim()) await addChatMessage(conversationId, "assistant", assistant);
    event("done", { conversationId });
    res.end();
  } catch (err) {
    // Persist whatever streamed before the failure so history isn't lost.
    if (assistant.trim()) await addChatMessage(conversationId, "assistant", assistant).catch(() => {});
    event("error", { error: err instanceof Error ? err.message : "Chat stream failed" });
    res.end();
  }
});
