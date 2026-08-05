// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { api } from "../api/client";

const mkBirth = (name: string, place: string) => ({
  name, year: 1990, month: 1, day: 2, hour: 6, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 1, longitude: 1, placeLabel: place,
});
const CHARTS = [
  { id: "c1", label: "Asha", birth: mkBirth("Asha", "Delhi") },
  { id: "c2", label: "Ravi", birth: mkBirth("Ravi", "Chennai") },
  { id: "c3", label: "Meena", birth: mkBirth("Meena", "Mumbai") },
  { id: "c4", label: "Kiran", birth: mkBirth("Kiran", "Pune") },
  { id: "c5", label: "Deepa", birth: mkBirth("Deepa", "Kochi") },
];

vi.mock("../api/client", () => ({
  api: {
    listCharts: vi.fn(async () => CHARTS),
    createChart: vi.fn(),
    deleteChart: vi.fn(async () => {}),
    renameChart: vi.fn(async (id: string, label: string) => ({ id, label, birth: mkBirth(label, "Delhi") })),
  },
}));

import ProfileSwitcher from "./ProfileSwitcher";

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const noop = () => {};

async function openMenu(activeChartId: string | null = "c1") {
  const onLoad = vi.fn();
  render(
    <ProfileSwitcher
      currentBirth={CHARTS[0].birth} activeChartId={activeChartId}
      onLoadChart={onLoad} onNewChart={noop} onProfileDeleted={noop}
    />,
  );
  fireEvent.click(screen.getByTitle("Switch profile"));
  await screen.findByText("Meena"); // wait for async listCharts
  return { onLoad };
}

describe("ProfileSwitcher", () => {
  it("names the active profile in the pill", async () => {
    render(
      <ProfileSwitcher currentBirth={CHARTS[0].birth} activeChartId="c1"
        onLoadChart={noop} onNewChart={noop} onProfileDeleted={noop} />,
    );
    expect(await screen.findByText("Asha")).toBeTruthy();
  });

  it("marks the active profile with a check in the list", async () => {
    await openMenu("c2");
    const list = screen.getByRole("list");
    const activeItem = within(list).getByText("Ravi").closest("li")!;
    expect(within(activeItem).getByText("✓")).toBeTruthy();
    // A non-active profile has no check.
    const otherItem = within(list).getByText("Asha").closest("li")!;
    expect(within(otherItem).queryByText("✓")).toBeNull();
  });

  it("switches profile on click, passing that profile's birth + id", async () => {
    const { onLoad } = await openMenu("c1");
    fireEvent.click(screen.getByText("Meena"));
    expect(onLoad).toHaveBeenCalledWith(CHARTS[2].birth, "c3");
  });

  it("filters the list via search", async () => {
    await openMenu("c1");
    fireEvent.change(screen.getByPlaceholderText(/search profiles/i), { target: { value: "kir" } });
    const list = screen.getByRole("list");
    expect(within(list).getByText("Kiran")).toBeTruthy();
    expect(within(list).queryByText("Asha")).toBeNull();
  });

  it("shows an unsaved badge + save row when no active profile", async () => {
    render(
      <ProfileSwitcher currentBirth={CHARTS[0].birth} activeChartId={null}
        onLoadChart={noop} onNewChart={noop} onProfileDeleted={noop} />,
    );
    expect(await screen.findByText("unsaved")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Switch profile"));
    expect(await screen.findByText("Save current")).toBeTruthy();
  });

  it("renames a profile inline", async () => {
    await openMenu("c1");
    const list = screen.getByRole("list");
    const ravi = within(list).getByText("Ravi").closest("li")!;
    fireEvent.click(within(ravi).getByTitle("Rename"));
    const input = within(ravi).getByDisplayValue("Ravi");
    fireEvent.change(input, { target: { value: "Ravi Kumar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.renameChart).toHaveBeenCalledWith("c2", "Ravi Kumar"));
    expect(await within(list).findByText("Ravi Kumar")).toBeTruthy();
  });

  it("sorts A–Z", async () => {
    await openMenu("c1");
    fireEvent.click(screen.getByText("A–Z"));
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[0].textContent).toContain("Asha");
    expect(items[1].textContent).toContain("Deepa"); // was "Ravi" in recent order
  });

  it("navigates with the keyboard (↓ then Enter)", async () => {
    const { onLoad } = await openMenu("c1");
    const menu = document.querySelector(".profile-menu") as HTMLElement;
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // highlight 0 → 1 (Ravi)
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onLoad).toHaveBeenCalledWith(CHARTS[1].birth, "c2");
  });
});
