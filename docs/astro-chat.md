# Astro Chat

A logged-in, streaming **AI chat** grounded in the user's own chart and whatever
module they're looking at. The goal: *"whatever we do through the modules, we can
also talk to the AI about."*

> **Not medical/financial/legal advice.** Like every AI feature in the app, chat
> is astrology guidance for reflection, streamed from the admin-configured
> provider, and should be verified with a qualified astrologer.

## Enabling & operating

The **✦ Astro Chat** launcher appears bottom-right on the main app page for a
signed-in user **only when all three hold** (the same gate as the Justify
buttons — if any is off, nothing shows):

1. **An AI engine is active.** Admin console → **AI / LLM** → *Active engine* →
   pick a configured provider (e.g. OpenAI) or **Demo (offline)**. If this is
   `Off`, the launcher is hidden even though a key may be saved. (This is the
   usual reason "I don't see the chat button.")
2. **The `chat` feature flag is on** (default). Admin console → **Features** →
   *Astro Chat*.
3. **The user is signed in** and on the main reading page (not a sub-page like
   Admin/Consultation).

Notes:
- With **Demo** active, chat shows a canned reply (no key, no cost) — good for a
  quick smoke test. With a real provider, replies are streamed live and **cost
  tokens on that provider's account**.
- Per-plan daily message quotas apply (see below); free users get a small taste.
- No new secrets: chat reuses the global provider key configured under AI / LLM.

## What it reuses

Astro Chat is deliberately **not** a new AI stack. It builds on the existing LLM
layer in [`server/llm.ts`](../server/llm.ts):

| Existing capability | Reused for chat |
| ------------------- | --------------- |
| Provider abstraction (OpenAI / Anthropic / Gemini + offline `demo`) | Same providers, same encrypted admin key |
| SSE streaming (`pipeStream`, `EXTRACT` per provider) | Token-by-token chat replies |
| Admin-managed global engine (`getLlmSettings`, `activeProvider`) | Chat uses the same active engine |
| Per-plan daily quotas (`PLAN_DAILY_LIMITS`, `checkDailyQuota`) | New `chat` quota key |
| Feature flags (`requireFeature`) | New `chat` flag |
| Client SSE reader (`api.justifyStream`) | New `api.chatStream` (same shape) |

**Key architectural fact:** astrology computation lives on the **client**
(`src/astro/*`); the server LLM endpoints are **stateless context-takers**. The
`Justify` feature already proves this — the client computes the facts and posts
them. Chat follows the same pattern: the client assembles a **context** from the
loaded chart + active module and sends it with each turn.

## Architecture

```
  ┌────────────────────────────┐        POST /api/llm/chat/stream (SSE)
  │ ChatPanel.tsx (client)      │  ───────────────────────────────────────►
  │ • holds message history     │        { messages:[...], context:{...} }
  │ • summarizes loaded chart   │
  │ • picks up current module   │        ┌──────────────────────────────┐
  └────────────────────────────┘        │ server/llm.ts                 │
             ▲                           │ • requireFeature("chat")       │
             │  data: {delta} … [done]   │ • daily quota (chat)           │
             └───────────────────────────┤ • system = CHAT_PROMPT+context │
                                         │ • openChatStream(messages)     │
                                         │ • pipeStream → SSE             │
                                         └───────────────┬────────────────┘
                                                         ▼  provider stream
                                            OpenAI / Anthropic / Gemini / demo
```

### Context injection

Each turn carries a compact `context` the model is told to ground its answers in:

```ts
type ChatContext = {
  chart?: {
    label: string;        // profile name
    summary: string;      // ascendant + planet placements, one line each
  };
  module?: string;        // the tab/module the user is in (Kundli, Doshas, …)
  findings?: string[];    // app-computed results to ground answers in
};
```

The chart summary is built once on the client from the computed `Chart` object.
The `findings` array is what makes free-typed questions *specific* rather than
generic: the server renders it under an **"App-computed findings (prefer these
over generic reasoning)"** block in the system prompt. Two sources feed it:

- **Doshas — always.** ChatPanel runs `detectDoshas(chart)` itself and injects
  the detected doshas (or "none present") on every turn, since they're a core,
  deterministic chart property. This is why "do I have any doshas?" now names the
  actual doshas instead of giving a textbook answer.
- **Active module — while visible.** A module publishes its own computed results
  via `usePublishChatContext(findings)`; ChatPanel merges them in. Wired into
  **Muhurta** (the searched days + ratings/Panchanga) and **Vastu** (score,
  verdict, room/astro factors). The hook clears on unmount, so the chat only ever
  sees the tab you're actually on.

**Module hooks (Phase 3).** The same provider
([`src/chat/AstroChat.tsx`](../src/chat/AstroChat.tsx)) also exposes
`useAstroChat().ask(prompt)` and an `<AskAiButton prompt=… />`. Modules drop the
button next to a finding; clicking it opens the panel and starts a **fresh
conversation** seeded with a question that embeds that specific finding, while the
chart summary + findings are still injected automatically. The button hides
itself when chat isn't usable (same gate as the panel). Wired into Doshas (per
dosha), Muhurta (per day) and Vastu (overall result).

**Profile scoping.** ChatPanel resets its on-screen thread (messages +
`conversationId`) whenever the active profile (`chartId`) changes, so switching
charts starts a clean conversation instead of appending a new profile's turn to
the previous profile's thread. Past conversations remain in **History**.

### Plan gating & quotas

Chat is **not paid-only** (unlike Justify) — a small free allowance is the best
upgrade hook. Daily limits live in
[`server/rateLimit.ts`](../server/rateLimit.ts) under the `chat` key:

| Plan | Messages / day |
| ---- | -------------- |
| Basic (free) | 5 |
| Pro | 50 |
| Premium | 200 |

Enforced by `checkDailyQuota(userId, "chat", limit)`. A `429` returns an
upgrade-friendly message; the panel shows an "Upgrade" CTA for free users who hit
the cap. Cost is further bounded by capping `max_tokens`, **truncating history to
the last N turns**, and a per-message input length limit. The global per-IP
limiter in [`server/index.ts`](../server/index.ts) backstops abuse.

### Feature flag

A `chat` flag in [`server/features.ts`](../server/features.ts) lets an admin turn
the whole feature off (hides the launcher **and** blocks `/api/llm/chat/stream`),
consistent with the other modules. Default: enabled.

### Safety & privacy

- The chart summary + birth context go to the **admin-configured provider** —
  the same data-egress posture as `Justify` today; no new exposure.
- Conversations are scoped strictly to the signed-in user (no cross-user data).
- The system prompt keeps the assistant in the **astrology domain**, declines
  medical/financial/legal advice, and appends the standard verify-with-an-expert
  disclaimer.
- In `demo` mode (no provider key) chat degrades to a canned reply, like Justify.

## Validation

"Is the answer appropriate for the *selected profile*?" decomposes into three
separable properties, validated at different cost/certainty:

| Property | Question | How |
| -------- | -------- | --- |
| **A. Right inputs** | Is the context this profile's chart + findings? | Deterministic unit tests — certain, no LLM |
| **B. Faithful use** | Does the answer avoid contradicting that chart? | Anchored facts + contradiction scan |
| **C. Quality** | Relevant, in-scope, safe, non-fatalistic? | Sampled / judged eval |

The strategy is **certainty on A, automation on B, sampled confidence on C** —
not per-response certainty (LLM output is probabilistic).

### Layer 0 — context unit tests (`npm test`, every commit)

The context builders are a pure module,
[`src/chat/context.ts`](../src/chat/context.ts) (`summarizeChart`,
`summarizeDoshas`, `buildChatContext`), so they're tested deterministically in
[`src/chat/context.test.ts`](../src/chat/context.test.ts): a known birth →
correct ascendant/placements/doshas, and a **cross-profile isolation** suite that
builds context for two profiles with different ascendants and asserts neither
leaks into the other. This certifies the model always *receives* the selected
profile's data at zero LLM cost.

The runtime counterpart — the panel **resetting its thread when the active
profile (`chartId`) changes** — is covered by a component test,
[`src/components/ChatPanel.test.tsx`](../src/components/ChatPanel.test.tsx)
(jsdom + Testing Library, via a per-file `// @vitest-environment jsdom` so the
node suites are untouched). It sends a message, switches `chartId`, and asserts
the thread clears — closing the "old profile's history remained" bug — and that
an *unrelated* prop change does not reset it.

### Layers 1–3 — golden-set eval (`npm run eval:chat`, nightly / pre-release)

[`scripts/eval-chat.ts`](../scripts/eval-chat.ts) exercises the **live** API using
the same `buildChatContext`, over fixed test profiles:

- **Factual anchors** — "what's my ascendant?" must contain the computed sign.
- **Cross-profile differentiation** — the same question to profiles A and B must
  each name their own ascendant and **not leak the other's** (the definitive
  "selected profile" test).
- **Dosha grounding** — the reply must name the doshas from `detectDoshas`, not
  give a generic answer.
- **Contradiction scan** — every reading is run through
  [`findChartContradictions`](../src/chat/contradictions.ts) and must not assert a
  placement that contradicts the chart.

It needs the API running with an **active real engine** and `ALLOW_DEV_LOGIN`, so
it's kept out of `npm test` (real tokens, mild non-determinism). Each run uses a
fresh dev user for clean quota; it makes 5 LLM calls (fits the free 5/day).
Failures exit non-zero for CI gating on a schedule.

### Layer B — contradiction scan (`npm test`, deterministic)

[`src/chat/contradictions.ts`](../src/chat/contradictions.ts) is a pure,
LLM-free scanner: it regex-matches "&lt;planet&gt; … in … &lt;sign&gt;" and
"ascendant/lagna … &lt;sign&gt;" claims in a reply and flags any that disagree
with the computed chart (unit-tested in
[`contradictions.test.ts`](../src/chat/contradictions.test.ts)). It's a *signal*,
not a proof — it can miss paraphrases and occasionally over-flag generic sign
talk — but it catches the clearest failure: the model inventing a placement. Used
both in `npm run eval:chat` and available for runtime spot-checks.

### Not yet built (roadmap)

- **LLM-as-judge rubric** — score open-ended answers (grounding, no contradiction,
  profile-specificity, safety, non-fatalism) as a gate on prompt/context changes.
- **Production feedback** — thumbs up/down on messages + logging the context
  snapshot per turn, to grow the golden set from real misfires.

## API contract

`POST /api/llm/chat/stream` — auth required, `requireFeature("chat")`, `chat`
quota. Request body:

```jsonc
{
  "messages": [                       // full turn history, oldest → newest
    { "role": "user", "content": "What does my Saturn placement mean?" }
  ],
  "context": {                        // optional
    "chart": { "label": "Asha", "summary": "Ascendant Leo. Sun in Virgo (H2)…" },
    "module": "Doshas"
  }
}
```

Optionally include `conversationId` (to continue a thread) and `chartId` (stored
with a new conversation). Response: `text/event-stream` — `event: meta`
(`{provider, model, conversationId}`), then `data: {delta}` chunks, then
`event: done` (`{conversationId}`); `event: error` on failure. Identical framing
to `/api/llm/justify/stream`, so the client reader is shared.

### Persistence endpoints (Phase 2)

The stream endpoint persists each turn: it resolves or creates the conversation
(auto-titled from the first user message), writes the user turn before streaming
and the assistant turn after. Read/manage them via the `chat` router
([`server/chat.ts`](../server/chat.ts)), all scoped to the signed-in user:

| Method & path | Purpose |
| ------------- | ------- |
| `GET /api/chat/conversations` | List the user's conversations (newest first, with message counts). |
| `GET /api/chat/conversations/:id` | One conversation + its full message history. |
| `DELETE /api/chat/conversations/:id` | Delete a conversation (messages cascade). |

Ownership is enforced in SQL (`WHERE user_id = $me`), so another user's id
returns `404` on read/delete.

## Phasing

| Phase | Scope | Status |
| ----- | ----- | ------ |
| **1 — MVP** | Streaming `ChatPanel`, chat feature flag + `chat` quota (free allowance), injects loaded chart + current module. Reuses the SSE/provider layer. | ✅ done |
| **2 — Persistence** | `chat_conversations` / `chat_messages` tables, in-panel history + New chat, resume/delete across reloads, user-scoped. | ✅ done |
| **3 — Module hooks** | "✦ Ask AI" buttons in Doshas / Muhurta / Vastu that open the panel and start a fresh, finding-seeded conversation. | ✅ done |

Phase 1 is intentionally small: streaming, provider fan-out, quotas, encryption,
and the client SSE reader already exist — the new code is a multi-turn prompt
assembler (`openChatStream`) and the chat UI.

## Files

- [`server/llm.ts`](../server/llm.ts) — `CHAT_SYSTEM_PROMPT`, `openChatStream`,
  `POST /chat/stream` route (with per-turn persistence).
- [`server/chat.ts`](../server/chat.ts) — conversation CRUD router (Phase 2).
- [`server/db.ts`](../server/db.ts) — `chat_conversations` / `chat_messages`
  tables + helpers (Phase 2).
- [`server/features.ts`](../server/features.ts) — `chat` feature flag.
- [`server/rateLimit.ts`](../server/rateLimit.ts) — `chat` daily limits.
- [`src/api/client.ts`](../src/api/client.ts) — `ChatMessage`, `ChatContext`,
  `ChatConversation`, `api.chatStream`, conversation CRUD methods.
- [`src/components/ChatPanel.tsx`](../src/components/ChatPanel.tsx) — the launcher
  + panel, chart summarizer, streaming, history/New chat/resume/delete,
  quota/upgrade handling, seeded-ask handling.
- [`src/chat/AstroChat.tsx`](../src/chat/AstroChat.tsx) — `AstroChatProvider`,
  `useAstroChat`, `AskAiButton`, `usePublishChatContext` (Phase 3).
- [`src/chat/context.ts`](../src/chat/context.ts) — pure context builders
  (`summarizeChart`, `summarizeDoshas`, `buildChatContext`).
- [`src/chat/context.test.ts`](../src/chat/context.test.ts) — Layer-0 unit tests
  incl. cross-profile isolation.
- [`src/chat/contradictions.ts`](../src/chat/contradictions.ts) +
  [`.test.ts`](../src/chat/contradictions.test.ts) — Layer-B faithfulness scanner.
- [`src/components/ChatPanel.test.tsx`](../src/components/ChatPanel.test.tsx) —
  component test for the profile-switch reset (jsdom).
- [`scripts/eval-chat.ts`](../scripts/eval-chat.ts) — `npm run eval:chat`
  golden-set eval (factual anchors, cross-profile, dosha grounding, contradictions).
- Module hooks: `DoshasView.tsx`, `MuhurtaView.tsx`, `VastuView.tsx`.
- [`src/App.tsx`](../src/App.tsx) — mounts `<ChatPanel>`; `src/main.tsx` wraps the
  app in `<AstroChatProvider>`.
