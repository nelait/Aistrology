/**
 * Astro Chat golden-set eval (Layers 1–3 in docs/astro-chat.md § Validation).
 *
 * End-to-end grounding check against the LIVE chat API: factual anchors +
 * cross-profile differentiation. Uses the same buildChatContext the app uses, so
 * it validates the real path. This is the NIGHTLY / pre-release layer — it costs
 * real tokens and is mildly non-deterministic, so it is NOT part of `npm test`.
 *
 * Prereqs: the API running (npm run dev:all) with an ACTIVE real engine
 * (Admin → AI/LLM), and dev login enabled (ALLOW_DEV_LOGIN=true).
 *
 * Run:  npm run eval:chat          (defaults to http://localhost:8787)
 *       BASE_URL=https://… npm run eval:chat
 */
import { computeChart } from "../src/astro/engine";
import { detectDoshas } from "../src/astro/doshas";
import { buildChatContext } from "../src/chat/context";
import { findChartContradictions } from "../src/chat/contradictions";
import { RASHIS } from "../src/astro/constants";
import type { BirthData } from "../src/astro/types";
import type { Chart } from "../src/astro/types";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

const PROFILE_A: BirthData = {
  name: "Asha (Delhi 1990)",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India",
};
const PROFILE_B: BirthData = {
  name: "Ravi (Chennai 1985)",
  year: 1985, month: 6, day: 15, hour: 6, minute: 30, second: 0,
  tzOffsetHours: 5.5, latitude: 13.0827, longitude: 80.2707, placeLabel: "Chennai, India",
};

async function login(name: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/dev/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`dev login failed (${res.status}) — is ALLOW_DEV_LOGIN=true?`);
  const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [res.headers.get("set-cookie") ?? ""];
  const session = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("aistro_session="));
  if (!session) throw new Error("no session cookie returned from dev login");
  return session;
}

/** Send one chat turn and return the full concatenated reply (or throw on error). */
async function ask(cookie: string, context: unknown, question: string): Promise<string> {
  const res = await fetch(`${BASE}/api/llm/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: question }], context }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json())?.error ?? msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: { delta?: string; error?: string };
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === "error") throw new Error(parsed.error ?? "stream error");
      if (parsed.delta) text += parsed.delta;
    }
  }
  return text;
}

const has = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());

interface Result { name: string; pass: boolean; detail: string; }

async function run(): Promise<void> {
  const results: Result[] = [];
  const record = (name: string, pass: boolean, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };

  // Fresh dev user per run → fresh daily quota. The eval makes 5 LLM calls, which
  // fits the free plan's 5/day; if you add more checks, promote this user's plan.
  const cookie = await login(`Chat Eval ${Date.now()}`);
  const chartA = computeChart(PROFILE_A);
  const chartB = computeChart(PROFILE_B);
  const ascA = RASHIS[chartA.ascendantSign].name;
  const ascB = RASHIS[chartB.ascendantSign].name;
  const ctxA = buildChatContext({ chart: chartA, moduleLabel: "Kundli" });
  const ctxB = buildChatContext({ chart: chartB, moduleLabel: "Kundli" });

  // 1. Factual anchor: ascendant per profile.
  try {
    const q = "What is my ascendant (Lagna) sign? Reply with just the sign name.";
    const a = await ask(cookie, ctxA, q);
    record(`A ascendant is ${ascA}`, has(a, ascA), `reply: "${a.trim().slice(0, 80)}"`);
    const b = await ask(cookie, ctxB, q);
    record(`B ascendant is ${ascB}`, has(b, ascB), `reply: "${b.trim().slice(0, 80)}"`);

    // 2. Cross-profile differentiation: no leakage of the other profile's Lagna.
    record("A does not leak B's ascendant", !has(a, ascB));
    record("B does not leak A's ascendant", !has(b, ascA));
  } catch (e) {
    record("ascendant/differentiation", false, (e as Error).message);
  }

  // 3. Dosha grounding: the reply should reflect detectDoshas, not generic text.
  try {
    const doshas = detectDoshas(chartA).map((d) => d.name);
    const a = await ask(cookie, ctxA, "List the doshas in my chart by name, or say none.");
    if (doshas.length === 0) {
      record("A dosha grounding (expected none)", /\bnone\b|no (major )?dosha/i.test(a), `reply: "${a.trim().slice(0, 80)}"`);
    } else {
      const missing = doshas.filter((d) => !has(a, d.split(" ")[0]));
      record(`A dosha grounding (${doshas.join(", ")})`, missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : `reply: "${a.trim().slice(0, 80)}"`);
    }
  } catch (e) {
    record("dosha grounding", false, (e as Error).message);
  }

  // 4. Faithfulness: a free-form reading must not contradict the actual chart.
  try {
    const noContradiction = async (label: string, chart: Chart, ctx: unknown) => {
      const reply = await ask(cookie, ctx, "Give a short reading of my ascendant and Sun sign placement.");
      const bad = findChartContradictions(reply, chart);
      record(`${label} reading has no chart contradictions`, bad.length === 0,
        bad.length ? bad.map((c) => `${c.subject}: said ${c.claimed}, actual ${c.actual}`).join("; ")
                   : `reply: "${reply.trim().slice(0, 80)}"`);
    };
    await noContradiction("A", chartA, ctxA);
    await noContradiction("B", chartB, ctxB);
  } catch (e) {
    record("contradiction scan", false, (e as Error).message);
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error("eval failed to run:", (e as Error).message); process.exit(1); });
