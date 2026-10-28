import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encode } from '@papercusp/result-encoding';

const catalog = vi.hoisted(() => [] as Array<Record<string, any>>);
const cells = vi.hoisted(() => new Map<string, Record<string, any>>());

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => catalog,
  projectedToolRegistryRevision: (tools: Array<Record<string, any>>) =>
    // Keep the synthetic revision bounded independently of the tool name so the
    // long-name regression exercises `tool` rather than the revision field's cap.
    `rev:${tools.map((entry) => entry.expose.mcp.name).join(',').length}:${JSON.stringify(tools.map((entry) => entry.inputSchema)).length}`,
}));

vi.mock('./cell-registry', () => ({
  getCellUnchecked: (cell: string) => cells.get(cell),
}));

import {
  CONTINUITY_PROBE_MAX_PER_WAKE,
  CONTINUITY_PROBE_RESULT_MAX_BYTES,
  CONTINUITY_PROBE_TIMEOUT_MS,
  collectContinuityProbeSources,
  continuityProbeRevision,
  continuityProbeSchema,
  continuityProbeShapeSchema,
  continuityPredicateSchema,
  continuityPredicateShapeMessage,
  decodeContinuityProbe,
  encodeContinuityProbe,
  runContinuityProbeBatch,
  validateContinuityProbe,
  type ContinuityProbe,
  type ContinuityProbeSource,
} from './continuity-probes';
import { renderCarryNote } from './carry-note';
import { LIMITS, RUBRIC_PROBE_MAX_PER_EMIT } from './agent-tools/limits';
import { CRITERION_PROBE_TIMEOUT_MS, evaluateCriterionProbeChecks, normalizeCriterionProbeChecks, validateCriterionCheckPaths } from './rubrics-criterion-checks';
import { rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';

const LONG_READ_TOOL = `test:${'x'.repeat(167 - 'test:'.length)}`;

describe('criterion ALL probes', () => {
  const check = (all: unknown[]) => ({ kind: 'probe' as const, all });
  const evaluate = (all: unknown[], dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>, rating = 'pass') =>
    evaluateCriterionProbeChecks({ criteria: [{ key: 'proof', check: check(all) }], ratings: { proof: { rating } }, dispatchTool });

  it('keeps the single-probe shape and rejects empty, ambiguous and oversized groups', () => {
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe: readProbe() }).success).toBe(true);
    for (const value of [check([]), { ...check([readProbe()]), probe: readProbe() }, { kind: 'probe' }, check(Array(9).fill(readProbe()))]) {
      expect(rubricCriterionCheckSchema.safeParse(value).success).toBe(false);
    }
  });

  it('preserves every child and requires both populated evidence and zero failures', async () => {
    const rows = readProbe({ expect: { path: '$.count', op: 'eq', value: 3 } });
    const verdict = readProbe({ expect: { path: '$.failed', op: 'eq', value: 0 } });
    const success = await evaluate([rows, verdict], async () => ({ count: 3, failed: 0 }));
    expect(success).toMatchObject({ ok: true, checkRuns: { proof: { kind: 'probe', verdict: 'pass', all: [
      { probe: rows, observed: 3, verdict: 'pass', executed: true },
      { probe: verdict, observed: 0, verdict: 'pass', executed: true },
    ] } } });
    // Zero failures over missing runs must never become a vacuous green.
    const absent = await evaluate([rows, verdict], async () => ({ count: 0, failed: 0 }));
    expect(absent).toMatchObject({ ok: false, error: 'probe_contradicted', run: { all: [{ verdict: 'fail' }, { verdict: 'pass' }] } });
    const honest = await evaluate([rows, verdict], async () => ({ count: 0, failed: 0 }), 'fail');
    expect(honest).toMatchObject({ ok: true, checkRuns: { proof: { verdict: 'fail', all: [{ observed: 0 }, { observed: 0 }] } } });
  });

  it('validates every child before dispatch, including a schema-stale or write target', async () => {
    const dispatch = vi.fn(async () => ({ state: 'green' }));
    for (const invalid of [readProbe({ schemaRevision: 'old' }), readProbe({ tool: 'status:write' }), { ...readProbe(), args: { wrong: true } }]) {
      expect(await evaluate([readProbe(), invalid], dispatch)).toMatchObject({ ok: false, error: 'probe_invalid' });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('pins each writer live sentinel before persistence and preserves legacy single probes', () => {
    const legacy = { key: 'single', check: { kind: 'probe' as const, probe: readProbe({ schemaRevision: 'live' }) } };
    expect(normalizeCriterionProbeChecks([legacy])[0]).toBe(legacy);
    const all = normalizeCriterionProbeChecks([{ key: 'set', check: check([readProbe({ schemaRevision: 'live' }), readProbe()]) }])[0];
    expect(all.check.all).toEqual([readProbe(), readProbe()]);
    expect(validateCriterionCheckPaths([{ key: 'set', check: check([readProbe({ schemaRevision: 'old' })]) }]).ok).toBe(false);
  });

  it('preserves grouped probe metadata while pinning every child', () => {
    const grouped = normalizeCriterionProbeChecks([{
      key: 'latency',
      check: {
        kind: 'probe' as const,
        all: [readProbe({ schemaRevision: 'live' })],
        unit: 'ms',
        ratingBands: [{ rating: 'near', expect: { op: 'lte' as const, value: 250 } }],
      },
    }])[0];

    expect(grouped.check).toMatchObject({
      kind: 'probe',
      unit: 'ms',
      ratingBands: [{ rating: 'near', expect: { op: 'lte', value: 250 } }],
      all: [readProbe()],
    });
  });

  it('refuses an unjudgeable child without borrowing its sibling result', async () => {
    const next = readProbe({ args: { id: 'unreadable' } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await evaluate([readProbe(), next], async (_name, args) => {
        if (args.id === 'unreadable') throw new Error('ledger unavailable');
        return { state: 'green' };
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('ledger unavailable'));
      expect(result).toMatchObject({ ok: false, error: 'probe_run_failed' });
    } finally { warning.mockRestore(); }
  });

  it('rejects the shared batch cap across criteria at write time and before execution', async () => {
    // Each group stays within its own 8-child limit; together they exceed the per-emit cap, which
    // is derived here so the case keeps exceeding it when the cap moves.
    const groups = Math.floor(RUBRIC_PROBE_MAX_PER_EMIT / 8) + 1;
    const criteria = Array.from({ length: groups }, (_, i) => ({ key: `g${i}`, check: check(Array(8).fill(readProbe())) }));
    expect(groups * 8).toBeGreaterThan(RUBRIC_PROBE_MAX_PER_EMIT);
    expect(validateCriterionCheckPaths(criteria).ok).toBe(false);
    const dispatch = vi.fn(async () => ({ state: 'green' }));
    const ratings = Object.fromEntries(criteria.map((c) => [c.key, { rating: 'pass' }]));
    expect(await evaluateCriterionProbeChecks({ criteria, ratings, dispatchTool: dispatch })).toMatchObject({ ok: false, error: 'probe_invalid' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects single and ALL rubric probes that independent judges cannot read', () => {
    const target = catalog.find(tool => tool.expose.mcp.name === 'status:read')!;
    target.agentRoles = ['su'];
    const probe = readProbe();
    // Continuity probes outside rubric grading retain their ordinary read-only contract.
    expect(continuityProbeSchema.safeParse(probe).success).toBe(true);
    for (const binding of [{ kind: 'probe' as const, probe }, check([probe])]) {
      expect(validateCriterionCheckPaths([{ key: 'proof', check: binding }])).toMatchObject({
        ok: false,
        scopeFailures: [{ criterionKey: 'proof', reason: expect.stringContaining('independent judge role') }],
      });
    }
    target.agentRoles = ['su', 'judge'];
    for (const binding of [{ kind: 'probe' as const, probe }, check([probe])]) {
      expect(validateCriterionCheckPaths([{ key: 'proof', check: binding }]).ok).toBe(true);
    }
  });

  it('validates schema currentness for single rubric probes before persistence', () => {
    expect(validateCriterionCheckPaths([{ key: 'proof', check: {
      kind: 'probe', probe: readProbe({ schemaRevision: 'old' }),
    } }]).ok).toBe(false);
  });

  it.each([{ event: 'rubric:criterion-regressed:example' }, { meter: true }])(
    'rejects judge-denied events:status arguments at authoring for single and ALL checks: %j',
    (args) => {
      const target = projected('events:status', 'read', {
        event: { type: 'string' }, meter: { type: 'boolean' }, await_id: { type: 'number' },
      });
      catalog.push({ ...target, agentRoles: ['su', 'judge'] });
      const probe = readProbe({ tool: 'events:status', args, schemaRevision: continuityProbeRevision('events:status')! });
      // A generic continuity probe remains valid for its SU author. The rubric
      // must additionally prove the SAME arguments are admitted to its grader.
      expect(continuityProbeSchema.safeParse(probe).success).toBe(true);
      for (const binding of [{ kind: 'probe' as const, probe }, check([readProbe(), probe])]) {
        expect(validateCriterionCheckPaths([{ key: 'proof', check: binding }])).toMatchObject({
          ok: false,
          scopeFailures: [{ criterionKey: 'proof', reason: expect.stringContaining('evidence-only judge') }],
        });
      }
    },
  );

  it.each([{}, { await_id: 11 }, { meter: false }])(
    'keeps caller-scoped events:status probes authorable and executable: %j',
    async (args) => {
      catalog.push({
        ...projected('events:status', 'read', {
          event: { type: 'string' }, meter: { type: 'boolean' }, await_id: { type: 'number' },
        }),
        agentRoles: ['su', 'judge'],
      });
      const probe = readProbe({ tool: 'events:status', args, schemaRevision: continuityProbeRevision('events:status')! });
      for (const binding of [{ kind: 'probe' as const, probe }, check([probe])]) {
        expect(validateCriterionCheckPaths([{ key: 'proof', check: binding }]).ok).toBe(true);
        const dispatch = vi.fn(async () => ({ state: 'green' }));
        expect(await evaluateCriterionProbeChecks({
          criteria: [{ key: 'proof', check: binding }], ratings: { proof: { rating: 'pass' } }, dispatchTool: dispatch,
        })).toMatchObject({ ok: true, checkRuns: { proof: { verdict: 'pass' } } });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith('events:status', args, expect.any(AbortSignal));
      }
    },
  );
});

function projected(name: string, effect: 'read' | 'write' = 'read', properties: Record<string, unknown> = {}) {
  return {
    expose: { mcp: { name } },
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
    },
    capabilities: [],
    effect,
  };
}

function readProbe(overrides: Partial<ContinuityProbe> = {}): ContinuityProbe {
  return {
    kind: 'tool',
    tool: 'status:read',
    args: { id: 'x' },
    schemaRevision: continuityProbeRevision('status:read')!,
    expect: { path: '$.state', op: 'eq', value: 'green' },
    ...overrides,
  } as ContinuityProbe;
}

function source(probe: ContinuityProbe, i = 0, recheck = 'read status'): ContinuityProbeSource {
  return {
    source: { kind: 'work-item', id: `WI-${i + 1}`, harness: 'papercusp' },
    checkIndex: i,
    check: { id: `check-${i}`, claim: `claim ${i}`, recheck, probe },
  };
}

describe('original rubric measurement execution', () => {
  it('retains surrounding population diagnostics and the frozen descriptor before live source changes', async () => {
    const payload = { state: 'green', sample_count: 7, password: 'tiny' };
    const probe = readProbe();
    const batch = await runContinuityProbeBatch([source(probe)], {
      retainMeasurement: true, now: () => Date.parse('2026-10-23T00:00:00Z'),
      dispatchTool: async () => ({ data: payload }),
    });
    payload.sample_count = 999;
    expect(batch.results[0]?.observed).toBe('green');
    expect(batch.results[0]?.provenance?.diagnostics).toContainEqual({ path: '$["sample_count"]', value: 7 });
    expect(batch.results[0]?.provenance?.procedure.snapshot).toContain('status:read');
    expect(JSON.stringify(batch)).not.toContain('tiny');
  });

  it('captures the SQL transaction clock in the original query without coercing native scalar types', async () => {
    const clock = '__papercusp_measurement_transaction_at_v1';
    let executedSql = '';
    const probe = { kind: 'sql' as const, sql: 'SELECT 9007199254740993::bigint AS n;', maxRows: 5,
      schemaRevision: continuityProbeRevision('dev:pg_query')!,
      expect: { path: '$.rows[0].n', op: 'eq' as const, value: '9007199254740993' } };
    const batch = await runContinuityProbeBatch([source(probe)], {
      retainMeasurement: true, now: () => Date.parse('2026-10-23T00:00:01Z'),
      dispatchTool: async (_name, args) => {
        executedSql = String(args.sql);
        return { data: { rowCount: 1, fields: ['n', clock], rows: [{ n: '9007199254740993', [clock]: '2026-10-23T00:00:00Z' }] } };
      },
    });
    expect(executedSql).toContain('transaction_timestamp()');
    expect(batch.results[0]).toMatchObject({ status: 'fresh', observed: '9007199254740993',
      provenance: { transactionAt: '2026-10-23T00:00:00.000Z' } });
    expect(batch.results[0]?.provenance?.procedure.snapshot).toContain('9007199254740993::bigint');
    expect(batch.results[0]?.provenance?.diagnostics.some(d => d.path.includes(clock))).toBe(false);
  });
});

beforeEach(() => {
  catalog.splice(
    0,
    catalog.length,
    projected('status:read', 'read', { id: { type: 'string' } }),
    projected('state:read', 'read', { cell: { type: 'string' }, as: { type: 'string' } }),
    projected('status:write', 'write', { id: { type: 'string' } }),
    projected(LONG_READ_TOOL, 'read', { value: { type: 'string' } }),
    projected('dev:pg_query', 'read', { sql: { type: 'string' }, maxRows: { type: 'number' },
      timeoutMs: { type: 'number' }, allowUnscoped: { type: 'boolean' }, allowUnboundedJsonSearch: { type: 'boolean' } }),
    projected('tools:invoke', 'read', { name: { type: 'string' } }),
  );
  cells.clear();
  cells.set('gate.verdict', { changeSignal: { kind: 'poll', tool: 'status:read', path: 'state' } });
});

describe('continuity probe persistence contract', () => {
  it('round-trips a typed probe through bounded base64url encoding', () => {
    const probe = readProbe();
    const encoded = encodeContinuityProbe(probe);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeContinuityProbe(encoded)).toEqual(probe);
    expect(decodeContinuityProbe('not+base64')).toBeNull();
  });

  it('accepts current read-only tool/state probes and refuses mutation, SQL, meta calls, and secrets', () => {
    expect(validateContinuityProbe(readProbe())).toEqual([]);
    const stateProbe: ContinuityProbe = {
      kind: 'state-cell',
      cell: 'gate.verdict',
      schemaRevision: continuityProbeRevision('state:read')!,
      expect: { path: '$.value', op: 'exists' },
    };
    expect(validateContinuityProbe(stateProbe)).toEqual([]);

    expect(
      validateContinuityProbe(
        readProbe({ tool: 'status:write', schemaRevision: continuityProbeRevision('status:write')! }),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'not_read_only' })]));
    expect(
      validateContinuityProbe(
        readProbe({
          tool: 'dev:pg_query',
          args: { sql: 'select 1' },
          schemaRevision: continuityProbeRevision('dev:pg_query')!,
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'indirect_tool' })]));
    expect(
      validateContinuityProbe(
        readProbe({
          tool: 'tools:invoke',
          args: { name: 'status:read' },
          schemaRevision: continuityProbeRevision('tools:invoke')!,
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'indirect_tool' })]));
    expect(
      validateContinuityProbe(readProbe({ args: { id: 'x', authorization: 'Bearer sk-abcdefghijklmnop' } })),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'secret_material' })]));
    expect(
      validateContinuityProbe(readProbe({ expect: { path: '$.state', op: 'eq', value: 'sk-abcdefghijklmnop' } })),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'secret_material' })]));
  });

  it('documents the conditional predicate and direct-tool restrictions in the generated schema', () => {
    const schema = JSON.stringify(z.toJSONSchema(continuityProbeSchema as never));
    expect(schema).toContain('MUST omit `value`');
    expect(schema).toContain('comparison operations require a scalar `value`');
    expect(schema).toContain('indirect/meta surfaces such as `dev:pg_query`');
    expect(() =>
      continuityPredicateSchema.parse({ path: '$.state', op: 'exists', value: 'green' }),
    ).toThrow(/exists.*does not take a value/);
  });

  it('reports live contract violations at the nested probe field', () => {
    expect(() => continuityProbeSchema.parse({ ...readProbe(), schemaRevision: 'old' })).toThrow(/schemaRevision/);
    expect(() => continuityProbeSchema.parse({ ...readProbe(), projection: { pipe: [{ op: 'head' }] } })).toThrow(
      /projection/,
    );
  });

  it('accepts a 167-character read-only tool name under the shared identifier cap', () => {
    const probe = readProbe({
      tool: LONG_READ_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(LONG_READ_TOOL)!,
      expect: { path: '$.value', op: 'eq', value: 'green' },
    });
    expect(LONG_READ_TOOL).toHaveLength(167);
    expect(LIMITS.IDENT).toBeGreaterThanOrEqual(167);
    expect(() => continuityProbeSchema.parse(probe)).not.toThrow();
  });

  it('names the `live` sentinel escape hatch in a caller-hardcoded schema-revision mismatch (EI-21886701316980990)', () => {
    // A caller who hardcodes a stale registry-revision literal instead of the
    // writer-only `live` shorthand used to see only two opaque revision
    // strings with no path forward — multiple agents independently re-filed
    // this exact confusion. The mismatch diagnostic must name the fix inline.
    const issues = validateContinuityProbe({ ...readProbe(), schemaRevision: 'work-items-get-v1' });
    const mismatch = issues.find((issue) => issue.code === 'schema_revision_mismatch');
    expect(mismatch?.message).toMatch(/schemaRevision:"live"/);
    expect(mismatch?.message).toContain('work-items-get-v1');
  });

  it('resolves the writer-only live revision sentinel while keeping shape/replay strict', async () => {
    const parsed = continuityProbeSchema.parse({ ...readProbe(), schemaRevision: 'live' });
    expect(parsed.schemaRevision).toBe(continuityProbeRevision('status:read'));
    expect(continuityProbeShapeSchema.parse({ ...readProbe(), schemaRevision: 'live' }).schemaRevision).toBe('live');

    const stateProbe: ContinuityProbe = {
      kind: 'state-cell',
      cell: 'gate.verdict',
      schemaRevision: 'live',
      expect: { path: '$.value', op: 'exists' },
    };
    expect(continuityProbeSchema.parse(stateProbe).schemaRevision).toBe(continuityProbeRevision('state:read'));

    const dispatchTool = vi.fn();
    const replay = await runContinuityProbeBatch([source(readProbe({ schemaRevision: 'live' }))], { dispatchTool });
    expect(replay.results[0]).toMatchObject({
      status: 'unknown',
      executed: false,
      diagnostic: { code: 'schema_revision_mismatch', storedRevision: 'live' },
    });
    expect(dispatchTool).not.toHaveBeenCalled();
  });
});

describe('continuity probe wake replay', () => {
  it('collects loop checks before held work-item checks from the existing stores', async () => {
    const loopProbe = readProbe({ args: { id: 'loop' } });
    const itemProbe = readProbe({ args: { id: 'item' } });
    const loopNote = renderCarryNote({ checks: [{ claim: 'loop claim', probe: loopProbe }] });
    const itemNote = renderCarryNote({ checks: [{ claim: 'item claim', probe: itemProbe }] });
    const sources = await collectContinuityProbeSources('su-me', 'workspace', {
      getLoopStatus: async () => ({ active: true, harnessSlug: 'papercusp' }),
      getLoopCarryNoteWithMeta: async () => ({ note: loopNote, updatedAtMs: 1 }),
      readHeldWorkItems: async () => [{ id: 'WI-1', harness: 'papercusp', checkpoint: itemNote }],
    });
    expect(sources.map((entry) => entry.source)).toEqual([
      { kind: 'loop', ownerId: 'su-me' },
      { kind: 'work-item', id: 'WI-1', harness: 'papercusp' },
    ]);
    expect(sources.map((entry) => entry.check.probe)).toEqual([loopProbe, itemProbe]);
  });

  it('distinguishes fresh/stale, contains errors, and preserves source order', async () => {
    const dispatchTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.id === 'error') return { isError: true, content: [{ type: 'text', text: 'failed' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ state: args.id === 'fresh' ? 'green' : 'red' }) }] };
    });
    const probes = ['fresh', 'stale', 'error'].map((id, i) => source(readProbe({ args: { id } }), i));
    const batch = await runContinuityProbeBatch(probes, { dispatchTool });
    expect(batch.results.map((result) => result.status)).toEqual(['fresh', 'stale', 'error']);
    // The tool's own error text rides on the diagnostic, so an unjudgeable probe says why.
    expect(batch.results[2]?.diagnostic).toMatchObject({ code: 'tool_error', message: expect.stringMatching(/returned an error: failed$/) });
    expect(batch.results.map((result) => result.source)).toEqual(probes.map((row) => row.source));
    expect(batch.executed).toBe(3);
  });

  it('carries a conditional stored re-check beside a probe failure', async () => {
    const recheck = 'On an unblock or deployed-SHA transition, read state:read for the pipeline position.';
    const batch = await runContinuityProbeBatch([source(readProbe(), 0, recheck)], {
      dispatchTool: async () => ({ isError: true, content: [{ type: 'text', text: 'cell unavailable' }] }),
    });
    expect(batch.results[0]).toMatchObject({
      status: 'error',
      executed: true,
      recheck,
      diagnostic: { code: 'tool_error' },
    });
  });

  it('fails closed on revision/argument drift without dispatching', async () => {
    const dispatchTool = vi.fn();
    const drifted = readProbe({ schemaRevision: 'stale-revision', args: { renamed_id: 'x' } });
    const batch = await runContinuityProbeBatch([source(drifted)], { dispatchTool });
    expect(batch.results[0]).toMatchObject({
      status: 'unknown',
      executed: false,
      diagnostic: { code: 'schema_revision_mismatch', storedRevision: 'stale-revision' },
    });
    expect(batch.results[0].diagnostic?.candidates).toContain('id');
    expect(dispatchTool).not.toHaveBeenCalled();

    const invalidArgs = readProbe({ args: { renamed_id: 'x' } });
    const invalidBatch = await runContinuityProbeBatch([source(invalidArgs)], { dispatchTool });
    expect(invalidBatch.results[0]).toMatchObject({
      status: 'unknown',
      executed: false,
      diagnostic: { code: 'invalid_args' },
    });
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('routes registered state-cell probes through state:read', async () => {
    const probe: ContinuityProbe = {
      kind: 'state-cell',
      cell: 'gate.verdict',
      schemaRevision: continuityProbeRevision('state:read')!,
      expect: { path: '$.value', op: 'eq', value: 'green' },
    };
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"value":"green"}' }] }));
    const batch = await runContinuityProbeBatch([source(probe)], { dispatchTool });
    expect(batch.results[0]).toMatchObject({ status: 'fresh', executed: true });
    expect(dispatchTool).toHaveBeenCalledWith('state:read', { cell: 'gate.verdict' }, expect.any(AbortSignal));
  });

  it('caps a mixed batch while preserving the selected prefix', async () => {
    const rows = Array.from({ length: CONTINUITY_PROBE_MAX_PER_WAKE + 3 }, (_, i) => source(readProbe(), i));
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"state":"green"}' }] }));
    const batch = await runContinuityProbeBatch(rows, { dispatchTool });
    expect(batch.results).toHaveLength(CONTINUITY_PROBE_MAX_PER_WAKE);
    expect(batch.results.map((result) => result.checkIndex)).toEqual(
      Array.from({ length: CONTINUITY_PROBE_MAX_PER_WAKE }, (_, i) => i),
    );
    expect(batch.truncated).toBe(3);
  });

  it('contains an oversized decoded result without blocking the remaining probe', async () => {
    const huge = source(readProbe({ args: { id: 'huge' }, expect: { path: '$.blob', op: 'exists' } }), 0);
    const normal = source(readProbe({ args: { id: 'fresh' } }), 1);
    const dispatchTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [
        {
          type: 'text',
          text:
            args.id === 'huge'
              ? JSON.stringify({ blob: 'x'.repeat(CONTINUITY_PROBE_RESULT_MAX_BYTES + 1) })
              : '{"state":"green"}',
        },
      ],
    }));
    const batch = await runContinuityProbeBatch([huge, normal], { dispatchTool });
    expect(batch.results.map((result) => result.status)).toEqual(['error', 'fresh']);
    expect(batch.results[0].diagnostic?.code).toBe('result_too_large');
  });

  // WI-10004343: the in-process dispatcher returns the JSON payload item PLUS
  // separate advisory text items (a tool's guidance.seeAlso "See also: …"). The
  // decoder used to JSON-parse only a SINGLE text item and otherwise hand the
  // predicate a string[], so every path read undefined — a true value read
  // `stale`, and a scorecard criterion rated healthy was refused
  // probe_contradicted. Measured live on rubrics:get during acceptance grading.
  it('judges the JSON payload item when the result also carries advisory text items', async () => {
    const payload = { results: [{ rubric: { status: 'active', revision: 30 } }] };
    const dispatchTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: JSON.stringify(payload) },
        { type: 'text', text: 'See also: rubrics:propose (author a rubric); scorecards:emit (grade one)' },
      ],
    }));
    const fresh = await runContinuityProbeBatch(
      [source(readProbe({ expect: { path: '$.results[0].rubric.status', op: 'eq', value: 'active' } }))],
      { dispatchTool },
    );
    expect(fresh.results[0]).toMatchObject({ status: 'fresh', executed: true, observed: 'active' });

    // Falsifier: the same multi-item shape must still read STALE when the value differs,
    // so the fix cannot pass by treating an unparsed body as a match.
    const stale = await runContinuityProbeBatch(
      [source(readProbe({ expect: { path: '$.results[0].rubric.status', op: 'eq', value: 'retired' } }))],
      { dispatchTool },
    );
    expect(stale.results[0]).toMatchObject({ status: 'stale', executed: true, observed: 'active' });
  });

  it('decodes lossless TOON payloads for both boolean outcomes with advisory items', async () => {
    const dispatchTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [
        {
          type: 'text',
          text: `format: toon\n${encode({ found: args.id === 'true' }, 'toon')}`,
        },
        { type: 'text', text: 'See also: status:read (inspect the source result)' },
      ],
    }));

    const batch = await runContinuityProbeBatch([
      source(readProbe({ args: { id: 'true' }, expect: { path: '$.found', op: 'eq', value: true } }), 0),
      source(readProbe({ args: { id: 'false' }, expect: { path: '$.found', op: 'eq', value: false } }), 1),
    ], { dispatchTool });

    expect(batch.results).toMatchObject([
      { status: 'fresh', executed: true, observed: true },
      { status: 'fresh', executed: true, observed: false },
    ]);
  });

  it('does not treat malformed TOON as a judgeable payload', async () => {
    const dispatchTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: 'format: toon\n{not valid' },
        { type: 'text', text: 'See also: status:read (inspect the source result)' },
      ],
    }));

    const batch = await runContinuityProbeBatch(
      [source(readProbe({ expect: { path: '$.found', op: 'eq', value: true } }))],
      { dispatchTool },
    );

    expect(batch.results[0]).toMatchObject({ status: 'stale', executed: true });
    expect(batch.results[0].observed).toBeUndefined();
  });

  it('measures the result budget against the JSON payload, not payload + advisory prose', async () => {
    // Payload comfortably under budget; the advisory items alone must not push it over.
    const payload = { ok: false, error: 'evidenceRef missing', filler: 'y'.repeat(CONTINUITY_PROBE_RESULT_MAX_BYTES - 200) };
    const dispatchTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: JSON.stringify(payload) },
        { type: 'text', text: `See also: ${'z'.repeat(500)}` },
      ],
    }));
    const batch = await runContinuityProbeBatch(
      [source(readProbe({ expect: { path: '$.ok', op: 'eq', value: false } }))],
      { dispatchTool },
    );
    expect(batch.results[0]).toMatchObject({ status: 'fresh', executed: true, observed: false });
  });

  // WI-10005537: a rubric probe on dev:pipeline_position with no projection
  // (expect $.servingRuntimes[0].containsChange) was refused result_too_large
  // because the WHOLE body (~20KB+) was charged against the budget, though the
  // predicate reads one boolean. scorecards:emit fails closed on that refusal,
  // so no independent acceptance card could be filed for the plan.
  it('judges a small selected value inside a body larger than the result budget', async () => {
    const body = (containsChange: boolean) => ({
      servingRuntimes: [{ runtime: 'release-operator', method: 'blob', containsChange }],
      stages: Array.from({ length: 40 }, (_, i) => ({ stage: `s${i}`, detail: 'd'.repeat(600) })),
    });
    expect(JSON.stringify(body(true)).length).toBeGreaterThan(CONTINUITY_PROBE_RESULT_MAX_BYTES);
    const probe = readProbe({ expect: { path: '$.servingRuntimes[0].containsChange', op: 'eq', value: true } });
    const run = async (containsChange: boolean) =>
      runContinuityProbeBatch([source(probe)], {
        dispatchTool: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(body(containsChange)) }] })),
      });

    expect((await run(true)).results[0]).toMatchObject({ status: 'fresh', executed: true, observed: true });
    // Falsifier: the same oversized shape must still read STALE when the value differs,
    // so the fix cannot pass by treating any large body as a match.
    expect((await run(false)).results[0]).toMatchObject({ status: 'stale', executed: true, observed: false });
  });
});

// EI-24809550207915153: the batch hard-coded the 2.5s wake budget for every caller, so a
// scorecard criterion probe on dev:pipeline_position (measured p50 ~3s, p95 ~28s) was
// refused unjudgeable on most emits and no independent acceptance card could be filed.
describe('continuity probe dispatch budget', () => {
  const SLOW_READ_MS = 3_000;
  const slowDispatch = (delayMs = SLOW_READ_MS) =>
    vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: [{ type: 'text', text: '{"state":"green"}' }] }), delayMs),
        ),
    );

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the wake budget by default and names it when a read overruns', async () => {
    expect(SLOW_READ_MS).toBeGreaterThan(CONTINUITY_PROBE_TIMEOUT_MS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = runContinuityProbeBatch([source(readProbe())], { dispatchTool: slowDispatch() });
    await vi.advanceTimersByTimeAsync(SLOW_READ_MS);
    const batch = await pending;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${CONTINUITY_PROBE_TIMEOUT_MS}ms`));
    warn.mockRestore();
    expect(batch.limits.timeoutMs).toBe(CONTINUITY_PROBE_TIMEOUT_MS);
    expect(batch.results[0]).toMatchObject({ status: 'error', executed: true, diagnostic: { code: 'timeout' } });
    expect(batch.results[0].diagnostic?.message).toContain(`${CONTINUITY_PROBE_TIMEOUT_MS}ms budget`);
  });

  it('aborts timed-out state-cell reads and scopes the timeout to cell + subject presence', async () => {
    const probe: ContinuityProbe = {
      kind: 'state-cell',
      cell: 'gate.verdict',
      as: 'private-subject',
      schemaRevision: continuityProbeRevision('state:read')!,
      expect: { path: '$.value', op: 'eq', value: 'green' },
    };
    let receivedSignal: AbortSignal | undefined;
    let resolveLate!: (value: unknown) => void;
    const dispatchTool = vi.fn(
      (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<unknown>((resolve) => { resolveLate = resolve; });
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const pending = runContinuityProbeBatch([source(probe)], { dispatchTool, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      const batch = await pending;

      expect(receivedSignal?.aborted).toBe(true);
      expect(dispatchTool).toHaveBeenCalledWith(
        'state:read',
        { cell: 'gate.verdict', as: 'private-subject' },
        expect.any(AbortSignal),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('continuity-probe:state:read:gate.verdict:subject=true'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('private-subject'));
      expect(batch.results[0]).toMatchObject({ status: 'error', diagnostic: { code: 'timeout' } });

      resolveLate({ content: [{ type: 'text', text: '{"value":"green"}' }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(batch.results[0]).toMatchObject({ status: 'error', diagnostic: { code: 'timeout' } });
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the cancellation signal live for a probe that finishes within budget', async () => {
    let receivedSignal: AbortSignal | undefined;
    const dispatchTool = vi.fn(
      async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        receivedSignal = signal;
        return { content: [{ type: 'text', text: '{"state":"green"}' }] };
      },
    );

    const batch = await runContinuityProbeBatch([source(readProbe())], { dispatchTool, timeoutMs: 100 });

    expect(batch.results[0]).toMatchObject({ status: 'fresh', executed: true });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it('honours a caller budget, so the same slow read is judged instead of refused', async () => {
    const pending = runContinuityProbeBatch([source(readProbe())], {
      dispatchTool: slowDispatch(),
      timeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(SLOW_READ_MS);
    const batch = await pending;
    expect(batch.limits.timeoutMs).toBe(10_000);
    expect(batch.results[0]).toMatchObject({ status: 'fresh', executed: true });
  });

  it('uses the full 60s grading budget for criterion probes by default', async () => {
    expect(CRITERION_PROBE_TIMEOUT_MS).toBe(60_000);
    const pending = evaluateCriterionProbeChecks({
      criteria: [{ key: 'r-9', check: { kind: 'probe', probe: readProbe() } as never }],
      ratings: { 'r-9': { rating: 'pass' } },
      dispatchTool: slowDispatch(CRITERION_PROBE_TIMEOUT_MS - 1),
    });
    await vi.advanceTimersByTimeAsync(CRITERION_PROBE_TIMEOUT_MS - 1);
    const evaluation = await pending;
    expect(evaluation).toMatchObject({ ok: true, checkRuns: { 'r-9': { verdict: 'pass', status: 'fresh' } } });
  });

  it('still fails a criterion probe closed when it overruns its grading budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = evaluateCriterionProbeChecks({
      criteria: [{ key: 'r-9', check: { kind: 'probe', probe: readProbe() } as never }],
      ratings: { 'r-9': { rating: 'pass' } },
      dispatchTool: slowDispatch(),
      probeTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(SLOW_READ_MS);
    const evaluation = await pending;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 1000ms'));
    warn.mockRestore();
    expect(evaluation).toMatchObject({ ok: false, error: 'probe_run_failed', criterionKey: 'r-9' });
    expect(evaluation.ok === false && 'detail' in evaluation ? evaluation.detail : '').toContain('1000ms budget');
  });
});

describe('probeDiscriminatorMessage — the refusal must name the REMEDY, not just the shape (EI-21674755057848047)', () => {
  // At least eight items filed this same refusal (EI-21674755057848047,
  // EI-21929976122332931, EI-21926988610689807, EI-21669773488181735,
  // EI-21724647966446631, EI-21681194471658869, EI-21691599989865588,
  // EI-21579824588879610). Every reporter took the same costly workaround —
  // dropping `probe`, and in one case the whole `checks` array — because the bare
  // "Invalid discriminator value" named the missing SHAPE and never the remedy.
  const E = { path: 'ok', op: 'eq' as const, value: true };
  const messageFor = (probe: unknown) => {
    const parsed = continuityProbeShapeSchema.safeParse(probe);
    expect(parsed.success).toBe(false);
    return parsed.success ? '' : parsed.error.issues[0]!.message;
  };

  it('a probe with NOTHING to execute is told to use `recheck` instead of dropping the row', () => {
    const msg = messageFor({ expect: E });
    expect(msg).toMatch(/neither `tool` nor `cell`/);
    expect(msg).toMatch(/OMIT `probe`/);
    expect(msg).toMatch(/`recheck`/);
    // The specific harm this exists to prevent.
    expect(msg).toMatch(/keep the check row rather than dropping it/);
  });

  it('an AMBIGUOUS probe is not misdescribed as an empty one', () => {
    // A single shared message would tell this caller their probe "carries neither",
    // which is false and sends them to fix something that is not wrong.
    const msg = messageFor({ tool: 't', cell: 'c', schemaRevision: 'live', expect: E });
    expect(msg).toMatch(/carries BOTH `tool` and `cell`/);
    expect(msg).toMatch(/state `kind` explicitly/);
    expect(msg).not.toMatch(/neither/);
    expect(msg).not.toMatch(/OMIT `probe`/);
  });

  it('a probe missing only its discriminator names the exact kind to add', () => {
    expect(messageFor({ tool: 't', schemaRevision: 'live', expect: E })).toMatch(/add kind:'tool'/);
    expect(messageFor({ cell: 'c', schemaRevision: 'live', expect: E })).toMatch(/add kind:'state-cell'/);
  });

  it('every variant still identifies the failing field, so the message stays greppable', () => {
    for (const probe of [{ expect: E }, { tool: 't', cell: 'c', schemaRevision: 'live', expect: E }]) {
      expect(messageFor(probe)).toMatch(/probe\.kind is a required discriminator/);
    }
  });
});

describe('continuityPredicateShapeMessage — a wrong-shaped `expect` must name the exact contract (EI-22052859235198905 / EI-22057107388066791 / EI-22057804176244287)', () => {
  // Independent reporters guessed a wrong shape for `expect` (a bare string;
  // a right-shaped predicate plus stray extra keys — e.g. bundled narrative
  // evidence) and got zod's generic structural error back. `superRefine`
  // below already gives a clear message once the shape is RIGHT but the
  // VALUE is wrong (e.g. `exists` with a `value`) — this covers the two
  // structural-mismatch codes the OBJECT schema itself raises (its own
  // invalid_type when the input isn't an object at all, and strict-mode
  // unrecognized_keys). A predicate missing `path`/`op` ENTIRELY still
  // surfaces zod's per-field message at that field's own path (e.g. "expected
  // string, received undefined" at `path:['path']`) — that issue is raised by
  // the CHILD field schema, not this object's own checks, so it is out of
  // scope for this object-level `error` callback; it already names the exact
  // missing field, which is a materially smaller class of confusion than the
  // wrong-TYPE / stray-KEYS cases this message targets.
  const messageFor = (expect: unknown) => {
    const parsed = continuityPredicateSchema.safeParse(expect);
    if (parsed.success) throw new Error('expected this shape to be rejected');
    return parsed.error.issues[0]!.message;
  };

  it('a bare string is named as the wrong TYPE, not a generic parse failure', () => {
    expect(messageFor('the state is green')).toBe(continuityPredicateShapeMessage());
  });

  it('a right-shaped predicate plus stray extra keys (bundled narrative evidence) is named', () => {
    expect(messageFor({ path: '$.state', op: 'eq', value: 'green', reason: 'why I expect this' })).toBe(
      continuityPredicateShapeMessage(),
    );
  });

  it('a free-form evidence object (extra keys beyond path/op/value) is named', () => {
    expect(messageFor({ path: '$.state', op: 'eq', value: 'green', evidence: 'observed via curl' })).toBe(
      continuityPredicateShapeMessage(),
    );
  });

  it('the message states the exact shape + a worked example, and redirects narrative evidence', () => {
    const msg = continuityPredicateShapeMessage();
    expect(msg).toContain('{ path: string, op:');
    expect(msg).toContain('{ path: "$.state", op: "eq", value: "green" }');
    expect(msg).toMatch(/`verified`\/`recheck`/);
  });

  it('a right-shaped predicate with a wrong VALUE still gets its own specific superRefine message, unaffected', () => {
    expect(() => continuityPredicateSchema.parse({ path: '$.state', op: 'exists', value: 'green' })).toThrow(
      /`exists` does not take a value/,
    );
    const msg = messageFor({ path: '$.state', op: 'exists', value: 'green' });
    expect(msg).not.toBe(continuityPredicateShapeMessage());
  });
});
