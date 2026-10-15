// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopGrid, type DesktopGridProps } from "./DesktopGrid";
import type { DesktopGridTile } from "./desktop-grid-model";

afterEach(cleanup);

const TILES: DesktopGridTile[] = [
  {
    desktopSessionId: "dsk-a",
    title: "browser",
    ownerLabel: "Agent su-1a2b",
    workItemLabel: "WI-12 · build the grid",
    state: "running",
    geometry: "1280x800",
    lastActiveAt: "2026-10-06T08:00:00.000Z",
    thumbnailSrc: "data:image/png;base64,AAAA",
  },
  {
    desktopSessionId: "dsk-b",
    title: "terminal",
    ownerLabel: "Agent cup-99",
    workItemLabel: null,
    state: "starting",
    thumbnailSrc: null,
  },
  {
    desktopSessionId: "dsk-c",
    title: "spare",
    ownerLabel: null,
    workItemLabel: null,
    state: "running",
    thumbnailSrc: null,
  },
];

function renderGrid(overrides: Partial<DesktopGridProps> = {}) {
  const props: DesktopGridProps = {
    tiles: TILES,
    selectedId: null,
    pinned: [],
    filter: "",
    canOpen: true,
    onOpen: vi.fn(),
    onPinnedChange: vi.fn(),
    onFilterChange: vi.fn(),
    renderLive: (tile) => <div data-testid={`live-${tile.desktopSessionId}`}>live viewer</div>,
    ...overrides,
  };
  render(<DesktopGrid {...props} />);
  return props;
}

describe("DesktopGrid (agent-multi-desktops-grid P-006)", () => {
  it("renders one tile per desktop with owner, work-item, state and thumbnail", () => {
    renderGrid();
    const list = screen.getByRole("list", { name: "Available desktops" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const browser = screen.getByRole("button", { name: "Watch browser" });
    expect(within(browser).getByText("Agent su-1a2b")).toBeTruthy();
    expect(within(browser).getByText("WI-12 · build the grid")).toBeTruthy();
    expect(within(browser).getByText(/running · 1280x800/)).toBeTruthy();
    expect(browser.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-10-06T08:00:00.000Z",
    );
    expect(browser.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // No thumbnail yet → placeholder, never a broken <img>.
    expect(screen.getByRole("button", { name: "Watch terminal" }).querySelector("img")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("3 desktops");
  });

  it("opens the large viewer on click", () => {
    const props = renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Watch terminal" }));
    expect(props.onOpen).toHaveBeenCalledWith("dsk-b");
  });

  it("marks the selected tile", () => {
    renderGrid({ selectedId: "dsk-a" });
    expect(
      screen.getByRole("button", { name: "Watch browser" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("filters tiles and says so when nothing matches", () => {
    const props = renderGrid({ filter: "cup-99" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Watch terminal" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter desktops" }), {
      target: { value: "wi-12" },
    });
    expect(props.onFilterChange).toHaveBeenCalledWith("wi-12");
    cleanup();
    renderGrid({ filter: "nothing-like-this" });
    expect(screen.getByText(/No desktops match/)).toBeTruthy();
  });

  it("streams pinned tiles live and keeps them openable", () => {
    const props = renderGrid({ pinned: ["dsk-a"] });
    const live = screen.getByRole("group", { name: "browser live" });
    expect(within(live).getByTestId("live-dsk-a")).toBeTruthy();
    expect(screen.queryByTestId("live-dsk-b")).toBeNull();
    fireEvent.click(within(live).getByRole("button", { name: "Watch browser" }));
    expect(props.onOpen).toHaveBeenCalledWith("dsk-a");
    fireEvent.click(screen.getByRole("button", { name: "Unpin browser" }));
    expect(props.onPinnedChange).toHaveBeenCalledWith([]);
  });

  it("pins a tile and refuses a third pin", () => {
    const props = renderGrid({ pinned: ["dsk-a"] });
    fireEvent.click(screen.getByRole("button", { name: "Pin terminal live" }));
    expect(props.onPinnedChange).toHaveBeenCalledWith(["dsk-a", "dsk-b"]);
    cleanup();
    renderGrid({ pinned: ["dsk-a", "dsk-b"] });
    const third = screen.getByRole("button", { name: "Pin spare live" }) as HTMLButtonElement;
    expect(third.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("2/2 live");
  });

  it("disables opening and pinning while the source cannot open a viewer", () => {
    renderGrid({ canOpen: false });
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
