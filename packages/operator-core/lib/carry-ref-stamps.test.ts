import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlRows: { rows: unknown[] } = { rows: [] };
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: async () => sqlRows.rows }),
}));

import {
  CARRY_REF_MAX,
  carryRefChangesBlock,
  diffCarryRefStamps,
  extractCarryRefDeps,
  mergeCarryRefStampsIntoDeps,
  parseCarryRefStamps,
  reconcileCarryRefStamps,
  renderCarryRefChanges,
  resolveDecisionTokens,
  resolveFactTokens,
  stampCarryRefs,
  type CarryRefResolver,
} from './carry-ref-stamps';

const CTX = { workspaceId: 'ws-1', harness: 'papercusp' };

beforeEach(() => {
  sqlRows.rows = [];
});

describe('extractCarryRefDeps', () => {
  it('extracts work items, decisions, facts and repo files in order of first appearance, deduplicated', () => {
    const text = [
      'Blocked on WI-6554700010012441 until carry-recheck-and-governed-memory-2026-10-14#D-004 is settled.',
      'See fact:guard-rail:loop-monitor-inconclusive and fact `owner-name`.',
      'Edited packages/operator-core/lib/carry-note.ts:3084 and `libs/flags/src/types.ts`.',
      'Again WI-6554700010012441 and plan:carry-recheck-and-governed-memory-2026-10-14#D-004.',
    ].join('\n');
    expect(extractCarryRefDeps(text)).toEqual([
      'work-item:WI-6554700010012441',
      'decision:carry-recheck-and-governed-memory-2026-10-14#D-004',
      'fact:guard-rail:loop-monitor-inconclusive',
      'fact:owner-name',
      'file:packages/operator-core/lib/carry-note.ts',
      'file:libs/flags/src/types.ts',
    ]);
  });

  it('strips sentence punctuation and a repo prefix from file paths, and ignores short WI aliases', () => {
    expect(extractCarryRefDeps('Changed papercusp/scripts/lint-tsc.mjs. Also WI-548 (alias).')).toEqual([
      'file:scripts/lint-tsc.mjs',
    ]);
  });

  it('honours exclude and the cap', () => {
    const ids = Array.from({ length: CARRY_REF_MAX + 5 }, (_, i) => `EI-${100000 + i}`).join(' ');
    const out = extractCarryRefDeps(`WI-1234 ${ids}`, { exclude: ['work-item:WI-1234'] });
    expect(out).toHaveLength(CARRY_REF_MAX);
    expect(out[0]).toBe('work-item:EI-100000');
  });

  it('returns nothing for empty text', () => {
    expect(extractCarryRefDeps(null)).toEqual([]);
    expect(extractCarryRefDeps('no references here')).toEqual([]);
  });
});

describe('stampCarryRefs (write side)', () => {
  it('stamps every reference that resolves now and leaves out the ones that do not', async () => {
    const resolve: CarryRefResolver = vi.fn(async (deps) => {
      const m = new Map<string, string | null>();
      for (const d of deps) m.set(d, d === 'work-item:WI-1111' ? 'wip@100' : d.startsWith('file:') ? 'sha256:aa' : null);
      return m;
    });
    const stamps = await stampCarryRefs({
      text: 'WI-1111 and EI-2222 touched packages/x/y.ts',
      workspaceId: 'ws-1',
      harness: 'papercusp',
      now: 42,
      resolve,
    });
    expect(stamps).toEqual([
      { dep: 'work-item:WI-1111', token: 'wip@100', at: 42 },
      { dep: 'file:packages/x/y.ts', token: 'sha256:aa', at: 42 },
    ]);
  });

  it('never throws and stamps nothing without a workspace or when resolution fails', async () => {
    expect(await stampCarryRefs({ text: 'WI-1111', workspaceId: null, harness: null })).toEqual([]);
    const boom: CarryRefResolver = async () => {
      throw new Error('pg down');
    };
    expect(await stampCarryRefs({ text: 'WI-1111', workspaceId: 'ws-1', harness: null, resolve: boom })).toEqual([]);
  });

  it('persists the exact source root that supplied a carried file hash', async () => {
    const stamps = await stampCarryRefs({
      text: 'See packages/operator-core/lib/carry-ref-stamps.ts',
      workspaceId: 'ws-1',
      harness: 'papercusp',
      now: 42,
    });
    expect(stamps).toEqual([
      expect.objectContaining({
        dep: 'file:packages/operator-core/lib/carry-ref-stamps.ts',
        token: expect.stringMatching(/^sha256:[0-9a-f]{16}$/),
        at: 42,
        sourceRoot: expect.any(String),
        sourceRootKind: 'canonical-repo',
      }),
    ]);
  });

  // CRGM-P-002-own-item-excluded: a work-item checkpoint never stamps its own id, so the next
  // wake cannot report the author's own write as a moved reference.
  it('never stamps an excluded reference (a checkpoint citing its own work item)', async () => {
    const resolve = vi.fn<CarryRefResolver>(async (deps) => new Map(deps.map((d) => [d, 'open@1'])));
    const stamps = await stampCarryRefs({
      text: 'WI-5000 waits on WI-1111',
      workspaceId: 'ws-1',
      harness: 'papercusp',
      exclude: ['work-item:WI-5000'],
      resolve,
    });
    expect(stamps.map((s) => s.dep)).toEqual(['work-item:WI-1111']);
    expect(resolve.mock.calls[0]![0]).toEqual(['work-item:WI-1111']);
  });
});

describe('reconcileCarryRefStamps (what a write persists)', () => {
  const prior = {
    v: 1,
    stamps: [],
    refs: [
      { dep: 'work-item:WI-1111', token: 'wip@1', at: 1 },
      { dep: 'work-item:WI-2222', token: 'open@1', at: 1 },
    ],
  };

  it('lets fresh stamps win and keeps a prior baseline only while the stored note still cites it', () => {
    const out = reconcileCarryRefStamps('Still on WI-1111 and WI-3333.', [{ dep: 'work-item:WI-3333', token: 'open@9', at: 9 }], prior);
    expect(out).toEqual([
      { dep: 'work-item:WI-3333', token: 'open@9', at: 9 },
      { dep: 'work-item:WI-1111', token: 'wip@1', at: 1 },
    ]);
  });

  it('prefers the fresh stamp over a prior one for the same reference', () => {
    const out = reconcileCarryRefStamps('WI-1111', [{ dep: 'work-item:WI-1111', token: 'done@5', at: 5 }], prior);
    expect(out).toEqual([{ dep: 'work-item:WI-1111', token: 'done@5', at: 5 }]);
  });

  it('keeps cited priors when the caller did not stamp, and stores nothing for a cleared note', () => {
    expect(reconcileCarryRefStamps('WI-2222 only', undefined, prior).map((s) => s.dep)).toEqual(['work-item:WI-2222']);
    expect(reconcileCarryRefStamps(null, [{ dep: 'work-item:WI-1111', token: 'x', at: 1 }], prior)).toEqual([]);
  });
});

describe('deps payload merge + parse', () => {
  const stamp = { dep: 'work-item:WI-1111', token: 'wip@1', at: 1 };

  it('adds refs beside the declared payload without touching it', () => {
    const declared = { v: 1, stamps: [{ dep: 'file:a.ts', token: 't', at: 1 }] };
    expect(mergeCarryRefStampsIntoDeps(declared, [stamp], null)).toEqual({ ...declared, refs: [stamp] });
  });

  it('creates a refs-only payload whose declared stamps stay empty', () => {
    expect(mergeCarryRefStampsIntoDeps(null, [stamp], null)).toEqual({ v: 1, stamps: [], refs: [stamp] });
  });

  it('carries prior refs forward when the write passes none, and clears them on []', () => {
    const prior = { v: 1, stamps: [], refs: [stamp] };
    expect(mergeCarryRefStampsIntoDeps(prior, undefined, prior)).toEqual(prior);
    expect(mergeCarryRefStampsIntoDeps(null, undefined, prior)).toEqual({ v: 1, stamps: [], refs: [stamp] });
    expect(mergeCarryRefStampsIntoDeps(prior, [], prior)).toEqual({ v: 1, stamps: [] });
    expect(mergeCarryRefStampsIntoDeps(null, [], prior)).toBeNull();
  });

  it('parses refs defensively', () => {
    expect(parseCarryRefStamps({ refs: [stamp, { dep: '' }, null, { dep: 'x:y', token: 3 }] })).toEqual([stamp]);
    expect(parseCarryRefStamps(null)).toEqual([]);
    expect(parseCarryRefStamps({ v: 1, stamps: [] })).toEqual([]);
  });
});

describe('diff + render (read side)', () => {
  const stamps = [
    { dep: 'work-item:WI-1111', token: 'wip@100', at: 1 },
    { dep: 'file:packages/x/y.ts', token: 'sha256:aa', at: 1 },
    { dep: 'decision:p#D-001', token: 'sha256:d1', at: 1 },
    { dep: 'fact:k', token: 'live:9@5', at: 1 },
  ];

  it('reports changed and unresolved references without claiming deletion, and nothing for unchanged ones', () => {
    const current = new Map<string, string | null>([
      ['work-item:WI-1111', 'done@200'],
      ['file:packages/x/y.ts', 'sha256:aa'],
      ['decision:p#D-001', null],
      ['fact:k', 'retracted:9'],
    ]);
    const changes = diffCarryRefStamps(stamps, current, 'loop note');
    expect(changes.map((c) => [c.dep, c.kind])).toEqual([
      ['work-item:WI-1111', 'changed'],
      ['decision:p#D-001', 'unverified'],
      ['fact:k', 'changed'],
    ]);
    const text = renderCarryRefChanges(changes, { where: 'wake delivery', readAtIso: '2026-10-14T00:00:00Z' })!;
    expect(text).toContain('3 references need review');
    expect(text).toContain('↻ CHANGED — work-item:WI-1111 [loop note]: wip → done');
    expect(text).toContain('⚠ UNVERIFIED — decision:p#D-001 [loop note]');
    expect(text).toContain('this is not evidence of deletion');
    expect(text).toContain('↻ CHANGED — fact:k [loop note]: now retracted');
    expect(text).not.toContain('packages/x/y.ts');
  });

  it('renders nothing when every reference is unchanged', () => {
    const current = new Map<string, string | null>(stamps.map((s) => [s.dep, s.token]));
    expect(diffCarryRefStamps(stamps, current, 'loop note')).toEqual([]);
    expect(renderCarryRefChanges([], { where: 'wake delivery' })).toBeNull();
  });

  it('says a work item was updated when only its timestamp moved', () => {
    const changes = diffCarryRefStamps([stamps[0]!], new Map([['work-item:WI-1111', 'wip@300']]), 'WI-9 checkpoint');
    expect(renderCarryRefChanges(changes, { where: 'compaction recovery' })).toContain('wip (updated since)');
  });

  it('identifies a file-source shift separately when the hash is unchanged', () => {
    const stamp = {
      dep: 'file:packages/x/y.ts',
      token: 'sha256:aa',
      at: Date.parse('2026-10-25T00:00:00Z'),
      sourceRoot: '/old/checkout',
      sourceRootKind: 'canonical-repo' as const,
    };
    const current = new Map([[stamp.dep, stamp.token]]);
    const roots = new Map([[stamp.dep, { root: '/new/checkout', rootSource: 'canonical-repo' as const }]]);
    const changes = diffCarryRefStamps([stamp], current, 'WI-9 checkpoint', roots);
    expect(changes).toEqual([
      expect.objectContaining({ dep: stamp.dep, kind: 'source-shift', rootChanged: true }),
    ]);
    expect(renderCarryRefChanges(changes, { where: 'compaction recovery' })).toContain('SOURCE ROOT CHANGED');
  });

  it('renders file hash changes with the stamp time and both source roots', () => {
    const stamp = {
      dep: 'file:packages/x/y.ts',
      token: 'sha256:aa',
      at: Date.parse('2026-10-25T00:00:00Z'),
      sourceRoot: '/repo/staging',
      sourceRootKind: 'harness-root' as const,
    };
    const current = new Map([[stamp.dep, 'sha256:bb']]);
    const roots = new Map([[stamp.dep, { root: '/repo/staging', rootSource: 'harness-root' as const }]]);
    const rendered = renderCarryRefChanges(
      diffCarryRefStamps([stamp], current, 'WI-9 checkpoint', roots),
      { where: 'compaction recovery', readAtIso: '2026-10-26T00:00:00Z' },
    );
    expect(rendered).toContain('stamped=2026-10-25T00:00:00.000Z');
    expect(rendered).toContain('baseline-root=harness-root /repo/staging');
    expect(rendered).toContain('current-root=harness-root /repo/staging');
  });
});

describe('carryRefChangesBlock', () => {
  const loop = { label: 'loop note', stamps: [{ dep: 'work-item:WI-1111', token: 'wip@1', at: 1 }] };
  const held = { label: 'WI-2222 checkpoint', stamps: [{ dep: 'file:a/b.ts', token: 'sha256:aa', at: 1 }, { dep: 'work-item:WI-1111', token: 'wip@1', at: 1 }] };

  it('resolves the union once and renders one line per changed reference per source', async () => {
    const resolve = vi.fn<CarryRefResolver>(async () => new Map([['work-item:WI-1111', 'done@2'], ['file:a/b.ts', 'sha256:aa']]));
    const out = await carryRefChangesBlock([loop, held], { workspaceId: 'ws-1', harness: 'papercusp', where: 'compaction recovery', resolve });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toEqual(['work-item:WI-1111', 'file:a/b.ts']);
    expect(out).toContain('[loop note]: wip → done');
    expect(out).toContain('[WI-2222 checkpoint]: wip → done');
    expect(out).not.toContain('a/b.ts');
  });

  it('returns null when nothing moved, when nothing is stamped, and without a workspace', async () => {
    const same: CarryRefResolver = async (deps) => new Map(deps.map((d) => [d, d === 'file:a/b.ts' ? 'sha256:aa' : 'wip@1']));
    expect(await carryRefChangesBlock([loop, held], { workspaceId: 'ws-1', harness: null, where: 'wake delivery', resolve: same })).toBeNull();
    expect(await carryRefChangesBlock([], { workspaceId: 'ws-1', harness: null, where: 'wake delivery', resolve: same })).toBeNull();
    expect(await carryRefChangesBlock([loop], { workspaceId: null, harness: null, where: 'wake delivery', resolve: same })).toBeNull();
  });

  it('says it could not re-check on a resolver failure or overrun instead of staying silent', async () => {
    const boom: CarryRefResolver = async () => {
      throw new Error('pg down');
    };
    expect(await carryRefChangesBlock([loop], { workspaceId: 'ws-1', harness: null, where: 'wake delivery', resolve: boom })).toContain(
      'COULD NOT RE-CHECK at wake delivery: pg down',
    );
    const slow: CarryRefResolver = () => new Promise(() => {});
    expect(
      await carryRefChangesBlock([loop], { workspaceId: 'ws-1', harness: null, where: 'wake delivery', resolve: slow, timeoutMs: 10 }),
    ).toContain('did not resolve within 10ms');
  });
});

describe('decision and fact resolvers', () => {
  it('hashes one decision and reports a missing decision or plan as null', async () => {
    sqlRows.rows = [
      { plan_slug: 'p', harness_slug: 'papercusp', decisions: [{ id: 'D-001', title: 'T', body: 'B' }] },
    ];
    const out = await resolveDecisionTokens(['p#D-001', 'p#D-009', 'q#D-001', 'not-a-ref'], CTX);
    expect(out.get('p#D-001')).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(out.get('p#D-009')).toBeNull();
    expect(out.get('q#D-001')).toBeNull();
    expect(out.get('not-a-ref')).toBeNull();
    sqlRows.rows = [{ plan_slug: 'p', harness_slug: 'papercusp', decisions: [{ id: 'D-001', title: 'T', body: 'B2' }] }];
    const edited = await resolveDecisionTokens(['p#D-001'], CTX);
    expect(edited.get('p#D-001')).not.toBe(out.get('p#D-001'));
  });

  it('uses the note harness when a plan slug exists in several harnesses', async () => {
    sqlRows.rows = [
      { plan_slug: 'p', harness_slug: 'other', decisions: [{ id: 'D-001', title: 'X', body: 'X' }] },
      { plan_slug: 'p', harness_slug: 'papercusp', decisions: [{ id: 'D-001', title: 'T', body: 'B' }] },
    ];
    const a = await resolveDecisionTokens(['p#D-001'], CTX);
    const b = await resolveDecisionTokens(['p#D-001'], { workspaceId: 'ws-1', harness: 'nowhere' });
    expect(a.get('p#D-001')).toMatch(/^sha256:/);
    expect(b.get('p#D-001')).toBeNull();
  });

  it('maps a fact key to live, retracted or missing', async () => {
    sqlRows.rows = [
      { key: 'live-key', id: 7, updated_at: new Date(5000), retracted_at: null, superseded_at: null, evicted_at: null, expires_at: null },
      { key: 'dead-key', id: 8, updated_at: new Date(6000), retracted_at: new Date(7000), superseded_at: null, evicted_at: null, expires_at: null },
      { key: 'old-key', id: 9, updated_at: new Date(1000), retracted_at: null, superseded_at: null, evicted_at: null, expires_at: new Date(2000) },
    ];
    const out = await resolveFactTokens(['live-key', 'dead-key', 'old-key', 'never-key'], CTX, 10_000);
    expect(out.get('live-key')).toBe('live:7@5000');
    expect(out.get('dead-key')).toBe('retracted:8');
    expect(out.get('old-key')).toBe('expired:9');
    expect(out.get('never-key')).toBeNull();
  });
});
