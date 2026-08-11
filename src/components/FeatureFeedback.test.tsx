// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { FeatureFeedback } from "./FeatureFeedback";
import { api } from "../api/client";

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe("FeatureFeedback", () => {
  it("shows the prompt with the feature label", () => {
    render(<FeatureFeedback feature="muhurta" label="Muhurta" />);
    expect(screen.getByText(/was muhurta helpful\?/i)).toBeTruthy();
  });

  it("does not send until the user confirms, so a stray tap costs nothing", () => {
    const send = vi.spyOn(api, "sendFeedback").mockResolvedValue();
    render(<FeatureFeedback feature="dasha" label="Dasha" />);
    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("submits rating plus comment and thanks the user", async () => {
    const send = vi.spyOn(api, "sendFeedback").mockResolvedValue();
    render(<FeatureFeedback feature="doshas" label="Doshas" />);
    fireEvent.click(screen.getByRole("button", { name: /no/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too generic" } });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(screen.getByText(/thanks/i)).toBeTruthy());
    expect(send).toHaveBeenCalledWith({ feature: "doshas", rating: "down", comment: "Too generic" });
  });

  it("sends a bare rating when no comment is typed", async () => {
    const send = vi.spyOn(api, "sendFeedback").mockResolvedValue();
    render(<FeatureFeedback feature="chart" label="Kundli" />);
    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ feature: "chart", rating: "up", comment: "" }));
  });

  it("cancel drops the draft without sending", () => {
    const send = vi.spyOn(api, "sendFeedback").mockResolvedValue();
    render(<FeatureFeedback feature="transit" />);
    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces a failure instead of falsely thanking the user", async () => {
    vi.spyOn(api, "sendFeedback").mockRejectedValue(new Error("Daily feedback limit reached"));
    render(<FeatureFeedback feature="vastu" label="Vastu" />);
    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(screen.getByText(/daily feedback limit reached/i)).toBeTruthy());
    expect(screen.queryByText(/thanks/i)).toBeNull();
  });

  it("resets when the user switches module, so feedback tracks what's on screen", async () => {
    vi.spyOn(api, "sendFeedback").mockResolvedValue();
    const { rerender } = render(<FeatureFeedback feature="career" label="Career" />);
    fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(screen.getByText(/thanks/i)).toBeTruthy());

    rerender(<FeatureFeedback feature="health" label="Health" />);
    expect(screen.getByText(/was health helpful\?/i)).toBeTruthy();
    expect(screen.queryByText(/thanks/i)).toBeNull();
  });

  it("every control is type=button — the widget can sit inside a form", () => {
    const { container } = render(<FeatureFeedback feature="notes" label="Notes" />);
    fireEvent.click(screen.getByRole("button", { name: /no/i }));
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.getAttribute("type") === "button")).toBe(true);
  });
});
