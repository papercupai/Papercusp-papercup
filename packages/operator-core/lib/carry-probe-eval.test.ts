import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => [] as Array<Record<string, any>>);

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => catalog,
  projectedToolRegistryRevision: (tools: Array<Record<string, any>>) =>
    `rev:${tools.map((entry) => entry.expose.mcp.name).join(',')}:${JSON.stringify(tools.map((entry) => entry.inputSchema)).length}`,
}));

import {
  carriedProbeBlockForDelivery,
  carriedProbeRunCeilingMs,
  carriedProbeSources,
  renderCarriedProbeBlock,
  runCarriedProbesForDelivery,
} from './carry-probe-eval';
import {
  CONTINUITY_PROBE_MAX_PER_WAKE,
  continuityProbeRevision,
  type ContinuityProbe,
} from './continuity-probes';
import type { CheckEntry } from './carry-note';

function projected(name: string, effect: 'read' | 'write', properties: Record<string, unknown>) {
  return {
    expose: { mcp: { name } },
    inputSchema: { type: 'object', properties, additionalProperties: false },
    capabilities: [],
    effect,
  };
}

function probe(tool: string, id: string): ContinuityProbe {
  return {
    kind: 'tool',
    tool,
    args: { id },
    schemaRevision: continuityProbeRevision(tool)!,
    expect: { path: '$.state', op: 'eq', value: 'green' },
  } as ContinuityProbe;
}

function check(claim: string, p?: ContinuityProbe, id?: string): CheckEntry {
  return { ...(id ? { id } : {}), claim, recheck: 'read status', ...(p ? { probe: p } : {}) } as CheckEntry;
}

/** A read-only dispatcher answering `{ state }` from the probe's id; 'boom' returns a tool error. */
function statusDispatcher() {
  return vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (args.id === 'boom') return { isError: true, content: [{ type: 'text', text: 'relation does not exist' }] };
    return { content: [{ type: 'text', text: JSON.stringify({ state: args.id === 'ok' ? 'green' : 'red' }) }] };
  });
}

beforeEach(() => {
  catalog.splice(
    0,
    catalog.length,
    projected('status:read', 'read', { id: { type: 'string' } }),
    projected('status:write', 'write', { id: { type: 'string' } }),
  );
});

describe('carriedProbeSources', () => {
  it('orders loop checks before held work-item checks and keeps their indexes', () => {
    const sources = carriedProbeSources({
      loop: { ownerId: 'su-me', checks: [check('a'), check('b')] },
      workItems: [{ id: 'WI-9', harness: 'papercusp', checks: [check('c')] }],
    });
    expect(sources.map((s) => [s.source, s.checkIndex, s.check.claim])).toEqual([
      [{ kind: 'loop', ownerId: 'su-me' }, 0, 'a'],
      [{ kind: 'loop', ownerId: 'su-me' }, 1, 'b'],
      [{ kind: 'work-item', id: 'WI-9', harness: 'papercusp' }, 0, 'c'],
    ]);
  });
});

describe('R-1 / R-25: changed and could-not-run probes get a line; matching probes print nothing', () => {
  it('renders a changed probe with its observed value and a probe that could not run with its reason', async () => {
    const dispatchTool = statusDispatcher();
    const sources = carriedProbeSources({
      loop: {
        ownerId: 'su-me',
        checks: [
          check('gate is green', probe('status:read', 'ok'), 'gate'),
          check('deploy is green', probe('status:read', 'drifted'), 'deploy'),
          check('table exists', probe('status:read', 'boom')),
        ],
      },
    });
    const block = await carriedProbeBlockForDelivery(sources, { dispatchTool, readAtIso: '2026-10-14T09:00:00.000Z' });
    expect(dispatchTool).toHaveBeenCalledTimes(3);
    expect(block).not.toBeNull();
    const lines = block!.split('\n');
    expect(lines[0]).toContain('readAt=2026-10-14T09:00:00.000Z');
    expect(lines[0]).toContain('1 hold · 1 changed · 1 could not run');
    expect(lines).toContain('  ✗ CHANGED — deploy is green [loop #deploy]: observed "red"');
    expect(lines.find((l) => l.startsWith('  ? COULD NOT RUN — table exists [loop check 3]'))).toMatch(
      /tool_error — read-only probe status:read returned an error: relation does not exist/,
    );
    // R-25: the matching probe is counted in the header but gets no line of its own.
    expect(lines.some((l) => l.includes('gate is green'))).toBe(false);
    // the header plus one line per changed or could-not-run probe
    expect(lines).toHaveLength(3);
  });

  it('renders nothing for probes that still match their expect value', async () => {
    const dispatchTool = statusDispatcher();
    const sources = carriedProbeSources({
      loop: {
        ownerId: 'su-me',
        checks: [check('gate is green', probe('status:read', 'ok'), 'gate'), check('ci is green', probe('status:read', 'ok'))],
      },
    });
    const block = await carriedProbeBlockForDelivery(sources, { dispatchTool });
    // Both probes ran and matched: D-001 'prints nothing when nothing changed'.
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(block).toBeNull();
  });

  it('renders a check without a probe as nothing (only probed checks are evaluated)', async () => {
    const dispatchTool = statusDispatcher();
    const sources = carriedProbeSources({ loop: { ownerId: 'su-me', checks: [check('prose only')] } });
    expect(await carriedProbeBlockForDelivery(sources, { dispatchTool })).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('caps the probes run per delivery and says how many were left un-run', async () => {
    const dispatchTool = statusDispatcher();
    const checks = Array.from({ length: CONTINUITY_PROBE_MAX_PER_WAKE + 2 }, (_, i) =>
      check(`claim ${i}`, probe('status:read', 'ok')),
    );
    const block = await carriedProbeBlockForDelivery(carriedProbeSources({ loop: { ownerId: 'su-me', checks } }), {
      dispatchTool,
    });
    expect(dispatchTool).toHaveBeenCalledTimes(CONTINUITY_PROBE_MAX_PER_WAKE);
    expect(block).toContain(`${CONTINUITY_PROBE_MAX_PER_WAKE} hold · 0 changed · 0 could not run · 2 not run`);
    expect(block).toMatch(/… 2 more carried probe\(s\) were NOT run \(per-delivery cap 8 probes/);
  });
});

describe('R-10: a probe that is not provably read-only is refused without being dispatched', () => {
  it('reports a write-capable tool probe as could-not-run (not_read_only) and never calls the dispatcher', async () => {
    const dispatchTool = statusDispatcher();
    const sources = carriedProbeSources({
      workItems: [{ id: 'WI-1', checks: [check('item closed', probe('status:write', 'ok'), 'w')] }],
    });
    const outcome = await runCarriedProbesForDelivery(sources, { dispatchTool });
    expect(outcome?.kind).toBe('batch');
    if (outcome?.kind !== 'batch') throw new Error('expected a batch');
    expect(outcome.batch.results[0]).toMatchObject({ status: 'unknown', executed: false, diagnostic: { code: 'not_read_only' } });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(renderCarriedProbeBlock(outcome)).toContain(
      '  ? COULD NOT RUN — item closed [WI-1 #w]: not_read_only — status:write is not provably read-only for these arguments',
    );
  });

  it('refuses a probe naming a tool absent from the catalog without dispatching it', async () => {
    const dispatchTool = statusDispatcher();
    const sources = carriedProbeSources({
      loop: { ownerId: 'su-me', checks: [check('mystery', { ...probe('status:read', 'ok'), tool: 'nope:gone' } as ContinuityProbe)] },
    });
    const block = await carriedProbeBlockForDelivery(sources, { dispatchTool });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(block).toMatch(/\? COULD NOT RUN — mystery \[loop check 1\]: /);
  });
});

describe('R-28: a probe that overruns its per-probe budget is reported, not waited on', () => {
  it('renders a probe that exceeds its per-probe timeout as could-not-run with reason timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 'hang' never answers; every other id answers at once.
    const dispatchTool = vi.fn((_name: string, args: Record<string, unknown>) =>
      args.id === 'hang'
        ? new Promise<never>(() => {})
        : Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ state: 'red' }) }] }),
    );
    const sources = carriedProbeSources({
      loop: {
        ownerId: 'su-me',
        checks: [check('slow check holds', probe('status:read', 'hang')), check('fast check holds', probe('status:read', 'fast'))],
      },
    });
    const block = await carriedProbeBlockForDelivery(sources, { dispatchTool, timeoutMs: 20 });
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    const lines = block!.split('\n');
    expect(lines[0]).toContain('0 hold · 1 changed · 1 could not run');
    const timedOut = lines.find((l) => l.startsWith('  ? COULD NOT RUN — slow check holds [loop check 1]'));
    expect(timedOut).toBeDefined();
    expect(timedOut).toMatch(/: timeout — probe status:read did not return within its 20ms budget/);
    // The overrun did not stall the batch: the other probe still ran and reported its own result.
    expect(lines).toContain('  ✗ CHANGED — fast check holds [loop check 2]: observed "red"');
    warn.mockRestore();
  });
});

describe('delivery fail-soft never reads as "all hold"', () => {
  it('turns a runner failure into an explicit could-not-run block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources = carriedProbeSources({ loop: { ownerId: 'su-me', checks: [check('x', probe('status:read', 'ok'))] } });
    const block = await carriedProbeBlockForDelivery(sources, {
      dispatchTool: statusDispatcher(),
      runBatch: async () => {
        throw new Error('registry offline');
      },
    });
    expect(block).toMatch(/^🧪 CARRIED PROBES — COULD NOT RUN at delivery: registry offline\. This is NOT evidence/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-probe-eval:delivery failed: registry offline'));
    warn.mockRestore();
  });

  it('bounds the whole run by the delivery ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources = carriedProbeSources({ loop: { ownerId: 'su-me', checks: [check('x', probe('status:read', 'ok'))] } });
    const outcome = await runCarriedProbesForDelivery(sources, {
      dispatchTool: statusDispatcher(),
      timeoutMs: 5,
      runBatch: () => new Promise(() => {}),
    });
    expect(outcome).toEqual({ kind: 'failed', reason: `the probe run exceeded its ${carriedProbeRunCeilingMs(5)}ms delivery ceiling` });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('carry-probe-eval:delivery exceeded'));
    warn.mockRestore();
  });

  it('returns null without loading a dispatcher when nothing carries a probe', async () => {
    const runBatch = vi.fn();
    expect(await runCarriedProbesForDelivery(carriedProbeSources({}), { runBatch })).toBeNull();
    expect(runBatch).not.toHaveBeenCalled();
    expect(renderCarriedProbeBlock(null)).toBeNull();
  });
});
