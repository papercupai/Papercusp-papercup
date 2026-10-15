// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

const H = vi.hoisted(() => ({
  rows: [] as WorkspaceHostControlRow[],
  localRows: [] as unknown[],
  params: {} as Record<string, unknown>,
  updates: [] as Array<[string, unknown]>,
  loading: false,
  error: null as Error | null,
  invalidate: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    queryName === "desktops.local"
      ? { data: H.localRows, loading: false, error: null, invalidate: H.invalidate }
      : {
          data: H.rows,
          loading: H.loading,
          error: H.error,
          invalidate: H.invalidate,
        },
  useSyncMutate: () => vi.fn(),
}));
vi.mock("nuqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nuqs")>();
  const React = await import("react");
  return {
    ...actual,
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

function openDesktops() {
  const Desktops = OPERATOR_SURFACES.desktops;
  return render(
    <Suspense fallback={<p>Loading surface</p>}>
      <Desktops />
    </Suspense>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  H.rows = [
    workspace("Old workspace", "absent"),
    workspace("Research workspace"),
  ];
  H.localRows = [];
  H.params = { app: "desktops", step: "operate", tab: "desktops" };
  H.updates = [];
  H.loading = false;
  H.error = null;
});

describe("portal Desktops entry — approved option B", () => {
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
    expect(screen.getByRole("button", { name: "Watch browser" })).toBeTruthy();
    expect(screen.getByText("Agent su-1")).toBeTruthy();
  });
});
