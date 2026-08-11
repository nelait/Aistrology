// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { FeedbackSection } from "./AdminView";
import { api } from "../api/client";
import type { AdminFeedback, FeedbackSummaryRow } from "../api/client";

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

const SUMMARY: FeedbackSummaryRow[] = [
  { feature: "chart", total: 4, up: 3, down: 1, comments: 2 },
  { feature: "doshas", total: 2, up: 0, down: 2, comments: 1 },
];

const ENTRIES: AdminFeedback[] = [
  { id: "a", feature: "doshas", rating: "down", comment: "Explanation felt generic.", status: "new", email: "u@example.dev", createdAt: 1_700_000_000_000 },
  { id: "b", feature: "chart", rating: "up", comment: "", status: "read", email: null, createdAt: 1_700_000_100_000 },
  { id: "c", feature: "chart", rating: "up", comment: "Varga switching is fast.", status: "new", email: "v@example.dev", createdAt: 1_700_000_200_000 },
];

function mockLoad() {
  return vi.spyOn(api, "getAdminFeedback").mockResolvedValue({ entries: ENTRIES, summary: SUMMARY });
}

describe("Admin → Feedback", () => {
  it("ranks the worst-rated feature first — that's where the work is", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(document.querySelectorAll(".fb-sum-name")).toHaveLength(2));
    const names = Array.from(document.querySelectorAll(".fb-sum-name")).map((n) => n.textContent);
    expect(names).toEqual(["Doshas", "Kundli"]);
  });

  it("shows the positive share per feature", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(screen.getByText("0%")).toBeTruthy());
    expect(screen.getByText("75%")).toBeTruthy(); // chart: 3 up of 4
    expect(screen.getByText(/👍 3 · 👎 1 · 4 ratings · 2 comments/)).toBeTruthy();
  });

  it("counts unreviewed entries", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(screen.getByText(/3 total · 2 unreviewed/)).toBeTruthy());
  });

  it("clicking a summary row filters the list to that feature", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(document.querySelectorAll(".fb-sum-name")).toHaveLength(2));
    fireEvent.click(document.querySelector(".fb-sum-name") as HTMLElement); // "Doshas"
    const list = document.querySelector(".contact-list") as HTMLElement;
    expect(within(list).getAllByText(/Doshas|Kundli/)).toHaveLength(1);
    expect(within(list).getByText("Explanation felt generic.")).toBeTruthy();
  });

  it("filters by rating", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(document.querySelectorAll(".fb-sum-name")).toHaveLength(2));
    fireEvent.change(screen.getByDisplayValue("👍 & 👎"), { target: { value: "down" } });
    const list = document.querySelector(".contact-list") as HTMLElement;
    expect(within(list).getByText("Explanation felt generic.")).toBeTruthy();
    expect(within(list).queryByText("Varga switching is fast.")).toBeNull();
  });

  it("labels a rating-only entry rather than showing a blank body", async () => {
    mockLoad();
    render(<FeedbackSection />);
    await waitFor(() => expect(screen.getByText(/rating only/i)).toBeTruthy());
  });

  it("marking an entry actioned updates it in place", async () => {
    mockLoad();
    const set = vi.spyOn(api, "setFeedbackStatus")
      .mockResolvedValue({ ...ENTRIES[0], status: "actioned" });
    render(<FeedbackSection />);
    await waitFor(() => expect(document.querySelectorAll(".fb-sum-name")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: /actioned/i })[0]);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a", "actioned"));
    await waitFor(() => expect(screen.getByText("actioned")).toBeTruthy());
  });

  it("reports a load failure instead of showing an empty console", async () => {
    vi.spyOn(api, "getAdminFeedback").mockRejectedValue(new Error("nope"));
    render(<FeedbackSection />);
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
  });

  it("says so when nothing has been submitted yet", async () => {
    vi.spyOn(api, "getAdminFeedback").mockResolvedValue({ entries: [], summary: [] });
    render(<FeedbackSection />);
    await waitFor(() => expect(screen.getByText(/no feedback submitted yet/i)).toBeTruthy());
  });
});
