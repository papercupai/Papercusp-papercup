// @vitest-environment jsdom
import { createElement, StrictMode, useCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { NuqsAdapter } from "../../../operator-vite/src/lib/nuqs-tanstack-router-adapter";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { OperatorWorkspaceLocationProvider } from "@papercusp/operator-ui";
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION, currentTutorialStep, type TutorialEvent, type TutorialState } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { hostedBrowserApiMarker } from "../hosted-browser-api";
import CloudWorkspacesPage from "@/app/cloud-workspaces/page";
import type { CloudWorkspacesControlRow } from "@/app/cloud-workspaces/page";

type TutorialObservation = Extract<TutorialEvent, { type: "observe" }>["observation"];
const data = vi.hoisted(() => ({
  rows: [] as CloudWorkspacesControlRow[], loading: false, error: null as Error | null, mutate: vi.fn(), invalidate: vi.fn(),
  companionInputs: [] as Array<{ configurationValid: boolean; configurationReviewed: boolean; boundWorkspaceId: string | null; workspaceId: string | null; workspaceReady: boolean }>,
  observations: [] as unknown[], states: [] as unknown[], routeErrors: [] as string[],
  injectionMode: null as null | "stale-next-reviewed",
  injectedObservations: [] as Array<{ emitted: TutorialObservation; injected: TutorialObservation; priorRevision: number }>,
  replayObservation: null as null | ((observation: TutorialObservation) => void),
}));
// Substitute only the authenticated network boundary. The Cloud forms, Radix
// dialog, guide, highlighting, URL state and router are actual application code.
vi.mock("@papercusp/sync", async importOriginal => ({
  ...(await importOriginal<typeof import("@papercusp/sync")>()),
  useSyncQuery: () => ({ data: data.rows, loading: data.loading, fetching: false, error: data.error, invalidate: data.invalidate }),
  useSyncMutate: () => data.mutate, planChunks: vi.fn(),
}));
vi.mock("@/lib/onboarding/use-cloud-tutorial-progress", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/onboarding/use-cloud-tutorial-progress")>();
  return {
    ...actual,
    useCloudTutorialProgress: (...args: Parameters<typeof actual.useCloudTutorialProgress>) => {
      const result = actual.useCloudTutorialProgress(...args);
      if (result.state) data.states.push(result.state);
      data.replayObservation = observation => result.dispatch({ type: "observe", observation });
      const dispatch = useCallback((event: Parameters<typeof result.dispatch>[0]) => {
        if (event.type === "observe") {
          data.observations.push(event.observation);
          if (data.injectionMode === "stale-next-reviewed" && event.observation.configuration?.costReviewed === true) {
            data.injectionMode = null;
            const current = data.states.at(-1) as TutorialState | undefined;
            const priorRevision = current?.observation?.revision ?? 0;
            const injected = { ...event.observation, revision: priorRevision };
            data.injectedObservations.push({ emitted: event.observation, injected, priorRevision });
            return result.dispatch({ ...event, observation: injected });
          }
        }
        return result.dispatch(event);
      }, [result.dispatch]);
      return { ...result, dispatch };
    },
  };
});
vi.mock("@/lib/onboarding/cloud-tutorial-companion", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/onboarding/cloud-tutorial-companion")>();
  return {
    ...actual,
    CloudTutorialCompanion: (props: Parameters<typeof actual.CloudTutorialCompanion>[0]) => {
      const row = props.workspace;
      data.companionInputs.push({
        configurationValid: props.configurationValid,
        configurationReviewed: props.configurationReviewed,
        boundWorkspaceId: props.boundWorkspaceId,
        workspaceId: row?.id ?? null,
        workspaceReady: Boolean(row && row.observedState === "running" && row.desiredState === "running" &&
          row.health?.status === "healthy" && props.boundWorkspaceId === row.id),
      });
      return createElement(actual.CloudTutorialCompanion, props);
    },
  };
});
const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
const connection: CloudWorkspacesControlRow = { kind: "connection", id: "gcp", target: "gcp", label: "My GCP", status: "connected", credentialRef: "env:CREDENTIAL", scopes: [], regions: [], sizes: [], images: [], networks: [] };
const workspace: CloudWorkspacesControlRow = { kind: "workspace", id: "customer", name: "My workspace", connectionId: "gcp", target: "gcp", scopeLabel: "project", region: "us-central1", size: "small", image: "ubuntu", diskGiB: 100, network: "private", desiredState: "running", observedState: "running", recoverability: { kind: "none", label: "No backup" }, capabilities: { stop: true, repair: true, snapshot: true, destroy: true } };
function resetNuqsUpdateQueue() {
  // nuqs keeps its throttle queue at module scope; clear pending work before
  // mounting an independent router in this integration-test fixture.
  render(<NuqsTestingAdapter>{null}</NuqsTestingAdapter>).unmount();
}
function mount(initial = "/cloud-workspaces", options: { resetQueue?: boolean } = {}) {
  if (options.resetQueue !== false) resetNuqsUpdateQueue();
  const root = createRootRoute({
    component: () => <NuqsAdapter><main><Outlet /></main></NuqsAdapter>,
    onCatch: error => { data.routeErrors.push(error.stack ?? error.message); },
    errorComponent: ({ error }) => <pre data-testid="cloud-route-error">{error.stack ?? error.message}</pre>,
  });
  const cloud = createRoute({ getParentRoute: () => root, path: "/cloud-workspaces", component: CloudWorkspacesPage });
  const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <h1>Other view</h1> });
  const router = createRouter({ routeTree: root.addChildren([cloud, other]), history: createMemoryHistory({ initialEntries: [initial] }) });
  const view = render(<StrictMode><OperatorWorkspaceLocationProvider location="cloud"><RouterProvider router={router} /></OperatorWorkspaceLocationProvider></StrictMode>);
  return { ...view, router };
}
beforeEach(() => {
  data.rows = []; data.loading = false; data.error = null; data.mutate.mockReset().mockResolvedValue({ ok: true }); data.invalidate.mockReset().mockResolvedValue(undefined);
  data.companionInputs = []; data.observations = []; data.states = []; data.routeErrors = [];
  data.injectionMode = null; data.injectedObservations = []; data.replayObservation = null;
  window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker("control");
  delete window.__PAPERCUSP_HOSTED_BROWSER_API__;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  let revision = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const patch = init?.body ? JSON.parse(init.body) : null;
    const version = String(_url).includes("version=2") ? 2 : CLOUD_TUTORIAL_VERSION;
    return new Response(JSON.stringify({ record: { revision: patch ? ++revision : revision, mutationId: patch?.mutationId ?? null,
      progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version, disposition: patch?.disposition ?? "active" } } }));
  }));
});
afterEach(() => {
  const routeError = screen.queryByTestId("cloud-route-error")?.textContent;
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__PAPERCUSP_HOSTED_BROWSER__;
  // A routed render failure must remain visible even if an earlier assertion passed.
  expect(routeError).toBeUndefined();
  expect(data.routeErrors).toEqual([]);
});
function expectNoHiddenProductWrites() {
  expect(data.mutate).not.toHaveBeenCalled();
  for (const [input, init] of vi.mocked(fetch).mock.calls) {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    // Progress persistence is allowed; provisioning, repair and agent requests are not.
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/api/hosted/browser/onboarding/tutorial-progress");
    expect(init?.method ?? "GET").toMatch(/^(GET|POST)$/);
  }
}
describe("Cloud Guide mounted on the maintained hosted Cloud surface", () => {
  it.each(["gcp", "aws"])("selects an authorized healthy %s prepared workspace with provider-neutral cost guidance and no provisioning", async target => {
    data.rows = [{ ...connection, id: target, target }, { ...workspace, target, connectionId: target, health: { status: "healthy", checks: [] }, estimatedMonthlyUsd: 18.5 },
      { ...workspace, id: "stopped", name: "Stopped", desiredState: "stopped" },
      { ...workspace, id: "unhealthy", name: "Unhealthy", health: { status: "unhealthy", checks: [] } }];
    const { router } = mount();
    const entry = await screen.findByRole("region", { name: "Beginner workspace entry" });
    expect(within(entry).getByText(/existing model and account defaults.*interactive mode/)).toBeTruthy();
    expect(within(entry).getByText(/\$18.50 per month/)).toBeTruthy();
    expect(within(entry).queryAllByRole("button", { name: /Use prepared workspace/ })).toHaveLength(1);
    fireEvent.click(within(entry).getByRole("button", { name: "Use prepared workspace My workspace" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ host: "customer", step: "operate", tab: "cost" }));
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    expect(within(guide).getByText(/Your cloud provider bills for provisioned resources, including retained disks/)).toBeTruthy();
    expect(guide.textContent).not.toContain("Google Cloud bills");
    const cost = document.querySelector<HTMLElement>('[data-tutorial-target="cloud-configuration"]')!;
    expect(within(cost).getByText(/Your cloud provider bills for provisioned resources and retained disks/)).toBeTruthy();
    expect(cost.textContent).not.toContain("Google Cloud bills");
    expect(screen.queryByRole("textbox", { name: "Connection label" })).toBeNull();
    expect(fetch).toHaveBeenCalled(); // Positive control for the network assertion.
    expectNoHiddenProductWrites();
  });
  it("explains missing preparation and opens the maintained advanced BYOC form only after an explicit choice", async () => {
    const { router } = mount();
    const entry = await screen.findByRole("region", { name: "Beginner workspace entry" });
    expect(within(entry).getByText(/No prepared healthy workspace.*administrator/)).toBeTruthy();
    expect(within(entry).queryByRole("button", { name: /Use prepared workspace/ })).toBeNull();
    fireEvent.click(within(entry).getByRole("button", { name: "Advanced: connect my own cloud" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tutorial: "advanced", step: "connect", connect: "gcp" }));
    await screen.findByRole("textbox", { name: "Connection label" });
    expectNoHiddenProductWrites();
    fireEvent.click(screen.getByRole("button", { name: "Use a prepared workspace instead" }));
    await screen.findByRole("region", { name: "Beginner workspace entry" });
    expectNoHiddenProductWrites();
  });
  it("offers only the authorized prepared target when the URL names a foreign workspace", async () => {
    // The HTTP/RLS companion case verifies that B is excluded by the server.
    // Here the actual page receives that authorized A list, while the URL
    // attempts to select B. Navigation cannot manufacture a second target.
    data.rows = [connection, { ...workspace, name: "Authorized workspace", health: { status: "healthy", checks: [] } }];
    const { router } = mount("/cloud-workspaces?host=foreign-workspace");
    const entry = await screen.findByRole("region", { name: "Beginner workspace entry" });
    const choices = within(entry).getAllByRole("button", { name: /Use prepared workspace/ });
    expect(choices).toHaveLength(1);
    expect(choices[0].getAttribute("aria-label")).toBe("Use prepared workspace Authorized workspace");
    expect(entry.textContent).not.toContain("foreign-workspace");
    expectNoHiddenProductWrites();
    fireEvent.click(choices[0]);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ host: workspace.id, step: "operate", tab: "cost" }));
    await screen.findByRole("region", { name: "First agent guide" });
    expectNoHiddenProductWrites();
  });
  it.each(["loading", "denied"])("does not offer stale workspace selections while access is %s", async mode => {
    data.rows = [{ ...workspace, health: { status: "healthy", checks: [] } }];
    data.loading = mode === "loading"; data.error = mode === "denied" ? new Error("private access detail") : null;
    mount();
    const entry = await screen.findByRole("region", { name: "Beginner workspace entry" });
    expect(within(entry).queryByRole("button", { name: /Use prepared workspace/ })).toBeNull();
    expect(entry.textContent).not.toContain("private access detail");
    expectNoHiddenProductWrites();
  });

  it.each([
    { desiredState: "stopped", observedState: "running" },
    { desiredState: "running", observedState: "provisioning" },
    { desiredState: "running", observedState: "absent" },
    { desiredState: "running", observedState: "degraded" },
  ] as const)("does not offer a healthy workspace with desired=$desiredState and observed=$observedState", async lifecycle => {
    data.rows = [{ ...workspace, ...lifecycle, health: { status: "healthy", checks: [] } }];
    mount();
    const entry = await screen.findByRole("region", { name: "Beginner workspace entry" });
    expect(within(entry).getByText(/No prepared healthy workspace.*administrator/)).toBeTruthy();
    expect(within(entry).queryByRole("button", { name: /Use prepared workspace/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Connection label" })).toBeNull();
    expectNoHiddenProductWrites();
  });

  it("discloses cost before the user provisions and leaves the real provision action untouched by guide controls", async () => {
    data.rows = [{ ...connection,
      scopes: [{ id: "project", label: "Tutorial project" }],
      regions: [{ id: "us-central1", label: "Iowa", zones: ["us-central1-a"] }],
      sizes: [{ id: "small", label: "Small", vcpu: 2, memoryGiB: 2, hourlyUsd: 0.02 }],
      images: [{ id: "ubuntu", label: "Ubuntu" }],
      networks: [{ id: "private", label: "Private" }],
    }];
    mount("/cloud-workspaces?step=configure&connection=gcp&name=Cost%20review&scope=project&region=us-central1&size=small&image=ubuntu&network=private");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    const estimate = screen.getByRole("group", { name: "Estimated workspace cost" });
    expect(within(estimate).getByText("Estimated monthly cost")).toBeTruthy();
    expect(within(estimate).getByText(/730 compute hours.*selected disk.*provider taxes and egress excluded/)).toBeTruthy();
    expect(within(guide).getByText(/Google Cloud bills for provisioned resources, including retained disks/)).toBeTruthy();
    const provision = screen.getByRole("button", { name: "Provision workspace" }) as HTMLButtonElement;
    await waitFor(() => expect(provision.disabled).toBe(false));
    for (const name of ["Show me", "Pause", "Resume guide"])
      fireEvent.click(within(guide).getByRole("button", { name }));
    expect(data.mutate).not.toHaveBeenCalled();
    // Positive control: the maintained product action exists and dispatches
    // only after the user operates its enabled control.
    fireEvent.click(provision);
    await waitFor(() => expect(data.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: "provision" })));
  });
  it("explains unmet provisioning prerequisites and keeps the actual product action blocked", async () => {
    data.rows = [connection];
    mount("/cloud-workspaces?step=configure&name=Prerequisite%20review");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    const provision = screen.getByRole("button", { name: "Provision workspace" }) as HTMLButtonElement;
    expect(provision.disabled).toBe(true);
    expect(provision.getAttribute("aria-describedby")).toBe("provision-readiness");
    const readiness = document.getElementById("provision-readiness")!;
    expect(within(readiness).getByText(/Provisioning blocked/)).toBeTruthy();
    for (const name of ["Project, account, or subscription loaded", "Region loaded", "Machine size loaded", "Image loaded", "Network loaded"])
      expect(within(readiness).getByText(name)).toBeTruthy();
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    fireEvent.click(provision);
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it.each([false, true])("recognizes an existing healthy workspace with Nuqs queue reset=%s, records real cost review and waits for the host-specific connector", async resetQueue => {
    data.rows = [connection, { ...workspace, health: { status: "healthy", checks: [] } }];
    mount("/cloud-workspaces?step=operate&host=customer", { resetQueue });
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const review = await screen.findByRole("button", { name: "I've reviewed the configuration and cost" });
    expect(document.querySelector('[data-tutorial-target="cloud-configuration"]')).not.toBeNull();
    const inputStart = data.companionInputs.length;
    const observationStart = data.observations.length;
    const stateStart = data.states.length;
    const boundaryTrace = () => {
      const input = data.companionInputs.slice(inputStart).at(-1);
      const observation = data.observations.slice(observationStart).at(-1) as {
        scope?: { tenantId?: string; userId?: string; workspaceId?: string };
        revision?: number;
        configuration?: { connectionId?: string; valid?: boolean; costReviewed?: boolean };
        workspace?: { id?: string; connectionId?: string; healthy?: boolean };
      } | undefined;
      const state = data.states.slice(stateStart).at(-1) as TutorialState | undefined;
      return {
        // Keep the failure record self-contained under the test ledger's output-tail cap.
        // input=[valid,reviewed,boundWorkspaceId,workspaceId,ready]; emitted=[scopeMatches,revision,connectionId,valid,costReviewed,workspaceId,healthy]; applied=[scopeMatches,revision,connectionId,valid,costReviewed,currentStep].
        input: input && [input.configurationValid, input.configurationReviewed, input.boundWorkspaceId, input.workspaceId, input.workspaceReady],
        emitted: observation && [JSON.stringify(observation.scope) === JSON.stringify(scope), observation.revision,
          observation.configuration?.connectionId, observation.configuration?.valid, observation.configuration?.costReviewed,
          observation.workspace?.id, observation.workspace?.healthy],
        applied: state && [JSON.stringify(state.observation?.scope) === JSON.stringify(scope), state.observation?.revision,
          state.observation?.configuration?.connectionId, state.observation?.configuration?.valid,
          state.observation?.configuration?.costReviewed, currentTutorialStep(state)?.id],
        guideConnected: guide.isConnected,
        routeErrors: data.routeErrors.map(error => error.split("\n")[0]).slice(-2),
        headings: within(guide).queryAllByRole("heading").map(heading => heading.textContent),
      };
    };
    const withBoundaryTrace = (stage: string) => () =>
      new Error(`V1 boundary timeout (${stage}): ${JSON.stringify(boundaryTrace())}`);
    fireEvent.click(review);
    await waitFor(() => expect(data.companionInputs.slice(inputStart).some(input => input.configurationReviewed)).toBe(true),
      { onTimeout: withBoundaryTrace("companion-input") });
    const reviewedInput = data.companionInputs.slice(inputStart).filter(input => input.configurationReviewed).at(-1);
    expect(reviewedInput).toMatchObject({ configurationValid: true, configurationReviewed: true,
      boundWorkspaceId: null, workspaceId: "customer", workspaceReady: false });
    await waitFor(() => expect(data.observations.slice(observationStart).some(value => {
      const observation = value as { scope?: { tenantId?: string; userId?: string; workspaceId?: string }; revision?: number;
        configuration?: { valid?: boolean; costReviewed?: boolean }; workspace?: { id?: string; healthy?: boolean } };
      return observation.scope?.tenantId === scope.tenantId && observation.scope.userId === scope.userId &&
        observation.scope.workspaceId === scope.workspaceId && typeof observation.revision === "number" &&
        Number.isSafeInteger(observation.revision) && observation.configuration?.valid === true &&
        observation.configuration.costReviewed === true &&
        observation.workspace?.id === "customer" && observation.workspace?.healthy === false;
    })).toBe(true), { onTimeout: withBoundaryTrace("emitted-observation") });
    await waitFor(() => {
      const state = data.states.slice(stateStart).at(-1) as TutorialState | undefined;
      expect(state && currentTutorialStep(state)?.id).toBe("workspace");
    }, { onTimeout: withBoundaryTrace("applied-state") });
    const appliedState = data.states.slice(stateStart).at(-1) as TutorialState;
    expect(appliedState.observation).toMatchObject({
      scope,
      revision: expect.any(Number),
      configuration: { connectionId: "gcp", valid: true, costReviewed: true },
      workspace: { id: "customer", connectionId: "gcp", healthy: false },
    });
    expect(data.observations.slice(observationStart).some(value => {
      const observation = value as { scope?: unknown; revision?: number; configuration?: { costReviewed?: boolean } };
      return observation.revision === appliedState.observation?.revision &&
        JSON.stringify(observation.scope) === JSON.stringify(appliedState.observation?.scope) &&
        observation.configuration?.costReviewed === appliedState.observation?.configuration?.costReviewed;
    })).toBe(true);
    await waitFor(() => expect(within(guide).queryByRole("heading", { name: "Wait for a healthy workspace" })).toBeTruthy(),
      { onTimeout: withBoundaryTrace("rendered-heading") });
    expect(JSON.stringify(boundaryTrace()).length).toBeLessThan(600);
    expect(screen.queryByRole("button", { name: "+ New session" })).toBeNull();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("isolates a V1 stale-revision rejection between the emitted observation and rendered guide", async () => {
    data.rows = [connection, { ...workspace, health: { status: "healthy", checks: [] } }];
    mount("/cloud-workspaces?step=operate&host=customer");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const review = await screen.findByRole("button", { name: "I've reviewed the configuration and cost" });
    await waitFor(() => {
      const state = data.states.at(-1) as TutorialState | undefined;
      expect(state && currentTutorialStep(state)?.id).toBe("configuration");
      expect(state?.observation?.revision).toBeGreaterThan(0);
    });
    const priorRevision = (data.states.at(-1) as TutorialState).observation!.revision;

    data.injectionMode = "stale-next-reviewed";
    fireEvent.click(review);
    await waitFor(() => expect(data.injectedObservations).toHaveLength(1));
    const injection = data.injectedObservations[0];
    expect(injection.emitted).toMatchObject({ scope, configuration: { valid: true, costReviewed: true } });
    expect(injection.emitted.revision).toBeGreaterThan(priorRevision);
    expect(injection.priorRevision).toBe(priorRevision);
    expect(injection.injected.revision).toBe(priorRevision);

    const rejectedState = data.states.at(-1) as TutorialState;
    expect(rejectedState.observation?.revision).toBe(priorRevision);
    expect(currentTutorialStep(rejectedState)?.id).toBe("configuration");
    expect(within(guide).getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();

    await act(async () => data.replayObservation?.(injection.emitted));
    await waitFor(() => {
      const state = data.states.at(-1) as TutorialState | undefined;
      expect(state && currentTutorialStep(state)?.id).toBe("workspace");
    });
    await within(guide).findByRole("heading", { name: "Wait for a healthy workspace" });
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("keeps a prepared-workspace cost review when its connection row is absent from the control response", async () => {
    data.rows = [{ ...workspace, health: { status: "healthy", checks: [] } }];
    mount("/cloud-workspaces?tutorial=beginner&step=operate&host=customer&tab=cost");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    fireEvent.click(await screen.findByRole("button", { name: "I've reviewed the configuration and cost" }));

    await waitFor(() => expect(data.observations.some(value => {
      const observation = value as { configuration?: { connectionId?: string; valid?: boolean; costReviewed?: boolean } };
      return observation.configuration?.connectionId === "gcp" && observation.configuration.valid === true &&
        observation.configuration.costReviewed === true;
    })).toBe(true));
    await waitFor(() => {
      const state = data.states.at(-1) as TutorialState | undefined;
      expect(state && currentTutorialStep(state)?.id).toBe("workspace");
    });
    const state = data.states.at(-1) as TutorialState;
    expect(state.observation).toMatchObject({
      configuration: { connectionId: "gcp", valid: true, costReviewed: true },
      workspace: { id: "customer", connectionId: "gcp", healthy: false },
    });
    await within(guide).findByRole("heading", { name: "Wait for a healthy workspace" });
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("explains and highlights the actual connection action without filling or submitting the form", async () => {
    const { router } = mount();
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Connection label" });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ step: "connect", connect: "gcp" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Tab", cancelable: true })).toBe(true);
    fireEvent.change(input, { target: { value: "My project" } });
    expect(input).toHaveProperty("value", "My project");
    expect(document.activeElement).toBe(input);
    expect(within(guide).getByText("0 of 6 steps confirmed")).toBeTruthy();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("recovers a missing real target by navigation, preserving confirmed prerequisites and user input", async () => {
    data.rows = [connection];
    mount("/cloud-workspaces?step=connect");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    expect(document.querySelector('[data-tutorial-target="cloud-configuration"]')).toBeNull();
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const target = await waitFor(() => {
      const target = document.querySelector<HTMLElement>('[data-tutorial-target="cloud-configuration"]');
      expect(target).not.toBeNull(); return target!;
    });
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(within(guide).getByText("1 of 6 steps confirmed")).toBeTruthy();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("offers pause/resume/skip and replay from Help while retaining the actual form", async () => {
    mount(); const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Connection label" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(within(guide).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    expect(input).toHaveProperty("value", "Keep this draft");
    fireEvent.click(within(guide).getByRole("button", { name: "Resume guide" }));
    fireEvent.click(within(guide).getByRole("button", { name: "Skip lesson" }));
    expect(within(guide).getByText(/start this lesson again from Help/)).toBeTruthy();
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(within(guide).getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Connection label" })).toBe(input);
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("keeps the actual product destroy dialog operable without activating its destructive action", async () => {
    data.rows = [connection, workspace];
    mount("/cloud-workspaces?step=operate");
    await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(await screen.findByRole("button", { name: "More actions for My workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Destroy" }));
    const dialog = await screen.findByRole("dialog", { name: "Destroy My workspace" });
    expect(within(dialog).getByRole("button", { name: /Confirm destroy/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(data.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "First agent guide" })).toBeTruthy();
  });
  it("closes and reopens from Help, then cleans overlays on route exit", async () => {
    const { router } = mount(); const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(within(guide).getByRole("button", { name: "Close guide" }));
    expect(screen.queryByRole("region", { name: "First agent guide" })).toBeNull();
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    await screen.findByRole("region", { name: "First agent guide" });
    await waitFor(() => expect(document.querySelectorAll(".react-joyride__overlay")).toHaveLength(1));
    await act(async () => { await router.navigate({ to: "/other" }); });
    await screen.findByRole("heading", { name: "Other view" });
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay, [data-cloud-tutorial-highlight], [data-cloud-tutorial-guide]")).toBeNull());
    expect(data.mutate).not.toHaveBeenCalled();
  });
});
