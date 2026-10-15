/**
 * WI-6554700010009537 recurrence guard: the scheduled re-score's DEFAULT probe dispatcher must be
 * admitted by the palette chokepoint for a sql probe.
 *
 * Every scheduled fire on 2026-10-13 (06:05Z, 06:20Z) lost all 13 sql probe rows of
 * papercusp-app-performance: dispatchPaletteTarget refused dev:pg_query with
 * confirmation_required, because the palette guard classes raw SQL as high-tier and the re-score
 * dispatched unconfirmed. The unit tests of rescoreRubric inject their own dispatcher, so they
 * could not see it. This guard derives dev:pg_query's capability from the REAL projected tool
 * registration, so a later tier change cannot silently re-open the gap.
 */
import { describe, expect, it } from 'vitest';
import { lookupByMcpName, tierFor } from '@papercusp/agent-mcp';
import '../../agent-tools/dev/pg_query';
import { projectedToolToCapability } from '../../capabilities/from-tooldef';
import { paletteInvokeGuard, type dispatchPaletteTarget } from '../../capabilities/invoke';
import { RESCORE_CONFIRMED_PROBE_TOOLS, rescoreProbeDispatcher } from './rubric-rescore-action';

type DispatchOpts = Parameters<typeof dispatchPaletteTarget>[0];
type DispatchResult = Awaited<ReturnType<typeof dispatchPaletteTarget>>;

function guardFor(name: string, confirmed: boolean) {
  const projected = lookupByMcpName(name);
  if (!projected) throw new Error(`${name} is not registered in this test process`);
  const cap = projectedToolToCapability(
    name,
    { ...projected, capabilities: projected.capabilities as readonly string[] },
    tierFor,
  );
  return paletteInvokeGuard(cap, confirmed, true);
}

function recordingDispatch(calls: DispatchOpts[]): typeof dispatchPaletteTarget {
  return async (opts) => {
    calls.push(opts);
    return { content: [] } as unknown as DispatchResult;
  };
}

describe('rubric re-score: default probe dispatcher', () => {
  it('the palette chokepoint refuses an unconfirmed dev:pg_query (the failure this guards)', () => {
    expect(guardFor('dev:pg_query', false)).toMatchObject({ allow: false, code: 'confirmation_required' });
  });

  it('confirms dev:pg_query, so the real palette guard admits a sql probe', async () => {
    const calls: DispatchOpts[] = [];
    await rescoreProbeDispatcher('papercusp', recordingDispatch(calls))('dev:pg_query', { sql: 'SELECT 1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'dev:pg_query', confirmed: true, harness: 'papercusp' });
    expect(guardFor('dev:pg_query', calls[0].confirmed === true).allow).toBe(true);
  });

  it('confirms nothing except dev:pg_query, and omits an absent harness', async () => {
    expect([...RESCORE_CONFIRMED_PROBE_TOOLS]).toEqual(['dev:pg_query']);
    const calls: DispatchOpts[] = [];
    await rescoreProbeDispatcher(undefined, recordingDispatch(calls))('state:read', { cell: 'git.pipelinePosition' });
    expect(calls[0].confirmed).toBeUndefined();
    expect('harness' in calls[0]).toBe(false);
  });
});
