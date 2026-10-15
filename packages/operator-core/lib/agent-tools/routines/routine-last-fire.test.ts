/**
 * routine-last-fire.test.ts — EI-25264102161745452.
 *
 * `routines:list { name }` attaches `lastFire`: what the newest completed fire of a
 * system routine DID, read from the DBOS step output bound to the routine id. Before
 * this, a fire's `diagnostics` (SystemActionResult) were retained but unreadable
 * without hand-written SQL against dbos.operation_outputs.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/routines/routine-last-fire.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseRoutineFireOutput,
  readRoutineLastFires,
  ROUTINE_LAST_FIRE_LOOKBACK_MS,
  ROUTINE_LAST_FIRE_MAX_CHARS,
  type LastFireSql,
} from './routine-last-fire';

const superjson = (value: unknown): string => JSON.stringify({ json: value });

describe('parseRoutineFireOutput', () => {
  it('unwraps superjson diagnostics + softError and stamps completedAt', () => {
    const fire = parseRoutineFireOutput({
      workflow_uuid: 'sched-.routinesTick-2026-10-06T20:03:00.000Z-15',
      output: superjson({ diagnostics: { status: 'swept', reds: 18 }, softError: 'one red unfiled' }),
      error: null,
      completed_at_epoch_ms: '1791316993704',
    });
    expect(fire).toEqual({
      completedAt: new Date(1791316993704).toISOString(),
      workflowId: 'sched-.routinesTick-2026-10-06T20:03:00.000Z-15',
      diagnostics: { status: 'swept', reds: 18 },
      softError: 'one red unfiled',
      error: null,
    });
  });

  it('reads a void action (no diagnostics) as diagnostics:null, not as a failure', () => {
    for (const output of [superjson(null), superjson(undefined), null, '']) {
      const fire = parseRoutineFireOutput({ workflow_uuid: 'w', output, error: null, completed_at_epoch_ms: 1 });
      expect(fire.diagnostics).toBeNull();
      expect(fire.softError).toBeNull();
      expect(fire.error).toBeNull();
    }
  });

  it('accepts a plain-JSON (non-superjson) output', () => {
    const fire = parseRoutineFireOutput({
      workflow_uuid: 'w', output: JSON.stringify({ diagnostics: { n: 1 } }), error: null, completed_at_epoch_ms: 1,
    });
    expect(fire.diagnostics).toEqual({ n: 1 });
  });

  it('surfaces a thrown step error by its message, bounded', () => {
    const fire = parseRoutineFireOutput({
      workflow_uuid: 'w', output: null, error: superjson({ name: 'ReferenceError', message: 'X is not defined' }), completed_at_epoch_ms: 1,
    });
    expect(fire.error).toBe('X is not defined');
    const long = parseRoutineFireOutput({ workflow_uuid: 'w', output: null, error: 'e'.repeat(2_000), completed_at_epoch_ms: 1 });
    expect(long.error!.length).toBeLessThanOrEqual(501);
  });

  it('replaces an oversized diagnostics body with a bounded head instead of passing it through', () => {
    const big = { outcomes: Array.from({ length: 400 }, (_, i) => ({ specPath: `apps/operator/e2e/s${i}.spec.ts`, outcome: 'owned' })) };
    const fire = parseRoutineFireOutput({ workflow_uuid: 'w', output: superjson({ diagnostics: big }), error: null, completed_at_epoch_ms: 1 });
    expect(fire.diagnostics).toBeNull();
    expect(fire.diagnosticsTruncated?.chars).toBe(JSON.stringify(big).length);
    expect(fire.diagnosticsTruncated?.head.length).toBe(ROUTINE_LAST_FIRE_MAX_CHARS);
  });

  it('reports completedAt null when DBOS recorded none', () => {
    expect(parseRoutineFireOutput({ workflow_uuid: 'w', output: null, error: null, completed_at_epoch_ms: null }).completedAt).toBeNull();
  });
});

/** A fake tagged-template sql that records each call and answers from `respond`. */
function fakeSql(respond: (text: string, values: unknown[]) => unknown[] | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?');
    calls.push({ text, values });
    const r = respond(text, values);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as LastFireSql;
  return { sql, calls };
}

describe('readRoutineLastFires', () => {
  const NOW = 1_791_320_000_000;

  it('does not query at all when no routine is a system action', async () => {
    const { sql, calls } = fakeSql(() => []);
    const out = await readRoutineLastFires(sql, [{ id: 'rt_a', targetRole: 'queen' }], NOW);
    expect(calls).toHaveLength(0);
    expect(out.size).toBe(0);
  });

  it('binds fires to the ROUTINE ID (not just the shared function name) and maps a missing fire to null', async () => {
    const { sql, calls } = fakeSql(() => [
      { routine_id: 'rt_papercusp_red_filer', workflow_uuid: 'wf1', output: superjson({ diagnostics: { reds: 2 } }), error: null, completed_at_epoch_ms: '1791316993704' },
    ]);
    const out = await readRoutineLastFires(sql, [
      { id: 'rt_papercusp_red_filer', targetRole: 'system:operator-e2e-red-filer' },
      { id: 'rt_other_install_red_filer', targetRole: 'system:operator-e2e-red-filer' },
      { id: 'rt_agent', targetRole: 'queen' },
    ], NOW);

    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    // The routine id is the routineFire workflow's first input; that, not the
    // function name, is what keeps another install's fire of the same action out.
    expect(text).toContain("w.inputs::jsonb -> 'json' ->> 0");
    expect(text).toContain("w.name = 'routineFire'");
    expect(values).toContainEqual(['system:operator-e2e-red-filer']);
    expect(values).toContainEqual(['rt_papercusp_red_filer', 'rt_other_install_red_filer']);
    expect(values).toContain(NOW - ROUTINE_LAST_FIRE_LOOKBACK_MS);

    expect(out.get('rt_papercusp_red_filer')).toMatchObject({ workflowId: 'wf1', diagnostics: { reds: 2 } });
    expect(out.get('rt_other_install_red_filer')).toBeNull();
    expect(out.has('rt_agent')).toBe(false);
  });

  it('turns a failed lookup into an explicit { unavailable } per system routine, never a throw', async () => {
    const { sql } = fakeSql(() => new Error('relation "dbos.operation_outputs" does not exist'));
    const out = await readRoutineLastFires(sql, [{ id: 'rt_x', targetRole: 'system:git-sync' }], NOW);
    expect(out.get('rt_x')).toEqual({ unavailable: expect.stringContaining('dbos.operation_outputs') });
  });

  it('converts a timeout from the bounded query runner to unavailable instead of failing the list', async () => {
    const { sql } = fakeSql(() => []);
    const runQuery = vi.fn(async () => {
      throw Object.assign(new Error('statement timeout'), { code: '57014' });
    });
    const out = await readRoutineLastFires(
      sql,
      [{ id: 'rt_x', targetRole: 'system:git-sync' }],
      NOW,
      runQuery,
    );

    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(out.get('rt_x')).toEqual({ unavailable: expect.stringContaining('statement timeout') });
  });
});
