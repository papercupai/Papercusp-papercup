/**
 * P-011 (verification-system-improvements-2026-10-10), AUTO-BAR-R-11-P-011: plans:bind-spec-evidence
 * refuses evidence for a bar that declares verification.productionConfiguration when the
 * evidence's declared-configuration fingerprint is missing or differs from that declaration,
 * and stamps a matching binding so currentness can tell it from an unchecked one.
 *
 * The check is exercised through its injected deps (clause, pinned BAR criterion, the run's
 * stored configuration_snapshot) with REAL snapshots from the reporter's own capture function,
 * so the fingerprint comparison under test is the production one, not a stub.
 */
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { FLAGS, FLAG_DEFAULTS, flagEnvVarName } from '@papercusp/flags';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';

import type { SpecClauseBarPin, SpecClauseRevision, listSpecClauses } from './spec-clauses-store';
import {
  declaredConfigurationBindCheck,
  type bindingSchema,
  type DeclaredConfigurationBindDeps,
} from './bind-spec-evidence';
import { declaredConfigurationFingerprint } from './declared-configuration';
import { computeAcceptanceBarHash, diffAcceptanceBarHashInputs } from '../../rubrics';

type Binding = z.infer<typeof bindingSchema>;

// Declared OPPOSITE to the compiled default, so only a run that set the override satisfies it.
const VIDEO = FLAGS.VIDEO_CHANNELS;
const VIDEO_REQUIRED = !FLAG_DEFAULTS[VIDEO];
const VIDEO_ENV = flagEnvVarName(VIDEO);
const DECLARED = { flags: { [VIDEO]: VIDEO_REQUIRED }, env: { PAPERCUSP_SEARCH_MODE: 'hybrid' } };
const SCOPE = { planSlug: 'config-plan', harnessSlug: 'papercusp' };

const PIN: SpecClauseBarPin = {
  barKey: 'R-11',
  barHash: 'a'.repeat(64),
  barSetHash: 'b'.repeat(64),
  rubricSlug: 'acceptance-config-plan',
  rubricRevision: 4,
  evidencePlane: 'tree',
};

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'config-plan',
    specId: 'AUTO-BAR-R-11-P-011',
    currentRevision: 4,
    revision: 4,
    planItemId: 'P-011',
    behavior: 'bind-spec-evidence refuses evidence whose declared-configuration fingerprint is missing or differs.',
    behaviorClass: 'happy-path',
    requiredEvidence: ['tree'],
    requiredTestLayers: ['unit'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:clause',
    createdBy: 'su-test',
    createdAt: '2026-10-11T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-10-11T00:01:00.000Z',
    acceptanceRef: 'acceptance-config-plan@4:R-11',
    sourceBar: PIN,
    ...over,
  } as SpecClauseRevision;
}

function binding(over: Partial<Binding> = {}): Binding {
  return {
    workItemId: 'WI-11',
    specId: 'AUTO-BAR-R-11-P-011',
    evidenceKind: 'test',
    evidenceRef: 'packages/operator-core/lib/agent-tools/plans/bind-spec-evidence-declared-configuration.test.ts',
    sourceFingerprint: 'git:abc',
    testRunId: 501,
    ...over,
  } as Binding;
}

const matchingSnapshot = () =>
  captureConfigurationSnapshot({ [VIDEO_ENV]: VIDEO_REQUIRED ? '1' : '0', PAPERCUSP_SEARCH_MODE: 'hybrid', NODE_ENV: 'test' });

function deps(over: {
  clause?: SpecClauseRevision | null;
  productionConfiguration?: unknown;
  snapshot?: unknown;
} = {}) {
  const loadClauses = vi.fn(async () => (over.clause === null ? [] : [over.clause ?? clause()])) as unknown as typeof listSpecClauses;
  const loadCriterion = vi.fn(async () => ({
    productionConfiguration: 'productionConfiguration' in over ? over.productionConfiguration : DECLARED,
  }));
  const readSnapshot = vi.fn(async () => ('snapshot' in over ? over.snapshot : matchingSnapshot()));
  const bundle: DeclaredConfigurationBindDeps = { loadClauses, loadCriterion, readSnapshot };
  return { bundle, loadClauses, loadCriterion, readSnapshot };
}

describe('AUTO-BAR-R-11-P-011: bind refuses evidence without a matching declared-configuration fingerprint', () => {
  it('refuses a binding that names no test run as fingerprint-missing, before reading any snapshot', async () => {
    const d = deps();
    const result = await declaredConfigurationBindCheck(binding({ testRunId: undefined }), SCOPE, d.bundle);
    expect(result).toMatchObject({
      kind: 'refused',
      refusal: {
        error: 'declared_configuration_fingerprint_missing',
        clause: 'AUTO-BAR-R-11-P-011@4',
        testRunId: null,
        fingerprint: null,
        declaredFingerprint: declaredConfigurationFingerprint(DECLARED),
      },
    });
    expect(result.kind === 'refused' && result.refusal.message).toMatch(/fromTestRun/);
    expect(d.readSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a run that recorded no configuration snapshot as fingerprint-missing', async () => {
    const d = deps({ snapshot: null });
    const result = await declaredConfigurationBindCheck(binding(), SCOPE, d.bundle);
    expect(result).toMatchObject({
      kind: 'refused',
      refusal: { error: 'declared_configuration_fingerprint_missing', testRunId: 501, fingerprint: null },
    });
    expect(d.readSnapshot).toHaveBeenCalledWith(501);
  });

  it('refuses a run whose snapshot is unreadable (hand-edited) as fingerprint-missing', async () => {
    const tampered = { ...matchingSnapshot(), flagEnv: { [VIDEO_ENV]: VIDEO_REQUIRED ? '0' : '1' } };
    const result = await declaredConfigurationBindCheck(binding(), SCOPE, deps({ snapshot: tampered }).bundle);
    expect(result).toMatchObject({ kind: 'refused', refusal: { error: 'declared_configuration_fingerprint_missing' } });
  });

  it('refuses a run under a different configuration as a mismatch naming the differing keys', async () => {
    const other = captureConfigurationSnapshot({ [VIDEO_ENV]: VIDEO_REQUIRED ? '0' : '1', PAPERCUSP_SEARCH_MODE: 'lexical' });
    const result = await declaredConfigurationBindCheck(binding(), SCOPE, deps({ snapshot: other }).bundle);
    expect(result).toMatchObject({
      kind: 'refused',
      refusal: {
        error: 'declared_configuration_fingerprint_mismatch',
        testRunId: 501,
        differing: [`env:PAPERCUSP_SEARCH_MODE`, `flag:${VIDEO}`].sort(),
      },
    });
    if (result.kind !== 'refused') return;
    expect(result.refusal.fingerprint).not.toBeNull();
    expect(result.refusal.fingerprint).not.toBe(result.refusal.declaredFingerprint);
  });

  it('accepts a run under the declared configuration and returns the stamp the binding stores', async () => {
    const d = deps();
    const result = await declaredConfigurationBindCheck(binding(), SCOPE, d.bundle);
    const declaredFingerprint = declaredConfigurationFingerprint(DECLARED);
    expect(result).toEqual({
      kind: 'matched',
      stamp: { required: true, testRunId: 501, declaredFingerprint, fingerprint: declaredFingerprint },
    });
    expect(d.loadCriterion).toHaveBeenCalledWith(PIN);
  });

  it('reads the clause at the bound revision, so a pinned proof is judged against its own bar', async () => {
    const d = deps();
    await declaredConfigurationBindCheck(binding({ specRevision: 3 }), SCOPE, d.bundle);
    expect(d.loadClauses).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'config-plan', specIds: ['AUTO-BAR-R-11-P-011'], revision: 3, limit: 1 }),
    );
  });
});

describe('AUTO-BAR-R-11-P-011: bars that declare nothing are untouched', () => {
  it('leaves a BAR with no productionConfiguration alone, even for a binding with no run', async () => {
    const d = deps({ productionConfiguration: undefined });
    expect(await declaredConfigurationBindCheck(binding({ testRunId: undefined }), SCOPE, d.bundle)).toEqual({
      kind: 'undeclared',
    });
    expect(d.readSnapshot).not.toHaveBeenCalled();
  });

  it('leaves a clause with no source BAR alone without loading any rubric', async () => {
    const d = deps({ clause: clause({ sourceBar: null }) });
    expect(await declaredConfigurationBindCheck(binding(), SCOPE, d.bundle)).toEqual({ kind: 'undeclared' });
    expect(d.loadCriterion).not.toHaveBeenCalled();
  });

  it('leaves an unknown spec and a spec-less binding to the store', async () => {
    expect(await declaredConfigurationBindCheck(binding(), SCOPE, deps({ clause: null }).bundle)).toEqual({
      kind: 'undeclared',
    });
    const d = deps();
    expect(await declaredConfigurationBindCheck(binding({ specId: undefined }), SCOPE, d.bundle)).toEqual({
      kind: 'undeclared',
    });
    expect(d.loadClauses).not.toHaveBeenCalled();
  });

  it('throws on a malformed stored declaration instead of treating it as none', async () => {
    await expect(
      declaredConfigurationBindCheck(binding(), SCOPE, deps({ productionConfiguration: { flags: { [VIDEO]: 'on' } } }).bundle),
    ).rejects.toThrow(/must be a boolean/);
  });
});

describe('AUTO-BAR-R-11-P-011: declaring a production configuration is part of the BAR hash', () => {
  const base = { key: 'R-11', model: 'Evidence must run under the declared configuration.', driftMarkers: 'accepted anyway' };

  it('keeps an undeclared BAR hash byte-for-byte', () => {
    expect(computeAcceptanceBarHash({ ...base, productionConfiguration: undefined })).toBe(computeAcceptanceBarHash(base));
  });

  it('re-hashes a BAR that declares a configuration, independent of key order, and names the field', () => {
    const declared = computeAcceptanceBarHash({ ...base, productionConfiguration: DECLARED });
    expect(declared).not.toBe(computeAcceptanceBarHash(base));
    expect(
      computeAcceptanceBarHash({
        ...base,
        productionConfiguration: { env: { PAPERCUSP_SEARCH_MODE: 'hybrid' }, flags: { [VIDEO]: VIDEO_REQUIRED } },
      }),
    ).toBe(declared);
    expect(diffAcceptanceBarHashInputs(base, { ...base, productionConfiguration: DECLARED })).toEqual([
      'productionConfiguration',
    ]);
  });
});
