import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  asCommittedRunOf,
  bindingSchema,
  bindingStageDiagnostics,
  measureBindingForStore,
  parseDerivedBinding,
} from './bind-spec-evidence';
import tool from './bind-spec-evidence';
import { EVIDENCE_MEASUREMENT_SCHEMA_VERSION, evidenceMeasurementSchema } from './spec-evidence-store';

describe('native compiler dependency binding input', () => {
  it('requires a repo-files measurement or a recorded test run', () => {
    const base = { slug: 'native-plan', dependencies: [{ name: 'target', file: 'src/target.ts', paths: ['src'] }],
      binding: { workItemId: 'WI-1', specId: 'SPEC-001', evidenceKind: 'test', evidenceRef: 'test.ts', sourceFingerprint: 'opaque' } };
    const invalid = tool.args.safeParse(base);
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues.some(issue => issue.path[0] === 'dependencies')).toBe(true);
    expect(tool.args.safeParse({ ...base, binding: { workItemId: 'WI-1', specId: 'SPEC-001', fromTestRun: 42 } }).success).toBe(true);
  });
});

describe('evidence-binding timeout diagnostics', () => {
  it('retains confirmed writes and identifies an advisory failure after storage', async () => {
    let clock = 0;
    const published: Array<ReturnType<ReturnType<typeof bindingStageDiagnostics>['snapshot']>> = [];
    const timing = bindingStageDiagnostics(
      (metadata) => {
        published.push(metadata.plansBindSpecEvidenceStageTimings as (typeof published)[number]);
      },
      () => clock,
    );
    await timing.phase('storeBinding', async () => {
      clock = 5;
    });
    timing.stored({ status: 'created', id: 123 });
    timing.stored({ status: 'unchanged', id: 123 });
    timing.stored({ status: 'not_found', id: 456 });
    const error = new Error('parent deadline');
    await expect(
      timing.phase('vettingAdvisory', async () => {
        clock = 55_005;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(timing.snapshot()).toEqual({
      schemaVersion: 'plans-bind-spec-evidence-stage-timings-v1',
      totalMs: 55_005,
      phaseMs: { storeBinding: 5, vettingAdvisory: 55_000 },
      active: {},
      storedBindingIds: [123],
    });
    expect(published.some((row) => row.active.vettingAdvisory === 1 && row.storedBindingIds[0] === 123)).toBe(true);
    // Earlier ledger snapshots cannot mutate when the handler advances.
    expect(published[0].active).toEqual({ storeBinding: 1 });
    expect(published[0].storedBindingIds).toEqual([]);
  });

  it('tracks concurrent work and preserves results when the metadata sink fails', async () => {
    const timing = bindingStageDiagnostics(() => {
      throw new Error('metadata unavailable');
    });
    let finish!: () => void;
    const first = timing.phase(
      'measureAndPin',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await timing.phase('measureAndPin', async () => {
      expect(timing.snapshot().active.measureAndPin).toBe(2);
    });
    expect(timing.snapshot().active.measureAndPin).toBe(1);
    finish();
    await first;
    timing.stored({ status: 'created', id: 789 });
    expect(timing.snapshot().active).toEqual({});
    expect(timing.snapshot().storedBindingIds).toEqual([789]);
  });
});

const measuredBinding = {
  workItemId: 'WI-1',
  specId: 'SPEC-001-01',
  evidenceKind: 'test' as const,
  evidenceRef: 'test/reconnect.test.ts',
  measurement: {
    schemaVersion: 1 as const,
    kind: 'repo-files' as const,
    sourcePaths: ['src/reconnect.ts'],
    testPaths: ['test/reconnect.test.ts'],
  },
};

describe('plans:bind-spec-evidence test-run identity schema', () => {
  const filePath = 'test/reconnect.test.ts';
  const withRunIdentity = (over: Record<string, unknown> = {}) => ({
    ...measuredBinding,
    testRunId: 42,
    details: { testRun: { id: 42, filePath }, ...over },
  });

  it('accepts a nested run identity only when its id and file agree with the binding', () => {
    expect(bindingSchema.safeParse(withRunIdentity()).success).toBe(true);

    const wrongId = bindingSchema.safeParse(withRunIdentity({ testRun: { id: 43, filePath } }));
    expect(wrongId.success).toBe(false);
    if (!wrongId.success) {
      expect(wrongId.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['details', 'testRun', 'id'] }),
      ]));
    }

    const wrongPath = bindingSchema.safeParse({ ...withRunIdentity(), evidenceRef: 'test/other.test.ts' });
    expect(wrongPath.success).toBe(false);
    if (!wrongPath.success) {
      expect(wrongPath.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['evidenceRef'], message: expect.stringContaining('same file') }),
      ]));
    }
  });
});

describe('plans:bind-spec-evidence instrument declaration schema', () => {
  it('publishes the instrument forms required for operational and manual evidence', () => {
    const published = z.toJSONSchema(tool.args as never);
    const propertySchemas = (value: unknown, property: string): unknown[] => {
      if (Array.isArray(value)) return value.flatMap((child) => propertySchemas(child, property));
      if (value === null || typeof value !== 'object') return [];
      const node = value as Record<string, unknown>;
      const properties = node.properties;
      const found =
        properties !== null &&
        typeof properties === 'object' &&
        Object.prototype.hasOwnProperty.call(properties, property)
          ? [(properties as Record<string, unknown>)[property]]
          : [];
      return [
        ...found,
        ...Object.entries(node)
          .filter(([key]) => key !== 'description')
          .flatMap(([, child]) => propertySchemas(child, property)),
      ];
    };
    const [instrumentSchema] = propertySchemas(published, 'instrument');
    expect(instrumentSchema).toBeDefined();
    for (const field of ['path', 'testPath', 'none', 'reason']) {
      expect(propertySchemas(instrumentSchema, field)).not.toHaveLength(0);
    }

    const base = {
      harness: 'papercusp',
      binding: {
        workItemId: 'WI-1',
        specId: 'SPEC-001-01',
        evidenceKind: 'operational',
        evidenceRef: 'docs/evidence/measurement.json',
        sourceFingerprint: 'opaque-evidence-fingerprint',
      },
    };
    expect(
      tool.args.safeParse({
        ...base,
        binding: {
          ...base.binding,
          details: { instrument: { path: 'scripts/measure.mjs', testPath: 'scripts/measure.test.ts' } },
        },
      }).success,
    ).toBe(true);
    expect(
      tool.args.safeParse({
        ...base,
        binding: { ...base.binding, details: { instrument: { none: true, reason: 'The result was read directly from the operator UI.' } } },
      }).success,
    ).toBe(true);
  });
});

describe('plans:bind-spec-evidence repo-files measurement contract', () => {
  it.each(['test', 'mutation', 'counterexample'] as const)(
    'preflights first-bind fixture calibration for recorded %s evidence in single and bulk calls',
    (evidenceKind) => {
      const binding = {
        workItemId: 'WI-1', specId: 'SPEC-001-01', fromTestRun: 42, evidenceKind,
        details: { adequacy: { fixtureCalibrated: true } },
      };
      for (const request of [{ binding }, { items: [binding] }]) {
        expect(tool.args.safeParse(request).success).toBe(false);
      }
      for (const recipe of [
        { fixturePaths: ['test/reconnect.test.ts'] },
        { fixtureGlobs: ['test/fixtures/*.ts'] },
      ]) {
        for (const request of [{ binding: { ...binding, ...recipe } }, { items: [{ ...binding, ...recipe }] }]) {
          expect(tool.args.safeParse(request).success).toBe(true);
        }
      }
    },
  );

  it('accepts a workspace-registered sibling harness slug without accepting an arbitrary root path', () => {
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        measurement: { ...measuredBinding.measurement, rootHarnessSlug: 'portal' },
      }).success,
    ).toBe(true);
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        measurement: { ...measuredBinding.measurement, rootPath: '/tmp/unregistered' },
      }).success,
    ).toBe(false);
  });

  it('accepts omitted or explicit-null opaque fingerprint dimensions', () => {
    expect(bindingSchema.safeParse(measuredBinding).success).toBe(true);
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      }).success,
    ).toBe(true);
  });

  it('accepts fixture measurement paths and requires them for repository-measured fixture calibration', () => {
    const fixtureBinding = {
      ...measuredBinding,
      evidenceKind: 'fixture' as const,
      details: { adequacy: { fixtureCalibrated: true } },
    };
    expect(bindingSchema.safeParse({
      ...fixtureBinding,
      measurement: { ...measuredBinding.measurement, fixturePaths: ['src/server-envelope.ts'] },
    }).success).toBe(true);
    expect(bindingSchema.safeParse({
      ...fixtureBinding,
      measurement: { ...measuredBinding.measurement, fixtureGlobs: ['libs/db/sql/*.sql'], fixtureRootHarnessSlug: 'fixtures' },
    }).success).toBe(true);

    const missingFixturePaths = bindingSchema.safeParse(fixtureBinding);
    expect(missingFixturePaths.success).toBe(false);
    if (missingFixturePaths.success) return;
    expect(missingFixturePaths.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['measurement', 'fixturePaths'],
          message: expect.stringContaining('requires repo-files measurement.fixturePaths'),
        }),
      ]),
    );
  });

  it.each(['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'] as const)(
    'rejects an unmeasurable non-null %s instead of persisting an unreachable freshness tuple',
    (field) => {
      const parsed = bindingSchema.safeParse({ ...measuredBinding, [field]: `${field}:opaque` });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [field],
            message: expect.stringContaining(`cannot independently refresh ${field}`),
          }),
        ]),
      );
    },
  );
});

// plan-verification-friction-reduction-2026-10-11 P-005 (R-5): a caller that omits
// measurement.schemaVersion is stored at the current version; an unsupported one still refuses.
describe('plans:bind-spec-evidence measurement schemaVersion tolerance (P-005)', () => {
  const { schemaVersion: _omitted, ...measurementWithoutVersion } = measuredBinding.measurement;

  it('stores a measurement binding that omits schemaVersion at the current schema version', () => {
    const parsed = tool.args.safeParse({
      slug: 'friction-plan',
      binding: { ...measuredBinding, measurement: measurementWithoutVersion },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The handler persists exactly this parsed object as details.currentMeasurement.
    const stored = (parsed.data as { binding: { measurement: Record<string, unknown> } }).binding.measurement;
    expect(stored.schemaVersion).toBe(EVIDENCE_MEASUREMENT_SCHEMA_VERSION);
    expect(stored).toEqual({ ...measurementWithoutVersion, schemaVersion: EVIDENCE_MEASUREMENT_SCHEMA_VERSION });
    // The read side re-measures from that stored recipe, so it must parse back unchanged.
    expect(evidenceMeasurementSchema.parse(stored)).toEqual(stored);
    // The same default applies to the work-items measurement kind.
    const workItems = evidenceMeasurementSchema.parse({ kind: 'work-items', workItemIds: ['WI-1'] });
    expect(workItems.schemaVersion).toBe(EVIDENCE_MEASUREMENT_SCHEMA_VERSION);
  });

  it('refuses a measurement with an unsupported schemaVersion', () => {
    const parsed = tool.args.safeParse({
      slug: 'friction-plan',
      binding: { ...measuredBinding, measurement: { ...measurementWithoutVersion, schemaVersion: 2 } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // binding is a union (measured vs fromTestRun), so the refusal is nested in a branch.
    type Issue = { path: PropertyKey[]; errors?: Issue[][] };
    const flatten = (issues: Issue[], prefix: PropertyKey[] = []): PropertyKey[][] =>
      issues.flatMap((issue) => [
        [...prefix, ...issue.path],
        ...(issue.errors ?? []).flatMap((branch) => flatten(branch, [...prefix, ...issue.path])),
      ]);
    expect(flatten(parsed.error.issues as Issue[]).map((path) => path.join('.')))
      .toContain('binding.measurement.schemaVersion');
    expect(evidenceMeasurementSchema.safeParse({ kind: 'work-items', workItemIds: ['WI-1'], schemaVersion: 0 }).success)
      .toBe(false);
  });
});

describe('plans:bind-spec-evidence adequacy completeness metadata', () => {
  const flatAdequacyFields: ReadonlyArray<readonly [string, unknown]> = [
    ['fixtureCalibrated', true],
    ['fixtureFree', true],
    ['falsifiable', true],
    ['testCases', ['suite > case']],
    ['pathReachable', true],
    ['oracleIndependent', true],
    ['collected', true],
    ['skipped', false],
    ['executed', true],
    ['outcome', 'passed'],
    ['targeted', true],
    ['coverageRungs', { l3: true }],
    ['scenarioIds', ['stale-vs-decision']],
    ['causalPairIds', ['missing-goal-history']],
    ['provisionalProofBase', true],
  ];

  it.each(flatAdequacyFields)(
    'rejects flat adequacy field %s with the correct details.adequacy path',
    (field, value) => {
      const parsed = bindingSchema.safeParse({
        ...measuredBinding,
        details: { [field]: value },
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['details', field],
            message: expect.stringContaining(`details.adequacy.${field}`),
          }),
        ]),
      );
    },
  );

  it.each(flatAdequacyFields)(
    'rejects flat adequacy field %s even when details.adequacy is present',
    (field, value) => {
      const parsed = bindingSchema.safeParse({
        ...measuredBinding,
        details: { adequacy: { executed: true }, [field]: value },
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['details', field],
            message: expect.stringContaining(`details.adequacy.${field}`),
          }),
        ]),
      );
    },
  );

  it('continues to accept unrelated free-form details without an adequacy container', () => {
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        details: { observations: { source: 'independent-run' } },
      }).success,
    ).toBe(true);
  });

  it('documents required evidence planes and live environment currentness on the binding schema', () => {
    expect(bindingSchema.shape.details.description).toContain('details.evidencePlane');
    expect(bindingSchema.shape.details.description).toContain('environmentFingerprint');
    expect(bindingSchema.shape.environmentFingerprint.description).toContain('runtime/environment');
  });

  it('accepts stable scenario and causal-pair ids on executable proof', () => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: {
        adequacy: {
          coverageRungs: { l3: true, l4: false },
          scenarioIds: ['stale-vs-decision', 'wrong-subject-exclusion'],
          causalPairIds: ['missing-goal-history'],
          executed: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires adequacy.testCases to be a list of nonblank case titles', () => {
    expect(bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { testCases: ['suite > selected case'] } },
    }).success).toBe(true);

    for (const value of ['selected case', [42], ['   ']]) {
      expect(bindingSchema.safeParse({
        ...measuredBinding,
        details: { adequacy: { testCases: value } },
      }).success).toBe(false);
    }
  });

  it.each([
    ['calibrated', true],
    ['caseTitles', ['suite > selected case']],
    ['assertion', 'a hand-written assertion'],
    ['falsifier', 'a hand-written falsifier'],
  ] as const)('rejects non-canonical nested adequacy key %s instead of persisting inert metadata', (field, value) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { [field]: value } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['details', 'adequacy'],
          message: expect.stringContaining(field),
        }),
      ]),
    );
  });

  it('accepts an uppercase platform-generated clause ID as targeted adequacy metadata', () => {
    const specId = 'AUTO-BAR-R-5-P-004';
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      specId,
      evidenceKind: 'mutation',
      details: { adequacy: { targeted: specId } },
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    'fixtureCalibrated',
    'fixtureFree',
    'falsifiable',
    'pathReachable',
    'oracleIndependent',
    'collected',
    'skipped',
    'executed',
    'provisionalProofBase',
  ])('rejects numeric nested adequacy metadata for %s', (field) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { [field]: 13 } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['details', 'adequacy', field],
          message: expect.stringMatching(/boolean/i),
        }),
      ]),
    );
  });

  it.each([
    { value: ['l3'], message: 'expected object' },
    { value: { l3: 'true' }, message: 'expected boolean' },
    { value: { l5: true }, message: 'unrecognized key' },
  ])('rejects malformed coverageRungs metadata ($message)', ({ value, message }) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { coverageRungs: value } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^details\.adequacy\.coverageRungs(?:\.|$)/)]),
    );
    expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toMatch(new RegExp(message, 'i'));
  });

  it.each([
    { field: 'scenarioIds', value: ['valid-id', 'valid-id'], message: 'unique' },
    { field: 'scenarioIds', value: ['Not Stable'], message: 'Invalid' },
    { field: 'scenarioIds', value: ['su-S01-harness-scope'], message: 'Invalid' },
    { field: 'causalPairIds', value: [], message: 'too small' },
  ])('rejects malformed or duplicate $field metadata', ({ field, value, message }) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { [field]: value } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^details\\.adequacy\\.${field}(?:\\.|$)`))]),
    );
    expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toMatch(new RegExp(message, 'i'));
  });

  it('accepts scenario-to-case proof only when it names declared scenarios and exact test cases', () => {
    const valid = bindingSchema.safeParse({
      ...measuredBinding,
      details: {
        adequacy: {
          scenarioIds: ['correlated-tool-error'],
          testCases: ['dispatch failure emits the correlated exception'],
          scenarioTestCases: {
            'correlated-tool-error': ['dispatch failure emits the correlated exception'],
          },
        },
      },
    });
    expect(valid.success).toBe(true);

    const unboundCase = bindingSchema.safeParse({
      ...measuredBinding,
      details: {
        adequacy: {
          scenarioIds: ['correlated-tool-error'],
          testCases: ['exporter maps error spans'],
          scenarioTestCases: { 'correlated-tool-error': ['unlisted dispatch case'] },
        },
      },
    });
    expect(unboundCase.success).toBe(false);
  });

  it('rejects causal-pair ids on non-executable fixture evidence', () => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      evidenceKind: 'fixture',
      details: { adequacy: { causalPairIds: ['missing-goal-history'] } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['details', 'adequacy', 'causalPairIds'],
          message: expect.stringContaining('require executable'),
        }),
      ]),
    );
  });
});

describe('plans:bind-spec-evidence authenticated actor provenance', () => {
  const publicBinding = (evidenceRef: string) => ({
    workItemId: 'WI-1',
    specId: 'SPEC-001-01',
    evidenceKind: 'test' as const,
    evidenceRef,
    sourceFingerprint: 'git:abc123',
  });

  it('accepts a valid two-row public payload without a caller-supplied actorId', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      items: [publicBinding('test/reconnect-a.test.ts'), publicBinding('test/reconnect-b.test.ts')],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects actorId at the public boundary because the handler derives it from identity', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      items: [publicBinding('test/reconnect-a.test.ts'), publicBinding('test/reconnect-b.test.ts')],
      actorId: 'caller-controlled-actor',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keys: ['actorId'],
          message: expect.stringContaining('Unrecognized key'),
        }),
      ]),
    );
  });

  it('rejects actorId nested in a binding, keeping the internal store field private', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      binding: { ...publicBinding('test/reconnect.test.ts'), actorId: 'caller-controlled-actor' },
    });
    expect(parsed.success).toBe(false);
  });
});

// proof-freshness-pinned-candidate-2026-10-06 P-003 / D-001 (b): a binding derived from a clean
// run in a disposable clone is measured at the commit that ran, never at the live checkout.
describe('as-committed bindings are measured at the run commit', () => {
  const repoFiles = { schemaVersion: 1 as const, kind: 'repo-files' as const, sourcePaths: ['src/a.ts'] };
  const fakes = () => {
    const calls: string[] = [];
    const result = { sourceFingerprint: 's', testFingerprint: null, pin: null };
    return {
      calls,
      deps: {
        atCommit: (async (_w: string, _h: string, _m: unknown, at: { commitSha: string }) => {
          calls.push(`atCommit:${at.commitSha}`);
          return result;
        }) as never,
        live: (async () => {
          calls.push('live');
          return result;
        }) as never,
      },
    };
  };

  it('reads the commit stamped by bind-from-test-run, and nothing from an ordinary binding', () => {
    // The exact shape expandTestRunBinding writes (bind-from-test-run.test.ts pins that side).
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 'abc123', repoPrefix: 'libs/sub', measuredAtCommit: true } } }))
      .toEqual({ commitSha: 'abc123', repoPrefix: 'libs/sub' });
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 'abc123', repoPrefix: '' } } }))
      .toEqual({ commitSha: 'abc123', repoPrefix: '' });
    expect(asCommittedRunOf({ testRun: { commitSha: 'abc123', worktreeDirty: false } })).toBeUndefined();
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 42 } } })).toBeUndefined();
    expect(asCommittedRunOf(undefined)).toBeUndefined();
  });

  it('routes a repo-files binding with a run commit to the at-commit measurer, and every other binding to the live one', async () => {
    const f = fakes();
    await measureBindingForStore('w', 'h', repoFiles, { commitSha: 'abc123', repoPrefix: null }, f.deps);
    await measureBindingForStore('w', 'h', repoFiles, undefined, f.deps);
    await measureBindingForStore(
      'w',
      'h',
      { schemaVersion: 1, kind: 'work-items', workItemIds: ['WI-1'] } as never,
      { commitSha: 'abc123', repoPrefix: null },
      f.deps,
    );
    expect(f.calls).toEqual(['atCommit:abc123', 'live', 'live']);
  });
});

// verification-system-improvements-2026-10-10 P-001: the verification-system map names
// derived_binding_invalid, so a test must trigger it.
describe('parseDerivedBinding', () => {
  it.each([undefined, 'integration'])('normalizes a flat layer into the derived binding stored by the handler (nested=%s)', (nested) => {
    const result = parseDerivedBinding({
      ...measuredBinding,
      details: { testLayer: 'integration', observations: 'preserved', adequacy: { executed: true, ...(nested ? { testLayer: nested } : {}) } },
    }, 42);
    expect(result).toMatchObject({ ok: true, binding: { details: { observations: 'preserved', adequacy: { executed: true, testLayer: 'integration' } } } });
    if (!result.ok) throw new Error('expected normalized binding');
    expect(result.binding.details).not.toHaveProperty('testLayer');
  });

  it('refuses contradictory flat and nested layers without weakening the nested layer', () => {
    const result = parseDerivedBinding({ ...measuredBinding, details: { testLayer: 'unit', adequacy: { testLayer: 'integration' } } }, 42);
    expect(result).toMatchObject({ ok: false, error: 'derived_binding_invalid' });
    const parsed = bindingSchema.safeParse({ ...measuredBinding, details: { testLayer: 'unit', adequacy: { testLayer: 'integration' } } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['details', 'testLayer'], message: expect.stringContaining('conflicts') })]));
  });

  it('continues refusing invalid flat layer types and unrelated flat adequacy attestations', () => {
    expect(bindingSchema.safeParse({ ...measuredBinding, details: { testLayer: 3 } }).success).toBe(false);
    expect(bindingSchema.safeParse({ ...measuredBinding, details: { testLayer: 'integration', executed: true } }).success).toBe(false);
  });

  it('CALIBRATION: a binding the schema accepts passes through unchanged', () => {
    const result = parseDerivedBinding(measuredBinding, 42);
    expect(result).toEqual({ ok: true, binding: bindingSchema.parse(measuredBinding) });
  });

  it('a derived binding the schema rejects is refused as derived_binding_invalid, naming the run', () => {
    const result = parseDerivedBinding({ ...measuredBinding, evidenceKind: 'not-a-kind' }, 42);
    expect(result).toMatchObject({ ok: false, error: 'derived_binding_invalid', testRunId: 42 });
    expect(result.ok ? '' : result.message).toContain('evidenceKind');
  });
});
