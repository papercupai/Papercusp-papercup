/**
 * rubrics-bulk.test.ts — rubrics:get (read) + rubrics:ratify (action) HANDLERS,
 * bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21). The
 * rubrics engine + identity are mocked. Pins the inline single form, the
 * rubricRefs:[…] many form (per-item results keyed by rubricRef), and a not-found
 * item failing only itself while the batch's top-level ok stays true.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/rubrics-bulk.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  formatVintageAge,
  lookupByMcpName,
  readJsonResult,
  resetServerVintageResolver,
  setServerVintageResolver,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
// rubricCompleteness is mocked shape-only here (WI-4287: ratify surfaces it per result);
// its real logic is pinned in lib/rubrics-loss-guards.test.ts.
vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    META_ACCEPTANCE_RUBRIC_ID: 'meta-acceptance-rubric',
    getRubric: vi.fn(),
    getRubricPlanRevision: vi.fn(),
    readRubricPlanRevision: vi.fn(),
    ratifyRubric: vi.fn(),
    rubricCompleteness: vi.fn(() => ({ criteriaWithoutReplication: [], methodRefMissing: false, complete: true })),
  };
});
// The production vetting path probes the current critique channel before falling
// back to meta-scorecards. Keep this handler unit suite on its existing rubric /
// scorecard seams instead of opening a real Postgres connection for that probe.
vi.mock('../../acceptance-rubric-critique', () => ({
  readCurrentAcceptanceRubricCritique: vi.fn(async () => null),
}));
vi.mock('../../scorecards', () => ({
  listScorecards: vi.fn(),
  settledGradingAuditIsCurrent: (row: {
    gradingAudit?: { state?: string };
    gradingAuditCurrentness?: { state?: string };
  }) =>
    !row.gradingAudit ||
    (row.gradingAudit.state === 'passed' &&
      row.gradingAuditCurrentness?.state !== 'stale' &&
      row.gradingAuditCurrentness?.state !== 'unknown'),
}));

import {
  getRubric,
  getRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
  ratifyRubric,
  readRubricPlanRevision,
} from '../../rubrics';
import type { Rubric } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import { mockResolvedTyped } from '../../testing/typed-mock';
const getM = vi.mocked(getRubric);
const getRevisionM = vi.mocked(getRubricPlanRevision);
const revisionM = vi.mocked(readRubricPlanRevision);
const ratifyM = vi.mocked(ratifyRubric);
const listScorecardsM = vi.mocked(listScorecards);

/**
 * A COMPLETE, typed `Rubric` — the typed-mock alternative to `{ … } as never`
 * (check-mock-cast-escape.mjs ratchets that cast count). Referenced by BOTH the
 * mocked resolve and the echo assertion, so the fixture cannot drift from what the
 * handler is expected to hand back.
 */
const RUBRIC_R1: Rubric = {
  rubricId: 'r-1',
  workspaceId: 'default',
  kind: 'standard',
  gradingAuthority: 'independent',
  characteristic: 'hive-coordination',
  title: 'r-1',
  description: '',
  criteria: [],
  ratingScale: [],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ACCEPTANCE_RUBRIC: Rubric = {
  ...RUBRIC_R1,
  rubricId: 'acceptance-rubric',
  kind: 'acceptance',
  criteria: [
    {
      key: 'criterion-1',
      title: 'Criterion 1',
      model: 'The criterion is true.',
      method: 'Check the criterion.',
      driftMarkers: 'The criterion is false.',
    },
  ],
};

const META_ACCEPTANCE_RUBRIC: Rubric = {
  ...RUBRIC_R1,
  rubricId: META_ACCEPTANCE_RUBRIC_ID,
};

const getModule = await import('./get');
const getTool = getModule.default;
const ratifyTool = (await import('./ratify')).default;

type Out = { data: any };
const body = async (tool: typeof getTool | typeof ratifyTool, args: unknown) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  resetServerVintageResolver();
  getRevisionM.mockResolvedValue(null);
  revisionM.mockResolvedValue({ ok: true, revision: null });
  listScorecardsM.mockResolvedValue([]);
});

afterEach(() => resetServerVintageResolver());

const vettingCard = (rubricRevision: number) => ({
  issueId: 'EI-vetting',
  createdAt: '2026-09-06T00:00:00.000Z',
  createdBy: 'su-reviewer',
  rubricRef: META_ACCEPTANCE_RUBRIC_ID,
  ratings: {},
  nKeys: 1,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  vetting: { consultId: 'consult-vetting', rubricRevision },
});

const mockAcceptanceVetting = (cards: unknown[]) => {
  getM.mockImplementation(async (id: string) => {
    if (id === ACCEPTANCE_RUBRIC.rubricId) return ACCEPTANCE_RUBRIC;
    if (id === META_ACCEPTANCE_RUBRIC_ID) return META_ACCEPTANCE_RUBRIC;
    return null;
  });
  getRevisionM.mockResolvedValue(7);
  revisionM.mockResolvedValue({ ok: true, revision: 7 });
  listScorecardsM.mockResolvedValue(cards as never);
};

describe('rubrics:get handler (bulk keyed-array)', () => {
  it.each([[true, 'full'], [false, 'summary']] as const)('detail %s and %s select identical rubric scope and tier', async (booleanDetail, stringDetail) => {
    mockResolvedTyped(getM, RUBRIC_R1);
    const aliased = await body(getTool, { rubricRef: 'r-1', detail: booleanDetail });
    const canonical = await body(getTool, { rubricRef: 'r-1', detail: stringDetail });
    expect(aliased).toEqual(canonical);
    expect(aliased.results[0]).toMatchObject({ ok: true, rubricRef: 'r-1' });
    if (booleanDetail) {
      expect(aliased.results[0].rubric.criteria).toEqual(RUBRIC_R1.criteria);
      expect(aliased.results[0]).not.toHaveProperty('fullBody');
    } else {
      expect(aliased.results[0]).toMatchObject({ detail: stringDetail });
      expect(aliased.results[0]).toHaveProperty('fullBody.args.detail', 'full');
    }
  });

  it('inline { rubricRef } returns a single result', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const b = await body(getTool, { rubricRef: 'r-1', detail: 'full' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricRef: 'r-1', rubric: { id: 'r-1' } });
  });

  it('accepts generic { ref } at projected dispatch as a single-rubric alias', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'rubrics:get',
      { ref: 'r-1', detail: 'full' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'rubrics-get-ref-alias-test',
        isSuperuser: true,
        uiClientId: 'su-rubrics-get-ref-alias-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ results: Array<{ rubricRef: string; ok: boolean }> }>(dispatched.result!);
    expect(payload?.results).toEqual([{ ok: true, rubricRef: 'r-1', rubric: { id: 'r-1', criteria: [] } }]);
    expect(getM).toHaveBeenCalledWith('r-1');
  });

  it('accepts caller-natural { slug } at projected dispatch as a single-rubric alias', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'rubrics:get',
      { slug: 'r-1', detail: 'full' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'rubrics-get-slug-alias-test',
        isSuperuser: true,
        uiClientId: 'su-rubrics-get-slug-alias-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ results: Array<{ rubricRef: string; ok: boolean }> }>(dispatched.result!);
    expect(payload?.results).toEqual([{ ok: true, rubricRef: 'r-1', rubric: { id: 'r-1', criteria: [] } }]);
    expect(getM).toHaveBeenCalledWith('r-1');
  });

  it('accepts legacy { id } at projected dispatch as a single-rubric alias', async () => {
    getM.mockResolvedValue({ id: 'r-1', criteria: [] } as never);
    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'rubrics:get',
      { id: 'r-1', detail: 'full' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'rubrics-get-id-alias-test',
        isSuperuser: true,
        uiClientId: 'su-rubrics-get-id-alias-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ results: Array<{ rubricRef: string; ok: boolean }> }>(dispatched.result!);
    expect(payload?.results).toEqual([{ ok: true, rubricRef: 'r-1', rubric: { id: 'r-1', criteria: [] } }]);
    expect(getM).toHaveBeenCalledWith('r-1');
  });

  it('normalizes typed plan provenance refs for lookup while preserving the keyed input ref', async () => {
    getM.mockImplementation(async (id: string) => (id === 'plan-class-feature-ship' ? RUBRIC_R1 : null));

    const b = await body(getTool, { ref: 'plan:plan-class-feature-ship', detail: 'full' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      rubricRef: 'plan:plan-class-feature-ship',
      rubric: RUBRIC_R1,
    });
    expect(getM).toHaveBeenCalledWith('plan-class-feature-ship');
  });

  it('normalizes typed plan provenance refs for the backing-row diagnostic too', async () => {
    getM.mockResolvedValue(null);
    revisionM.mockResolvedValue({ ok: true, revision: 6 });

    const b = await body(getTool, { rubricRef: 'plan:acceptance-rubric' });

    expect(b.results[0]).toMatchObject({
      ok: false,
      rubricRef: 'plan:acceptance-rubric',
      error: 'rubric not found; a backing rubric plan row exists at revision 6, but this server could not project it.',
    });
    expect(revisionM).toHaveBeenCalledWith('acceptance-rubric');
  });

  it('accepts an optional harness hint without filtering the workspace-wide read', async () => {
    mockResolvedTyped(getM, RUBRIC_R1);
    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'rubrics:get',
      { rubricRef: 'r-1', harness: 'papercusp', detail: 'full' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'rubrics-get-harness-hint-test',
        isSuperuser: true,
        uiClientId: 'su-rubrics-get-harness-hint-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ results: Array<{ rubricRef: string; ok: boolean }> }>(dispatched.result!);
    expect(payload?.results).toEqual([{ ok: true, rubricRef: 'r-1', rubric: RUBRIC_R1 }]);
    expect(getM).toHaveBeenCalledWith('r-1');
  });

  it('prefers canonical rubricRef when ref is also supplied', async () => {
    getM.mockImplementation(async (id: string) => ({ id } as never));
    const b = await body(getTool, { rubricRef: 'canonical', ref: 'alias', slug: 'slug-alias', id: 'legacy-id' });
    expect(b.results.map((r: { rubricRef: string }) => r.rubricRef)).toEqual(['canonical']);
    expect(getM).toHaveBeenCalledWith('canonical');
    expect(getM).not.toHaveBeenCalledWith('alias');
    expect(getM).not.toHaveBeenCalledWith('slug-alias');
    expect(getM).not.toHaveBeenCalledWith('legacy-id');
  });

  it('rubricRefs:[…] fetches many; a not-found item fails only itself', async () => {
    getM.mockImplementation(async (id: string) => (id === 'gone' ? null : ({ id } as never)));
    const b = await body(getTool, { rubricRefs: ['r-1', 'gone', 'r-2'] });
    expect(b.ok).toBe(false); // DERIVED from counts.failed — 'gone' failed
    expect(b.counts).toEqual({ ok: 2, failed: 1 }); // …but the batch still RAN: r-1/r-2 succeeded
    expect(b.results.map((r: { rubricRef: string; ok: boolean }) => [r.rubricRef, r.ok])).toEqual([
      ['r-1', true],
      ['gone', false],
      ['r-2', true],
    ]);
    expect(b.results[1]).toMatchObject({ ok: false, rubricRef: 'gone', error: 'rubric not found' });
  });

  it('bounds independent bulk reads with the shared worker-pool ceiling', async () => {
    let active = 0;
    let peak = 0;
    getM.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return { id } as never;
      } finally {
        active -= 1;
      }
    });

    const refs = Array.from({ length: 10 }, (_, index) => `r-${index}`);
    const b = await body(getTool, { rubricRefs: refs });

    expect(b).toMatchObject({ ok: true, counts: { ok: refs.length, failed: 0 } });
    expect(peak).toBe(getModule.RUBRICS_GET_MAX_CONCURRENCY);
  });

  it('reads an exact immutable revision and returns its selected revision plus criteria fingerprint', async () => {
    const historical = { ...RUBRIC_R1, revision: 3, criteriaHash: 'criteria-hash-r3' };
    getM.mockImplementation(async (_id: string, revision?: number) => (revision === 3 ? historical : null));

    const b = await body(getTool, { rubricRef: 'r-1', revision: 3 });

    const projected = lookupByMcpName('rubrics:get');
    expect(projected?.inputSchema).toMatchObject({
      properties: { revision: expect.anything() },
    });
    expect(getM).toHaveBeenCalledWith('r-1', 3);
    expect(b.results[0]).toMatchObject({
      ok: true,
      rubricRef: 'r-1',
      rubric: { revision: 3, criteriaHash: 'criteria-hash-r3' },
    });
  });

  it('fails closed when the requested immutable revision is unavailable instead of falling back to current', async () => {
    getM.mockResolvedValue(null);
    revisionM.mockResolvedValue({ ok: true, revision: 4 });

    const b = await body(getTool, { rubricRef: 'r-1', revision: 3 });

    expect(getM).toHaveBeenCalledTimes(1);
    expect(getM).toHaveBeenCalledWith('r-1', 3);
    expect(b.results[0]).toMatchObject({
      ok: false,
      rubricRef: 'r-1',
      error: 'rubric revision 3 not found; current revision is 4',
    });
  });

  it('reports an exact revision projection failure without treating it as a current read', async () => {
    getM.mockResolvedValue(null);
    revisionM.mockResolvedValue({ ok: true, revision: 3 });

    const b = await body(getTool, { rubricRef: 'r-1', revision: 3 });

    expect(b.results[0]).toMatchObject({
      ok: false,
      rubricRef: 'r-1',
      error:
        'rubric revision 3 exists, but its immutable snapshot could not be projected. ' +
        'Preview rubrics:repair { rubricRef, rubricRevision: 3, dryRun:true } for a missing current first-party version; omit rubricRevision to inspect an exact-current-body legacy chain.',
    });
  });

  it('surfaces a current acceptance-rubric vetting attestation', async () => {
    mockAcceptanceVetting([vettingCard(7)]);

    const b = await body(getTool, { rubricRef: ACCEPTANCE_RUBRIC.rubricId });

    expect(b.results[0].vetting).toMatchObject({
      required: true,
      satisfied: true,
      state: 'vetted',
      currentRevision: 7,
      attestedRevision: 7,
      attestedRevisions: [7],
    });
    expect(listScorecardsM).toHaveBeenCalledWith({
      rubricRef: META_ACCEPTANCE_RUBRIC_ID,
      subjectRef: ACCEPTANCE_RUBRIC.rubricId,
      limit: 50,
    });
  });

  it('surfaces stale acceptance-rubric vetting after the rubric revision changes', async () => {
    mockAcceptanceVetting([vettingCard(6)]);

    const b = await body(getTool, { rubricRef: ACCEPTANCE_RUBRIC.rubricId });

    expect(b.results[0].vetting).toMatchObject({
      required: true,
      satisfied: false,
      state: 'unvetted',
      reason: 'stale-attestation',
      currentRevision: 7,
      attestedRevision: 6,
      attestedRevisions: [6],
    });
  });

  it('surfaces missing acceptance-rubric vetting when no attestation exists', async () => {
    mockAcceptanceVetting([]);

    const b = await body(getTool, { rubricRef: ACCEPTANCE_RUBRIC.rubricId });

    expect(b.results[0].vetting).toMatchObject({
      required: true,
      satisfied: false,
      state: 'unvetted',
      reason: 'missing-attestation',
      currentRevision: 7,
      attestedRevision: null,
      attestedRevisions: [],
    });
  });

  it('diagnoses a projected miss when the versioned backing rubric plan row exists', async () => {
    getM.mockResolvedValue(null);
    revisionM.mockResolvedValue({ ok: true, revision: 6 });
    setServerVintageResolver(() => ({
      buildId: 'stale-build',
      bootedAgoMs: 2 * 60 * 60_000,
      freshCodeEndpoint: 'the Papercusp staging operator at :3170',
    }));

    const b = await body(getTool, { rubricRef: 'acceptance-rubric' });
    const result = b.results[0];

    expect(result).toMatchObject({ ok: false, rubricRef: 'acceptance-rubric' });
    expect(result.error).toContain('a backing rubric plan row exists at revision 6');
    expect(result.error).toContain('build stale-build');
    expect(result.error).toContain(`started ${formatVintageAge(2 * 60 * 60_000)} ago`);
    expect(result.error).toContain('retry this call against the Papercusp staging operator at :3170');
    expect(revisionM).toHaveBeenCalledWith('acceptance-rubric');
  });

  it('does not collapse a failed backing-row probe into a false not-found', async () => {
    getM.mockResolvedValue(null);
    revisionM.mockResolvedValue({ ok: false, revision: null });
    setServerVintageResolver(() => ({
      buildId: 'stale-build',
      bootedAgoMs: 2 * 60 * 60_000,
      freshCodeEndpoint: 'the Papercusp staging operator at :3170',
    }));

    const b = await body(getTool, { rubricRef: 'unknown-rubric' });

    expect(b.results[0]).toMatchObject({
      ok: false,
      rubricRef: 'unknown-rubric',
      error:
        'rubric could not be resolved because the backing plan read failed; retry or verify independently before treating it as absent',
    });
    expect(b.results[0].error).not.toBe('rubric not found');
    expect(revisionM).toHaveBeenCalledWith('unknown-rubric');
  });

  it('dedups rubricRef + rubricRefs into one merged list', async () => {
    getM.mockImplementation(async (id: string) => ({ id } as never));
    const b = await body(getTool, { rubricRef: 'r-1', rubricRefs: ['r-1', 'r-2'] });
    expect(b.results.map((r: { rubricRef: string }) => r.rubricRef)).toEqual(['r-1', 'r-2']);
  });

  it('keeps every criterion through an ambient trimmed dispatch', async () => {
    const criteria = Array.from({ length: 26 }, (_, i) => ({
      key: `criterion-${i + 1}`,
      title: `Criterion ${i + 1} ${'t'.repeat(120)}`,
      model: 'm',
      method: `method-${i + 1} ${'m'.repeat(120)}`,
      driftMarkers: `drift-${i + 1} ${'d'.repeat(120)}`,
      replication: `replication-${i + 1} ${'r'.repeat(120)}`,
      instrumentKey: `instrument-${i + 1}`,
    }));
    mockResolvedTyped(getM, { ...RUBRIC_R1, rubricId: 'large-rubric', criteria });

    // EI-21406267171411887's property now belongs to the FULL body (P-007 made summary the
    // default): a grader who asks for detail:'full' must get every criterion un-projected.
    const raw = await body(getTool, { rubricRef: 'large-rubric', detail: 'full' });
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'rubrics:get',
      { rubricRef: 'large-rubric', detail: 'full' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'rubrics-get-completeness-test',
        isSuperuser: true,
        uiClientId: 'su-rubrics-get-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      results: Array<{ rubric?: { criteria: Array<{ key: string; method: string }> } }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.results[0]?.rubric?.criteria).toHaveLength(26);
    expect(payload?.results[0]?.rubric?.criteria.map((criterion) => criterion.key)).toEqual(
      criteria.map((criterion) => criterion.key),
    );
    expect(payload?.results[0]?.rubric?.criteria.every((criterion) => criterion.method.length > 120)).toBe(true);
  });

  // review-system-rework-reduction-2026-09-23 P-007, clause RSR-P-007-A. Falsifier: the
  // default response carries the full body, or omits the ref to it.
  it('defaults to a criteria index plus a fullBody ref, and returns criteria prose only with detail:"full"', async () => {
    const criteria = Array.from({ length: 26 }, (_, i) => ({
      key: `criterion-${i + 1}`,
      title: `Criterion ${i + 1}`,
      model: `model-${i + 1} ${'m'.repeat(200)}`,
      method: `method-${i + 1} ${'m'.repeat(200)}`,
      driftMarkers: `drift-${i + 1} ${'d'.repeat(200)}`,
    }));
    mockResolvedTyped(getM, { ...RUBRIC_R1, rubricId: 'large-rubric', criteria, criteriaHash: 'sha256:criteria' });

    const summary = await body(getTool, { rubricRef: 'large-rubric' });
    const full = await body(getTool, { rubricRef: 'large-rubric', detail: 'full' });

    const compact = summary.results[0];
    expect(compact).toMatchObject({
      ok: true,
      rubricRef: 'large-rubric',
      detail: 'summary',
      rubric: { rubricId: 'large-rubric', criteriaHash: 'sha256:criteria' },
      fullBody: {
        tool: 'rubrics:get',
        args: { rubricRef: 'large-rubric', detail: 'full' },
        omitted: expect.arrayContaining(['rubric.criteria[].model', 'rubric.criteria[].method']),
      },
    });
    expect(compact.rubric.criteria.map((c: { key: string }) => c.key)).toEqual(criteria.map((c) => c.key));
    for (const criterion of compact.rubric.criteria) {
      expect(criterion).not.toHaveProperty('model');
      expect(criterion).not.toHaveProperty('method');
      expect(criterion).not.toHaveProperty('driftMarkers');
    }

    expect(full.results[0]).not.toHaveProperty('fullBody');
    expect(full.results[0].rubric.criteria[0].method.length).toBeGreaterThan(200);
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 4);
  });

  it("declares the full rubric body oversize-by-design so the outer result door cannot hide criteria", () => {
    const projected = lookupByMcpName('rubrics:get');
    expect(projected).toBeDefined();
    expect(projected?.skipResultDoor).toBe('oversize-by-design');
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
  });
});

describe('rubrics:ratify handler (bulk keyed-array)', () => {
  it('ratifies one inline and returns the activated rubric', async () => {
    mockResolvedTyped(ratifyM, { ...RUBRIC_R1, status: 'active' });
    const b = await body(ratifyTool, { rubricRef: 'r-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricRef: 'r-1', rubric: { status: 'active' } });
    // WI-4287: each activated rubric reports its testing-procedure completeness.
    expect(b.results[0].completeness).toEqual({
      criteriaWithoutReplication: [],
      methodRefMissing: false,
      complete: true,
    });
    expect(ratifyM).toHaveBeenCalledWith('r-1', 'me');
  });

  it('ratifies MANY via rubricRefs:[…]; a missing one fails only itself', async () => {
    ratifyM.mockImplementation(async (id: string) => (id === 'gone' ? null : ({ id, status: 'active' } as never)));
    const b = await body(ratifyTool, { rubricRefs: ['r-1', 'gone'] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, rubricRef: 'r-1' });
    expect(b.results[1]).toMatchObject({ ok: false, rubricRef: 'gone', error: 'rubric not found' });
  });
});

/**
 * ROUND-TRIP GUARD (EI-22084112133846580) — the identifying key a bulk result row
 * carries must be a key the SAME tool accepts as input.
 *
 * These two tools emitted `rubricId` while their schemas accept only
 * rubricRef/rubricRefs/ref/slug — P-005/EI-11400 having retired `rubricId` as a
 * public argument on purpose. The strict-args did-you-mean hint rescued each
 * individual call, but the result key kept re-teaching the rejected spelling, so
 * the failure recurred until the watchdog promoted it to a bug.
 *
 * Asserted as a PROPERTY (result key ∈ input keys), not as the literal string
 * 'rubricRef', so it stays true if the canonical spelling is ever renamed again.
 */
describe('bulk result rows round-trip into the input schema', () => {
  // `fullBody` (P-007) is a recovery REF to the full read, not an identifying key; its own
  // `args` are asserted to be accepted input by the P-007 test above.
  const NON_KEY_FIELDS = new Set(['ok', 'rubric', 'vetting', 'error', 'completeness', 'replicationSqlCheck', 'fullBody']);

  const inputKeys = (toolName: string): string[] => {
    const tool = lookupByMcpName(toolName);
    expect(tool, `${toolName} not registered`).toBeDefined();
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    expect(properties, `${toolName} must publish an input schema`).toBeDefined();
    return Object.keys(properties ?? {});
  };

  const identifyingKeys = (row: Record<string, unknown>): string[] =>
    Object.keys(row).filter((k) => !NON_KEY_FIELDS.has(k));

  it('rubrics:get echoes only keys its own schema accepts', async () => {
    mockResolvedTyped(getM, RUBRIC_R1);
    const b = await body(getTool, { rubricRef: 'r-1' });
    const keys = identifyingKeys(b.results[0]);
    expect(keys, 'a result row must identify itself by some key').not.toHaveLength(0);
    for (const key of keys) {
      expect(
        inputKeys('rubrics:get'),
        `rubrics:get emits \`${key}\` but will not accept it back as an argument`,
      ).toContain(key);
    }
  });

  it('rubrics:ratify echoes only keys its own schema accepts', async () => {
    mockResolvedTyped(ratifyM, { ...RUBRIC_R1, status: 'active' });
    const b = await body(ratifyTool, { rubricRef: 'r-1' });
    const keys = identifyingKeys(b.results[0]);
    expect(keys, 'a result row must identify itself by some key').not.toHaveLength(0);
    for (const key of keys) {
      expect(
        inputKeys('rubrics:ratify'),
        `rubrics:ratify emits \`${key}\` but will not accept it back as an argument`,
      ).toContain(key);
    }
  });

  it('neither tool re-admits the retired `rubricId` argument (P-005/EI-11400)', () => {
    for (const toolName of ['rubrics:get', 'rubrics:ratify']) {
      expect(inputKeys(toolName), `${toolName} must not re-admit rubricId`).not.toContain('rubricId');
    }
  });
});
