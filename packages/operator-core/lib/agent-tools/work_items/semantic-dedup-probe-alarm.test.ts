/**
 * semantic-dedup-probe-alarm.test — EI-22170937574367219: the missing
 * publisher for "the semantic dedup probe just went unavailable". Covers:
 * (1) the VITEST no-op guard (so the ~15 existing dedup-gate test cases that
 * already drive this path via a null-mocked findSemanticDupes need no new
 * mocking), and (2) the real path's escalation shape once VITEST is cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const escalationMocks = vi.hoisted(() => ({ open: vi.fn(async () => ({ msg_id: 'esc-1' })) }));
vi.mock('../coordination/escalations', () => ({ openEscalation: escalationMocks.open }));
const railMocks = vi.hoisted(() => ({
  broadcast: vi.fn(async (_event: { conditionKey?: string; oneShot?: boolean }) => true),
  resolve: vi.fn(async (_event: { conditionKey: string }) => true),
  read: vi.fn(async () => []),
  states: vi.fn(() => [] as Array<{ condition_key: string; open: boolean }>),
}));
vi.mock('../../severe-event-broadcast', () => ({
  broadcastSevereEvent: railMocks.broadcast, broadcastSevereEventResolved: railMocks.resolve,
}));
vi.mock('../coordination/tools/conditions', () => ({
  readConditionEnvelopes: railMocks.read, computeConditionStates: railMocks.states,
}));

import {
  reportDedupCoverageDegraded,
  reportSemanticDedupProbeUnavailable,
} from './semantic-dedup-probe-alarm';

const originalVitest = process.env.VITEST;

describe('reportSemanticDedupProbeUnavailable', () => {
  beforeEach(() => {
    escalationMocks.open.mockClear();
    vi.clearAllMocks();
    railMocks.states.mockReturnValue([]);
  });
  afterEach(() => {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
  });

  it('is a NO-OP under vitest — never calls openEscalation (protects the ~15 dedup-gate tests)', async () => {
    expect(process.env.VITEST).toBeTruthy(); // the ambient contract this test relies on
    await reportDedupCoverageDegraded({
      source: 'improvements:capture',
      harnessSlug: 'papercusp',
      coverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    });
    expect(escalationMocks.open).not.toHaveBeenCalled();
    expect(railMocks.broadcast).not.toHaveBeenCalled();
  });

  it('opens a deduplicated advisory escalation with source and achieved coverage', async () => {
    delete process.env.VITEST;
    await reportDedupCoverageDegraded({
      source: 'improvements:capture',
      harnessSlug: 'papercusp',
      coverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    });
    expect(escalationMocks.open).toHaveBeenCalledTimes(1);
    const [identity, input] = escalationMocks.open.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; body: string; meta?: { dedupKind?: string; subjectSignature?: string } },
    ];
    expect(identity.ownerId).toBe('system:semantic-dedup-probe-alarm');
    expect(input.severity).toBe('advisory');
    expect(input.summary).toContain('coverage is incomplete');
    expect(input.body).toContain("from improvements:capture in harness 'papercusp'");
    expect(input.body).toContain('lexical=unavailable, semantic=unavailable');
    expect(input.meta).toEqual({
      dedupKind: 'work-item-dedup-coverage-degraded',
      subjectSignature: 'papercusp-work-item-dedup',
    });
  });

  it('keeps the legacy work_items:create alarm mapped onto the shared coverage alert', async () => {
    delete process.env.VITEST;
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'papercusp' });
    const input = (escalationMocks.open.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(input.body).toContain('from work_items:create');
    expect(input.body).toContain('semantic=unavailable');
  });

  it('never throws when openEscalation itself fails (fire-and-forget contract)', async () => {
    delete process.env.VITEST;
    escalationMocks.open.mockRejectedValueOnce(new Error('pg down'));
    await expect(reportDedupCoverageDegraded({ source: 'improvements:capture' })).resolves.toBeUndefined();
  });

  it('omits the harness clause from the body when no harnessSlug is known', async () => {
    delete process.env.VITEST;
    await reportDedupCoverageDegraded({ source: 'improvements:capture' });
    const input = (escalationMocks.open.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(input.body).not.toContain('in harness');
  });

  it('opens one-shot leg conditions before the advisory, independently of advisory failure', async () => {
    const order: string[] = [];
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture' }, {
      rail: { broadcast: async event => { order.push(event.conditionKey!); return true; } },
      escalate: async () => { order.push('legacy'); throw new Error('advisory failed'); },
    });
    expect(order).toEqual(['alarm:work-item-dedup-coverage:work_items%3Acreate:fixture:semantic', 'legacy']);
    expect(railMocks.read).not.toHaveBeenCalled();
  });

  it('preserves skipped, absent and unclassified readings and recovers only the measured leg', async () => {
    const open = new Set<string>();
    const deps = { rail: {
      broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); open.add(event.conditionKey!); return true;
      },
      resolve: async (event: { conditionKey: string }) => open.delete(event.conditionKey),
    }, escalate: async () => {} };
    const input = { source: 'improvements:capture' as const, harnessSlug: 'fixture' };
    await reportDedupCoverageDegraded({ ...input,
      coverage: { lexical: 'unavailable', semantic: 'partial', degraded: true } }, deps);
    expect(open.size).toBe(2);
    for (const status of [undefined, 'skipped', 'unknown']) {
      await reportDedupCoverageDegraded({ ...input,
        coverage: { lexical: status, semantic: status, degraded: false } }, deps);
      expect(open.size).toBe(2);
    }
    await reportDedupCoverageDegraded({ ...input,
      coverage: { lexical: 'skipped', semantic: 'ok', degraded: false } }, deps);
    expect([...open]).toEqual(['alarm:work-item-dedup-coverage:improvements%3Acapture:fixture:lexical']);
    await reportDedupCoverageDegraded({ ...input,
      coverage: { lexical: 'ok', semantic: 'ok', degraded: false } }, deps);
    expect(open.size).toBe(0);
  });

  it('requires complete measured coverage to resolve unclassified degradation', async () => {
    const open = new Set<string>();
    const deps = { rail: {
      broadcast: async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; },
      resolve: async (event: { conditionKey: string }) => open.delete(event.conditionKey),
    }, escalate: async () => {} };
    const input = { source: 'improvements:capture' as const, harnessSlug: 'fixture' };
    await reportDedupCoverageDegraded({ ...input, coverage: { degraded: true } }, deps);
    expect([...open][0]).toMatch(/:unknown$/);
    await reportDedupCoverageDegraded({ ...input, coverage: { semantic: 'ok', degraded: false } }, deps);
    expect(open.size).toBe(1);
    await reportDedupCoverageDegraded({ ...input,
      coverage: { semantic: 'ok', lexical: 'ok', degraded: false } }, deps);
    expect(open.size).toBe(0);
  });

  it('partitions recovery by source and harness, including escaped names', async () => {
    const resolve = vi.fn(async (_event: { conditionKey: string }) => true);
    const broadcast = vi.fn(async (_event: { conditionKey?: string }) => true);
    const deps = { rail: { resolve, broadcast }, escalate: async () => {} };
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'a:b' }, deps);
    const breachedKey = broadcast.mock.calls[0][0].conditionKey!;
    await reportDedupCoverageDegraded({ source: 'improvements:capture', harnessSlug: 'a:b',
      coverage: { semantic: 'ok' } }, deps);
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'other', coverage: { semantic: 'ok' } }, deps);
    expect(resolve.mock.calls.map(([event]) => event.conditionKey)).not.toContain(breachedKey);
    expect(breachedKey).toContain(':a%3Ab:semantic');
  });

  it('uses durable open conditions after restart and stays quiet for already healthy legs', async () => {
    delete process.env.VITEST;
    const key = 'alarm:work-item-dedup-coverage:work_items%3Acreate:fixture:semantic';
    railMocks.states.mockReturnValue([{ condition_key: key, open: true }]);
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture',
      coverage: { semantic: 'ok', lexical: 'skipped', degraded: false } });
    expect(railMocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
    railMocks.resolve.mockClear(); railMocks.states.mockReturnValue([]);
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture', coverage: { semantic: 'ok' } });
    expect(railMocks.resolve).not.toHaveBeenCalled();
  });

  it('keeps both legs independent when broadcasts, resolution or advisory delivery fail', async () => {
    const warn = vi.spyOn(console, 'warn');
    const broadcast = vi.fn(async () => { throw new Error('rail failed'); });
    const resolve = vi.fn(async () => { throw new Error('recovery failed'); });
    const escalate = vi.fn(async () => { throw new Error('advisory failed'); });
    await expect(reportDedupCoverageDegraded({ source: 'improvements:capture',
      coverage: { lexical: 'unavailable', semantic: 'partial', degraded: true } },
    { rail: { broadcast, resolve }, escalate })).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledTimes(2); expect(escalate).toHaveBeenCalledOnce();
    await expect(reportDedupCoverageDegraded({ source: 'improvements:capture',
      coverage: { lexical: 'ok', semantic: 'ok', degraded: false } },
    { rail: { broadcast, resolve }, escalate })).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(3); expect(warn).not.toHaveBeenCalled(); warn.mockRestore();
  });

  it('orders fire-and-forget observations in each source/harness partition', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(done => { release = done; });
    const order: string[] = [];
    const deps = { rail: {
      broadcast: async () => { order.push('open'); await blocked; return true; },
      resolve: async () => { order.push('resolve'); return true; },
    }, escalate: async () => {} };
    const degraded = reportSemanticDedupProbeUnavailable({ harnessSlug: 'ordered' }, deps);
    const recovered = reportSemanticDedupProbeUnavailable({ harnessSlug: 'ordered',
      coverage: { semantic: 'ok', degraded: false } }, deps);
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['open']); release(); await Promise.all([degraded, recovered]);
    expect(order).toEqual(['open', 'resolve']);
  });
});
