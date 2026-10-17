// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OperatorWorkspaceLocationProvider } from "@papercusp/operator-ui/seam";
import type { WorkspaceHostControlRow } from "./workspace-view-model";
import { MachineSwitcherView } from "./MachineSwitcher";
import { setBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";

const H = vi.hoisted(() => ({
  rows: [] as WorkspaceHostControlRow[],
  localRows: [] as unknown[],
  params: {} as Record<string, unknown>,
  updates: [] as Array<[string, unknown]>,
  loading: false,
  error: null as Error | null,
  invalidate: vi.fn(),
  queries: [] as string[],
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    H.queries.push(queryName);
    return queryName === "desktops.local"
      ? { data: H.localRows, loading: false, error: null, invalidate: H.invalidate }
      : {
          data: H.rows,
          loading: H.loading,
          error: H.error,
          invalidate: H.invalidate,
        };
  },
  useSyncMutate: () => vi.fn(),
}));
vi.mock("nuqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nuqs")>();
  const React = await import("react");
  return {
    ...actual,
    useQueryStates: (parsers: Record<string, unknown>) => {
      const [values, setValues] = React.useState<Record<string, unknown>>(
        Object.fromEntries(Object.keys(parsers).map((key) => [key, H.params[key] ?? null])),
      );
      return [values, (next: Record<string, unknown>) => {
        H.updates.push(...Object.entries(next));
        setValues((previous) => ({ ...previous, ...next }));
        return Promise.resolve(next);
      }];
    },
    useQueryState: (key: string, config?: { defaultValue?: unknown }) => {
      const [value, setValue] = React.useState<unknown>(
        H.params[key] ?? config?.defaultValue ?? null,
      );
      return [
        value,
        (next: unknown) => {
          H.updates.push([key, next]);
          setValue(next);
          return Promise.resolve(next);
        },
      ];
    },
  };
});
vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    options,
    onChange,
    ariaLabel,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/app/harness/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Exercise the registry the real portal mounts, not a hand-selected viewer component.
import { OPERATOR_SURFACES } from "@papercusp/operator-ui/surfaces";

function workspace(
  id: string,
  observedState: WorkspaceHostControlRow["observedState"] = "running",
): WorkspaceHostControlRow {
  return {
    kind: "workspace",
    id,
    name: id,
    connectionId: "gcp",
    target: "gcp",
    scopeLabel: "project",
    region: "us-central1",
    size: "small",
    image: "linux",
    diskGiB: 40,
    network: "private",
    desiredState: observedState,
    observedState,
    recoverability: { kind: "none", label: "No snapshot" },
    capabilities: {
      start: false,
      stop: false,
      repair: false,
      snapshot: false,
      destroy: false,
    },
  };
}

function openDesktops(location: "local" | "cloud" = "local") {
  const Desktops = OPERATOR_SURFACES.desktops;
  return render(
    <Suspense fallback={<p>Loading surface</p>}>
      <OperatorWorkspaceLocationProvider location={location}>
        <Desktops />
      </OperatorWorkspaceLocationProvider>
    </Suspense>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  window.sessionStorage.clear();
  H.rows = [
    workspace("Old workspace", "absent"),
    workspace("Research workspace"),
  ];
  H.localRows = [];
  H.params = { app: "desktops", step: "operate", tab: "desktops" };
  H.updates = [];
  H.loading = false;
  H.error = null;
  H.queries = [];
});

describe("portal Desktops entry — approved option B", () => {
  it("retains this window's selected machine after another app clears desktop URL state", async () => {
    H.rows.push(workspace("Saved machine"));
    setBrowserMachineId("Saved machine");
    openDesktops();
    expect(await screen.findByRole("region", { name: "Desktops for Saved machine" })).toBeTruthy();
  });

  it("keeps an unavailable persisted selection explicit instead of opening another machine", async () => {
    setBrowserMachineId("Removed machine");
    openDesktops();
    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Desktops for Research workspace" })).toBeNull();
  });

  it.each(["local", "cloud"] as const)(
    "keeps the persistent %s machine selector on the desktop pane's default target",
    async (location) => {
      H.rows = [workspace("Stopped machine", "stopped"), workspace("Running machine")];
      render(<MachineSwitcherView localMode={location === "local"} value={null}
        rows={H.rows} loading={false} error={null} onSelect={vi.fn()} />);
      openDesktops(location);
      expect(await screen.findByRole("region", { name: "Desktops for Running machine" })).toBeTruthy();
      expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value)
        .toBe((screen.getByRole("combobox", { name: "Desktop workspace" }) as HTMLSelectElement).value);
    },
  );

  it("keeps both controls on the connector-backed target when an earlier machine is running", async () => {
    const connected = workspace("Connected machine");
    connected.tunnel = { routeLabel: "connected-route", transport: "websocket" };
    H.rows = [workspace("Other running machine"), connected];
    render(<MachineSwitcherView localMode={false} value={null}
      rows={H.rows} loading={false} error={null} onSelect={vi.fn()} />);
    openDesktops("cloud");
    expect(await screen.findByRole("region", { name: "Desktops for Connected machine" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe(connected.id);
  });

  it("keeps a hosted session with no workspace empty without reading this computer", async () => {
    H.rows = [];
    openDesktops("cloud");
    expect(await screen.findByText("No desktop workspaces yet")).toBeTruthy();
    expect(screen.queryByText("This computer")).toBeNull();
    expect(H.queries).not.toContain("desktops.local");
  });

  it("refuses a hosted local deep link without opening local desktops", async () => {
    H.params.desktopHost = "local";
    openDesktops("cloud");
    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(screen.queryByText("This computer")).toBeNull();
    expect(H.queries).not.toContain("desktops.local");
  });

  it("offers only authorized cloud machines in a hosted workspace", async () => {
    openDesktops("cloud");
    expect(await screen.findByRole("region", { name: "Desktops for Research workspace" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "This computer" })).toBeNull();
    expect(H.queries).not.toContain("desktops.local");
  });

  it("opens the desktop composition without expanding a cloud-host row", async () => {
    openDesktops();
    expect(
      await screen.findByRole("region", {
        name: "Desktops for Research workspace",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "Managed workspace hosts" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Cloud Workspaces" }),
    ).toBeNull();
    expect(
      screen.getByRole("complementary", {
        name: "Workspace desktops and activity",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Your desktop is not ready yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("honors an explicit workspace and records workspace switches in URL state", async () => {
    H.rows.push(workspace("Budget workspace"));
    H.params.desktopHost = "Budget workspace";
    openDesktops();
    expect(
      await screen.findByRole("region", {
        name: "Desktops for Budget workspace",
      }),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Desktop workspace" }),
      { target: { value: "Research workspace" } },
    );
    expect(
      await screen.findByRole("region", {
        name: "Desktops for Research workspace",
      }),
    ).toBeTruthy();
    expect(H.updates).toContainEqual(["desktopHost", "Research workspace"]);
  });

  it.each(["local", "cloud"] as const)(
    "clears the previous machine's desktop state when the %s page switches machines",
    async (location) => {
      H.rows.push(workspace("Next machine"));
      H.params = { ws: "window-workspace", desktopHost: "Research workspace", host: "Research workspace",
        desktop: "watch:old", desktopPins: "old", desktopFilter: "old" };
      openDesktops(location);
      fireEvent.change(await screen.findByRole("combobox", { name: "Desktop workspace" }),
        { target: { value: "Next machine" } });
      expect(await screen.findByRole("region", { name: "Desktops for Next machine" })).toBeTruthy();
      expect(H.updates).toEqual(expect.arrayContaining([
        ["desktopHost", "Next machine"], ["host", "Next machine"],
        ["desktop", null], ["desktopPins", null], ["desktopFilter", null],
      ]));
      expect(H.updates.some(([key]) => key === "ws")).toBe(false);
    },
  );

  it("does not silently open a different workspace for an invalid deep link", async () => {
    H.params.desktopHost = "missing-host";
    openDesktops();
    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Desktops for Research workspace" }),
    ).toBeNull();
  });

  it("opens This computer when no active cloud workspace exists", async () => {
    H.rows = [workspace("Removed workspace", "absent")];
    openDesktops();
    expect(
      await screen.findByRole("region", { name: "Desktops on this computer" }),
    ).toBeTruthy();
    expect(screen.getByText("No agent desktops on this computer")).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: "Desktop workspace" }) as HTMLSelectElement)
        .value,
    ).toBe("local");
    expect(
      screen.queryByRole("list", { name: "Managed workspace hosts" }),
    ).toBeNull();
  });

  it("offers This computer beside the cloud workspaces and switches to it in URL state", async () => {
    H.localRows = [
      {
        id: "ds-1",
        slug: "papercusp",
        kind: "xvfb",
        scope: "agent",
        scopeRef: "su-1:main",
        display: 110,
        displayRaw: ":110",
        displayGeometry: { width: 1280, height: 800, depth: 24 },
        captureGeometry: { width: 1280, height: 800 },
        state: "ready",
        viewerMode: "none",
        viewerActor: null,
        capabilities: {},
        lastActiveAt: null,
        owner: "su-1",
        name: "browser",
        workItemId: "WI-12",
        workItemIntent: null,
      },
    ];
    openDesktops();
    expect(
      await screen.findByRole("region", { name: "Desktops for Research workspace" }),
    ).toBeTruthy();
    const picker = screen.getByRole("combobox", { name: "Desktop workspace" });
    expect(
      [...(picker as HTMLSelectElement).options].map((option) => option.textContent),
    ).toEqual(["This computer", "Research workspace"]);
    fireEvent.change(picker, { target: { value: "local" } });
    expect(
      await screen.findByRole("region", { name: "Desktops on this computer" }),
    ).toBeTruthy();
    expect(H.updates).toContainEqual(["desktopHost", "local"]);
    expect(H.updates).toContainEqual(["host", null]);
    expect(screen.getByRole("button", { name: "Watch browser" })).toBeTruthy();
    expect(screen.getByText("Agent su-1")).toBeTruthy();
  });
});
