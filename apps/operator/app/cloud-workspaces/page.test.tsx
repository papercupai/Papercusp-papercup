// @vitest-environment jsdom

/**
 * Cloud Workspaces — the guided rail.
 *
 * Every invariant the pre-redesign suite pinned is re-expressed here against
 * the new UI; none was dropped. Where the redesign moved a control, the test
 * moved with it and says so:
 *
 *  - Validate now lives on the Connect stage, Stop/Repair on Operate, so the
 *    overlapping-mutation invariant is exercised with TWO HOSTS rather than
 *    two stages (it was always about per-key independence, not about which
 *    section the buttons sat in);
 *  - Destroy moved into the row overflow menu, so the destroy tests open it;
 *  - the semicolon-joined blocker sentence became the readiness checklist, so
 *    the fix strings are asserted on the checklist;
 *  - machine sizes became radio cards, so the size-describedby case is
 *    asserted on the empty-catalog fallback (which is still a combobox);
 *  - the hosted session mounts inside the expanded host panel, so the test
 *    expands the host first.
 *
 * New coverage the redesign earns: step routing/landing/degradation, the rail
 * status column, and the single drift chip.
 */

import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as Error | null,
  loading: false,
  mutate: vi.fn(),
  invalidate: vi.fn(),
  tooltip: vi.fn(),
  queryDefaults: {} as Record<string, unknown>,
  queryUpdates: [] as Array<[string, unknown]>,
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({
    data: H.rows,
    error: H.error,
    loading: H.loading,
    fetching: false,
    invalidate: H.invalidate,
  }),
  useSyncMutate: () => H.mutate,
}));

vi.mock("nuqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nuqs")>();
  const React = await import("react");
  return {
    // Expanded host details compose collection parsers. Keep the real parser
    // API so nested surfaces can add query types without breaking this fixture.
    ...actual,
    useQueryState: (key: string, config?: { defaultValue?: unknown }) => {
      const [value, setValue] = React.useState(
        Object.prototype.hasOwnProperty.call(H.queryDefaults, key)
          ? H.queryDefaults[key]
          : (config?.defaultValue ?? null),
      );
      const setQueryValue = React.useCallback(
        (next: unknown) => {
          H.queryUpdates.push([key, next]);
          setValue(next);
          return Promise.resolve(next);
        },
        [key],
      );
      return [value, setQueryValue];
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    options,
    ariaLabel,
    placeholder,
    disabled,
    describedBy,
  }: {
    value: string;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel: string;
    placeholder?: string;
    disabled?: boolean;
    describedBy?: string;
  }) => (
    <button
      type="button"
      role="combobox"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      {String(
        options.find((option) => option.value === value)?.label ??
          placeholder ??
          "",
      )}
    </button>
  ),
}));

vi.mock("@/app/harness/Modal", () => ({
  Modal: ({
    open,
    title,
    children,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <button aria-label="Close modal" onClick={() => onOpenChange?.(false)} />
        {children}
      </section>
    ) : null,
}));

/* Record the reason supplied to the portalled tooltip as well as the
   accessible name on its trigger. */
vi.mock("@/app/harness/Tooltip", () => ({
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => {
    H.tooltip(label);
    return <>{children}</>;
  },
}));

import CloudWorkspacesPage, {
  type CloudWorkspacesControlRow,
  workspaceHostActionRest,
  workspaceHostIdFromName,
} from "./page";
import { focusSafely } from "./stage-primitives";
import { EMPTY_CONNECT_DRAFT, connectionActionFromDraft } from "./ConnectStage";

const cloudPageCss = readFileSync(
  "app/cloud-workspaces/cloud-workspaces.module.css",
  "utf8",
);

const connectionRow: CloudWorkspacesControlRow = {
  kind: "connection",
  id: "gcp-main",
  target: "gcp",
  label: "Production GCP",
  status: "connected",
  credentialRef: "env:GCP_APPLICATION_CREDENTIALS",
  lastValidatedAt: "2026-08-22T05:00:00.000Z",
  provider: {
    projectId: "papercusp-prod",
    serviceAccountEmail:
      "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
  },
  scopes: [{ id: "papercusp-prod", label: "papercusp-prod" }],
  regions: [
    {
      id: "us-central1",
      label: "Iowa · us-central1",
      zones: ["us-central1-a"],
    },
  ],
  sizes: [
    {
      id: "e2-standard-4",
      label: "e2-standard-4",
      vcpu: 4,
      memoryGiB: 16,
      hourlyUsd: 0.08,
    },
  ],
  images: [
    {
      id: "projects/papercusp-images/global/images/ubuntu-2404",
      version: "ubuntu-2404",
      label: "Ubuntu 24.04 LTS",
    },
  ],
  networks: [{ id: "managed", label: "Papercusp-managed private network" }],
  diskPricePerGiBMonth: 0.145,
};

const workspaceRow: CloudWorkspacesControlRow = {
  kind: "workspace",
  id: "host-1",
  name: "research-control",
  connectionId: "gcp-main",
  target: "gcp",
  scopeLabel: "papercusp-prod",
  region: "us-central1",
  size: "e2-standard-4",
  image: "ubuntu-2404",
  diskGiB: 100,
  network: "default",
  estimatedMonthlyUsd: 72.9,
  desiredState: "running",
  observedState: "running",
  observedAt: "2026-08-22T05:10:00.000Z",
  providerResourceId:
    "projects/papercusp-prod/zones/us-central1-a/instances/research-control",
  endpoint: "ssh://10.0.0.8",
  recoverability: {
    kind: "snapshot",
    label: "snapshot-20260822",
    updatedAt: "2026-08-22T04:50:00.000Z",
  },
  capabilities: {
    start: false,
    stop: true,
    repair: true,
    snapshot: true,
    destroy: true,
  },
  resources: [
    {
      logicalKey: "vm",
      kind: "vm",
      state: "applied",
      providerId:
        "projects/papercusp-prod/zones/us-central1-a/instances/research-control",
      providerRequestId: "request-1",
      attempts: 1,
      updatedAt: "2026-08-22T05:08:00.000Z",
    },
  ],
  health: {
    status: "healthy",
    attestedAt: "2026-08-22T05:09:00.000Z",
    checks: [{ name: "systemd", ok: true }],
    bootstrapVersion: "1.4.0",
  },
  versionDrift: [{ component: "agent", desired: "1.4.0", observed: "1.3.0" }],
  tunnel: { state: "connected", transport: "gcp-iap-ssh" },
  costSignals: [{ estimatedMonthlyUsd: 72.9 }],
  quotaSignals: [{ resource: "CPUS", remaining: 8 }],
  logs: [
    {
      id: "log-1",
      operationId: "op-1",
      observedAt: "2026-08-22T05:09:30.000Z",
      stream: "systemd",
      unit: "papercusp-agent",
      level: "info",
      message: "Agent ready",
    },
  ],
  operation: {
    id: "op-1",
    action: "provision",
    status: "succeeded",
    percent: 100,
    message: "Host attested",
    request: {
      image: "ubuntu-2404",
      credentialRef: "env:GCP_APPLICATION_CREDENTIALS",
    },
    events: [
      {
        id: "evt-1",
        ts: "2026-08-22T05:09:00.000Z",
        phase: "attest",
        status: "succeeded",
        level: "info",
        source: "controller",
        message: "Bootstrap healthy",
      },
    ],
  },
};

const rows: CloudWorkspacesControlRow[] = [connectionRow, workspaceRow];

/** The configure stage is only reachable once a connection exists. */
const onConfigure = { step: "configure" } as const;
/** Operate is the landing step whenever a workspace exists; be explicit anyway. */
const onOperate = { step: "operate" } as const;

beforeEach(() => {
  H.rows = rows;
  H.error = null;
  H.loading = false;
  H.mutate.mockReset().mockResolvedValue({ ok: true });
  H.invalidate.mockReset().mockResolvedValue(undefined);
  H.tooltip.mockReset();
  H.queryDefaults = {};
  H.queryUpdates = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CloudWorkspacesPage — rail and step routing", () => {
  it("lands on Operate when a workspace exists, and reports each step's evidence", () => {
    render(<CloudWorkspacesPage />);

    const rail = screen.getByRole("navigation", {
      name: "Cloud workspace setup",
    });
    expect(rail).toBeTruthy();

    const operateStep = screen.getByRole("button", { name: /03 Operate/ });
    expect(operateStep.getAttribute("aria-current")).toBe("step");
    /* Evidence, not a bare tick: every step states its own condition. */
    expect(operateStep.getAttribute("aria-label")).toContain("current step");
    /* A healthy connection reports WHEN it was validated, not just that it is. */
    expect(
      screen
        .getByRole("button", { name: /01 Connect/ })
        .getAttribute("aria-label"),
    ).toContain("GCP · validated");
    expect(operateStep.getAttribute("aria-label")).toContain(
      "1 workspace · all aligned",
    );

    expect(
      screen.getByRole("heading", { name: "Managed workspaces" }),
    ).toBeTruthy();
    /* One stage at a time: Connect's own heading is not on screen. */
    expect(
      screen.queryByRole("heading", { name: "Provider readiness" }),
    ).toBeNull();

    const stats = screen.getByRole("region", { name: "Fleet posture" });
    expect(stats.textContent).toContain("Running1");
    expect(stats.textContent).toContain("Drifting0");
    expect(stats.textContent).toContain("$72.90");
  });

  it("lands on Configure with a connection but no workspace, and on Connect with neither", () => {
    H.rows = [connectionRow];
    const { unmount } = render(<CloudWorkspacesPage />);
    expect(screen.getByRole("heading", { name: "New workspace" })).toBeTruthy();
    unmount();
    cleanup();

    H.rows = [];
    render(<CloudWorkspacesPage />);
    expect(
      screen.getByRole("heading", { name: "Provider readiness" }),
    ).toBeTruthy();
  });

  it("degrades an unreachable requested step instead of rendering a blank stage", () => {
    H.rows = [];
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    /* ?step=operate on a workspace-less install falls back to Connect. */
    expect(
      screen.getByRole("heading", { name: "Provider readiness" }),
    ).toBeTruthy();
    const operateStep = screen.getByRole("button", {
      name: /03 Operate/,
    }) as HTMLButtonElement;
    expect(operateStep.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps an unreachable rail step inert but still able to say why", () => {
    /* The rail's tooltip is enriched with `evidence` precisely in the
       unreachable case, and once the container query collapses .railStepBody
       away (<=1100px) it is the ONLY channel carrying that reason to a sighted
       pointer user. Tooltip is Radix (Trigger asChild), so it hangs pointer and
       focus listeners on the trigger — a natively `disabled` button dispatches
       neither, which made the explanation undeliverable in exactly the state
       that needed one, and dropped the step out of the tab order too.

       So: inert via aria-disabled, never the native attribute. */
    H.rows = [];
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    const operateStep = screen.getByRole("button", {
      name: /03 Operate/,
    }) as HTMLButtonElement;

    expect(operateStep.getAttribute("aria-disabled")).toBe("true");
    expect(operateStep.disabled).toBe(false);
    expect(operateStep.getAttribute("aria-label")).toContain("No workspaces yet");
    expect(H.tooltip).toHaveBeenCalledWith("03 Operate — No workspaces yet");

    /* Reachable by keyboard, which is what lets a keyboard user surface the
       reason at all. */
    operateStep.focus();
    expect(document.activeElement).toBe(operateStep);

    /* ...and still genuinely inert: clicking cannot strand the operator in an
       empty stage, which is the guarantee the native attribute used to carry. */
    fireEvent.click(operateStep);
    expect(H.queryUpdates).not.toContainEqual(["step", "operate"]);
  });

  it("navigates between reachable steps from the rail", () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole("button", { name: /02 Configure/ }));
    expect(H.queryUpdates).toContainEqual(["step", "configure"]);
    expect(screen.getByRole("heading", { name: "New workspace" })).toBeTruthy();
  });

  it("contributes no nested <main> landmark", () => {
    /* The ROUTER owns the document's single main landmark — __root.tsx renders
       <main data-route-transition-page>, the element GlobalFindInPage targets —
       so this page must not add a second one. A document with two nested <main>s
       is invalid and costs screen-reader users the landmark as a navigation aid.

       The pre-redesign suite pinned this indirectly, via
       expect(pageHeading.closest("main")).toBeNull(). That test was dropped in
       the guided-rail rewrite while the stage area simultaneously shipped as a
       <main>, so the regression became unpinned at the moment it was introduced
       (WI-370245 — found by the independent acceptance grader, not by us).
       Assert the property DIRECTLY rather than as a side effect of where the
       heading sits, so it cannot come back silently. */
    const { container } = render(<CloudWorkspacesPage />);

    /* Presence guard fused into the same test: a blank or crashed render would
       satisfy a zero-count assertion vacuously. The rail is present on every
       step, so requiring it proves the page actually mounted. */
    expect(
      screen.getByRole("navigation", { name: "Cloud workspace setup" }),
    ).toBeTruthy();

    /* Positive control for the INSTRUMENT, kept permanently rather than proven
       once by mutating the tree: a zero count means nothing unless the same
       query demonstrably finds a <main> when one is really there. */
    const control = document.createElement("div");
    control.innerHTML = "<main>control</main>";
    expect(control.querySelectorAll("main").length).toBe(1);

    expect(container.querySelectorAll("main").length).toBe(0);
  });
});

describe("CloudWorkspacesPage — mutation seam", () => {
  it("reconciles a timed-out validation from the later connection row without a false failure", async () => {
    H.rows = [connectionRow];
    H.queryDefaults = { step: "connect", connection: connectionRow.id };
    H.mutate.mockRejectedValueOnce(
      Object.assign(new Error("scheduler task timed out after 20000ms"), {
        name: "OriginSchedulerError",
        code: "timeout",
      }),
    );
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    const view = render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Validate Google Cloud connection" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      "Validation response timed out; checking connection status. It may still complete.",
    ));
    expect(H.invalidate).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    H.rows = [{ ...connectionRow, lastValidatedAt: "2026-08-22T05:01:00.000Z" }];
    view.rerender(<CloudWorkspacesPage />);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      "Production GCP connection status updated: connected",
    ));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ["gcp-main", "Production GCP"],
    ["gcp-secondary", "Selected GCP"],
  ])("validates the selected same-provider connection %s", async (id, label) => {
    H.rows = [
      connectionRow,
      { ...connectionRow, id: "gcp-secondary", label: "Selected GCP" },
    ];
    H.queryDefaults = { step: "connect", connection: id };
    render(<CloudWorkspacesPage />);

    const providers = within(screen.getByRole("list", { name: "Provider connections" }));
    expect(providers.getByText(label)).toBeTruthy();
    expect(
      providers.queryByText(id === "gcp-main" ? "Selected GCP" : "Production GCP"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Validate Google Cloud connection" }),
    );
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "validate-connection",
        connectionId: id,
      }),
    );
  });

  it("routes connection and lifecycle actions through the sync mutation seam", async () => {
    H.queryDefaults = { step: "connect" };
    const { unmount } = render(<CloudWorkspacesPage />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Validate Google Cloud connection",
      }),
    );
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "validate-connection",
        connectionId: "gcp-main",
      }),
    );
    unmount();
    cleanup();

    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Stop machine" }));
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "stop",
        workspaceId: "host-1",
      }),
    );
  });

  it("tracks overlapping mutations until each request settles", async () => {
    /*
     * Per-key busy tracking: two hosts stopped at once must disable
     * independently and each re-enable on its OWN settle.
     */
    H.rows = [
      connectionRow,
      workspaceRow,
      { ...workspaceRow, id: "host-2", name: "batch-runner" },
    ];
    H.queryDefaults = { ...onOperate };

    let resolveFirst!: (value: { ok: boolean }) => void;
    let resolveSecond!: (value: { ok: boolean }) => void;
    const first = new Promise<{ ok: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ ok: boolean }>((resolve) => {
      resolveSecond = resolve;
    });
    H.mutate.mockImplementation((args: { workspaceId?: string }) =>
      args.workspaceId === "host-1" ? first : second,
    );

    render(<CloudWorkspacesPage />);
    const [stopOne, stopTwo] = screen.getAllByRole("button", {
      name: "Stop machine",
    }) as HTMLButtonElement[];

    fireEvent.click(stopOne);
    await waitFor(() => expect(stopOne.disabled).toBe(true));
    /* The second host is untouched by the first host's in-flight mutation. */
    expect(stopTwo.disabled).toBe(false);

    fireEvent.click(stopTwo);
    await waitFor(() => {
      expect(stopOne.disabled).toBe(true);
      expect(stopTwo.disabled).toBe(true);
    });

    resolveSecond({ ok: true });
    await waitFor(() => expect(stopTwo.disabled).toBe(false));
    expect(stopOne.disabled).toBe(true);
    /* A re-click while still in flight is refused, not queued. */
    fireEvent.click(stopOne);
    expect(H.mutate).toHaveBeenCalledTimes(2);

    resolveFirst({ ok: true });
    await waitFor(() => expect(stopOne.disabled).toBe(false));
  });

  it("builds the canonical persisted desired spec for provisioning", async () => {
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Research Control" },
    });
    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    }) as HTMLButtonElement;
    expect(provision.disabled).toBe(false);
    fireEvent.click(provision);

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "provision",
        connectionId: "gcp-main",
        name: "Research Control",
        desired: {
          hostId: "host-research-control",
          target: "gcp",
          scope: { kind: "project", id: "papercusp-prod" },
          region: "us-central1",
          zone: "us-central1-a",
          size: "e2-standard-4",
          image: {
            id: "projects/papercusp-images/global/images/ubuntu-2404",
            version: "ubuntu-2404",
          },
          data: { volumeGiB: 100, encrypted: true },
          provider: { network: { mode: "managed" } },
        },
      }),
    );
  });

  it("dispatches each mutation family to its canonical REST route and surfaces typed errors", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, message: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspaceHostActionRest({
      action: "connect",
      target: "gcp",
      label: "GCP",
      credentialRef: "adc://default",
      projectId: "paper-prod",
      serviceAccountEmail: "host@paper-prod.iam.gserviceaccount.com",
    });
    await workspaceHostActionRest({
      action: "provision",
      connectionId: "gcp:production",
      name: "Research",
      desired: {
        hostId: "host-research",
        target: "gcp",
        scope: { kind: "project", id: "paper-prod" },
        region: "us-central1",
        zone: "us-central1-a",
        size: "e2-small",
        image: { id: "projects/images/global/images/papercusp-v1" },
        data: { volumeGiB: 100, encrypted: true },
        provider: { network: { mode: "managed" } },
      },
    });
    await workspaceHostActionRest({ action: "stop", workspaceId: "host-1" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/workspace-hosts/connection",
      "/api/workspace-hosts/provision",
      "/api/workspace-hosts/action",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      connectionId: "gcp:production",
      name: "Research",
      desired: expect.objectContaining({ hostId: "host-research" }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: "typed route refusal" }),
        {
          status: 422,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await expect(
      workspaceHostActionRest({ action: "repair", workspaceId: "host-1" }),
    ).rejects.toThrow("typed route refusal");
    expect(workspaceHostIdFromName("  Résumé / Lab  ")).toBe("host-resume-lab");
  });
});

const awsConnectionRow = {
  ...connectionRow,
  id: "aws-main",
  target: "aws",
  label: "Production AWS",
  provider: { vpcId: "vpc-0123456789abcdef0", securityGroupIds: ["sg-0123456789abcdef0"], launchTemplateId: "lt-0123456789abcdef0" },
  scopes: [{ id: "123456789012", label: "AWS account 123456789012" }],
  regions: [{ id: "us-east-1", label: "us-east-1", zones: ["us-east-1a"] }],
  sizes: [{ id: "m6i.xlarge", label: "m6i.xlarge", vcpu: 4, memoryGiB: 16 }],
  images: [{ id: "ami-0123456789abcdef0", label: "Ubuntu 24.04" }],
  networks: [{ id: "subnet-0123456789abcdef0", label: "Private subnet" }],
} satisfies CloudWorkspacesControlRow;

describe("CloudWorkspacesPage — AWS parity", () => {
  it("offers the existing setup-template download for a valid local account and region", () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Amazon Web Services" }));
    expect((screen.getByRole("button", { name: "Download AWS setup template" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "AWS account ID" }), { target: { value: "123456789012" } });
    const link = screen.getByRole("link", { name: "Download AWS setup template" });
    expect(link.getAttribute("href")).toBe("/api/workspace-hosts/aws-setup-template?accountId=123456789012&region=us-east-1");
    expect(link.hasAttribute("download")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "AWS region" }), { target: { value: "eu-west-1" } });
    expect(link.getAttribute("href")).toContain("region=eu-west-1");
    fireEvent.change(screen.getByRole("textbox", { name: "AWS region" }), { target: { value: "cn-north-1" } });
    expect(screen.queryByRole("link", { name: "Download AWS setup template" })).toBeNull();
    expect(H.mutate).not.toHaveBeenCalled();
  });

  it("dismisses the restore dialog through the Modal lifecycle callback", () => {
    H.rows = [awsConnectionRow, {
      ...workspaceRow, target: "aws", connectionId: awsConnectionRow.id,
      capabilities: { ...workspaceRow.capabilities, restore: true },
      resources: [{ logicalKey: "snapshot", kind: "snapshot", state: "applied", providerId: "snapshot-1", attempts: 1 }],
    }];
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for research-control" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore snapshot" }));
    const dialog = screen.getByRole("dialog", { name: "Restore research-control" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close modal" }));
    expect(screen.queryByRole("dialog", { name: "Restore research-control" })).toBeNull();
    expect(H.mutate).not.toHaveBeenCalled();
  });

  it("collects AWS launch resources and SDK references without GCP fields", async () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Amazon Web Services" }));
    expect(screen.queryByRole("textbox", { name: "Runtime service account email" })).toBeNull();
    const submit = screen.getByRole("button", { name: "Connect and validate" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const [label, value] of [
      ["Connection label", "Production AWS"],
      ["Injected credential reference", "resolver://aws/default"],
      ["AWS account ID", "123456789012"],
      ["VPC ID", "vpc-0123456789abcdef0"],
      ["Private subnet ID", "subnet-0123456789abcdef0"],
      ["Security group IDs", "sg-0123456789abcdef0, sg-0123456789abcdef0"],
      ["Launch template ID", "lt-0123456789abcdef0"],
      ["AMI ID", "ami-0123456789abcdef0"],
      ["Instance profile ARN", "arn:aws:iam::123456789012:instance-profile/host"],
      ["KMS key ARN", "arn:aws:kms:us-east-1:123456789012:key/host-key"],
    ]) fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({
      action: "connect", target: "aws", label: "Production AWS", credentialRef: "resolver://aws/default",
      accountId: "123456789012", region: "us-east-1", vpcId: "vpc-0123456789abcdef0",
      subnetId: "subnet-0123456789abcdef0", securityGroupIds: ["sg-0123456789abcdef0"],
      launchTemplateId: "lt-0123456789abcdef0", imageId: "ami-0123456789abcdef0",
      instanceProfileArn: "arn:aws:iam::123456789012:instance-profile/host",
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/host-key",
      credentialSource: { environment: "local", method: "default-chain" },
    }));
  });

  it.each(["shared-profile", "assume-role"] as const)("uses the %s source without unrelated credential fields", (credentialMethod) => {
    const draft = { ...EMPTY_CONNECT_DRAFT, label: "AWS", credentialRef: "resolver://aws/local", accountId: "123456789012",
      vpcId: "vpc-01234567", securityGroupIds: "sg-01234567", subnetId: "subnet-01234567", launchTemplateId: "lt-01234567",
      imageId: "ami-01234567", instanceProfileArn: "arn:aws:iam::123456789012:instance-profile/host",
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/host", credentialMethod, profile: " production ",
      roleArn: " arn:aws:iam::123456789012:role/host ", externalIdRef: " env:AWS_EXTERNAL_ID " };
    expect(connectionActionFromDraft("aws", { ...draft, profile: "", roleArn: "" })).toBeNull();
    expect(connectionActionFromDraft("aws", draft)).toMatchObject({ credentialSource: credentialMethod === "shared-profile"
      ? { environment: "local", method: credentialMethod, profile: "production" }
      : { environment: "local", method: credentialMethod, roleArn: "arn:aws:iam::123456789012:role/host", sourceProfile: "production", externalIdRef: "env:AWS_EXTERNAL_ID" } });
    expect(connectionActionFromDraft("aws", draft)).not.toHaveProperty("projectId");
  });

  it("provisions the AWS account and subnet from the settled catalog", async () => {
    H.rows = [awsConnectionRow];
    H.queryDefaults = { step: "configure" };
    render(<CloudWorkspacesPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "aws-research" } });
    const submit = screen.getByRole("button", { name: "Provision workspace" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: "provision", connectionId: "aws-main", name: "aws-research",
      desired: { hostId: "host-aws-research", target: "aws", scope: { kind: "account", id: "123456789012" },
        region: "us-east-1", zone: "us-east-1a", size: "m6i.xlarge", image: { id: "ami-0123456789abcdef0" },
        data: { volumeGiB: 100, encrypted: true }, provider: { subnetId: "subnet-0123456789abcdef0" } } }));
  });

  it.each(["gcp", "aws"] as const)("restores a registered %s snapshot to a distinct host without browser credential config", async (target) => {
    H.rows = [target === "aws" ? awsConnectionRow : connectionRow, { ...workspaceRow, target, id: "host-research-control",
      capabilities: { ...workspaceRow.capabilities, restore: true },
      resources: [...(workspaceRow.resources ?? []), { logicalKey: "snapshot-1", kind: "snapshot", state: "applied", providerId: "snapshot-1", attempts: 1 }],
    }];
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for research-control" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore snapshot" }));
    const submit = screen.getByRole("button", { name: "Restore workspace" }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole("textbox", { name: "Restored workspace name" }), { target: { value: "research-control" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Restored workspace name" }), { target: { value: "research-restored" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: "restore", workspaceId: "host-research-control", name: "research-restored",
      snapshot: { target, hostId: "host-research-control", providerId: "snapshot-1" }, desired: { hostId: "host-research-restored" } }));
  });

  it("validates AWS and snapshots an AWS host through the shared mutation seam", async () => {
    H.rows = [awsConnectionRow, { ...workspaceRow, target: "aws", connectionId: "aws-main" }];
    H.queryDefaults = { step: "connect" };
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Validate Amazon Web Services connection" }));
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: "validate-connection", connectionId: "aws-main" }));
    fireEvent.click(screen.getByRole("button", { name: /^03 Operate:/ }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for research-control" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Snapshot" }));
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: "snapshot", workspaceId: "host-1" }));
  });
});

describe("CloudWorkspacesPage — 01 Connect", () => {
  it("collects the complete supported GCP connection admission contract", async () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google Cloud" }),
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Connection label" }),
      {
        target: { value: "Production GCP" },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Injected credential reference" }),
      { target: { value: "adc://default" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Google Cloud project ID" }),
      { target: { value: "papercusp-prod" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Runtime service account email" }),
      {
        target: {
          value: "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
        },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Connect and validate" }),
    );

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "connect",
        target: "gcp",
        label: "Production GCP",
        credentialRef: "adc://default",
        projectId: "papercusp-prod",
        serviceAccountEmail:
          "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
      }),
    );
  });

  it("withholds admission until every contract field is supplied", () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google Cloud" }),
    );

    const submit = screen.getByRole("button", {
      name: "Connect and validate",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    for (const [name, value] of [
      ["Connection label", "Production GCP"],
      ["Injected credential reference", "adc://default"],
      ["Google Cloud project ID", "papercusp-prod"],
    ] as const) {
      fireEvent.change(screen.getByRole("textbox", { name }), {
        target: { value },
      });
      /* Three of four is still incomplete. */
      expect(submit.disabled).toBe(true);
    }

    fireEvent.change(
      screen.getByRole("textbox", { name: "Runtime service account email" }),
      { target: { value: "host@papercusp-prod.iam.gserviceaccount.com" } },
    );
    expect(submit.disabled).toBe(false);
  });

  it("keeps the connect form beside its provider rather than over them", () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google Cloud" }),
    );

    /* An inline panel, not a modal: the provider rows stay on screen. */
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Connect Google Cloud" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Provider connections" }),
    ).toBeTruthy();
  });

  it("moves focus into the connect panel and hands it back when the panel closes", () => {
    /* The panel is conditionally rendered, so closing it UNMOUNTS the button
       holding focus. The browser's fallback for a removed active element is
       <body> — a keyboard user silently dropped to the start of the document,
       a screen-reader user with no place left (WCAG 2.4.3). Restoring focus to
       the provider row that opened the panel is the half that matters; moving
       focus in on open is the same contract from the other side, since the form
       renders elsewhere in the DOM. */
    H.rows = [];
    render(<CloudWorkspacesPage />);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    const trigger = screen.getByRole("button", {
      name: "Connect Google Cloud",
    }) as HTMLButtonElement;
    fireEvent.click(trigger);

    /* Opened: focus is inside the panel, on its first field. */
    const panelInput = screen.getByLabelText(
      "Connection label",
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(panelInput);
    // The new form can grow below the scrollport. Opening focus must reveal it.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });

    /* Closed: focus returns to the trigger, NOT to <body>. */
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Connect Google Cloud" }),
    ).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Connect Google Cloud" }),
    );
    // Restoring focus must preserve the user's scroll position.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it("keeps an opening field visible across layout changes until the user moves focus", () => {
    const callbacks: Array<() => void> = [];
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe(element: Element) { observed.push(element); }
      disconnect = disconnect;
    });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const flush = () => act(() => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } });
    H.rows = [];
    const view = render(<StrictMode><CloudWorkspacesPage /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Cloud" }));
    const input = screen.getByLabelText("Connection label");
    expect(observed).toContain(input.closest("form"));
    expect(document.activeElement).toBe(input);
    const scroll = vi.fn();
    input.scrollIntoView = scroll;
    let top = 20;
    vi.spyOn(input, "getBoundingClientRect").mockImplementation(() => ({ x: 20, y: top, top, left: 20,
      width: 200, height: 30, right: 220, bottom: top + 30, toJSON: () => ({}) }));
    act(() => callbacks.forEach(callback => callback())); flush();
    expect(scroll).not.toHaveBeenCalled();
    top = window.innerHeight + 80;
    act(() => callbacks.forEach(callback => callback())); flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    // A resize response must never take focus or scroll after the user leaves.
    screen.getByLabelText("Injected credential reference").focus();
    act(() => callbacks.forEach(callback => callback())); flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText("Injected credential reference"));
    expect(disconnect).toHaveBeenCalled();
    view.unmount();
    expect(frames.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("control: removing a focused element really does drop focus to <body> here", () => {
    /* CALIBRATION for the test above, kept permanently rather than run once.
       `expect(activeElement).not.toBe(document.body)` is only meaningful if
       this environment actually exhibits the failure it is guarding against —
       if jsdom retained focus on a detached node, that assertion would pass no
       matter what ConnectStage did, and the guard would be decorative.

       This reproduces the exact mechanism (remove the element holding focus)
       with no focus management whatsoever, and asserts the bad outcome. If this
       control ever stops reporting <body>, the guard above has quietly stopped
       proving anything and both need revisiting. */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const button = document.createElement("button");
    host.appendChild(button);

    button.focus();
    expect(document.activeElement).toBe(button);

    host.removeChild(button);
    expect(document.activeElement).toBe(document.body);

    document.body.removeChild(host);
  });

  it("marks unsupported providers as planned rather than merely disabled", () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);

    const providers = screen.getByRole("list", {
      name: "Provider connections",
    });
    expect(providers.querySelectorAll("li")).toHaveLength(3);
    expect(providers.textContent).toContain("planned");
    expect(
      (
        screen.getByRole("button", {
          name: "Microsoft Azure connection is not available",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Connect Amazon Web Services" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("CloudWorkspacesPage — 02 Configure", () => {
  it("blocks silent disk correction and submits only an explicitly valid volume", async () => {
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Disk Check" },
    });
    const disk = screen.getByRole("spinbutton", {
      name: "Disk size in GiB",
    }) as HTMLInputElement;
    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    }) as HTMLButtonElement;

    for (const invalidValue of ["", "19", "20.5", "16385"]) {
      fireEvent.change(disk, { target: { value: invalidValue } });
      await waitFor(() => expect(provision.disabled).toBe(true));
      expect(disk.getAttribute("aria-invalid")).toBe("true");
      /* No silent correction — the typed value survives verbatim. */
      expect(disk.value).toBe(invalidValue);
      expect(screen.getByRole("status").textContent).toContain(
        "enter a whole-number disk size between 20 and 16,384 GiB",
      );
    }

    fireEvent.change(disk, { target: { value: "120" } });
    await waitFor(() => expect(provision.disabled).toBe(false));
    expect(disk.getAttribute("aria-invalid")).toBe("false");
    fireEvent.click(provision);

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "provision",
          desired: expect.objectContaining({
            data: { volumeGiB: 120, encrypted: true },
          }),
        }),
      ),
    );
  });

  it("canonicalizes stale URL-backed catalog IDs before provisioning", async () => {
    H.queryDefaults = {
      ...onConfigure,
      connection: "retired-connection",
      scope: "retired-project",
      region: "retired-region",
      size: "retired-size",
      image: "retired-image",
      network: "retired-network",
      name: "Recovered Link",
    };
    render(<CloudWorkspacesPage />);

    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(H.queryUpdates).toEqual(
        expect.arrayContaining([
          ["connection", "gcp-main"],
          ["scope", "papercusp-prod"],
          ["region", "us-central1"],
          ["size", "e2-standard-4"],
          ["image", "projects/papercusp-images/global/images/ubuntu-2404"],
          ["network", "managed"],
        ]),
      );
      expect(provision.disabled).toBe(false);
    });

    fireEvent.click(provision);
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "provision",
          connectionId: "gcp-main",
          desired: expect.objectContaining({
            scope: { kind: "project", id: "papercusp-prod" },
            region: "us-central1",
            size: "e2-standard-4",
            image: expect.objectContaining({
              id: "projects/papercusp-images/global/images/ubuntu-2404",
            }),
            provider: { network: { mode: "managed" } },
          }),
        }),
      ),
    );
  });

  it("clears stale dependent IDs when the selected catalog has no options", async () => {
    H.rows = [
      {
        ...connectionRow,
        scopes: [],
        regions: [],
        sizes: [],
        images: [],
        networks: [],
      },
    ];
    H.queryDefaults = {
      ...onConfigure,
      connection: "retired-connection",
      scope: "retired-project",
      region: "retired-region",
      size: "retired-size",
      image: "retired-image",
      network: "retired-network",
      name: "Blocked Link",
    };
    render(<CloudWorkspacesPage />);

    await waitFor(() =>
      expect(H.queryUpdates).toEqual(
        expect.arrayContaining([
          ["connection", "gcp-main"],
          ["scope", ""],
          ["region", ""],
          ["size", ""],
          ["image", ""],
          ["network", ""],
        ]),
      ),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Provision workspace",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not leak undefined capacity values from an incomplete runtime catalog row", () => {
    H.rows = [
      {
        ...connectionRow,
        sizes: [{ id: "e2-small", label: "e2-small" } as never],
      },
    ];
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    expect(screen.getAllByText("Capacity details unavailable")).toHaveLength(2);
    expect(screen.queryByText(/undefined vCPU/)).toBeNull();
    expect(screen.queryByText(/\$NaN/)).toBeNull();
  });

  it("explains empty catalog dimensions instead of rendering a blank provisioning dead end", () => {
    H.rows = [{ ...connectionRow, networks: [] }];
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    const network = screen.getByRole("combobox", { name: "Network" });
    expect((network as HTMLButtonElement).disabled).toBe(true);
    expect(network.textContent).toContain("No networks available");
    expect(
      screen.getByText(
        "No networks were returned by this provider connection.",
      ),
    ).toBeTruthy();

    /* The checklist replaces the semicolon-joined blocker sentence: one line
       per unmet condition, each naming its own fix. */
    const readiness = screen.getByRole("status");
    expect(readiness.textContent).toContain("Provisioning blocked");
    expect(readiness.textContent).toContain("enter a workspace name");
    expect(readiness.textContent).toContain(
      "load a network from the provider catalog",
    );
    expect(readiness.querySelectorAll('li[data-ok="false"]').length).toBe(2);

    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    });
    expect((provision as HTMLButtonElement).disabled).toBe(true);
    expect(provision.getAttribute("aria-describedby")).toBe(
      "provision-readiness",
    );
  });

  it("presents machine sizes as comparable priced cards", () => {
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    const size = screen.getByRole("radio", { name: /e2-standard-4/ });
    expect(size.getAttribute("aria-checked")).toBe("true");
    expect(size.textContent).toContain("4 vCPU · 16 GiB RAM");
    /* Each card carries its own price, so sizes can be compared in place. */
    expect(size.textContent).toContain("$58.40 / month");
    /* The shared radiogroup primitive supplies the group's accessible name. */
    expect(
      screen.getByRole("radiogroup", { name: "Machine size" }),
    ).toBeTruthy();
  });

  it("associates visible field guidance with the control it describes", () => {
    H.rows = [{ ...connectionRow, networks: [], sizes: [] }];
    H.queryDefaults = { ...onConfigure };
    render(<CloudWorkspacesPage />);

    const expectedDescriptions = [
      ["textbox", "Workspace name", "Required before provisioning."],
      ["combobox", "Region", "Zone us-central1-a"],
      [
        "combobox",
        "Machine size",
        "No machine sizes were returned by this provider connection.",
      ],
      ["spinbutton", "Disk size in GiB", "20–16,384 GiB"],
      [
        "combobox",
        "Network",
        "No networks were returned by this provider connection.",
      ],
    ] as const;

    for (const [role, name, description] of expectedDescriptions) {
      const control = screen.getByRole(role, { name });
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe(
        description,
      );
    }
  });
});

describe("CloudWorkspacesPage — 03 Operate", () => {
  it("states drift on one chip and names the diverging host in a banner", () => {
    H.rows = [
      connectionRow,
      { ...workspaceRow, desiredState: "running", observedState: "stopped" },
    ];
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    /* The chip STATES the divergence; it does not leave it to be computed
       from separate desired/observed pills. */
    expect(screen.getByText("stopped → running")).toBeTruthy();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain(
      "1 host has diverged from its desired state",
    );
    expect(banner.textContent).toContain("research-control");
    expect(banner.textContent).toContain("diverged for");

    const stats = screen.getByRole("region", { name: "Fleet posture" });
    expect(stats.textContent).toContain("Drifting1");
  });

  it("shows one chip and no drift banner when desired and observed agree", () => {
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByText(/diverged from/)).toBeNull();
    expect(screen.queryByText(/desired:/)).toBeNull();
    expect(screen.queryByText(/observed:/)).toBeNull();
  });

  it("offers one contextual primary action with the rest in overflow", () => {
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    /* This host is stoppable and not startable, so Stop is the primary and
       Start is not rendered at all — the pre-redesign page greyed Start out
       on every running host. */
    expect(screen.getByRole("button", { name: "Stop machine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start machine" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for research-control" }),
    );
    const menu = screen.getByRole("menu", {
      name: "More actions for research-control",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Repair" }),
    );
    const repairItem = screen.getByRole("menuitem", {
      name: "Repair",
    }) as HTMLButtonElement;
    fireEvent.keyDown(repairItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Snapshot" }),
    );
    const snapshotItem = screen.getByRole("menuitem", {
      name: "Snapshot",
    }) as HTMLButtonElement;
    fireEvent.keyDown(snapshotItem, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Destroy" }),
    );
    const destroyItem = screen.getByRole("menuitem", {
      name: "Destroy",
    }) as HTMLButtonElement;
    fireEvent.keyDown(destroyItem, { key: "ArrowUp" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Snapshot" }),
    );
    fireEvent.keyDown(snapshotItem, { key: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Repair" }),
    );
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Repair", "Snapshot", "Restore snapshot", "Destroy"]);

    fireEvent.keyDown(repairItem, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["pointer", "Tab"])("does not steal the destination's focus on %s dismissal", (dismissal) => {
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);
    const trigger = screen.getByRole("button", {
      name: "More actions for research-control",
    }) as HTMLButtonElement;
    fireEvent.click(trigger);
    const repair = screen.getByRole("menuitem", { name: "Repair" });
    expect(document.activeElement).toBe(repair);
    const destination = screen.getByRole("button", { name: "Stop machine" });
    destination.focus();
    expect(document.activeElement).toBe(destination);
    const restore = vi.spyOn(trigger, "focus");

    if (dismissal === "pointer") fireEvent.pointerDown(destination);
    else fireEvent.keyDown(repair, { key: "Tab" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(restore).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(destination);
  });

  it("does not focus a detached lifecycle target", () => {
    const host = document.createElement("div");
    const button = document.createElement("button");
    host.appendChild(button);
    document.body.appendChild(host);
    button.focus();
    host.removeChild(button);

    const focus = vi.spyOn(button, "focus");
    expect(focusSafely(button)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);

    document.body.removeChild(host);
  });

  it("hands focus back to the overflow trigger when the menu closes", () => {
    /* The menu is conditionally rendered, so every close path UNMOUNTS the
       element holding focus. A keyboard user who has moved onto Repair and
       presses Escape — or activates it — has their active element removed,
       and the browser's fallback for that is <body>: silently dropped to the
       start of the document (WCAG 2.4.3). The ARIA menu-button pattern owes
       them the trigger back.

       The calibration control in the Connect suite above ("removing a focused
       element really does drop focus to <body> here") is what makes the
       `not.toBe(document.body)` assertions below non-vacuous in this
       environment; it covers this file. */
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    const trigger = screen.getByRole("button", {
      name: "More actions for research-control",
    }) as HTMLButtonElement;

    /* Close path 1 — Escape while focus sits on a menu item. */
    fireEvent.click(trigger);
    const repair = screen.getByRole("menuitem", {
      name: "Repair",
    }) as HTMLButtonElement;
    repair.focus();
    expect(document.activeElement).toBe(repair);

    fireEvent.keyDown(repair, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);

    /* Close path 2 — activating an action. The action still fires; the point
       is that focus lands somewhere rather than nowhere. Focus the item
       first and park focus off the trigger, so passing means focus was
       genuinely MOVED back rather than never having left. */
    fireEvent.click(trigger);
    const repairAgain = screen.getByRole("menuitem", {
      name: "Repair",
    }) as HTMLButtonElement;
    repairAgain.focus();
    expect(document.activeElement).toBe(repairAgain);
    fireEvent.click(repairAgain);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });

  it("expands the selected host in place with tabbed detail", () => {
    H.queryDefaults = { ...onOperate, host: "host-1", tab: "resources" };
    render(<CloudWorkspacesPage />);

    const tab = screen.getByRole("tab", { name: /Resources/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("vm");

    fireEvent.click(screen.getByRole("tab", { name: /Logs/ }));
    expect(H.queryUpdates).toContainEqual(["tab", "logs"]);
    expect(screen.getByRole("tabpanel").textContent).toContain("Agent ready");
  });

  it("supports arrow, Home, and End keyboard navigation across host tabs", () => {
    H.queryDefaults = { ...onOperate, host: "host-1" };
    render(<CloudWorkspacesPage />);

    const tabs = screen.getAllByRole("tab") as HTMLButtonElement[];
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(H.queryUpdates).toContainEqual(["tab", "resources"]);

    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[4]);
    expect(tabs[4].getAttribute("aria-selected")).toBe("true");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, -1, -1, 0]);

    fireEvent.keyDown(tabs[4], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[4]);

    fireEvent.keyDown(tabs[4], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(H.queryUpdates).toContainEqual(["tab", "overview"]);
  });

  it("keeps the audit export reachable from the expanded host", () => {
    H.queryDefaults = { ...onOperate, host: "host-1" };
    render(<CloudWorkspacesPage />);

    expect(
      screen.getByRole("link", { name: /Audit export/ }).getAttribute("href"),
    ).toBe("/api/workspace-hosts/host-1/audit");
  });

  it("mounts the browser session plane when a WebSocket connector is advertised", () => {
    H.rows = [
      connectionRow,
      {
        ...workspaceRow,
        tunnel: {
          hostedConnector: {
            routeLabel: "workspace-relay",
            transport: "websocket",
          },
        },
      },
    ];
    H.queryDefaults = { ...onOperate, host: "host-1" };
    render(<CloudWorkspacesPage />);

    const session = screen.getByRole("region", {
      name: "Browser workspace session for research-control",
    });
    expect(session).toBeTruthy();
    expect(session.textContent).toContain("outbound relay · workspace-relay");
    expect(session.textContent).toContain(
      "Connect to open the authenticated PTY",
    );
  });

  it("submits an explicit ordinary destroy disposition and exact host confirmation", async () => {
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for research-control" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Destroy" }));

    expect(
      screen.getByRole("dialog", { name: "Destroy research-control" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /Create a snapshot first/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("radio", { name: /Discard recoverability/ }),
    );

    const confirmButton = screen.getByRole("button", {
      name: "Confirm destroy",
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(
      screen.getByLabelText("Type research-control to confirm discard"),
      { target: { value: "research-control" } },
    );
    expect(confirmButton.disabled).toBe(false);
    expect(confirmButton.getAttribute("aria-describedby")).toBe(
      "destroy-admission-blocker",
    );
    expect(screen.getByText("Ready for durable teardown")).toBeTruthy();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith(expect.objectContaining({
      action: "destroy",
      workspaceId: "host-1",
      disposition: "discard",
      confirmation: expect.objectContaining({
        expectedHostId: "host-1",
        confirmedBy: "operator:cloud-workspaces-ui",
      }),
    })));
  });

  it("uses one tab stop and arrow-key selection in the recoverability radiogroup", () => {
    H.queryDefaults = { ...onOperate };
    render(<CloudWorkspacesPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for research-control" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Destroy" }));

    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(radios[1], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);

    fireEvent.keyDown(radios[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  });
});

describe("CloudWorkspacesPage — failure and layout", () => {
  it("fails closed when the sync control-plane read is unavailable", () => {
    H.rows = [];
    H.error = new Error("workspaceHosts.control is not registered");
    render(<CloudWorkspacesPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Local cloud control plane unavailable",
    );
    /* Routed to Connect rather than stranded in an inert form. */
    expect(
      screen.getByRole("heading", { name: "Provider readiness" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /02 Configure/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps rail disclosure and shell columns synchronized to the page container", () => {
    /* The operator routinely embeds this route in a pane far narrower than
       the browser viewport. A global media query can therefore disagree with
       a container query: the old contract hid the rail body while leaving its
       268px grid track in place. Slice each breakpoint so these assertions
       prove the paired transition lives in ONE rule. */
    expect(cloudPageCss).toContain("container-type: inline-size");
    expect(cloudPageCss).toContain("container-name: cw-page");
    // The desktop content pane can be 394px inside a 1280px window. A
    // viewport breakpoint let the provider track collapse to zero and cover
    // the form. The open panel must reflow using its own available width.
    expect(cloudPageCss).toContain("repeat(auto-fit, minmax(min(100%, 380px), 1fr))");
    const configureColumns = /\.configureColumns\s*\{([^}]+)\}/.exec(cloudPageCss)?.[1];
    expect(configureColumns).toContain("repeat(auto-fit, minmax(min(100%, 380px), 1fr))");
    expect(cloudPageCss).not.toMatch(/@media[^{}]+\{\s*\.configureColumns/);
    expect(cloudPageCss).not.toContain("container-name: cw-shell");

    const mediumStart = cloudPageCss.indexOf(
      "@container cw-page (max-width: 1100px)",
    );
    const narrowStart = cloudPageCss.indexOf(
      "@container cw-page (max-width: 760px)",
    );
    const compactStart = cloudPageCss.indexOf(
      "@container cw-page (max-width: 500px)",
    );
    expect(mediumStart).toBeGreaterThan(-1);
    expect(narrowStart).toBeGreaterThan(mediumStart);
    expect(compactStart).toBeGreaterThan(narrowStart);

    const medium = cloudPageCss.slice(mediumStart, narrowStart);
    expect(medium).toContain("grid-template-columns: 74px minmax(0, 1fr)");
    expect(medium).toContain(".railStepBody,");
    expect(medium).toContain("display: none");

    const narrow = cloudPageCss.slice(narrowStart, compactStart);
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(narrow).toContain(".railSteps {");
    expect(narrow).toContain("flex-direction: row");
    expect(narrow).toContain(".railStepBody {");
    expect(narrow).toContain("display: flex");
    expect(narrow).toContain(".railStats {");
    expect(narrow).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
    );
    // Equal-specificity responsive row rules must follow their base rules.
    // Finding them only in the first container block misses a later override
    // that squeezes the workspace name into the status badge.
    const responsiveRowsStart = cloudPageCss.lastIndexOf(
      "@container cw-page (max-width: 760px)",
    );
    expect(responsiveRowsStart).toBeGreaterThan(
      cloudPageCss.search(/^\.hostRowMain \{/m),
    );
    const responsiveRows = cloudPageCss.slice(responsiveRowsStart);
    expect(responsiveRows).toContain(".hostRow {");
    expect(responsiveRows).toContain(".hostRowActions {");
    expect(responsiveRows).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
  });

  it("bounds recent activity density without dropping its entries", () => {
    const activityStart = cloudPageCss.indexOf(".railActivityList {");
    const activityEnd = cloudPageCss.indexOf(
      ".railActivityList li {",
      activityStart,
    );
    expect(activityStart).toBeGreaterThan(-1);
    expect(activityEnd).toBeGreaterThan(activityStart);

    const activityRule = cloudPageCss.slice(activityStart, activityEnd);
    expect(activityRule).toContain("max-height:");
    expect(activityRule).toContain("overflow-y: auto");
    expect(activityRule).toContain("scrollbar-gutter: stable");
  });

  it("styles an inert rail step off aria-disabled, not :disabled", () => {
    /* The DOM half of this contract is pinned above ("keeps an unreachable rail
       step inert but still able to say why"). This is the stylesheet half: a
       `:disabled` selector here would silently stop matching, so the inert step
       would lose its affordance the moment the attribute changed. */
    expect(cloudPageCss).toContain('.railStep[aria-disabled="true"]');
    expect(cloudPageCss).not.toMatch(/\.railStep[^{]*:disabled/);
  });

  it("raises the type floor above the pre-redesign 8.5px metadata", () => {
    const sizes = Array.from(
      cloudPageCss.matchAll(/font-size:\s*([\d.]+)px/g),
    ).map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.5);
  });

  it("keeps a reduced-motion path", () => {
    expect(cloudPageCss).toContain("prefers-reduced-motion: reduce");
  });
});
