import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import proposeTool, { rubricsProposeArgs } from './propose';
import { normalizeRequirementSections } from '../../requirement-contract';
import { rubricTemplateDataSchema } from '../plans/rubric-template';

const mocks = vi.hoisted(() => ({
  proposeRubric: vi.fn(),
  validateRubricReplicationSql: vi.fn(),
  getWorkItemsByIds: vi.fn(),
  // P-005: the handler reads the stored revision to grandfather carried instrument keys.
  getRubric: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  getWorkItemsByIds: mocks.getWorkItemsByIds,
}));
vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return { ...actual, proposeRubric: mocks.proposeRubric, getRubric: mocks.getRubric };
});
vi.mock('../../rubrics-replication-sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics-replication-sql')>();
  return { ...actual, validateRubricReplicationSql: mocks.validateRubricReplicationSql };
});
vi.mock('../../detached-imports', () => ({
  trackDetached: () => Promise.resolve({ notifySyncInvalidate: vi.fn() }),
}));

const base = {
  rubricRef: 'release-readiness',
  characteristic: 'release-health',
  title: 'Release health',
  criteria: [
    {
      key: 'tests',
      title: 'Required tests pass',
      model: 'The required tests pass.',
      method: 'Run the focused test suite and inspect its result.',
      driftMarkers: 'Any required test fails or cannot be run.',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateRubricReplicationSql.mockResolvedValue({ ok: true });
});

const lightAcceptanceCriterion = {
  key: 'tests',
  title: 'Required tests pass for the shipped behavior',
  driftMarkers: 'A required test fails or the shipped behavior is absent.',
  check: { kind: 'instrument', instrumentKey: 'none' },
};

describe('rubrics:propose args — standard-only watchdog fields', () => {
  it('keeps the complete tool schema JSON-Schema-representable', () => {
    expect(() => z.toJSONSchema(proposeTool.args as never)).not.toThrow();
  });

  it('scopes gradingAuthority descriptions to acceptance grading, separate from standard scorecards', () => {
    const descriptionOf = (schema: unknown): string => {
      const jsonSchema = z.toJSONSchema(schema as never) as {
        properties?: { gradingAuthority?: { description?: string } };
      };
      return jsonSchema.properties?.gradingAuthority?.description ?? '';
    };
    const descriptions = [descriptionOf(rubricsProposeArgs), descriptionOf(rubricTemplateDataSchema)];

    expect(descriptions).toHaveLength(2);
    for (const description of descriptions) {
      expect(description).toContain('acceptance-kind plan/goal rubrics');
      expect(description).toContain('standard-kind terminal scorecards');
      expect(description).toContain('P-013');
      expect(description).toContain('goal-rubric stewardship');
    }
  });

  it('documents the conditional acceptance ratingScale normalization without requiring caller input', () => {
    const schema = z.toJSONSchema(rubricsProposeArgs as never) as {
      properties?: {
        ratingScale?: { description?: string };
      };
      required?: string[];
    };
    const description = schema.properties?.ratingScale?.description ?? '';

    expect(schema.required ?? []).not.toContain('ratingScale');
    expect(description).toMatch(/acceptance rubrics/i);
    expect(description).toMatch(/omitted/i);
    expect(description).toMatch(/unknown-equivalent/i);
    expect(description).toMatch(/appends "unknown"/i);

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [lightAcceptanceCriterion],
      }).success,
    ).toBe(true);
  });

  it('accepts unified sections at the real proposal door and refuses conflicting duplicates', () => {
    const unified = {
      key: 'export',
      title: 'Export',
      barKey: 'R-1',
      intent: { request: 'Export all rows.' },
      acceptance: {
        condition: 'All filtered rows exported.',
        falsifier: 'A row is missing.',
        requiredTestLayers: ['e2e'],
      },
      verification: { method: 'Compare a full fixture export.', check: { kind: 'instrument', instrumentKey: 'none' } },
    };
    const args = { ...base, kind: 'acceptance', subjectPlan: 'export', criteria: [unified] };
    const parsed = rubricsProposeArgs.parse(args);
    expect(normalizeRequirementSections(parsed.criteria[0]!)).toMatchObject({
      model: 'All filtered rows exported.',
      method: 'Compare a full fixture export.',
      requiredTestLayers: ['e2e'],
    });
    expect(
      rubricsProposeArgs.safeParse({ ...args, criteria: [{ ...unified, model: 'First page only.' }] }).success,
    ).toBe(false);
  });
  it('rejects rubric refs that the canonical plan lock cannot store', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      rubricRef: 'acceptance:mcp-proxy-reconnect-herd-2026-08-25',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['rubricRef'],
            message: expect.stringContaining('valid plan slug'),
          }),
        ]),
      );
    }
  });

  it('rejects releaseGating for acceptance-kind rubrics at dispatch validation', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [lightAcceptanceCriterion],
      releaseGating: true,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['releaseGating'],
            message: expect.stringContaining('standard-kind only'),
          }),
        ]),
      );
    }
  });

  it('accepts releaseGating for a standard-kind rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'standard',
      releaseGating: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts stalenessWatched for a standard-kind rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'standard',
      stalenessWatched: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects stalenessWatched for acceptance-kind rubrics at dispatch validation', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [lightAcceptanceCriterion],
      stalenessWatched: true,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['stalenessWatched'],
            message: expect.stringContaining('standard-kind only'),
          }),
        ]),
      );
    }
  });

  it('forwards stalenessWatched through the handler to the rubric writer', async () => {
    mocks.proposeRubric.mockResolvedValue({
      ...base,
      rubricId: 'release-readiness',
      kind: 'standard',
      description: '',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      methodRef: null,
      stalenessWatched: true,
      status: 'proposed',
      createdBy: null,
      proposedBy: 'me',
      ratifiedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await proposeTool.handler({ ...base, kind: 'standard', stalenessWatched: true }, {} as never);

    expect(mocks.proposeRubric).toHaveBeenCalledWith(
      expect.objectContaining({
        stalenessWatched: true,
      }),
    );
  });

  it('P-005: refuses a NEW unregistered instrument binding before anything is written', async () => {
    const result = await proposeTool.handler(
      {
        ...base,
        kind: 'standard',
        criteria: [{ ...base.criteria[0], check: { kind: 'instrument', instrumentKey: 'parked-agent-census' } }],
      } as never,
      {} as never,
    );
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

    expect(parsed).toMatchObject({
      ok: false,
      code: 'unregistered_instrument',
      refused: [{ criterion: 'tests', instrumentKey: 'parked-agent-census', priorInstrumentKey: null }],
    });
    expect(parsed.registeredKeys).toContain('host:psi-cpu-some-avg10-pct');
    expect(mocks.getRubric).toHaveBeenCalledWith('release-readiness');
    expect(mocks.proposeRubric).not.toHaveBeenCalled();
  });

  it('P-005: grandfathers a legacy key carried unchanged from the stored revision and reports it', async () => {
    const legacy = { ...base.criteria[0], instrumentKey: 'pot-throughput-ticks' };
    mocks.getRubric.mockResolvedValueOnce({ criteria: [legacy] });
    mocks.proposeRubric.mockResolvedValue({
      ...base,
      rubricId: 'release-readiness',
      kind: 'standard',
      criteria: [legacy],
      description: '',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      methodRef: null,
      status: 'proposed',
      createdBy: null,
      proposedBy: 'me',
      ratifiedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await proposeTool.handler({ ...base, kind: 'standard', criteria: [legacy] } as never, {} as never);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

    expect(parsed.ok).toBe(true);
    expect(parsed.grandfatheredInstruments).toEqual([{ criterion: 'tests', instrumentKey: 'pot-throughput-ticks' }]);
    expect(mocks.proposeRubric).toHaveBeenCalledTimes(1);
  });

  it('surfaces mismatched terminal implementation coverage at the real proposal handler', async () => {
    const method = 'Missing detector branches remain unknown. Their implementation dependency is WI-6554700010014915, assigned to the leader.';
    const item = { ...lightAcceptanceCriterion, key: 'r-6', barKey: 'R-6', method };
    mocks.getWorkItemsByIds.mockResolvedValue([{
      id: 'WI-6554700010014915', state: 'done',
      terminalCompletionEvidence: { coverage: { checked: ['R1 scope detector', 'R9 deployment detector'] } },
    }]);
    mocks.proposeRubric.mockResolvedValue({
      ...base, rubricId: 'release-readiness', kind: 'acceptance', subjectPlan: 'release-plan',
      subjectHarnessSlug: 'papercusp', criteria: [item],
    });
    const response = await proposeTool.handler({ ...base, kind: 'acceptance', subjectPlan: 'release-plan', criteria: [item] } as never, {} as never);
    const result = JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text);
    expect(result.ok).toBe(true);
    expect(result.methodLint).toEqual([expect.objectContaining({
      code: 'acceptance-method-dependency-coverage', criterionKey: 'r-6', dependencyId: 'WI-6554700010014915',
    })]);
    expect(mocks.getWorkItemsByIds).toHaveBeenCalledWith(['WI-6554700010014915'], 'papercusp', {
      includeBody: false, payloadProjection: 'completionEvidence',
    });
  });

  it('returns a non-blocking methodLint advisory for native-shell acceptance methods', async () => {
    const method = 'Run npm run test:file -- packages/operator-core/lib/example.test.ts.';
    mocks.proposeRubric.mockResolvedValue({
      ...base,
      rubricId: 'release-readiness',
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, method }],
      description: '',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      methodRef: null,
      status: 'active',
      createdBy: null,
      proposedBy: 'me',
      ratifiedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await proposeTool.handler(
      {
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [{ ...lightAcceptanceCriterion, method }],
      } as never,
      {} as never,
    );
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

    expect(parsed.methodLint).toEqual([
      expect.objectContaining({
        code: 'acceptance-method-native-shell',
        criterionKey: 'tests',
        markers: ['npm-run'],
      }),
    ]);
  });

  it('accepts an explicitly non-gating acceptance rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [lightAcceptanceCriterion],
      releaseGating: false,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a goal-linked acceptance rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectGoal: 'goal-123',
      criteria: [lightAcceptanceCriterion],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts methodRef:null emitted by rubrics:get for an unset runbook', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      methodRef: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.methodRef).toBeNull();
  });

  it('accepts unpinned standard-rubric composition refs and rejects revision-shaped refs', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      composes: [' goal-mode-e2e ', 'pot-coordination-health'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.composes).toEqual(['goal-mode-e2e', 'pot-coordination-health']);

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        composes: [{ rubricRef: 'goal-mode-e2e', revision: 37 }],
      }).success,
    ).toBe(false);
    expect(rubricsProposeArgs.safeParse({ ...base, composes: [] }).success).toBe(false);
  });

  it('accepts the light acceptance profile only with a falsifier and structured check', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [lightAcceptanceCriterion],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.criteria[0]?.model).toBeUndefined();
      expect(parsed.data.criteria[0]?.method).toBeUndefined();
      expect(parsed.data.criteria[0]?.driftMarkers).toBeTruthy();
      expect(parsed.data.criteria[0]?.check).toEqual({ kind: 'instrument', instrumentKey: 'none' });
    }
  });

  it('publishes a criterion schema that requires a direct falsifier or acceptance.falsifier alias', () => {
    const schema = z.toJSONSchema(rubricsProposeArgs as never) as {
      properties?: {
        criteria?: {
          items?: {
            anyOf?: Array<{ required?: string[] }>;
          };
        };
      };
    };
    const branches = schema.properties?.criteria?.items?.anyOf ?? [];

    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['driftMarkers']) }),
        expect.objectContaining({ required: expect.arrayContaining(['acceptance']) }),
      ]),
    );
  });

  it('rejects a criterion that omits both direct and unified falsifiers', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [
        {
          key: 'tests',
          title: 'Required tests pass for the shipped behavior',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts canonical BAR metadata and keeps model as the single semantic text', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [
        {
          ...lightAcceptanceCriterion,
          bar: 'The shipped behavior exists for every post-epoch plan.',
          barKey: 'R-1',
          role: 'outcome',
          mandatory: true,
          requiredScope: ['cohort:post-epoch'],
          evidencePlane: 'tree',
          passRatings: ['pass'],
          barProvenance: {
            lifecycle: 'pre-implementation',
            declaredAt: '2026-09-04T12:00:00.000Z',
            declaredBy: 'su-author',
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.criteria[0]).toMatchObject({
        bar: 'The shipped behavior exists for every post-epoch plan.',
        barKey: 'R-1',
        role: 'outcome',
        mandatory: true,
        evidencePlane: 'tree',
      });
    }

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [{ ...lightAcceptanceCriterion, evidencePlane: 'production-ish' }],
      }).success,
    ).toBe(false);

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [
          {
            ...lightAcceptanceCriterion,
            model: 'Canonical outcome.',
            bar: 'A different outcome.',
            role: 'outcome',
            mandatory: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        criteria: [{ ...base.criteria[0], barKey: 'R-1', role: 'outcome' }],
      }).success,
    ).toBe(false);
  });

  it('allows an explicitly empty passRatings array for disclosure criteria and teaches outcome callers', () => {
    const disclosure = {
      ...lightAcceptanceCriterion,
      bar: 'Report on the outcome BAR.',
      barKey: 'R-2',
      role: 'disclosure' as const,
      mandatory: false,
      requiredScope: ['tree'],
      evidencePlane: 'tree' as const,
      passRatings: [],
      coversBarKeys: ['R-1'],
    };
    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [disclosure],
      }).success,
    ).toBe(true);

    const invalid = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...disclosure, role: 'outcome', mandatory: true }],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining("role:'disclosure'"),
          }),
        ]),
      );
    }

    const invalidDisclosure = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...disclosure, passRatings: ['healthy'] }],
    });
    expect(invalidDisclosure.success).toBe(false);
    if (!invalidDisclosure.success) {
      expect(invalidDisclosure.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining('must be empty'),
          }),
        ]),
      );
    }
  });

  it('rejects acceptance criteria that omit the meta-rubric falsifier or structured-check floor', () => {
    const missingFalsifier = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, driftMarkers: undefined }],
    });
    expect(missingFalsifier.success).toBe(false);
    if (!missingFalsifier.success) {
      expect(missingFalsifier.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_union',
            path: ['criteria', 0],
          }),
        ]),
      );
    }

    const missingCheck = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, check: undefined }],
    });
    expect(missingCheck.success).toBe(false);
    if (!missingCheck.success) {
      expect(missingCheck.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria'],
            message: expect.stringContaining('require at least one structured check'),
          }),
        ]),
      );
    }
  });

  it('documents the acknowledgement needed when a revision removes a stored structured check', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      allowMethodShrink: true,
      shrinkReason: 'the deterministic check is intentionally retired with its test suite',
    });

    expect(parsed.success).toBe(true);
    // "structured" is optional here ONLY because the description is byte-budgeted and was
    // trimmed to "a stored check"; guidance.when below still pins the full phrase, so the
    // acknowledgement requirement stays asserted rather than loosened away.
    expect(proposeTool.description).toMatch(/removing a stored (?:structured )?check/i);
    expect(proposeTool.description).toMatch(/allowMethodShrink \+ shrinkReason/);
    expect(proposeTool.description).toMatch(/acceptance criteria may omit model\/method/i);
    expect(proposeTool.description).toMatch(/non-empty driftMarkers falsifier/i);
    expect(proposeTool.description).toMatch(/(?:at least one|≥ ?1) structured check/i);
    // The bare phrase moved out of guidance.when into the allowMethodShrink zod .describe()
    // (cc95f91dfb). That text is NOT safely assertable — rubricsProposeArgs carries
    // .superRefine, which strips .shape, so an args.shape.*.description match would pass
    // VACUOUSLY (EI-22428147744123216). Assert the LINKAGE on the description instead, which
    // is this test's stated intent and a stronger guard than the two loose matches it replaces.
    expect(proposeTool.description).toMatch(
      /removing a stored (?:structured )?check[\s\S]*?requires allowMethodShrink \+ shrinkReason/i,
    );
    expect(proposeTool.guidance?.when).toMatch(/acceptance criteria are a light profile/i);
    expect(proposeTool.guidance?.when).toMatch(/traceability to the plan goal\/Decisions/i);
    // chaining no longer carries check semantics (cc95f91dfb rewrote it as pure tool
    // sequencing). Pin what it actually guards now — the independent-ratify chain (D-001) —
    // rather than a phrase that moved, so this stays a real assertion instead of a dead one.
    expect(proposeTool.guidance?.chaining).toMatch(/independent rubrics:ratify/i);
  });
});
