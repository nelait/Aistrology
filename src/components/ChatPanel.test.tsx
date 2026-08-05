// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { computeChart } from "../astro/engine";
import { BirthData } from "../astro/types";

// Mock the surrounding providers so we can drive ChatPanel in isolation and keep
// the panel visible (signed in, feature on, engine active, window open).
vi.mock("../llm/LlmProvider", () => ({ useLlm: () => ({ enabled: true }) }));
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { plan: "pro" }, features: { chat: true } }),
}));
vi.mock("../chat/AstroChat", () => ({
  useAstroChat: () => ({
    open: true, setOpen: vi.fn(), seed: null, moduleContext: null, setModuleContext: vi.fn(),
  }),
}));
vi.mock("../api/client", () => ({
  api: {
    // Stream a one-shot assistant reply synchronously.
    chatStream: vi.fn(async (_req, handlers) => {
      handlers.onMeta?.({ provider: "openai", model: "gpt", conversationId: "c1" });
      handlers.onDelta("hello there");
      handlers.onDone?.({ conversationId: "c1" });
    }),
    listChatConversations: vi.fn(async () => []),
    getChatConversation: vi.fn(),
    deleteChatConversation: vi.fn(),
  },
}));

import ChatPanel from "./ChatPanel";

const PROFILE: BirthData = {
  name: "Asha", year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi",
};
const chart = computeChart(PROFILE);

beforeAll(() => {
  // jsdom lacks scrollTo; ChatPanel's auto-scroll calls it.
  Element.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);

async function sendAMessage() {
  const input = screen.getByPlaceholderText(/ask about this chart/i);
  fireEvent.change(input, { target: { value: "what is my ascendant?" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await screen.findByText("hello there");
}

describe("ChatPanel — profile switching", () => {
  it("shows the streamed conversation after sending", async () => {
    render(<ChatPanel chart={chart} chartId="A" moduleLabel="Kundli" />);
    await sendAMessage();
    expect(screen.getByText("what is my ascendant?")).toBeTruthy();
    expect(screen.getByText("hello there")).toBeTruthy();
  });

  it("resets the thread when the active profile (chartId) changes", async () => {
    const { rerender } = render(<ChatPanel chart={chart} chartId="A" moduleLabel="Kundli" />);
    await sendAMessage();
    expect(screen.getByText("hello there")).toBeTruthy();

    // Switch profile → the previous thread must be cleared.
    rerender(<ChatPanel chart={chart} chartId="B" moduleLabel="Kundli" />);

    await waitFor(() => {
      expect(screen.queryByText("hello there")).toBeNull();
      expect(screen.queryByText("what is my ascendant?")).toBeNull();
    });
    // Back to the empty state (starter prompts visible again).
    expect(screen.getByText(/what are the strongest features of my chart/i)).toBeTruthy();
  });

  it("does NOT reset when unrelated props change (same profile)", async () => {
    const { rerender } = render(<ChatPanel chart={chart} chartId="A" moduleLabel="Kundli" />);
    await sendAMessage();
    // Only the module label changes; the thread should persist.
    rerender(<ChatPanel chart={chart} chartId="A" moduleLabel="Doshas" />);
    expect(screen.getByText("hello there")).toBeTruthy();
  });
});
