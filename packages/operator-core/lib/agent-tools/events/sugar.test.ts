import { describe, it, expect, vi, beforeEach } from "vitest";

const definedTools = vi.hoisted(
  () =>
    [] as Array<{
      name: string;
      handler: (
        args: never,
        ctx: never,
      ) => Promise<{ content: Array<{ text: string }> }>;
    }>,
);

vi.mock("@papercusp/agent-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: (typeof definedTools)[number]) => {
    definedTools.push(def);
    return def;
  },
  SU_ROLES: ["operator"],
}));

vi.mock("../coordination/identity", () => ({
  resolveAgentIdentity: () => ({
    ownerId: "su-awaiter",
    ownerLabel: "a",
    source: "static-client",
    workspaceId: "ws-x",
    userId: null,
  }),
}));

vi.mock("../../events/await/handle", () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({
    handle: {
      kind: "adv-session",
      advSessionId: 1,
      agent: "codex",
      sessionId: "s",
      ompThreadId: null,
      cwd: "/r",
      pid: 1,
    },
  })),
}));

vi.mock("../../events/await/store", () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({
    id: 99,
    eventKey: i.eventKey,
    expiresTs: "2030-01-01",
    timeoutBehavior: i.timeoutBehavior,
  })),
  attachProducerHealthCertificate: vi.fn(async () => 4),
  cancelAwait: vi.fn(async () => true),
  cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
  FLEET_BENCH_NOTE_PREFIX: "[fleet:bench] ",
}));

vi.mock("../../service-health", () => ({
  probeNamedService: vi.fn(async () => null),
}));

vi.mock("../../events/await/engine", () => ({ startAwaitSweeper: vi.fn() }));

vi.mock("../../dev-deploy-state", () => ({
  devDeployState: vi.fn(async () => ({
    integrationRoot: "/home/x/papercupai-workspace/papercusp",
  })),
}));

// EI-18676050719521433: the deploy-already-landed latch probes these two —
// mocked here so the rig stays hermetic (the real modules shell out to git).
// Default: a snapshot/position pair describing a sha that is NOT yet deployed,
// so every EXISTING deploy:await case keeps registering exactly as before.
vi.mock("../../git-pipeline-stats", () => ({
  gitPipelineSnapshot: vi.fn(async () => ({ deploy: { deployed: { sha: "not-target" } } })),
}));
vi.mock("../../git-pipeline-position", () => ({
  gitPipelinePosition: vi.fn(async () => ({
    targetSha: "abc123",
    deployedSha: "not-target",
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
    // EI-19448585641887174: the real resolver ALWAYS returns `serving` (a required
    // field on PipelinePosition), so a fixture without it is drift, not a smaller
    // valid shape. The latch reads it un-defensively for exactly that reason — a
    // fixture that forgets it should fail loudly rather than silently read as
    // "not stale", which is the direction that would ship a false "it's live".
    serving: { startedSinceCodeChange: true, behindMin: null },
  })),
}));

// EI-19448585641887174: the UNTARGETED deploy:await arm probes the deploy unit to warn
// when it is being armed mid-deploy — mocked so the rig stays hermetic (the real module
// shells out to systemctl). Default: MEASURED idle, so every existing untargeted case
// arms exactly as before and emits no warning.
vi.mock("../../release-deploy-launch", () => ({
  readDeployInFlight: vi.fn(async () => ({
    active: false,
    unit: "papercup-auto-deploy",
    activeState: "inactive",
    subState: "dead",
    startedAtMs: null,
    logPath: "/tmp/papercup-auto-deploy.log",
    logMtimeMs: null,
    source: "systemd",
  })),
}));

// EI-18676650746298156: checkpoint:await's candidateSha already-judged latch probes this —
// mocked here so the rig stays hermetic (the real module hits Postgres). Default: no
// matching row, so every EXISTING checkpoint:await case keeps registering exactly as before.
vi.mock("../../harness/git-sync/pipeline-events", () => ({
  findGreenCheckpointVerdictForCandidate: vi.fn(async () => null),
}));

vi.mock("../../acceptance-runtime-wait-guard", () => ({
  mainWaitPlanReviewForWait: vi.fn(async () => null),
}));

// EI-13095/P-006: the work-item:await latches probe the live item — mocked here
// so the rig stays hermetic (the real module pulls db-org). Default
// 'live'/a real blocking edge = every existing case registers exactly as before.
vi.mock("../../work-items-events", () => ({
  liveSettledProbe: vi.fn(async () => ({ verdict: "live" as const, itemState: "wip" })),
  liveBlockedState: vi.fn(async () => ({
    verdict: "blocked" as const,
    lifecycleState: "open",
    dependencyState: "blocked" as const,
  })),
}));

await import("./sugar");

import {
  registerAwait,
  attachProducerHealthCertificate,
  cancelAwait,
  cancelAwaitsForSubscribersOnKeys,
} from "../../events/await/store";
import { probeNamedService, type ProbeResult } from "../../service-health";
import { devDeployState } from "../../dev-deploy-state";
import { liveBlockedState, liveSettledProbe } from "../../work-items-events";
import { gitPipelineSnapshot } from "../../git-pipeline-stats";
import { gitPipelinePosition } from "../../git-pipeline-position";
import { readDeployInFlight } from "../../release-deploy-launch";
import { findGreenCheckpointVerdictForCandidate } from "../../harness/git-sync/pipeline-events";
import { mainWaitPlanReviewForWait } from "../../acceptance-runtime-wait-guard";
import { checkpointPipelineName } from "./sugar";

const checkpointTool = definedTools.find(
  (tool) => tool.name === "checkpoint:await",
);
if (!checkpointTool)
  throw new Error("checkpoint:await tool was not registered");

const ctx = { workspaceId: "ws-x" } as never;
const call = async (args: Record<string, unknown>) => {
  const res = await checkpointTool.handler(args as never, ctx);
  return JSON.parse(res.content[0].text);
};

it("opts checkpoint:await out of the ambient workspace transaction", () => {
  expect((checkpointTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeNamedService).mockResolvedValue(null);
  vi.mocked(cancelAwait).mockResolvedValue(true);
  vi.mocked(attachProducerHealthCertificate).mockResolvedValue(4);
});

describe("checkpoint:await sugar", () => {
  it("refuses a main wait with ready plan work before registering any wake", async () => {
    vi.mocked(mainWaitPlanReviewForWait).mockResolvedValueOnce({
      plan: 'plan-a', allowWait: false, code: 'plan_main_wait_review_required',
      readyItems: ['P-002'], downstreamItems: [], waitRoots: ['P-001'], reasonAccepted: false,
      message: 'Continue P-002 on staging',
    });
    const out = await call({ pipeline: 'papercusp' });
    expect(out).toMatchObject({ ok: false, error: 'plan_main_wait_review_required', readyItems: ['P-002'] });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("defaults to the current pipeline-scoped gate keys", async () => {
    const out = await call({});

    expect(devDeployState).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
    expect(out.advice).toContain("End your turn");
  });

  it("uses an explicit pipeline without reading deploy state", async () => {
    await call({ pipeline: "papercup" });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual([
      "release:green:papercup",
      "green-checkpoint:red:papercup",
      "green-checkpoint:inconclusive:papercup",
      "green-checkpoint:held:papercup",
    ]);
  });

  it("keeps an explicit global escape hatch for cross-pipeline monitors", async () => {
    await call({ global: true });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(
      vi.mocked(registerAwait).mock.calls.map((call) => call[0].eventKey),
    ).toEqual([
      "release:green",
      "green-checkpoint:red",
      "green-checkpoint:inconclusive",
      "green-checkpoint:held",
    ]);
  });

  // EI-19320479870270699: the third, non-judging outcome must be armed alongside the
  // other two so "await the decision" genuinely covers every way the gate run can end —
  // an inconclusive run (migrations-pending / skipped-locked / …) used to leave every
  // parked awaiter asleep straight through to its full timeout with no signal at all.
  it("EI-19320479870270699: arms the inconclusive key alongside green/red so a non-judging run still wakes the awaiter", async () => {
    const out = await call({ pipeline: "papercup" });

    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toContain("green-checkpoint:inconclusive:papercup");
    expect(out.events).toContain("green-checkpoint:inconclusive:papercup");
  });

  it("sanitizes pipeline names the same way checkpoint emitters do", () => {
    expect(checkpointPipelineName("/weird/dir with spaces!")).toBe(
      "dir-with-spaces-",
    );
  });

  // EI-12457: candidateSha binds the wait to an exact subject via a payload
  // predicate, and re-arming must retire this subscriber's own prior pending
  // checkpoint-family wait for the pipeline BEFORE registering the new one.
  it("binds candidateSha to a payloadFilter on every registered key", async () => {
    const out = await call({ candidateSha: "94c1234567" });

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({
        sha: { startsWith: "94c1234567" },
      });
    }
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
  });

  it("omits payloadFilter when no candidateSha is given", async () => {
    await call({});

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toBeNull();
    }
  });

  // WI-4957: runId binds further than candidateSha alone — needed only when two runs
  // might judge the same candidate (a re-fire, or a routine/manual race).
  it("WI-4957: binds runId to a payloadFilter on global keys when pipeline is omitted", async () => {
    const out = await call({ runId: "run-abc-123" });

    expect(devDeployState).not.toHaveBeenCalled();
    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({ runId: "run-abc-123" });
    }
    expect(out.events).toEqual([
      "release:green",
      "green-checkpoint:red",
      "green-checkpoint:inconclusive",
      "green-checkpoint:held",
    ]);
  });

  it("WI-4957: an explicit pipeline keeps a runId await pipeline-scoped", async () => {
    const out = await call({ pipeline: "papercup", runId: "run-abc-123" });

    expect(devDeployState).not.toHaveBeenCalled();
    expect(out.events).toEqual([
      "release:green:papercup",
      "green-checkpoint:red:papercup",
      "green-checkpoint:inconclusive:papercup",
      "green-checkpoint:held:papercup",
    ]);
    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({ runId: "run-abc-123" });
    }
  });

  it("WI-4957: candidateSha + runId compose into ONE AND-filter (both must match)", async () => {
    await call({ candidateSha: "94c1234567", runId: "run-abc-123" });

    for (const call_ of vi.mocked(registerAwait).mock.calls) {
      expect(call_[0].payloadFilter).toEqual({
        sha: { startsWith: "94c1234567" },
        runId: "run-abc-123",
      });
    }
  });

  it("supersedes this subscriber's own prior pending checkpoint keys BEFORE registering the new wait, and threads the count into the response", async () => {
    const callOrder: string[] = [];
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockImplementationOnce(
      async () => {
        callOrder.push("supersede");
        return 3;
      },
    );
    vi.mocked(registerAwait).mockImplementationOnce(async (i) => {
      callOrder.push("register");
      return {
        id: 99,
        eventKey: i.eventKey,
        expiresTs: "2030-01-01",
        timeoutBehavior: i.timeoutBehavior,
      } as never;
    });

    const out = await call({ candidateSha: "94c1234567" });

    expect(cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledWith(
      ["su-awaiter"],
      [
        "release:green:papercusp",
        "green-checkpoint:red:papercusp",
        "green-checkpoint:inconclusive:papercusp",
        "green-checkpoint:held:papercusp",
      ],
      { excludeNotePrefix: "[fleet:bench] " },
    );
    expect(callOrder[0]).toBe("supersede");
    expect(callOrder).toContain("register");
    expect(out.superseded).toBe(3);
  });

  it("reports zero superseded when nothing was retired (checkpoint:await always attempts supersession)", async () => {
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockResolvedValueOnce(0);

    const out = await call({});

    expect(out.superseded).toBe(0);
  });

  // WI-5685: the generic events:await default (1800s/30min) is shorter than the suite can
  // legitimately run (the systemd backstop alone allows up to 3h) — a default-timeout
  // checkpoint:await used to strand the caller mid-suite on EVERY default call. This verb now
  // carries its OWN default derived from the suite's real ceiling.
  it("WI-5685: defaults the registered timeout to the suite's real ceiling, not the generic 30min events:await default", async () => {
    await call({});

    const timeouts = vi
      .mocked(registerAwait)
      .mock.calls.map((c) => c[0].timeoutSec);
    expect(new Set(timeouts).size).toBe(1);
    expect(timeouts[0]).toBeGreaterThan(30 * 60); // strictly longer than the generic default
    expect(timeouts[0]).toBeGreaterThanOrEqual(3 * 60 * 60); // at least the systemd backstop (3h)
  });

  it("WI-5685: an explicit timeout_sec still always wins over the checkpoint-specific default", async () => {
    await call({ timeout_sec: 60 });

    const timeouts = vi
      .mocked(registerAwait)
      .mock.calls.map((c) => c[0].timeoutSec);
    expect(timeouts).toEqual([60, 60, 60, 60]);
  });

  it("registers every await before observing or attaching the producer certificate", async () => {
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      vi.mocked(registerAwait).mockImplementationOnce(async (input) => {
        order.push(`register:${String(input.eventKey)}`);
        return {
          id: 100 + i,
          eventKey: input.eventKey,
          expiresTs: "2030-01-01",
          timeoutBehavior: input.timeoutBehavior,
        } as never;
      });
    }
    vi.mocked(gitPipelineSnapshot).mockImplementationOnce(async () => {
      order.push("snapshot");
      return { deploy: { deployed: { sha: "not-target" } } } as never;
    });
    vi.mocked(attachProducerHealthCertificate).mockImplementationOnce(async (input) => {
      order.push("attach");
      expect(input.awaitIds).toEqual([100, 101, 102, 103]);
      expect(input.certificate).toMatchObject({
        producer: { kind: "green-checkpoint" },
        details: { pipeline: "papercusp" },
        expectedCadenceMs: 60_000,
      });
      return 4;
    });

    await call({ pipeline: "papercusp", timeout_sec: 60 });

    expect(order).toEqual([
      "register:release:green:papercusp",
      "register:green-checkpoint:red:papercusp",
      "register:green-checkpoint:inconclusive:papercusp",
      "register:green-checkpoint:held:papercusp",
      "snapshot",
      "attach",
    ]);
  });

  it("keeps a zero-timeout checkpoint probe immediate without attaching a health cadence", async () => {
    await call({
      pipeline: "papercusp",
      candidateSha: "94c1234567890abcdef",
      timeout_sec: 0,
    });

    expect(registerAwait).toHaveBeenCalledTimes(4);
    expect(gitPipelineSnapshot).not.toHaveBeenCalled();
    expect(attachProducerHealthCertificate).not.toHaveBeenCalled();
  });

  it("keeps registered awaits usable when producer observation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(gitPipelineSnapshot).mockRejectedValueOnce(new Error("snapshot unavailable"));

    const out = await call({ pipeline: "papercusp", timeout_sec: 60 });

    expect(out.ok).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(4);
    expect(attachProducerHealthCertificate).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keeps registered awaits usable when certificate attachment fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(attachProducerHealthCertificate).mockRejectedValueOnce(new Error("attach unavailable"));

    const out = await call({ pipeline: "papercusp", timeout_sec: 60 });

    expect(out.ok).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(4);
    expect(attachProducerHealthCertificate).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("deploy:await already-deployed latch (EI-18676050719521433 — was purely edge-triggered)", () => {
  const deployTool = definedTools.find((tool) => tool.name === "deploy:await");
  if (!deployTool) throw new Error("deploy:await tool was not registered");
  const callDeploy = async (args: Record<string, unknown>) => {
    const res = await deployTool.handler(args as never, ctx);
    return JSON.parse(res.content[0].text);
  };

  it("refuses a main wait with staging-ready plan work before registering either outcome", async () => {
    vi.mocked(mainWaitPlanReviewForWait).mockResolvedValueOnce({
      plan: 'plan-a', allowWait: false, code: 'plan_main_wait_review_required',
      readyItems: ['P-002'], downstreamItems: [], waitRoots: ['P-001'], reasonAccepted: false,
      message: 'Continue P-002 on staging',
    });
    const out = await callDeploy({ note: 'waiting for main before P-002' });
    expect(out).toMatchObject({ ok: false, error: 'plan_main_wait_review_required', readyItems: ['P-002'] });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("a sha ALREADY deployed answers already_deployed and registers NOTHING (the stranded-wait class)", async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValueOnce({
      targetSha: "33bfb1e68de2bffd5c45c831762261ec426790f7",
      deployedSha: "a5ba5521",
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      serving: { startedSinceCodeChange: true, behindMin: null },
    } as never);

    const out = await callDeploy({ sha: "33bfb1e68de2bffd5c45c831762261ec426790f7" });

    expect(out).toMatchObject({
      ok: true,
      already_deployed: true,
      sha: "33bfb1e68de2bffd5c45c831762261ec426790f7",
      deployedSha: "a5ba5521",
    });
    expect(out.advice).toContain("Do not wait");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  /**
   * EI-19448585641887174 — the swap→restart window.
   *
   * `positions.deployed` is ancestry against the RELEASE CHECKOUT'S HEAD, which the
   * deploy's `swap` step moves BEFORE it restarts the process (deploy.ts: swap …
   * L389 restart … L438 emit release:deployed). So this state is not exotic — every
   * normal deploy passes through it — and in it the latch was telling callers the sha
   * was "live on :3070" and to "proceed with the work that needed it live now" while
   * the OLD process was still serving. A git fact stating a process conclusion.
   */
  it("does NOT claim a sha is live while the serving process has not restarted into it", async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValueOnce({
      targetSha: "33bfb1e68de2bffd5c45c831762261ec426790f7",
      deployedSha: "33bfb1e6",
      // The files ARE in the release checkout…
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      // …and the process serving them predates the code by 3 minutes.
      serving: { startedSinceCodeChange: false, behindMin: 3 },
    } as never);

    const out = await callDeploy({ sha: "33bfb1e68de2bffd5c45c831762261ec426790f7" });

    // The LATCH still fires, and that is deliberate: its subject is key semantics, not
    // liveness. Suppressing it here would re-open EI-18676050719521433 — a full-timeout
    // sleep on a per-sha key that can never re-fire for an already-shipped sha.
    expect(out.already_deployed).toBe(true);
    expect(registerAwait, 'must not register a per-sha wait that cannot fire').not.toHaveBeenCalled();

    // What changed is the CLAIM. The false "it is live, go" must be gone…
    expect(out.serving_stale).toBe(true);
    expect(out.advice).not.toMatch(/live on :3070/);
    expect(out.advice).not.toMatch(/proceed with the work/);
    // …replaced by the measurement and the key that actually marks restart-complete.
    expect(out.advice).toMatch(/NOT yet running it/);
    expect(out.advice).toMatch(/~3m/);
    expect(out.advice).toMatch(/release:deployed/);
  });

  /**
   * The opposite-direction guard. `startedSinceCodeChange` is null on a host with no
   * serving unit (tauri-desktop) or an unprobeable one — manufacturing a staleness
   * warning from that absence would be the same defect with the sign flipped, and it
   * would fire on every such caller.
   */
  it("treats an UNMEASURABLE serving reading as not-stale, never as stale", async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValueOnce({
      targetSha: "33bfb1e68de2bffd5c45c831762261ec426790f7",
      deployedSha: "33bfb1e6",
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      serving: { startedSinceCodeChange: null, behindMin: null },
    } as never);

    const out = await callDeploy({ sha: "33bfb1e68de2bffd5c45c831762261ec426790f7" });

    expect(out.already_deployed).toBe(true);
    expect(out.serving_stale).toBe(false);
    expect(out.advice).toContain("Do not wait");
  });

  it("a sha NOT yet deployed still registers exactly as before (sibling case)", async () => {
    // Default mock already answers positions.deployed:false.
    const out = await callDeploy({ sha: "abc123" });

    expect(out.already_deployed).toBeUndefined();
    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toEqual(["release:deployed:abc123", "release:deploy-failed"]);
  });

  it("omitting sha entirely skips the probe and registers the global keys as before", async () => {
    const out = await callDeploy({});

    expect(gitPipelineSnapshot).not.toHaveBeenCalled();
    expect(gitPipelinePosition).not.toHaveBeenCalled();
    expect(out.already_deployed).toBeUndefined();
    // Deploy unit measured IDLE (default mock) ⇒ nothing to warn about.
    expect(out.warning).toBeUndefined();
    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toEqual(["release:deployed", "release:deploy-failed"]);
  });

  it("supersedes this subscriber's prior deploy outcome pair before renewing the wait", async () => {
    const callOrder: string[] = [];
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockImplementationOnce(async () => {
      callOrder.push("supersede");
      return 2;
    });
    vi.mocked(registerAwait).mockImplementationOnce(async (i) => {
      callOrder.push("register");
      return {
        id: 99,
        eventKey: i.eventKey,
        expiresTs: "2030-01-01",
        timeoutBehavior: i.timeoutBehavior,
      } as never;
    });

    const out = await callDeploy({});

    expect(cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledWith(
      ["su-awaiter"],
      ["release:deployed", "release:deploy-failed"],
      { excludeNotePrefix: "[fleet:bench] " },
    );
    expect(callOrder[0]).toBe("supersede");
    expect(callOrder).toContain("register");
    expect(out.superseded).toBe(2);
  });

  it("reports zero superseded when a deploy renewal finds no prior pair", async () => {
    vi.mocked(cancelAwaitsForSubscribersOnKeys).mockResolvedValueOnce(0);

    const out = await callDeploy({ sha: "abc123" });

    expect(out.superseded).toBe(0);
  });

  /**
   * EI-19448585641887174 — the reported loss, at the arm site.
   *
   * The UNTARGETED form has no already-landed latch, so arming it mid-deploy registers a
   * wait that the IN-FLIGHT deploy can never satisfy (its `release:deployed` fires at the
   * END, after the restart, and by then it has already fired). Reported live: 900s slept
   * for nothing. It must still ARM — "wake me on the next deploy" is legitimate — but the
   * caller has to be TOLD, while they can still act on it.
   */
  it("WARNS when an untargeted await is armed while a deploy is already running — and still arms", async () => {
    vi.mocked(readDeployInFlight).mockResolvedValueOnce({
      active: true,
      unit: "papercup-auto-deploy",
      activeState: "activating",
      subState: "running",
      startedAtMs: 1_700_000,
      logPath: "/tmp/papercup-auto-deploy.log",
      logMtimeMs: null,
      source: "systemd",
    } as never);

    const out = await callDeploy({});

    // Still armed — the warning must not cost the caller the wait they asked for.
    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toEqual(["release:deployed", "release:deploy-failed"]);
    expect(out.deploy_in_flight).toMatchObject({ unit: "papercup-auto-deploy", activeState: "activating" });
    expect(out.warning).toMatch(/ALREADY RUNNING/);
    expect(out.warning).toMatch(/will NOT wake for it/);
    expect(out.warning).toMatch(/startedSinceCodeChange/);
  });

  /**
   * The absence-vs-measurement guard, same rule as the serving latch above: a probe that
   * could NOT read systemd reports `active:false, source:'systemd-unavailable'`, and that
   * is UNKNOWN — never "a deploy is running". Warning on it would fire spuriously on every
   * host without systemd.
   */
  it("does NOT warn on an UNMEASURABLE deploy-unit reading", async () => {
    vi.mocked(readDeployInFlight).mockResolvedValueOnce({
      active: true, // even if some future path sets this, the source is what decides
      unit: "papercup-auto-deploy",
      activeState: null,
      subState: null,
      startedAtMs: null,
      logPath: "/tmp/papercup-auto-deploy.log",
      logMtimeMs: null,
      source: "systemd-unavailable",
    } as never);

    const out = await callDeploy({});

    expect(out.warning).toBeUndefined();
    expect(out.deploy_in_flight).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(2);
  });

  it("a TARGETED await never pays the in-flight probe (it has its own latch)", async () => {
    await callDeploy({ sha: "abc123" });
    expect(readDeployInFlight).not.toHaveBeenCalled();
  });

  it("a probe failure/timeout fails OPEN — registers normally rather than blocking the await", async () => {
    // withBoundedTimeout logs a console.warn on a caught rejection (expected here —
    // we are deliberately exercising its fallback path, not a real bug).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(gitPipelineSnapshot).mockRejectedValueOnce(new Error("git unavailable"));

    const out = await callDeploy({ sha: "def456" });

    expect(out.already_deployed).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe("checkpoint:await already-judged latch (EI-18676650746298156 — deploy:await's candidateSha sibling)", () => {
  const call = async (args: Record<string, unknown>) => {
    const res = await checkpointTool.handler(args as never, ctx);
    return JSON.parse(res.content[0].text);
  };

  it("EI-20256713252259611: accepts a zero-second timeout for an immediate probe", () => {
    expect(
      // `definedTools.find()` narrows to { name, handler }, so `args` (the zod schema) is not on
      // the inferred type. Cast locally — the same pattern this file already uses for
      // `skipWorkspaceTx` above — rather than widening the shared tool type.
      (
        checkpointTool as unknown as {
          args: { safeParse: (value: unknown) => { success: boolean } };
        }
      ).args.safeParse({
        candidateSha: "94c1234567890abcdef",
        timeout_sec: 0,
      }).success,
    ).toBe(true);
  });

  it("EI-20256713252259611: zero-timeout probe reaches an already-judged latch", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "advanced",
      detail: { candidate: "94c123456789", green: true },
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({
      candidateSha: "94c1234567890abcdef",
      timeout_sec: 0,
    });

    expect(out).toMatchObject({
      ok: true,
      already_judged: true,
      green: true,
      event: "release:green:papercusp",
    });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("a candidateSha ALREADY judged GREEN answers already_judged and registers NOTHING (the stranded-wait class)", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "advanced",
      detail: { candidate: "94c123456789", green: true },
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out).toMatchObject({
      ok: true,
      already_judged: true,
      green: true,
      status: "advanced",
      event: "release:green:papercusp",
    });
    expect(out.advice).toContain("Do not wait");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("a candidateSha ALREADY judged HELD/RED answers already_judged (green:false) against the red key and registers NOTHING", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "not-green",
      detail: { candidate: "94c123456789", green: false },
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out).toMatchObject({
      ok: true,
      already_judged: true,
      green: false,
      status: "not-green",
      event: "green-checkpoint:red:papercusp",
    });
    expect(out.advice).toContain("Do not wait");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("does not latch an interim decision-pending row as a final red verdict", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "decision-pending",
      detail: {
        candidate: "94c123456789",
        green: false,
        promotionPending: true,
      },
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out.already_judged).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(4);
    expect(out.events).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
  });

  it("WI-5685 shape: an 'advanced-prefix' match (candidate stayed red; a DIFFERENT earlier prefix advanced) reports green:false, never misread as green from the status string alone", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "advanced-prefix",
      detail: { candidate: "94c123456789", green: false, advancedTo: "aaaaaaaaaaaa" },
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out.already_judged).toBe(true);
    expect(out.green).toBe(false);
    expect(out.event).toBe("green-checkpoint:red:papercusp");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("a candidateSha NOT yet judged still registers exactly as before (sibling case — default mock answers no match)", async () => {
    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out.already_judged).toBeUndefined();
    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
  });

  it("omitting candidateSha entirely skips the probe and registers the pipeline keys as before", async () => {
    const out = await call({});

    expect(findGreenCheckpointVerdictForCandidate).not.toHaveBeenCalled();
    expect(out.already_judged).toBeUndefined();
    expect(
      vi.mocked(registerAwait).mock.calls.map((c) => c[0].eventKey),
    ).toEqual([
      "release:green:papercusp",
      "green-checkpoint:red:papercusp",
      "green-checkpoint:inconclusive:papercusp",
      "green-checkpoint:held:papercusp",
    ]);
  });

  it("global:true probes across ALL pipelines (installSlug null) rather than the current pipeline", async () => {
    await call({ candidateSha: "94c1234567890abcdef", global: true });

    expect(findGreenCheckpointVerdictForCandidate).toHaveBeenCalledWith(
      null,
      "94c1234567890abcdef",
      { runId: undefined },
    );
  });

  it("a scoped call probes with the resolved pipeline as installSlug", async () => {
    await call({
      candidateSha: "94c1234567890abcdef",
      pipeline: "papercup",
      runId: "run-xyz",
    });

    expect(findGreenCheckpointVerdictForCandidate).toHaveBeenCalledWith(
      "papercup",
      "94c1234567890abcdef",
      { runId: "run-xyz" },
    );
  });

  it("a runId-only scoped-by-payload call probes across all pipelines", async () => {
    await call({ candidateSha: "94c1234567890abcdef", runId: "run-xyz" });

    expect(findGreenCheckpointVerdictForCandidate).toHaveBeenCalledWith(
      null,
      "94c1234567890abcdef",
      { runId: "run-xyz" },
    );
  });

  it("a probe failure/timeout fails OPEN — registers normally rather than blocking the await", async () => {
    // withBoundedTimeout logs a console.warn on a caught rejection (expected here —
    // we are deliberately exercising its fallback path, not a real bug).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockRejectedValueOnce(new Error("db unavailable"));

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out.already_judged).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(4);
    warnSpy.mockRestore();
  });

  it("a match with detail.green missing/non-boolean is treated as unresolved and falls through to a normal registration", async () => {
    vi.mocked(findGreenCheckpointVerdictForCandidate).mockResolvedValueOnce({
      status: "skipped-disabled",
      detail: { candidate: "94c123456789" }, // no `green` key at all
      createdAtMs: 1_700_000_000_000,
    } as never);

    const out = await call({ candidateSha: "94c1234567890abcdef" });

    expect(out.already_judged).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(4);
  });
});

describe("git-sync:await harness/workspace scoping (EI-20366619311636764)", () => {
  const gitSyncTool = definedTools.find((tool) => tool.name === "git-sync:await");
  if (!gitSyncTool) throw new Error("git-sync:await tool was not registered");

  it("accepts on_timeout and threads expire through the shared await registration (EI-21671694555865156)", async () => {
    const schema = (
      gitSyncTool as unknown as {
        args: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).args;
    expect(
      schema.safeParse({
        harness: "harness-a",
        timeout_sec: 30,
        on_timeout: "expire",
      }).success,
    ).toBe(true);

    const res = await gitSyncTool.handler(
      { harness: "harness-a", timeout_sec: 30, on_timeout: "expire" } as never,
      { harnessSlug: "*", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: true,
      events: ["git-sync:committed"],
    });
    expect(registerAwait).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "git-sync:committed",
        timeoutSec: 30,
        timeoutBehavior: "expire",
      }),
    );
  });

  it("binds the global commit wait to the caller's concrete harness, workspace, and registration boundary", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const res = await gitSyncTool.handler(
      {} as never,
      { harnessSlug: "harness-a", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text).events).toEqual(["git-sync:committed"]);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter).toEqual({
      installSlug: "harness-a",
      workspaceId: "workspace-a",
      committedAtMs: { gt: 1_700_000_000_000 },
    });
    now.mockRestore();
  });

  it("rejects an operator-scope next-commit wait when no concrete harness is available", async () => {
    const res = await gitSyncTool.handler(
      {} as never,
      { harnessSlug: "*", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text)).toMatchObject({
      error: "harness_required",
      tool: "git-sync:await",
    });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("accepts an explicit harness for an operator-scope next-commit wait", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const res = await gitSyncTool.handler(
      { harness: "harness-a" } as never,
      { harnessSlug: "*", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text).events).toEqual(["git-sync:committed"]);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter).toEqual({
      installSlug: "harness-a",
      workspaceId: "workspace-a",
      committedAtMs: { gt: 1_700_000_000_000 },
    });
    now.mockRestore();
  });

  it("keeps an exact-SHA operator wait available without a concrete harness", async () => {
    const sha = "abc1234def5678901234567890abcdef12345678";
    const res = await gitSyncTool.handler(
      { sha } as never,
      { harnessSlug: "*", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text).events).toEqual([`git-sync:committed:${sha}`]);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter).toBeNull();
  });

  // EI-24719187042784648: git-sync emits the FULL head sha only, so a short sha arms a key
  // that can never fire — the wait would hang silently until its timeout.
  it("refuses a short sha instead of registering a key that can never fire", async () => {
    const res = await gitSyncTool.handler(
      { sha: "abc1234" } as never,
      { harnessSlug: "harness-a", workspaceId: "workspace-a" } as never,
    );

    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: false,
      error: "git_sync_key_never_fires",
      tool: "git-sync:await",
      event: "git-sync:committed:abc1234",
    });
    expect(registerAwait).not.toHaveBeenCalled();
  });
});

describe("work-item:await registration latches (EI-13095 — the sugar used to bypass them)", () => {
  const wiTool = definedTools.find((tool) => tool.name === "work-item:await");
  if (!wiTool) throw new Error("work-item:await tool was not registered");
  const callWi = async (args: Record<string, unknown>) => {
    const res = await wiTool.handler(args as never, ctx);
    return JSON.parse(res.content[0].text);
  };

  it("state:'done' on an ALREADY-settled item answers already_done and registers NOTHING (the WI-5075 stranded-await class)", async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: "settled", itemState: "resolved" });
    const out = await callWi({ id: "WI-5075", state: "done" });
    expect(out).toMatchObject({ ok: true, already_done: true, item_state: "resolved" });
    expect(out.advice).toContain("Do not wait");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'done' on a LIVE item registers the done key exactly as before", async () => {
    const out = await callWi({ id: "WI-42", state: "done" });
    expect(out.ok).toBe(true);
    expect(out.already_done).toBeUndefined();
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:done:WI-42");
  });

  it("state:'done' with an UNKNOWN probe (unreadable item) fails OPEN — registers normally", async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: "unknown" });
    const out = await callWi({ id: "WI-404", state: "done" });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it("state:'unblocked' on an item with no live blocker answers already_unblocked (the P-006 latch, now applied via sugar too)", async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce({
      verdict: "unblocked",
      lifecycleState: "open",
      dependencyState: "unblocked",
    });
    const out = await callWi({ id: "WI-7", state: "unblocked" });
    expect(out).toMatchObject({ ok: true, already_unblocked: true, item_state: "unblocked" });
    expect(out).toMatchObject({ lifecycle_state: "open", dependency_state: "unblocked" });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'unblocked' on a SETTLED item also latches (the key can never fire)", async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce({
      verdict: "settled",
      lifecycleState: "resolved",
      dependencyState: "not-applicable",
    });
    const out = await callWi({ id: "WI-8", state: "unblocked" });
    expect(out).toMatchObject({ already_unblocked: true, item_state: "settled" });
    expect(out).toMatchObject({ lifecycle_state: "resolved", dependency_state: "not-applicable" });
    expect(out.advice).toContain("never fire");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'unblocked' on a genuinely BLOCKED item registers as before", async () => {
    const out = await callWi({ id: "WI-9", state: "unblocked" });
    expect(out.already_unblocked).toBeUndefined();
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:unblocked:WI-9");
  });

  it("state:'unblocked' on a lifecycle-blocked item with no dependency edges is refused as unfirable", async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce({
      verdict: "blocked",
      lifecycleState: "blocked",
      dependencyState: "unblocked",
    });
    const out = await callWi({ id: "WI-42228", state: "unblocked" });
    expect(out).toMatchObject({
      ok: false,
      error: "unfirable_work_item_unblocked",
      firable: false,
      event: "work-item:unblocked:WI-42228",
      work_item_id: "WI-42228",
      item_state: "blocked",
      lifecycle_state: "blocked",
      dependency_state: "unblocked",
    });
    expect(out.advice).toContain("NO live blocker dependency edge");
    expect(out.advice).toContain("nothing was registered");
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it("state:'any' probes NOTHING (the general status key can always fire again)", async () => {
    const out = await callWi({ id: "WI-10" });
    expect(liveSettledProbe).not.toHaveBeenCalled();
    expect(liveBlockedState).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe("work-item:status:WI-10");
  });
});

describe("service:await-up state-aware registration latch (EI-21308013234701667)", () => {
  const serviceTool = definedTools.find((tool) => tool.name === "service:await-up");
  if (!serviceTool) throw new Error("service:await-up tool was not registered");
  const callService = async (args: Record<string, unknown>) => {
    const res = await serviceTool.handler(args as never, ctx);
    return JSON.parse(res.content[0].text);
  };

  const up = (name = "staging-api"): ProbeResult => ({
    name,
    up: true,
    status: 200,
    latencyMs: 2,
    url: "http://127.0.0.1:3170/api/desktop/version",
  });
  const down = (name = "staging-api"): ProbeResult => ({
    name,
    up: false,
    status: null,
    latencyMs: 2,
    url: "http://127.0.0.1:3170/api/desktop/version",
  });

  it("returns already_up without registering when a fresh probe is healthy", async () => {
    vi.mocked(probeNamedService).mockResolvedValueOnce(up());

    const out = await callService({ name: "staging-api" });

    expect(out).toMatchObject({
      ok: true,
      already_up: true,
      service: "staging-api",
      event: "service:up:staging-api",
    });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(cancelAwait).not.toHaveBeenCalled();
  });

  it("registers normally when the named service is currently down", async () => {
    vi.mocked(probeNamedService).mockResolvedValueOnce(down()).mockResolvedValueOnce(down());

    const out = await callService({ name: "staging-api", timeout_sec: 30 });

    expect(out.events).toEqual(["service:up:staging-api"]);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(cancelAwait).not.toHaveBeenCalled();
  });

  it("cancels only the still-pending row when recovery wins during registration", async () => {
    vi.mocked(probeNamedService).mockResolvedValueOnce(down()).mockResolvedValueOnce(up());

    const out = await callService({ name: "staging-api" });

    expect(out).toMatchObject({
      ok: true,
      already_up: true,
      reconciled_after_register: true,
      event: "service:up:staging-api",
    });
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: "su-awaiter" });
  });

  it("fails open when the current probe is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(probeNamedService).mockRejectedValueOnce(new Error("health probe unavailable"));

    const out = await callService({ name: "staging-api" });

    expect(out.events).toEqual(["service:up:staging-api"]);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
