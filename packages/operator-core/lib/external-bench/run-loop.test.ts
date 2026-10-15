/**
 * BRIEF 2 / P-019 (impartial-benchmark-suite-2026-06-15): the `external-bench` blueprint +
 * the `instantiateBenchHarness` port.
 *
 * Pins (1) the MATCHED CAUSAL-ISOLATION PAIR — `external-bench` (extends `coding`, full spine,
 * spine ON) vs `coding-solo` (single worker, spine OFF) — both load + validate, share the
 * identical-infra controls (harnessKind, workItem kind), and differ ONLY in the spine; and
 * (2) the `instantiateBenchHarness` port — type-conformant to the shared contract, never throws
 * on a generation failure (returns infra-error telemetry), passes the request through to a bound
 * driver, and refuses cleanly until the live driver is bound (the pilot, P-009).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import {
  instantiateBenchHarness,
  setBenchHarnessDriver,
  FULL_SPINE_BLUEPRINT,
  SINGLE_WORKER_BLUEPRINT,
  type BenchHarnessDriver,
} from './run-loop';
import type { BenchTask, GenerationBudget, InstantiateBenchHarness, TaskCheckout } from './types';

afterEach(() => setBenchHarnessDriver(null));

// ── fixtures ─────────────────────────────────────────────────────────────────
const TASK: BenchTask = {
  benchmark: 'swe-bench-pro',
  instanceId: 'instance_astropy__astropy-12345',
  problemStatement: 'Fix the units regression in astropy.units.',
  repo: 'astropy/astropy',
  baseCommit: 'abc123',
  graderMeta: { dockerhub_tag: 'astropy-12345', FAIL_TO_PASS: ['t1'], PASS_TO_PASS: ['t2'] },
};
const BUDGET: GenerationBudget = { maxTokens: 1_000_000, maxUsd: 25 };
function fakeCheckout(over: Partial<TaskCheckout> = {}): TaskCheckout {
  return { dir: '/scratch/astropy-12345', repo: 'astropy/astropy', baseCommit: 'abc123', cleanup: async () => {}, ...over };
}

// ── the blueprint + the matched causal-isolation pair ────────────────────────

test('external-bench loads + validates as the FULL coding spine (extends coding, spine ON)', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('external-bench');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  // Decider-edges (NOT program-steps): it IS the coding spine, instantiated as a harness.
  assert.ok(blueprint.spine.edges && Object.keys(blueprint.spine.edges).length > 0);
  assert.ok(!blueprint.spine.steps || blueprint.spine.steps.length === 0);
  // The full multi-agent spine verbs are present (inherited from coding) — the treatment.
  for (const verb of ['DONE', 'NEXT_WORKER', 'NEXT_VALIDATOR', 'NEXT_ARCHITECT', 'NEXT_SCOPER']) {
    assert.ok(blueprint.spine.edges![verb], `external-bench is missing the coding verb ${verb}`);
  }
  // The full role set (scoper/architect/worker/validator/…) is inherited — multi-agent.
  const roleIds = blueprint.roles.map((r) => r.id);
  for (const role of ['director', 'scoper', 'architect', 'worker', 'validator']) {
    assert.ok(roleIds.includes(role), `external-bench is missing the coding role ${role}`);
  }
  // A benchmark task = one `feature` work_item (inherited).
  assert.equal(blueprint.workItem.kind, 'feature');
});

test('the causal-isolation PAIR: external-bench (spine ON) vs coding-solo (spine OFF) share the identical-infra controls, differ ONLY in the spine', () => {
  const full = loadBuiltinBlueprint('external-bench').blueprint;
  const solo = loadBuiltinBlueprint('coding-solo').blueprint;

  // Identical-infra controls held constant (D-004 fairness): same harness infra class + work unit.
  assert.equal(full.knobs.harnessKind, 'coding');
  assert.equal(solo.knobs.harnessKind, 'coding');
  assert.equal(full.knobs.requiresRepo, true);
  assert.equal(solo.knobs.requiresRepo, true);
  assert.equal(full.workItem.kind, solo.workItem.kind); // both `feature`

  // The ONLY material difference = orchestration. The full arm has the multi-role hand-off verbs;
  // the solo arm collapses to a single worker decider (no NEXT_WORKER/NEXT_VALIDATOR hand-offs).
  assert.equal(full.spine.decider, 'director');
  assert.equal(solo.spine.decider, 'worker');
  assert.ok(full.spine.edges?.NEXT_VALIDATOR, 'full arm should drive a validator (spine ON)');
  assert.ok(!solo.spine.edges?.NEXT_VALIDATOR, 'solo arm must NOT have a validator hand-off (spine OFF)');
  assert.ok(full.roles.length > solo.roles.length, 'full arm has the multi-agent role set; solo has one worker');
});

// ── the instantiateBenchHarness port ─────────────────────────────────────────

test('instantiateBenchHarness conforms to the InstantiateBenchHarness port type + names the matched-pair blueprint ids', () => {
  const port: InstantiateBenchHarness = instantiateBenchHarness; // compile-time conformance
  assert.equal(typeof port, 'function');
  assert.equal(FULL_SPINE_BLUEPRINT, 'su');
  assert.equal(SINGLE_WORKER_BLUEPRINT, 'coding-solo');
});

test('UNBOUND (no live driver) → infra-error telemetry over the checkout, NEVER throws (excluded from accuracy)', async () => {
  const checkout = fakeCheckout();
  const run = await instantiateBenchHarness('external-bench', TASK, checkout, BUDGET);
  assert.equal(run.worktreePath, checkout.dir);
  assert.equal(run.telemetry.stopReason, 'error');
  assert.match(run.telemetry.generationError ?? '', /not bound/i);
  // No model budget was spent — zeroed cost, so the row carries no phantom tokens.
  assert.equal(run.telemetry.tokensIn, 0);
  assert.equal(run.telemetry.tokensOut, 0);
  assert.equal(run.telemetry.costUsd, 0);
});

test('a BOUND driver receives the full request + its telemetry passes through (the shared instantiation infra)', async () => {
  let seen: { blueprintId: string; task: BenchTask } | null = null;
  const driver: BenchHarnessDriver = {
    async spinRunAndCost(req) {
      seen = { blueprintId: req.blueprintId, task: req.task };
      return {
        worktreePath: req.checkout.dir,
        telemetry: {
          tokensIn: 120_000,
          tokensOut: 30_000,
          costUsd: 4.2,
          turns: 18,
          wallClockMs: 240_000,
          trajectoryRef: 'rollout://traj/xbench-1',
          stopReason: 'done',
        },
      };
    },
  };
  setBenchHarnessDriver(driver);

  const checkout = fakeCheckout();
  const run = await instantiateBenchHarness('external-bench', TASK, checkout, BUDGET);
  assert.equal(seen!.blueprintId, 'external-bench'); // the full Papercusp arm
  assert.equal(seen!.task.instanceId, TASK.instanceId);
  assert.equal(run.telemetry.stopReason, 'done');
  assert.equal(run.telemetry.costUsd, 4.2);
  assert.equal(run.telemetry.turns, 18);
  assert.equal(run.telemetry.trajectoryRef, 'rollout://traj/xbench-1');

  // The SAME port spins the ablation arm — only the blueprintId differs (the causal isolation).
  await instantiateBenchHarness('coding-solo', TASK, checkout, BUDGET);
  assert.equal(seen!.blueprintId, 'coding-solo');
});

test('a driver that THROWS mid-run is captured as infra-error telemetry, not a thrown exception', async () => {
  setBenchHarnessDriver({
    async spinRunAndCost() {
      throw new Error('orchestrator crashed spinning the harness');
    },
  });
  const checkout = fakeCheckout();
  const run = await instantiateBenchHarness('external-bench', TASK, checkout, BUDGET);
  assert.equal(run.telemetry.stopReason, 'error');
  assert.match(run.telemetry.generationError ?? '', /orchestrator crashed/);
  assert.equal(run.worktreePath, checkout.dir);
});
