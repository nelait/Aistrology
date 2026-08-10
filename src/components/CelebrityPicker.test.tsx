// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import CelebrityPicker from "./CelebrityPicker";
import { CELEBRITIES } from "../data/celebrities";

afterEach(cleanup);

describe("CelebrityPicker", () => {
  it("lists every celebrity by default", () => {
    render(<CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /·/ })).toHaveLength(CELEBRITIES.length);
  });

  it("filters by region", () => {
    render(<CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const regions = screen.getByRole("group", { name: /filter by region/i });
    fireEvent.click(within(regions).getByRole("button", { name: /United States/ }));
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(within(list).getByText("Barack Obama")).toBeTruthy();
    expect(within(list).queryByText("Rajinikanth")).toBeNull();
  });

  it("searches across name, place and field", () => {
    render(<CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByPlaceholderText(/search by name/i);
    fireEvent.change(search, { target: { value: "kerala" } });
    const list = screen.getByRole("list");
    expect(within(list).getByText("Mohanlal")).toBeTruthy();
    expect(within(list).queryByText("Barack Obama")).toBeNull();
  });

  it("shows an empty state for a non-match", () => {
    render(<CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), {
      target: { value: "zzzznobody" },
    });
    expect(screen.getByText(/No one matches/)).toBeTruthy();
  });

  it("returns the picked celebrity", () => {
    const onPick = vi.fn();
    render(<CelebrityPicker onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Rajinikanth"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].name).toBe("Rajinikanth");
  });

  it("closes on the ✕ button and on Escape", () => {
    const onClose = vi.fn();
    render(<CelebrityPicker onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // Regression: the picker renders INSIDE the birth <form>. A <button> with no
  // explicit type defaults to type="submit", so every filter click submitted the
  // form — casting a chart from stale values and unmounting the modal.
  it("marks every button type=button so it cannot submit the surrounding form", () => {
    const { container } = render(<CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.getAttribute("type"), `"${b.textContent?.slice(0, 30)}" must be type=button`).toBe("button");
    }
  });

  it("does not submit a wrapping form when its controls are clicked", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <CelebrityPicker onPick={vi.fn()} onClose={vi.fn()} />
      </form>,
    );
    const regions = screen.getByRole("group", { name: /filter by region/i });
    fireEvent.click(within(regions).getByRole("button", { name: /South India/ }));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
