import { describe, expect, it } from 'vitest';
import type { CorpusCase } from './acceptance-corpus';
import type { EngineArm, EngineQueryResult } from './engine-comparison';
import type { ArmAnswer, ArmCapabilities, FairCase } from './fair-comparison';
import { classifyArmError, fromEngineArm, runConformance, toCorpusCase, type FairArm } from './fair-comparison-arms';
import { MICRO_CASES, microRepoKeys } from './fair-comparison-micro-repo';

const caps = (intents: ArmCapabilities['intents']): ArmCapabilities => ({ armId: 'fake', version: '1', intents, licence: 'first-party' });
const kase: FairCase = { id: 'c1', intent: 'callers', subject: 'foo', tags: [], source: 'authored' };

function fakeEngine(reply: (c: CorpusCase) => EngineQueryResult | Promise<EngineQueryResult>): EngineArm & { calls: CorpusCase[] } {
  const calls: CorpusCase[] = [];
  return {
    calls,
    id: 'fake',
    version: '1',
    treeRoot: '/tmp/x',
    unavailable: null,
    index: async () => ({ wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null }),
    refresh: async () => ({ wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null }),
    indexBytes: async () => 0,
    query: async (c) => {
      calls.push(c);
      return reply(c);
    },
  };
}

describe('classifyArmError', () => {
  it.each([
    [null, 'answered'],
    ['declined: gitnexus facade does not route intent', 'declined'],
    ['gitnexus impact exit 124: ', 'timed-out'],
    ['exit 137 (deadline: process group killed)', 'timed-out'],
    ['request timed out after 120s', 'timed-out'],
    ['index is stale: tree changed since analyze', 'stale-index'],
    ['rg exit 2: regex parse error', 'crashed'],
    ['TypeError: cannot read properties of undefined', 'crashed'],
  ] as const)('%s -> %s', (error, status) => {
    expect(classifyArmError(error)).toBe(status);
  });
});

describe('fromEngineArm', () => {
  it('passes the subject as the query text and keeps the answered sites', async () => {
    const engine = fakeEngine(() => ({ sites: [{ path: 'a.ts', line1: 3, kind: null }], responseBytes: 10, error: null }));
    let t = 100;
    const arm = fromEngineArm(engine, caps(['callers']), () => (t += 7));
    const a = await arm.query(kase);
    expect(engine.calls[0]).toMatchObject({ id: 'c1', intent: 'callers', query: 'foo' });
    expect(a).toEqual({ caseId: 'c1', status: 'answered', sites: [{ path: 'a.ts', line1: 3, kind: null }], latencyMs: 7 });
  });

  it('declines an undeclared intent without querying the engine', async () => {
    const engine = fakeEngine(() => ({ sites: [{ path: 'a.ts', line1: 1, kind: null }], responseBytes: 1, error: null }));
    const a = await fromEngineArm(engine, caps(['definition']), () => 0).query(kase);
    expect(a.status).toBe('declined');
    expect(a.sites).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it('turns an error string into a typed status and drops any sites with it', async () => {
    const engine = fakeEngine(() => ({ sites: [{ path: 'junk.ts', line1: 1, kind: null }], responseBytes: 0, error: 'gitnexus context exit 124: ' }));
    const a = await fromEngineArm(engine, caps(['callers']), () => 0).query(kase);
    expect(a).toMatchObject({ status: 'timed-out', sites: [], detail: 'gitnexus context exit 124: ' });
  });

  it('turns a thrown error into crashed, never into an empty answer', async () => {
    const engine = fakeEngine(() => {
      throw new Error('gitnexus impact exit 1: boom');
    });
    const a = await fromEngineArm(engine, caps(['callers']), () => 0).query(kase);
    expect(a.status).toBe('crashed');
    expect(a.detail).toContain('boom');
  });

  it('builds a CorpusCase the 2026-10-02 arms accept', () => {
    expect(toCorpusCase({ ...kase, intent: 'text-search', subject: 'grand total' })).toMatchObject({ intent: 'text-search', query: 'grand total' });
  });
});

describe('runConformance', () => {
  const keys = microRepoKeys();
  const site = (s: string) => {
    const i = s.lastIndexOf(':');
    return { path: s.slice(0, i), line1: Number(s.slice(i + 1)), kind: null };
  };
  const oracle = (override: (c: FairCase) => ArmAnswer | null = () => null, intents = MICRO_CASES.map((c) => c.intent)): FairArm => ({
    capabilities: { armId: 'oracle', version: '1', intents: [...new Set(intents)], licence: 'first-party' },
    unavailable: null,
    index: async () => ({ wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null }),
    query: async (c) =>
      override(c) ?? { caseId: c.id, status: 'answered', sites: keys.find((k) => k.caseId === c.id)!.sites.map(site), latencyMs: 1 },
  });

  it('passes an arm that returns the key (control)', async () => {
    const r = await runConformance(oracle(), MICRO_CASES, keys);
    expect(r.defects).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.scores.every((s) => s.outcome === 'correct')).toBe(true);
  });

  it('names a plain-case miss as an adapter defect', async () => {
    const r = await runConformance(
      oracle((c) => (c.id === 'micro-definition-doubled' ? { caseId: c.id, status: 'answered', sites: [site('src/app/report.ts:11')], latencyMs: 1 } : null)),
      MICRO_CASES,
      keys,
    );
    expect(r.ok).toBe(false);
    expect(r.defects).toEqual([expect.objectContaining({ caseId: 'micro-definition-doubled', outcome: 'wrong' })]);
    expect(r.defects[0]!.why).toContain('src/app/report.ts:12');
  });

  it('does not count a hard-case miss as a defect, but does count any crash', async () => {
    const r = await runConformance(
      oracle((c) => {
        if (c.id === 'micro-callers-by-label-dynamic') return { caseId: c.id, status: 'answered', sites: [], latencyMs: 1 };
        if (c.id === 'micro-callers-add') return { caseId: c.id, status: 'crashed', sites: [], latencyMs: 1, detail: 'boom' };
        return null;
      }),
      MICRO_CASES,
      keys,
    );
    expect(r.defects.map((d) => d.caseId)).toEqual(['micro-callers-add']);
    expect(r.scores.find((s) => s.caseId === 'micro-callers-by-label-dynamic')!.confidentFalseEmpty).toBe(true);
  });

  it('treats a coarser-granularity answer (partial, precision 1) as measured, but a wrong extra site as a defect', async () => {
    const coarse = await runConformance(
      oracle((c) => (c.id === 'micro-references-sort-rows' ? { caseId: c.id, status: 'answered', sites: [site('src/main.ts:1')], latencyMs: 1 } : null)),
      MICRO_CASES,
      keys,
    );
    expect(coarse.ok).toBe(true);
    expect(coarse.scores.find((s) => s.caseId === 'micro-references-sort-rows')).toMatchObject({ outcome: 'partial', precision: 1 });
    const extra = await runConformance(
      oracle((c) => (c.id === 'micro-references-sort-rows' ? { caseId: c.id, status: 'answered', sites: [site('src/main.ts:2'), site('src/main.ts:5'), site('src/main.ts:6')], latencyMs: 1 } : null)),
      MICRO_CASES,
      keys,
    );
    expect(extra.defects).toEqual([expect.objectContaining({ caseId: 'micro-references-sort-rows', outcome: 'partial' })]);
  });

  it('reports an accepted engine fault without blocking, but still blocks a different crash and flags an unused acceptance', async () => {
    const crash = (msg: string) => (c: FairCase) => ({ caseId: c.id, status: 'crashed' as const, sites: [], latencyMs: 1, detail: msg });
    const accepted = [
      { caseId: 'micro-impact-doubled', outcome: 'crashed' as const, detail: /Binder exception/, evidence: 'reproduced through the engine MCP server' },
      { caseId: 'micro-callees-report', outcome: 'wrong' as const, evidence: 'engine fixed since; acceptance should go' },
    ];
    const ok = await runConformance(oracle((c) => (c.id === 'micro-impact-doubled' ? crash('Binder exception: alias')(c) : null)), MICRO_CASES, keys, accepted);
    expect(ok.ok).toBe(true);
    expect(ok.defects).toEqual([]);
    expect(ok.acceptedFaults.map((f) => [f.caseId, f.evidence])).toEqual([['micro-impact-doubled', 'reproduced through the engine MCP server']]);
    expect(ok.unusedAcceptances).toEqual(['micro-callees-report:wrong']);

    const other = await runConformance(oracle((c) => (c.id === 'micro-impact-doubled' ? crash('parser blew up')(c) : null)), MICRO_CASES, keys, accepted);
    expect(other.ok).toBe(false);
    expect(other.defects.map((d) => d.caseId)).toEqual(['micro-impact-doubled']);

    await expect(runConformance(oracle(), MICRO_CASES, keys, [{ caseId: 'x', outcome: 'crashed', evidence: 'e' }])).rejects.toThrow(/needs a detail pattern/);
    await expect(runConformance(oracle(), MICRO_CASES, keys, [{ caseId: 'x', outcome: 'wrong', evidence: ' ' }])).rejects.toThrow(/no evidence/);
  });

  it('does not count an undeclared intent as a defect', async () => {
    const r = await runConformance(oracle(() => null, ['text-search']), MICRO_CASES, keys);
    expect(r.ok).toBe(true);
    expect(r.scores.filter((s) => s.outcome === 'undeclared').length).toBe(MICRO_CASES.filter((c) => c.intent !== 'text-search').length);
  });
});
