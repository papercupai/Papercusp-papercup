/**
 * P-013(b) (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-003/D-005):
 * while a repair queue row exists in ANY phase, the gate's decision never judges the moving
 * integration tip — the candidate it names is always the frozen candidate or its repairHead,
 * and it never asks for a re-cut.
 *
 * Written as a falsifier FIRST: on the pre-plan code an exhausted queue under the default
 * limits yields `recut-at-tip` (P-048's escape hatch), which this file refuses. D-005 deletes
 * that hatch; until P-009 removes the decision kind from the union this guard is the thing
 * that keeps it unreachable. The resolver-level structural guard (green-checkpoint.ts never
 * calling `revParse(cfg.integrationBranch)` while a queue row exists) lands with P-009.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS,
  FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
  decideFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairPhase,
  type FrozenCandidateRepairQueue,
  type FrozenRepairQueueDecision,
  type FrozenRepairQueueObservation,
} from './frozen-candidate-repair-queue';
import { resolveRunnableCandidate } from './checkpoint-required-ancestor';

const C = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const T0 = 1_800_000_000_000;
const { maxAttempts } = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS;
// The FORMER 8h wall-clock budget, deleted in P-010. Kept only as an observation EDGE: every row
// below is also driven past it, and nothing may hold, clear or re-cut on it any more.
const maxAgeMs = FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS;

const PHASES: FrozenCandidateRepairPhase[] = ['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'];

function row(phase: FrozenCandidateRepairPhase, overrides: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  const base: FrozenCandidateRepairQueue = {
    schemaVersion: 4,
    phase,
    candidate: C,
    base: null,
    repairHead: phase === 'ready-to-test' ? C : R,
    attempts: phase === 'ready-to-test' ? 0 : 1,
    openedAtMs: T0,
    updatedAtMs: T0,
    fixerSpawnId: phase === 'ready-to-verify' || phase === 'ready-to-promote' ? 'spawn-1' : null,
    failingTests: ['lib/a.test.ts'],
    signature: [],
    ...(phase === 'blocked' ? { blockedReason: 'attempts-exhausted' as const } : {}),
  };
  return { ...base, ...overrides };
}

/** Every observation shape that has ever produced an exhaustion or a re-cut, plus the calm ones. */
const OBSERVATIONS: Array<{ label: string; obs: FrozenRepairQueueObservation }> = [
  { label: 'fresh', obs: { nowMs: T0 + 1 } },
  { label: 'fixer dead', obs: { nowMs: T0 + 1, fixerAlive: false } },
  { label: 'fixer alive', obs: { nowMs: T0 + 1, fixerAlive: true } },
  { label: 'wall clock exhausted', obs: { nowMs: T0 + maxAgeMs + 1 } },
  { label: 'wall clock exhausted, fixer dead', obs: { nowMs: T0 + maxAgeMs + 1, fixerAlive: false } },
  { label: 'dispatch infeasible after the stall window', obs: { nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1, dispatchFeasible: false } },
  { label: 'staging contains the repair', obs: { nowMs: T0 + 1, stagingContainsRepair: true } },
  { label: 'staging lacks the repair', obs: { nowMs: T0 + 1, stagingContainsRepair: false } },
  // A stale caller still passing the deleted P-048 budget observation: ignored, never honoured.
  { label: 'stale priorEscapes observation', obs: { nowMs: T0 + maxAgeMs + 1, priorEscapes: 0 } as unknown as FrozenRepairQueueObservation },
];

const ROW_VARIANTS: Array<{ label: string; make: (phase: FrozenCandidateRepairPhase) => FrozenCandidateRepairQueue }> = [
  { label: 'as-is', make: (p) => row(p) },
  { label: 'attempts exhausted, fixer named', make: (p) => row(p, { attempts: maxAttempts, fixerSpawnId: 'spawn-x' }) },
  { label: 'attempts exhausted, unassigned', make: (p) => row(p, { attempts: maxAttempts, fixerSpawnId: null }) },
  { label: 'zero attempts, unassigned', make: (p) => row(p, { attempts: 0, fixerSpawnId: null }) },
  // P-010: a row PERSISTED blocked by the deleted wall-clock hold, as the parser now returns it
  // (phase ready-to-verify, no blockedReason) — the legacy shape still never judges the tip.
  {
    label: 'legacy blocked-on-wall-clock row, as parsed',
    make: (p) =>
      p === 'blocked'
        ? parseFrozenCandidateRepairQueue({ ...row(p), blockedReason: 'wall-clock-exhausted' } as unknown as FrozenCandidateRepairQueue)!
        : row(p),
  },
];

const TIP_JUDGING_KINDS = new Set(['run-normal-gate', 'recut-at-tip']);

describe('a queue row in any phase never lets the gate judge the tip (P-013(b))', () => {
  for (const phase of PHASES) {
    for (const variant of ROW_VARIANTS) {
      for (const { label, obs } of OBSERVATIONS) {
        it(`${phase} / ${variant.label} / ${label}`, () => {
          const queue = variant.make(phase);
          const decision = decideFrozenCandidateRepairQueue(queue, obs);
          expect(TIP_JUDGING_KINDS.has(decision.kind), `decision ${decision.kind} judges the tip`).toBe(false);
          if ('candidate' in decision && typeof decision.candidate === 'string') {
            expect([queue.candidate, queue.repairHead]).toContain(decision.candidate);
          }
          if ('repairHead' in decision && typeof decision.repairHead === 'string') {
            expect(decision.repairHead).toBe(queue.repairHead);
          }
          if ('abandonedCandidate' in decision) {
            throw new Error(`decision ${decision.kind} abandons the frozen candidate`);
          }
        });
      }
    }
  }

  it('the limits carry NO candidate-escape budget at all (D-005: the P-048 hatch is deleted, not zeroed)', () => {
    // A zeroed budget would be a switch someone could flip back on; the field's ABSENCE is
    // the property. A stray value on a stale caller's limits object is ignored, never honoured.
    expect(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS).not.toHaveProperty('maxCandidateEscapes');
    // P-010 deleted `maxAgeMs` the same way: absent, not zeroed.
    expect(Object.keys(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS).sort()).toEqual(['maxAttempts']);
  });

  it('no queue row at all is the ONLY input that judges the tip', () => {
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 })).toMatchObject({ kind: 'run-normal-gate' });
  });
});

/**
 * P-005 (D-004): the gate's ready-to-verify path verifies the repair head AT ITS OWN SHA. The
 * queue decision above can only name the sha; whether the gate then re-runs the signature at
 * that sha or at the tip lives in apps/operator/lib/release/green-checkpoint.ts, which this
 * package cannot import — so the property is pinned at the SOURCE level, the way the doc-claims
 * suite pins CLAUDE.md's gate claims. Written as a falsifier first: on the pre-P-005 tree the
 * verify-repair branch called `proveFrozenRepairOutcomeAtStableTip`, whose deps Pick named
 * `resolveTip` and whose `full-suite-required` / `proved` arms re-cut the gate at the tip — every
 * assertion below was red there.
 */
// lib/release → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Overridable so a falsifiability probe (scripts/mutation-probe.sh, copy-out / historical mode)
// can point this guard at a snapshot without mutating the shared tree.
const GATE_SOURCE_PATH =
  process.env.FROZEN_LINEAGE_GATE_SOURCE ?? join(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts');
const GATE_SOURCE = readFileSync(GATE_SOURCE_PATH, 'utf8');
const GATE_ANCESTOR_SOURCE = readFileSync(
  join(REPO_ROOT, 'packages/operator-core/lib/release/checkpoint-required-ancestor.ts'),
  'utf8',
);

describe('the ready-to-verify path verifies the repair head at its own sha, never the tip (P-005)', () => {
  it('the tip-proving predecessor is neither declared nor called', () => {
    // Prose mentions in docblocks are allowed (they explain what was retired and why); a
    // declaration or a call is not.
    expect(GATE_SOURCE).not.toMatch(/(?:function|await)\s+proveFrozenRepairOutcomeAtStableTip\s*\(/);
    expect(GATE_SOURCE).not.toContain('kind: "full-suite-required"');
    expect(GATE_SOURCE).not.toContain('kind: "tip-moved"');
    expect(GATE_SOURCE).not.toContain('kind: "proved"');
  });

  it('the verification deps Pick names the ref-taking runners and NO tip resolver (structural)', () => {
    const declaration = /export type RepairHeadVerificationDeps = Pick<\s*CheckpointDeps,\s*([^>]+)>/.exec(GATE_SOURCE);
    expect(declaration, 'RepairHeadVerificationDeps must be a Pick over CheckpointDeps').not.toBeNull();
    const keys = declaration![1]!
      .split('|')
      .map((key) => key.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    expect(keys).toEqual(expect.arrayContaining(['runTestsAtRef', 'runGateAtRef', 'affectedTestsAtRef']));
    expect(keys).not.toContain('resolveTip');
  });

  it('the verify-repair branch hands verifyRepairHead the queue and never names the tip', () => {
    const start = GATE_SOURCE.indexOf('decision.kind === "verify-repair"');
    expect(start, 'the verify-repair branch must exist').toBeGreaterThan(-1);
    const rest = GATE_SOURCE.slice(start);
    const end = rest.indexOf('// QUIET CUT');
    expect(end, 'the quiet-cut block must follow the branch').toBeGreaterThan(-1);
    const branch = rest.slice(0, end);
    // The deps OBJECT handed to verifyRepairHead is an incidental local (`deps` before
    // 2026-09-11T00:00Z, `verifyDeps` after it); what this guard pins is the SECOND
    // argument — the frozen queue row, never the tip. Match either spelling of the
    // first arg, exactly as the `(?:repairQueue|fresh)` assertion below does, so a
    // rename cannot red-pin the whole pure lane while the invariant still holds.
    expect(branch).toMatch(/await verifyRepairHead\((?:deps|verifyDeps), repairQueue\)/);
    expect(branch).not.toMatch(/resolveTip|transportedCandidate|stagingContainsFrozenRepair/);
    // P-008 (green-gate-zero-wait-convergence-2026-09-08) added the ONE permitted mention of
    // the integration ref on this path: `convergeLockfileDrift` reads that ref's COMMITTED
    // LOCKFILE BLOBS to clear a permanent `dependency-prewarm-missing` (exit 74,
    // EI-22752586902645795). It does not move the lineage — the branch still verifies at
    // `repairQueue.repairHead`, and any non-lockfile delta stays a typed miss. So the ref is
    // pinned to that exact call rather than banned outright: a SECOND mention, or any other
    // spelling, would be a real tip read and fails here.
    expect(branch.match(/integrationBranch/g) ?? []).toHaveLength(1);
    expect(branch).toContain('integrationRef: cfg.integrationBranch');
    // A red re-queues from the repair head that was just tested; nothing on this path retires
    // the queue (`writeFrozenRepairQueue(null)`) or steps the candidate anywhere else.
    // P-027 / D-014: the red is recorded through `commitFrozenRepairQueueTransition` +
    // `verdictTransitionAtHead`, which hands the marker a FRESH re-read of the row (`fresh`)
    // so a concurrent admission is never overwritten (the 2026-09-05 17:41Z lost update);
    // either spelling names the queue row, never the tip.
    // Since 2026-10-08 (be90772aa9) the marker is no longer CALLED directly: it is handed by
    // reference to `recordedGateDecision('frozen-repair-red', markFrozenRepairVerificationRed,
    // [fresh, …])`, which records the gate decision and then applies it to that argument list.
    // Accept the direct call or that wrapper — in both the FIRST argument must still be the
    // queue row (`repairQueue` / `fresh`), so a tip-derived argument fails here either way.
    expect(branch).toMatch(/markFrozenRepairVerificationRed(?:\(|,\s*\[)(?:repairQueue|fresh),/);
    expect(branch).toContain('verdictTransitionAtHead(');
    expect(branch).not.toContain('writeFrozenRepairQueue?.(null)');
  });

  it('every runner call inside verifyRepairHead passes the repair head', () => {
    const start = GATE_SOURCE.indexOf('export async function verifyRepairHead(');
    expect(start).toBeGreaterThan(-1);
    const rest = GATE_SOURCE.slice(start);
    const body = rest.slice(0, rest.indexOf('\n}\n') + 3);
    const runnerCalls = [...body.matchAll(/deps\s*\.\s*(runTestsAtRef|runGateAtRef|affectedTestsAtRef)!?\s*\(\s*(\w+)/g)];
    expect(runnerCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of runnerCalls) {
      expect(call[2], `${call[1]} must be called at the repair head`).toBe('head');
    }
    expect(body).toContain('const head = queue.repairHead;');
    expect(body).not.toMatch(/resolveTip|integrationBranch/);
  });
});

/**
 * P-009 / P-010 (D-004): NOTHING un-freezes a lineage but promotion or an explicit operator
 * retire — in particular no AGE, STALL or "fossil" clock. Written as a falsifier against the
 * tree of 2026-09-04 06:25Z, where the WI-42207 block in green-checkpoint.ts released the
 * 97c0b102 pin (549m old, `updatedAtMs` unmoved for one suite + 30m) and judged tip 7910b78c —
 * every assertion below is red on that source (`frozenPinIsFossilized` declared, the
 * `frozen-candidate-fossil:` log line present, a third `writeFrozenRepairQueue(null)` site with
 * no promotion marker near it).
 *
 * The queue-null writes that REMAIN are enumerated by the marker that must sit within the
 * preceding window, so adding a fourth clearing path anywhere in the gate fails here unless it
 * is one of the two sanctioned shapes.
 */
describe('no age, stall or fossil clock ever clears a queue row (P-009/P-010)', () => {
  it('the fossil release predicate, its stall window and its evidence type are gone', () => {
    for (const forbidden of [
      'frozenPinIsFossilized',
      'FROZEN_REPAIR_STALL_MS',
      'frozen-candidate-fossil',
      'fossilAbandonment',
      'FrozenCandidateFossilAbandonment',
    ]) {
      expect(GATE_SOURCE.includes(forbidden), `${forbidden} is back in the gate`).toBe(false);
    }
  });

  it('every queue-clearing write sits on a sanctioned path: promotion, or the WI-2141347 converged-head retest', () => {
    // The CAS writer now passes options after null; the comma is part of each
    // real clear site and prevents a no-argument lookalike from satisfying this guard.
    const sites = [...GATE_SOURCE.matchAll(/writeFrozenRepairQueue!?\??\.?\(\s*null\s*,/g)];
    // Exactly the sanctioned shapes. A new one must be argued into this list, not added.
    // 2 (P-013) + 2 (P-008, 2026-09-04: the post-promotion staging bridge and its crash
    // recovery — both run only AFTER `main` has already advanced to the proven lineage).
    expect(sites.length, 'a new writeFrozenRepairQueue(null) site appeared').toBe(4);
    const SANCTIONED = [
      // The lineage's own repairHead has converged past the frozen candidate: its bookkeeping row
      // is dropped but the CONVERGED repairHead (a sha on the lineage) is what gets tested next.
      /WI-2141347/,
      // `main` was fast-forwarded to the lineage: the queue has done its job.
      /repairPromotionAdvance/,
      // P-008 (D-004): staging absorbs the ALREADY-PROMOTED lineage (`merge -s ours`), then the
      // ready-to-promote row is cleared — on the promotion pass, or on the next pass when the
      // process died between main's fast-forward and the bridge. Never before main advanced.
      /P-008 post-promotion|absorbPromotedLineageIntoStaging/,
    ];
    for (const site of sites) {
      const window = GATE_SOURCE.slice(Math.max(0, site.index! - 2500), site.index!);
      expect(
        SANCTIONED.some((re) => re.test(window)),
        `writeFrozenRepairQueue(null) at offset ${site.index} has no promotion / converged-head marker in its window`,
      ).toBe(true);
      // And neither sanctioned window may be an age/stall decision in disguise.
      expect(window).not.toMatch(/commitUnixTime|ageMs|updatedAtMs\s*[<>]/);
    }
  });

  it('P-010: no age budget survives anywhere the gate or the queue policy could act on', () => {
    // Structure: the limits carry no age field, and the gate source names neither the deleted
    // budget nor its diagnostic projection.
    expect(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS).not.toHaveProperty('maxAgeMs');
    expect(GATE_SOURCE).not.toMatch(/maxAgeMs|ageExpired|wall-clock-exhausted/);
    // The one age read the gate is allowed — the escalation rung — may never sit beside a queue
    // clear: every rung read must be followed by a NON-null queue write, not a null one.
    for (const m of GATE_SOURCE.matchAll(/frozenRepairAgeEscalationRung\(/g)) {
      const after = GATE_SOURCE.slice(m.index!, m.index! + 1200);
      expect(after, `rung read at offset ${m.index} is followed by a queue clear`).not.toMatch(/writeFrozenRepairQueue\?\.\(\s*null/);
    }
    // Behaviour: no open phase, however old, ever decides to hold on the clock — and a stale
    // caller still passing the deleted budget is ignored, never honoured.
    const ancient = { nowMs: T0 + 1000 * maxAgeMs };
    for (const phase of PHASES) {
      if (phase === 'blocked') continue;
      for (const limits of [DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, { maxAttempts, maxAgeMs: 1 } as unknown as typeof DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS]) {
        const decision = decideFrozenCandidateRepairQueue(row(phase), ancient, limits);
        expect(decision.kind, `${phase} held on age`).not.toBe('hold-exhausted');
        expect(JSON.stringify(decision)).not.toMatch(/wall-clock/);
      }
    }
    // Migration: a row persisted blocked by the deleted hold comes back to verification on read,
    // so no queue stays wedged behind a reason nothing can produce any more.
    const legacy = parseFrozenCandidateRepairQueue({ ...row('blocked'), blockedReason: 'wall-clock-exhausted' } as unknown as FrozenCandidateRepairQueue);
    expect(legacy?.phase).toBe('ready-to-verify');
    expect(legacy).not.toHaveProperty('blockedReason');
    // And a genuinely attempt-exhausted blocked row is untouched by that migration.
    expect(parseFrozenCandidateRepairQueue(row('blocked'))?.phase).toBe('blocked');
  });
});

/**
 * P-013(d) (D-011): `retire` is an ACTOR-attributed operator verb, never an automatic path. The
 * storage compare-and-swap `retireFrozenCandidateRepairQueue` (harness/routines/release-actions.ts)
 * has exactly ONE non-test call site — the release:repair-queue tool's `retire` op, which requires
 * a reason and audits the caller's ownerId — and nothing a routine tick, the gate, or a fixer could
 * reach. Written as a falsifier: a second call site anywhere under the scanned roots fails here
 * until it is argued into the allowlist, which is deliberately a single entry (an "automatic
 * retire" would be the age/stall clock of D-011 wearing a new name).
 */
const RETIRE_CALLER_ALLOWLIST = ['packages/operator-core/lib/agent-tools/release/repair-queue.ts'];
const RETIRE_SCAN_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib', 'apps/operator/bin', 'packages/agent-mcp/src'];
// A CALL, not the declaration (`function retireFrozenCandidateRepairQueue(`) and not an import /
// export specifier (which never carries the `(`).
const RETIRE_CALL = /(?<!function\s+)\bretireFrozenCandidateRepairQueue\s*\(/g;

function walkSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
}

describe('retire is an actor-attributed operator verb with no automatic caller (P-013(d), D-011)', () => {
  const files: string[] = [];
  for (const root of RETIRE_SCAN_ROOTS) walkSources(join(REPO_ROOT, root), files);
  const callers = new Map<string, number>();
  for (const file of files) {
    const calls = [...readFileSync(file, 'utf8').matchAll(RETIRE_CALL)].length;
    if (calls > 0) callers.set(relative(REPO_ROOT, file), calls);
  }

  it('scanned a real population (positive control against an empty walk reading as "no callers")', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(callers.size).toBeGreaterThan(0);
  });

  it('exactly the tool op calls the storage retire; no routine, tick or gate path does', () => {
    expect([...callers.keys()].sort()).toEqual(RETIRE_CALLER_ALLOWLIST);
    expect(callers.get(RETIRE_CALLER_ALLOWLIST[0]!)).toBe(1);
  });

  it('the tool op requires a reason and audits the retire to the caller identity', () => {
    const tool = readFileSync(join(REPO_ROOT, RETIRE_CALLER_ALLOWLIST[0]!), 'utf8');
    const retireReason = /op:\s*z\.literal\('retire'\)[\s\S]*?(reason:[^\n]*)/.exec(tool);
    expect(retireReason, "the retire op must declare a reason").not.toBeNull();
    expect(retireReason![1]).toMatch(/z\.string\(\)\.min\(\d+\)/);
    expect(retireReason![1], "the retire op's reason must be required").not.toContain('.optional()');
    expect(tool).toMatch(/recordAudit\(\s*identity\.ownerId/);
  });

  it('the gate never calls retire itself', () => {
    expect(GATE_SOURCE).not.toMatch(RETIRE_CALL);
  });
});

/**
 * P-007 / D-004 falsifiers. Two independent holes let a frozen candidate lose its freeze at
 * the very last hop, AFTER every fix had been admitted and proven:
 *
 *  1. the manual-run preflight resolved a `verify-repair` queue by asking whether canonical
 *     staging already contained the repair's patch, and fell back to a TIP CUT when it did
 *     not — so a repair deliberately not yet folded into staging was answered with the moving
 *     tip, the exact object the freeze exists to refuse;
 *  2. the gate treated a green isolated repair as VERIFICATION-ONLY (D-001) and joined it into
 *     the moving tip to re-run the complete gate there, discarding the proof it had earned and
 *     re-importing every commit landed since the freeze.
 *
 * D-004 replaces both with one rule: `main` may fast-forward to a commit of the frozen lineage
 * that passed the full gate.
 */
describe('a verify-repair queue resolves to its own head, never a tip cut (P-007)', () => {
  const NOT_A_REPO = '/nonexistent/definitely-not-a-git-repo';
  const TIP = '3333333333333333333333333333333333333333';

  it('CALIBRATION: a test-candidate decision already resolves to the frozen candidate', () => {
    const resolved = resolveRunnableCandidate(
      { kind: 'test-candidate', candidate: C } as FrozenRepairQueueDecision,
      row('ready-to-test'),
      TIP,
      NOT_A_REPO,
    );
    expect(resolved).toEqual({ candidate: C, source: 'frozen-repair-queue' });
  });

  it('resolves the repair head even when staging does NOT contain the repair patch', () => {
    // The point of the freeze is that the lineage need not be observable on staging. Answering
    // "not on staging" with the tip is how a frozen candidate got swapped for a fresh cut at
    // the last hop.
    const resolved = resolveRunnableCandidate(
      { kind: 'verify-repair', candidate: R } as FrozenRepairQueueDecision,
      row('ready-to-verify'),
      TIP,
      NOT_A_REPO,
    );
    expect(resolved).toEqual({ candidate: R, source: 'frozen-repair-queue' });
  });

  it('never answers a verify-repair queue with the predicted tip, whatever the tip is', () => {
    for (const predicted of [TIP, C, null]) {
      const resolved = resolveRunnableCandidate(
        { kind: 'verify-repair', candidate: R } as FrozenRepairQueueDecision,
        row('ready-to-verify'),
        predicted,
        NOT_A_REPO,
      );
      expect(resolved?.candidate).toBe(R);
      expect(resolved?.source).not.toBe('current-quiet-cut');
      expect(resolved?.source).not.toBe('unresolved');
    }
  });

  it('does not consult a moving tip for a verify-repair queue', () => {
    // A pure branch cannot fall back to a moving object. If this decision ever needs git
    // again, the fallback it reintroduces is the defect above.
    expect(GATE_ANCESTOR_SOURCE).not.toMatch(
      /kind === 'verify-repair'[\s\S]{0,600}?currentQuietCutCandidate/,
    );
  });

  it('the patch-on-staging probe is gone entirely — it had no other honest caller', () => {
    expect(GATE_ANCESTOR_SOURCE).not.toContain('stagingContainsFrozenRepairPatch');
  });
});

describe('a green repair head promotes; it is never joined into the tip (P-007, replaces D-001)', () => {
  it('the verification-only staging join has no declaration and no caller in the gate', () => {
    // Scanned as CALL/DECLARATION shapes, not bare mentions: the prose explaining why D-001 was
    // retired names both symbols on purpose, and a guard that forbade the explanation would push
    // the next reader to delete the history instead of the code.
    expect(GATE_SOURCE).not.toMatch(
      /(?:deps\.|async\s+)reconcileFrozenRepairIntoStaging|reconcileFrozenRepairIntoStaging\s*[?(]/,
    );
    expect(GATE_SOURCE).not.toMatch(/stageCanonicalRepairRetest\s*[(=]/);
  });

  it('POSITIVE CONTROL: those same patterns DO match the shapes they are meant to catch', () => {
    // Without this, a typo in either pattern above reads as "the join is gone".
    const declaration = '  reconcileFrozenRepairIntoStaging?(\n    queue: Q,\n  ): Promise<string>;';
    const call = 'const staged = await stageCanonicalRepairRetest(repairQueue);';
    expect(declaration).toMatch(
      /(?:deps\.|async\s+)reconcileFrozenRepairIntoStaging|reconcileFrozenRepairIntoStaging\s*[?(]/,
    );
    expect('await deps.reconcileFrozenRepairIntoStaging!(queue)').toMatch(
      /(?:deps\.|async\s+)reconcileFrozenRepairIntoStaging|reconcileFrozenRepairIntoStaging\s*[?(]/,
    );
    expect(call).toMatch(/stageCanonicalRepairRetest\s*[(=]/);
  });

  it('the gate decides promotion through the frozen-lineage predicate', () => {
    expect(GATE_SOURCE).toContain('assessFrozenLineagePromotion');
  });

  it('POSITIVE CONTROL: both sources really were read (these scans can fail)', () => {
    expect(GATE_SOURCE.length).toBeGreaterThan(100_000);
    expect(GATE_SOURCE).toContain('runGreenCheckpoint');
    expect(GATE_ANCESTOR_SOURCE).toContain('resolveRunnableCandidate');
  });
});

/**
 * P-024 (D-003 / D-011, WI-2144110): the FOURTH un-freezing path. The stale-red RE-TRIAGE in the
 * gate's not-green branch re-runs the failing legs at a second sha and, on a pass, REFIRES the whole
 * gate on it (`return runGreenCheckpoint(cfg, deps, { ...opts, candidate: tip })`). Until P-024 that
 * sha was `deps.resolveTip()` — the integration branch — even while a queue row was frozen. Measured
 * 2026-09-04 12:23:16Z: queue frozen at 97c0b102 @ repairHead a93a1cab, re-triage refired at
 * 88b78003, a sha that does NOT descend from the lineage and IS an ancestor of staging.
 *
 * Written as a falsifier against that source: the pre-P-024 block reads
 * `const tip = (await deps.resolveTip?.().catch(() => null)) ?? null;` and re-reads the tip the same
 * way after the re-run — both shapes are refused below. The behavioural half (a row in ANY phase
 * pins the target to repairHead and never consults the tip) lives in retriage-target.test.ts.
 */
describe('re-triage never re-runs at, or refires on, the integration tip while a queue row exists (P-024)', () => {
  const start = GATE_SOURCE.indexOf('// Stale-candidate re-triage:');
  // The CALL, not the reason string: `"superseded-by-refire"` is also a member of the promotion
  // reason union declared thousands of lines earlier.
  const end = GATE_SOURCE.indexOf('stampPromotion(false, "superseded-by-refire")', Math.max(0, start));
  const block = start > -1 && end > start ? GATE_SOURCE.slice(start, end) : '';

  it('the re-triage block exists and ends in the refire recursion', () => {
    expect(start, 'the re-triage block marker must exist').toBeGreaterThan(-1);
    expect(end, 'the refire promotion stamp must follow the block').toBeGreaterThan(start);
  });

  it('resolves its target through the lineage-aware resolver, never by a bare tip read', () => {
    expect(block).toContain('resolveRetriageTarget(');
    expect(block).toMatch(/isLineageDescendant:/);
    expect(block).toMatch(/const tip = retriageTarget\.ref;/);
    expect(block).not.toMatch(/const tip\s*=\s*\(await deps\.resolveTip/);
    expect(block).not.toMatch(/const currentTipAfterRetriage\s*=\s*\(await deps\.resolveTip/);
  });

  it('every remaining mention of the tip resolver in the block is the resolver INPUT, not a read the block performs', () => {
    // CODE only — the block's own docblock names `deps.resolveTip` to explain this rule.
    const code = block
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    const mentions = [...code.matchAll(/deps\.resolveTip/g)];
    expect(mentions.length, 'the resolver must be handed the tip reader as its no-row input').toBeGreaterThan(0);
    for (const m of mentions) {
      // The mention must sit INSIDE the resolver's `resolveIntegrationTip:` input (the guard and
      // the call share one line), never as a value assigned to something the block then judges.
      const around = code.slice(Math.max(0, m.index! - 160), m.index! + 160);
      expect(around, `bare deps.resolveTip read at block offset ${m.index}`).toMatch(/resolveIntegrationTip/);
      const line = code.slice(code.lastIndexOf('\n', m.index!) + 1, code.indexOf('\n', m.index!));
      expect(line, `deps.resolveTip assigned to a judged value at block offset ${m.index}`).not.toMatch(/^\s*(const|let)\s+\w+\s*=/);
    }
  });

  it('the refire recurses on the resolved target and on nothing else', () => {
    const tail = GATE_SOURCE.slice(end, end + 400);
    expect(tail).toMatch(/candidate:\s*tip,/);
    expect(tail).not.toMatch(/integrationBranch|resolveTip/);
  });

  it('POSITIVE CONTROL: the forbidden bare-read shapes match what they are meant to catch', () => {
    expect('const tip = (await deps.resolveTip?.().catch(() => null)) ?? null;').toMatch(/const tip\s*=\s*\(await deps\.resolveTip/);
    expect('const currentTipAfterRetriage =\n          (await deps.resolveTip?.().catch(() => null)) ?? null;').toMatch(
      /const currentTipAfterRetriage\s*=\s*\(await deps\.resolveTip/,
    );
  });
});
