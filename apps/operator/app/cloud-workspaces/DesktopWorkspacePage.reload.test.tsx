// @vitest-environment jsdom
import { Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { OperatorWorkspaceLocationProvider } from "@papercusp/operator-ui/seam";
import { OPERATOR_SURFACES } from "@papercusp/operator-ui/surfaces";
import { setBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

const inventory = vi.hoisted(() => ({ rows: [] as WorkspaceHostControlRow[] }));

// Only the inventory transport is doubled. The portal's mounted surface,
// Nuqs parsing, workspace resolution and resulting desktop region are real.
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({
    data: inventory.rows,
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  }),
  useSyncMutate: () => vi.fn(),
}));
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, options, onChange, ariaLabel }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => <select aria-label={ariaLabel} value={value}
    onChange={event => onChange(event.target.value)}>
    <option value="">Choose a workspace</option>
    {options.map(option => <option key={option.value} value={option.value}>
      {option.label}
    </option>)}
  </select>,
}));

function privateWorkspace(id: string, name: string): WorkspaceHostControlRow {
  return {
    kind: "workspace", id, name, connectionId: "private-fixture",
    target: "gcp", scopeLabel: "private-fixture", region: "test-region",
    size: "small", image: "linux", diskGiB: 40, network: "private",
    desiredState: "running", observedState: "running",
    recoverability: { kind: "none", label: "No snapshot" },
    capabilities: { start: false, stop: false, repair: false, snapshot: false, destroy: false },
  };
}

const research = privateWorkspace("private-host/research", "Private Research");
const production = privateWorkspace("private-host/production", "Private Production");

function openDeepLink(subject: WorkspaceHostControlRow) {
  const url = new URL("/portal", window.location.origin);
  url.searchParams.set("app", "desktops");
  url.searchParams.set("ws", "private-account");
  url.searchParams.set("desktopHost", subject.id);
  window.history.replaceState(null, "", url);
}

function mountFromLocation() {
  const Desktops = OPERATOR_SURFACES.desktops;
  return render(
    <Suspense fallback={<p>Loading portal surface</p>}>
      <OperatorWorkspaceLocationProvider location="cloud">
        <Desktops />
      </OperatorWorkspaceLocationProvider>
    </Suspense>,
    { wrapper: withNuqsTestingAdapter({
      searchParams: window.location.search,
      hasMemory: true,
      onUrlUpdate: ({ queryString }) => {
        window.history.replaceState(null, "", window.location.pathname + queryString);
      },
    }) },
  );
}

async function expectResolvedSubject(subject: WorkspaceHostControlRow, other: WorkspaceHostControlRow) {
  expect(await screen.findByRole("region", { name: `Desktops for ${subject.name}` })).toBeTruthy();
  const selected = screen.getByRole("combobox", { name: "Desktop workspace" }) as HTMLSelectElement;
  expect(selected.value).toBe(subject.id);
  expect(selected.selectedOptions[0]?.textContent).toBe(subject.name);
  expect(screen.queryByRole("region", { name: `Desktops for ${other.name}` })).toBeNull();
  expect(new URL(window.location.href).searchParams.get("desktopHost")).toBe(subject.id);
}

beforeEach(() => {
  window.sessionStorage.clear();
  inventory.rows = [research, production];
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("PARITY-P005-SCOPE mounted portal subject reload", () => {
  it.each([
    [research.name, research, production],
    [production.name, production, research],
  ] as const)(
    "restores the deep-linked private subject %s from its URL after a fresh mount",
    async (_name, subject, other) => {
      setBrowserMachineId(other.id);
      openDeepLink(subject);
      const initialUrl = window.location.href;
      const first = mountFromLocation();
      await expectResolvedSubject(subject, other);
      expect(window.location.href).toBe(initialUrl);

      // A unit reload destroys component/adapter state and reconstructs both
      // from the serialized browser URL. A conflicting saved machine and a
      // reordered inventory make a silent default fallback observable.
      first.unmount();
      window.sessionStorage.clear();
      setBrowserMachineId(other.id);
      inventory.rows = [other, subject];
      const reloadedUrl = window.location.href;
      const second = mountFromLocation();
      await expectResolvedSubject(subject, other);
      expect(window.location.href).toBe(reloadedUrl);
      expect(reloadedUrl).toBe(initialUrl);
      second.unmount();
    },
  );

  it("keeps an unavailable deep-linked subject explicit after reload instead of resolving the other workspace", async () => {
    openDeepLink(production);
    const first = mountFromLocation();
    await expectResolvedSubject(production, research);
    const selectedUrl = window.location.href;

    first.unmount();
    inventory.rows = [research];
    setBrowserMachineId(research.id);
    mountFromLocation();
    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(window.location.href).toBe(selectedUrl);
    expect(new URL(window.location.href).searchParams.get("desktopHost")).toBe(production.id);
    expect(screen.queryByRole("region", { name: `Desktops for ${research.name}` })).toBeNull();
    expect(screen.queryByRole("region", { name: `Desktops for ${production.name}` })).toBeNull();
  });
});
