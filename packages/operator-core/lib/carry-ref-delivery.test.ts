/**
 * P-002 (carry-recheck-and-governed-memory-2026-10-14) read side: carried-reference re-check at
 * wake delivery and compaction recovery. Readers and the resolver are injected — no database.
 *
 * BARs: R-2 (wake: changed → one line), R-12 (wake: unresolved → unverified), R-21 (wake: unchanged → silent),
 * R-11 (recovery: changed), R-20 (recovery: unresolved → unverified), R-22 (recovery: unchanged → silent).
 */
import { describe, it, expect, vi } from 'vitest';
import { carryRefChangesForRecovery, carryRefChangesForWake, stampsCitedBy } from './carry-ref-delivery';
import type { CarryRefResolver } from './carry-ref-stamps';
import type { DepStamp } from './freshness/index';

const WS = 'papercusp-workspace';
const READ_AT = '2026-10-14T13:00:00.000Z';

function stamp(dep: string, token: string): DepStamp {
  return { dep, token, at: 1 };
}

function resolverFrom(current: Record<string, string | null>): CarryRefResolver {
  return vi.fn(async (deps: readonly string[]) => new Map(deps.map((d) => [d, d in current ? current[d]! : null])));
}

describe('stampsCitedBy', () => {
  it('keeps only stamps whose reference the delivered note still cites', () => {
    const stamps = [stamp('work-item:WI-1234', 'open@1'), stamp('work-item:WI-9999', 'open@1')];
    expect(stampsCitedBy('Did: WI-1234', stamps).map((s) => s.dep)).toEqual(['work-item:WI-1234']);
    expect(stampsCitedBy(null, stamps)).toEqual([]);
    expect(stampsCitedBy('Did: WI-1234', [])).toEqual([]);
  });
});

describe('carryRefChangesForWake', () => {
  const note = 'Did: WI-1234 landed; see plan-x#D-002 and packages/operator-core/lib/a.ts.';
  const stamps = [
    stamp('work-item:WI-1234', 'open@100'),
    stamp('decision:plan-x#D-002', 'sha256:aaaa'),
    stamp('file:packages/operator-core/lib/a.ts', 'sha256:bbbb'),
  ];
  const readLoopRefStamps = vi.fn(async () => ({ note, stamps }));

  it('renders changed references and marks an unresolved file unverified rather than gone (R-12)', async () => {
    const out = await carryRefChangesForWake({
      ownerId: 'su-1',
      harness: 'papercusp',
      workspaceId: WS,
      deliveredNote: note,
      readAtIso: READ_AT,
      readLoopRefStamps,
      resolve: resolverFrom({
        'work-item:WI-1234': 'done@200',
        'decision:plan-x#D-002': 'sha256:aaaa',
        'file:packages/operator-core/lib/a.ts': null,
      }),
    });
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    expect(lines[0]).toContain('re-checked at wake delivery (readAt=2026-10-14T13:00:00.000Z)');
    expect(lines[0]).toContain('2 references need review');
    expect(lines).toContain('  ↻ CHANGED — work-item:WI-1234 [loop note]: open → done');
    expect(lines.some((l) => l.startsWith('  ⚠ UNVERIFIED — file:packages/operator-core/lib/a.ts [loop note]'))).toBe(true);
    expect(out).toContain('this is not evidence of deletion');
    // the unchanged decision gets no line
    expect(out).not.toContain('decision:plan-x#D-002');
    expect(lines).toHaveLength(3);
  });

  it('renders nothing when every carried reference still matches its stamp (R-21)', async () => {
    const out = await carryRefChangesForWake({
      ownerId: 'su-1',
      harness: 'papercusp',
      workspaceId: WS,
      deliveredNote: note,
      readAtIso: READ_AT,
      readLoopRefStamps,
      resolve: resolverFrom({
        'work-item:WI-1234': 'open@100',
        'decision:plan-x#D-002': 'sha256:aaaa',
        'file:packages/operator-core/lib/a.ts': 'sha256:bbbb',
      }),
    });
    expect(out).toBeNull();
  });

  it('never reads the stamp row when the delivered note cites no reference', async () => {
    const read = vi.fn(async () => ({ note: 'x', stamps }));
    const resolve = resolverFrom({});
    const out = await carryRefChangesForWake({
      ownerId: 'su-1',
      harness: 'papercusp',
      workspaceId: WS,
      deliveredNote: 'Did: nothing citable here.',
      readAtIso: READ_AT,
      readLoopRefStamps: read,
      resolve,
    });
    expect(out).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('ignores a stamp for a reference the delivered note does not cite (row rewritten between reads)', async () => {
    const resolve = resolverFrom({ 'work-item:WI-1234': 'open@100', 'work-item:WI-7777': 'done@9' });
    const out = await carryRefChangesForWake({
      ownerId: 'su-1',
      harness: 'papercusp',
      workspaceId: WS,
      deliveredNote: 'Did: WI-1234',
      readAtIso: READ_AT,
      readLoopRefStamps: async () => ({
        note: 'Did: WI-1234 and WI-7777',
        stamps: [stamp('work-item:WI-1234', 'open@100'), stamp('work-item:WI-7777', 'open@1')],
      }),
      resolve,
    });
    expect(out).toBeNull();
    expect(resolve).toHaveBeenCalledWith(['work-item:WI-1234'], expect.anything());
  });

  it('says it could not re-check when the stamp read throws, instead of staying silent', async () => {
    const out = await carryRefChangesForWake({
      ownerId: 'su-1',
      harness: 'papercusp',
      workspaceId: WS,
      deliveredNote: 'Did: WI-1234',
      readAtIso: READ_AT,
      readLoopRefStamps: async () => {
        throw new Error('pool exhausted');
      },
    });
    expect(out).toContain('COULD NOT RE-CHECK at wake delivery');
    expect(out).toContain('pool exhausted');
    expect(out).toContain('NOT evidence they are unchanged');
  });
});

describe('carryRefChangesForRecovery', () => {
  const loopNote = 'Next: finish WI-1111.';
  const heldCheckpoint = 'Waiting on fact `guard-rail:x` and WI-2222.';
  const base = {
    ownerId: 'su-1',
    workspaceId: WS,
    sessionHarness: 'papercusp',
    readAtIso: READ_AT,
    getLoopStatus: async () => ({ active: true, harnessSlug: 'papercusp' }),
    readLoopRefStamps: async () => ({ note: loopNote, stamps: [stamp('work-item:WI-1111', 'wip@1')] }),
    heldItems: [
      { id: 'WI-5000', harness: 'papercusp', checkpoint: heldCheckpoint },
      { id: 'WI-6000', harness: 'papercusp', checkpoint: 'no references' },
    ],
    readWorkItemRefStamps: vi.fn(async () =>
      new Map([
        [
          'WI-5000',
          { note: heldCheckpoint, stamps: [stamp('fact:guard-rail:x', 'live:7@1'), stamp('work-item:WI-2222', 'open@5')] },
        ],
      ]),
    ),
  };

  it('renders changed and unverified references across the loop note and held checkpoints (R-20)', async () => {
    const out = await carryRefChangesForRecovery({
      ...base,
      resolve: resolverFrom({
        'work-item:WI-1111': 'done@2',
        'fact:guard-rail:x': 'retracted:7',
        'work-item:WI-2222': null,
      }),
    });
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    expect(lines[0]).toContain('re-checked at compaction recovery');
    expect(lines).toContain('  ↻ CHANGED — work-item:WI-1111 [loop note]: wip → done');
    expect(lines).toContain('  ↻ CHANGED — fact:guard-rail:x [WI-5000 checkpoint]: now retracted');
    expect(lines.some((l) => l.startsWith('  ⚠ UNVERIFIED — work-item:WI-2222 [WI-5000 checkpoint]'))).toBe(true);
    expect(lines).toHaveLength(4);
    // only the held item whose checkpoint cites something is read
    expect(base.readWorkItemRefStamps).toHaveBeenCalledWith([
      { harness: 'papercusp', workItemId: 'WI-5000', workspaceId: WS },
    ]);
  });

  it('renders nothing when every carried reference still matches (R-22)', async () => {
    const out = await carryRefChangesForRecovery({
      ...base,
      resolve: resolverFrom({
        'work-item:WI-1111': 'wip@1',
        'fact:guard-rail:x': 'live:7@1',
        'work-item:WI-2222': 'open@5',
      }),
    });
    expect(out).toBeNull();
  });

  it('skips the loop note when no loop is active', async () => {
    const readLoop = vi.fn(async () => ({ note: loopNote, stamps: [stamp('work-item:WI-1111', 'wip@1')] }));
    const out = await carryRefChangesForRecovery({
      ...base,
      heldItems: [],
      getLoopStatus: async () => ({ active: false, harnessSlug: 'papercusp' }),
      readLoopRefStamps: readLoop,
      resolve: resolverFrom({ 'work-item:WI-1111': 'done@2' }),
    });
    expect(out).toBeNull();
    expect(readLoop).not.toHaveBeenCalled();
  });

  it('re-resolves each recovery source in its owning harness when the session is unscoped', async () => {
    const dep = 'file:packages/operator-core/lib/shared.ts';
    const checkpoint = 'See packages/operator-core/lib/shared.ts.';
    const heldItems = [
      { id: 'EI-1001', harness: 'papercusp', checkpoint },
      { id: 'EI-1002', harness: 'other-harness', checkpoint },
    ];
    const readWorkItemRefStamps = vi.fn(async () => new Map([
      ['EI-1001', { note: checkpoint, stamps: [stamp(dep, 'sha256:papercusp')] }],
      ['EI-1002', { note: checkpoint, stamps: [stamp(dep, 'sha256:other-harness')] }],
    ]));
    const currentByHarness = new Map([
      ['loop-harness', 'sha256:loop-harness'],
      ['papercusp', 'sha256:papercusp'],
      ['other-harness', 'sha256:other-harness'],
    ]);
    const resolve = vi.fn<CarryRefResolver>(async (deps, ctx) => {
      const token = ctx.harness ? currentByHarness.get(ctx.harness) ?? null : null;
      return new Map(deps.map((ref) => [ref, token]));
    });

    const out = await carryRefChangesForRecovery({
      ownerId: 'su-1',
      workspaceId: WS,
      sessionHarness: null,
      readAtIso: READ_AT,
      getLoopStatus: async () => ({ active: true, harnessSlug: 'loop-harness' }),
      readLoopRefStamps: async () => ({ note: checkpoint, stamps: [stamp(dep, 'sha256:loop-harness')] }),
      heldItems,
      readWorkItemRefStamps,
      resolve,
    });

    expect(out).toBeNull();
    expect(resolve.mock.calls.map(([, ctx]) => ctx.harness)).toEqual([
      'loop-harness',
      'papercusp',
      'other-harness',
    ]);
  });
});
