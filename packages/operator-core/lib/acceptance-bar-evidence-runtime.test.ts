/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-002/P-006 — a live/deployed BAR names
 * the RUNTIME its evidence is measured on, and the ship door checks THAT runtime.
 *
 * The failure this guards: `live` had no definition, so every agent and grader resolved
 * it to :3070 (green main) and waited on a deploy the code under test never needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  evidenceRecordsAbsent,
  evidenceRuntimeOf,
  evidenceRuntimeUnmet,
  resolveBarEvidenceRuntime,
  sourcePathsIn,
} from './acceptance-bar-evidence-runtime';
import {
  acceptanceEvidenceRuntimeSchema,
  requirementAcceptanceSchema,
  rubricTemplateDataSchema,
  stripUnknownCriterionKeys,
} from './agent-tools/plans/rubric-template';
import { computeAcceptanceBarHash, normalizeAcceptanceBarCriterion } from './rubrics';
import type { AcceptanceBarContractSnapshot, AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';
import { evaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';

vi.mock('./acceptance-bar-contract-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acceptance-bar-contract-snapshot')>()),
  readAcceptanceBarContractSnapshot: vi.fn(),
}));

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';
const OPERATOR_PATH = 'packages/operator-core/lib/agent-tools/plans/get.ts';
const PORTAL_RUNTIME = 'runtime-vintage:papercusp-workspace/portal-web@builder' as const;

describe('schema', () => {
  it('exports the runtime declaration as JSON Schema for the complete tool catalog', () => {
    const schema = z.toJSONSchema(requirementAcceptanceSchema);
    expect(JSON.stringify(schema)).toContain('runtime-vintage:');
    expect(JSON.stringify(schema)).toContain('pattern');
  });
  it('accepts a catalog runtime and refuses aliases in a declaration', () => {
    expect(acceptanceEvidenceRuntimeSchema.parse('bg-host')).toBe('bg-host');
    expect(() => acceptanceEvidenceRuntimeSchema.parse(':3070')).toThrow();
    const parsed = requirementAcceptanceSchema.parse({
      condition: 'x',
      falsifier: 'y',
      evidencePlane: 'live',
      evidenceRuntime: 'staging-operator',
    });
    expect(parsed.evidenceRuntime).toBe('staging-operator');
  });

  it('accepts an exact external registry identity through the requirement schema', () => {
    expect(acceptanceEvidenceRuntimeSchema.parse(PORTAL_RUNTIME)).toBe(PORTAL_RUNTIME);
    expect(requirementAcceptanceSchema.parse({
      condition: 'Hosted voice works', falsifier: 'Hosted voice fails',
      evidencePlane: 'live', evidenceRuntime: PORTAL_RUNTIME,
    }).evidenceRuntime).toBe(PORTAL_RUNTIME);
  });

  it('refuses external names and incomplete or malformed registry identities', () => {
    for (const value of [
      'portal', 'runtime-vintage:portal-web', 'runtime-vintage:portal-web@builder',
      'runtime-vintage:/portal-web@builder', 'runtime-vintage:workspace/@builder',
      'runtime-vintage:workspace/portal-web@', `${PORTAL_RUNTIME}/extra`,
      `${PORTAL_RUNTIME} trailing`, { unit: 'portal-web', host: 'builder' },
    ]) expect(acceptanceEvidenceRuntimeSchema.safeParse(value).success).toBe(false);
  });
});

describe('barHash', () => {
  const base = {
    key: 'r-1',
    barKey: 'R-1',
    model: 'The ingest drains every host ledger.',
    driftMarkers: 'Rows stop arriving.',
    requiredScope: ['live'],
    evidencePlane: 'live' as const,
    role: 'outcome' as const,
    mandatory: true,
    passRatings: ['healthy'],
  };

  it('is byte-stable for a BAR that declares no runtime (every pre-existing BAR keeps its hash)', () => {
    // Pinned literal. With no evidenceRuntime the hash material is exactly the pre-P-002
    // tuple, so this is the value every stored BAR of this shape already carries. If the
    // new field is ever hashed unconditionally (e.g. as null), this literal breaks — which
    // is the point: every stored BAR in the fleet would otherwise silently re-hash.
    expect(computeAcceptanceBarHash(base)).toBe('37a0e22bc00173e18ea6667351e7f973ba74e26946972f9ee0bdb983c76d8b85');
    expect(computeAcceptanceBarHash({ ...base, evidenceRuntime: undefined })).toBe(computeAcceptanceBarHash(base));
  });

  it('declaring a runtime changes the promise, so it re-hashes', () => {
    expect(computeAcceptanceBarHash({ ...base, evidenceRuntime: 'bg-host' })).not.toBe(computeAcceptanceBarHash(base));
  });

  it('flows from the acceptance section through normalization', () => {
    const normalized = normalizeAcceptanceBarCriterion({
      key: 'r-1',
      title: 'Ingest',
      barKey: 'R-1',
      acceptance: { ...base, condition: base.model, falsifier: base.driftMarkers, evidenceRuntime: 'bg-host' },
      verification: { method: 'census' },
    } as never);
    expect(normalized.evidenceRuntime).toBe('bg-host');
  });

  it('preserves and hashes the full external workspace/unit/host identity', () => {
    const normalized = normalizeAcceptanceBarCriterion({
      key: 'r-1', title: 'Hosted voice', barKey: 'R-1',
      acceptance: { ...base, condition: base.model, falsifier: base.driftMarkers, evidenceRuntime: PORTAL_RUNTIME },
      verification: { method: 'Read the exact vintage row and hosted artifact' },
    } as never);
    expect(normalized.evidenceRuntime).toBe(PORTAL_RUNTIME);
    const hash = computeAcceptanceBarHash({ ...base, evidenceRuntime: PORTAL_RUNTIME });
    for (const runtime of [
      'runtime-vintage:other-workspace/portal-web@builder',
      'runtime-vintage:papercusp-workspace/other-unit@builder',
      'runtime-vintage:papercusp-workspace/portal-web@other-host',
    ] as const) expect(computeAcceptanceBarHash({ ...base, evidenceRuntime: runtime })).not.toBe(hash);
  });
});

describe('rollout safety — an older reader must not lose a rubric that carries the new field', () => {
  const stored = {
    kind: 'acceptance',
    subjectPlan: 'plan-a',
    characteristic: 'plan-a acceptance',
    ratingScale: ['healthy', 'broken', 'unknown'],
    criteria: [
      {
        key: 'r-1',
        title: 'Ingest',
        model: 'The ingest drains every host ledger.',
        method: 'census',
        driftMarkers: 'rows stop arriving',
        // a field THIS build knows, plus one a hypothetical newer build added
        evidenceRuntime: 'bg-host',
        someFutureField: { x: 1 },
      },
    ],
  };

  it('strips only UNKNOWN criterion keys, so the strict template schema parses the rest', () => {
    expect(rubricTemplateDataSchema.safeParse(stored).success).toBe(false);
    const tolerant = stripUnknownCriterionKeys(stored);
    expect(tolerant.stripped).toEqual(['someFutureField']);
    const parsed = rubricTemplateDataSchema.safeParse(tolerant.data);
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data.criteria[0] as { evidenceRuntime?: string }).evidenceRuntime).toBe('bg-host');
  });

  it('never masks a malformed KNOWN field, and is a no-op on clean data', () => {
    const bad = { ...stored, criteria: [{ ...stored.criteria[0], evidenceRuntime: 'not-a-runtime', someFutureField: undefined }] };
    const tolerant = stripUnknownCriterionKeys(bad);
    expect(rubricTemplateDataSchema.safeParse(tolerant.data).success).toBe(false);
    const clean = { ...stored, criteria: [{ ...stored.criteria[0], someFutureField: undefined }] };
    delete (clean.criteria[0] as Record<string, unknown>).someFutureField;
    expect(stripUnknownCriterionKeys(clean)).toEqual({ data: clean, stripped: [] });
  });
});

describe('resolveBarEvidenceRuntime', () => {
  it('keeps an external live declaration exact without substituting an operator', () => {
    expect(resolveBarEvidenceRuntime({ evidencePlane: 'live', evidenceRuntime: PORTAL_RUNTIME })).toEqual({
      runtime: PORTAL_RUNTIME, source: 'declared', reviewFlag: false, inferredFrom: [],
    });
  });
  it('tree BARs need no runtime', () => {
    expect(resolveBarEvidenceRuntime({ evidencePlane: 'tree' })).toMatchObject({ source: 'not-applicable', reviewFlag: false });
  });

  it('a declared runtime is authoritative and unflagged', () => {
    expect(resolveBarEvidenceRuntime({ evidencePlane: 'live', evidenceRuntime: 'gateway' })).toEqual({
      runtime: 'gateway',
      source: 'declared',
      reviewFlag: false,
      inferredFrom: [],
    });
  });

  it('infers bg-host from a bg-host-owned source path, flagged for review', () => {
    expect(resolveBarEvidenceRuntime({ evidencePlane: 'live', method: `Census rows produced by ${BG_PATH}.` })).toEqual({
      runtime: 'bg-host',
      source: 'inferred',
      reviewFlag: true,
      inferredFrom: [BG_PATH],
    });
  });

  it('infers the STAGING operator — never the release operator — for operator-served code', () => {
    const r = resolveBarEvidenceRuntime({ evidencePlane: 'deployed', method: `Call the tool implemented in ${OPERATOR_PATH}` });
    expect(r.runtime).toBe('staging-operator');
    expect(r.source).toBe('inferred');
  });

  it('honors an explicit deployed :3070 requirement over an operator source-path inference', () => {
    const r = resolveBarEvidenceRuntime({
      evidencePlane: 'deployed',
      method: `Compare bytes in the deployed :3070 release checkout for ${OPERATOR_PATH}`,
    });
    expect(r).toMatchObject({ runtime: 'release-operator', source: 'inferred', reviewFlag: true });
  });

  it('with nothing to infer from it is unresolved + flagged, never silently :3070', () => {
    expect(resolveBarEvidenceRuntime({ evidencePlane: 'live', method: 'Check the dashboard looks right.' })).toEqual({
      runtime: null,
      source: 'unresolved',
      reviewFlag: true,
      inferredFrom: [],
    });
  });

  it('source paths ignore test files (proof, not subject) and conflicting owners stay unresolved', () => {
    expect(sourcePathsIn(`see ${BG_PATH} and packages/operator-core/lib/x.test.ts`)).toEqual([BG_PATH]);
    expect(
      resolveBarEvidenceRuntime({ evidencePlane: 'live', method: `${BG_PATH} and ${OPERATOR_PATH}` }).source,
    ).toBe('unresolved');
  });
});

describe('evidence rows and the ship-door verdict', () => {
  it('reads case-sensitive external identities and refuses incomplete declarations', () => {
    expect(evidenceRuntimeOf({ runtime: PORTAL_RUNTIME })).toBe(PORTAL_RUNTIME);
    const mixed = 'runtime-vintage:Workspace/Portal-Web@Host';
    expect(evidenceRuntimeOf({ evidenceRuntime: mixed })).toBe(mixed);
    expect(evidenceRuntimeOf({ runtime: 'portal-web' })).toBeNull();
    expect(evidenceRuntimeOf({ runtime: 'runtime-vintage:workspace/bg-host@' })).toBeNull();
  });
  it('reads the runtime from details by id or alias', () => {
    expect(evidenceRuntimeOf({ runtime: 'bg-host' })).toBe('bg-host');
    expect(evidenceRuntimeOf({ evidenceRuntime: ':3170' })).toBe('staging-operator');
    expect(evidenceRuntimeOf({ plane: 'live' })).toBeNull();
    expect(evidenceRecordsAbsent({ containsChange: false })).toBe(true);
    expect(evidenceRecordsAbsent({ containsChange: true })).toBe(false);
  });

  it('declared: met by matching evidence, unmet by none / another runtime / an absent recording', () => {
    const declared = resolveBarEvidenceRuntime({ evidencePlane: 'live', evidenceRuntime: 'bg-host' });
    expect(evidenceRuntimeUnmet({ resolution: declared, evidenceRuntimes: ['bg-host'], runtimeAbsent: [] })).toBe(false);
    expect(evidenceRuntimeUnmet({ resolution: declared, evidenceRuntimes: [], runtimeAbsent: [] })).toBe(true);
    expect(
      evidenceRuntimeUnmet({ resolution: declared, evidenceRuntimes: ['release-operator'], runtimeAbsent: [] }),
    ).toBe(true);
    expect(
      evidenceRuntimeUnmet({ resolution: declared, evidenceRuntimes: ['bg-host'], runtimeAbsent: ['bg-host'] }),
    ).toBe(true);
  });

  it('inferred and unresolved runtimes never block', () => {
    const inferred = resolveBarEvidenceRuntime({ evidencePlane: 'live', method: BG_PATH });
    expect(evidenceRuntimeUnmet({ resolution: inferred, evidenceRuntimes: [], runtimeAbsent: [] })).toBe(false);
    const unresolved = resolveBarEvidenceRuntime({ evidencePlane: 'live' });
    expect(evidenceRuntimeUnmet({ resolution: unresolved, evidenceRuntimes: [], runtimeAbsent: [] })).toBe(false);
  });

  it('requires the exact external identity and does not accept absent or operator evidence', () => {
    const resolution = resolveBarEvidenceRuntime({ evidencePlane: 'live', evidenceRuntime: PORTAL_RUNTIME });
    expect(evidenceRuntimeUnmet({ resolution, evidenceRuntimes: [PORTAL_RUNTIME], runtimeAbsent: [] })).toBe(false);
    for (const runtimes of [[], ['release-operator'], ['staging-operator'],
      ['runtime-vintage:other-workspace/portal-web@builder'],
      ['runtime-vintage:papercusp-workspace/other-unit@builder'],
      ['runtime-vintage:papercusp-workspace/portal-web@other-host'],
    ]) expect(evidenceRuntimeUnmet({ resolution, evidenceRuntimes: runtimes, runtimeAbsent: [] })).toBe(true);
    expect(evidenceRuntimeUnmet({ resolution, evidenceRuntimes: [PORTAL_RUNTIME], runtimeAbsent: [PORTAL_RUNTIME] })).toBe(true);
  });
});

function liveBar(overrides: Partial<AcceptanceBarTrace>): AcceptanceBarTrace {
  return {
    barKey: 'R-1',
    criterionKey: 'r-1',
    barHash: 'a'.repeat(64),
    model: 'The ingest drains every host ledger.',
    method: 'census',
    check: { kind: 'instrument', instrumentKey: 'none' } as never,
    replication: 'count rows',
    falsifier: 'rows stop arriving',
    role: 'outcome',
    mandatory: false,
    requiredScope: ['live'],
    evidencePlane: 'live',
    passRatings: ['healthy'],
    coversBarKeys: [],
    provenance: { lifecycle: 'pre-implementation', declaredAt: '2026-09-23T00:00:00.000Z', declaredBy: 'su-a' },
    mappings: [],
    workContracts: [],
    proof: {
      state: 'current',
      currentEvidence: 1,
      staleEvidence: 0,
      kinds: ['operational'],
      evidenceRefs: ['census'],
      uncertainEvidence: 0,
      evidencePlanes: ['live'],
      evidenceRuntimes: [],
      runtimeAbsent: [],
    },
    grading: {
      state: 'pass',
      scorecardId: 'SC-1',
      rubricRevision: 1,
      gradedBy: 'su-grader',
      selectedVia: null,
      rating: 'healthy',
      evidence: 'ok',
    },
    readiness: { state: 'ready', codes: [], mapping: 'live', method: 'declared', workContract: 'current' },
    ...overrides,
  };
}

function snapshotWith(bar: AcceptanceBarTrace): AcceptanceBarContractSnapshot {
  return {
    schemaVersion: 1,
    contentHash: 'c'.repeat(64),
    planSlug: 'plan-a',
    applicable: true,
    plan: {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      status: 'active',
      revision: 1,
      contentHash: 'plan-content',
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'acceptance-plan-a',
      rubricRevision: 1,
      seededAt: '2026-09-23T00:00:00.000Z',
      seededBy: 'su-a',
    },
    rubric: {
      rubricId: 'acceptance-plan-a',
      revision: 1,
      criteriaHash: 'criteria',
      barSetHash: 'b'.repeat(64),
      contract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        subjectPlanRevision: 1,
        seededAt: '2026-09-23T00:00:00.000Z',
        seededBy: 'su-a',
      },
      createdBy: 'su-a',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      classRef: null,
    },
    sourceRevisions: { subjectPlan: 1, rubricPlan: 1, clauses: [], workContracts: [], scorecardIds: [] },
    lineage: { identities: ['su-a'], parties: [], complete: true },
    grading: {
      authoritativeScorecardId: 'SC-1',
      gradedBy: 'su-grader',
      selectedVia: null,
      rubricRevision: 1,
      vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
      authorVerdict: { state: 'accepted', scorecardId: 'SC-2', verdict: 'accept' },
    },
    bars: [bar],
    completeness: { complete: true, truncated: false, problems: [] },
    readiness: { state: 'ready', codes: [], nextRepair: null },
  } as unknown as AcceptanceBarContractSnapshot;
}

describe('ship door (evaluateAcceptanceBarLifecycle)', () => {
  const codesFor = (bar: AcceptanceBarTrace) => evaluateAcceptanceBarLifecycle(snapshotWith(bar), 'ship').codes;

  it('blocks external live bars with operator or missing proof and accepts exact current proof', () => {
    const evidenceRuntime = resolveBarEvidenceRuntime({ evidencePlane: 'live', evidenceRuntime: PORTAL_RUNTIME });
    for (const evidenceRuntimes of [[], ['staging-operator'], ['release-operator']]) {
      expect(codesFor(liveBar({ evidenceRuntime, proof: { ...liveBar({}).proof, evidenceRuntimes } })))
        .toContain('bar_snapshot_evidence_runtime_unmet');
    }
    expect(codesFor(liveBar({ evidenceRuntime, proof: { ...liveBar({}).proof, evidenceRuntimes: [PORTAL_RUNTIME] } })))
      .not.toContain('bar_snapshot_evidence_runtime_unmet');
    expect(codesFor(liveBar({ evidenceRuntime, proof: { ...liveBar({}).proof, evidenceRuntimes: [PORTAL_RUNTIME], runtimeAbsent: [PORTAL_RUNTIME] } })))
      .toContain('bar_snapshot_evidence_runtime_unmet');
  });

  it('declared runtime with evidence measured there: no runtime code', () => {
    const bar = liveBar({
      evidenceRuntime: { runtime: 'bg-host', source: 'declared', reviewFlag: false, inferredFrom: [] },
      proof: { ...liveBar({}).proof, evidenceRuntimes: ['bg-host'] },
    });
    expect(codesFor(bar)).not.toContain('bar_snapshot_evidence_runtime_unmet');
  });

  it('declared runtime with evidence from a DIFFERENT runtime (e.g. :3070) is unmet', () => {
    const bar = liveBar({
      evidenceRuntime: { runtime: 'bg-host', source: 'declared', reviewFlag: false, inferredFrom: [] },
      proof: { ...liveBar({}).proof, evidenceRuntimes: ['release-operator'] },
    });
    expect(codesFor(bar)).toContain('bar_snapshot_evidence_runtime_unmet');
  });

  it('inferred runtime never raises the code (review flag, not a promise)', () => {
    const bar = liveBar({
      evidenceRuntime: { runtime: 'bg-host', source: 'inferred', reviewFlag: true, inferredFrom: [BG_PATH] },
    });
    expect(codesFor(bar)).not.toContain('bar_snapshot_evidence_runtime_unmet');
  });

  it('a legacy snapshot with no evidenceRuntime field is unaffected', () => {
    expect(codesFor(liveBar({}))).not.toContain('bar_snapshot_evidence_runtime_unmet');
  });
});
