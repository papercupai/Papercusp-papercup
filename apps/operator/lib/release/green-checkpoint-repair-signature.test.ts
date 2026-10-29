import { describe, expect, it } from "vitest";

import {
  NON_TEST_GATE_SCRIPTS,
  describeRepairHeadRunnerFailure,
  parseRepairHeadRadius,
  partitionRepairSignatureEntries,
  makeTestWorkspaceResolver,
  repairSignatureFromVerdict,
  verifyRepairHead,
  validateTargetedFileOutcomes,
  type FailingFile,
  type RepairHeadVerificationDeps,
  type TargetedFileResult,
  type TargetedGateResult,
} from "./green-checkpoint";
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  frozenRepairRoundExecution,
  markFrozenRepairVerificationRed,
  selectFrozenRepairAdmissionPaths,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
  type RepairSignatureEntry,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

/**
 * P-006 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-004) — the GATE side of
 * the typed repair signature.
 *
 * The queue module proves the signature is CLASSIFIED and PERSISTED correctly
 * (`frozen-repair-signature.test.ts`). These tests prove the gate CONSUMES it the way P-006
 * promised: every entry's `kind` picks the runner that re-measures it (nothing re-guesses a
 * kind from the id's shape), a kind no runner can re-measure forces the full gate at the
 * repair head instead of being silently dropped, every runner is handed `queue.repairHead`
 * and never the frozen candidate, and a verdict reports WHICH kinds it measured so the queue
 * extends rather than replaces the signature (a suite-only run must not erase a lint red).
 */

const CANDIDATE = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const CORE = "@papercusp/operator-core";
const WEB = "@papercusp/web";

function entry(
  partial: Pick<RepairSignatureEntry, "kind" | "id"> & Partial<RepairSignatureEntry>,
): RepairSignatureEntry {
  return {
    recipe: `npm run ${partial.id}`,
    admittedRound: 1,
    measuredHead: HEAD,
    ...partial,
  };
}

function queueWith(
  signature: RepairSignatureEntry[],
  extra: Partial<FrozenCandidateRepairQueue> = {},
): FrozenCandidateRepairQueue {
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: "ready-to-verify",
    candidate: CANDIDATE,
    base: BASE,
    repairHead: HEAD,
    attempts: 1,
    openedAtMs: 1,
    updatedAtMs: 2,
    fixerSpawnId: "fixer-1",
    failingTests: signature.map((e) => e.id),
    signature,
    ...extra,
  };
}

/** Deps that record every ref they are handed, so "never the candidate" is asserted, not assumed. */
function recordingDeps(opts: {
  filesPass?: boolean;
  gatesPass?: boolean;
  radius?: { files: FailingFile[]; gateIds: string[]; summary: string } | null;
  withRadius?: boolean;
} = {}) {
  const refs: string[] = [];
  const fileRuns: FailingFile[][] = [];
  const gateRuns: string[][] = [];
  const radiusCalls: string[][] = [];
  const deps: RepairHeadVerificationDeps = {
    runTestsAtRef: async (ref, files) => {
      refs.push(ref);
      fileRuns.push(files);
      return { pass: opts.filesPass ?? true, summary: `${files.length} file(s) ${opts.filesPass === false ? "failed" : "passed"}` };
    },
    runGateAtRef: async (ref, gateIds) => {
      refs.push(ref);
      gateRuns.push(gateIds);
      return { pass: opts.gatesPass ?? true, summary: `${gateIds.length} gate(s) ${opts.gatesPass === false ? "failed" : "passed"}` };
    },
    ...(opts.withRadius
      ? {
          affectedTestsAtRef: async (ref: string, paths: string[]) => {
            refs.push(ref);
            radiusCalls.push(paths);
            return opts.radius ?? null;
          },
        }
      : {}),
  };
  return { deps, refs, fileRuns, gateRuns, radiusCalls };
}

describe("P-003/P-006 partitionRepairSignatureEntries — the kind picks a bounded runner", () => {
  it("routes test-file → files, re-runnable workspace-task/lint-leg/seed → gates, and the rest → full run", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
      // The workspace's own `test` task is covered by its file re-run — not a gate.
      entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
      entry({ kind: "workspace-task", id: `${WEB} :: lint:styles`, workspace: WEB }),
      entry({ kind: "lint-leg", id: "lint:tsc" }),
      entry({ kind: "seed", id: `${WEB} :: seed:demo:check`, workspace: WEB }),
      // A seed id that is neither registered nor a `<ws> :: seed:*:check` task: nothing re-runs it.
      entry({ kind: "seed", id: "seed:demo" }),
      // A post-suite leg is full-gate-only by construction, whatever its id looks like.
      entry({ kind: "post-suite-leg", id: "@papercusp/operator-vite" }),
      // A bare workspace marker with no paired file has no selective runner either.
      entry({ kind: "workspace-task", id: "@papercusp/sync", workspace: "@papercusp/sync" }),
    ]);
    expect(out.files).toEqual([{ workspace: CORE, file: "lib/a.test.ts" }]);
    expect(out.gateIds).toEqual([
      `${WEB} :: lint:styles`,
      "lint:tsc",
      `${WEB} :: seed:demo:check`,
      "seed:demo",
      "@papercusp/sync :: test",
    ]);
    expect(out.fullRun).toEqual(["@papercusp/operator-vite"]);
    expect(out.unavailable).toEqual([]);
  });

  it("pairs a workspace-less test-file (a derived pre-schema-4 row) with the ONE bare workspace beside it", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
    ]);
    expect(out.files).toEqual([{ workspace: WEB, file: "lib/a.test.ts" }]);
    expect(out.gateIds).toEqual([]);
    expect(out.fullRun).toEqual([]);
    expect(out.unavailable).toEqual([]);
  });

  it("an unpairable workspace-less test-file (two candidate workspaces) forces the full run, never a guess", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
      entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
    ]);
    expect(out.files).toEqual([]);
    expect(out.gateIds).toEqual([`${WEB} :: test`, `${CORE} :: test`]);
    expect(out.fullRun).toEqual([]);
    expect(out.unavailable).toEqual(["lib/a.test.ts"]);
  });

  it("WI-10000288: workspace-less test-files beside SEVERAL bare workspaces are paired by the disk resolver, never held as unroutable", () => {
    const DESKTOP = "@papercusp/desktop";
    const UI = "@papercusp/operator-ui";
    const resolver = makeTestWorkspaceResolver("/repo", {
      dirs: ["apps/operator", "packages/operator-core", "packages/operator-ui", "papercusp-desktop"],
      exists: (p) =>
        [
          "/repo/apps/operator/app/_components/chat/SessionChatModal.test.tsx",
          "/repo/packages/operator-core/lib/desktop-install/__tests__/papercusp-files.test.ts",
          "/repo/packages/operator-ui/src/papercup-chat/parity-matrix.test.ts",
          "/repo/papercusp-desktop/test/verify-tauri-headless-assertion-integrity.test.js",
        ].includes(p),
      readFile: (p) =>
        JSON.stringify({
          name: p.includes("apps/operator/")
            ? WEB
            : p.includes("operator-core/")
              ? CORE
              : p.includes("operator-ui/")
                ? UI
                : DESKTOP,
        }),
    });
    const out = partitionRepairSignatureEntries(
      [
        entry({ kind: "workspace-task", id: DESKTOP, workspace: DESKTOP }),
        entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
        entry({ kind: "workspace-task", id: UI, workspace: UI }),
        entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
        entry({ kind: "test-file", id: "app/_components/chat/SessionChatModal.test.tsx" }),
        entry({ kind: "test-file", id: "lib/desktop-install/__tests__/papercusp-files.test.ts" }),
        entry({ kind: "test-file", id: "src/papercup-chat/parity-matrix.test.ts" }),
        entry({ kind: "test-file", id: "test/verify-tauri-headless-assertion-integrity.test.js" }),
      ],
      resolver,
    );
    expect(out.unavailable).toEqual([]);
    expect(out.files).toEqual([
      { workspace: WEB, file: "app/_components/chat/SessionChatModal.test.tsx" },
      { workspace: CORE, file: "lib/desktop-install/__tests__/papercusp-files.test.ts" },
      { workspace: UI, file: "src/papercup-chat/parity-matrix.test.ts" },
      { workspace: DESKTOP, file: "test/verify-tauri-headless-assertion-integrity.test.js" },
    ]);
    // Each workspace's bare `test` task is covered by its own file's re-run.
    expect(out.gateIds).toEqual([]);
    expect(out.fullRun).toEqual([]);
  });

  it("the disk resolver answers null — and the entry stays unroutable — when zero or several workspace dirs contain the file", () => {
    const resolver = makeTestWorkspaceResolver("/repo", {
      dirs: ["apps/operator", "packages/operator-core"],
      exists: (p) => p.endsWith("/lib/shared.test.ts"),
      readFile: () => JSON.stringify({ name: WEB }),
    });
    expect(resolver("lib/shared.test.ts")).toBeNull();
    expect(resolver("lib/nowhere.test.ts")).toBeNull();
    expect(resolver("../escape.test.ts")).toBeNull();
    const out = partitionRepairSignatureEntries(
      [
        entry({ kind: "test-file", id: "lib/shared.test.ts" }),
        entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
        entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
      ],
      resolver,
    );
    expect(out.files).toEqual([]);
    expect(out.unavailable).toEqual(["lib/shared.test.ts"]);
  });
});

describe("P-006 repairSignatureFromVerdict — a verdict names WHICH kinds it measured", () => {
  it("a suite-only verdict (post-suite skipped) measures no lint kind, so a prior lint red survives the extend", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lib/a.test.ts", CORE],
      postSuiteMeasured: false,
    });
    expect(out.failingTests).toEqual(["lib/a.test.ts", CORE]);
    expect(out.measuredKinds).toEqual(["test-file", "workspace-task", "seed"]);
    expect(out.measuredKinds).not.toContain("lint-leg");
    expect(out.measuredKinds).not.toContain("post-suite-leg");
    expect(out.signatureContext.gateRegistry).toBe(NON_TEST_GATE_SCRIPTS);
    expect(out.signatureContext.postSuiteLegIds).toEqual([]);
  });

  it("a verdict whose post-suite phase RAN measures the lint kinds and unions every red leg into the signature", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lib/a.test.ts", "lint:plane-integrity"],
      postSuiteMeasured: true,
      postSuiteLegs: [
        { id: "lint:plane-integrity", status: "failed" },
        { id: "lint:identity-leak", status: "failed" },
        { id: "lint:tsc", status: "passed" },
      ],
    });
    // Deduplicated on id: the leg the suite already named is not doubled.
    expect(out.failingTests).toEqual(["lib/a.test.ts", "lint:plane-integrity", "lint:identity-leak"]);
    expect(out.measuredKinds).toEqual(["test-file", "workspace-task", "seed", "lint-leg", "post-suite-leg"]);
    expect(out.signatureContext.postSuiteLegIds).toEqual(["lint:plane-integrity", "lint:identity-leak"]);
  });

  it("a failed typecheck preflight measured only the ids it names — no kind at all — so nothing prior is erased", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lint:tsc"],
      typecheckPreflight: { status: "failed" },
      postSuiteMeasured: false,
    });
    expect(out.failingTests).toEqual(["lint:tsc"]);
    expect(out.measuredKinds).toEqual([]);
  });

  it("P-017: the verdict carries failed cases per file and error keys per red leg onto the queue's entries", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["apps/operator/lib/a.test.ts"],
      postSuiteMeasured: true,
      postSuiteLegs: [
        { id: "lint:tsc", status: "failed", errorKeys: ["lib/x.ts|TS2322", "lib/x.ts|TS2322#2"] },
        { id: "lint:identity-leak", status: "failed" },
        { id: "lint:plane-integrity", status: "passed", errorKeys: ["ignored|TS1"] },
      ],
      // Runner output names the file workspace-relative; the signature holds it repo-relative.
      failingCasesByFile: new Map([["lib/a.test.ts", ["case one", "case two"]]]),
    });
    expect(out.casesByFile).toEqual({ "lib/a.test.ts": ["case one", "case two"] });
    // Only a RED leg contributes keys; a red leg with no parsed errors stays keyed on its id.
    expect(out.legErrors).toEqual({ "lint:tsc": ["lib/x.ts|TS2322", "lib/x.ts|TS2322#2"] });
    // Plain objects, so the detail survives the queue's JSON persistence.
    expect(JSON.parse(JSON.stringify(out.casesByFile))).toEqual(out.casesByFile);

    const queue = queueWith([
      entry({ kind: "test-file", id: "apps/operator/lib/a.test.ts", cases: ["case one"] }),
      entry({ kind: "lint-leg", id: "lint:tsc", errors: ["lib/x.ts|TS2322"] }),
    ]);
    const next = markFrozenRepairVerificationRed(queue, { repairHead: HEAD, nowMs: 3, ...out });
    const byId = new Map(next.signature.map((e) => [e.id, e]));
    expect(byId.get("apps/operator/lib/a.test.ts")?.cases).toEqual(["case one", "case two"]);
    expect(byId.get("lint:tsc")?.errors).toEqual(["lib/x.ts|TS2322", "lib/x.ts|TS2322#2"]);
  });

  it("P-017: a measured verdict with no detail says so; an unmeasured one carries neither field", () => {
    const measured = repairSignatureFromVerdict({
      failingTests: ["lib/a.test.ts"],
      postSuiteMeasured: true,
      postSuiteLegs: [{ id: "lint:tsc", status: "failed" }],
      failingCasesByFile: new Map(),
    });
    expect(measured.casesByFile).toEqual({});
    expect(measured.legErrors).toEqual({});

    const unmeasured = repairSignatureFromVerdict({
      failingTests: ["lint:tsc"],
      typecheckPreflight: { status: "failed" },
      postSuiteMeasured: false,
      failingCasesByFile: new Map([["lib/a.test.ts", ["case"]]]),
    });
    expect(unmeasured).not.toHaveProperty("casesByFile");
    expect(unmeasured).not.toHaveProperty("legErrors");
  });

  it("P-017: a round that did not measure cases keeps the last measured ones — no phantom crash", () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", cases: ["case one"] }),
      entry({ kind: "lint-leg", id: "lint:tsc", errors: ["lib/x.ts|TS2322"] }),
    ]);
    // A targeted repair-head re-run: typed entries, no case / error measurement.
    const carried = markFrozenRepairVerificationRed(queue, {
      repairHead: HEAD, nowMs: 3, failingTests: ["lib/a.test.ts", "lint:tsc"],
      signature: [
        { kind: "test-file", id: "lib/a.test.ts", recipe: "npm run test:file -- lib/a.test.ts" },
        { kind: "lint-leg", id: "lint:tsc", recipe: "npm run lint:tsc" },
      ],
    });
    const byId = new Map(carried.signature.map((e) => [e.id, e]));
    expect(byId.get("lib/a.test.ts")?.cases).toEqual(["case one"]);
    expect(byId.get("lint:tsc")?.errors).toEqual(["lib/x.ts|TS2322"]);

    // A measured round that names no case for the file: the detail is gone (a crash shape).
    const crashed = markFrozenRepairVerificationRed(queue, {
      repairHead: HEAD, nowMs: 4, failingTests: ["lib/a.test.ts"], casesByFile: {},
    });
    expect(crashed.signature.find((e) => e.id === "lib/a.test.ts")?.cases).toBeUndefined();
  });
});

describe("P-006 verifyRepairHead — the typed signature drives the runners, at the repair head only", () => {
  it("selects the measured signature despite stale failing lifecycle legs and flat names (P-008)", async () => {
    const staleId = `${CORE} :: test:lane-stateful`;
    const remainingId = `${WEB} :: test`;
    const queue = queueWith([
      entry({ kind: "workspace-task", id: remainingId, workspace: WEB }),
      entry({ kind: "lint-leg", id: "lint:tsc" }),
    ], {
      failingTests: [staleId, remainingId],
      legs: [{
        id: staleId, state: "failing", admittedRound: 1,
        admittedHead: CANDIDATE, admittedAtMs: 1,
        lastMeasuredHead: CANDIDATE, lastMeasuredAtMs: 1,
        lastMeasuredRound: 1, failingRounds: 1,
      }],
    });
    const { deps, gateRuns, fileRuns, refs } = recordingDeps();

    await verifyRepairHead(deps, queue);

    expect(gateRuns).toEqual([[remainingId, "lint:tsc"]]);
    expect(fileRuns).toEqual([]);
    expect(refs).toEqual([HEAD]);
  });

  it.each([
    { selected: 2, workspaces: 1, files: 2, rows: ["lib/a.test.ts"] },
    { selected: 1, workspaces: 2, files: 1, rows: ["lib/a.test.ts"] },
    { selected: 1, workspaces: 1, files: 2, rows: ["lib/a.test.ts"] },
    { selected: 2, workspaces: 1, files: 2, rows: ["lib/a.test.ts", "lib/a.test.ts"] },
  ])("rejects truncated/inconsistent selector counts: $selected/$workspaces/$files", (fixture) => {
    const output = [
      `RELATED_SELECTION ws=${WEB} selected=${fixture.selected} total=5 mode=related reason=ok`,
      `AFFECTED_WS_CMD\t${WEB}\tnpm run --workspace packages/web test`,
      `RELATED_AFFECTED_FILES status=selected workspaces=${fixture.workspaces} files=${fixture.files}`,
      ...fixture.rows.map((file) => `RELATED_AFFECTED_FILE\t${WEB}\t${file}`),
    ].join("\n");
    expect(parseRepairHeadRadius(output)).toBeNull();
  });

  it("cannot mint a complete receipt from a cumulative radius whose initial admission history is missing", async () => {
    const queue = queueWith([entry({ kind: "lint-leg", id: "lint:remaining" })], {
      admissions: [{
        atMs: 2, actor: "test", source: { ref: "staging", sha: HEAD },
        fromRepairHead: "d".repeat(40), toRepairHead: HEAD,
        paths: ["lib/only-retained.ts"], unchanged: [], blobs: { "lib/only-retained.ts": "e".repeat(40) },
      }],
    });
    const deps: RepairHeadVerificationDeps = {
      affectedTestsAtRef: async () => ({ files: [], gateIds: [], summary: "retained radius" }),
      runGateAtRef: async (head, ids) => ({
        pass: false, summary: "remaining failure", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "fail" as const })),
      }),
    };
    const result = await verifyRepairHead(deps, queue);
    expect(result.kind).toBe("red");
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("carries complete coverage across ordinary repair rounds and selects only the new admission radius", async () => {
    const nextHead = "d".repeat(40);
    const firstAdmission: FrozenRepairAdmission = {
      atMs: 2, actor: "test", source: { ref: "staging", sha: HEAD },
      fromRepairHead: CANDIDATE, toRepairHead: HEAD,
      paths: ["lib/first.ts"], unchanged: [], blobs: { "lib/first.ts": "e".repeat(40) },
    };
    const initial = queueWith([entry({ kind: "lint-leg", id: "lint:remaining" })], { admissions: [firstAdmission] });
    const selected: string[][] = [];
    const executed: string[][] = [];
    const deps: RepairHeadVerificationDeps = {
      affectedTestsAtRef: async (_head, paths) => {
        selected.push(paths);
        return {
          files: paths.map((p) => ({ workspace: CORE, file: p.replace(".ts", ".test.ts") })),
          gateIds: [], summary: "exact radius", coverageComplete: true,
        };
      },
      runTestsAtRef: async (head, files) => {
        executed.push(files.map((f) => f.file));
        return {
          pass: true, summary: "all groups passed", measuredHead: head, coverageComplete: true,
          perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "pass" }],
        };
      },
      runGateAtRef: async (head, ids) => ({
        pass: false, summary: "remaining lint failed", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "fail" as const })),
      }),
    };
    const first = await verifyRepairHead(deps, initial);
    if (first.kind !== "red") throw new Error("expected first red");
    expect(first.selectiveCoverage).toEqual({ schemaVersion: 1, candidate: CANDIDATE, head: HEAD });
    const measured = markFrozenRepairVerificationRed(initial, {
      repairHead: HEAD, nowMs: 3, failingTests: first.failingTests,
      signature: first.signature, selectiveCoverage: first.selectiveCoverage,
    });
    const next: FrozenCandidateRepairQueue = {
      ...measured, phase: "ready-to-verify", repairHead: nextHead,
      admissions: [firstAdmission, {
        ...firstAdmission, fromRepairHead: HEAD, toRepairHead: nextHead,
        paths: ["lib/second.ts"], blobs: { "lib/second.ts": "f".repeat(40) },
      }],
    };
    const second = await verifyRepairHead(deps, next);
    expect(second).toMatchObject({ kind: "red", failingTests: ["lint:remaining"] });
    expect(second.summary).toContain("REPAIR_RADIUS mode=delta");
    expect(selected).toEqual([["lib/first.ts"], ["lib/second.ts"]]);
    expect(executed).toEqual([["lib/first.test.ts"], ["lib/second.test.ts"]]);
  });

  it("retains a failed coexecution group even when every diagnostic file passes alone", async () => {
    const files = [{ workspace: CORE, file: "lib/a.test.ts" }, { workspace: WEB, file: "lib/b.test.ts" }];
    const queue = queueWith(files.flatMap((f) => [
      entry({ kind: "test-file", id: f.file, workspace: f.workspace }),
      entry({ kind: "workspace-task", id: f.workspace, workspace: f.workspace }),
    ]));
    const deps: RepairHeadVerificationDeps = {
      runTestsAtRef: async () => ({
        pass: false, summary: "core group fails, web passes", measuredHead: HEAD, coverageComplete: true,
        perFile: files.map((f) => ({ ...f, pass: true })),
        perWorkspace: [
          { workspace: CORE, files: [files[0]!.file], status: "fail" },
          { workspace: WEB, files: [files[1]!.file], status: "pass" },
        ],
      }),
    };
    const result = await verifyRepairHead(deps, queue);
    expect(result).toMatchObject({
      kind: "red", failingTests: ["lib/a.test.ts", CORE],
    });
    // Legacy head with no admission chain cannot establish whole prior-radius coverage.
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("retains every legacy coexecution member when diagnostics mix individual passes and failures", async () => {
    const files = [{ workspace: WEB, file: "lib/a.test.ts" }, { workspace: WEB, file: "lib/b.test.ts" }];
    const queue = queueWith([
      ...files.map((f) => entry({ kind: "test-file", id: f.file, workspace: WEB })),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
    ]);
    const result = await verifyRepairHead({
      runTestsAtRef: async () => ({
        pass: false, summary: "group failed; b passes alone",
        perFile: [{ ...files[0]!, pass: false }, { ...files[1]!, pass: true }],
      }),
    }, queue);
    expect(result).toMatchObject({ kind: "red", failingTests: ["lib/a.test.ts", WEB, "lib/b.test.ts"] });
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("does not mint coverage from a legacy aggregate or an errored group", async () => {
    const queue = queueWith([entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE })]);
    const { deps } = recordingDeps({ filesPass: false });
    expect(await verifyRepairHead(deps, queue)).not.toHaveProperty("selectiveCoverage");
    deps.runTestsAtRef = async () => ({
      pass: false, summary: "spawn failed", measuredHead: HEAD, coverageComplete: true,
      perWorkspace: [{ workspace: CORE, files: ["lib/a.test.ts"], status: "errored" }],
    });
    const result = await verifyRepairHead(deps, queue);
    expect(result.kind).toBe("red");
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("requires exact file population and head before using a group result", () => {
    const files = [{ workspace: CORE, file: "lib/a.test.ts" }];
    const result = {
      pass: true, summary: "pass", measuredHead: HEAD,
      perWorkspace: [{ workspace: CORE, files: ["lib/a.test.ts"], status: "pass" as const }],
    };
    expect(validateTargetedFileOutcomes(result, files, HEAD)).toEqual(result.perWorkspace);
    expect(validateTargetedFileOutcomes({ ...result, measuredHead: CANDIDATE }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [] }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [...result.perWorkspace, ...result.perWorkspace] }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [{ workspace: WEB, files: ["lib/a.test.ts"], status: "pass" }] }, files, HEAD)).toBeNull();
  });

  it("retains only the actual failing gate after a complete per-task measurement", async () => {
    const queue = queueWith([
      entry({ kind: "lint-leg", id: "lint:good" }),
      entry({ kind: "lint-leg", id: "lint:bad" }),
      entry({ kind: "lint-leg", id: "lint:later" }),
    ]);
    const { deps } = recordingDeps();
    deps.runGateAtRef = async () => ({
      pass: false,
      summary: "good and later passed; bad failed",
      measuredHead: HEAD,
      perGate: [
        { id: "lint:good", status: "pass" },
        { id: "lint:bad", status: "fail" },
        { id: "lint:later", status: "pass" },
      ],
    });
    const verdict = await verifyRepairHead(deps, queue);
    expect(verdict).toMatchObject({ kind: "red", failingTests: ["lint:bad"] });
  });

  it("holds on a foreign or incomplete gate population, even with aggregate pass", async () => {
    const queue = queueWith([entry({ kind: "lint-leg", id: "lint:required" })]);
    const { deps } = recordingDeps();
    deps.runGateAtRef = async () => ({
      pass: true,
      summary: "wrong task passed",
      measuredHead: HEAD,
      perGate: [{ id: "lint:foreign", status: "pass" }],
    });
    expect(await verifyRepairHead(deps, queue)).toMatchObject({ kind: "unavailable" });
  });

  it("a typed red re-emits files as test-file + workspace-task and a gate from the entry it was re-run from", async () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE, recipe: "npm run test:file -- lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: CORE, workspace: CORE, recipe: `npm run test -w ${CORE}` }),
      // A registry recipe wider than the bare `npm run lint:tsc` — the re-queue must carry it
      // forward from the prior entry rather than re-classify the id.
      entry({ kind: "lint-leg", id: "lint:tsc", recipe: "npm run lint:tsc && npm run lint:tsc:scripts" }),
    ]);
    const { deps, refs, fileRuns, gateRuns } = recordingDeps({ filesPass: false, gatesPass: false });

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("red");
    if (verdict.kind !== "red") throw new Error("unreachable");
    expect(verdict.signature).toEqual([
      { kind: "test-file", id: "lib/a.test.ts", recipe: "npm run test:file -- lib/a.test.ts", workspace: CORE },
      { kind: "workspace-task", id: CORE, recipe: `npm run test -w ${CORE}`, workspace: CORE },
      { kind: "lint-leg", id: "lint:tsc", recipe: "npm run lint:tsc && npm run lint:tsc:scripts" },
    ]);
    expect(verdict.failingTests).toEqual(verdict.signature.map((e) => e.id));
    expect(fileRuns).toEqual([[{ workspace: CORE, file: "lib/a.test.ts" }]]);
    expect(gateRuns).toEqual([["lint:tsc"]]);
    // D-004: every runner call is AT the repair head; the frozen candidate is never handed out.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => ref === HEAD)).toBe(true);
    expect(refs).not.toContain(CANDIDATE);
  });

  it("routes a target without platform selective tooling to its configured full suite", async () => {
    const queue = queueWith([entry({ kind: "test-file", id: "tests/host-smoke.test.ts" })]);
    let selectiveCalls = 0;
    const verdict = await verifyRepairHead({
      selectiveRepairSupported: false,
      runTestsAtRef: async () => { selectiveCalls++; throw new Error("foreign target has no platform runner"); },
    }, queue);
    expect(verdict.kind).toBe("full-run-required");
    expect(verdict.summary).toContain(queue.repairHead.slice(0, 8));
    expect(selectiveCalls).toBe(0);
    expect((await verifyRepairHead({}, queue)).kind).toBe("unavailable");
  });

  it("requires the exact full gate for fork inheritance instead of returning raw selective reds", async () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
      entry({ kind: "lint-leg", id: "lint:tsc" }),
    ]);
    const { deps, refs } = recordingDeps({ filesPass: false, gatesPass: false });

    const fork = await verifyRepairHead({ ...deps, forkInheritanceRequired: true }, queue);
    expect(fork).toMatchObject({ kind: "full-run-required" });
    expect(fork.summary).toContain(HEAD.slice(0, 8));
    expect(fork.summary).toContain("measured upstream/base inheritance");
    expect(refs).toEqual([]);

    // The same red evidence must still block a direct-mode repair.
    const direct = await verifyRepairHead({ ...deps, forkInheritanceRequired: false }, queue);
    expect(direct.kind).toBe("red");
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => ref === HEAD)).toBe(true);
  });

  it("a post-suite-leg entry is full-run-required — named in the summary, with no runner spent", async () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
      entry({ kind: "post-suite-leg", id: "@papercusp/operator-vite" }),
    ]);
    const { deps, refs } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("full-run-required");
    expect(verdict.summary).toContain("@papercusp/operator-vite");
    expect(verdict.summary).toContain(HEAD.slice(0, 8));
    expect(refs).toEqual([]);
  });

  it("a typed root seed entry runs its named bounded script — it does not spend the full gate", async () => {
    const queue = queueWith([entry({ kind: "seed", id: "seed:demo" })]);
    const { deps, refs, gateRuns } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("green");
    expect(gateRuns).toEqual([["seed:demo"]]);
    expect(refs).toEqual([HEAD]);
  });

  // WI-10004340: repairHead 0d8ad5e3 stayed red on `<ws> :: lint:migration-forward-compat`
  // because this runner judged sidecar reviewBy by the wall clock, not the queue's freeze.
  it("hands the gate runner the queue's freeze time as its review clock", async () => {
    const id = "@papercusp/operator-core :: lint:migration-forward-compat";
    const queue = queueWith([entry({ kind: "workspace-task", id })], { openedAtMs: 1_790_851_192_720 });
    const clocks: Array<number | undefined> = [];
    const deps: RepairHeadVerificationDeps = {
      runGateAtRef: async (head, ids, opts) => {
        clocks.push(opts?.frozenCandidateOpenedAtMs);
        return { pass: true, summary: "ok", measuredHead: head, coverageComplete: true,
          perGate: ids.map((gate) => ({ id: gate, status: "pass" as const })) };
      },
    };

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("green");
    expect(clocks).toEqual([1_790_851_192_720]);
  });

  it("a row handed in without a typed signature is classified from its flat list, the way the parser types a persisted one", async () => {
    const queue = queueWith([], { failingTests: ["lib/a.test.ts", WEB] });
    const { deps, refs, fileRuns, gateRuns } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("green");
    expect(fileRuns).toEqual([[{ workspace: WEB, file: "lib/a.test.ts" }]]);
    // The bare workspace marker is the file's own `test` task — covered, not a second gate run.
    expect(gateRuns).toEqual([]);
    expect(refs).toEqual([HEAD]);
  });

  it("a runner that fails to EXECUTE is `unavailable` — absence of evidence, never a verdict", async () => {
    const queue = queueWith([entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE })]);
    const deps: RepairHeadVerificationDeps = {
      runTestsAtRef: async () => {
        throw new Error("tree setup failed");
      },
      runGateAtRef: async () => ({ pass: true, summary: "unused" }),
    };

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("unavailable");
    expect(verdict.summary).toContain("file runner failed to execute");
  });

  describe("the admitted paths' radius is measured beside the signature", () => {
    const admission: FrozenRepairAdmission = {
      atMs: 3,
      actor: "su-test",
      source: { ref: "staging", sha: "d".repeat(40) },
      fromRepairHead: CANDIDATE,
      toRepairHead: HEAD,
      paths: ["lib/x.ts"],
      unchanged: [],
      blobs: { "lib/x.ts": "e".repeat(40) },
    };

    it("without a radius resolver the queue holds unavailable — it never spends the full gate", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, refs } = recordingDeps({ withRadius: false });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("unavailable");
      expect(verdict.summary).toContain("1 admitted path(s)");
      expect(verdict.summary).toContain("without spending the full gate");
      expect(refs).toEqual([]);
    });

    it("a resolvable radius is merged into the file and gate runs, all resolved AT the repair head", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, refs, fileRuns, gateRuns, radiusCalls } = recordingDeps({
        withRadius: true,
        radius: {
          files: [{ workspace: CORE, file: "lib/x.test.ts" }],
          gateIds: [`${CORE} :: lint:tsc:orchestrator`],
          summary: "1 file, 1 leg",
        },
      });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("green");
      expect(radiusCalls).toEqual([["lib/x.ts"]]);
      expect(fileRuns).toEqual([[{ workspace: CORE, file: "lib/x.test.ts" }]]);
      expect(gateRuns).toEqual([["lint:tsc", `${CORE} :: lint:tsc:orchestrator`]]);
      expect(refs.every((ref) => ref === HEAD)).toBe(true);
      expect(refs).toHaveLength(3);
    });

    it("a malformed/unavailable radius holds rather than falling through to the full gate", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, fileRuns, gateRuns } = recordingDeps({ withRadius: true, radius: null });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("unavailable");
      expect(verdict.summary).toContain("could not be resolved");
      expect(fileRuns).toEqual([]);
      expect(gateRuns).toEqual([]);
    });

    it("P-003: an over-threshold selector widening runs only the named affected workspace lanes plus signature kinds", async () => {
      const radius = parseRepairHeadRadius([
        "RELATED_SELECTION ws=@papercusp/operator-core selected=40 total=40 mode=full reason=over-threshold widenThreshold=0.95",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-pure",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-stateful",
        "RELATED_AFFECTED_FILES status=full reason=no-complete-exact-file-radius",
      ].join("\n"));
      expect(radius).toEqual({
        files: [],
        coverageComplete: false,
        gateIds: [
          "@papercusp/operator-core :: test:lane-pure",
          "@papercusp/operator-core :: test:lane-stateful",
        ],
        // #D-025: the widened-task count is carried on the radius so the P-018 shadow can refuse
        // a composed proof over a widened (non-exact) radius.
        widenedTasks: 2,
        summary: "0 exact related file(s), 2 widened affected test task(s), 0 guard/task leg(s)",
      });

      const queue = queueWith(
        [entry({ kind: "lint-leg", id: "lint:tsc" })],
        { admissions: [admission] },
      );
      const { deps, refs, fileRuns, gateRuns } = recordingDeps({
        withRadius: true,
        radius,
      });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("green");
      expect(fileRuns).toEqual([]);
      expect(gateRuns).toEqual([[
        "lint:tsc",
        "@papercusp/operator-core :: test:lane-pure",
        "@papercusp/operator-core :: test:lane-stateful",
      ]]);
      expect(refs.every((ref) => ref === HEAD)).toBe(true);
      expect(refs).toHaveLength(2);
    });

    it("keeps an exact related selection on the file runner even with the threshold suffix", () => {
      expect(parseRepairHeadRadius([
        "RELATED_SELECTION ws=@papercusp/operator-core selected=1 total=40 mode=related reason=ok widenThreshold=0.95",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test",
        "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1",
        "RELATED_AFFECTED_FILE\t@papercusp/operator-core\tlib/x.test.ts",
      ].join("\n"))).toEqual({
        files: [{ workspace: "@papercusp/operator-core", file: "lib/x.test.ts" }],
        gateIds: [],
        coverageComplete: false,
        widenedTasks: 0,
        summary: "1 exact related file(s), 0 widened affected test task(s), 0 guard/task leg(s)",
      });
    });
    it("requires a complete producer census before permitting receipt reuse", () => {
      const output = [
        "AFFECTED_DERIVATION source=explicit changedPaths=1 workspaces=1 guards=0 tasks=1",
        `AFFECTED_WS\t${CORE}`,
        `RELATED_SELECTION ws=${CORE} selected=1 total=5 mode=related reason=ok`,
        `AFFECTED_WS_CMD\t${CORE}\tnpm run --workspace packages/operator-core test`,
        "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1",
        `RELATED_AFFECTED_FILE\t${CORE}\tlib/a.test.ts`,
      ].join("\n");
      expect(parseRepairHeadRadius(output)?.coverageComplete).toBe(true);
      expect(parseRepairHeadRadius(output.replace("tasks=1", "tasks=2"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius(output.replace("guards=0", "guards=1"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius(output.replace("workspaces=1 guards", "workspaces=2 guards"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius("")?.coverageComplete).toBe(false);
    });
    // WI-10004928 / D-129 (1): the selector now emits an exact file radius ALONGSIDE attached
    // invariant guards. The consumer must keep the exact files (no widening) and run each guard
    // as its own leg, with the census still binding the guard count.
    it("keeps an exact file radius and runs attached invariant guards as separate legs", () => {
      const output = [
        "AFFECTED_DERIVATION source=explicit changedPaths=1 workspaces=1 guards=1 tasks=1",
        `AFFECTED_WS\t${CORE}`,
        `RELATED_SELECTION ws=${CORE} selected=1 total=5 mode=related reason=ok`,
        `AFFECTED_WS_CMD\t${CORE}\tnpm run --workspace packages/operator-core test`,
        `AFFECTED_GUARD\t${CORE}\tlint:example-guard\tnpm run --workspace packages/operator-core lint:example-guard`,
        "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1",
        `RELATED_AFFECTED_FILE\t${CORE}\tlib/a.test.ts`,
      ].join("\n");
      const radius = parseRepairHeadRadius(output);
      expect(radius).not.toBeNull();
      expect(radius!.files).toEqual([{ workspace: CORE, file: "lib/a.test.ts" }]);
      expect(radius!.gateIds).toEqual([`${CORE} :: lint:example-guard`]);
      expect(radius!.coverageComplete).toBe(true);
      expect(radius!.summary).toBe(
        "1 exact related file(s), 0 widened affected test task(s), 1 guard/task leg(s)",
      );
      // A guard the census does not account for is not complete coverage.
      expect(parseRepairHeadRadius(output.replace("guards=1", "guards=0"))?.coverageComplete).toBe(false);
    });
  });
});

/**
 * WI-10004151: an `unavailable` hold must name WHY nothing was measured. On 2026-09-30 a
 * partial package-lock.json admission left repair head 5955f82b without a dependency
 * generation; the radius resolver threw, `.catch(() => null)` dropped the error, and the queue
 * re-held every tick on "could not be resolved" with no cause and no remedy.
 */
describe("WI-10004151 verifyRepairHead carries a runner's failure into the hold", () => {
  const MISSING_GENERATION =
    "bash setup-release-checkout.sh exited 74: dependency-generation.sh: " +
    "no prewarmed dependency generation for input fingerprint 523c88fb";
  const admittedQueue = () =>
    queueWith([entry({ kind: "lint-leg", id: "lint:remaining" })], {
      admissions: [{
        atMs: 2, actor: "test", source: { ref: "staging", sha: HEAD },
        fromRepairHead: CANDIDATE, toRepairHead: HEAD,
        paths: ["package-lock.json"], unchanged: [], blobs: { "package-lock.json": "e".repeat(40) },
      }],
    });

  it("names the missing dependency generation, its fingerprint and its remedy when the radius resolver throws", async () => {
    let gateRuns = 0;
    const result = await verifyRepairHead({
      affectedTestsAtRef: async () => { throw new Error(MISSING_GENERATION); },
      runGateAtRef: async (head, ids) => {
        gateRuns += 1;
        return { pass: true, summary: "ok", measuredHead: head, perGate: ids.map((id) => ({ id, status: "pass" as const })) };
      },
    }, admittedQueue());
    expect(result.kind).toBe("unavailable");
    expect(result.summary).toContain("could not be resolved at repair head cccccccc");
    expect(result.summary).toContain("fingerprint 523c88fb");
    expect(result.summary).toContain("does not clear on its own");
    expect(result.summary).toContain("--ensure-ref");
    expect(gateRuns).toBe(0);
  });

  it("carries an ordinary resolver error verbatim, and says 'malformed' only for a null radius", async () => {
    const thrown = await verifyRepairHead({
      affectedTestsAtRef: async () => { throw new Error("affected-tests selector exited 2 at cccccccccccc: boom"); },
      runGateAtRef: async (head) => ({ pass: true, summary: "ok", measuredHead: head }),
    }, admittedQueue());
    expect(thrown.summary).toContain("(affected-tests selector exited 2 at cccccccccccc: boom)");
    const malformed = await verifyRepairHead({
      affectedTestsAtRef: async () => null,
      runGateAtRef: async (head) => ({ pass: true, summary: "ok", measuredHead: head }),
    }, admittedQueue());
    expect(malformed.kind).toBe("unavailable");
    expect(malformed.summary).toContain("(the selector output was malformed or unroutable)");
  });

  it("names the file runner's failure and does not spend the gate runner after it", async () => {
    const files = [{ workspace: CORE, file: "lib/a.test.ts" }];
    const queue = queueWith([
      entry({ kind: "test-file", id: files[0]!.file, workspace: CORE }),
      entry({ kind: "lint-leg", id: "lint:x" }),
    ]);
    let gateRuns = 0;
    const result = await verifyRepairHead({
      runTestsAtRef: async () => { throw new Error("vitest crashed: ENOSPC"); },
      runGateAtRef: async (head) => { gateRuns += 1; return { pass: true, summary: "ok", measuredHead: head }; },
    }, queue);
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.summary).toContain("the file runner failed to execute at repair head cccccccc (vitest crashed: ENOSPC)");
    expect(gateRuns).toBe(0);
  });

  // Regression (2026-09-30, 9b4ff59de8): swapping `.catch(() => null)` for a settle wrapper kept
  // the THROWN arm but dropped the resolved-null arm, so a null gate result fell through to the
  // full gate (green-checkpoint.test.ts EI-23071029479486567 "unavailable" case).
  it("holds on a runner that RESOLVES null exactly as on one that throws — never the full gate", async () => {
    const fileQueue = queueWith([entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE })]);
    const fileNull = await verifyRepairHead({
      runTestsAtRef: async () => null as unknown as TargetedFileResult,
      runGateAtRef: async (head) => ({ pass: true, summary: "unused", measuredHead: head }),
    }, fileQueue);
    expect(fileNull.kind).toBe("unavailable");
    expect(fileNull.summary).toContain("the file runner failed to execute at repair head cccccccc (it returned no result)");

    const gateQueue = queueWith([entry({ kind: "lint-leg", id: "lint:x" })]);
    const gateNull = await verifyRepairHead({
      runGateAtRef: async () => null as unknown as TargetedGateResult,
    }, gateQueue);
    expect(gateNull.kind).toBe("unavailable");
    expect(gateNull.summary).toContain("the gate runner failed to execute at repair head cccccccc (it returned no result)");
  });

  it("bounds a long failure to one line", () => {
    const described = describeRepairHeadRunnerFailure(new Error(`line one\n${"x".repeat(2000)}`));
    expect(described).not.toContain("\n");
    expect(described.length).toBeLessThanOrEqual(601);
    expect(described.endsWith("…")).toBe(true);
    expect(describeRepairHeadRunnerFailure("plain string")).toBe("plain string");
  });

  // Part (3): an exact-ref miss exhausts both live and cached compatible graphs.
  // Preserve the mismatched package and a remedy that leaves the shared tree intact.
  it("carries dependency-generation's exact-ref refusal reason into the hold", () => {
    const raw =
      "[dependency-generation] FATAL: no prewarmed dependency generation for input fingerprint abcd1234; " +
      "exact-ref build refused: ref r dependency inputs are not install-equivalent to the live tree's:\n" +
      '[dependency-generation]   node_modules/pkg: version "1.0.0" (ref) vs "2.0.0" (live)';
    const described = describeRepairHeadRunnerFailure(new Error(raw));
    expect(described).toContain("fingerprint abcd1234");
    expect(described).toContain("live tree or a validated cached generation");
    expect(described).toContain('no compatible installed source was found: node_modules/pkg: version "1.0.0" (ref) vs "2.0.0" (live)');
    expect(described).toContain("Install the head's lockfiles in an isolated source");
    expect(described).not.toContain("\n");
  });
});

describe("WI-10007489 verifyRepairHead stamps the radius it EXECUTED on its verdict", () => {
  const signature = [
    entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
    entry({ kind: "lint-leg", id: "lint:remaining" }),
  ];
  const expectedFor = (queue: FrozenCandidateRepairQueue) =>
    frozenRepairRoundExecution({
      mode: "targeted",
      fileKeys: [`${CORE} :: lib/a.test.ts`],
      gateIds: ["lint:remaining"],
      radiusMode: selectFrozenRepairAdmissionPaths(queue).mode,
    });

  it("a red verdict carries the targeted files + gates it ran, and the queue records them on its round", async () => {
    const queue = queueWith(signature);
    const result = await verifyRepairHead({
      runTestsAtRef: async (head, files) => ({
        pass: false, summary: "a fails", measuredHead: head, coverageComplete: true,
        perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "fail" }],
      }),
      runGateAtRef: async (head, ids) => ({
        pass: true, summary: "lint passes", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "pass" as const })),
      }),
    }, queue);
    expect(result.kind).toBe("red");
    if (result.kind !== "red") throw new Error("unreachable");
    // P-005: this fixture's admission ledger cannot prove a chain from the candidate to HEAD,
    // so the round records no receipt and NAMES that as the reason (and only that reason).
    const withheld = frozenRepairRoundExecution({
      mode: "targeted",
      fileKeys: [`${CORE} :: lib/a.test.ts`],
      gateIds: ["lint:remaining"],
      radiusMode: selectFrozenRepairAdmissionPaths(queue).mode,
      coverageWithheld: ["selection-incomplete"],
    });
    expect(result.executed).toEqual(withheld);
    expect(result.executed).toMatchObject({ ...expectedFor(queue), mode: "targeted", fileCount: 1, gateIds: ["lint:remaining"] });

    // The verdict's record reaches the persisted round unchanged (the wiring the gate does).
    const next = markFrozenRepairVerificationRed(queue, {
      repairHead: HEAD,
      failingTests: result.failingTests,
      signature: result.signature,
      nowMs: 10,
      executed: result.executed,
    });
    expect(next.convergenceRounds?.at(-1)?.executed).toEqual(withheld);
  });

  it("a green verdict carries the same record — a passing targeted round is still not a full-gate run", async () => {
    const queue = queueWith(signature);
    const result = await verifyRepairHead({
      runTestsAtRef: async (head, files) => ({
        pass: true, summary: "a passes", measuredHead: head, coverageComplete: true,
        perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "pass" }],
      }),
      runGateAtRef: async (head, ids) => ({
        pass: true, summary: "lint passes", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "pass" as const })),
      }),
    }, queue);
    expect(result.kind).toBe("green");
    expect(result).toMatchObject({ executed: expectedFor(queue) });
  });

  it("a verdict that ran nothing (full-run-required / unavailable) claims no executed radius", async () => {
    const fullOnly = queueWith([entry({ kind: "post-suite-leg", id: "perf:budget" })]);
    const full = await verifyRepairHead({}, fullOnly);
    expect(full.kind).toBe("full-run-required");
    expect(full).not.toHaveProperty("executed");
  });

  // P-005 (green-main-cycle-time-2026-10-08): a red round that records no receipt forces the
  // next round onto the cumulative radius. The round must say WHICH condition withheld it.
  it("P-005: a receipt is recorded iff the round withholds nothing", async () => {
    const queue = queueWith(signature);
    for (const gateComplete of [true, false]) {
      const result = await verifyRepairHead({
        runTestsAtRef: async (head, files) => ({
          pass: false, summary: "a fails", measuredHead: head, coverageComplete: true,
          perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "fail" }],
        }),
        runGateAtRef: async (head, ids) => ({
          pass: true, summary: "lint passes", measuredHead: head, coverageComplete: gateComplete,
          perGate: ids.map((id) => ({ id, status: "pass" as const })),
        }),
      }, queue);
      if (result.kind !== "red") throw new Error(`expected red, got ${result.kind}`);
      const withheld = result.executed?.coverageWithheld ?? [];
      expect(Boolean(result.selectiveCoverage)).toBe(withheld.length === 0);
      if (!gateComplete) expect(withheld).toContain("gate-run-incomplete");
      else expect(withheld).not.toContain("gate-run-incomplete");
    }
  });

  // P-005 stage 2 (measured on live queue 4a0ab756, rounds 2 and 3): the only withheld reason
  // was `gate-run-incomplete`, and the only non-pass/fail gate was the registered non-gating
  // NOT CHECKED detector. The producer counts it coverage-neutral; the receipt must too, or
  // every round falls back to the cumulative radius.
  it("P-005: a registered NOT CHECKED leg does not withhold the receipt; an errored one does", async () => {
    const queue = queueWith([...signature, entry({ kind: "lint-leg", id: "lint:vimock-export-strands" })]);
    const run = (status: "not-checked" | "errored") => verifyRepairHead({
      runTestsAtRef: async (head, files) => ({
        pass: false, summary: "a fails", measuredHead: head, coverageComplete: true,
        perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "fail" }],
      }),
      runGateAtRef: async (head, ids) => ({
        pass: status === "not-checked", summary: "lint", measuredHead: head,
        coverageComplete: status === "not-checked",
        perGate: ids.map((id) => ({ id, status: id === "lint:vimock-export-strands" ? status : "pass" as const })),
      }),
    }, queue);
    const neutral = await run("not-checked");
    if (neutral.kind !== "red") throw new Error(`expected red, got ${neutral.kind}`);
    expect(neutral.executed?.coverageWithheld ?? []).not.toContain("gate-run-incomplete");
    const errored = await run("errored");
    expect(errored.kind === "red" ? errored.executed?.coverageWithheld : errored.kind)
      .not.toEqual(neutral.executed?.coverageWithheld ?? []);
    if (errored.kind === "red") expect(errored.executed?.coverageWithheld).toContain("gate-run-incomplete");
  });

  it("P-005: the withheld reasons reach the persisted round", async () => {
    const queue = queueWith(signature);
    const result = await verifyRepairHead({
      runTestsAtRef: async (head, files) => ({
        pass: false, summary: "a fails", measuredHead: head, coverageComplete: false,
        perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "fail" }],
      }),
      runGateAtRef: async (head, ids) => ({
        pass: true, summary: "lint passes", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "pass" as const })),
      }),
    }, queue);
    if (result.kind !== "red") throw new Error(`expected red, got ${result.kind}`);
    expect(result.executed?.coverageWithheld).toContain("file-run-incomplete");
    const next = markFrozenRepairVerificationRed(queue, {
      repairHead: HEAD,
      failingTests: result.failingTests,
      signature: result.signature,
      nowMs: 10,
      executed: result.executed,
    });
    expect(next.convergenceRounds?.at(-1)?.executed?.coverageWithheld).toEqual(result.executed?.coverageWithheld);
  });
});
