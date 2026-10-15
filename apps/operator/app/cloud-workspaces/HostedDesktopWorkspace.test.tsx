// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { HostedDesktopViewerProps } from "./HostedDesktopViewer";
import {
  HostedDesktopWorkspace,
  myDesktopEntry,
  myDesktopErrorMessage,
  selectionAfterStart,
  type DesktopSelection,
  type HostedDesktopWorkspaceProps,
} from "./HostedDesktopWorkspace";

vi.mock("./HostedDesktopViewer", () => ({
  HostedDesktopViewer: (props: HostedDesktopViewerProps) => (
    <section
      aria-label={`Live ${props.desktopSessionId}`}
      data-workspace={props.workspaceId}
      data-host={props.hostId}
      data-route={props.routeLabel}
      data-mode={props.mode}
    >
      <button
        onClick={() => props.onModeChange?.("takeover")}
        disabled={!props.canTakeControl}
      >
        Take control
      </button>
    </section>
  ),
}));

afterEach(cleanup);

const roster = [
  {
    desktopSessionId: "desk-1",
    state: "running",
    displayNumber: 1,
    geometry: "1280x720",
    lastActiveAt: "2026-09-07T10:00:00Z",
  },
  {
    desktopSessionId: "desk-2",
    state: "idle",
    displayNumber: 2,
    lastActiveAt: "2026-09-07T10:05:00Z",
  },
];

function Workspace(props: Partial<HostedDesktopWorkspaceProps>) {
  const [selectedDesktop, onSelectDesktop] = useState<DesktopSelection | null>(
    null,
  );
  const [pinned, onPinnedChange] = useState<string[]>([]);
  const [filter, onFilterChange] = useState("");
  return (
    <HostedDesktopWorkspace
      hostName="Research workspace"
      workspaceId="customer-1"
      hostId="host-1"
      routeLabel="relay-1"
      bridge={{
        requestRoster: () => true,
        requestThumbnail: () => true,
        requestStart: () => true,
      }}
      roster={roster}
      rosterState="ready"
      rosterError={null}
      startState="idle"
      startError={null}
      thumbnails={{}}
      selectedDesktop={selectedDesktop}
      viewerState={null}
      onSelectDesktop={onSelectDesktop}
      onViewerStateChange={() => {}}
      pinned={pinned}
      onPinnedChange={onPinnedChange}
      filter={filter}
      onFilterChange={onFilterChange}
      {...props}
    />
  );
}

describe("<HostedDesktopWorkspace>", () => {
  it("opens the selected host-scoped desktop in watch mode and replaces it on selection", () => {
    render(<Workspace />);
    expect(screen.getByText("Choose a desktop to watch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 1" }));
    const first = screen.getByRole("region", { name: "Live desk-1" });
    expect(first.getAttribute("data-workspace")).toBe("customer-1");
    expect(first.getAttribute("data-host")).toBe("host-1");
    expect(first.getAttribute("data-route")).toBe("relay-1");
    expect(first.getAttribute("data-mode")).toBe("watch");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(first.getAttribute("data-mode")).toBe("takeover");
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 2" }));
    expect(screen.queryByRole("region", { name: "Live desk-1" })).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Live desk-2" })
        .getAttribute("data-mode"),
    ).toBe("watch");
    expect(
      screen
        .getByRole("button", { name: "Watch Display 2" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Close desktop viewer" }),
    );
    expect(screen.queryByRole("region", { name: "Live desk-2" })).toBeNull();
  });

  it("keeps an existing media stream through discovery loss but prevents opening another or taking control", () => {
    const { rerender } = render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 1" }));
    rerender(<Workspace bridge={null} />);
    expect(screen.getByRole("region", { name: "Live desk-1" })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Watch Display 2",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Take control",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Workspace disconnected")).toBeTruthy();
    rerender(<Workspace roster={[roster[1]]} />);
    expect(screen.queryByRole("region", { name: "Live desk-1" })).toBeNull();
    expect(
      screen.getByText("This desktop is no longer available"),
    ).toBeTruthy();
  });

  it("refreshes via the existing bridge and renders only reported activity and thumbnails", () => {
    const requestRoster = vi.fn(() => true);
    const { rerender } = render(
      <Workspace
        bridge={{
          requestRoster,
          requestThumbnail: () => true,
          requestStart: () => true,
        }}
        thumbnails={{ "desk-1": { desktopSessionId: "desk-1", data: "frame" } }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh desktop roster" }),
    );
    expect(requestRoster).toHaveBeenCalledOnce();
    const activity = screen.getByRole("region", {
      name: "Recent desktop activity",
    });
    expect(within(activity).getAllByRole("listitem")[0].textContent).toContain(
      "Display 2 · idle",
    );
    expect(activity.querySelector("time")?.dateTime).toBe(
      "2026-09-07T10:05:00Z",
    );
    expect(
      screen
        .getByRole("button", { name: "Watch Display 1" })
        .querySelector("img")?.src,
    ).toBe("data:image/jpeg;base64,frame");
    rerender(
      <Workspace
        roster={[
          {
            desktopSessionId: "unknown",
            state: "running",
            lastActiveAt: "not-a-timestamp",
          },
        ]}
      />,
    );
    expect(
      screen.getByText("No desktop activity has been reported yet."),
    ).toBeTruthy();
  });

  it("labels each tile with its owning agent and that agent's work-item (P-006)", () => {
    render(
      <Workspace
        roster={[
          {
            desktopSessionId: "desk-a",
            state: "running",
            scope: "agent",
            owner: "su-1a2b",
            name: "browser",
            workItemId: "WI-12",
            workItemIntent: "build the grid",
          },
          { desktopSessionId: "desk-p", state: "running", scope: "pot", owner: "research" },
          { desktopSessionId: "desk-w", state: "running", scope: "workspace" },
        ]}
      />,
    );
    const agent = screen.getByRole("button", { name: "Watch browser" });
    expect(within(agent).getByText("Agent su-1a2b")).toBeTruthy();
    expect(within(agent).getByText("WI-12 · build the grid")).toBeTruthy();
    expect(screen.getByText("Pot research")).toBeTruthy();
    expect(screen.getByText("Workspace desktop")).toBeTruthy();
  });

  it("streams pinned tiles live in watch-only mode beside the large viewer", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Display 2 live" }));
    const pinnedLive = screen.getByRole("region", { name: "Live desk-2" });
    expect(pinnedLive.getAttribute("data-mode")).toBe("watch");
    // A pinned tile never offers take-over in place; that lives in the large viewer.
    expect(
      (within(pinnedLive).getByRole("button", { name: "Take control" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 1" }));
    expect(screen.getByRole("region", { name: "Live desk-1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Live desk-2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin Display 2" }));
    expect(screen.queryByRole("region", { name: "Live desk-2" })).toBeNull();
  });

  it.each([
    [{ routeLabel: null }, "Your desktop is not ready yet"],
    [{ bridge: null }, "Connect your workspace"],
    [{ rosterState: "loading", roster: [] }, "Finding your desktops…"],
    [{ roster: [] }, "No desktops are available yet"],
    [{ roster: [], startState: "loading" }, "Starting your desktop…"],
    [
      { roster: [], startState: "error", startError: "desktop_start_failed" },
      "Your desktop could not be started",
    ],
    [
      { rosterState: "error", rosterError: "connection_lost", roster: [] },
      "Desktops could not be loaded",
    ],
  ] as const)(
    "explains unavailable state without presenting a fabricated live desktop: %j",
    (props, title) => {
      render(<Workspace {...props} />);
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.queryByRole("region", { name: /^Live/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    },
  );
});

describe("My desktop (personal-cloud-desktop-2026-10-06 P-005)", () => {
  const mine = { desktopSessionId: "mine", state: "running", scope: "user" as const };

  it("finds the caller's own desktop only by its user scope", () => {
    expect(myDesktopEntry(roster)).toBeNull();
    expect(
      myDesktopEntry([...roster, { desktopSessionId: "agent-d", state: "running", scope: "agent" }]),
    ).toBeNull();
    expect(myDesktopEntry([...roster, mine])).toEqual(mine);
  });

  it("opens a started personal desktop in Take control, even over an open viewer (R-5)", () => {
    const open: DesktopSelection = { desktopSessionId: "desk-1", mode: "watch" };
    expect(selectionAfterStart({ ...mine, state: "ready" }, open)).toEqual({
      desktopSessionId: "mine",
      mode: "takeover",
    });
    expect(selectionAfterStart({ ...mine, state: "ready" }, null)).toEqual({
      desktopSessionId: "mine",
      mode: "takeover",
    });
    // The automatic workspace start (D-405) keeps its watch-only, open-if-empty rule.
    const workspaceDesktop = { desktopSessionId: "ws-d", state: "ready", scope: "workspace" as const };
    expect(selectionAfterStart(workspaceDesktop, null)).toEqual({
      desktopSessionId: "ws-d",
      mode: "watch",
    });
    expect(selectionAfterStart(workspaceDesktop, open)).toBeNull();
  });

  it("offers My desktop and hands the click to the connection (R-5)", () => {
    const onOpenMyDesktop = vi.fn();
    render(<Workspace onOpenMyDesktop={onOpenMyDesktop} />);
    const button = screen.getByRole("button", { name: "Open my desktop" });
    expect(button.textContent).toBe("My desktop");
    expect(button.getAttribute("data-my-desktop")).toBe("absent");
    fireEvent.click(button);
    expect(onOpenMyDesktop).toHaveBeenCalledTimes(1);
  });

  it("lands a selected personal desktop in Take control, labelled as the person's own", () => {
    render(
      <Workspace
        onOpenMyDesktop={() => {}}
        roster={[...roster, mine]}
        selectedDesktop={{ desktopSessionId: "mine", mode: "takeover" }}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Live mine" }).getAttribute("data-mode"),
    ).toBe("takeover");
    expect(screen.getAllByText("My desktop").length).toBeGreaterThan(0);
  });

  it("marks a running personal desktop so one click reopens it (R-16)", () => {
    render(<Workspace onOpenMyDesktop={() => {}} roster={[...roster, mine]} />);
    expect(
      screen.getByRole("button", { name: "Open my desktop" }).getAttribute("data-my-desktop"),
    ).toBe("running");
  });

  it("shows a My desktop start in progress, and disables a second click", () => {
    render(<Workspace onOpenMyDesktop={() => {}} personalStart startState="loading" />);
    const button = screen.getByRole("button", { name: "Open my desktop" });
    expect(button.textContent).toBe("Starting my desktop…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("names a refused My desktop start instead of leaving a spinner (R-15)", () => {
    render(
      <Workspace
        onOpenMyDesktop={() => {}}
        personalStart
        startState="error"
        startError="personal_desktop_unavailable"
      />,
    );
    const alert = screen
      .getAllByRole("alert")
      .find((node) => node.getAttribute("data-error-code") === "personal_desktop_unavailable");
    expect(alert?.textContent).toContain(
      "My desktop could not be opened (personal_desktop_unavailable).",
    );
    expect(alert?.textContent).toContain(myDesktopErrorMessage("personal_desktop_unavailable"));
    expect(screen.queryByText("Starting my desktop…")).toBeNull();
    expect(screen.getByRole("button", { name: "Open my desktop" }).textContent).toBe("My desktop");
  });

  it("never attributes the automatic workspace start to My desktop", () => {
    const { rerender } = render(
      <Workspace onOpenMyDesktop={() => {}} roster={[]} startState="loading" />,
    );
    expect(screen.getByRole("button", { name: "Open my desktop" }).textContent).toBe("My desktop");
    rerender(
      <Workspace
        onOpenMyDesktop={() => {}}
        roster={[]}
        startState="error"
        startError="desktop_start_failed"
      />,
    );
    expect(document.querySelector("[data-error-code]")).toBeNull();
    expect(screen.queryByText(/My desktop could not be opened/)).toBeNull();
  });

  it("gives each refusal code its own explanation", () => {
    expect(myDesktopErrorMessage("personal_desktop_unavailable")).toMatch(/desktop pack/);
    expect(myDesktopErrorMessage("controller_required")).toMatch(/Another tab/);
    expect(myDesktopErrorMessage("desktop_not_owner")).toBe("Your desktop could not be started.");
  });
});
