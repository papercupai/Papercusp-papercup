import { describe, expect, it } from "vitest";

import {
  canProvision,
  driftingWorkspaces,
  estimateMonthlyUsd,
  formatCapacity,
  formatElapsed,
  formatMoney,
  formatSignal,
  formatTimestamp,
  hostStateChip,
  isDiskGiBValid,
  isStepId,
  lifecycleActionPlan,
  railModel,
  readinessChecks,
  resolveActiveStep,
  resolveLandingStep,
  signalTone,
  stateTone,
  stepAvailability,
  unmetReadinessFixes,
  workspaceHostIdFromName,
  type CatalogOption,
  type ImageOption,
  type ProvisionSelection,
  type RegionOption,
  type SizeOption,
  type WorkspaceHostConnectionRow,
  type WorkspaceHostControlRow,
} from "./workspace-view-model";

const connection = (
  overrides: Partial<WorkspaceHostConnectionRow> = {},
): WorkspaceHostConnectionRow => ({
  kind: "connection",
  id: "gcp-main",
  target: "gcp",
  label: "Production GCP",
  status: "connected",
  credentialRef: "adc://default",
  lastValidatedAt: "2026-08-28T03:00:00.000Z",
  scopes: [{ id: "papercusp-prod", label: "papercusp-prod" }],
  regions: [{ id: "us-central1", label: "Iowa", zones: ["us-central1-a"] }],
  sizes: [
    { id: "n2-standard-8", label: "n2-standard-8", vcpu: 8, memoryGiB: 32 },
  ],
  images: [{ id: "ubuntu-2404", label: "Ubuntu 24.04" }],
  networks: [{ id: "managed", label: "Managed" }],
  ...overrides,
});

const workspace = (
  overrides: Partial<WorkspaceHostControlRow> = {},
): WorkspaceHostControlRow => ({
  kind: "workspace",
  id: "host-1",
  name: "research-control",
  connectionId: "gcp-main",
  target: "gcp",
  scopeLabel: "papercusp-prod",
  region: "us-central1",
  size: "n2-standard-8",
  image: "ubuntu-2404",
  diskGiB: 200,
  network: "managed",
  estimatedMonthlyUsd: 318.4,
  desiredState: "running",
  observedState: "running",
  observedAt: "2026-08-28T04:00:00.000Z",
  recoverability: { kind: "snapshot", label: "snap-0827" },
  capabilities: { start: false, stop: true, repair: true, snapshot: true, destroy: true },
  ...overrides,
});

describe("step resolution", () => {
  it("gates each step behind the precondition that makes it useful", () => {
    expect(stepAvailability([], [])).toEqual({
      connect: true,
      configure: false,
      operate: false,
    });
    expect(stepAvailability([connection()], [])).toEqual({
      connect: true,
      configure: true,
      operate: false,
    });
    expect(stepAvailability([connection()], [workspace()])).toEqual({
      connect: true,
      configure: true,
      operate: true,
    });
  });

  it("lands on the step that matches how far setup has actually got", () => {
    expect(resolveLandingStep([], [])).toBe("connect");
    expect(resolveLandingStep([connection()], [])).toBe("configure");
    expect(resolveLandingStep([connection()], [workspace()])).toBe("operate");
  });

  it("lands on operate once a workspace exists even with no live connection row", () => {
    // Operate is the daily job; a connection that has since gone away must not
    // bounce the operator back into setup while hosts are still running.
    expect(resolveLandingStep([], [workspace()])).toBe("operate");
  });

  it("honours a requested step only when it is reachable", () => {
    expect(resolveActiveStep("connect", [connection()], [workspace()])).toBe(
      "connect",
    );
    expect(resolveActiveStep("configure", [connection()], [workspace()])).toBe(
      "configure",
    );
  });

  it("degrades an unreachable or unknown requested step to the landing step", () => {
    // A shared ?step=operate link on a workspace-less install must not render a
    // blank stage.
    expect(resolveActiveStep("operate", [connection()], [])).toBe("configure");
    expect(resolveActiveStep("configure", [], [])).toBe("connect");
    expect(resolveActiveStep("nonsense", [connection()], [workspace()])).toBe(
      "operate",
    );
    expect(resolveActiveStep(null, [connection()], [workspace()])).toBe(
      "operate",
    );
    expect(resolveActiveStep(undefined, [], [])).toBe("connect");
  });

  it("recognises exactly the three step ids", () => {
    expect(isStepId("connect")).toBe(true);
    expect(isStepId("configure")).toBe(true);
    expect(isStepId("operate")).toBe(true);
    expect(isStepId("provision")).toBe(false);
    expect(isStepId(null)).toBe(false);
    expect(isStepId(3)).toBe(false);
  });
});

describe("host state chip", () => {
  it("states one word when desired and observed agree", () => {
    const chip = hostStateChip(workspace());
    expect(chip).toMatchObject({
      drifting: false,
      label: "running",
      tone: "good",
    });
    expect(chip.percent).toBeUndefined();
  });

  it("names both states ONLY when they diverge", () => {
    expect(
      hostStateChip(
        workspace({ desiredState: "running", observedState: "stopped" }),
      ),
    ).toMatchObject({
      drifting: true,
      label: "stopped → running",
      tone: "warn",
    });
  });

  it("escalates tone when the observed state is itself a failure", () => {
    expect(
      hostStateChip(
        workspace({ desiredState: "running", observedState: "degraded" }),
      ),
    ).toMatchObject({ drifting: true, tone: "bad" });
  });

  it("carries in-flight progress on a drifting host so the row shows work is happening", () => {
    expect(
      hostStateChip(
        workspace({
          desiredState: "running",
          observedState: "stopped",
          operation: {
            id: "op-1",
            action: "start",
            status: "running",
            percent: 38,
            message: "Reconciling",
            events: [],
          },
        }),
      ),
    ).toMatchObject({ drifting: true, percent: 38 });
  });

  it("ignores a settled operation — a finished op is not in-flight progress", () => {
    const chip = hostStateChip(
      workspace({
        operation: {
          id: "op-1",
          action: "provision",
          status: "succeeded",
          percent: 100,
          message: "done",
          events: [],
        },
      }),
    );
    expect(chip.percent).toBeUndefined();
    expect(chip.label).toBe("running");
  });

  it("shows provisioning progress inline while a host is still being built", () => {
    expect(
      hostStateChip(
        workspace({
          desiredState: "provisioning",
          observedState: "provisioning",
          operation: {
            id: "op-2",
            action: "provision",
            status: "running",
            percent: 62,
            message: "Creating disk",
            events: [],
          },
        }),
      ),
    ).toMatchObject({ drifting: false, label: "provisioning · 62%", percent: 62 });
  });

  it("selects exactly the diverging hosts", () => {
    const aligned = workspace({ id: "a" });
    const drifted = workspace({
      id: "b",
      desiredState: "running",
      observedState: "stopped",
    });
    expect(driftingWorkspaces([aligned, drifted]).map((row) => row.id)).toEqual([
      "b",
    ]);
    expect(driftingWorkspaces([])).toEqual([]);
  });

  it("orders drift worst first: degraded above stopped, then longest-diverged", () => {
    /* The banner renders this list in order, so order IS the triage advice.
       `degraded` is deliberately given the NEWEST observedAt here: if severity
       did not outrank duration it would sort last, so a passing result cannot
       be an accident of the timestamps. */
    const stoppedRecent = workspace({
      id: "stopped-recent",
      desiredState: "running",
      observedState: "stopped",
      observedAt: "2026-08-28T05:00:00.000Z",
    });
    const stoppedOld = workspace({
      id: "stopped-old",
      desiredState: "running",
      observedState: "stopped",
      observedAt: "2026-08-28T01:00:00.000Z",
    });
    const degraded = workspace({
      id: "degraded",
      desiredState: "running",
      observedState: "degraded",
      observedAt: "2026-08-28T05:30:00.000Z",
    });

    expect(
      driftingWorkspaces([stoppedRecent, stoppedOld, degraded]).map(
        (row) => row.id,
      ),
    ).toEqual(["degraded", "stopped-old", "stopped-recent"]);
  });

  it("keeps query order between hosts of equal severity and equal age", () => {
    /* Stability matters: without it the banner's list can reshuffle between
       renders on equally-ranked hosts, which reads as activity that did not
       happen. */
    const first = workspace({
      id: "first",
      desiredState: "running",
      observedState: "stopped",
      observedAt: "2026-08-28T02:00:00.000Z",
    });
    const second = workspace({
      id: "second",
      desiredState: "running",
      observedState: "stopped",
      observedAt: "2026-08-28T02:00:00.000Z",
    });

    expect(
      driftingWorkspaces([first, second]).map((row) => row.id),
    ).toEqual(["first", "second"]);
    expect(
      driftingWorkspaces([second, first]).map((row) => row.id),
    ).toEqual(["second", "first"]);
  });

  it("ranks a host with no observedAt below one whose divergence age is known", () => {
    /* An unknown age is not evidence of a long divergence, so it must not
       outrank a host we can actually prove has been drifting for hours. */
    const unknownAge = workspace({
      id: "unknown-age",
      desiredState: "running",
      observedState: "stopped",
      observedAt: undefined,
    });
    const knownOld = workspace({
      id: "known-old",
      desiredState: "running",
      observedState: "stopped",
      observedAt: "2026-08-28T01:00:00.000Z",
    });

    expect(
      driftingWorkspaces([unknownAge, knownOld]).map((row) => row.id),
    ).toEqual(["known-old", "unknown-age"]);
  });
});

describe("contextual lifecycle actions", () => {
  it("offers Stop (not a disabled Start) on a running host", () => {
    const plan = lifecycleActionPlan(workspace());
    expect(plan.primary).toMatchObject({ action: "stop", enabled: true });
    expect(plan.overflow.map((entry) => entry.action)).toEqual([
      "repair",
      "snapshot",
      "restore",
      "destroy",
    ]);
  });

  it("offers Start on a stopped host", () => {
    expect(
      lifecycleActionPlan(
        workspace({
          observedState: "stopped",
          desiredState: "stopped",
          capabilities: { start: true, stop: false, destroy: true },
        }),
      ).primary,
    ).toMatchObject({ action: "start", enabled: true });
  });

  it("offers no primary when neither transition is legal", () => {
    expect(
      lifecycleActionPlan(
        workspace({ capabilities: { start: false, stop: false } }),
      ).primary,
    ).toBeNull();
  });

  it("falls back to observed state when the capability payload claims both", () => {
    expect(
      lifecycleActionPlan(
        workspace({
          observedState: "running",
          capabilities: { start: true, stop: true },
        }),
      ).primary,
    ).toMatchObject({ action: "stop" });
    expect(
      lifecycleActionPlan(
        workspace({
          observedState: "stopped",
          desiredState: "stopped",
          capabilities: { start: true, stop: true },
        }),
      ).primary,
    ).toMatchObject({ action: "start" });
  });

  it("keeps an unavailable overflow action visible but disabled, never silently absent", () => {
    const plan = lifecycleActionPlan(
      workspace({ capabilities: { stop: true, destroy: false } }),
    );
    const destroy = plan.overflow.find((entry) => entry.action === "destroy");
    expect(destroy).toMatchObject({ enabled: false, label: "Destroy" });
  });

  it("treats a missing capabilities payload as nothing being legal", () => {
    const plan = lifecycleActionPlan(
      workspace({ capabilities: {} as Record<string, never> }),
    );
    expect(plan.primary).toBeNull();
    expect(plan.overflow.every((entry) => !entry.enabled)).toBe(true);
  });
});

describe("readiness checklist", () => {
  const ready = (): ProvisionSelection => ({
    catalogSelectionCanonical: true,
    diskGiBValid: true,
    connection: connection(),
    name: "research-control",
    scope: { id: "papercusp-prod", label: "papercusp-prod" } as CatalogOption,
    region: { id: "us-central1", label: "Iowa", zones: ["a"] } as RegionOption,
    zone: "us-central1-a",
    size: { id: "n2", label: "n2", vcpu: 8, memoryGiB: 32 } as SizeOption,
    image: { id: "ubuntu", label: "Ubuntu" } as ImageOption,
    network: { id: "managed", label: "Managed" } as CatalogOption,
  });

  it("passes every check when the selection is complete", () => {
    const checks = readinessChecks(ready());
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(canProvision(checks)).toBe(true);
    expect(unmetReadinessFixes(checks)).toEqual([]);
  });

  it("reports each failure as its own line rather than one joined sentence", () => {
    const checks = readinessChecks({
      ...ready(),
      name: "   ",
      network: null,
      diskGiBValid: false,
    });
    expect(canProvision(checks)).toBe(false);
    expect(unmetReadinessFixes(checks)).toEqual([
      "enter a workspace name",
      "load a network from the provider catalog",
      "enter a whole-number disk size between 20 and 16,384 GiB",
    ]);
  });

  it("keeps the checklist stable in length so lines do not reflow as they pass", () => {
    expect(readinessChecks(ready())).toHaveLength(11);
    expect(
      readinessChecks({ ...ready(), connection: null, name: "" }),
    ).toHaveLength(11);
  });

  it("does not demand a zone when no region is loaded to have one", () => {
    const checks = readinessChecks({ ...ready(), region: null, zone: null });
    expect(checks.find((check) => check.id === "zone")?.ok).toBe(true);
    expect(checks.find((check) => check.id === "region")?.ok).toBe(false);
  });

  it("demands a zone once a region IS loaded", () => {
    const checks = readinessChecks({ ...ready(), zone: null });
    expect(checks.find((check) => check.id === "zone")?.ok).toBe(false);
  });

  it("refuses an unvalidated or unsupported connection", () => {
    expect(
      readinessChecks({
        ...ready(),
        connection: connection({ status: "invalid" }),
      }).find((check) => check.id === "connection-validated")?.ok,
    ).toBe(false);
    expect(
      readinessChecks({
        ...ready(),
        connection: connection({ target: "azure" }),
      }).find((check) => check.id === "provider-supported")?.ok,
    ).toBe(false);
  });

  it("admits AWS only when its required launch metadata is present", () => {
    const incomplete = readinessChecks({ ...ready(), connection: connection({ target: "aws" }) });
    expect(incomplete.find((check) => check.id === "provider-supported")?.ok).toBe(true);
    expect(canProvision(incomplete)).toBe(false);
    const configured = connection({ target: "aws", provider: { vpcId: "vpc-01234567", securityGroupIds: ["sg-01234567"], launchTemplateId: "lt-01234567" } });
    expect(canProvision(readinessChecks({ ...ready(), connection: configured }))).toBe(true);
  });

  it("blocks while URL-backed selections are still settling", () => {
    expect(
      canProvision(
        readinessChecks({ ...ready(), catalogSelectionCanonical: false }),
      ),
    ).toBe(false);
  });
});

describe("disk validation", () => {
  it("accepts only whole numbers inside the documented range", () => {
    expect(isDiskGiBValid("20")).toBe(true);
    expect(isDiskGiBValid("200")).toBe(true);
    expect(isDiskGiBValid("16384")).toBe(true);
  });

  it("rejects rather than silently correcting an out-of-range or fractional value", () => {
    for (const invalid of ["", "19", "20.5", "16385", "abc", "-40"]) {
      expect(isDiskGiBValid(invalid)).toBe(false);
    }
  });
});

describe("rail model", () => {
  const now = Date.parse("2026-08-28T05:00:00.000Z");

  it("keeps evidence on a completed step instead of a bare tick", () => {
    const model = railModel([connection()], [workspace()], "operate", now);
    const connect = model.steps.find((step) => step.id === "connect");
    expect(connect).toMatchObject({ status: "done" });
    expect(connect?.evidence).toBe("GCP · validated 2h ago");
  });

  it("ages the Configure step from when the host was provisioned, not from when it was last observed", () => {
    /* `observedAt` is refreshed by every provider observation — every start,
       stop, repair and destroy — so reading the provisioning age off it makes a
       host stopped seconds ago report as freshly provisioned. `provisionedAt`
       is the row's creation stamp, which the host upsert deliberately never
       overwrites. */
    const model = railModel(
      [connection()],
      [
        workspace({
          provisionedAt: "2026-08-26T05:00:00.000Z",
          observedAt: "2026-08-28T04:59:57.000Z",
        }),
      ],
      "operate",
      now,
    );
    expect(model.steps.find((step) => step.id === "configure")?.evidence).toBe(
      "Last provisioned 2d ago",
    );
  });

  it("marks the active step current even when it would otherwise read done", () => {
    const model = railModel([connection()], [workspace()], "connect", now);
    expect(model.steps.find((step) => step.id === "connect")?.status).toBe(
      "current",
    );
  });

  it("surfaces a problem in a step the operator is NOT looking at", () => {
    const model = railModel(
      [connection({ status: "invalid" })],
      [workspace()],
      "operate",
      now,
    );
    const connect = model.steps.find((step) => step.id === "connect");
    expect(connect?.status).toBe("attention");
    expect(connect?.evidence).toBe("Production GCP · invalid");
  });

  it("raises attention on Operate when any host is drifting", () => {
    const model = railModel(
      [connection()],
      [
        workspace(),
        workspace({
          id: "host-2",
          desiredState: "running",
          observedState: "stopped",
        }),
      ],
      "configure",
      now,
    );
    const operate = model.steps.find((step) => step.id === "operate");
    expect(operate?.status).toBe("attention");
    expect(operate?.evidence).toBe("2 workspaces · 1 needs attention");
  });

  it("agrees the drift verb with the drift count, not with the host count", () => {
    const model = railModel(
      [connection()],
      [
        workspace(),
        workspace({
          id: "host-2",
          desiredState: "running",
          observedState: "stopped",
        }),
        workspace({
          id: "host-3",
          desiredState: "running",
          observedState: "stopped",
        }),
      ],
      "configure",
      now,
    );
    expect(model.steps.find((step) => step.id === "operate")?.evidence).toBe(
      "3 workspaces · 2 need attention",
    );
  });

  it("keeps the singular verb when exactly one host has drifted", () => {
    const model = railModel(
      [connection()],
      [
        workspace(),
        workspace({
          id: "host-2",
          desiredState: "running",
          observedState: "stopped",
        }),
        workspace({ id: "host-3" }),
      ],
      "configure",
      now,
    );
    expect(model.steps.find((step) => step.id === "operate")?.evidence).toBe(
      "3 workspaces · 1 needs attention",
    );
  });

  it("says all aligned when nothing is drifting", () => {
    const model = railModel([connection()], [workspace()], "connect", now);
    expect(model.steps.find((step) => step.id === "operate")?.evidence).toBe(
      "1 workspace · all aligned",
    );
  });

  it("marks unreachable steps so the rail can dim and disable them", () => {
    const model = railModel([], [], "connect", now);
    expect(model.steps.map((step) => step.reachable)).toEqual([
      true,
      false,
      false,
    ]);
    expect(model.steps.find((step) => step.id === "configure")?.evidence).toBe(
      "Needs a validated connection",
    );
    expect(model.steps.find((step) => step.id === "operate")?.evidence).toBe(
      "No workspaces yet",
    );
  });

  it("counts the fleet and sums only finite cost estimates", () => {
    const model = railModel(
      [connection()],
      [
        workspace({ estimatedMonthlyUsd: 100 }),
        workspace({
          id: "b",
          observedState: "stopped",
          desiredState: "stopped",
          estimatedMonthlyUsd: undefined,
        }),
        workspace({
          id: "c",
          observedState: "stopped",
          desiredState: "running",
          estimatedMonthlyUsd: Number.NaN,
        }),
      ],
      "operate",
      now,
    );
    expect(model.stats).toEqual({
      running: 1,
      stopped: 2,
      drifting: 1,
      monthlyUsd: 100,
    });
  });

  it("stops billing for a host that has been destroyed", () => {
    /* Nothing clears `estimated_monthly_usd` when a host is destroyed — the
       destroy path only moves desired/observed to `absent` — so a destroyed row
       still carries its provision-time estimate. The rail has to exclude it, or
       the Fleet posture panel bills for hardware that no longer exists and
       contradicts its own Running/Stopped counts, which already ignore
       `absent`. */
    const model = railModel(
      [connection()],
      [
        workspace({ estimatedMonthlyUsd: 100 }),
        workspace({
          id: "destroyed",
          desiredState: "absent",
          observedState: "absent",
          estimatedMonthlyUsd: 318.4,
        }),
      ],
      "operate",
      now,
    );
    expect(model.stats).toEqual({
      running: 1,
      stopped: 0,
      drifting: 0,
      monthlyUsd: 100,
    });
  });

  it("keeps billing for a host that is still being destroyed", () => {
    /* `destroying` is not `absent`: the instance is still up and still costing
       until the provider confirms it gone, so the estimate stays in the total. */
    const model = railModel(
      [connection()],
      [
        workspace({
          id: "going",
          desiredState: "absent",
          observedState: "destroying",
          estimatedMonthlyUsd: 318.4,
        }),
      ],
      "operate",
      now,
    );
    expect(model.stats.monthlyUsd).toBe(318.4);
  });
});

describe("formatters", () => {
  it("formats money, and says so plainly when there is no number to format", () => {
    expect(formatMoney(318.4)).toContain("318.40");
    expect(formatMoney(undefined)).toBe("Unavailable");
    expect(formatMoney(Number.NaN)).toBe("Unavailable");
  });

  it("never leaks undefined capacity from an incomplete catalog row", () => {
    expect(formatCapacity({ vcpu: 8, memoryGiB: 32 })).toBe(
      "8 vCPU · 32 GiB RAM",
    );
    expect(formatCapacity(null)).toBe("Capacity details unavailable");
    expect(formatCapacity({})).toBe("Capacity details unavailable");
    expect(formatCapacity({ vcpu: 8 })).toBe("Capacity details unavailable");
  });

  it("keeps an unparsable timestamp visible rather than blanking it", () => {
    expect(formatTimestamp(undefined)).toBe("not yet");
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp("2026-08-28T04:00:00.000Z")).not.toBe("not yet");
  });

  it("renders elapsed time coarsely", () => {
    const now = Date.parse("2026-08-28T05:00:00.000Z");
    expect(formatElapsed("2026-08-28T04:59:19.000Z", now)).toBe("41s");
    expect(formatElapsed("2026-08-28T04:54:00.000Z", now)).toBe("6m");
    expect(formatElapsed("2026-08-28T03:00:00.000Z", now)).toBe("2h");
    expect(formatElapsed("2026-08-25T05:00:00.000Z", now)).toBe("3d");
    expect(formatElapsed(undefined, now)).toBe("unknown");
    expect(formatElapsed("nonsense", now)).toBe("unknown");
  });

  it("never renders a clock-skewed future timestamp as negative", () => {
    const now = Date.parse("2026-08-28T05:00:00.000Z");
    expect(formatElapsed("2026-08-28T05:05:00.000Z", now)).toBe("0s");
  });

  it("stringifies arbitrary signal payloads without throwing", () => {
    expect(formatSignal(null)).toBe("none");
    expect(formatSignal("ok")).toBe("ok");
    expect(formatSignal(42)).toBe("42");
    expect(formatSignal(true)).toBe("true");
    expect(formatSignal({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatSignal(cyclic)).not.toThrow();
  });

  it("maps signal and state vocabulary onto the tone set", () => {
    expect(signalTone("healthy")).toBe("good");
    expect(signalTone("failed")).toBe("bad");
    expect(signalTone("retry-wait")).toBe("warn");
    expect(signalTone("anything-else")).toBe("neutral");
    expect(stateTone("running")).toBe("good");
    expect(stateTone("degraded")).toBe("bad");
    expect(stateTone("provisioning")).toBe("warn");
    expect(stateTone("stopped")).toBe("neutral");
  });

  it("derives a stable host id from an arbitrary display name", () => {
    expect(workspaceHostIdFromName("  Résumé / Lab  ")).toBe("host-resume-lab");
    expect(workspaceHostIdFromName("")).toBe("host-workspace");
    expect(workspaceHostIdFromName("!!!")).toBe("host-workspace");
  });
});

describe("estimate", () => {
  it("prices 730 compute hours plus the selected disk", () => {
    expect(
      estimateMonthlyUsd(
        { id: "n2", label: "n2", vcpu: 8, memoryGiB: 32, hourlyUsd: 0.5 },
        200,
        true,
        0.1,
      ),
    ).toBe(0.5 * 730 + 20);
  });

  it("withholds an estimate rather than guessing when inputs are missing", () => {
    expect(
      estimateMonthlyUsd(
        { id: "n2", label: "n2", vcpu: 8, memoryGiB: 32 },
        200,
        true,
        0.1,
      ),
    ).toBeUndefined();
    expect(
      estimateMonthlyUsd(
        { id: "n2", label: "n2", vcpu: 8, memoryGiB: 32, hourlyUsd: 0.5 },
        0,
        false,
        0.1,
      ),
    ).toBeUndefined();
    expect(estimateMonthlyUsd(null, 200, true, 0.1)).toBeUndefined();
  });

  it("treats a missing disk price as zero rather than poisoning the total", () => {
    expect(
      estimateMonthlyUsd(
        { id: "n2", label: "n2", vcpu: 8, memoryGiB: 32, hourlyUsd: 1 },
        100,
        true,
        undefined,
      ),
    ).toBe(730);
  });
});
