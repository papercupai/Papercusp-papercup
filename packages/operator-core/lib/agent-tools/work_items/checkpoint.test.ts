/**
 * Unit tests for work_items:checkpoint (bee-context-efficiency P-010·P-011·P-012),
 * now on the bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21).
 * The store (setWorkItemCheckpoint) + getWorkItem are mocked — this exercises the
 * tool's contract: per-item harness keying by the ITEM's own canonical harness
 * (EI-8805 — arg/ctx are only a lookup hint; a harness-null item keys under its own
 * null harness, never the session harness), write-vs-clear, the many form, and clean
 * per-item error surfacing.
 *
 * The single { id } call is now n=1 of the bulk call: it returns the house envelope
 * { ok, results:[{ ok, id, … | error }], counts } — assertions read results[0], not
 * the top level.
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach, afterAll } from 'vitest';
import { z } from 'zod';
// Formatting assertions ignore the ID anchor; lifecycle tests below verify IDs.
const withoutRowIds = (note: string | null | undefined) =>
  (note ?? '').replace(/^(- (?:[✓?⚠] )?)\[#[a-z0-9_.:-]+\] /gm, '$1');

import { DbCallDeadlineError } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
// EI-20004424625703051: bind the cap-eviction guard to the REAL constant, so raising
// the cap re-tunes the test instead of breaking it — the guard is about the note being
// truthful at the boundary, not about the boundary sitting at any particular number.
import {
  CARRY_NOTE_MAX_CHECKS,
  CHECKPOINT_BODY_CAP_CHARS,
  splitCarryNoteChecks,
  withCarryNoteChecks,
  withCarryNoteWalls,
} from '../../carry-note';

const setWorkItemCheckpoint = vi.fn();
const setWorkItemCheckpointWithPrior = vi.fn();
const getWorkItemCheckpoint = vi.fn();
const attestWorkItemCheckpointUnchanged = vi.fn();
const getWorkItem = vi.fn();
const readSuccessfulActionInvocations = vi.hoisted(() => vi.fn());
const resolveCurrentTokens = vi.hoisted(() => vi.fn());
const readFrozenRepairMarker = vi.hoisted(() => vi.fn());
const postLearnedAtLevel = vi.hoisted(() => vi.fn());
const unresolvedPlanDecisionRefs = vi.hoisted(() => vi.fn());
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
  setWorkItemCheckpointWithPrior: (...a: unknown[]) => setWorkItemCheckpointWithPrior(...a),
  getWorkItemCheckpoint: (...a: unknown[]) => getWorkItemCheckpoint(...a),
  attestWorkItemCheckpointUnchanged: (...a: unknown[]) => attestWorkItemCheckpointUnchanged(...a),
}));
vi.mock('../../carry-surface-action-proof', async () => {
  const actual = await vi.importActual<typeof import('../../carry-surface-action-proof')>(
    '../../carry-surface-action-proof',
  );
  return { ...actual, readSuccessfulActionInvocations };
});
vi.mock('../../freshness/resolvers', async () => {
  const actual = await vi.importActual<typeof import('../../freshness/resolvers')>('../../freshness/resolvers');
  return { ...actual, resolveCurrentTokens };
});
vi.mock('../../release/frozen-repair-edit-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker,
}));
// EI-22624970955266330: only the TURN RESOLVER is stubbed — `expandCurrentTurnSentinel`
// stays real, so a test that asserts the sentinel was expanded is asserting the actual
// production transform rather than a mock's echo. Defaults to null, which is what the
// real resolver returns in a suite with no transcript, so every other test is unaffected.
const resolveCurrentTurnStamp = vi.hoisted(() => vi.fn(async (): Promise<{ ref: string } | null> => null));
const verifyTurnRefs = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../turn-provenance/turn-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../turn-provenance/turn-ref')>()),
  resolveCurrentTurnStamp,
  verifyTurnRefs,
}));
vi.mock('../../effort-thread', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../effort-thread')>()),
  postLearnedAtLevel,
}));
vi.mock('../coordination/decision-ref-advisory', () => ({
  unresolvedPlanDecisionRefs: (...a: unknown[]) => unresolvedPlanDecisionRefs(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  // checkpoint.ts fire-and-forgets markFeatureProgress + markIssueProgress (last_progress_at
  // bump on the matching family; WI-3006). The mock MUST export BOTH or the `void markX(...)`
  // call throws (undefined is not callable) — the throw lands inside the per-item runBulk fn,
  // AFTER a successful setWorkItemCheckpoint, so every item that actually WRITES fails ok:false
  // (agent-activity-liveness-truth integration). Missing markIssueProgress here red-pinned the
  // 4 write-path tests deterministically (WI-2900 gate triage).
  markFeatureProgress: () => Promise.resolve(true),
  markIssueProgress: () => Promise.resolve(true),
  // EI-19395730805289668: same trap, third instance — checkpoint.ts now also imports
  // isClaimHoldParked (for the prose-pause nudge), and an unmocked export is `undefined`,
  // which throws at the call and fails EVERY write-path test ok:false exactly as described
  // above. Re-implemented rather than importActual'd on purpose: the point of this mock is
  // to keep work-items.ts (and its DB dependencies) out of a unit test. Mirrors the real
  // predicate's text-compare, which matches both the boolean and the legacy string form.
  isClaimHoldParked: (payload: unknown) =>
    !!payload && typeof payload === 'object' && String((payload as Record<string, unknown>)._claimHold) === 'true',
  // EI-21921431863111143: same trap, fourth instance — checkpoint.ts now also imports
  // isSelfOwnerRecord (the not_holder guard's prefix-tolerant identity match). Mirrors the
  // real predicate: exact match, or `recorded` a non-empty strict prefix of `caller`.
  isSelfOwnerRecord: (recorded: string | null | undefined, caller: string) => {
    const holder = recorded?.trim();
    if (!holder) return false;
    if (holder === caller) return true;
    return caller.length > holder.length && caller.startsWith(holder);
  },
}));
import checkpoint from './checkpoint';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
// EI-19400299440742193: the guard asserts against the REAL caps, not literals, so a
// future cap change moves the test with the code instead of silently un-pinning it.
import { CARRY_CAP_HARD_MULTIPLE, CARRY_ROW_SOFT_CAPS } from '../../carry-note';
import { readFileSync } from 'node:fs';
// Resolves to the MOCK above (that is the point) — so its keys are the double's real export set.
import * as workItemsMocked from '../../work-items';
import { continuityProbeRevision } from '../../continuity-probes';
import { LIMITS } from '../limits';

const WORK_ITEM_CONTINUITY_TEST_TOOL = 'test:work-item-continuity-read';
const WORK_ITEM_LONG_CONTINUITY_TEST_TOOL = `test:${'x'.repeat(167 - 'test:'.length)}`;
defineTool({
  name: WORK_ITEM_CONTINUITY_TEST_TOOL,
  description: 'read-only fixture for work-item checkpoint executable probes',
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: ['su'],
  effect: 'read',
  args: z.object({ value: z.string() }),
  async handler(args) {
    return { data: { value: args.value } };
  },
});
defineTool({
  name: WORK_ITEM_LONG_CONTINUITY_TEST_TOOL,
  description: 'read-only fixture for long work-item checkpoint executable probes',
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: ['su'],
  effect: 'read',
  args: z.object({ value: z.string() }),
  async handler(args) {
    return { data: { value: args.value } };
  },
});

// EI-8824: force activeWorkspaceId()'s deterministic env-pin precedence (workspace-registry.ts
// precedence #2) instead of mocking the workspace-registry module — resolveConcreteWorkspaceId
// and activeWorkspaceId are same-module internal calls, so overriding the module's exports via
// vi.mock does NOT intercept the internal call resolveConcreteWorkspaceId makes to
// activeWorkspaceId(); only an out-of-module signal (the env var) actually steers it.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
beforeEach(() => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
});
afterAll(() => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
});

const baseCtx = {
  uiClientId: 'opspawn-bee-1',
  sigVerifiedSpawn: true,
  workspaceId: 'default',
  harnessSlug: 'papercup',
} as never;
const noHarnessCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default' };
const parse = (x: unknown) => (checkpoint.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
/** Parse the full bulk envelope. */
const env = async (x: unknown, ctx: unknown = baseCtx) => {
  const res = (await checkpoint.handler(parse(x) as never, ctx as never)) as Out;
  return res.data;
};
/** The single-call result is n=1 of the bulk envelope — read results[0]. */
const one = async (x: unknown, ctx: unknown = baseCtx) => (await env(x, ctx)).results[0];

beforeEach(() => {
  setWorkItemCheckpoint.mockReset();
  setWorkItemCheckpointWithPrior.mockReset();
  getWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
  readSuccessfulActionInvocations.mockReset();
  resolveCurrentTokens.mockReset();
  readFrozenRepairMarker.mockReset();
  postLearnedAtLevel.mockReset();
  unresolvedPlanDecisionRefs.mockReset();
  verifyTurnRefs.mockReset();
  readFrozenRepairMarker.mockReturnValue(null);
  readSuccessfulActionInvocations.mockResolvedValue([]);
  resolveCurrentTokens.mockResolvedValue(new Map());
  // Provenance verification is an I/O dependency. Keep this unit suite on its
  // declared seam so a missing transcript cannot consume the 3s bounded I/O
  // budget and trip vitest-fail-on-console under a loaded stateful lane.
  verifyTurnRefs.mockResolvedValue([]);
  postLearnedAtLevel.mockResolvedValue({
    posted: true,
    level: 'work_item',
    ref: 'WI-7',
    fellBack: false,
  });
  unresolvedPlanDecisionRefs.mockResolvedValue(undefined);
  // EI-9325: checkpoint.ts routes every PLAIN replace-on-write (non-append,
  // non-clear) through setWorkItemCheckpointWithPrior instead of setWorkItemCheckpoint
  // now, to get the prior length for free. Default it to delegate straight through to
  // the (still separately mockable) setWorkItemCheckpoint fn with priorLength:0 (no
  // shrink signal) — so every EXISTING test that only configures
  // setWorkItemCheckpoint.mockResolvedValue(...) keeps working unchanged. Tests that
  // specifically exercise the shrinkWarning override this mock directly.
  setWorkItemCheckpointWithPrior.mockImplementation(async (ref: unknown, checkpoint: string | null | undefined) => ({
    stored: await setWorkItemCheckpoint(ref, checkpoint),
    priorLength: 0,
  }));
  // The write now ALWAYS keys by the item's canonical harness (EI-8805), so it looks
  // the item up on every call. Most cases exercise a successful write; give them an
  // existing-item fixture by default. Tests for a confirmed miss override this with
  // null. The resolved fixture also keeps the `.catch(...)` chain valid (an unmocked
  // vi.fn returns undefined, which has no .catch).
  getWorkItem.mockImplementation(async (id: string, harness?: string) => ({
    id,
    harness: harness ?? 'papercup',
  }));
  // P-003 verify-read default: the read-back mirrors whatever the store's LAST write
  // resolved to, so every pre-existing write-path test verifies clean without each
  // one re-declaring the round-trip. Verify-failure tests override this per-case.
  //
  // P-007: mirror setWorkItemCheckpointWithPrior — checkpoint.ts now routes EVERY
  // path (replace, append, clear) through it, so keying this off the old
  // setWorkItemCheckpoint made the read-back return null for any test that stubs the
  // WithPrior path directly. The default shim above still delegates to
  // setWorkItemCheckpoint, so tests that stub only that one keep working unchanged.
  getWorkItemCheckpoint.mockImplementation(async () => {
    const last = setWorkItemCheckpointWithPrior.mock.results.at(-1);
    if (!last || last.type !== 'return') return null;
    const resolved = (await last.value) as { stored?: string | null } | null;
    return resolved?.stored ?? null;
  });
});

describe('work_items:checkpoint (bulk keyed-array)', () => {
  it('opts out of the ambient workspace transaction because the handler owns its DB scopes', () => {
    expect((checkpoint as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('records phase markers for explicit batch writes so a caller timeout leaves a useful trace', async () => {
    const logs: string[] = [];
    const ctx = {
      uiClientId: 'opspawn-bee-1',
      sigVerifiedSpawn: true,
      workspaceId: 'default',
      harnessSlug: 'papercup',
      log: (message: string) => logs.push(message),
    } as never;
    const body = 'Messaged fleet leader su-bce40c51 [turn:self]';

    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, note: string | null | undefined, opts: unknown) => {
      const transform = (opts as { transform?: (prior: string | null, incoming: string | null | undefined) => string | null | undefined })
        .transform;
      return { stored: transform?.(null, note) ?? note ?? null, priorLength: 0 };
    });

    const result = await one({ items: [{ id: 'WI-7', checkpoint: body, append: true }] }, ctx);
    expect(result.ok).toBe(true);

    const prefix = '[work_items:checkpoint:phase] ';
    const events = logs
      .filter((message) => message.startsWith(prefix))
      .map((message) => JSON.parse(message.slice(prefix.length)) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'provenance-action-proof-read', state: 'started', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'provenance-action-proof-read', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'provenance-current-turn-stamp', state: 'started', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'provenance-current-turn-stamp', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'provenance-carry-surface-stamp', state: 'started', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'provenance-carry-surface-stamp', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'locked-check-row-transform', state: 'started', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'locked-check-row-transform', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'store-write-transaction', state: 'started', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'verify-read', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'work-item-ref-advisory', state: 'completed', itemId: 'WI-7' }),
        expect.objectContaining({ phase: 'plan-decision-ref-advisory', state: 'completed', itemId: 'WI-7' }),
      ]),
    );
    expect(events.some((event) => event.phase === 'append-prior-read')).toBe(false);
    expect(events.every((event) => event.itemIndex === 1 && event.itemCount === 1)).toBe(true);
  });

  it('records only slow phase markers for single-item writes', async () => {
    const logs: string[] = [];
    const ctx = { ...baseCtx, log: (message: string) => logs.push(message) } as never;
    const body = 'Checkpoint write with a deliberately slow store phase.';

    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, note: string | null | undefined, opts: unknown) => {
      const transform = (opts as { transform?: (prior: string | null, incoming: string | null | undefined) => string | null | undefined })
        .transform;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      return { stored: transform?.(null, note) ?? note ?? null, priorLength: 0 };
    });

    const result = await one({ id: 'WI-7', checkpoint: body }, ctx);
    expect(result.ok).toBe(true);

    const prefix = '[work_items:checkpoint:phase] ';
    const events = logs
      .filter((message) => message.startsWith(prefix))
      .map((message) => JSON.parse(message.slice(prefix.length)) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'store-write-transaction',
      state: 'completed',
      traceMode: 'slow-only',
      thresholdMs: 2_000,
    });
    expect(events[0].elapsedMs).toBeGreaterThanOrEqual(2_000);
  });

  it('refuses the historical staging-candidate instruction before calling the checkpoint store', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const result = await one({
      id: 'WI-7',
      checkpoint: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    });

    expect(result).toMatchObject({
      ok: false,
      id: 'WI-7',
      error: 'frozen_candidate_lineage_violation',
      surface: 'work-item-checkpoint',
      unsafeSource: 'staging',
      liveIdentity: {
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        queueRevision: 1_788_763_360_000,
      },
    });
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('allows a neutral worktree branch-status note while a frozen repair marker exists', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({ id: 'WI-7', checkpoint: 'Worktree remains on staging.' });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('accepts factual current-build SHA attribution in a structured check claim', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpointWithPrior.mockImplementation(
      async (_ref: unknown, stored: string | null | undefined) => ({ stored: stored ?? null, priorLength: 0 }),
    );

    const result = await one({
      id: 'WI-7',
      checks: [
        {
          claim: 'Target SHA a906a9a29b1abaf67ce94abccd7ed263e64886a3 is loaded in the staging-operator current build',
          ok: false,
          contested: 'Historical reproduction input; this unit test makes no current-runtime claim.',
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('allows descriptive frozen-candidate staleness comparisons against staging', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({
      id: 'WI-7',
      checkpoint: 'Frozen candidate is 09d0c118d5df, 32 commits behind staging.',
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('allows a metadata-only patch when the stale instruction exists only in the locked prior', async () => {
    const stale = 'Then pin whatever staging resolves to at that instant, still never a quoted sha.';
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpointWithPrior.mockImplementationOnce(
      async (
        ref: unknown,
        checkpointText: string | null | undefined,
        opts?: Parameters<typeof import('../../work-item-checkpoint').setWorkItemCheckpointWithPrior>[2],
      ) => {
        const stored = opts?.transform ? opts.transform(stale, checkpointText) : checkpointText;
        await setWorkItemCheckpoint(ref, stored);
        return { stored, priorLength: stale.length };
      },
    );

    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({ id: 'WI-7', checks: [{ claim: 'the focused unit suite is green' }] });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
    expect(setWorkItemCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('does not treat an inherited frozen-lineage CHECK row as caller-supplied text', async () => {
    const unsafeStoredCheck =
      "· verdict RED on test:lane-stateful -> THEN run that one lane locally, fix it on the shared staging checkout (there is NO repair worktree, D-010), let git-sync commit, and admit BY PATH via release:repair-queue { op:'admit', paths:[...] }";
    const prior = withCarryNoteChecks('prior narrative', [{ claim: unsafeStoredCheck }]);
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpointWithPrior.mockImplementationOnce(
      async (
        ref: unknown,
        checkpointText: string | null | undefined,
        opts?: Parameters<typeof import('../../work-item-checkpoint').setWorkItemCheckpointWithPrior>[2],
      ) => {
        const stored = opts?.transform ? opts.transform(prior, checkpointText) : checkpointText;
        await setWorkItemCheckpoint(ref, stored);
        return { stored, priorLength: prior.length };
      },
    );
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({ id: 'WI-7', checkpoint: 'Corrected checkpoint narrative.' });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    const stored = setWorkItemCheckpoint.mock.calls.at(-1)?.[1] as string;
    expect(stored).toContain(unsafeStoredCheck);
    expect(stored).toContain('Corrected checkpoint narrative.');
  });

  it('allows a diagnostic check that quotes the refusal wording', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({
      id: 'WI-7',
      checkpoint: 'Documenting the prior refusal.',
      checks: [
        {
          claim: 'The refusal says staging was selected as the judged candidate; this row documents the diagnostic.',
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('allows diagnostic prose reporting that a sentence was classified as candidate selection', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, stored: string | null | undefined) => stored);

    const result = await one({
      id: 'WI-7',
      checkpoint:
        'It classified the sentence as selecting staging for the judged frozen candidate, although the note gave no instruction to judge or release staging.',
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('accepts factual canonical-tree location prose while a frozen queue is open', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, text: string) => text);

    const result = await one({
      id: 'WI-7',
      checkpoint: 'Canonical tree is /workspace/papercusp on staging.',
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit plain-not negation of unsafe candidate selection', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, text: string) => text);

    const result = await one({
      id: 'WI-7',
      checkpoint: 'I am NOT selecting current-head as the judged candidate',
    });

    expect(result).toMatchObject({ ok: true, id: 'WI-7' });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('teaches that rowsMode controls rows only and gives the complete body+rows replacement recipe', () => {
    const json = z.toJSONSchema(checkpoint.args as never) as {
      properties?: { rowsMode?: { description?: string } };
    };
    const rowsMode = json.properties?.rowsMode?.description ?? '';
    expect(rowsMode).toContain('controls CHECK ROWS only');
    expect(rowsMode).toContain("append:true` + `rowsMode:'replace'");
    expect(rowsMode).toContain('`retireIds` are required');
    for (const token of ['append:false', "rowsMode:'replace'", 'confirmShrink:true', 'retireIds:[...]']) {
      expect(rowsMode).toContain(token);
      expect(checkpoint.description).toContain(token.replaceAll("'", '"'));
    }
  });

  it('documents checks beside checkpoint, not nested in the structured checkpoint body', () => {
    const json = z.toJSONSchema(checkpoint.args as never);
    const descriptions: string[] = [];
    const collectDescriptions = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('description' in value && typeof (value as { description?: unknown }).description === 'string') {
        descriptions.push((value as { description: string }).description);
      }
      for (const child of Object.values(value)) collectDescriptions(child);
    };
    collectDescriptions(json);

    expect(descriptions.some((description) => description.includes('`checks` is a sibling argument, not a field inside this object'))).toBe(true);
    expect(descriptions.some((description) => description.includes('root-level `checks` beside `checkpoint`'))).toBe(true);
    expect(descriptions.some((description) => description.includes('`items[n].checks` beside `items[n].checkpoint`'))).toBe(true);
  });

  it('publishes the retireIds rowsMode constraint for single and items[] writes', () => {
    const json = z.toJSONSchema(checkpoint.args as never) as {
      properties?: {
        retireIds?: { 'x-papercusp-call-constraint'?: string };
        items?: {
          items?: {
            properties?: { retireIds?: { 'x-papercusp-call-constraint'?: string } };
          };
        };
      };
    };
    const expected = "Requires effective `rowsMode:'replace'`; an `items[]` entry overrides the root setting, and omitted `rowsMode` defaults to `'merge'`.";
    expect(json.properties?.retireIds?.['x-papercusp-call-constraint']).toContain(expected);
    expect(json.properties?.items?.items?.properties?.retireIds?.['x-papercusp-call-constraint']).toContain(expected);
  });

  it('teaches the single-item attestation exclusion in the published schema', () => {
    const json = z.toJSONSchema(checkpoint.args as never) as {
      properties?: {
        unchanged?: { description?: string; 'x-papercusp-call-constraint'?: string };
      };
    };
    const guidance = json.properties?.unchanged?.description ?? '';
    for (const field of ['contentHash', 'checkpoint', 'did', 'left', 'insight', 'next', 'clear', 'append', 'checks', 'dependsOn']) {
      expect(guidance).toContain(field);
    }
    expect(guidance).toContain('attestation_conflicting_args');
    expect(guidance).toContain('omit `unchanged` when writing a new body');

    const constraint = json.properties?.unchanged?.['x-papercusp-call-constraint'] ?? '';
    for (const token of [
      '`contentHash` required',
      '`checkpoint`',
      '`clear:true`',
      '`append:true`',
      '`checks`',
      '`retireIds`',
      '`dependsOn`',
      'attestation_conflicting_args',
      '`confirmRetire` cannot authorize a row mutation',
    ]) {
      expect(constraint).toContain(token);
    }
  });

  it('accepts a current read-only executable probe and refuses drift before persistence', () => {
    const probe = {
      kind: 'tool' as const,
      tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    expect(() => parse({ id: 'WI-7', checks: [{ claim: 'gate is green', probe }] })).not.toThrow();
    const liveParsed = parse({
      id: 'WI-7',
      checks: [{ claim: 'gate is green', probe: { ...probe, schemaRevision: 'live' } }],
    }) as { checks: Array<{ probe: { schemaRevision: string } }> };
    expect(liveParsed.checks[0].probe.schemaRevision).toBe(continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL));
    expect(() =>
      parse({ id: 'WI-7', checks: [{ claim: 'gate is green', probe: { ...probe, schemaRevision: 'stale' } }] }),
    ).toThrow(/schema_revision_mismatch/);
    expect(() =>
      parse({
        id: 'WI-7',
        checks: [
          {
            claim: 'gate is green',
            probe: { ...probe, args: { value: 'green', authorization: 'Bearer sk-abcdefghijklmnop' } },
          },
        ],
      }),
    ).toThrow(/secret_material/);
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('keeps the generated compact catalog guidance aligned with the typed probe contract', () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../../../.papercusp/tool-catalog.json', import.meta.url), 'utf8'),
    ) as { tools: Array<{ name: string; guidance?: { when?: string } }> };
    const compact = catalog.tools.find((entry) => entry.name === 'work_items:checkpoint');
    expect(compact, 'generated catalog must include work_items:checkpoint').toBeDefined();

    const authored = String((checkpoint as { guidance?: { when?: unknown } }).guidance?.when ?? '');
    const projected = compact?.guidance?.when ?? '';
    expect(projected).toBe(authored);
    for (const token of ["kind:'tool'", "kind:'state-cell'", 'tool:', 'args:', 'schemaRevision', 'recheck']) {
      expect(projected).toContain(token);
    }
    expect(projected).toContain('probe:{expect:...}');
  });

  it('EI-21989135403192173: lifts a legacy check-level schemaRevision into a nested probe before validation', () => {
    const revision = continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL)!;
    const parsed = parse({
      id: 'WI-7',
      checks: [
        {
          claim: 'gate is green',
          schemaRevision: 'live',
          probe: {
            tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
            args: { value: 'green' },
            expect: { path: '$.value', op: 'eq' as const, value: 'green' },
          },
        },
      ],
    }) as { checks: Array<Record<string, unknown>> };

    expect(parsed.checks[0]).toEqual({
      claim: 'gate is green',
      probe: {
        kind: 'tool',
        tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
        args: { value: 'green' },
        schemaRevision: revision,
        expect: { path: '$.value', op: 'eq', value: 'green' },
      },
    });
    expect(parsed.checks[0]).not.toHaveProperty('schemaRevision');
  });

  it('accepts the structured carry-note checkpoint shape in both shorthand forms', () => {
    const checkpointBody = {
      did: 'implemented the compatibility path',
      left: 'run the focused test',
      insight: 'the work-item checkpoint shares the loop carry-note shape',
      next: 'run Vitest',
    };
    const expected =
      '## Did\nimplemented the compatibility path\n\n' +
      '## Left\nrun the focused test\n\n' +
      '## Key insight\nthe work-item checkpoint shares the loop carry-note shape\n\n' +
      '## Next action\nrun Vitest';

    expect(parse({ id: 'WI-7', checkpoint: checkpointBody })).toMatchObject({ checkpoint: expected });
    expect(parse({ items: [{ id: 'WI-7', checkpoint: checkpointBody }] })).toMatchObject({
      items: [{ checkpoint: expected }],
    });
  });

  it('publishes the documented structured checkpoint shape in both shorthand schemas', () => {
    const json = z.toJSONSchema(checkpoint.args as never) as {
      $defs?: Record<string, unknown>;
      properties?: Record<string, unknown> & {
        checkpoint?: unknown;
        checks?: unknown;
        items?: { items?: unknown };
      };
    };
    const resolveRef = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      const ref = (value as Record<string, unknown>).$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return value;
      return json.$defs?.[ref.slice('#/$defs/'.length)] ?? value;
    };
    const hasStructuredCheckpoint = (value: unknown): boolean => {
      value = resolveRef(value);
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      const properties = record.properties;
      if (
        record.type === 'object' &&
        properties &&
        typeof properties === 'object' &&
        'did' in properties &&
        'left' in properties &&
        'insight' in properties &&
        'next' in properties
      ) {
        return true;
      }
      return Object.values(record).some(hasStructuredCheckpoint);
    };

    expect(hasStructuredCheckpoint(json.properties?.checkpoint)).toBe(true);
    expect(hasStructuredCheckpoint(json.properties?.items?.items)).toBe(true);

    // EI-26041557359273233: testResult/verified are evidence aliases for check rows,
    // not top-level checkpoint arguments. A stale generated wrapper advertised them
    // at the root even though the current runtime accepts them only under checks[].
    expect('testResult' in (json.properties ?? {})).toBe(false);
    expect('verified' in (json.properties ?? {})).toBe(false);

    const hasProperty = (value: unknown, key: string): boolean => {
      value = resolveRef(value);
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      const properties = record.properties;
      if (properties && typeof properties === 'object' && key in properties) return true;
      return Object.values(record).some((child) => hasProperty(child, key));
    };
    expect(hasProperty(json.properties?.checks, 'testResult')).toBe(true);
    expect(hasProperty(json.properties?.items?.items, 'testResult')).toBe(true);
    expect(hasProperty(json.properties?.checks, 'verified')).toBe(true);
    expect(hasProperty(json.properties?.items?.items, 'verified')).toBe(true);
    expect(hasProperty(json.properties?.checks, 'sinceMs')).toBe(true);
    expect(hasProperty(json.properties?.items?.items, 'sinceMs')).toBe(true);
  });

  it('accepts and publishes the sinceMs check-row age anchor', () => {
    const sinceMs = Date.parse('2026-09-13T12:00:00.000Z');
    const parsed = parse({ id: 'WI-7', checks: [{ claim: 'the gate is green', sinceMs }] }) as {
      checks: Array<{ claim: string; sinceMs?: number }>;
    };
    expect(parsed.checks[0]).toMatchObject({ claim: 'the gate is green', sinceMs });

    const json = z.toJSONSchema(checkpoint.args as never) as {
      $defs?: Record<string, unknown>;
      properties?: { checks?: { $ref?: string } };
    };
    const checksRef = json.properties?.checks?.$ref;
    const checks = (checksRef ? json.$defs?.[checksRef.slice('#/$defs/'.length)] : undefined) as
      | { items?: { properties?: Record<string, unknown> } }
      | undefined;
    expect(checks?.items?.properties?.sinceMs).toMatchObject({ type: 'number' });
  });

  it('publishes shared checkpoint and checks schemas once via defs and refs', () => {
    const json = z.toJSONSchema(checkpoint.args as never, { io: 'input' }) as {
      $defs?: Record<string, unknown>;
      properties?: {
        checkpoint?: { $ref?: string };
        checks?: { $ref?: string };
        items?: { items?: { properties?: { checkpoint?: { $ref?: string }; checks?: { $ref?: string } } } };
      };
    };
    const defs = json.$defs ?? {};
    const resolveRef = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      const ref = (value as Record<string, unknown>).$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return value;
      return defs[ref.slice('#/$defs/'.length)] ?? value;
    };
    const shorthandBodyRef = json.properties?.checkpoint?.$ref;
    const itemBodyRef = json.properties?.items?.items?.properties?.checkpoint?.$ref;
    const shorthandChecksRef = json.properties?.checks?.$ref;
    const itemChecksRef = json.properties?.items?.items?.properties?.checks?.$ref;

    expect(Object.keys(defs)).toEqual(
      expect.arrayContaining(['work-items-checkpoint-body-v1', 'work-items-checks-v1']),
    );
    expect(shorthandBodyRef).toBe('#/$defs/work-items-checkpoint-body-v1');
    expect(itemBodyRef).toBe(shorthandBodyRef);
    expect(shorthandChecksRef).toBe('#/$defs/work-items-checks-v1');
    expect(itemChecksRef).toBe(shorthandChecksRef);
    const hasSchemaField = (value: unknown, field: string): boolean => {
      value = resolveRef(value);
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      const properties = record.properties;
      if (properties && typeof properties === 'object' && field in properties) return true;
      return Object.values(record).some((child) => hasSchemaField(child, field));
    };
    expect(hasSchemaField(json.properties?.checks, 'replaces')).toBe(true);
    expect(hasSchemaField(json.properties?.items?.items, 'replaces')).toBe(true);
    const hasProbeSchemaRevision = (value: unknown): boolean => {
      value = resolveRef(value);
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      const properties = record.properties;
      if (properties && typeof properties === 'object') {
        const probe = (properties as Record<string, unknown>).probe;
        if (probe && hasSchemaField(probe, 'schemaRevision')) return true;
      }
      return Object.values(record).some(hasProbeSchemaRevision);
    };
    expect(hasProbeSchemaRevision(json.properties?.checks)).toBe(true);
    expect(hasProbeSchemaRevision(json.properties?.items?.items)).toBe(true);
    // Keep the published schema under 25 KiB. Exact length also counts constraint
    // metadata, so metadata-only changes should not break this structural-sharing guard.
    // The budget still catches the former duplicated-schema expansion (~10 KiB).
    expect(Buffer.byteLength(JSON.stringify(json), 'utf8')).toBeLessThan(25 * 1024);
  });

  it('keeps the parsed checkpoint output text-typed after exposing the structured input schema', () => {
    type ParsedArgs = z.output<typeof checkpoint.args>;
    expectTypeOf<ParsedArgs['checkpoint']>().toEqualTypeOf<string | null | undefined>();
  });

  it('accepts loop checkpoint aliases while canonical fields win, and rejects unrelated object keys', () => {
    const parsed = parse({
      id: 'WI-7',
      checkpoint: {
        did: 'progress',
        keyInsight: 'alias insight',
        insight: 'canonical insight',
        nextAction: 'alias next',
        goal: 'older goal alias',
        next: 'canonical next',
      },
    }) as { checkpoint: string };

    expect(parsed.checkpoint).toContain('## Key insight\ncanonical insight');
    expect(parsed.checkpoint).toContain('## Next action\ncanonical next');
    expect(parsed.checkpoint).not.toContain('alias insight');
    expect(parsed.checkpoint).not.toContain('alias next');
    expect(() => parse({ id: 'WI-7', checkpoint: { did: 'progress', notAField: 'drop me' } })).toThrow();
  });

  it('EI-23125773053698900: accepts loop carry aliases at the single-shorthand root', () => {
    const reporterShape = parse({
      id: 'EI-23116653414837836',
      workItem: 'ei-23116653414837836',
      checkpoint: 'canonical checkpoint wins',
      left: 'focused tests and terminal disposition',
      keyInsight: 'shared carry vocabulary',
      nextAction: 'run the focused suite',
    }) as { checkpoint: string; id: string; workItem: string };
    expect(reporterShape).toMatchObject({
      id: 'EI-23116653414837836',
      workItem: 'ei-23116653414837836',
      checkpoint: 'canonical checkpoint wins',
    });

    const aliasesOnly = parse({
      workItem: 'WI-7',
      did: 'implemented compatibility',
      left: 'verify it',
      keyInsight: 'root aliases now share the loop contract',
      nextAction: 'run Vitest',
    }) as { workItem: string };
    expect(aliasesOnly.workItem).toBe('WI-7');
    expect(() => parse({ id: 'WI-7', workItem: 'WI-8', checkpoint: 'wrong target' })).toThrow(
      /identify different work-items/,
    );
    expect(() => parse({ items: [{ id: 'WI-7', checkpoint: 'batch' }], nextAction: 'ignored before fix' })).toThrow(
      /single shorthand/,
    );
    expect(() => parse({ items: [{ id: 'WI-7', checkpoint: 'per-item' }], checkpoint: 'ignored root body' })).toThrow(
      /root-level checkpoint\/carry aliases/,
    );
  });

  it('publishes the root checkpoint and carry-alias exclusion for items[]', () => {
    const schema = z.toJSONSchema(checkpoint.args as never) as {
      'x-papercusp-call-constraint'?: string;
    };
    expect(schema['x-papercusp-call-constraint']).toContain('With `items[]`, omit root-level');
    for (const field of ['checkpoint', 'note', 'did', 'left', 'insight', 'next', 'workItem']) {
      expect(schema['x-papercusp-call-constraint']).toContain(`\`${field}\``);
    }
    expect(schema['x-papercusp-call-constraint']).toContain('`confirmShrink`');
    expect(schema['x-papercusp-call-constraint']).toContain('remain defaults for entries');
  });

  it('keeps terminal-only assumptions off the checkpoint contract', () => {
    expect(() => parse({ id: 'WI-7', checkpoint: 'progress', assumptions: 'none' })).toThrow();
  });

  it('renders a structured checkpoint before the handler persists it', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, text: string) => text);

    const r = await one({
      id: 'WI-7',
      checkpoint: { did: 'stored structured progress', nextAction: 'verify the focused test' },
    });

    expect(r).toMatchObject({ ok: true, cleared: false, verified: true });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      '## Did\nstored structured progress\n\n## Next action\nverify the focused test',
    );
  });

  it('EI-23125773053698900: renders root carry aliases and resolves workItem as the single id', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, text: string) => text);

    const r = await one({
      workItem: 'WI-7',
      did: 'stored root-shaped progress',
      left: 'verify the focused test',
      keyInsight: 'loop payloads can cross the work-item boundary',
      nextAction: 'run Vitest',
    } as never);

    expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: false, verified: true });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      '## Did\nstored root-shaped progress\n\n' +
        '## Left\nverify the focused test\n\n' +
        '## Key insight\nloop payloads can cross the work-item boundary\n\n' +
        '## Next action\nrun Vitest',
    );
  });

  describe('WI-10005640: items[] entries accept the same loop carry aliases as the single shorthand', () => {
    // Drift guard: the root and each entry used to be two hand-kept field lists. Every
    // alias the root accepts MUST also be accepted by an entry, so a future alias added
    // at one level and forgotten at the other fails here instead of as ~40 prod refusals.
    // Entries take the four CANONICAL carry fields only (the exact keys of all ~40 measured
    // refusals); keyInsight/nextAction/goal stay root-only compat aliases because every
    // declared property costs ~80 B in COMPACT delivery of a floor tool already over budget.
    const ENTRY_ALIASES = ['did', 'left', 'insight', 'next'] as const;
    const ROOT_ONLY_ALIASES = ['keyInsight', 'nextAction', 'goal'] as const;

    it.each(ENTRY_ALIASES)('parses `%s` on an items[] entry (and on the root)', (alias) => {
      expect(() => parse({ id: 'WI-7', [alias]: 'x' })).not.toThrow();
      expect(() => parse({ items: [{ id: 'WI-7', [alias]: 'x' }] })).not.toThrow();
    });

    it.each(ROOT_ONLY_ALIASES)('`%s` remains a root-only compat alias (entry refuses it)', (alias) => {
      expect(() => parse({ id: 'WI-7', [alias]: 'x' })).not.toThrow();
      expect(() => parse({ items: [{ id: 'WI-7', [alias]: 'x' }] })).toThrow();
    });

    it('still refuses root-level aliases combined with items[] (and names the entry-level route)', () => {
      expect(() => parse({ items: [{ id: 'WI-7', checkpoint: 'batch' }], did: 'x' })).toThrow(
        /single shorthand[\s\S]*did\/left\/insight\/next/,
      );
    });

    it('renders each entry\'s aliases into its stored checkpoint; explicit `checkpoint` wins', async () => {
      getWorkItem.mockImplementation(async (ref: { workItemId?: string; id?: string }) => ({
        id: ref?.workItemId ?? ref?.id ?? 'WI-A',
        harness: 'papercup',
      }));
      setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, text: string) => text);

      const e = await env({
        items: [
          { id: 'WI-A', did: 'did A', left: 'left A', insight: 'insight A', next: 'next A' },
          { id: 'WI-B', checkpoint: 'canonical B wins', did: 'ignored', next: 'ignored' },
        ],
      });

      expect(e.results).toHaveLength(2);
      expect(e.results[0]).toMatchObject({ ok: true, id: 'WI-A', cleared: false });
      expect(e.results[1]).toMatchObject({ ok: true, id: 'WI-B', cleared: false });
      const stored = setWorkItemCheckpoint.mock.calls.map((c: unknown[]) => c[1] as string);
      expect(stored).toContain('## Did\ndid A\n\n## Left\nleft A\n\n## Key insight\ninsight A\n\n## Next action\nnext A');
      expect(stored).toContain('canonical B wins');
      expect(stored.some((s: string) => s.includes('ignored'))).toBe(false);
    });
  });

  it('EI-21631530729522909: lifts a flattened executable tool probe into the nested probe field', () => {
    const probe = {
      kind: 'tool' as const,
      tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    const parsed = parse({
      id: 'WI-7',
      checks: [{ claim: 'gate is green', ...probe }],
    }) as { checks: Array<Record<string, unknown>> };

    expect(parsed.checks[0]).toEqual({ claim: 'gate is green', probe });
    // `kind` is the executable discriminator here, not a legacy claim alias;
    // the old `{kind, command, result}` compatibility path remains covered below.
    expect(parsed.checks[0]).not.toHaveProperty('kind');
  });

  it('accepts a 167-character flattened executable tool name at the shared identifier cap', () => {
    const probe = {
      kind: 'tool' as const,
      tool: WORK_ITEM_LONG_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(WORK_ITEM_LONG_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    expect(WORK_ITEM_LONG_CONTINUITY_TEST_TOOL).toHaveLength(167);
    expect(LIMITS.IDENT).toBeGreaterThanOrEqual(167);
    expect(() => parse({ id: 'WI-7', checks: [{ claim: 'long tool is accepted', ...probe }] })).not.toThrow();
  });

  it('EI-21674755057848047: accepts a NESTED probe whose kind is implied by `tool`', () => {
    // The canonical nested spelling used to be the ONE shape that bypassed the
    // normalizer, so it failed with a raw "Invalid discriminator value" while the
    // flattened envelope directly above it succeeded. Callers responded by
    // dropping `checks` entirely, which cost evidence rather than just a retry.
    const revision = continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL)!;
    const parsed = parse({
      id: 'WI-7',
      checks: [
        {
          claim: 'gate is green',
          probe: {
            tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
            args: { value: 'green' },
            schemaRevision: revision,
            expect: { path: '$.value', op: 'eq' as const, value: 'green' },
          },
        },
      ],
    }) as { checks: Array<Record<string, unknown>> };

    expect(parsed.checks[0]).toEqual({
      claim: 'gate is green',
      probe: {
        kind: 'tool',
        tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
        args: { value: 'green' },
        schemaRevision: revision,
        expect: { path: '$.value', op: 'eq', value: 'green' },
      },
    });
  });

  it('EI-21674755057848047: still REFUSES a nested probe with nothing to execute', () => {
    // `probe:{expect}` is not an under-specified probe — it is a claim with no
    // probe, and the row wants `recheck` instead. Inferring here would persist a
    // probe the caller never described.
    expect(() =>
      parse({
        id: 'WI-7',
        checks: [{ claim: 'gate is green', probe: { expect: { path: '$.value', op: 'eq' as const, value: 'green' } } }],
      }),
    ).toThrow(/discriminator/i);
  });

  it("keys the checkpoint by the ITEM's harness (looked up), disambiguated by the ctx hint", async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const out = await env({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(getWorkItem).toHaveBeenCalledWith('WI-7', 'papercup');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did step 1; next: step 2',
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7', harness: 'papercup', cleared: false });
    expect(out.results[0].length).toBeGreaterThan(0);
  });

  it('forwards the complete authoritative work-item subject to the checkpoint writer', async () => {
    const item = {
      id: 'WI-subject-forward',
      harness: 'papercusp',
      kind: 'bug',
      title: 'subject title',
      summary: 'subject summary',
      state: 'open',
    };
    getWorkItem.mockResolvedValue(item);
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'checkpoint body', priorLength: 0 });

    const result = await one({ id: item.id, checkpoint: 'checkpoint body' });

    expect(result).toMatchObject({ ok: true, id: item.id, verified: true });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledWith(
      { harness: item.harness, workItemId: item.id, workspaceId: 'default' },
      'checkpoint body',
      expect.objectContaining({ workItem: item }),
    );
  });

  it('clears the checkpoint with an explicit null (cleared:true)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-7', checkpoint: null });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      null,
    );
    expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: true, length: 0, contentHash: null });
  });

  it('EI-22041231879905297: rejects a body-less omission without metadata before reading or touching the store', async () => {
    const single = await one({ id: 'WI-7' });
    const bulk = await env({
      items: [{ id: 'WI-A' }, { id: 'WI-B', append: false }],
    });

    for (const result of [single, ...bulk.results]) {
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'checkpoint_required',
        retryable: true,
        recovery: { clear: { args: { checkpoint: null } } },
      });
      expect(result.error).toContain('checkpoint body was omitted');
    }
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('EI-21020695928840897: refuses accidental empty-string clears in both single and bulk shapes before touching the store', async () => {
    const single = await one({ id: 'WI-7', checkpoint: '' });
    const bulk = await env({
      items: [
        { id: 'WI-A', checkpoint: '' },
        { id: 'WI-B', checkpoint: ' \n\t ' },
      ],
    });

    for (const result of [single, ...bulk.results]) {
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'empty_checkpoint_requires_confirmation',
        retryable: true,
        recovery: {
          clear: { args: { checkpoint: null } },
          confirm: { args: { confirmClear: true } },
        },
      });
    }
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('EI-21020695928840897: preserves explicit null/clear:true and confirmed blank clears in single and bulk shapes', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue(null);

    const singleResults = await Promise.all([
      one({ id: 'WI-7', checkpoint: null }),
      one({ id: 'WI-7', clear: true }),
      one({ id: 'WI-7', checkpoint: ' \n', confirmClear: 'true' as unknown as boolean }),
    ]);
    const bulk = await env({
      items: [
        { id: 'WI-7', clear: true },
        { id: 'WI-7', checkpoint: '', confirmClear: true },
      ],
    });

    for (const result of [...singleResults, ...bulk.results]) {
      expect(result).toMatchObject({
        ok: true,
        id: 'WI-7',
        cleared: true,
        length: 0,
        contentHash: null,
      });
    }
  });

  it('EI-21020695928840897: clear:true rejects a contradictory non-blank checkpoint', async () => {
    const r = await one({ id: 'WI-7', checkpoint: 'keep this body', clear: true });
    expect(r).toMatchObject({ ok: false, errorCode: 'clear_with_checkpoint' });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('EI-8987: returns a contentHash of the STORED text on a real write (same-call round-trip proof)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r.contentHash).toEqual(expect.stringMatching(/^[0-9a-f]{12}$/));
    // Deterministic: the same stored text always hashes to the same value.
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r2 = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r2.contentHash).toBe(r.contentHash);
    // Different stored text hashes differently.
    setWorkItemCheckpoint.mockResolvedValue('a completely different checkpoint body');
    const r3 = await one({ id: 'WI-7', checkpoint: 'a completely different checkpoint body' });
    expect(r3.contentHash).not.toBe(r.contentHash);
  });

  it('EI-8987: contentHash is null when the write clears (nothing stored to hash)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-7', checkpoint: null });
    expect(r).toMatchObject({ ok: true, cleared: true, contentHash: null, verified: null, storedHead: null });
  });

  it('P-003: a write is VERIFY-READ via the reader path — verified:true + storedHead on the round-trip', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r).toMatchObject({ ok: true, verified: true, storedHead: 'did step 1; next: step 2' });
    // The read-back uses the SAME canonicalized ref as the write (harness + concrete ws).
    expect(getWorkItemCheckpoint).toHaveBeenCalledWith({
      harness: 'papercup',
      workItemId: 'WI-7',
      workspaceId: 'default',
    });
  });

  it('P-003: a write the reader path CANNOT see fails loudly (checkpoint_verify_failed), never silently', async () => {
    // The WI-3549 class: the store echoes the write but a future read resolves to a
    // different key (or nothing). The tool must fail THIS item at write time.
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('in-flight state');
    getWorkItemCheckpoint.mockResolvedValue(null); // reader path sees nothing
    const r = await one({ id: 'WI-7', checkpoint: 'in-flight state' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('checkpoint_verify_failed');
    expect(r.error).toContain('read back null');
    expect(r).toMatchObject({
      errorCode: 'checkpoint_verify_failed',
      retryable: false,
      writeCommitted: true,
      storedLength: 'in-flight state'.length,
      storedContentHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      readBackContentHash: null,
      recovery: {
        verify: {
          tool: 'work_items:get',
          args: { id: 'WI-7', harness: 'papercup', detail: true, threadLimit: 0 },
          expectedContentHash: expect.stringMatching(/^[0-9a-f]{12}$/),
        },
      },
    });
    expect(r.error).toContain('Do NOT retry this write');
  });

  it('EI-22707338795824591: preserves a verifier exception instead of reporting read back null or recommending a duplicate append', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    const prior = 'prior checkpoint body';
    let stored: string | null = null;
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, note: string, opts) => {
      const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
      stored = blockedReason ? prior : opts?.transform?.(prior, note) ?? note;
      return { stored, priorLength: prior.length, blockedReason };
    });
    getWorkItemCheckpoint.mockRejectedValueOnce(new Error('bounded verifier read timed out'));

    const r = await one({ id: 'WI-7', checkpoint: 'one append only', append: true });

    expect(r).toMatchObject({
      ok: false,
      errorCode: 'checkpoint_verify_unavailable',
      retryable: false,
      writeCommitted: true,
      storedLength: 'prior checkpoint body\n\n---\none append only'.length,
      storedContentHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      recovery: {
        verify: {
          tool: 'work_items:get',
          args: { id: 'WI-7', harness: 'papercup', detail: true, threadLimit: 0 },
          expectedContentHash: expect.stringMatching(/^[0-9a-f]{12}$/),
        },
      },
    });
    expect(r.error).toContain('bounded verifier read timed out');
    expect(r.error).toContain('Do NOT retry this write');
    expect(r.error).not.toContain('read back null');
    expect(stored).toBe('prior checkpoint body\n\n---\none append only');
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledTimes(1);
  });

  it('P-003: a read-back that returns DIFFERENT bytes also fails verification', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('fresh state');
    getWorkItemCheckpoint.mockResolvedValue('a stale prior checkpoint'); // wrong row wins the read
    const r = await one({ id: 'WI-7', checkpoint: 'fresh state' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('checkpoint_verify_failed');
  });

  it('P-003: storedHead caps at 80 chars', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    const long = 'x'.repeat(300);
    setWorkItemCheckpoint.mockResolvedValue(long);
    const r = await one({ id: 'WI-7', checkpoint: long });
    expect(r.ok).toBe(true);
    expect(r.storedHead).toHaveLength(80);
  });

  it('uses an explicit harness arg as the lookup hint over ctx', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'other-harness' });
    setWorkItemCheckpoint.mockResolvedValue('x');
    await one({ id: 'WI-7', checkpoint: 'x', harness: 'other-harness' });
    expect(getWorkItem).toHaveBeenCalledWith('WI-7', 'other-harness');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ harness: 'other-harness' }), 'x');
  });

  it('resolves the harness via a work-item lookup when neither arg nor ctx has one', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'looked-up' });
    setWorkItemCheckpoint.mockResolvedValue('y');
    const r = await one({ id: 'WI-9', checkpoint: 'y' }, noHarnessCtx);
    expect(getWorkItem).toHaveBeenCalledWith('WI-9', undefined);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ harness: 'looked-up' }), 'y');
    expect(r.ok).toBe(true);
  });

  it('EI-8805: keys a harness-null item by its OWN (null) harness, not the session harness', async () => {
    // Repro: a harness-null EI (filed from an unscoped su session) checkpointed from a
    // session that HAS a harness. The write must key under the item's null harness (the
    // store canonicalizes it to the wildcard namespace work_items:get reads under) —
    // previously it substituted the session harness ('papercup') and the read silently
    // got null, losing the continuity state.
    getWorkItem.mockResolvedValue({ id: 'EI-8797', harness: null });
    setWorkItemCheckpoint.mockResolvedValue('continuity state');
    const r = await one({ id: 'EI-8797', checkpoint: 'continuity state' }); // baseCtx harnessSlug 'papercup'
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: null, workItemId: 'EI-8797', workspaceId: 'default' },
      'continuity state',
    );
    expect(r).toMatchObject({ ok: true, id: 'EI-8797', harness: null, cleared: false });
  });

  it('EI-8805: an unscoped session (harnessSlug "*") also keys a harness-null item by its null harness', async () => {
    getWorkItem.mockResolvedValue({ id: 'EI-8797', harness: null });
    setWorkItemCheckpoint.mockResolvedValue('state');
    const unscoped = { ...noHarnessCtx, harnessSlug: '*' } as never;
    await one({ id: 'EI-8797', checkpoint: 'state' }, unscoped);
    // '*' is sanitized to no lookup hint, and the item's own null harness wins.
    expect(getWorkItem).toHaveBeenCalledWith('EI-8797', undefined);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: null, workItemId: 'EI-8797', workspaceId: 'default' },
      'state',
    );
  });

  it('refuses an unknown work item even when no harness hint is available', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404', checkpoint: 'z' }, noHarnessCtx);
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.id).toBe('WI-404');
    expect(r.errorCode).toBe('work_item_not_found');
  });

  it('does not write an orphan checkpoint when an unknown id has an explicit harness hint', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404', checkpoint: 'z', harness: 'papercup' });
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: false,
      id: 'WI-404',
      errorCode: 'work_item_not_found',
    });
    expect(r.error).toContain('Your checkpoint text was NOT saved');
  });

  it('EI-8824: an unscoped superuser session (ctx.workspaceId "*") never persists the literal wildcard — resolves to the concrete active workspace instead', async () => {
    // Repro: work_items:checkpoint from a `?superuser=1` session with no chosen
    // workspace passes ctx.workspaceId='*' (the read-scoping sentinel). Previously
    // `c.workspaceId ?? undefined` let the truthy '*' win and stored the checkpoint
    // under a literal workspace_id='*' row that work_items:get's checkpoint read
    // (which resolves via activeWorkspaceId(), and NEVER returns '*') could never see
    // — the checkpoint silently vanished on the next (especially post-compaction) read.
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('state');
    const superuserCtx = {
      uiClientId: 'su-1',
      sigVerifiedSpawn: true,
      workspaceId: '*',
      harnessSlug: 'papercup',
    } as never;
    await one({ id: 'WI-7', checkpoint: 'state' }, superuserCtx);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'resolved-concrete-ws' },
      'state',
    );
  });

  it('surfaces a store error cleanly via runBulk keyOf (batch survives)', async () => {
    setWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-7', checkpoint: 'x' });
    expect(r).toEqual({ ok: false, id: 'WI-7', error: 'pg down' });
  });

  it('maps a bounded transaction timeout per item so a batch avoids an unknown transport outcome', async () => {
    setWorkItemCheckpointWithPrior.mockRejectedValue(
      new OrgTxnTimeoutError('57014', new Error('statement timeout'), 'likely blocked by pid 42'),
    );

    const out = await env({
      items: [
        { id: 'WI-A', checkpoint: 'append A', append: true },
        { id: 'WI-B', checkpoint: 'append B', append: true },
      ],
    });

    expect(out.results).toEqual([
      expect.objectContaining({
        ok: false,
        id: 'WI-A',
        error: 'timeout',
        errorCode: 'timeout',
        retryable: true,
        pgCode: '57014',
        message: expect.stringContaining('NOT saved'),
      }),
      expect.objectContaining({
        ok: false,
        id: 'WI-B',
        error: 'timeout',
        errorCode: 'timeout',
        retryable: true,
        pgCode: '57014',
        message: expect.stringContaining('NOT saved'),
      }),
    ]);
    expect(out.counts).toEqual({ ok: 0, failed: 2 });
  });

  it('maps a bounded transaction acquisition deadline per item so a batch avoids an unknown transport outcome', async () => {
    setWorkItemCheckpointWithPrior.mockRejectedValue(
      new DbCallDeadlineError('boundedOrgTxn:acquire(admin)', 8_000, 8_000, 'org-admin'),
    );

    const out = await env({
      items: [
        { id: 'WI-acquire-A', checkpoint: 'append A', append: true },
        { id: 'WI-acquire-B', checkpoint: 'append B', append: true },
      ],
    });

    expect(out.results).toEqual([
      expect.objectContaining({
        ok: false,
        id: 'WI-acquire-A',
        error: 'timeout',
        errorCode: 'timeout',
        retryable: true,
        message: expect.stringContaining('NOT saved'),
      }),
      expect.objectContaining({
        ok: false,
        id: 'WI-acquire-B',
        error: 'timeout',
        errorCode: 'timeout',
        retryable: true,
        message: expect.stringContaining('NOT saved'),
      }),
    ]);
    expect(out.results[0]).not.toHaveProperty('pgCode');
    expect(out.results[1]).not.toHaveProperty('pgCode');
    expect(out.counts).toEqual({ ok: 0, failed: 2 });
  });

  it('items:[…] checkpoints many; per-item harness overrides; one bad item fails only itself', async () => {
    // WI-A and WI-C are absent. WI-B exists and its own harness is 'web'.
    setWorkItemCheckpoint.mockImplementation(async (key: { workItemId: string }) =>
      key.workItemId === 'WI-A' ? 'snap-a' : 'snap-b',
    );
    getWorkItem.mockImplementation(async (id: string) =>
      id === 'WI-B' ? { id, harness: 'web' } : null,
    );
    const out = await env(
      {
        items: [
          { id: 'WI-A', checkpoint: 'a' },
          { id: 'WI-B', checkpoint: 'b', harness: 'web' },
          { id: 'WI-C', checkpoint: 'c' },
        ],
      },
      noHarnessCtx, // WI-B's lookup hint disambiguates the existing item; WI-A/WI-C are missing
    );
    // The two absent items fail while the found WI-B uses its canonical harness and succeeds.
    // Envelope ok is DERIVED (`counts.failed === 0`), so one bad item doesn't undo the good write.
    expect(out.ok).toBe(false);
    expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-A', false],
      ['WI-B', true],
      ['WI-C', false],
    ]);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'web', workItemId: 'WI-B' }),
      'b',
    );
    expect(out.counts).toEqual({ ok: 1, failed: 2 });
  });

  it('items:[…] with a batch harness default applies to items that omit one', async () => {
    setWorkItemCheckpoint.mockResolvedValue('s');
    const out = await env(
      {
        harness: 'def',
        items: [
          { id: 'WI-1', checkpoint: 'a' },
          { id: 'WI-2', checkpoint: 'b', harness: 'web' },
        ],
      },
      noHarnessCtx,
    );
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ harness: 'def', workItemId: 'WI-1' }),
      'a',
    );
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ harness: 'web', workItemId: 'WI-2' }),
      'b',
    );
  });

  describe('EI-9036: append mode (join onto the existing checkpoint instead of replacing it)', () => {
    // The production store applies this transform against the authoritative prior
    // while holding the carry row lock. Model that contract in append fixtures:
    // the handler submits only the addendum and must not pre-read the body.
    const withLockedPrior = (priorNote: string | null) => {
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (_ref: unknown, note: string | null | undefined, opts?: { transform?: (prior: string | null, incoming: string | null | undefined) => string | null | undefined }) => {
          const transformed = opts?.transform ? opts.transform(priorNote, note) : note;
          const trimmed = (transformed ?? '').trim();
          return { stored: trimmed.length > 0 ? trimmed : null, priorLength: priorNote?.length ?? 0 };
        },
      );
    };

    it('append:true joins the new text onto the existing checkpoint with a --- separator', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = 'did step 1; next: step 2 (detailed 4-file build record)';
      withLockedPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: 'tsc came back clean', append: true });
      expect(setWorkItemCheckpointWithPrior.mock.calls.at(-1)?.[2]).toMatchObject({
        latestUpdate: 'tsc came back clean',
      });
      expect(setWorkItemCheckpointWithPrior.mock.calls.at(-1)?.[1]).toBe('tsc came back clean');
      const stored = (await setWorkItemCheckpointWithPrior.mock.results.at(-1)?.value as { stored: string }).stored;
      expect(stored).toBe(`${prior}\n\n---\ntsc came back clean`);
      expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: false, verified: true });
      // The detailed prior record survives verbatim inside the stored text — the exact
      // failure EI-9036 reported (an addendum call silently wiping it) cannot happen.
      expect(r.storedHead).toContain('detailed 4-file build record');
    });

    it('append:true keeps the addendum outside a trailing Walls section', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = withCarryNoteWalls('prior narrative', [
        { claim: 'the gate remains open', recheck: 'recheck the gate' },
      ]);
      withLockedPrior(prior);

      const r = await one({ id: 'WI-7', checkpoint: 'new progress', append: true });

      expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: false, verified: true });
      const stored = (await setWorkItemCheckpointWithPrior.mock.results.at(-1)?.value as { stored: string }).stored;
      expect(stored).toContain('prior narrative');
      expect(stored).toContain('new progress');
      expect(withoutRowIds(stored)).toContain('## Walls');
      expect(stored.indexOf('new progress')).toBeLessThan(stored.indexOf('## Walls'));
      expect(stored).toContain('the gate remains open');
    });

    it('append:true with NO prior checkpoint just stores the addendum as-is (no leading separator)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      withLockedPrior(null); // nothing stored yet
      const r = await one({ id: 'WI-7', checkpoint: 'first note', append: true });
      expect(setWorkItemCheckpointWithPrior.mock.calls.at(-1)?.[1]).toBe('first note');
      const stored = (await setWorkItemCheckpointWithPrior.mock.results.at(-1)?.value as { stored: string }).stored;
      expect(stored).toBe('first note');
      expect(r).toMatchObject({ ok: true, cleared: false });
    });

    // EI-22624970955266330: `appendBodyPreservationGuard` compared the STORED tail against
    // the RAW submission. `[turn:self]` is expanded server-side at write time — the very
    // thing the provenance lint on this tool instructs writers to use — so the stored tail
    // never equalled the raw text, endsWith() was false, and the write was refused
    // `append_body_overflow` while citing cap pressure that did not exist. Measured live
    // before the fix: an 87-char append onto a 12,855-char note was refused, while a
    // 290-char append with no sentinel onto a 9,754-char note was accepted — the length
    // ordering is inverted from what a genuine cap failure would produce.
    it('EI-22624970955266330: append:true accepts a body containing the [turn:self] sentinel (the guard compares the EXPANDED addendum)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      resolveCurrentTurnStamp.mockResolvedValueOnce({ ref: 'turn:abc123@2026-09-08T13:10:00.000Z' });
      withLockedPrior('prior narrative worth keeping');

      const r = await one({
        id: 'WI-7',
        checkpoint: 'refreshed [turn:self] — contract unchanged',
        append: true,
      });

      expect(r).toMatchObject({ ok: true, id: 'WI-7', verified: true });
      const stored = (await setWorkItemCheckpointWithPrior.mock.results.at(-1)?.value as { stored: string }).stored;
      expect(stored).toContain('prior narrative worth keeping');
      // CALIBRATION: the sentinel must actually have been EXPANDED, or this test would
      // pass vacuously — a run where the resolver returned null exercises none of the
      // guard behaviour this case exists to pin.
      expect(stored).toContain('turn:abc123@2026-09-08T13:10:00.000Z');
      expect(stored).not.toContain('[turn:self]');
    });

    it('EI-22624970955266330 CALIBRATION: an append with NO sentinel is unaffected (the resolver is never consulted)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      resolveCurrentTurnStamp.mockClear();
      withLockedPrior('prior narrative worth keeping');

      const r = await one({ id: 'WI-7', checkpoint: 'plain addendum, no sentinel', append: true });

      expect(r).toMatchObject({ ok: true, id: 'WI-7', verified: true });
      expect(resolveCurrentTurnStamp).not.toHaveBeenCalled();
      const stored = (await setWorkItemCheckpointWithPrior.mock.results.at(-1)?.value as { stored: string }).stored;
      expect(stored).toContain('plain addendum, no sentinel');
    });

    it('append:true rejects a confirmed blank checkpoint (append + clear is a contradiction) without touching the store', async () => {
      const r = await one({ id: 'WI-7', checkpoint: '', confirmClear: true, append: true });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('append:true requires a non-blank');
    });

    it('append:true still rejects an omitted checkpoint when no checks are supplied', async () => {
      const r = await one({ id: 'WI-7', append: true });
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('append:true requires a non-blank');
    });

    it('append:true trims superseded prior tail only when confirmShrink is explicit', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = '## MEASURED BASELINE\n' + 'P'.repeat(31970);
      const addendum = '## LATEST PROGRESS\n' + 'A'.repeat(40);
      let stored = '';
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string, opts) => {
        const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
        stored = blockedReason ? prior : opts?.transform?.(prior, text) ?? text;
        return { stored, priorLength: prior.length, blockedReason };
      });
      getWorkItemCheckpoint.mockImplementationOnce(async () => stored);
      const r = await one({ id: 'WI-7', checkpoint: addendum, append: true, confirmShrink: true });
      expect(r.ok).toBe(true);
      const storedArg = stored;
      expect(storedArg.length).toBeLessThanOrEqual(32000);
      // The measured baseline at the head survives; only superseded prior bytes are
      // represented by the visible marker before the new addendum.
      expect(storedArg.startsWith('## MEASURED BASELINE\n')).toBe(true);
      expect(storedArg).toContain('…[older checkpoint content truncated]…');
      // The newest addendum — the part the caller just wrote — remains complete.
      expect(storedArg.endsWith(addendum)).toBe(true);
    });

    it('confirmShrink:true cannot truncate the newly submitted append', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = '## MEASURED BASELINE\nshort prior';
      const progressPrefix = '## LATEST PROGRESS\n';
      // The submitted value must satisfy the 32,000-char input schema while the
      // prior note makes the joined candidate exceed the storage cap.
      const addendum = progressPrefix + 'A'.repeat(CHECKPOINT_BODY_CAP_CHARS - progressPrefix.length);
      let stored = prior;
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string, opts) => {
        const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
        stored = blockedReason ? prior : opts?.transform?.(prior, text) ?? text;
        return { stored, priorLength: prior.length, blockedReason };
      });

      const result = await one({ id: 'WI-7', checkpoint: addendum, append: true, confirmShrink: true });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'append_body_overflow',
        appendBodyOverflowDiagnostics: { submittedAppendChars: addendum.length },
      });
      expect(result.error).toContain('Refusing the write');
      expect(stored).toBe(prior);
    });

    it('EI-26833103898072347: refuses a capped append that retains the addendum but evicts prior narrative', async () => {
      getWorkItem.mockResolvedValue({ id: 'EI-268331-PRIOR-BODY-OVERFLOW', harness: 'papercusp' });
      const prior = '## VERIFIED HANDBACK\n' + 'P'.repeat(31970);
      const addendum = '## FINAL DISPOSITION\n' + 'A'.repeat(40);
      let stored = prior;
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string, opts) => {
        const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
        stored = blockedReason ? prior : opts?.transform?.(prior, text) ?? text;
        return { stored, priorLength: prior.length, blockedReason };
      });

      const result = await one({ id: 'EI-268331-PRIOR-BODY-OVERFLOW', checkpoint: addendum, append: true });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'append_prior_body_overflow',
        appendPriorBodyOverflowDiagnostics: {
          priorNarrativeChars: prior.length,
          submittedAppendChars: addendum.length,
          priorNarrativeRetained: false,
          submittedAppendRetained: true,
        },
      });
      expect(result.error).toContain('evict previously stored narrative');
      expect(stored).toBe(prior);
    });

    it('EI-18665443723911343: the shorthand `append` accepts the literal string "true"/"false" identically to a real boolean', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      // Previously: "expected boolean, received string" on this exact shorthand shape,
      // even though items:[{ ..., append: true }] accepted the identical value.
      const r = await one({
        id: 'WI-7',
        checkpoint: 'addendum via string append',
        append: 'true' as unknown as boolean,
      });
      expect(r.ok).toBe(true);
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
        expect.anything(),
        'addendum via string append',
      );
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1); // post-write verification only
    });

    it('EI-18665443723911343: the string "false" is NOT truthy-coerced (unlike z.coerce.boolean/Boolean()) — plain replace, no append', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('brand new note');
      const r = await one({ id: 'WI-7', checkpoint: 'brand new note', append: 'false' as unknown as boolean });
      expect(r.ok).toBe(true);
      // append:false behaves as no-append: a plain overwrite, not a join onto a prior
      // checkpoint. (getWorkItemCheckpoint is still called once, for the post-write
      // verify-read every write path goes through — that's unrelated to append mode.)
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'brand new note');
    });

    it('EI-18665443723911343: a non-boolean-ish string (not "true"/"false") still fails validation, unchanged', () => {
      expect(() => parse({ id: 'WI-7', checkpoint: 'x', append: 'yes' })).toThrow();
    });

    it('a per-item append:true overrides a batch-level append:false/omitted default, and vice versa', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      // Batch default append:true, no per-item override → still appends.
      const out = await env({ append: true, items: [{ id: 'WI-7', checkpoint: 'addendum' }] });
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'addendum');
      expect(out.results[0].ok).toBe(true);
    });

    it('plain replace-on-write (no append) is UNCHANGED: never reads the prior checkpoint, always overwrites', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('brand new note');
      const r = await one({ id: 'WI-7', checkpoint: 'brand new note' });
      // The default suite mock for getWorkItemCheckpoint only fires on the verify-read
      // (post-write); confirm no PRE-write read happened by checking call count is
      // exactly the verify-read's one call, not two.
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1);
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'brand new note');
      expect(r.ok).toBe(true);
    });
  });

  describe("EI-18132462898750489: ownership guard — no silent overwrite of a peer's held item", () => {
    // WI-6746: this ownership guard is derived ENTIRELY from the pre-write read —
    // setWorkItemCheckpoint has no assignee check of its own. While that read was
    // swallowed with `.catch(() => null)`, a PG fault made `item` null, which made the
    // `item && item.assignee && …` guard fall through, which let the write land on a
    // peer's item: precisely the corruption this EI added the guard to prevent, plus the
    // false "my write succeeded, so I must hold this" signal it names as the root cause
    // of a bogus "currently holding" directive surviving into a compaction summary.
    it('FAILS CLOSED when the ownership read THROWS — a PG fault must not bypass not_holder (WI-6746)', async () => {
      getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
      const r = await one(
        { id: 'WI-5557', checkpoint: 'write during a PG blip' },
        {
          ...(baseCtx as Record<string, unknown>),
          uiClientId: 'su-2e534e59-ceb6-48b5-87b8-3b362f652725',
        },
      );
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('work_item_unreadable');
      expect(r.error).toMatch(/connection terminated/);
      // Must not masquerade as the harness-resolution error, which sends the agent to
      // pass { harness } — a remedy that cannot fix an unhealthy database.
      expect(r.error).not.toMatch(/could not resolve a harness/);
    });

    it('an unreadable ownership read is refused even when a harness hint WAS supplied (WI-6746)', async () => {
      // The hint used to mask the failure: with `hintHarness` set, a null item skipped the
      // "could not resolve a harness" branch and fell straight through to the write.
      getWorkItem.mockRejectedValue(new Error('statement timeout'));
      const r = await one({ id: 'WI-5557', harness: 'papercup', checkpoint: 'note' });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('work_item_unreadable');
    });

    it('refuses a checkpoint write when the item is assigned to a DIFFERENT agent (not_holder)', async () => {
      getWorkItem.mockResolvedValue({
        id: 'WI-5557',
        harness: 'papercup',
        assignee: 'su-a7d08fd3-ba65-45d3-a07f-a335b9004454',
      });
      const r = await one(
        { id: 'WI-5557', checkpoint: "trying to write on a peer's item" },
        {
          ...(baseCtx as Record<string, unknown>),
          uiClientId: 'su-2e534e59-ceb6-48b5-87b8-3b362f652725',
        },
      );
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_holder');
      expect(r.error).toContain('su-a7d08fd3-ba65-45d3-a07f-a335b9004454');
    });

    it('refuses a CLEAR (blank checkpoint) on an item assigned to someone else too', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-5557', harness: 'papercup', assignee: 'someone-else' });
      const r = await one(
        { id: 'WI-5557', checkpoint: null },
        { ...(baseCtx as Record<string, unknown>), uiClientId: 'not-the-holder' },
      );
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_holder');
    });

    it('allows the write when the item is assigned to the CALLER itself', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', assignee: 'opspawn-bee-1' });
      setWorkItemCheckpoint.mockResolvedValue('my own progress');
      const r = await one({ id: 'WI-7', checkpoint: 'my own progress' });
      expect(r.ok).toBe(true);
    });

    it("EI-21921431863111143: allows the write when the item is assigned to a TRUNCATED PREFIX of the caller's own ownerId", async () => {
      // The exact repro: an upstream dispatch write persisted `opspawn-bee` (a strict
      // prefix of the caller's real `opspawn-bee-1`) instead of the canonical full
      // id — this used to deadlock as not_holder against a "peer" that never existed.
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', assignee: 'opspawn-bee' });
      setWorkItemCheckpoint.mockResolvedValue('my own progress, truncated assignee');
      const r = await one({ id: 'WI-7', checkpoint: 'my own progress, truncated assignee' });
      expect(r.ok).toBe(true);
      expect(setWorkItemCheckpoint).toHaveBeenCalled();
    });

    it('allows the write when the item is UNASSIGNED (about to be claimed)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', assignee: null });
      setWorkItemCheckpoint.mockResolvedValue('note before claiming');
      const r = await one({ id: 'WI-7', checkpoint: 'note before claiming' });
      expect(r.ok).toBe(true);
    });

    it("a mixed batch fails only the peer-held item; the caller's own item still writes", async () => {
      getWorkItem.mockImplementation(async (id: string) =>
        id === 'WI-MINE'
          ? { id: 'WI-MINE', harness: 'papercup', assignee: 'opspawn-bee-1' }
          : { id: 'WI-THEIRS', harness: 'papercup', assignee: 'someone-else' },
      );
      setWorkItemCheckpoint.mockResolvedValue('progress');
      const out = await env({
        items: [
          { id: 'WI-MINE', checkpoint: 'progress' },
          { id: 'WI-THEIRS', checkpoint: 'nope' },
        ],
      });
      expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
        ['WI-MINE', true],
        ['WI-THEIRS', false],
      ]);
      expect(out.results[1].error).toContain('not_holder');
    });
  });

  describe('EI-21035020852712365: terminal items cannot receive active checkpoints', () => {
    it('refuses a non-clear checkpoint on a terminal, unassigned item with a reopen path', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-DONE', harness: 'papercup', state: 'done', assignee: null });
      setWorkItemCheckpoint.mockResolvedValue('should not land');

      const r = await one({ id: 'WI-DONE', checkpoint: 'corrective work remains' });

      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('terminal_item');
      expect(r.error).toContain('already terminal');
      expect(r.recovery.reopen.args).toEqual({ state: 'open', force: true });
    });

    it('also refuses a non-clear checkpoint when the terminal item is assigned to the caller', async () => {
      getWorkItem.mockResolvedValue({
        id: 'WI-DONE',
        harness: 'papercup',
        state: 'dropped',
        assignee: 'opspawn-bee-1',
      });

      const r = await one({ id: 'WI-DONE', checkpoint: 'post-close edits' });

      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('terminal_item');
    });

    it('still allows an explicit clear on a terminal item for finish cleanup', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-DONE', harness: 'papercup', state: 'done', assignee: null });
      setWorkItemCheckpoint.mockResolvedValue(null);

      const r = await one({ id: 'WI-DONE', checkpoint: null });

      expect(r.ok).toBe(true);
      expect(r.cleared).toBe(true);
    });
  });

  describe('EI-19399101595349211: the mock must cover what checkpoint.ts actually imports', () => {
    /**
     * A `vi.mock` factory REPLACES the module wholesale, so the moment checkpoint.ts imports an
     * ADDITIONAL symbol from work-items, that symbol is `undefined` here, the call throws inside
     * the per-item runBulk callback — after a successful store write — and every test that
     * actually WRITES comes back ok:false.
     *
     * That has now happened three times (markIssueProgress / WI-2900, isClaimHoldParked / today).
     * What makes it expensive is that the failure names NOTHING: ~20 unrelated-looking tests go
     * red at once, none mentioning the symbol you just added, so the first hypothesis is always
     * "I broke the write path" rather than "my import list changed".
     *
     * This guard turns that into one failure that names the missing symbol. It is deliberately
     * source-parsing rather than type-level: the drift is between a RUNTIME object's keys and an
     * import list, which the compiler cannot see (the real module type-checks fine either way).
     */
    it('every symbol checkpoint.ts imports from work-items is provided by the mock', () => {
      const src = readFileSync(new URL('./checkpoint.ts', import.meta.url), 'utf8');
      const m = src.match(/import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/work-items'/);
      // A miss here means the import was reshaped (namespace/default/multi-line-with-comments).
      // Fail loudly rather than silently vacuously passing — a guard that quietly matches nothing
      // is worse than no guard, because it reads as coverage.
      expect(m, 'could not locate the work-items import in checkpoint.ts — update this guard').not.toBeNull();

      const imported = m![1]
        .split(',')
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      expect(imported.length).toBeGreaterThan(0);

      const provided = new Set(Object.keys(workItemsMocked));
      expect(imported.filter((name) => !provided.has(name))).toEqual([]);
    });
  });

  describe('EI-19395730805289668: pauseNotEnforcedWarning — a pause declared only in prose', () => {
    // The real 2026-08-03T02:05Z note, owner name stripped for the shipped-source identity lint.
    const PAUSE_NOTE =
      'P-001 (real gym corpus) — PAUSED at owner request [owner:redacted 2026-08-02 "find a good stopping point"]';

    const write = async (item: Record<string, unknown>, stored: string) => {
      getWorkItem.mockResolvedValue({ harness: 'papercup', ...item });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: null });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      return one({ id: (item.id as string) ?? 'WI-7', checkpoint: stored });
    };

    it('warns when the note declares an owner pause and the item has NO claim hold', async () => {
      const r = await write({ id: 'WI-7' }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeDefined();
      expect(r.pauseNotEnforcedWarning).toContain('work_items:hold_open');
    });

    it('stays SILENT when the item already carries a claim hold — the author did it right', async () => {
      const r = await write({ id: 'WI-7', payload: { _claimHold: true } }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('honours the legacy string form of the hold', async () => {
      const r = await write({ id: 'WI-7', payload: { _claimHold: 'true' } }, PAUSE_NOTE);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on an ordinary progress note', async () => {
      const r = await write({ id: 'WI-7' }, '## Did\nLanded the parser fix; 29/29 green.\n## Next\nP-005.');
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on prose that merely MENTIONS a pause (the false-positive class)', async () => {
      const r = await write({ id: 'WI-7' }, 'Do not touch p2p-ship/WI-3500/P-306 (paused). Continuing here.');
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on a CLEAR — there is no declaration left to enforce', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: null, priorLength: 400 });
      const r = await one({ id: 'WI-7', checkpoint: null });
      expect(r.cleared).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn when append-history explicitly resumes and clears an earlier pause', async () => {
      const historical = [
        PAUSE_NOTE,
        'RESUMED — superseding the earlier temporary pause. Pause hold cleared.',
      ].join('\n');
      const r = await write({ id: 'WI-7' }, historical);
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('refuses a missing item before inferring a pause hold from unknown state', async () => {
      // A definitive miss is not an unknown hold state: no checkpoint may be written to
      // an orphan carry_notes scope, and no pause warning may be derived from it.
      getWorkItem.mockResolvedValue(null);
      const r = await one({ id: 'WI-7', checkpoint: PAUSE_NOTE, harness: 'papercup' });
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('work_item_not_found');
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('never blocks the write — the checkpoint still stores and verifies', async () => {
      const r = await write({ id: 'WI-7' }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.verified).toBe(true);
      expect(r.length).toBe(PAUSE_NOTE.length);
    });
  });

  describe('EI-9325: shrinkWarning nudge on a suspicious plain-replace shrink', () => {
    it('warns when a plain replace shrinks a substantial prior checkpoint by more than half', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = '[PRIOR CONTENT PRESERVED — omitted for size]';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 23608 });
      getWorkItemCheckpoint.mockResolvedValue(stored); // verify-read echoes the write
      const r = await one({ id: 'WI-7', checkpoint: stored });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeDefined();
      expect(r.shrinkWarning).toContain('23608 chars previously stored');
      expect(r.shrinkWarning).toContain('EI-9325');
    });

    it('does NOT warn on a plain replace that is not a big shrink', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = 'a fresh, reasonably detailed note';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 40 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const r = await one({ id: 'WI-7', checkpoint: stored });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });

    it('does NOT warn when the prior checkpoint was small (not "substantial")', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      // Prior was only 100 chars — shrinking to 10 is not the "detailed record
      // accidentally truncated" failure mode this nudge targets.
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'x', priorLength: 100 });
      getWorkItemCheckpoint.mockResolvedValue('x');
      const r = await one({ id: 'WI-7', checkpoint: 'x' });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });

    // P-007: every path now goes through setWorkItemCheckpointWithPrior (the plain
    // setWorkItemCheckpoint was only a wrapper over it), so the clear/append paths
    // also get the prior length and the declared-dependency stamping. What these two
    // assert is the INVARIANT that survived the unification — a clear and an append
    // must never arm the shrink guard — rather than which function got called.
    it('does NOT warn on a clear (nothing to compare) and never arms the guard', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: null, priorLength: 19348 });
      const r = await one({ id: 'WI-7', checkpoint: null }); // explicit clear
      expect(r.ok).toBe(true);
      expect(r.cleared).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, unknown, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('does NOT warn on a normal atomic append with a substantial locked prior', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = 'P'.repeat(5000);
      let stored = '';
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string, opts) => {
        const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
        stored = blockedReason ? prior : opts?.transform?.(prior, text) ?? text;
        return { stored, priorLength: prior.length, blockedReason };
      });
      getWorkItemCheckpoint.mockImplementationOnce(async () => stored);
      const r = await one({ id: 'WI-7', checkpoint: 'short addendum', append: true });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
      expect(stored).toBe(`${prior}\n\n---\nshort addendum`);
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [
        unknown,
        unknown,
        { guard?: (n: string | null, l: number) => string | null },
      ];
      expect(call[2].guard).toBeTypeOf('function');
      expect(call[2].guard!(prior, prior.length)).toBeNull();
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1); // post-write verification only
    });

    it('the default suite delegate (no override) never produces a shrinkWarning — priorLength:0 never trips the threshold', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('anything at all');
      const r = await one({ id: 'WI-7', checkpoint: 'anything at all' });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });
  });

  describe('EI-18140632570924965: a plain-replace shrink is BLOCKED by default (shrink_blocked), not just warned', () => {
    it('blocks the write when setWorkItemCheckpointWithPrior reports blockedReason — no progress bump, no verify-read', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-4487', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({
        stored: '19348-char forensic record, unchanged',
        priorLength: 19348,
        blockedReason:
          'plain replace would shrink the checkpoint from 19348 to 12 chars (>50% loss). Pass { append: true } ' +
          'to join onto the existing checkpoint instead, or { confirmShrink: true } if this replace is intentional.',
      });
      const r = await one({ id: 'WI-4487', checkpoint: 'short status' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('shrink_blocked');
      expect(r.error).toContain('19348');
      expect(r).toMatchObject({
        errorCode: 'shrink_blocked',
        recovery: {
          append: { args: { append: true } },
          replace: { args: { append: false, confirmShrink: true } },
        },
      });
      // Blocked ⇒ no read-after-write verification and no progress-anchor bump attempt.
      expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
    });

    it('EI-20232176364474286: a concise plain refresh retries as an atomic append after the guard refuses it', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-202309', harness: 'papercup' });
      const prior = 'the detailed prior forensic checkpoint '.repeat(60);
      let stored: string | null = prior;
      let calls = 0;
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          incoming: string | null | undefined,
          opts?: {
            guard?: (priorNote: string | null, priorLength: number) => string | null;
            transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
          },
        ) => {
          calls += 1;
          if (calls === 1) {
            const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
            return Promise.resolve({ stored: prior, priorLength: prior.length, blockedReason });
          }
          const next = opts?.transform ? opts.transform(prior, incoming) : incoming;
          stored = (next ?? '').trim() || null;
          return Promise.resolve({ stored, priorLength: prior.length });
        },
      );
      // The handler's verify-read must see the text the retry actually stored.
      getWorkItemCheckpoint.mockImplementation(async () => stored);

      const r = await one({ id: 'WI-202309', checkpoint: 'fresh concise status' });
      expect(r).toMatchObject({ ok: true, autoAppended: true });
      expect(stored).toContain(prior.trim());
      // EI-21472322403787688: newest-FIRST. The old order (`prior\n\n---\nfresh`)
      // buried the caller's authoritative note at the tail while storedHead — and
      // every cold-wake excerpt that reads the head — showed superseded content.
      expect(stored).toMatch(/^fresh concise status\n\n---\n/);
      expect(r.storedHead?.startsWith('fresh concise status')).toBe(true);
      expect(calls).toBe(2);
      const retry = setWorkItemCheckpointWithPrior.mock.calls[1] as [
        unknown,
        unknown,
        { guard?: unknown; transform?: unknown },
      ];
      expect(retry[2].guard).toBeUndefined();
      expect(retry[2].transform).toBeTypeOf('function');
    });

    /**
     * EI-20745229385305334 — the WI-39655 repro. The preserve-by-default is inverted for a
     * checkpoint that RETRACTS its own prior conclusion: a correction is systematically
     * shorter than the investigation it supersedes, so the shrink guard fires hardest
     * exactly when appending resurrects a directive the author was withdrawing.
     */
    const RETRACTED_DIRECTIVE =
      'do NOT re-apply the ornith backfill until a real stopped-unit request serves a completion';

    /** The two-phase guard→append mock the autoAppend path needs, parameterised by prior. */
    const arrangeAutoAppend = (prior: string) => {
      let stored: string | null = prior;
      let calls = 0;
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          incoming: string | null | undefined,
          opts?: {
            guard?: (priorNote: string | null, priorLength: number) => string | null;
            transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
          },
        ) => {
          calls += 1;
          if (calls === 1) {
            const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
            return Promise.resolve({ stored: prior, priorLength: prior.length, blockedReason });
          }
          const next = opts?.transform ? opts.transform(prior, incoming) : incoming;
          stored = (next ?? '').trim() || null;
          return Promise.resolve({ stored, priorLength: prior.length });
        },
      );
      getWorkItemCheckpoint.mockImplementation(async () => stored);
      return () => stored;
    };

    it('EI-20745229385305334: an auto-append that PRESERVES a standing directive says so in retraction terms', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-39655', harness: 'papercup' });
      const prior = `${'the detailed prior forensic investigation. '.repeat(40)}\n${RETRACTED_DIRECTIVE}`;
      arrangeAutoAppend(prior);

      // The retraction: shorter than the investigation, which is what trips the guard.
      const r = await one({
        id: 'WI-39655',
        checkpoint: 'Backfill APPLIED: a real stopped-unit request served a completion.',
      });

      expect(r).toMatchObject({ ok: true, autoAppended: true });
      // The joined reading — not a generic tagging nit, but "you resurrected an instruction".
      expect(r.autoAppendedNote).toContain('STANDING DIRECTIVE');
      expect(r.autoAppendedNote).toContain(RETRACTED_DIRECTIVE);
      expect(r.autoAppendedNote).toContain('confirmShrink:true');
      // Structured sibling, so a caller need not parse the prose.
      expect(r.autoAppendedRetainedDirectives).toEqual([
        expect.objectContaining({ line: RETRACTED_DIRECTIVE, kind: 'bare-gate-imperative' }),
      ]);
    });

    it('EI-20745229385305334 CALIBRATION: an auto-append preserving only narrative gets NO directive warning', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-39656', harness: 'papercup' });
      // Same shape and length as the case above, minus the imperative — so a passing
      // assertion there cannot be the warning simply always firing on an auto-append.
      const prior = `${'the detailed prior forensic investigation. '.repeat(40)}\nthe backfill remains reverted for now.`;
      arrangeAutoAppend(prior);

      const r = await one({
        id: 'WI-39656',
        checkpoint: 'Backfill APPLIED: a real stopped-unit request served a completion.',
      });

      expect(r).toMatchObject({ ok: true, autoAppended: true });
      expect(r.autoAppendedNote).not.toContain('STANDING DIRECTIVE');
      expect(r.autoAppendedRetainedDirectives).toBeUndefined();
    });

    it('EI-20745229385305334: a directive the CALLER re-supplied is not reported as resurrected history', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-39657', harness: 'papercup' });
      const prior = `${'the detailed prior forensic investigation. '.repeat(40)}\n${RETRACTED_DIRECTIVE}`;
      arrangeAutoAppend(prior);

      // Carrying the directive FORWARD deliberately is the opposite of retracting it.
      // retainedProvenanceText subtracts by exact trimmed LINE, so the directive must be
      // re-supplied as its own line to be recognised as re-stated rather than inherited —
      // re-stating it mid-sentence leaves the prior's standalone line genuinely retained,
      // and it is still reported (measured, not assumed).
      const r = await one({
        id: 'WI-39657',
        checkpoint: `Still blocked.\n${RETRACTED_DIRECTIVE}`,
      });

      expect(r).toMatchObject({ ok: true, autoAppended: true });
      expect(r.autoAppendedRetainedDirectives).toBeUndefined();
    });

    it('the guard callback passed to setWorkItemCheckpointWithPrior blocks only a >50% shrink off a substantial (>500 char) prior', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'short new note', priorLength: 20000 });
      getWorkItemCheckpoint.mockResolvedValue('short new note');
      await one({ id: 'WI-7', checkpoint: 'short new note' });
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [
        unknown,
        string,
        { guard?: (n: string | null, l: number) => string | null },
      ];
      const guard = call[2].guard!;
      expect(guard(null, 20000)).toMatch(/plain replace would shrink/); // 14-char new text vs 20000 prior
      expect(guard(null, 100)).toBeNull(); // prior not "substantial" (<=500)
      expect(guard(null, 501)).not.toBeNull(); // just over the substantial floor, still a >50% shrink
    });

    it('confirmShrink:true omits the guard entirely — the destructive replace proceeds (still gets the EI-9325 warning)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-4487', harness: 'papercup' });
      const stored = 'short status';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 19348 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const r = await one({ id: 'WI-4487', checkpoint: stored, confirmShrink: true });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeDefined();
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, string, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('append:true joins a large checkpoint using the locked prior, without a separate pre-read', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = 'P'.repeat(20000);
      let stored = '';
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string, opts) => {
        const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
        stored = blockedReason ? prior : opts?.transform?.(prior, text) ?? text;
        return { stored, priorLength: prior.length, blockedReason };
      });
      getWorkItemCheckpoint.mockImplementationOnce(async () => stored);
      const r = await one({ id: 'WI-7', checkpoint: 'short addendum', append: true });
      expect(r.ok).toBe(true);
      expect(stored).toBe(`${prior}\n\n---\nshort addendum`);
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1); // post-write verification only
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [
        unknown,
        unknown,
        { guard?: (n: string | null, l: number) => string | null },
      ];
      expect(call[2].guard).toBeTypeOf('function');
      expect(call[2].guard!(prior, prior.length)).toBeNull();
    });

    it('EI-22801779900317365: append_body_overflow reports prose, check-row, submitted, and remaining-capacity chars separately', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-228017-DIAGNOSTIC', harness: 'papercup' });
      // No prior narrative means this oversized append has no earlier body to evict;
      // keep this fixture focused on the submitted-body overflow diagnostics.
      const prior = withCarryNoteChecks('', [
        { claim: 'the carried check remains', recheck: 'read the carried evidence', verified: 'measured' },
      ]);
      getWorkItemCheckpoint.mockResolvedValue(prior);
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          _text: string,
          opts?: { guard?: (n: string | null, l: number) => string | null },
        ) => {
          const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
          return { stored: prior, priorLength: prior.length, blockedReason };
        },
      );
      const submitted = 'N'.repeat(CHECKPOINT_BODY_CAP_CHARS);

      const result = await one({
        id: 'WI-228017-DIAGNOSTIC',
        checkpoint: submitted,
        append: true,
      });
      const carriedProseChars = splitCarryNoteChecks(prior).body.length;

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'append_body_overflow',
        appendBodyOverflowDiagnostics: {
          carriedProseChars,
          carriedCheckRowChars: prior.length - carriedProseChars,
          submittedAppendChars: submitted.length,
          remainingCapacityChars: CHECKPOINT_BODY_CAP_CHARS - prior.length,
        },
      });
      expect(result.error).toContain(`carried prose occupies ${carriedProseChars} chars`);
      expect(result.error).toContain(`carried check rows occupy ${prior.length - carriedProseChars} chars`);
      expect(result.error).toContain(`the submitted append occupies ${submitted.length} chars`);
      expect(result.error).toContain(`remaining capacity before this append is ${CHECKPOINT_BODY_CAP_CHARS - prior.length}`);
    });

    describe('EI-25882323366169485: append joins from the authoritative locked prior', () => {
      it('does not let an empty pre-read strand an append when a large prior exists', async () => {
        getWorkItem.mockResolvedValue({ id: 'EI-25800299430454847', harness: 'papercusp' });
        const prior = 'P'.repeat(30295);
        let stored: string | null = null;
        setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, note: string, opts) => {
          const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
          stored = blockedReason ? prior : opts?.transform?.(prior, note) ?? note;
          return { stored, priorLength: prior.length, blockedReason };
        });
        // Before the fix this read ran BEFORE the write to construct the joined note
        // and returned null, causing append_base_unreadable. Now the only read is the
        // post-write verifier, which sees the note produced by the locked transform.
        getWorkItemCheckpoint.mockImplementationOnce(async () => stored);

        const r = await one({
          id: 'EI-25800299430454847',
          harness: 'papercusp',
          checkpoint: 'append correction',
          append: true,
        });

        expect(r).toMatchObject({ ok: true, id: 'EI-25800299430454847', verified: true });
        expect(stored).toBe(`${prior}\n\n---\nappend correction`);
        expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1); // post-write verification only
      });

      it('does not block a genuinely fresh item with no prior checkpoint at all (priorLength 0)', async () => {
        getWorkItem.mockResolvedValue({ id: 'WI-NEW', harness: 'papercup' });
        setWorkItemCheckpointWithPrior.mockImplementation(
          async (_ref: unknown, _text: string, opts?: { guard?: (n: string | null, l: number) => string | null }) => {
            const blockedReason = opts?.guard ? (opts.guard(null, 0) ?? undefined) : undefined;
            return { stored: 'first note', priorLength: 0, blockedReason };
          },
        );
        const r = await one({ id: 'WI-NEW', checkpoint: 'first note', append: true });
        expect(r.ok).toBe(true);
      });

      // EI-20283744332352340 — the guard keyed off `wantsAppend`, but a checks-only
      // patch performs no join, so a missing addendum means "never attempted", not
      // "the two paths disagree". Every
      // checks-only patch against a >500-char checkpoint was refused, and the
      // refusal's own recovery block pointed at `confirmShrink:true` — the
      // destructive replace this guard exists to prevent. Reproduced live on
      // WI-38258 (22,058 chars), including with `harness` passed explicitly, which
      // is what rules out the filed item's stated `harness` hypothesis.
      it('does NOT block a checks-only additive patch — no join or pre-read is needed', async () => {
        getWorkItem.mockResolvedValue({ id: 'WI-38258', harness: 'papercup' });
        const priorNote = 'D'.repeat(22058);
        setWorkItemCheckpointWithPrior.mockImplementation(
          async (
            _ref: unknown,
            text: string | undefined,
            opts?: {
              guard?: (n: string | null, l: number) => string | null;
              transform?: (n: string | null, text: string) => string | null | undefined;
            },
          ) => {
            const blockedReason = opts?.guard ? (opts.guard(priorNote, priorNote.length) ?? undefined) : undefined;
            // The body is preserved by the store's transform, which reads the
            // authoritative prior itself — the caller sent no `checkpoint` text.
            expect(text).toBeUndefined();
            const stored = blockedReason ? priorNote : (opts?.transform?.(priorNote, priorNote) ?? priorNote);
            return { stored, priorLength: priorNote.length, blockedReason };
          },
        );
        const r = await one({
          id: 'WI-38258',
          append: true,
          checks: [{ claim: 'the deploy has not landed', recheck: 'dev:pipeline_position' }],
        });
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        // Body preserved byte-for-byte, with the supplied row rendered onto it.
        expect(r.storedHead ?? '').toContain('DDDD');
      });
    });

    it('a per-item confirmShrink:true overrides a batch-level default of false/omitted', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = 'tiny';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 5000 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const out = await env({ items: [{ id: 'WI-7', checkpoint: stored, confirmShrink: true }] });
      expect(out.results[0].ok).toBe(true);
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, string, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('a mixed batch: a concise shrink recovers on its own, siblings still write', async () => {
      getWorkItem.mockImplementation(async (id: string) => ({ id, harness: 'papercup' }));
      const storedById = new Map<string, string>();
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          ref: { workItemId: string },
          text: string,
          opts?: {
            guard?: (n: string | null, l: number) => string | null;
            transform?: (n: string | null, text: string) => string | null | undefined;
          },
        ) => {
          const prior = text === 'clobber' ? 'P'.repeat(19348) : null;
          const priorLength = prior?.length ?? 0;
          const blockedReason = opts?.guard ? (opts.guard(prior, priorLength) ?? undefined) : undefined;
          const stored = blockedReason ? prior : opts?.transform ? opts.transform(prior, text) : text;
          storedById.set(ref.workItemId, stored ?? '');
          return { stored, priorLength, blockedReason };
        },
      );
      getWorkItemCheckpoint.mockImplementation(
        async (ref: { workItemId: string }) => storedById.get(ref.workItemId) ?? null,
      );
      const out = await env({
        items: [
          { id: 'WI-BLOCKED', checkpoint: 'clobber' },
          { id: 'WI-FINE', checkpoint: 'fine, brand new note' },
        ],
      });
      expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
        ['WI-BLOCKED', true],
        ['WI-FINE', true],
      ]);
      expect(out.results[0].autoAppended).toBe(true);
    });
  });

  /**
   * EI-19298690705878336 — verified-vs-asserted marking on the work-item checkpoint.
   *
   * The gap: a checkpoint could carry a confident factual claim with nothing marking
   * whether it had been CHECKED, and it re-injects on every later invocation of the
   * item in the author's own voice — so a wrong claim reads as better-established each
   * time rather than more suspect. It matters more here than on the loop note, because
   * a work-item checkpoint is what an unrelated SUCCESSOR inherits.
   *
   * These drive the REAL merge: the store mock applies the `transform` the tool passes,
   * mirroring setCarryNoteWithPrior's own post-transform handling (trim; blank ⇒ null),
   * so the rows go through genuine render → parse → re-render round-trips.
   */
  describe('checks (verified-vs-asserted marking)', () => {
    const withPrior = (priorNote: string | null) => {
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          cp: string | null | undefined,
          opts?: { transform?: (p: string | null, n: string | null | undefined) => string | null | undefined },
        ) => {
          const effective = opts?.transform ? opts.transform(priorNote, cp) : cp;
          const trimmed = (effective ?? '').trim();
          return { stored: trimmed.length > 0 ? trimmed : null, priorLength: (priorNote ?? '').length };
        },
      );
    };
    const lastStored = async (): Promise<string | null> =>
      ((await setWorkItemCheckpointWithPrior.mock.results.at(-1)!.value) as { stored: string | null }).stored;

    const carriedRowIdsFor = async (claims: string[]): Promise<string[]> => {
      const rows = splitCarryNoteChecks(await lastStored()).checks;
      return claims.map((claim) => rows.find((row) => row.claim === claim)?.id ?? claim);
    };

    it('P-007 persists IDs for unkeyed rows and preserves identity, evidence and age across rewrites', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'first body', checks: [
        { claim: 'measured claim', recheck: 'probe measured', verified: 'measurement recorded' },
        { claim: 'another claim', recheck: 'probe another' },
      ] });
      const first = await lastStored();
      const rows = splitCarryNoteChecks(first).checks;
      expect(rows.map(row => row.id)).toEqual([expect.any(String), expect.any(String)]);
      expect(new Set(rows.map(row => row.id)).size).toBe(2);

      withPrior(first);
      await one({ id: 'WI-7', checkpoint: 'second body', rowsMode: 'replace',
        checks: [{ id: rows[0]!.id, claim: 'measured claim with tighter wording' }] });
      const secondRows = splitCarryNoteChecks(await lastStored()).checks;
      expect(secondRows).toHaveLength(2);
      expect(secondRows[0]).toMatchObject({ ...rows[0], claim: 'measured claim with tighter wording' });
      expect(secondRows[1]).toEqual(rows[1]);
    });

    it('P-007 keyed rows require their ID to retire; claim text cannot remove them', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'protected evidence', verified: 'observed' }] });
      const prior = await lastStored();
      const id = splitCarryNoteChecks(prior).checks[0]!.id!;
      expect(id).toEqual(expect.any(String));

      withPrior(prior);
      const refused = await one({ id: 'WI-7', checks: [], rowsMode: 'replace', retireIds: ['protected evidence'] });
      expect(refused).toMatchObject({ ok: false, errorCode: 'checkpoint_retire_ids_mismatch' });
      withPrior(prior);
      const retired = await one({ id: 'WI-7', checks: [], rowsMode: 'replace', retireIds: [id] });
      expect(retired).toMatchObject({ ok: true, checks: 0 });
      expect(await lastStored()).toBe('body');
    });

    it.each([{ clear: true }, { checkpoint: '', confirmClear: true }])(
      'P-007 body clear %j preserves omitted check IDs and evidence', async (clearArgs) => {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'narrative to clear', checks: [{ claim: 'carried proof', verified: 'observed' }] });
        const prior = await lastStored();
        withPrior(prior);
        expect(await one({ id: 'WI-7', ...clearArgs })).toMatchObject({ ok: true, checks: 1, cleared: false });
        const stored = await lastStored();
        expect(stored).not.toContain('narrative to clear');
        expect(splitCarryNoteChecks(stored).checks).toEqual(splitCarryNoteChecks(prior).checks);
      },
    );

    beforeEach(() => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    });

    it('accepts boolean compatibility rows without inventing verification evidence', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'boolean compatibility',
        checks: [
          { claim: 'true without evidence stays predicted', recheck: 'run probe A', verified: true },
          { claim: 'false stays predicted', recheck: 'run probe B', verified: false },
          {
            claim: 'false stays predicted even with stray evidence',
            recheck: 'run probe B2',
            verified: false,
            evidence: 'contradictory evidence must not override false',
          },
          {
            claim: 'true with evidence becomes verified',
            recheck: 'run probe C',
            verified: true,
            evidence: 'observed probe C pass',
          },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ? true without evidence stays predicted');
      expect(withoutRowIds(stored)).toContain('- ? false stays predicted');
      expect(withoutRowIds(stored)).toContain('- ? false stays predicted even with stray evidence');
      expect(stored).not.toContain('contradictory evidence must not override false');
      expect(withoutRowIds(stored)).toContain('- ✓ true with evidence becomes verified');
      expect(stored).toContain('evidence: observed probe C pass');
    });

    it('round-trips predicted evidence through the observed slot without rendering a verified glyph', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'predicted audit context',
        checks: [
          {
            id: 'p002-current-scorecard-audits',
            claim: 'P-002 adequacy audits are terminal',
            recheck: 'read all gradingAudit.state values',
            status: 'predicted',
            evidence: 'Pending with advancing reservations',
          },
          {
            id: 'p004-current-measurement',
            claim: 'P-004 has a current measurement',
            recheck: 'read the newest measurement artifact',
            status: 'predicted',
            evidence: 'Prior artifact is stale',
          },
        ],
      });

      expect(r).toMatchObject({ ok: true, checks: 2 });
      const stored = await lastStored();
      const checks = splitCarryNoteChecks(stored).checks;
      expect(checks).toEqual([
        expect.objectContaining({
          id: 'p002-current-scorecard-audits',
          observed: expect.stringContaining('Pending with advancing reservations'),
        }),
        expect.objectContaining({
          id: 'p004-current-measurement',
          observed: expect.stringContaining('Prior artifact is stale'),
        }),
      ]);
      expect(checks.every((check) => check.verified === undefined)).toBe(true);
      expect(stored).not.toContain('- ✓ [#p002-current-scorecard-audits]');
      expect(stored).not.toContain('- ✓ [#p004-current-measurement]');
    });

    it('EI-21828094173087688: accepts boolean `ok` compatibility rows in shorthand checks', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'ok alias compatibility',
        checks: [
          {
            claim: 'ok true with evidence is verified',
            recheck: 'run probe A',
            ok: true,
            evidence: 'observed probe A pass',
          },
          {
            claim: 'ok false with stray evidence stays predicted',
            recheck: 'run probe B',
            ok: false,
            evidence: 'discarded because the result was false',
          },
          {
            claim: 'ok true without evidence stays predicted',
            recheck: 'run probe C',
            ok: true,
          },
        ],
      });

      expect(r).toMatchObject({ ok: true, checks: 3 });
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ ok true with evidence is verified');
      expect(stored).toContain('evidence: observed probe A pass');
      expect(withoutRowIds(stored)).toContain('- ? ok false with stray evidence stays predicted');
      expect(withoutRowIds(stored)).toContain('- ? ok true without evidence stays predicted');
      expect(stored).not.toContain('discarded because the result was false');
    });

    it('accepts descriptive label/name rows and preserves an explicit canonical claim', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'descriptive row compatibility',
        checks: [
          {
            label: 'labelled claim',
            status: 'verified',
            evidence: 'observed labelled claim',
          },
          { name: 'named claim' },
          {
            claim: 'canonical claim',
            label: 'ignored label',
            name: 'ignored name',
            status: 'verified',
            evidence: 'observed canonical claim',
          },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ labelled claim');
      expect(stored).toContain('evidence: observed labelled claim');
      expect(withoutRowIds(stored)).toContain('- ? named claim');
      expect(withoutRowIds(stored)).toContain('- ✓ canonical claim');
      expect(stored).not.toContain('ignored label');
      expect(stored).not.toContain('ignored name');
      expect(r.checks).toBe(3);
    });

    it('EI-20234792018972820: accepts documented probe aliases alongside boolean verified rows', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'probe alias compatibility',
        checks: [
          {
            claim: 'probe alias true with evidence becomes verified',
            probe: 'run probe alias A',
            verified: true,
            evidence: 'observed probe alias A pass',
          },
          {
            claim: 'probe alias false stays predicted',
            probe: 'run probe alias B',
            verified: false,
            evidence: 'contradictory probe alias evidence must be discarded',
          },
          {
            claim: 'canonical recheck wins over probe alias',
            probe: 'ignored probe alias',
            recheck: 'canonical recheck command',
            verified: true,
            evidence: 'canonical evidence',
          },
        ],
      });

      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ probe alias true with evidence becomes verified — re-check: run probe alias A');
      expect(stored).toContain('evidence: observed probe alias A pass');
      expect(withoutRowIds(stored)).toContain('- ? probe alias false stays predicted — re-check: run probe alias B');
      expect(stored).not.toContain('contradictory probe alias evidence must be discarded');
      expect(withoutRowIds(stored)).toContain('- ✓ canonical recheck wins over probe alias — re-check: canonical recheck command');
      expect(stored).not.toContain('ignored probe alias');
      expect(r.checks).toBe(3);
    });

    it('EI-21311156936925867: accepts structured kind/command/result rows through the handler', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'structured verification compatibility',
        checks: [
          {
            kind: 'the checkpoint handler regression passes',
            command: 'npm run test:file -- packages/operator-core/lib/agent-tools/work_items/checkpoint.test.ts',
            result: 'handler regression passed with the structured row intact',
          },
          {
            kind: 'ignored kind',
            command: 'ignored command',
            result: 'ignored result',
            claim: 'canonical claim wins',
            recheck: 'canonical recheck wins',
            verified: 'canonical evidence wins',
          },
        ],
      });

      expect(r).toMatchObject({ ok: true, checks: 2 });
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ the checkpoint handler regression passes');
      expect(stored).toContain(
        're-check: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/checkpoint.test.ts',
      );
      expect(stored).toContain('evidence: handler regression passed with the structured row intact');
      expect(withoutRowIds(stored)).toContain('- ✓ canonical claim wins');
      expect(stored).toContain('re-check: canonical recheck wins');
      expect(stored).toContain('evidence: canonical evidence wins');
      expect(stored).not.toContain('ignored kind');
      expect(stored).not.toContain('ignored command');
      expect(stored).not.toContain('ignored result');
    });

    it('persists a flattened executable probe after normalizing it to the canonical nested shape', async () => {
      withPrior(null);
      const probe = {
        kind: 'tool' as const,
        tool: WORK_ITEM_CONTINUITY_TEST_TOOL,
        args: { value: 'green' },
        schemaRevision: continuityProbeRevision(WORK_ITEM_CONTINUITY_TEST_TOOL)!,
        expect: { path: '$.value', op: 'eq' as const, value: 'green' },
      };
      const r = await one({
        id: 'WI-7',
        checkpoint: 'flattened executable probe compatibility',
        checks: [{ claim: 'gate is green', ...probe }],
      });

      expect(r).toMatchObject({ ok: true, checks: 1 });
      const stored = await lastStored();
      expect(splitCarryNoteChecks(stored).checks).toEqual([
        { id: expect.any(String), claim: 'gate is green', probe, sinceMs: expect.any(Number) },
      ]);
    });

    it('EI-21268881673610011: accepts a bare-string shorthand checks list through the handler', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'string shorthand evidence list',
        checks: [
          'the checkpoint write succeeded',
          { claim: 'object rows still work beside strings', recheck: 'run probe S' },
          'stored note carries every rendered row',
        ],
      });

      expect(r).toMatchObject({ ok: true, checks: 3 });
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ? the checkpoint write succeeded');
      expect(withoutRowIds(stored)).toContain('- ? object rows still work beside strings — re-check: run probe S');
      expect(withoutRowIds(stored)).toContain('- ? stored note carries every rendered row');
    });

    it('applies the same boolean compatibility repair inside items[]', async () => {
      withPrior(null);
      const out = await env({
        items: [
          {
            id: 'WI-7',
            checkpoint: 'nested boolean compatibility',
            checks: [{ claim: 'nested row', recheck: 'run nested probe', verified: false }],
          },
        ],
      });
      expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7' });
      expect(withoutRowIds(await lastStored())).toContain('- ? nested row');
    });

    it('EI-21828094173087688: accepts boolean `ok` compatibility rows inside items[]', async () => {
      withPrior(null);
      const out = await env({
        items: [
          {
            id: 'WI-7',
            checkpoint: 'nested ok alias compatibility',
            checks: [
              {
                claim: 'nested ok true with evidence is verified',
                recheck: 'run nested probe A',
                ok: true,
                evidence: 'observed nested probe A pass',
              },
            ],
          },
        ],
      });

      expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7', checks: 1 });
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ nested ok true with evidence is verified');
      expect(stored).toContain('evidence: observed nested probe A pass');
    });

    it('renders ✓ for a claim WITH evidence and ? for one without — the whole point of the field', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'mid-refactor',
        checks: [
          { claim: 'gate is green', recheck: 'npm run test:file -- x.test.ts', verified: 'ran 21:30Z, 24/24 pass' },
          { claim: 'the deploy will pick this up', recheck: 'dev:pipeline_position { path }' },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('## Checks');
      // VERIFIED carries its evidence; PREDICTED carries only its probe.
      expect(withoutRowIds(stored)).toContain('- ✓ gate is green');
      expect(stored).toContain('evidence: ran 21:30Z, 24/24 pass');
      expect(withoutRowIds(stored)).toContain('- ? the deploy will pick this up');
      // The count is read back off what was STORED, not off the input.
      expect(r.checks).toBe(2);
    });

    it('ACCEPTS an explicit `contested` row — schema parity with loop:checkpoint (EI-21234745917984459)', async () => {
      // The storage/normalize/render layer already supported `contested` end to end:
      // CARRY_ROW_SOFT_CAPS.contested exists, normalizeCheckEntries is imported from
      // ../../carry-note (the SAME normalizer loop:checkpoint uses) and already reads
      // `verified ?? contested`, and renderCheckLine already emits ⚠. ONLY this tool's
      // strict row schema rejected the key, so an identical payload was valid on one
      // carry surface and `invalid_args` on the other — the same shape as the `id` gap
      // WI-7264 closed, one field over. Until this, the only route to the CONTESTED tier
      // here was smuggling a magic phrase through `verified` and relying on the
      // findVerificationConflict auto-downgrade: implicit where the sibling is explicit.
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'mid-verification',
        checks: [
          {
            claim: 'the suite is green',
            recheck: 'npm run test:file -- x.test.ts',
            contested: 'STILL RUNNING at 09:15Z',
          },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ⚠ the suite is green');
      expect(stored).toContain('evidence: STILL RUNNING at 09:15Z');
      // The whole point of the tier: it must NEVER read as the affirmative one.
      expect(stored).not.toContain('- ✓ the suite is green');
    });

    it('ACCEPTS completion-style `testResult` as verified evidence (EI-22575327388783364)', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'focused validation',
        checks: [
          {
            claim: 'the focused checkpoint test passes',
            recheck: 'npm run test:file -- checkpoint.test.ts',
            testResult: '8/8 tests passed',
          },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ the focused checkpoint test passes');
      expect(stored).toContain('evidence: 8/8 tests passed');
    });

    it('CARRIES ROWS FORWARD across a plain replace that drops the body — the silent-drop guard', async () => {
      // A rewrite that does not re-state the checks must not lose them: that silent
      // drop is exactly how a claim outlives the probe that would falsify it.
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'first body',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }],
      });
      const prior = await lastStored();
      expect(withoutRowIds(prior)).toContain('- ✓ X holds');

      withPrior(prior);
      const r2 = await one({ id: 'WI-7', checkpoint: 'second body, fully rewritten' });
      const stored2 = await lastStored();
      expect(stored2).toContain('second body, fully rewritten');
      expect(stored2).not.toContain('first body');
      expect(withoutRowIds(stored2)).toContain('- ✓ X holds');
      expect(r2.checks).toBe(1);
    });

    describe('P-013 parity: a checks row carries the same optional stable `id` loop:checkpoint accepts', () => {
      it('accepts `id` on a checks row instead of rejecting the WHOLE call as invalid_args', () => {
        // The regression: the storage/merge/render layer below already keyed rows by
        // `id` (carryRowKey), but THIS tool's strict schema rejected the field — so the
        // same payload was valid on loop:checkpoint and invalid_args here, and every
        // sibling row in the call was discarded with it.
        expect(() =>
          parse({ id: 'WI-7', checkpoint: 'body', checks: [{ id: 'gate-green', claim: 'gate is green' }] }),
        ).not.toThrow();
      });

      it('CONTROL: the row schema is still STRICT — an undeclared field is rejected', () => {
        // Without this, the assertion above would also pass if `id` were merely being
        // silently stripped as an unknown key, which is a different (and worse) bug.
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'x', notAField: 'y' }] })).toThrow();
      });

      it('uses the id as the row IDENTITY, so re-wording a claim under the same id keeps ONE row', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ id: 'gate-green', claim: 'gate is green', recheck: 'probe gate' }],
        });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          rowsMode: 'merge',
          checks: [{ id: 'gate-green', claim: 'gate is green at HEAD', recheck: 'probe gate', verified: 'saw green' }],
        })) as { checks: number; checksDropped?: string[] };
        const stored = await lastStored();
        expect(r.checks).toBe(1);
        expect(r.checksDropped).toBeUndefined();
        expect(stored).toContain('gate is green at HEAD');
        expect(stored).not.toContain('gate is green\n');
      });

      it('agrees with loop:checkpoint on the id bound at BOTH edges, so the contracts cannot drift again', async () => {
        const { CARRY_ROW_ID_MAX, CARRY_CAP_HARD_MULTIPLE } = await import('../../carry-note');
        const hardMax = CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE;
        const loopCheckpoint = (await import('../loop/checkpoint')).default as {
          args: { parse: (x: unknown) => unknown };
        };
        const wiVerdict = (id: string) => {
          try {
            parse({ id: 'WI-7', checkpoint: 'body', checks: [{ id, claim: 'c' }] });
            return 'accepted';
          } catch {
            return 'rejected';
          }
        };
        const loopVerdict = (id: string) => {
          try {
            (loopCheckpoint.args as { parse: (x: unknown) => unknown }).parse({ checks: [{ id, claim: 'c' }] });
            return 'accepted';
          } catch {
            return 'rejected';
          }
        };
        // Both edges: at the bound and one char over. Asserting only the accept side
        // would pass against a schema with no bound at all.
        for (const [len, expected] of [
          [hardMax, 'accepted'],
          [hardMax + 1, 'rejected'],
        ] as const) {
          const id = 'a'.repeat(len);
          expect(wiVerdict(id)).toBe(expected);
          expect(loopVerdict(id)).toBe(expected);
        }
      });

      it('publishes the same soft row caps as loop:checkpoint while retaining the hard backstop', async () => {
        type JsonNode = { [key: string]: unknown };
        const { CARRY_ROW_ID_MAX } = await import('../../carry-note');
        const schemaOf = (candidate: unknown) => {
          const args = (candidate as { args: { toJSONSchema: () => unknown } }).args;
          const schema = args.toJSONSchema() as JsonNode;
          const resolveRef = (value: unknown): JsonNode => {
            if (!value || typeof value !== 'object') return value as JsonNode;
            const ref = (value as JsonNode).$ref;
            if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return value as JsonNode;
            return (
              (schema.$defs as Record<string, JsonNode> | undefined)?.[ref.slice('#/$defs/'.length)] ??
              (value as JsonNode)
            );
          };
          const checks = resolveRef((schema.properties as JsonNode).checks);
          const rows = resolveRef(checks.items);
          return rows.properties as Record<string, JsonNode>;
        };
        const loopCheckpoint = (await import('../loop/checkpoint')).default;
        const workItemRows = schemaOf(checkpoint);
        const loopRows = schemaOf(loopCheckpoint);

        const idCaps = {
          maxLength: CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE,
          'x-soft-maxLength': CARRY_ROW_ID_MAX,
        };
        expect(workItemRows.id).toMatchObject(idCaps);
        expect(loopRows.id).toMatchObject(idCaps);
        expect(workItemRows.id.description).toContain(`Soft cap: ${CARRY_ROW_ID_MAX} chars`);
        expect(loopRows.id.description).toContain(`Hard input backstop: ${idCaps.maxLength} chars`);

        for (const field of ['claim', 'recheck', 'verified'] as const) {
          const softCap = CARRY_ROW_SOFT_CAPS[field];
          const expected = { maxLength: softCap * CARRY_CAP_HARD_MULTIPLE, 'x-soft-maxLength': softCap };
          expect(workItemRows[field]).toMatchObject(expected);
          expect(loopRows[field]).toMatchObject(expected);
        }
      });
    });

    describe('EI-23771449112267271: a checks row carries a FALSIFIER and a sample-adequacy state', () => {
      it('accepts `falsifier` and `sampleAdequate` on BOTH checkpoint tools (same verdict, so the contracts cannot drift)', async () => {
        const loopCheckpoint = (await import('../loop/checkpoint')).default as {
          args: { parse: (x: unknown) => unknown };
        };
        const row = { claim: 'queue stays shallow', recheck: 'probe queue', falsifier: 'depth >= 500', sampleAdequate: false };
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', checks: [row] })).not.toThrow();
        expect(() => loopCheckpoint.args.parse({ checks: [row] })).not.toThrow();
      });

      it('CONTROL: `sampleAdequate` is a boolean on both tools — a string is rejected, so the accept above is not a silent strip', async () => {
        const loopCheckpoint = (await import('../loop/checkpoint')).default as {
          args: { parse: (x: unknown) => unknown };
        };
        const row = { claim: 'queue stays shallow', sampleAdequate: 'no' };
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', checks: [row] })).toThrow();
        expect(() => loopCheckpoint.args.parse({ checks: [row] })).toThrow();
      });

      it('persists the falsifier in the stored checkpoint, and a re-sent claim that omits it inherits it', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'X holds', recheck: 'probe X', falsifier: 'X reads 0 twice', verified: 'saw X' }],
        });
        const prior = await lastStored();
        expect(prior).toContain('falsifier: X reads 0 twice');

        withPrior(prior);
        await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', verified: 'saw X again' }] });
        expect(await lastStored()).toContain('falsifier: X reads 0 twice');
      });

      it('warns (falsifierMissing) for a verified row written WITHOUT a falsifier, and stays silent when it has one', async () => {
        type Receipt = { falsifierMissing?: { flagged: true; note: string; rows: string[] } };
        withPrior(null);
        const bare = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }],
        })) as Receipt;
        expect(bare.falsifierMissing?.flagged).toBe(true);
        expect(bare.falsifierMissing?.rows).toEqual(['X holds']);

        withPrior(null);
        const withOne = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'X holds', recheck: 'probe X', falsifier: 'X reads 0 twice', verified: 'saw X' }],
        })) as Receipt;
        expect(withOne.falsifierMissing).toBeUndefined();
      });

      it('sampleAdequate:false stores the evidence as CONTEXT on a ? row — never a verified tick — and is exempt from the advisory', async () => {
        type Receipt = { falsifierMissing?: unknown };
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw 3 and 4, both under the threshold', sampleAdequate: false }],
        })) as Receipt;
        const stored = await lastStored();
        expect(stored).toContain('sample inconclusive: saw 3 and 4, both under the threshold');
        // Judge the ROW line, not the whole body: the checks legend itself contains a tick.
        const row = (stored ?? '').split('\n').find((line) => line.includes('X holds'));
        expect(row).toMatch(/^- \? /);
        expect(row).not.toContain('✓');
        expect(r.falsifierMissing).toBeUndefined();
      });

      it('accepts replaces and sampleAdequate in batched items[].checks', async () => {
        const prior = withCarryNoteChecks('prior batch body', [
          { claim: 'prior batch check', recheck: 'run prior probe' },
        ]);
        withPrior(prior);

        const out = await env({
          items: [
            {
              id: 'WI-7',
              checkpoint: 'updated batch body',
              checks: [
                {
                  claim: 'updated batch check',
                  replaces: 'prior batch check',
                  recheck: 'run updated probe',
                  verified: 'observed one sample, which is inconclusive',
                  sampleAdequate: false,
                },
              ],
            },
          ],
        });

        expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7', checks: 1 });
        const stored = await lastStored();
        expect(stored).toMatch(/- \? (?:\[#[-a-z0-9]+\] )?updated batch check/);
        expect(stored).toContain('sample inconclusive: observed one sample, which is inconclusive');
        expect(stored).not.toContain('prior batch check');
      });
    });

    // P-013 (EI-20281899810081153) moved the DEFAULT to rowsMode:'merge' on BOTH
    // checkpoint tools, under which an empty list is a documented NO-OP — the tool says
    // so in its own `rowsModeNote`. Clearing is therefore an explicit-replace act now.
    it("checks:[] under rowsMode:'replace' clears the rows explicitly", async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: 'body', checks: [], rowsMode: 'replace', confirmRetire: true, retireIds: await carriedRowIdsFor(["X holds"]) });
      const stored = await lastStored();
      expect(stored).not.toContain('## Checks');
      expect(stored).not.toContain('X holds');
      expect(r.checks).toBe(0);
    });

    it('a narrative CLEAR preserves carried checks until individually retired', async () => {
      // Terminal completion calls the store directly. This checkpoint rewrite
      // clears prose while the carried evidence remains available to successors.
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'body',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }],
      });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: null });
      expect(r.ok).toBe(true);
      expect(r.cleared).toBe(false);
      expect(await lastStored()).toContain('X holds');
      expect(await lastStored()).not.toContain('body');
      expect(r.checks).toBe(1);
    });

    /**
     * EI-19447043119380534: `checks` supplied while `checkpoint` is ENTIRELY OMITTED
     * used to render a body-less note — a 9376-char checkpoint became 1562 chars of
     * bare `## Checks`, returning ok:true. Two properties made it the worst shape:
     * within ONE call an omitted `checks` PRESERVES while an omitted `checkpoint`
     * DESTROYED, and the >50% shrink guard never armed (it requires a non-empty
     * replacement body, which this path by definition does not have).
     *
     * These three pin the fix AND the two contracts it must not break — an explicit
     * clear stays reachable, and the terminal-cleanup clear is untouched.
     */
    it('EI-19447043119380534: `checks` with `checkpoint` OMITTED is a checks-only PATCH — the body SURVIVES', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the full plan: A, then B, then C — and the file-by-file record of what landed',
        checks: [{ claim: 'X holds', recheck: 'probe X' }],
      });
      const prior = await lastStored();
      expect(prior).toContain('the full plan: A, then B, then C');
      expect(withoutRowIds(prior)).toContain('- ? X holds');

      // The reported call: promote one check to VERIFIED, touching nothing else.
      withPrior(prior);
      const r = await one({
        id: 'WI-7',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'ran probe X at 16:20Z' }],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      // The body is the whole point: it must still be there.
      expect(stored).toContain('the full plan: A, then B, then C');
      expect(stored).toContain('the file-by-file record of what landed');
      expect(withoutRowIds(stored)).toContain('- ✓ X holds');
      expect(stored).toContain('evidence: ran probe X at 16:20Z');
      expect(r.cleared).not.toBe(true);
    });

    it('EI-21282889275455257: a near-cap checks-only patch refuses before evicting the body', async () => {
      const checks = [{ claim: 'near-cap check holds', recheck: 'run the near-cap probe' }];
      const renderedChecks = withCarryNoteChecks('', checks);
      const prior = 'B'.repeat(32000 - renderedChecks.length + 1);
      expect(prior.length).toBeLessThanOrEqual(32000);
      expect(withCarryNoteChecks(prior, checks).length).toBeGreaterThan(32000);

      let current = prior;
      let writes = 0;
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          incoming: string | null | undefined,
          opts?: {
            guard?: (priorNote: string | null, priorLength: number) => string | null;
            transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
          },
        ) => {
          const blockedReason = opts?.guard?.(current, current.length) ?? undefined;
          if (blockedReason) return { stored: current, priorLength: current.length, blockedReason };
          writes += 1;
          const next = opts?.transform ? opts.transform(current, incoming) : incoming;
          current = typeof next === 'string' && next.trim().length > 0 ? next : '';
          return { stored: current || null, priorLength: prior.length };
        },
      );

      const r = (await one({ id: 'WI-7', checks })) as {
        ok: boolean;
        error?: string;
        errorCode?: string;
        recovery?: { append?: { args?: unknown } };
      };

      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('checks_body_overflow');
      expect(r.error).toContain('evicting the oldest narrative content');
      expect(r.recovery?.append).toMatchObject({ args: { checks: [] } });
      expect(writes).toBe(0);
      expect(current).toBe(prior);
    });

    it('EI-20252594592830798: append:true with checks and no checkpoint is an additive checks-only patch', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the detailed body that must survive an additive checks refresh',
        checks: [{ claim: 'existing check holds', recheck: 'run existing check' }],
      });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({
        id: 'WI-7',
        append: true,
        checks: [{ claim: 'new check holds', recheck: 'run the new check' }],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('the detailed body that must survive');
      expect(stored).toContain('existing check holds');
      expect(stored).toContain('new check holds');
      expect(stored).not.toContain('\n\n---\n');
      expect(r.checks).toBe(2);
    });

    describe("P-013 rowsMode:'merge' compatibility", () => {
      it("accepts rowsMode:'merge' in the single and bulk shapes", () => {
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', rowsMode: 'merge' })).not.toThrow();
        expect(() => parse({ items: [{ id: 'WI-7', checkpoint: 'body', rowsMode: 'merge' }] })).not.toThrow();
      });

      it('merges supplied checks while replacing the body, without dropping carried rows', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'first body',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B', verified: 'saw B' },
          ],
        });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'rewritten body',
          rowsMode: 'merge',
          checks: [{ claim: 'C holds', recheck: 'probe C' }],
        })) as { ok: boolean; rowsMode?: string; checks: number; checksDropped?: string[] };
        const stored = await lastStored();

        expect(r).toMatchObject({ ok: true, rowsMode: 'merge', checks: 3 });
        expect(r.checksDropped).toBeUndefined();
        expect(stored).toContain('rewritten body');
        expect(stored).not.toContain('first body');
        expect(stored).not.toContain('\n\n---\n');
        expect(stored).toContain('A holds');
        expect(stored).toContain('B holds');
        expect(stored).toContain('C holds');
      });

      it("treats rowsMode:'merge' with checks:[] as a no-op and reports the mode", async () => {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'first body', checks: [{ claim: 'A holds', recheck: 'probe A' }] });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'updated body',
          rowsMode: 'merge',
          checks: [],
        })) as { ok: boolean; rowsMode?: string; rowsModeNote?: string; checks: number };
        const stored = await lastStored();

        expect(r).toMatchObject({ ok: true, rowsMode: 'merge', checks: 1 });
        expect(r.rowsModeNote).toContain('NO-OP');
        expect(stored).toContain('updated body');
        expect(stored).toContain('A holds');
      });
    });

    it('EI-19447043119380534: a checks-only patch that CLEARS the rows (checks:[]) still keeps the body', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the body worth keeping',
        checks: [{ claim: 'X holds', recheck: 'probe X' }],
      });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checks: [], rowsMode: 'replace', confirmRetire: true, retireIds: await carriedRowIdsFor(["X holds"]) });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('the body worth keeping');
      expect(stored).not.toContain('## Checks');
      expect(r.checks).toBe(0);
    });

    describe("WI-42106 rowsMode:'replace' retirement confirmation", () => {
      const THREE = [
        { claim: 'gate is green', recheck: 'state:read' },
        { claim: 'main is at abc123', recheck: 'git rev-parse main' },
        { claim: 'deploy landed', recheck: 'release:trace' },
      ];

      async function seedThree() {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'prior body', checks: THREE });
        return lastStored();
      }

      it('preserves omitted checks during a replace-style write without retireIds', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        getWorkItemCheckpoint.mockClear();
        const before = setWorkItemCheckpointWithPrior.mock.calls.length;
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body',
          checks: [{ claim: 'a brand new claim' }],
          rowsMode: 'replace',
        });
        expect(r).toMatchObject({ ok: true, checks: 4 });
        expect(r.checksDropped).toBeUndefined();
        const stored = await lastStored();
        for (const row of THREE) expect(stored).toContain(row.claim);
        expect(setWorkItemCheckpointWithPrior.mock.calls.length).toBe(before + 1);
        expect(getWorkItemCheckpoint).toHaveBeenCalled();
      });

      it('confirmShrink changes the body without retiring omitted checks', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const before = setWorkItemCheckpointWithPrior.mock.calls.length;
        const r = await one({
          id: 'WI-7',
          checkpoint: 'refreshed evidence snapshot',
          checks: [{ claim: 'replacement check', recheck: 'read replacement' }],
          rowsMode: 'replace',
          confirmShrink: true,
        });

        expect(r).toMatchObject({ ok: true, checks: 4 });
        expect(r.checksDropped).toBeUndefined();
        const stored = await lastStored();
        for (const row of THREE) expect(stored).toContain(row.claim);
        expect(setWorkItemCheckpointWithPrior.mock.calls.length).toBe(before + 1);
      });

      it('accepts the same retirement with confirmRetire:true and still reports the dropped rows', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body',
          checks: [{ claim: 'a brand new claim' }],
          rowsMode: 'replace',
          confirmRetire: true, retireIds: await carriedRowIdsFor(["gate is green","main is at abc123","deploy landed"]),
        });
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toEqual(['gate is green', 'main is at abc123', 'deploy landed']);
      });

      it('confirmRetire:true preserves omitted checks while appending a body', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        getWorkItemCheckpoint.mockClear();

        const r = await one({
          id: 'WI-7',
          checkpoint: 'append narrative while replacing checks',
          append: true,
          checks: [{ claim: 'replacement check' }],
          rowsMode: 'replace',
          confirmRetire: true,
        });

        expect(r).toMatchObject({ ok: true, checks: 4 });
        expect(r.checksDropped).toBeUndefined();
        const stored = await lastStored();
        for (const row of THREE) expect(stored).toContain(row.claim);
        expect(stored).toContain('append narrative while replacing checks');
      });

      it('an empty replace-style list preserves its carried checks', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({ id: 'WI-7', checks: [], rowsMode: 'replace' });
        expect(r).toMatchObject({ ok: true, checks: 3 });
        expect(r.checksDropped).toBeUndefined();
        expect(withoutRowIds(await lastStored())).toBe(withoutRowIds(prior));
      });

      it('does not require confirmation when replace keeps every carried row', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({ id: 'WI-7', checkpoint: 'new body', checks: THREE, rowsMode: 'replace' });
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toBeUndefined();
      });

      // EI-21923095696933477: retireIds is a STRONGER, opt-in alternative to
      // confirmRetire — it names the exact rows a replace intends to retire and
      // refuses on any mismatch, so a row the caller never saw (a compaction
      // excerpt showed only a subset) can never be dropped by a blind
      // confirmRetire:true.
      it('EI-21923095696933477: accepts a replace with retireIds naming exactly the dropped rows, without confirmRetire', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body',
          checks: [{ claim: 'a brand new claim' }],
          rowsMode: 'replace',
          retireIds: await carriedRowIdsFor(['gate is green', 'main is at abc123', 'deploy landed']),
        });
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toEqual(['gate is green', 'main is at abc123', 'deploy landed']);
      });

      it('keeps explicit rowsMode replace independent from append body joining', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body appended after the prior note',
          append: true,
          rowsMode: 'replace',
          checks: [{ claim: 'replacement check' }],
          retireIds: await carriedRowIdsFor(['gate is green', 'main is at abc123', 'deploy landed']),
        });

        expect(r.ok).toBe(true);
        expect(r.checksDropped).toEqual(['gate is green', 'main is at abc123', 'deploy landed']);
        const stored = await lastStored();
        expect(stored).toContain('prior body');
        expect(stored).toContain('new body appended after the prior note');
        expect(stored).not.toContain('gate is green');
        expect(stored).not.toContain('main is at abc123');
        expect(stored).not.toContain('deploy landed');
        expect(stored).toContain('replacement check');
      });

      it('EI-21923095696933477: refuses (even with confirmRetire:true) when retireIds MISSES a row that would actually drop', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body',
          checks: [{ claim: 'a brand new claim' }],
          rowsMode: 'replace',
          confirmRetire: true,
          retireIds: await carriedRowIdsFor(['gate is green', 'main is at abc123']), // missing "deploy landed"
        });
        expect(r).toMatchObject({
          ok: false,
          errorCode: 'checkpoint_retire_ids_mismatch',
          retryable: true,
          retireIdsRequested: splitCarryNoteChecks(prior).checks.slice(0, 2).map(row => row.id),
        });
        expect(r.retireIdsActual).toEqual(
          expect.arrayContaining(splitCarryNoteChecks(prior).checks.map(row => row.id)),
        );
        expect(r.message).toContain(splitCarryNoteChecks(prior).checks[2]!.id);
      });

      it('EI-21923095696933477: refuses when retireIds names a row that would NOT actually drop (a stale snapshot)', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({
          id: 'WI-7',
          checkpoint: 'new body',
          checks: THREE, // keeps every carried row — nothing actually drops
          rowsMode: 'replace',
          retireIds: await carriedRowIdsFor(['gate is green']), // caller believes this drops; it does not
        });
        expect(r).toMatchObject({ ok: false, errorCode: 'checkpoint_retire_ids_mismatch' });
        expect(r.retireIdsActual).toEqual([]);
      });

      it('EI-21923095696933477: an empty retireIds:[] matches a replace that drops nothing', async () => {
        const prior = await seedThree();
        withPrior(await prior);
        const r = await one({ id: 'WI-7', checkpoint: 'new body', checks: THREE, rowsMode: 'replace', retireIds: [] });
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toBeUndefined();
      });

      it.each([undefined, 'merge'] as const)(
        'EI-23618780798277092: refuses retireIds with %s rowsMode before writing',
        async (rowsMode) => {
          const prior = await seedThree();
          withPrior(await prior);
          const before = setWorkItemCheckpointWithPrior.mock.calls.length;
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [{ claim: 'a replacement row' }],
            ...(rowsMode === undefined ? {} : { rowsMode }),
            retireIds: await carriedRowIdsFor(['gate is green']),
          });

          expect(r).toMatchObject({
            ok: false,
            errorCode: 'checkpoint_retire_ids_requires_replace',
            retryable: true,
            rowsMode: 'merge',
            retireIdsRequested: splitCarryNoteChecks(prior).checks.slice(0, 1).map(row => row.id),
          });
          expect(r.message).toContain("rowsMode:'replace'");
          expect(r.message).toContain('omit `retireIds`');
          expect(setWorkItemCheckpointWithPrior.mock.calls.length).toBe(before);
          expect(await lastStored()).toBe(await prior);
        },
      );

      // EI-22385255026192781: the ONLY place an agent ever SEES a stored row id is the
      // rendered `[#id]` anchor, and '#' is outside CARRY_ROW_ID_ALLOWED, so the stored
      // side sanitizes it away. Copying the id straight out of the note you just read
      // therefore refused on a difference the renderer itself introduced.
      describe('EI-22385255026192781: retireIds accepts the rendered [#id] form', () => {
        const KEYED = [
          { id: 'gate-green', claim: 'gate is green', recheck: 'state:read' },
          { id: 'main-sha', claim: 'main is at abc123', recheck: 'git rev-parse main' },
        ];

        async function seedKeyed() {
          withPrior(null);
          await one({ id: 'WI-7', checkpoint: 'prior body', checks: KEYED });
          return lastStored();
        }

        it("accepts '#id' — the form the rendered note shows — as the bare stored id", async () => {
          const prior = await seedKeyed();
          withPrior(await prior);
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [{ claim: 'a brand new claim' }],
            rowsMode: 'replace',
            retireIds: ['#gate-green', '#main-sha'],
          });
          expect(r.ok).toBe(true);
          expect(r.checksDropped).toEqual(['gate is green', 'main is at abc123']);
        });

        it('explains that same-id replacements are updates, not retirements', async () => {
          const prior = await seedKeyed();
          withPrior(prior);
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [
              { id: 'gate-green', claim: 'gate is green at current HEAD' },
              { id: 'main-sha', claim: 'main is at current HEAD' },
            ],
            rowsMode: 'replace',
            retireIds: ['gate-green', 'main-sha'],
          });

          expect(r).toMatchObject({
            ok: false,
            errorCode: 'checkpoint_retire_ids_mismatch',
            retireIdsActual: [],
          });
          expect(r.message).toContain('same id as a replacement');
          expect(r.message).toContain('Omit `retireIds` for an in-place update');
        });

        it('still accepts the bare stored id — the pre-fix form keeps working', async () => {
          const prior = await seedKeyed();
          withPrior(await prior);
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [{ claim: 'a brand new claim' }],
            rowsMode: 'replace',
            retireIds: ['gate-green', 'main-sha'],
          });
          expect(r.ok).toBe(true);
          expect(r.checksDropped).toEqual(['gate is green', 'main is at abc123']);
        });

        it('does NOT weaken the guard — a wrong id still refuses in the #-prefixed form', async () => {
          const prior = await seedKeyed();
          withPrior(await prior);
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [{ claim: 'a brand new claim' }],
            rowsMode: 'replace',
            retireIds: ['#gate-green', '#no-such-row'],
          });
          expect(r).toMatchObject({ ok: false, errorCode: 'checkpoint_retire_ids_mismatch' });
        });

        it('leaves raw CLAIM TEXT identity untouched — normalizing it would mangle punctuation', async () => {
          // An id-less row's identity is its claim text VERBATIM. Sanitizing every
          // requested key would rewrite 'gate #4 is green' to 'gate-4-is-green' and
          // silently stop matching, so the raw form is tried before the id form.
          withPrior(null);
          await one({ id: 'WI-7', checkpoint: 'prior body', checks: [{ claim: 'gate #4 is green' }] });
          withPrior(await lastStored());
          const r = await one({
            id: 'WI-7',
            checkpoint: 'new body',
            checks: [{ claim: 'a brand new claim' }],
            rowsMode: 'replace',
            retireIds: await carriedRowIdsFor(['gate #4 is green']),
          });
          expect(r.ok).toBe(true);
          expect(r.checksDropped).toEqual(['gate #4 is green']);
        });
      });
    });

    it('EI-20232161144151845: a dependency-only patch preserves the body and bypasses shrink protection', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the detailed checkpoint body that must survive a metadata-only dependency correction '.repeat(18),
      });
      const prior = await lastStored();
      expect(prior!.length).toBeGreaterThan(500);

      withPrior(prior);
      const r = await one({ id: 'WI-7', dependsOn: ['work-item:WI-38026'] });
      expect(r.ok).toBe(true);
      expect(r.cleared).not.toBe(true);
      // No shortened body was sent to the store; the locked transform carries the
      // existing narrative forward while the dependency metadata is restamped.
      expect(withoutRowIds(await lastStored())).toBe(withoutRowIds(prior));
      const call = setWorkItemCheckpointWithPrior.mock.calls.at(-1) as [
        unknown,
        unknown,
        { guard?: unknown; dependsOn?: string[] },
      ];
      expect(call[1]).toBeUndefined();
      expect(call[2]).toMatchObject({ dependsOn: ['work-item:WI-38026'] });
      expect(call[2].guard).toBeUndefined();
    });

    it('EI-23083222467738105: a learned-only patch preserves the body and posts the lesson', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'the detailed checkpoint body that must survive a learned-only update' });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({
        id: 'WI-7',
        learned: 'the checkpoint body must survive effort-thread metadata writes',
        learnedLevel: 'work_item',
      });

      expect(r).toMatchObject({
        ok: true,
        cleared: false,
        learned: { posted: true, level: 'work_item', ref: 'WI-7' },
      });
      expect(withoutRowIds(await lastStored())).toBe(withoutRowIds(prior));
      expect(postLearnedAtLevel).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: 'WI-7',
          level: 'work_item',
          text: 'the checkpoint body must survive effort-thread metadata writes',
          harness: 'papercup',
          workspaceId: 'default',
        }),
      );
    });

    it('EI-23083222467738105: learned-only patches preserve each bulk item body', async () => {
      const current = new Map([
        ['WI-A', 'body A that must survive the learned-only bulk update'],
        ['WI-B', 'body B that must survive the learned-only bulk update'],
      ]);
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          ref: { workItemId: string },
          cp: string | null | undefined,
          opts?: { transform?: (p: string | null, n: string | null | undefined) => string | null | undefined },
        ) => {
          const prior = current.get(ref.workItemId) ?? null;
          const next = opts?.transform ? opts.transform(prior, cp) : cp;
          const stored = typeof next === 'string' && next.trim().length > 0 ? next.trim() : null;
          current.set(ref.workItemId, stored ?? '');
          return { stored, priorLength: prior?.length ?? 0 };
        },
      );
      getWorkItemCheckpoint.mockImplementation(
        async (ref: { workItemId: string }) => current.get(ref.workItemId) ?? null,
      );
      postLearnedAtLevel.mockImplementation(async (input: { workItemId: string; level?: string }) => ({
        posted: true,
        level: input.level ?? 'work_item',
        ref: input.workItemId,
        fellBack: false,
      }));

      const out = await env({
        items: [
          { id: 'WI-A', learned: 'lesson A' },
          { id: 'WI-B', learned: 'lesson B', learnedLevel: 'plan' },
        ],
      });

      expect(out).toMatchObject({ ok: true, counts: { ok: 2, failed: 0 } });
      expect(current.get('WI-A')).toBe('body A that must survive the learned-only bulk update');
      expect(current.get('WI-B')).toBe('body B that must survive the learned-only bulk update');
      expect(out.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'WI-A',
            ok: true,
            cleared: false,
            learned: expect.objectContaining({ ref: 'WI-A' }),
          }),
          expect.objectContaining({
            id: 'WI-B',
            ok: true,
            cleared: false,
            learned: expect.objectContaining({ level: 'plan', ref: 'WI-B' }),
          }),
        ]),
      );
      expect(postLearnedAtLevel).toHaveBeenCalledTimes(2);
    });

    it('EI-19447043119380534: an EXPLICIT clear (checkpoint:null) alongside checks still wipes the body — deliberate intent stays reachable', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body to be discarded', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();
      expect(prior).toContain('body to be discarded');

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: null, checks: [{ claim: 'Y holds', recheck: 'probe Y' }] });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).not.toContain('body to be discarded');
      expect(withoutRowIds(stored)).toContain('- ? Y holds');
    });

    /**
     * EI-19460631385508515: the field's own description promised "a list merges by claim
     * text", which reads as a UNION — so the natural way to mark ONE claim verified is to
     * send just that row. `normalizeCheckEntries` iterates only the INCOMING rows (prior
     * is a lookup for inheriting recheck/verified/sinceMs), so every stored claim left out
     * is dropped. Replace-with-inheritance is the right semantics — it is the only way to
     * retire a stale check — but it was documented as its opposite, and the loss left no
     * trace beyond a `checks` count the caller would have had to record beforehand.
     *
     * Reported against the LIVE operator, which was serving pre-fix code (deployed
     * 5b898b7b, gate red 3 reds deep) — so the reporter's own numbers were confounded by
     * that deploy gap and could not discriminate this from the already-fixed body-destroy
     * bug. These tests pin the behavior against the CURRENT tree instead.
     */
    describe('EI-19460631385508515: a supplied `checks` list REPLACES the stored set — and says what it dropped', () => {
      it('DROPS stored claims the supplied list omits, and names them in checksDropped', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'the body worth keeping',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
            { claim: 'C holds', recheck: 'probe C' },
          ],
        });
        const prior = await lastStored();
        expect(withoutRowIds(prior)).toContain('- ? A holds');

        // The reporter's exact intent: touch ONE row, leave the rest alone.
        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'ran it, holds' }],
          // Post-P-013 the drop only happens under an EXPLICIT replace — which is
          // precisely when it still has to be announced.
          rowsMode: 'replace',
          confirmRetire: true, retireIds: await carriedRowIdsFor(["B holds","C holds"]),
        })) as { ok: boolean; checks: number; checksDropped?: string[]; checksDroppedNote?: string };

        expect(r.ok).toBe(true);
        // The body still survives (that is EI-19447043119380534's fix, still holding)...
        const stored = await lastStored();
        expect(stored).toContain('the body worth keeping');
        // ...but B and C are genuinely gone. This is the contract, now stated out loud.
        expect(withoutRowIds(stored)).toContain('- ✓ A holds');
        expect(stored).not.toContain('B holds');
        expect(stored).not.toContain('C holds');
        expect(r.checks).toBe(1);
        // The loss is REPORTED rather than silent — the whole point of the fix.
        expect(r.checksDropped).toEqual(['B holds', 'C holds']);
        expect(r.checksDroppedNote).toContain('REPLACES');
      });

      /**
       * EI-19944669306930709: `append: true` declares an ADDITIVE write — but `checks`
       * REPLACED the carried set inside that same call. So the single most natural
       * incremental write ("append a progress note, and record the one claim I just
       * verified") destroyed every other carried check. Reported twice in one session
       * ~25 min apart by an agent who had ALREADY read the replace-semantics warning:
       * knowing the rule did not help, because `append: true` sitting in the same call
       * establishes an additive frame for the whole invocation, and `checks` reads as
       * one more field of that append.
       *
       * The prior fix (EI-19460631385508515) made the loss VISIBLE via `checksDropped`.
       * Necessary but not sufficient — it is after-the-fact, rides on an `ok: true`, and
       * recovery means re-sending the full set verbatim (where any retyped claim text
       * silently becomes a new, unevidenced row). Under `append: true` the drop is now
       * PREVENTED rather than merely reported.
       *
       * Plain (non-append) replace semantics are deliberately UNCHANGED — that is the
       * only way to retire a stale check, and the test above pins it.
       */
      describe('EI-19944669306930709: `append: true` governs `checks` too (union, not replace)', () => {
        /** Seed a prior note, then serve the post-write verifier STATEFULLY. The
         *  append itself uses the prior selected inside the locked store transaction. */
        const seed = async (checks: Array<{ id?: string; claim: string; recheck?: string; verified?: string }>) => {
          withPrior(null);
          await one({ id: 'WI-7', checkpoint: 'the body worth keeping', checks });
          const prior = await lastStored();
          let current = prior;
          getWorkItemCheckpoint.mockImplementation(async () => current);
          setWorkItemCheckpointWithPrior.mockImplementation(
            async (
              _ref: unknown,
              cp: string | null | undefined,
              opts?: { transform?: (p: string | null, n: string | null | undefined) => string | null | undefined },
            ) => {
              const effective = opts?.transform ? opts.transform(prior, cp) : cp;
              const trimmed = (effective ?? '').trim();
              const stored = trimmed.length > 0 ? trimmed : null;
              current = stored;
              return { stored, priorLength: (prior ?? '').length };
            },
          );
          return prior;
        };

        /** Install a legacy prior that predates the current row cap. Recovery writes
         * must preserve it when they pass an explicitly empty additive list. The mock
         * invokes both the guard and transform so the regression fails at the same
         * decision point as the real locked store. */
        const installLegacyPrior = (prior: string) => {
          let current: string | null = prior;
          getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
          getWorkItemCheckpoint.mockImplementation(async () => current);
          setWorkItemCheckpointWithPrior.mockImplementation(
            async (
              _ref: unknown,
              incoming: string | null | undefined,
              opts?: {
                guard?: (priorNote: string | null, priorLength: number) => string | null;
                transform?: (priorNote: string | null, next: string | null | undefined) => string | null | undefined;
              },
            ) => {
              const blockedReason = opts?.guard?.(current, current?.length ?? 0) ?? undefined;
              if (blockedReason) return { stored: current, priorLength: prior.length, blockedReason };
              const next = opts?.transform ? opts.transform(current, incoming) : incoming;
              current = typeof next === 'string' && next.trim().length > 0 ? next : null;
              return { stored: current, priorLength: prior.length };
            },
          );
          return () => current;
        };

        const legacyPriorWithExtraRow = () =>
          withCarryNoteChecks(
            'legacy checkpoint body',
            Array.from({ length: CARRY_NOTE_MAX_CHECKS + 1 }, (_, i) => ({
              claim: `LEGACY-${String(i + 1).padStart(2, '0')} holds`,
              recheck: `probe legacy ${i + 1}`,
            })),
          );

        const legacyPriorWithManyKeyedRows = () =>
          withCarryNoteChecks(
            'legacy checkpoint body',
            Array.from({ length: CARRY_NOTE_MAX_CHECKS * 4 + 2 }, (_, i) => ({
              id: `legacy-${String(i + 1).padStart(2, '0')}`,
              claim: `LEGACY-${String(i + 1).padStart(2, '0')} holds`,
              recheck: `probe legacy ${i + 1}`,
              verified: `legacy evidence ${i + 1}`,
            })),
          );

        it('UNIONS a supplied row onto the carried set instead of dropping the rest', async () => {
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B', verified: 'saw B at 19:00Z' },
            { claim: 'C holds', recheck: 'probe C' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'ran the suite, 30/30',
            append: true,
            checks: [{ claim: 'D holds', recheck: 'probe D', verified: 'measured just now' }],
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          // The new row landed...
          expect(withoutRowIds(stored)).toContain('- ✓ D holds');
          // ...and NOTHING carried was destroyed — the whole point.
          expect(stored).toContain('A holds');
          expect(stored).toContain('B holds');
          expect(stored).toContain('C holds');
          // B keeps its own evidence, not D's.
          expect(stored).toContain('saw B at 19:00Z');
          expect(r.checks).toBe(4);
          // Nothing was lost, so nothing is reported lost.
          expect(r.checksDropped).toBeUndefined();
          // The body still appended (EI-9036's contract, unaffected).
          expect(stored).toContain('the body worth keeping');
          expect(stored).toContain('ran the suite, 30/30');
        });

        it('a supplied row UPDATES a carried claim of the same text rather than duplicating it', async () => {
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'verified A',
            append: true,
            checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'ran it, 12/12' }],
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          // Promoted from PREDICTED to VERIFIED in place — one row, not two.
          expect(withoutRowIds(stored)).toContain('- ✓ A holds');
          expect(stored).not.toContain('- ? A holds');
          expect(stored).toContain('B holds');
          expect(r.checks).toBe(2);
          expect(r.checksDropped).toBeUndefined();
        });

        /**
         * EI-20004424625703051 — the union is NOT the whole story, and the gap between
         * those two facts destroyed 16 peer-authored claims on a `critical` item.
         *
         * `append` unions supplied-first, then `normalizeCheckEntries` breaks at
         * CARRY_NOTE_MAX_CHECKS. So on an item already AT the cap — precisely the
         * long-lived, multi-agent items whose history is worth most — an additive write
         * silently evicts the carried tail and still returns `ok: true`.
         *
         * The reported cause is what makes it expensive rather than merely lossy. The
         * note used to emit the REPLACE text here, so a caller who had correctly passed
         * `append: true`, observed rows vanish, and read the tool's own explanation was
         * led to exactly one conclusion: the union is broken. It was not. That caller
         * filed a bug against a working code path and published the wrong root cause,
         * while the real mechanism — the cap — went unnamed. Its remedy compounded it:
         * "re-send the FULL set" is unachievable at the cap, because the full set is by
         * definition larger than `.max(CARRY_NOTE_MAX_CHECKS)` and the call is rejected.
         *
         * The authoritative locked prior therefore wins: the body still lands, carried
         * rows remain intact, and optional supplied rows that cannot fit are reported.
         */
        it('at the cap, append stores the body and carried rows while reporting supplied checks that did not fit', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'my fresh finding',
            append: true,
            checks: [
              { claim: 'MINE-A holds', verified: 'measured' },
              { claim: 'MINE-B holds', verified: 'measured' },
            ],
          })) as {
            ok: boolean;
            checksNotRetained?: string[];
            checksNotRetainedRows?: Array<{ claim: string; verified?: string }>;
            checksNotRetainedNote?: string;
          };

          expect(r.ok).toBe(true);
          const stored = readCurrent();
          expect(stored).toContain('my fresh finding');
          for (const row of atCap) expect(stored).toContain(row.claim);
          expect(stored).not.toContain('MINE-A holds');
          expect(stored).not.toContain('MINE-B holds');
          expect(r.checksNotRetained).toEqual(['MINE-A holds', 'MINE-B holds']);
          expect(r.checksNotRetainedRows).toEqual([
            expect.objectContaining({ claim: 'MINE-A holds', verified: 'measured' }),
            expect.objectContaining({ claim: 'MINE-B holds', verified: 'measured' }),
          ]);
          expect(r.checksNotRetainedNote).toContain('BODY PRESERVED');
        });

        it('at the cap, append refreshes an existing keyed check without reporting overflow', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            id: `peer-${String(i + 1).padStart(2, '0')}`,
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            append: true,
            checks: [
              {
                id: 'peer-06',
                claim: 'PEER-06 refreshed holds',
                recheck: 'probe refreshed 6',
                verified: 'measured just now',
              },
            ],
          })) as { ok: boolean; checks: number; errorCode?: string; checksDropped?: string[] };

          expect(r).toMatchObject({ ok: true, checks: CARRY_NOTE_MAX_CHECKS });
          expect(r.errorCode).toBeUndefined();
          expect(r.checksDropped).toBeUndefined();
          const stored = readCurrent();
          expect(stored).toContain('- ✓ [#peer-06] PEER-06 refreshed holds');
          expect(stored).toContain('evidence: measured just now');
          expect(stored).toContain('PEER-01 holds');
          expect(stored).toContain('PEER-12 holds');
          expect(splitCarryNoteChecks(stored).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
        });

        it('P-025: at the cap, replaces re-words an id-less check in place and preserves its evidence', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
            ...(i === 5 ? { verified: 'observed before reword' } : {}),
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'refreshed the sixth check',
            append: true,
            rowsMode: 'merge',
            checks: [
              {
                claim: 'PEER-06 refreshed holds',
                replaces: 'PEER-06 holds',
                recheck: 'probe refreshed 6',
              },
            ],
          })) as {
            ok: boolean;
            checks: number;
            errorCode?: string;
            checksDropped?: string[];
            unmatchedRowRefs?: string[];
          };

          expect(r).toMatchObject({ ok: true, checks: CARRY_NOTE_MAX_CHECKS });
          expect(r.errorCode).toBeUndefined();
          expect(r.checksDropped).toBeUndefined();
          expect(r.unmatchedRowRefs).toBeUndefined();
          const stored = readCurrent();
          expect(stored).toContain('refreshed the sixth check');
          expect(stored).toContain('PEER-06 refreshed holds');
          expect(stored).not.toContain('PEER-06 holds');
          expect(stored).toContain('observed before reword');
          expect(splitCarryNoteChecks(stored).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
        });

        it('reports an unmatched replaces ref when it remains a net addition past the cap', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            append: true,
            rowsMode: 'merge',
            checks: [{ claim: 'NEW row', replaces: 'no such carried check' }],
          })) as { ok: boolean; errorCode?: string; unmatchedRowRefs?: string[] };

          expect(r.ok).toBe(false);
          expect(r.errorCode).toBe('append_checks_overflow');
          expect(r.unmatchedRowRefs).toEqual(['no such carried check']);
          expect(withoutRowIds(readCurrent())).toBe(withoutRowIds(prior));
        });

        /**
         * EI-22669633054802773: a compacted 7,276-character checkpoint carrying
         * the full 12-row set was refused as `append_body_overflow` when a normal
         * append also refreshed one keyed row. The prior body was well below the
         * 32,000-character cap; pin the exact shape so the append guard cannot
         * regress into treating the carried note length as check-row-only usage.
         */
        it('accepts an append plus keyed check refresh on the reported 7,276-char compacted prior', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            id: `compact-${String(i + 1).padStart(2, '0')}`,
            claim: `COMPACT-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe compact ${i + 1}`,
            verified: `measured compact ${i + 1}`,
          }));
          const checksOnly = withCarryNoteChecks('', atCap);
          const prior = withCarryNoteChecks('B'.repeat(7276 - checksOnly.length - '\n\n'.length), atCap);
          expect(prior).toHaveLength(7276);
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'new progress after compaction',
            append: true,
            rowsMode: 'merge',
            checks: [
              {
                id: 'compact-06',
                claim: 'COMPACT-06 refreshed holds',
                recheck: 'probe compact refreshed 6',
                verified: 'measured immediately after compaction',
              },
            ],
          })) as { ok: boolean; errorCode?: string; checks?: number };

          expect(r).toMatchObject({ ok: true, checks: CARRY_NOTE_MAX_CHECKS });
          expect(r.errorCode).toBeUndefined();
          const stored = readCurrent();
          expect(stored).toContain('new progress after compaction');
          expect(stored).toContain('COMPACT-06 refreshed holds');
          expect(stored).not.toContain('COMPACT-06 holds');
          expect(splitCarryNoteChecks(stored).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
        });

        /**
         * EI-22754441777968838: the reported runtime had a 7,828-character prior
         * with checkpointChecks.count === 0, but append_body_overflow claimed those
         * characters were carried check rows and rejected a 1,000-character append.
         * A no-check prior is comfortably below the 32,000-character body cap and
         * must retain the complete submitted progress body.
         */
        it('accepts the reported 7,828-char no-check prior plus a 1,000-char append', async () => {
          const prior = 'B'.repeat(7828);
          const readCurrent = installLegacyPrior(prior);
          const addendum = 'N'.repeat(1000);

          const r = (await one({ id: 'WI-7', checkpoint: addendum, append: true })) as {
            ok: boolean;
            verified?: boolean;
            errorCode?: string;
            checks?: number;
          };

          expect(r).toMatchObject({ ok: true, verified: true, checks: 0 });
          expect(r.errorCode).toBeUndefined();
          const stored = readCurrent();
          expect(stored).toHaveLength(prior.length + '\n\n---\n'.length + addendum.length);
          expect(stored!.endsWith(addendum)).toBe(true);
          expect(splitCarryNoteChecks(stored).checks).toHaveLength(0);
        });

        /**
         * EI-23068149727966393: recovered continuations reported the same false
         * append_body_overflow for short no-check priors (2,336 and 3,002 chars)
         * when the append also supplied two fresh check rows. The prior is far
         * below the 32,000-character body cap; both the body and checks must land.
         */
        it('accepts short no-check priors when an append also supplies two checks', async () => {
          for (const priorLength of [2336, 3002]) {
            const prior = 'B'.repeat(priorLength);
            const readCurrent = installLegacyPrior(prior);

            const r = (await one({
              id: 'WI-7',
              checkpoint: 'short continuation paragraph',
              append: true,
              checks: [
                { claim: 'checkpoint body remains readable', recheck: 'read the stored body' },
                { claim: 'append progress is retained', recheck: 'read the stored tail' },
              ],
            })) as { ok: boolean; verified?: boolean; errorCode?: string; checks?: number };

            expect(r).toMatchObject({ ok: true, verified: true, checks: 2 });
            expect(r.errorCode).toBeUndefined();
            const stored = readCurrent();
            expect(stored).toContain('short continuation paragraph');
            expect(splitCarryNoteChecks(stored).body.trim().endsWith('short continuation paragraph')).toBe(true);
            expect(splitCarryNoteChecks(stored).checks).toHaveLength(2);
          }
        });

        it('uses a vacant slot before reporting the remaining supplied row as not retained', async () => {
          const oneVacancy = Array.from({ length: CARRY_NOTE_MAX_CHECKS - 1 }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
          }));
          await seed(oneVacancy);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'body survives partial check admission',
            append: true,
            checks: [{ claim: 'MINE-A holds' }, { claim: 'MINE-B holds' }],
          })) as { ok: boolean; checks: number; checksNotRetained?: string[] };

          expect(r).toMatchObject({ ok: true, checks: CARRY_NOTE_MAX_CHECKS });
          const stored = readCurrent();
          expect(stored).toContain('body survives partial check admission');
          expect(stored).toContain('MINE-A holds');
          expect(stored).not.toContain('MINE-B holds');
          expect(r.checksNotRetained).toEqual(['MINE-B holds']);
        });

        it('keeps checks-only overflow as an atomic refusal because no body payload can be salvaged', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({ id: 'WI-7', append: true, checks: [{ claim: 'MINE holds' }] })) as {
            ok: boolean;
            errorCode?: string;
          };

          expect(r).toMatchObject({ ok: false, errorCode: 'append_checks_overflow' });
          expect(withoutRowIds(readCurrent())).toBe(withoutRowIds(prior));
        });

        it('confirmRetire:true cannot authorize checks-only eviction of an unnamed row', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            append: true,
            confirmRetire: true,
            checks: [{ claim: 'MINE holds', verified: 'measured now' }],
          })) as {
            ok: boolean;
            checks: number;
            errorCode?: string;
            checksDropped?: string[];
            checksDroppedNote?: string;
          };

          expect(r).toMatchObject({ ok: false, errorCode: 'append_checks_overflow' });
          expect(r.checksDropped).toEqual([`PEER-${String(CARRY_NOTE_MAX_CHECKS).padStart(2, '0')} holds`]);
          const stored = readCurrent();
          expect(stored).toBe(prior);
          expect(splitCarryNoteChecks(stored).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
        });

        /**
         * EI-21534719386975911 — THE RECURRENCE GUARD. This is the seventh fix to this
         * guard and the first six shipped without one, which is the whole reason the same
         * defect kept coming back wearing a new error message.
         *
         * The bug: `append_checks_overflow` refused any additive write whose union
         * exceeded the row cap — correct when the caller's OWN rows do the evicting, but
         * catastrophic against a note that was ALREADY over cap before the call. There,
         * every non-empty additive write overflows by construction, so the refusal was
         * permanent and its advertised remedy unreachable (re-sending the full set is
         * rejected as invalid_input, the set being larger than the cap by definition).
         * 57 stored notes in one workspace were in that state, the worst holding 62 rows.
         * Different agents inheriting different poisoned notes each met it as a fresh
         * bug, so it was filed repeatedly and "fixed" by rewording the refusal.
         *
         * The contract this pins: an over-cap prior NORMALIZES ON WRITE. The write
         * succeeds, the note lands at exactly the cap, and the rows that yield are the
         * PREDICTED ones — evidence someone paid to obtain outlives a hypothesis anyone
         * can re-run. The companion test above pins the other half, that a WITHIN-cap
         * prior still refuses caller-caused eviction; together they are the distinction
         * the fix turns on, and breaking either direction fails here.
         */
        it('preserves legacy over-cap rows and the append body, reporting a new row that cannot fit', async () => {
          const verifiedRows = Array.from({ length: 8 }, (_, i) => ({
            claim: `VERIFIED-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe verified ${i + 1}`,
            verified: `measured at 22:0${i} on current HEAD`,
          }));
          const predictedRows = Array.from({ length: 12 }, (_, i) => ({
            claim: `PREDICTED-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe predicted ${i + 1}`,
          }));
          // 20 rows — eight over today's cap of twelve, the shape of the 57 real notes.
          const prior = withCarryNoteChecks('legacy checkpoint body', [...verifiedRows, ...predictedRows]);
          expect(splitCarryNoteChecks(prior).checks.length).toBe(20);
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'the finding I just made',
            append: true,
            checks: [{ claim: 'BRAND-NEW holds', recheck: 'probe new', verified: 'measured just now' }],
          })) as {
            ok: boolean;
            errorCode?: string;
            checks: number;
            checksDropped?: string[];
            checksDroppedNote?: string;
          };

          // It must WRITE, not refuse. This is the assertion the six prior fixes lacked.
          expect(r.ok).toBe(true);
          expect(r.errorCode).toBeUndefined();

          const storedChecks = splitCarryNoteChecks(readCurrent()).checks;
          const storedClaims = storedChecks.map((c) => c.claim);

          // Lands EXACTLY at the cap — the legacy excess is gone, not carried forward.
          expect(storedChecks.map(({ id, ...row }) => row)).toEqual(splitCarryNoteChecks(prior).checks.map(({ id, ...row }) => row));
          expect(r.checks).toBe(20);

          // The caller's own row survives; it is never the row the cap cuts.
          expect(storedClaims).not.toContain('BRAND-NEW holds');
          expect(r).toMatchObject({ checksNotRetained: ['BRAND-NEW holds'] });
          expect(readCurrent()).toContain('the finding I just made');

          // EVERY evidence-bearing row survives: 1 supplied + 8 VERIFIED = 9 of 12 seats,
          // leaving 3 for PREDICTED rows, so 9 of the 12 PREDICTED rows yield.
          for (const row of verifiedRows) expect(storedClaims).toContain(row.claim);
          const survivingPredicted = storedClaims.filter((c) => c.startsWith('PREDICTED-'));
          expect(survivingPredicted.length).toBe(12);

          // The eviction is REPORTED, never silent, and names the legacy cause rather
          // than blaming the caller for a state that predates their write.
          expect(r.checksDropped).toBeUndefined();
        });

        /** The self-heal must be TERMINAL: once normalized the note fits, so the very next
         *  additive write evicts nothing. Without this, a fix that merely trimmed on every
         *  write would pass the test above while quietly shedding a row per call. */
        it('repeated legacy over-cap appends preserve every carried row', async () => {
          const prior = withCarryNoteChecks(
            'legacy checkpoint body',
            Array.from({ length: 20 }, (_, i) => ({
              claim: `LEGACY-${String(i + 1).padStart(2, '0')} holds`,
              recheck: `probe legacy ${i + 1}`,
              verified: `evidence ${i + 1}`,
            })),
          );
          const readCurrent = installLegacyPrior(prior);

          const first = (await one({
            id: 'WI-7',
            checkpoint: 'first touch',
            append: true,
            checks: [{ claim: 'FIRST holds', verified: 'measured' }],
          })) as { ok: boolean; checksDropped?: string[] };
          expect(first.ok).toBe(true);
          expect(first.checksDropped).toBeUndefined();
          expect(splitCarryNoteChecks(readCurrent()).checks.map(({ id, ...row }) => row)).toEqual(splitCarryNoteChecks(prior).checks.map(({ id, ...row }) => row));

          // The note now FITS, so this write is an ordinary at-cap append — which the
          // companion guard refuses rather than silently evicting. Either way the
          // pathological "loses rows on every write forever" behaviour must be absent.
          const second = (await one({
            id: 'WI-7',
            checkpoint: 'second touch',
            append: true,
            checks: [{ claim: 'SECOND holds', verified: 'measured' }],
          })) as { ok: boolean; errorCode?: string; checksDropped?: string[] };

          if (second.ok) {
            expect(second.checksDropped ?? []).toEqual([]);
          } else {
            // Refused as a normal caller-caused overflow — NOT as a legacy over-cap note.
            expect(second.errorCode).toBe('append_checks_overflow');
          }
          expect(splitCarryNoteChecks(readCurrent()).checks.map(({ id, ...row }) => row)).toEqual(splitCarryNoteChecks(prior).checks.map(({ id, ...row }) => row));
          expect(readCurrent()).toContain('first touch');
          expect(readCurrent()).toContain('second touch');
        });

        it('accepts the advertised append:true checks:[] recovery when a legacy prior exceeds the current cap', async () => {
          const prior = legacyPriorWithExtraRow();
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({ id: 'WI-7', append: true, checks: [] })) as {
            ok: boolean;
            checks: number;
            error?: string;
          };

          expect(r).toMatchObject({ ok: true, checks: CARRY_NOTE_MAX_CHECKS + 1 });
          expect(r.error).toBeUndefined();
          expect(withoutRowIds(readCurrent())).toBe(withoutRowIds(prior));
        });

        it('refreshes selected keyed rows in an over-cap legacy note without evicting its evidence', async () => {
          const prior = legacyPriorWithManyKeyedRows();
          const readCurrent = installLegacyPrior(prior);
          const legacyRowCount = CARRY_NOTE_MAX_CHECKS * 4 + 2;

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'current verifier body',
            rowsMode: 'merge',
            checks: [
              {
                id: 'legacy-03',
                claim: 'LEGACY-03 refreshed holds',
                recheck: 'probe refreshed legacy 3',
                verified: 'fresh evidence 3',
              },
              {
                id: 'legacy-21',
                claim: 'LEGACY-21 refreshed holds',
                recheck: 'probe refreshed legacy 21',
                verified: 'fresh evidence 21',
              },
              {
                id: 'legacy-49',
                claim: 'LEGACY-49 refreshed holds',
                recheck: 'probe refreshed legacy 49',
                verified: 'fresh evidence 49',
              },
            ],
          })) as { ok: boolean; checks: number; checksDropped?: string[]; errorCode?: string };

          expect(r).toMatchObject({ ok: true, checks: legacyRowCount });
          expect(r.checksDropped).toBeUndefined();
          expect(r.errorCode).toBeUndefined();
          const stored = readCurrent();
          expect(stored).toContain('- ✓ [#legacy-03] LEGACY-03 refreshed holds');
          expect(stored).toContain('- ✓ [#legacy-21] LEGACY-21 refreshed holds');
          expect(stored).toContain('- ✓ [#legacy-49] LEGACY-49 refreshed holds');
          expect(stored).not.toContain('LEGACY-03 holds');
          expect(stored).toContain('LEGACY-01 holds');
          expect(stored).toContain('LEGACY-50 holds');
        });

        it('refuses an append that cannot fit without deleting legacy evidence rows', async () => {
          const legacyChecks = Array.from({ length: 83 }, (_, i) => ({
            id: `legacy-${String(i + 1).padStart(2, '0')}`,
            claim: `LEGACY-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `legacy recheck ${i + 1} ${'r'.repeat(180)}`,
            verified: `legacy evidence ${i + 1} ${'v'.repeat(180)}`,
          }));
          const prior = withCarryNoteChecks('legacy body', legacyChecks);
          const readCurrent = installLegacyPrior(prior);
          const addendum = '2026-08-25T04:50Z — the new progress body must survive';

          const r = (await one({ id: 'WI-7', checkpoint: addendum, append: true })) as {
            ok: boolean;
            errorCode?: string;
            checksDropped?: string[];
            checksDroppedNote?: string;
            legacyChecksNormalization?: { truncatedFields: number; droppedRows: number };
          };

          expect(r).toMatchObject({ ok: false, errorCode: 'append_prior_body_overflow' });
          const current = readCurrent();
          expect(current).toBe(prior);
          if (current === null) throw new Error('legacy checkpoint write unexpectedly cleared');
          // This fixture exceeds the byte cap through row count/serialized evidence,
          // not any individual soft field cap. Row-only normalization must not claim
          // that a field was shortened; that signal is reserved for truncateCarryField
          // repairs, while droppedRows reports the legacy rows yielded for body space.
          expect(r.checksDropped).toBeUndefined();
          expect(splitCarryNoteChecks(current).checks).toEqual(splitCarryNoteChecks(prior).checks);
        });

        /**
         * EI-21228214077347799 — the SAME cap-eviction loss as EI-20004424625703051
         * above, reached through the door that guard does not cover.
         *
         * The overflow guard is armed as the ELSE of `isPlainReplace`:
         *
         *     guard: isPlainReplace && !wantsConfirmShrink ? shrinkGuard
         *          : additiveChecks && !wantsConfirmShrink ? overflowGuard
         *          : undefined
         *
         * But those two conditions are NOT alternatives — they guard INDEPENDENT axes.
         * `isPlainReplace` is about the BODY being replaced; `additiveChecks` is about the
         * check ROWS being unioned. The default `rowsMode:'merge'` WITH a checkpoint body
         * is both at once: the body replaces (isPlainReplace true) while the rows are
         * additive (additiveChecks true). The single guard slot is claimed by the shrink
         * guard, which knows nothing about rows, so the overflow guard never runs and the
         * transform evicts the carried tail exactly as it did before that fix — returning
         * `ok: true`.
         *
         * Reported live: 4 carried rows evicted, EVERY ONE of them ✓ VERIFIED (a tsc
         * result, a forward-compat lint result, a live-DB migration check), displaced by
         * newly-supplied rows of which 2 were ? PREDICTED. So the eviction policy trades
         * PROVEN evidence for UNPROVEN claims — backwards for the field whose whole
         * purpose is telling an asserted claim from a verified one. The reporter then hit
         * `typeEvidenceWarning` on the very check whose verified row had just been
         * evicted, and had to re-run a ~2min tsc to re-establish something already proven.
         *
         * The body here is deliberately LARGE so the shrink guard returns null: this
         * isolates the guard-slot defect rather than the shrink path's own retry.
         */
        it('at the cap, DEFAULT rowsMode:merge stores the body and reports supplied rows it could not retain', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
            verified: `measured ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const freshBody = `progress refresh ${'x'.repeat(4000)}`;
          const r = (await one({
            id: 'WI-7',
            // No `append` and no explicit `rowsMode` — the DEFAULT merge path. Long enough
            // that `newLength < priorLen * 0.5` is false, so the shrink guard passes and
            // cannot mask the missing overflow guard.
            checkpoint: freshBody,
            checks: [{ claim: 'MINE-A holds' }, { claim: 'MINE-B holds' }],
          })) as {
            ok: boolean;
            checksNotRetained?: string[];
            checksDropped?: string[];
          };

          expect(r.ok).toBe(true);
          const stored = readCurrent();
          expect(stored).toContain(freshBody);
          for (const row of atCap) expect(stored).toContain(row.claim);
          expect(stored).not.toContain('MINE-A holds');
          expect(stored).not.toContain('MINE-B holds');
          expect(r.checksDropped).toBeUndefined();
          expect(r.checksNotRetained).toEqual(['MINE-A holds', 'MINE-B holds']);
        });

        it('updates an existing sanitized id while reporting a new supplied id that cannot fit', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            id: `peer-${String(i + 1).padStart(2, '0')}`,
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
            verified: `measured ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'fresh progress body',
            rowsMode: 'merge',
            checks: [
              // This is copied from the rendered `[#peer-01]` label. It must
              // normalize back to the stored stable id rather than become a
              // second row and change which predecessor is diagnosed.
              { id: '[#peer-01]', claim: 'PEER-01 holds', recheck: 'probe 1' },
              { id: 'mine-new', claim: 'MINE holds', recheck: 'probe mine', verified: 'measured mine' },
            ],
          })) as {
            ok: boolean;
            checksNotRetained?: string[];
            checksNotRetainedRows?: Array<{
              id?: string;
              claim: string;
              recheck?: string;
              verified?: string;
            }>;
          };

          expect(r.ok).toBe(true);
          const stored = readCurrent();
          expect(stored).toContain('[#peer-01] PEER-01 holds');
          expect(stored).toContain('PEER-12 holds');
          expect(stored).not.toContain('MINE holds');
          expect(r.checksNotRetained).toEqual(['MINE holds']);
          expect(r.checksNotRetainedRows).toEqual([
            expect.objectContaining({
              id: 'mine-new',
              claim: 'MINE holds',
              recheck: 'probe mine',
              verified: 'measured mine',
            }),
          ]);
        });

        /**
         * EI-21859829224277390: an id-matched UPSERT is a CORRECTION of an existing
         * row, not a new row — it must always land, even when several OTHER supplied
         * rows in the SAME call are genuinely new and the note is already at the cap.
         * Reported live: retracting a stale ✓ VERIFIED claim ('armf-is-decisive')
         * alongside newly-observed facts landed the retraction in `checksNotRetained`
         * while the stale VERIFIED row survived unchanged — the single write whose
         * whole job is keeping the ledger honest silently no-opped. The retraction
         * must never compete with new rows for the cap; only genuinely new identities
         * may be evicted.
         */
        it('an id-matched retraction lands even when accompanying new rows overflow the cap', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) =>
            i === 0
              ? {
                  id: 'armf-is-decisive',
                  claim: 'ARM F REPRODUCED THE FLAKE — the ONLY faithful reproducer',
                  recheck: 'probe arm f',
                  verified: 'observed 2026-08-29',
                }
              : {
                  id: `peer-${String(i + 1).padStart(2, '0')}`,
                  claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
                  recheck: `probe ${i + 1}`,
                  verified: `measured ${i + 1}`,
                },
          );
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'retraction landed',
            append: true,
            checks: [
              {
                id: 'armf-is-decisive',
                claim: 'RETRACTED — arm F is NOT a reproducer',
                contested: 'STILL RUNNING — re-checked 2026-08-30, does not reproduce',
              },
              { claim: 'NEW-A holds', verified: 'measured' },
              { claim: 'NEW-B holds', verified: 'measured' },
              { claim: 'NEW-C holds', verified: 'measured' },
              { claim: 'NEW-D holds', verified: 'measured' },
            ],
          })) as {
            ok: boolean;
            checksNotRetained?: string[];
            checksNotRetainedRows?: Array<{ id?: string; claim: string }>;
          };

          expect(r.ok).toBe(true);
          const stored = readCurrent();
          // The retraction landed — the id-matched row is UPDATED, not evicted.
          expect(stored).toContain('RETRACTED — arm F is NOT a reproducer');
          expect(stored).not.toContain('ARM F REPRODUCED THE FLAKE');
          // Every carried peer row is intact.
          for (const row of atCap.slice(1)) expect(stored).toContain(row.claim);
          // Only the genuinely NEW rows compete for (and lose) the full cap — the
          // retraction must never appear here.
          expect(r.checksNotRetained).toEqual(['NEW-A holds', 'NEW-B holds', 'NEW-C holds', 'NEW-D holds']);
        });

        it("accepts the advertised rowsMode:'merge' checks:[] recovery when a legacy prior exceeds the current cap", async () => {
          const prior = legacyPriorWithExtraRow();
          const readCurrent = installLegacyPrior(prior);

          const r = (await one({ id: 'WI-7', rowsMode: 'merge', checks: [] })) as {
            ok: boolean;
            rowsMode?: string;
            rowsModeNote?: string;
            checks: number;
            error?: string;
          };

          expect(r).toMatchObject({
            ok: true,
            rowsMode: 'merge',
            checks: CARRY_NOTE_MAX_CHECKS + 1,
          });
          expect(r.rowsModeNote).toContain('NO-OP');
          expect(r.error).toBeUndefined();
          expect(withoutRowIds(readCurrent())).toBe(withoutRowIds(prior));
        });

        it('PLAIN (non-append) replace still retires a stale check when explicitly confirmed', async () => {
          // The escape hatch: no `append`, so the supplied list still REPLACES. This is
          // what keeps EI-19460631385508515's contract reachable; the fix above must not
          // take it away, or a stale check becomes unretirable.
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B is stale', recheck: 'probe B' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checks: [{ claim: 'A holds', recheck: 'probe A' }],
            rowsMode: 'replace',
            confirmRetire: true, retireIds: await carriedRowIdsFor(["B is stale"]),
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          expect(stored).toContain('A holds');
          expect(stored).not.toContain('B is stale');
          expect(r.checks).toBe(1);
          expect(r.checksDropped).toEqual(['B is stale']);
        });

        /**
         * EI-21851633473920728: an explicit `rowsMode:'replace'` was silently
         * downgraded to merge/preserve-carried semantics whenever the accompanying
         * checkpoint BODY also shrank by more than half — the shrink-guard's
         * auto-retry (EI-20232176364474286) sets `preservePriorOnShrink`, which the
         * check-row additivity checks read off the SAME flag as `additiveChecks`,
         * with no regard for what `rowsMode` the caller actually asked for. The
         * result: an item already at the 12-row cap kept every STALE row, every
         * NEWLY SUBMITTED row landed in `checksNotRetained`, and the write still
         * returned `ok: true` with `checks: 12` — reading as "12 stored" while
         * `checksNotRetained` in the same payload named all 12 as not stored.
         *
         * `loop:checkpoint` refuses the analogous situation outright
         * (`checkpoint_merge_would_evict_rows`); this pins `work_items:checkpoint`
         * to the same no-silent-downgrade contract for an EXPLICIT replace.
         */
        describe("EI-21851633473920728: rowsMode:'replace' survives the shrink-guard retry", () => {
          const bigBody = 'a substantial prior narrative body worth preserving. '.repeat(20);
          const staleRows = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `STALE-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe stale ${i + 1}`,
          }));
          const freshRows = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `FRESH-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe fresh ${i + 1}`,
          }));

          it('preserves rows through the shrink retry and reports supplied rows that cannot fit', async () => {
            const prior = withCarryNoteChecks(bigBody, staleRows);
            expect(prior.length).toBeGreaterThan(500);
            const readCurrent = installLegacyPrior(prior);

            const r = (await one({
              id: 'WI-7',
              checkpoint: 'concise refresh', // << 50% of bigBody — trips the shrink guard
              rowsMode: 'replace',
              checks: freshRows,
            })) as { ok: boolean; errorCode?: string; checksDropped?: string[]; checksNotRetained?: string[] };

            expect(r).toMatchObject({ ok: true, checksNotRetained: freshRows.map(row => row.claim) });
            // The self-contradictory shape this bug reported must not appear on a refusal.
            expect(r.checksDropped).toBeUndefined();
            // Refused ⇒ nothing written.
            expect(splitCarryNoteChecks(readCurrent()).checks.map(({ id, ...row }) => row)).toEqual(splitCarryNoteChecks(prior).checks.map(({ id, ...row }) => row));
            expect(readCurrent()).toContain('concise refresh');
          });

          it('replaces individually named rows through the shrink retry', async () => {
            const prior = withCarryNoteChecks(bigBody, staleRows);
            const readCurrent = installLegacyPrior(prior);

            const r = (await one({
              id: 'WI-7',
              checkpoint: 'concise refresh',
              rowsMode: 'replace',
              confirmRetire: true,
              retireIds: staleRows.map(row => row.claim),
              checks: freshRows,
            })) as { ok: boolean; checks: number; checksNotRetained?: string[]; checksDropped?: string[] };

            expect(r.ok).toBe(true);
            // `checks` reflects what was actually retained: the SUBMITTED rows, not
            // the stale count masquerading as success.
            expect(r.checks).toBe(CARRY_NOTE_MAX_CHECKS);
            expect(r.checksNotRetained).toBeUndefined();
            expect(r.checksDropped).toEqual(staleRows.map((row) => row.claim));
            const stored = readCurrent();
            expect(stored).toContain('FRESH-01 holds');
            expect(stored).toContain('FRESH-12 holds');
            expect(stored).not.toContain('STALE-01 holds');
            // The narrative body is still preserved beneath the fresh note (the
            // shrink-guard's own no-loss contract, unaffected by this fix).
            expect(stored).toContain('concise refresh');
            expect(stored).toContain(bigBody.trim());
          });
        });
      });

      it('a re-sent claim INHERITS its stored evidence, so replace-semantics never loses a ✓ you kept', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'observed at 19:00Z' }],
        });
        const prior = await lastStored();

        // Re-sent with claim text only — the evidence must ride along, not be erased.
        withPrior(prior);
        const r = (await one({ id: 'WI-7', checks: [{ claim: 'A holds' }] })) as {
          ok: boolean;
          checksDropped?: string[];
        };
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(withoutRowIds(stored)).toContain('- ✓ A holds');
        expect(stored).toContain('observed at 19:00Z');
        // Nothing was dropped, so the key is absent entirely (shape unchanged).
        expect(r.checksDropped).toBeUndefined();
      });

      it('OMITTING `checks` entirely still carries every row forward and reports no drop', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
          ],
        });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({ id: 'WI-7', checkpoint: 'a rewritten body' })) as {
          ok: boolean;
          checks: number;
          checksDropped?: string[];
        };
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(withoutRowIds(stored)).toContain('- ? A holds');
        expect(withoutRowIds(stored)).toContain('- ? B holds');
        expect(r.checks).toBe(2);
        expect(r.checksDropped).toBeUndefined();
      });

      it('an explicit clear (checks: []) drops every row and says so', async () => {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'A holds', recheck: 'probe A' }] });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({ id: 'WI-7', checks: [], rowsMode: 'replace', confirmRetire: true, retireIds: await carriedRowIdsFor(["A holds"]) })) as {
          ok: boolean;
          checksDropped?: string[];
        };
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toEqual(['A holds']);
      });
    });

    it('append mode folds the prior note WITHOUT emitting a second ## Checks section', async () => {
      // The locked transform joins the whole prior note — rendered Checks section and
      // all — so it strips the prior section before re-attaching it, or the note grows
      // one section per append and the parse becomes ambiguous.
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'first',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }],
      });
      const prior = await lastStored();

      getWorkItemCheckpoint.mockImplementation(async () => {
        const last = setWorkItemCheckpointWithPrior.mock.results.at(-1);
        return last ? ((await last.value) as { stored: string | null }).stored : null;
      });
      withPrior(prior);
      getWorkItemCheckpoint.mockClear();
      const r = await one({ id: 'WI-7', checkpoint: 'an addendum', append: true });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored!.match(/## Checks/g) ?? []).toHaveLength(1);
      expect(stored).toContain('first');
      expect(stored).toContain('an addendum');
      expect(withoutRowIds(stored)).toContain('- ✓ X holds');
      expect(r.checks).toBe(1);
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1); // post-write verification only
    });

    it('re-stating a carried claim WITH evidence promotes it from ? to ✓', async () => {
      // The intended lifecycle: carry a prediction, then upgrade it once you actually
      // ran the probe — rather than leaving a stale prediction reading as established.
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();
      expect(withoutRowIds(prior)).toContain('- ? X holds');

      withPrior(prior);
      await one({
        id: 'WI-7',
        checkpoint: 'body',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'ran probe X at 21:40Z' }],
      });
      const stored = await lastStored();
      expect(withoutRowIds(stored)).toContain('- ✓ X holds');
      expect(stored).not.toContain('- ? X holds');
      expect(stored).toContain('evidence: ran probe X at 21:40Z');
    });

    /**
     * EI-19400299440742193 — the second instance of the class WI-7264 fixed on
     * loop:checkpoint. A zod `.max()` REJECTS THE WHOLE CALL, so one sub-field a few
     * chars over its cap discarded the entire accompanying multi-KB checkpoint and the
     * agent re-sent it: the bytes paid twice, and — the part that actually matters — an
     * item could be left with NO durable state at the moment its session ended, which is
     * exactly what a checkpoint exists to prevent.
     *
     * Measured over the same 6-day transcript window as WI-7264
     * (`node scripts/measure-carry-note-population.mjs 6 'work_items:checkpoint'`):
     * 665 calls, 11 rejected, and 6 of the 9 SCHEMA rejections were a `checks[].recheck`
     * overrun — 32,967 chars. The observed overruns were 311, 335, 386 and 460 chars
     * against a 300 cap, i.e. all a near miss rather than anything pathological.
     *
     * Deliberately NOT ported from WI-7264: the `{status, evidence}` row-shape coercion.
     * Re-measuring before building found ZERO instances of that confusion on this tool
     * (its one wrong-shape rejection was `dependsOn: expected array, received string`,
     * a different field entirely), so porting it would have added a coercion path
     * nothing exercises. The contract pinned here is cap-truncation only.
     */
    describe("EI-19400299440742193: repair-don't-refuse — an oversized check row must not discard the checkpoint", () => {
      it('WRITES the checkpoint instead of rejecting it when a recheck overruns, and reports the trim', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'substantial in-flight state the agent already paid to transmit',
          checks: [{ claim: 'gate is green', recheck: 'x'.repeat(360) }],
        })) as { ok: boolean; repairs?: { field: string; kind: string; detail?: string }[] };
        // The whole checkpoint used to be discarded over this one field.
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(stored).toContain('substantial in-flight state');
        // The trim is REPORTED — a cut the caller cannot see is EI-18723223344390510.
        expect(r.repairs).toHaveLength(1);
        expect(r.repairs![0]).toMatchObject({ field: 'checks[0].recheck', kind: 'truncated' });
        expect(r.repairs![0]!.detail).toContain('360');
      });

      it('truncates to the SOFT cap — the stored row is bounded, not merely accepted', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'c', recheck: 'y'.repeat(900), verified: 'z'.repeat(900) }],
        });
        const stored = await lastStored();
        // Relaxing the schema must not mean an unbounded row re-injects on every pickup.
        expect(stored!).not.toContain('y'.repeat(400));
        expect(stored!).not.toContain('z'.repeat(400));
      });

      it('caps `claim` too, and reports every trimmed field separately', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'C'.repeat(700), recheck: 'R'.repeat(400), verified: 'V'.repeat(400) }],
        })) as { ok: boolean; repairs?: { field: string }[] };
        expect(r.ok).toBe(true);
        expect(r.repairs?.map((x) => x.field)).toEqual(['checks[0].claim', 'checks[0].recheck', 'checks[0].verified']);
      });

      it('omits `repairs` entirely when nothing was trimmed — an unaffected result keeps its old shape', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'short', recheck: 'also short', verified: 'observed 04:00Z' }],
        })) as { ok: boolean; repairs?: unknown };
        expect(r.ok).toBe(true);
        expect(r).not.toHaveProperty('repairs');
      });

      // These two reject at the SCHEMA, before the handler runs, so they assert on
      // `parse` throwing rather than on an ok:false envelope — same shape as the
      // WI-7264 block in loop/checkpoint.test.ts.
      it('still REJECTS a genuinely undeclared key — EI-10883 is preserved, not weakened', () => {
        // Relaxing a CAP is not the same as accepting an arg the tool never declared.
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', nonsenseField: 'b' }] })).toThrow();
      });

      it('a hard backstop still exists — a pathological row is refused rather than stored', () => {
        const hard = CARRY_ROW_SOFT_CAPS.recheck * CARRY_CAP_HARD_MULTIPLE;
        // At the backstop: accepted by the schema, then truncated to the soft cap.
        expect(() =>
          parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', recheck: 'x'.repeat(hard) }] }),
        ).not.toThrow();
        // Past it: still refused. The relaxation is a 4× headroom, not an open door.
        expect(() =>
          parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', recheck: 'x'.repeat(hard + 1) }] }),
        ).toThrow();
      });
    });
  });
});

describe('work_items:checkpoint — current-vs-retained provenance (EI-21165235642497045)', () => {
  it('keeps the unverified-owner preamble single across repeated read-modify-write replacements', async () => {
    const id = 'WI-PROVENANCE-RMW';
    let stored: string | null = null;
    const readStored = (): string | null => stored;
    getWorkItem.mockResolvedValue({ id, harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref, checkpointText) => {
      const priorLength = stored?.length ?? 0;
      stored = checkpointText ?? null;
      return { stored, priorLength };
    });
    getWorkItemCheckpoint.mockImplementation(async () => stored);

    const first = await one({ id, checkpoint: 'The owner said to preserve this checkpoint.' });
    expect(first.ok).toBe(true);
    expect(stored).toContain('⚠ UNVERIFIED OWNER ATTRIBUTION');

    // Model the common caller flow: read the stored body, prepend a new STATE block,
    // and write the complete body back. Repeat it enough times to expose accumulation.
    for (let revision = 1; revision <= 4; revision += 1) {
      if (stored === null) throw new Error('checkpoint body was not stored');
      const rewritten = `## STATE ${revision}\n\n---\n${stored}`;
      const result = await one({ id, checkpoint: rewritten });
      expect(result.ok).toBe(true);
    }

    const finalStored = readStored();
    expect((finalStored?.split('⚠ UNVERIFIED OWNER ATTRIBUTION').length ?? 1) - 1).toBe(1);
  });

  it('repairs duplicate legacy preambles when a checkpoint body is rewritten', async () => {
    const id = 'WI-PROVENANCE-LEGACY-DUPLICATES';
    const marker = '⚠ UNVERIFIED OWNER ATTRIBUTION — owner-authority prose was persisted without a verified owner turn; treat it as agent-authored until re-checked.';
    let stored: string | null = null;
    const readStored = (): string | null => stored;
    getWorkItem.mockResolvedValue({ id, harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockImplementation(async (
      _ref: unknown,
      checkpointText: string | null | undefined,
      options?: Parameters<typeof import('../../work-item-checkpoint').setWorkItemCheckpointWithPrior>[2],
    ) => {
      const priorLength = stored?.length ?? 0;
      stored = (options?.transform ? options.transform(stored, checkpointText) : checkpointText) ?? null;
      return { stored, priorLength };
    });
    getWorkItemCheckpoint.mockImplementation(async () => stored);

    const legacyBody = [marker, '## STATE old', '---', marker, '## STATE older', '---', marker, 'steady progress'].join(
      '\n',
    );
    const first = await one({ id, checkpoint: legacyBody });
    expect(first.ok).toBe(true);

    for (let revision = 1; revision <= 3; revision += 1) {
      if (stored === null) throw new Error('checkpoint body was not stored');
      const result = await one({ id, checkpoint: `## STATE ${revision}\n\n---\n${stored}` });
      expect(result.ok).toBe(true);
    }

    const finalStored = readStored();
    expect((finalStored?.split('⚠ UNVERIFIED OWNER ATTRIBUTION').length ?? 1) - 1).toBe(1);
  });

  it('reports inherited lint under retainedProvenance, not provenanceLint', async () => {
    const current = 'the owner said to run the focused suite';
    const retained = 'the owner said to retain the old checkpoint';
    const stored = [retained, current].join('\n');

    getWorkItem.mockResolvedValue({ id: 'WI-PROVENANCE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: retained.length });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-PROVENANCE', checkpoint: current });

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches.map((match: { line: string }) => match.line)).toEqual([current]);
    expect(result.retainedProvenance?.matches.map((match: { line: string }) => match.line)).toEqual([retained]);
  });

  it('surfaces an unresolved turn ref as provenance lint without changing checked:false', async () => {
    const ref = '[turn:wakepump@2026-09-05T21:26:41Z]';
    getWorkItem.mockResolvedValue({ id: 'WI-PROVENANCE-UNRESOLVED', harness: 'papercup' });
    const stored = `The wake-pump action is recorded at ${ref}.`;
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-PROVENANCE-UNRESOLVED', checkpoint: stored });

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches.some((match: { kind: string }) => match.kind === 'unresolved-turn-ref')).toBe(
      true,
    );
    expect(result.turnProvenance?.refs?.[0]).toMatchObject({ ref, found: false, checked: false });
  });

  it('EI-25495485988836164: reuses the resolved current-turn stamp after expanding [turn:self]', async () => {
    const currentTurn = {
      ref: '[turn:session-example@2026-09-08T13:10:00.000Z]',
      verdict: 'agent-injected',
      origin: 'loop-fire',
    };
    const id = 'WI-PROVENANCE-CURRENT-SENTINEL';
    const stored = `Checkpoint note created here: ${currentTurn.ref}`;
    resolveCurrentTurnStamp.mockClear();
    verifyTurnRefs.mockClear();
    resolveCurrentTurnStamp.mockResolvedValueOnce(currentTurn);
    getWorkItem.mockResolvedValue({ id, harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id, checkpoint: 'Checkpoint note created here: [turn:self]' });

    expect(result.ok).toBe(true);
    expect(resolveCurrentTurnStamp).toHaveBeenCalledTimes(1);
    expect(verifyTurnRefs).not.toHaveBeenCalled();
    expect(result.turnProvenance).toMatchObject({
      writtenDuring: currentTurn,
      refs: [{ ref: currentTurn.ref, found: true, checked: true, verdict: currentTurn.verdict }],
    });
  });

  it('preserves a watchdog force-compaction stamp on the checkpoint writer path', async () => {
    const currentTurn = {
      ref: '[turn:session-watchdog@2026-09-08T13:10:00.000Z]',
      verdict: 'agent-injected',
      origin: 'watchdog',
    };
    const id = 'WI-PROVENANCE-WATCHDOG';
    const stored = `Checkpoint note created here: ${currentTurn.ref}`;
    resolveCurrentTurnStamp.mockClear();
    verifyTurnRefs.mockClear();
    resolveCurrentTurnStamp.mockResolvedValueOnce(currentTurn);
    getWorkItem.mockResolvedValue({ id, harness: 'papercusp' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id, checkpoint: 'Checkpoint note created here: [turn:self]' });

    expect(result.ok).toBe(true);
    expect(resolveCurrentTurnStamp).toHaveBeenCalledTimes(1);
    expect(verifyTurnRefs).not.toHaveBeenCalled();
    expect(result.turnProvenance).toMatchObject({
      writtenDuring: currentTurn,
      refs: [{ ref: currentTurn.ref, found: true, checked: true, verdict: currentTurn.verdict }],
    });
  });

  it('EI-21306957457076433: does not retain a factual timeout classification as bare imperative lint', async () => {
    const current = 'Fresh checkpoint evidence for the next wake.';
    const retained =
      'The green-checkpoint:inconclusive notification was a TIMEOUT, not a verdict; ' +
      'do not treat it as a verdict until release:trace confirms the state.';
    const stored = [retained, current].join('\n');

    getWorkItem.mockResolvedValue({ id: 'WI-PROVENANCE-TIMEOUT', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: retained.length });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-PROVENANCE-TIMEOUT', checkpoint: current });

    expect(result.ok).toBe(true);
    expect(result.provenanceLint).toBeUndefined();
    expect(result.retainedProvenance).toBeUndefined();
  });
});

describe('work_items:checkpoint — absence-premise continuity lint (WI-7238)', () => {
  const claim =
    'The mcp-proxy failure ledger has been written since W8 and there is no reader for it — nothing ingests the file.';

  it('returns an advisory with a concrete recheck while preserving the write', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-ABSENCE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: claim, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(claim);

    const result = await one({ id: 'WI-ABSENCE', checkpoint: claim });

    expect(result.ok).toBe(true);
    expect(result.absenceLint).toMatchObject({
      flagged: true,
      claims: [{ claim: expect.stringContaining('no reader'), recheck: expect.any(String) }],
    });
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();
  });

  it('does not warn on a no-pickup condition, while preserving main-clause absence claims', async () => {
    const conditional = "If no such pickup occurs, verify the target's progress/liveness before retrying.";
    getWorkItem.mockResolvedValue({ id: 'WI-CONDITIONAL-ABSENCE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: conditional, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(conditional);

    const conditionalResult = await one({ id: 'WI-CONDITIONAL-ABSENCE', checkpoint: conditional });

    expect(conditionalResult.ok).toBe(true);
    expect(conditionalResult).not.toHaveProperty('absenceLint');
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();

    const mainClause = 'If the wake is delayed, there is no receipt to verify the target progress.';
    getWorkItem.mockResolvedValue({ id: 'WI-MAIN-CLAUSE-ABSENCE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: mainClause, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(mainClause);

    const mainClauseResult = await one({ id: 'WI-MAIN-CLAUSE-ABSENCE', checkpoint: mainClause });

    expect(mainClauseResult.ok).toBe(true);
    expect(mainClauseResult.absenceLint).toMatchObject({
      flagged: true,
      claims: [{ claim: expect.stringContaining('no receipt'), recheck: expect.any(String) }],
    });
  });

  it('stays absent for an ordinary progress checkpoint', async () => {
    const body = 'Implemented the compatibility path and the focused test passes 7/7.';
    getWorkItem.mockResolvedValue({ id: 'WI-CLEAN', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    expect(await one({ id: 'WI-CLEAN', checkpoint: body })).not.toHaveProperty('absenceLint');
  });

  it('does not warn on a negative action disposition and preserves the checkpoint write', async () => {
    const body = 'The checkpoint records that no such action is being taken now.';
    getWorkItem.mockResolvedValue({ id: 'WI-ACTION-DISPOSITION', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-ACTION-DISPOSITION', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('absenceLint');
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();
  });

  it('suppresses the advisory when the stored check rows already carry the falsifier', async () => {
    const check = {
      claim,
      recheck: "rg -n 'mcp-proxy failure ledger reader' packages apps libs",
      verified: 'whole-repo importer search completed; no reader found',
    };
    const stored = withCarryNoteChecks(claim, [check]);
    getWorkItem.mockResolvedValue({ id: 'WI-COVERED', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-COVERED', checkpoint: claim, checks: [check] });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('absenceLint');
  });

  it('covers an unaccounted group/task absence with its matching unfiltered live-process census', async () => {
    const body = 'There is no current unaccounted group/task id for the descriptor probe.';
    const processCensus = {
      claim:
        'Fresh processes:list with live:true and no state/task selectors returned scannedProcesses=2506, ' +
        'unaccountedCount=0, unaccountedPidCount=0, and unaccountedGroups=[].',
      recheck: 'Repeat processes:list { live:true, limit:1 } without state/task selectors.',
      verified: 'The unfiltered live census returned zero unaccounted groups.',
    };
    const stored = withCarryNoteChecks(body, [processCensus]);
    getWorkItem.mockResolvedValue({ id: 'WI-LIVE-PROCESS-ABSENCE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({
      id: 'WI-LIVE-PROCESS-ABSENCE',
      checkpoint: body,
      checks: [processCensus],
    });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('absenceLint');
  });

  it('recommends a live-process ledger probe for an uncovered runtime absence, not a repository search', async () => {
    const body = 'There is no current unaccounted group/task id for the descriptor probe.';
    getWorkItem.mockResolvedValue({ id: 'WI-LIVE-PROCESS-ABSENCE-UNCHECKED', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-LIVE-PROCESS-ABSENCE-UNCHECKED', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.absenceLint?.flagged).toBe(true);
    expect(result.absenceLint?.claims[0]?.recheck).toMatch(/processes:list/i);
    expect(result.absenceLint?.claims[0]?.recheck).not.toMatch(/search for|grep|whole repo/i);
  });

  it('does not accept a filtered process census as proof of a global unaccounted-group absence', async () => {
    const body = 'There is no current unaccounted group/task id for the descriptor probe.';
    const filteredCensus = {
      claim:
        'processes:list with live:true and state=running returned scannedProcesses=2506, ' +
        'unaccountedCount=0, unaccountedPidCount=0, and unaccountedGroups=[].',
      recheck: 'Repeat the processes:list call for the running state only.',
      verified: 'The filtered running-state census returned zero unaccounted groups.',
    };
    const stored = withCarryNoteChecks(body, [filteredCensus]);
    getWorkItem.mockResolvedValue({ id: 'WI-LIVE-PROCESS-ABSENCE-FILTERED', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({
      id: 'WI-LIVE-PROCESS-ABSENCE-FILTERED',
      checkpoint: body,
      checks: [filteredCensus],
    });

    expect(result.ok).toBe(true);
    expect(result.absenceLint?.flagged).toBe(true);
  });
});

describe('work_items:checkpoint — prose path continuity lint (EI-22386514939689944)', () => {
  it('reports unresolved repo-relative paths from narrative prose without blocking the write', async () => {
    const missing = 'packages/operator-core/lib/agent-tools/fleet/respawn-member.ts';
    const present = 'packages/operator-core/lib/agent-tools/work_items/checkpoint.ts';
    const body = `Landed the surface in ${missing}; the verification lives in ${present}.`;
    resolveCurrentTokens.mockResolvedValue(
      new Map([
        [`file:${missing}`, null],
        [`file:${present}`, 'sha256:present'],
      ]),
    );
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-PATH', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-PATH', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toMatchObject({
      flagged: true,
      paths: [missing],
      note: expect.stringContaining('advisory only'),
    });
    expect(resolveCurrentTokens).toHaveBeenCalledWith([`file:${missing}`, `file:${present}`], {
      workspaceId: 'default',
      harness: 'papercup',
    }, { allowDirectories: true });
  });

  it('ignores an upstream source URL while still reporting a genuinely missing local path', async () => {
    const upstreamPath = 'src/backend/storage/aio/aio_funcs.c';
    const missingLocal = 'packages/operator-core/lib/agent-tools/work_items/url-path-regression-missing.ts';
    const body =
      'The upstream reference is https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/' +
      upstreamPath +
      '; the local implementation should be in ' +
      missingLocal +
      '.';
    resolveCurrentTokens.mockResolvedValue(new Map([[`file:${missingLocal}`, null]]));
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-UPSTREAM-URL', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-UPSTREAM-URL', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toMatchObject({
      flagged: true,
      paths: [missingLocal],
      note: expect.stringContaining('advisory only'),
    });
    expect(resolveCurrentTokens).toHaveBeenCalledWith(
      [`file:${missingLocal}`],
      { workspaceId: 'default', harness: 'papercup' },
      { allowDirectories: true },
    );
  });

  it('does not flag an extensionless TypeScript module path when its source file resolves', async () => {
    const modulePath = 'packages/operator-core/lib/search/bench/bm25-hybrid-recall';
    const body = 'The benchmark module is ' + modulePath + '.';
    resolveCurrentTokens
      .mockResolvedValueOnce(new Map([['file:' + modulePath, null]]))
      .mockResolvedValueOnce(new Map([['file:' + modulePath + '.ts', 'sha256:present']]));
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-EXTENSIONLESS-MODULE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-EXTENSIONLESS-MODULE', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toBeUndefined();
    expect(resolveCurrentTokens).toHaveBeenNthCalledWith(
      1,
      ['file:' + modulePath],
      { workspaceId: 'default', harness: 'papercup' },
      { allowDirectories: true },
    );
    const [suffixedDeps] = resolveCurrentTokens.mock.calls[1] as [string[]];
    expect(suffixedDeps).toContain('file:' + modulePath + '.ts');
  });

  it('still flags an extensionless path when no source-extension candidate resolves', async () => {
    const missing = 'packages/operator-core/lib/search/bench/missing-benchmark';
    const body = 'The benchmark module is ' + missing + '.';
    resolveCurrentTokens
      .mockResolvedValueOnce(new Map([['file:' + missing, null]]))
      .mockResolvedValueOnce(new Map());
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-MISSING-EXTENSIONLESS', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-MISSING-EXTENSIONLESS', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toMatchObject({
      flagged: true,
      paths: [missing],
      note: expect.stringContaining('advisory only'),
    });
  });

  it('does not flag an existing repository directory cited in narrative prose', async () => {
    const directory = 'apps/tui';
    const body = `The architecture lives under ${directory}; the implementation is ready.`;
    resolveCurrentTokens.mockResolvedValue(new Map([[`file:${directory}`, 'present:directory']]));
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-DIRECTORY', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-DIRECTORY', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toBeUndefined();
    expect(resolveCurrentTokens).toHaveBeenCalledWith(
      [`file:${directory}`],
      { workspaceId: 'default', harness: 'papercup' },
      { allowDirectories: true },
    );
  });

  it('checks a nested repository path as one complete path', async () => {
    const nested = 'libs/papercusp/packages/orchestrator/src/spawn-mcp.test.ts';
    const body = `Verified that ${nested} exists in the nested repository.`;
    resolveCurrentTokens.mockResolvedValue(new Map([[`file:${nested}`, 'sha256:present']]));
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-NESTED-REPO-PATH', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-NESTED-REPO-PATH', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toBeUndefined();
    expect(resolveCurrentTokens).toHaveBeenCalledWith([`file:${nested}`], {
      workspaceId: 'default',
      harness: 'papercup',
    }, { allowDirectories: true });
  });

  it('checks only narrative prose, not paths quoted by a structured recheck row', async () => {
    const recheckPath = 'packages/operator-core/lib/agent-tools/fleet/respawn-member.ts';
    const stored = withCarryNoteChecks('The implementation is ready.', [
      { claim: 'the surface is present', recheck: `read ${recheckPath}` },
    ]);
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-CHECK', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-PROSE-CHECK', checkpoint: stored });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toBeUndefined();
    expect(resolveCurrentTokens).not.toHaveBeenCalled();
  });

  it('fails open when the shared resolver cannot judge the prose paths', async () => {
    const body = 'The landed surface is packages/operator-core/lib/agent-tools/fleet/respawn-member.ts.';
    resolveCurrentTokens.mockRejectedValue(new Error('resolver unavailable'));
    getWorkItem.mockResolvedValue({ id: 'WI-PROSE-RESOLVER-FAIL', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-PROSE-RESOLVER-FAIL', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.prosePathLint).toBeUndefined();
  });
});

describe('EI-22995965169175295: qualified plan-decision refs in work-item checkpoint responses', () => {
  it('advises on unresolved qualified refs from the final stored note, without blocking the write', async () => {
    const stored = 'Resume from governed-plan#D-015 before the next holder; bare D-015 is not resolvable here.';
    const advisory = {
      flagged: true,
      refs: [
        {
          ref: 'governed-plan#D-015',
          slug: 'governed-plan',
          decisionId: 'D-015',
          reason: 'missing-plan',
        },
      ],
      note: 'decision_ref_lint: advisory only',
    };
    getWorkItem.mockResolvedValue({ id: 'WI-DECISION-REF', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);
    unresolvedPlanDecisionRefs.mockResolvedValueOnce(advisory);

    const result = await one({ id: 'WI-DECISION-REF', checkpoint: stored });

    expect(unresolvedPlanDecisionRefs).toHaveBeenCalledWith(stored, {
      workspaceId: 'default',
      harnessSlug: 'papercup',
    });
    expect(result).toMatchObject({ ok: true, decisionRefAdvisory: advisory });
  });

  it('fails open when the advisory resolver rejects', async () => {
    const stored = 'Resume from governed-plan#D-015.';
    getWorkItem.mockResolvedValue({ id: 'WI-DECISION-REF-FAIL', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);
    unresolvedPlanDecisionRefs.mockRejectedValueOnce(new Error('resolver unavailable'));

    const result = await one({ id: 'WI-DECISION-REF-FAIL', checkpoint: stored });

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('decisionRefAdvisory');
  });
});

describe('work_items:checkpoint — launched-but-unread run lint (EI-19455262557905604)', () => {
  const unread = [
    'Kicked off the full affected suite for the auth-rate-limit change.',
    'RESOLVED (6). REMAINING (5) — NOT yet diagnosed.',
    'Still running; output at /tmp/affected-9182.log.',
  ].join('\n');

  it('points at the PREDICTED form when prose reports a run the writer has not read', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: unread, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(unread);

    const result = await one({ id: 'WI-UNREAD', checkpoint: unread });

    expect(result.ok).toBe(true);
    expect(result.unreadRunLint).toMatchObject({
      flagged: true,
      note: expect.stringContaining('checks:[{ claim, recheck }]'),
      signals: {
        inFlight: expect.arrayContaining(['still running']),
        // The trailing sentence period must not ride along into the echoed path.
        runRefs: ['/tmp/affected-9182.log'],
      },
    });
    // D-098's constraint: advisory only — the write still happened.
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();
  });

  it('does not lint an unread-run advisory quoted from a peer checkpoint receipt', async () => {
    const body = [
      'Reconciled the work_items:checkpoint receipt for contentHash d6260111f61c that warns',
      "'run you launched but have not read (in-flight — /tmp/machine-first-commit-hop-0132.json)'.",
      'That peer-authored receipt was already read through the managed task; no unread local run exists.',
    ].join(' ');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-PEER-RECEIPT', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-PEER-RECEIPT', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });

  it('does not pair completed HTTP/JSON proof with a separate pending loop-status read (EI-26785326704021888)', async () => {
    const body = [
      'Completed and read HTTP evidence 21829544 and 21830124.',
      'Read /tmp/su51f-fidelity-runtime-ready-current.json.',
      'A separate loop-status CLI read 53849 is still running.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-UNRELATED-CONTROL-READ', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-UNRELATED-CONTROL-READ', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();
  });

  it('keeps a completed test log separate from a pending scorecard-repair output', async () => {
    const body = [
      'The focused test run completed and its output was read at /tmp/focused-tests.log, while a separate scorecards:repair process is still running;',
      'Output: /tmp/scorecard-repair.log.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-MIXED-TEST-REPAIR', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-MIXED-TEST-REPAIR', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.unreadRunLint).toMatchObject({
      flagged: true,
      signals: { inFlight: ['still running'], runRefs: ['/tmp/scorecard-repair.log'] },
    });
    expect(result.unreadRunLint.signals.runRefs).not.toContain('/tmp/focused-tests.log');
  });

  it('stays absent for an ordinary progress checkpoint', async () => {
    const body = 'Implemented the compatibility path and the focused test passes 7/7.';
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-CLEAN', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    expect(await one({ id: 'WI-UNREAD-CLEAN', checkpoint: body })).not.toHaveProperty('unreadRunLint');
  });

  it('does not flag a negated completed-run status as unread', async () => {
    const body = [
      'The selected job exited with code 1 and its log was read.',
      'No jobs still running.',
      'Read /tmp/selected-job.log before writing this checkpoint.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-NEGATED-STATUS', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-NEGATED-STATUS', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });

  it('ignores an unrelated in-flight compound even when the checkpoint also names a log', async () => {
    const body = [
      'Next: restore the in-flight store rebinding after refreshing the type definitions.',
      'Earlier typecheck output: /tmp/operation-api-types.log.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-UNRELATED-COMPOUND', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-UNRELATED-COMPOUND', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });

  it('still recognizes a run-specific in-flight phrase', async () => {
    const body = 'The typecheck run is still in-flight; output: /tmp/typecheck.log.';
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-IN-FLIGHT', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-IN-FLIGHT', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result.unreadRunLint).toMatchObject({
      flagged: true,
      signals: { inFlight: ['in-flight'], runRefs: ['/tmp/typecheck.log'] },
    });
  });

  it('does not pair a negated second-worker launch with a peer-owned diff', async () => {
    const body = [
      'The checkpoint preserves peer-owned source evidence from su-56361318.',
      'No second worker was launched.',
      'Preserved artifact: /tmp/su56361-launcher-source-loss-preserved.diff.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-PEER-DIFF', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-PEER-DIFF', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });

  it('does not pair historical launch prose with already-read JSON captures', async () => {
    const body = [
      'Historical note: an independent auditor was launched during the earlier recovery.',
      'Read captures: /tmp/su45-rubric3-exact.json and /tmp/su45-meta5-exact.json.',
    ].join('\n');
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-HISTORICAL-CAPTURES', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-HISTORICAL-CAPTURES', checkpoint: body });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });

  it('keeps an affirmative launched test with its output log as a positive control', async () => {
    const body = 'The verification test suite was launched; output: /tmp/verification-suite.log.';
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-LAUNCHED-POSITIVE', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: body, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(body);

    const result = await one({ id: 'WI-UNREAD-LAUNCHED-POSITIVE', checkpoint: body });

    expect(result.unreadRunLint).toMatchObject({
      flagged: true,
      signals: { inFlight: ['launched'], runRefs: ['/tmp/verification-suite.log'] },
    });
  });

  it('suppresses once ANY check row was stored — the writer has already found the affordance', async () => {
    const check = { claim: 'the affected suite is green', recheck: 'read /tmp/affected-9182.log' };
    const stored = withCarryNoteChecks(unread, [check]);
    getWorkItem.mockResolvedValue({ id: 'WI-UNREAD-COVERED', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);

    const result = await one({ id: 'WI-UNREAD-COVERED', checkpoint: unread, checks: [check] });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('unreadRunLint');
  });
});

describe('work_items:checkpoint — same-turn action proof (EI-21375032920365268/EI-22550731555241787)', () => {
  it('expands [turn:self] on the action-claim write path before persisting the checkpoint', async () => {
    const id = 'WI-ACTION-PROOF-CURRENT-TURN';
    const currentTurn = {
      ref: '[turn:01a13b68@2026-10-14T17:14:42.743Z]',
      verdict: 'agent-injected',
      origin: 'loop-fire',
    };
    const submitted = 'Messaged fleet leader su-bce40c51 directly; see [turn:self].';
    const expanded = submitted.replace('[turn:self]', currentTurn.ref);
    getWorkItem.mockResolvedValue({ id, harness: 'papercup' });
    resolveCurrentTurnStamp.mockClear();
    readSuccessfulActionInvocations.mockResolvedValueOnce([
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);
    resolveCurrentTurnStamp.mockResolvedValueOnce(currentTurn);
    setWorkItemCheckpoint.mockImplementation(async (_ref: unknown, checkpointText: string) => checkpointText);

    const result = await one({ id, checkpoint: submitted });

    expect(result.ok).toBe(true);
    expect(readSuccessfulActionInvocations).toHaveBeenCalledTimes(1);
    expect(resolveCurrentTurnStamp).toHaveBeenCalledTimes(1);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), expanded);
    expect(result.turnProvenance).toMatchObject({
      writtenDuring: currentTurn,
      refs: [{ ref: currentTurn.ref, found: true, checked: true, verdict: currentTurn.verdict }],
    });
    expect(result.provenanceLint).toBeUndefined();
  });

  it('queries the caller spawn with the stable owner fallback and clears only a successful matching coord action', async () => {
    const stored = 'Messaged fleet leader su-bce40c51 directly';
    getWorkItem.mockResolvedValue({ id: 'WI-ACTION-PROOF', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);
    readSuccessfulActionInvocations.mockResolvedValue([
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);

    const result = await one(
      { id: 'WI-ACTION-PROOF', checkpoint: stored },
      {
        uiClientId: 'opspawn-bee-1',
        sigVerifiedSpawn: true,
        workspaceId: 'default',
        harnessSlug: 'papercup',
        spawnId: 'spawn-action-proof',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.provenanceLint).toBeUndefined();
    expect(readSuccessfulActionInvocations).toHaveBeenCalledWith({
      workspaceId: 'default',
      spawnId: 'spawn-action-proof',
      coordOwnerId: 'opspawn-bee-1',
    });
  });

  it('uses the stable owner fallback when the caller has no spawn id', async () => {
    const stored = 'Messaged fleet leader su-bce40c51 directly';
    getWorkItem.mockResolvedValue({ id: 'WI-ACTION-PROOF-OWNER', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);
    readSuccessfulActionInvocations.mockResolvedValue([
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);

    const result = await one(
      { id: 'WI-ACTION-PROOF-OWNER', checkpoint: stored },
      {
        uiClientId: 'su-test',
        isSuperuser: true,
        workspaceId: 'default',
        harnessSlug: 'papercup',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.provenanceLint).toBeUndefined();
    expect(readSuccessfulActionInvocations).toHaveBeenCalledWith({
      workspaceId: 'default',
      spawnId: undefined,
      coordOwnerId: 'su-test',
    });
  });

  it('preserves the warning when the same-turn ledger cannot be read', async () => {
    const stored = 'Messaged fleet leader su-bce40c51 directly';
    getWorkItem.mockResolvedValue({ id: 'WI-ACTION-PROOF-FAIL', harness: 'papercup' });
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue(stored);
    readSuccessfulActionInvocations.mockResolvedValue(null);

    const result = await one(
      { id: 'WI-ACTION-PROOF-FAIL', checkpoint: stored },
      {
        uiClientId: 'opspawn-bee-1',
        sigVerifiedSpawn: true,
        workspaceId: 'default',
        harnessSlug: 'papercup',
        spawnId: 'spawn-action-proof-fail',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches[0]?.kind).toBe('unverified-action-claim');
  });
});

describe('work_items:checkpoint — unchanged attestation surface (P-007/R-06)', () => {
  const HASH = 'abc123def456';

  beforeEach(() => {
    attestWorkItemCheckpointUnchanged.mockReset();
    getWorkItem.mockResolvedValue({ id: 'WI-ATT', harness: 'papercup' });
  });

  it('refuses args that would CHANGE the body — an attestation writes no text', async () => {
    const result = await one({ id: 'WI-ATT', unchanged: true, contentHash: HASH, checkpoint: 'new prose' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('attestation_conflicting_args');
    expect(result.error).toContain('checkpoint');
    // The decisive assertion: it refused BEFORE reaching either store path, so a
    // contradictory call can never half-apply (text written, freshness attested).
    expect(attestWorkItemCheckpointUnchanged).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it.each([
    ['checks', { claim: 'the replacement row would change the carried checks' }],
    ['retireIds', 'carried-row-id'],
  ] as const)('refuses shorthand %s row mutations before attestation', async (field, value) => {
    attestWorkItemCheckpointUnchanged.mockResolvedValue({
      ok: true,
      currentHash: HASH,
      attestedCount: 1,
      bodyAgeMs: 0,
      remainingAttestations: 2,
    });

    const result = await one({
      id: 'WI-ATT',
      unchanged: true,
      contentHash: HASH,
      [field]: field === 'checks' ? [value] : [value],
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'attestation_conflicting_args',
    });
    expect(result.error).toContain(field);
    expect(attestWorkItemCheckpointUnchanged).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('refuses an attestation with no contentHash — you cannot attest a body you have not read', async () => {
    const result = await one({ id: 'WI-ATT', unchanged: true });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('attestation_hash_required');
    expect(attestWorkItemCheckpointUnchanged).not.toHaveBeenCalled();
  });

  it('EI-23074991388482969: treats blank contentHash as omitted in shorthand and items[] schemas', async () => {
    const shorthand = parse({ id: 'WI-ATT', unchanged: true, contentHash: '' }) as { contentHash?: string };
    const batch = parse({
      items: [{ id: 'WI-ATT', unchanged: true, contentHash: '   ' }],
    }) as { items: Array<{ contentHash?: string }> };

    expect(shorthand.contentHash).toBeUndefined();
    expect(batch.items[0].contentHash).toBeUndefined();

    const shorthandResult = await one({ id: 'WI-ATT', unchanged: true, contentHash: '' });
    const batchResult = await one({ items: [{ id: 'WI-ATT', unchanged: true, contentHash: '   ' }] });
    expect(shorthandResult.errorCode).toBe('attestation_hash_required');
    expect(batchResult.errorCode).toBe('attestation_hash_required');
    expect(attestWorkItemCheckpointUnchanged).not.toHaveBeenCalled();
  });

  it('on success reports the remaining budget and writes NO body', async () => {
    attestWorkItemCheckpointUnchanged.mockResolvedValue({
      ok: true,
      currentHash: HASH,
      attestedCount: 1,
      bodyAgeMs: 90 * 60_000,
      remainingAttestations: 2,
    });

    const result = await one({ id: 'WI-ATT', unchanged: true, contentHash: HASH });

    expect(result).toMatchObject({
      ok: true,
      attested: true,
      contentHash: HASH,
      attestedCount: 1,
      remainingAttestations: 2,
      bodyAgeMinutes: 90,
    });
    // The budget is stated in the response rather than left for the agent to track:
    // an agent that cannot see the remaining allowance cannot plan the real write.
    expect(result.note).toContain('2 attestation(s)');
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('maps an attestation transaction timeout to a structured retryable result', async () => {
    attestWorkItemCheckpointUnchanged.mockRejectedValueOnce(
      new OrgTxnTimeoutError('55P03', new Error('lock timeout'), 'likely blocked by pid 42'),
    );

    const result = await one({ id: 'WI-ATT', unchanged: true, contentHash: HASH });

    expect(result).toMatchObject({
      ok: false,
      id: 'WI-ATT',
      error: 'timeout',
      errorCode: 'timeout',
      retryable: true,
      pgCode: '55P03',
      message: expect.stringContaining('Checkpoint body was NOT changed'),
    });
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
  });

  it('turns each refusal into the remedy that clears it, not just a code', async () => {
    attestWorkItemCheckpointUnchanged.mockResolvedValue({
      ok: false,
      refusedReason: 'attestation_state_changed',
      currentHash: HASH,
      attestedCount: 0,
      bodyAgeMs: null,
      remainingAttestations: 0,
      itemUpdatedAtMs: Date.now(),
    });

    const result = await one({ id: 'WI-ATT', unchanged: true, contentHash: HASH });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('attestation_state_changed');
    expect(result.storedContentHash).toBe(HASH);
    // This branch exists so an agent does not bounce at a compaction boundary without
    // knowing the next move; a bare code would reproduce exactly that failure.
    expect(result.error).toContain('Write a real checkpoint');
    expect(result.bodyAgeMinutes).toBeNull();
  });

  it('leaves an ordinary checkpoint write completely untouched', async () => {
    setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'ordinary progress', priorLength: 0 });
    getWorkItemCheckpoint.mockResolvedValue('ordinary progress');

    const result = await one({ id: 'WI-ATT', checkpoint: 'ordinary progress' });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('attested');
    expect(attestWorkItemCheckpointUnchanged).not.toHaveBeenCalled();
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalled();
  });
});
