/**
 * git-sync-events.test.ts — the git-sync commit signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  emitGitSyncCommittedEvent,
  emitGitSyncEgressedEvent,
  emitGitSyncLockRetryEvent,
  emitResourceReleasedEvent,
  resourceReleasedEventKey,
  isSystemGitSyncHolder,
  snapshotGitSyncLockHolders,
} from './git-sync-events';
import { payloadMatchesFilter } from '../../events/await/pattern';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

const SHA = 'abcdef1234567890fedcba';
const SCOPE_A = { installSlug: 'harness-a', workspaceId: 'workspace-a' };
const SCOPE_B = { installSlug: 'harness-b', workspaceId: 'workspace-a' };
const HOLDER = {
  resource: 'git-sync:harness-a',
  owner: 'su-peer',
  owner_label: 'peer agent',
  mode: 'exclusive' as const,
  status: 'held' as const,
  lock_id: 'lock-1',
  reason: 'manual git work',
  acquired_ts: new Date('2026-08-21T10:00:00.000Z'),
  expires_ts: new Date('2026-08-21T10:10:00.000Z'),
  fence_seq: 42,
};

describe('emitGitSyncCommittedEvent (P-102)', () => {
  it('EI-255886: uses saved producer time when an old commit is emitted after a newer wait', async () => {
    const emit = typedEmit();
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000);
    try {
      emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A }, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const payload = emit.mock.calls.find(([opts]) => opts.key === 'git-sync:committed')?.[0].payload;
      expect(payloadMatchesFilter({ ...SCOPE_A, committedAtMs: { gt: 2_000 } }, payload)).toBe(false);
      expect(payloadMatchesFilter({ ...SCOPE_A, committedAtMs: { gt: 500 } }, payload)).toBe(true);
      expect(payload).toMatchObject({ sha: SHA, committedAtMs: 1_000 });
      expect(emit.mock.calls.map(([opts]) => opts.key)).toContain(`git-sync:committed:${SHA}`);
    } finally {
      now.mockRestore();
    }
  });

  it('EI-255886: missing legacy producer time cannot be synthesized from emission time', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const payload = emit.mock.calls.find(([opts]) => opts.key === 'git-sync:committed')?.[0].payload;
    expect(payloadMatchesFilter({ ...SCOPE_A, committedAtMs: { gt: 500 } }, payload)).toBe(false);
    expect(payload).not.toHaveProperty('committedAtMs');
    expect(emit.mock.calls.map(([opts]) => opts.key)).toContain(`git-sync:committed:${SHA}`);
  });

  it('fires BOTH the global git-sync:committed and the per-sha key, with payload.sha', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('git-sync:committed');
    expect(keys).toContain(`git-sync:committed:${SHA}`);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({
        source: 'git-sync',
        payload: expect.objectContaining({ sha: SHA, ...SCOPE_A }),
      });
      // short-sha (12) appears in the human summary
      expect(call[0].summary).toContain(SHA.slice(0, 12));
      expect(call[0].summary).toContain('local harness checkout');
      expect(call[0].summary).not.toContain('origin/staging');
    }
  });

  it('retains producer time when a delayed prior emit reaches a later no-SHA boundary', async () => {
    let releaseEmit!: () => void;
    const emitGate = new Promise<void>((resolve) => {
      releaseEmit = resolve;
    });
    const emit = vi.fn(async (_opts: EmitOpts) => {
      await emitGate;
      return { ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 };
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A }, 1_000);
    await Promise.resolve();

    const delayedPayload = emit.mock.calls[0]?.[0].payload;
    expect(delayedPayload).toMatchObject({
      sha: SHA,
      ...SCOPE_A,
      committedAtMs: 1_000,
    });
    expect(
      payloadMatchesFilter(
        { ...SCOPE_A, committedAtMs: { gt: 2_000 } },
        delayedPayload,
      ),
    ).toBe(false);

    releaseEmit();
    await emitGate;
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('is an awaiter-only signal — no `to` push (audience is whoever awaited)', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));
    for (const call of emit.mock.calls) expect(call[0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; a sync must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('committed-event'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('scopes a global wake to its harness and workspace (two-harness regression)', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A }, 1_000);
    await new Promise((r) => setTimeout(r, 0));

    const globalPayload = emit.mock.calls.find((call) => call[0].key === 'git-sync:committed')?.[0].payload;
    expect(globalPayload).toMatchObject({ sha: SHA, ...SCOPE_A });
    expect(globalPayload).toMatchObject({ committedAtMs: expect.any(Number) });
    expect(payloadMatchesFilter(SCOPE_A, globalPayload)).toBe(true);
    expect(payloadMatchesFilter(SCOPE_B, globalPayload)).toBe(false);
  });
});

describe('emitGitSyncEgressedEvent (EI-20331175777179195)', () => {
  it('fires BOTH remote-egress keys with payload.sha and an explicit origin/staging summary', async () => {
    const emit = typedEmit();
    emitGitSyncEgressedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((c) => c[0].key)).toEqual([
      'git-sync:egressed',
      `git-sync:egressed:${SHA}`,
    ]);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({
        source: 'git-sync',
        payload: { sha: SHA, ...SCOPE_A },
      });
      expect(call[0].summary).toContain('origin/staging');
      expect(call[0].summary).toContain(SHA.slice(0, 12));
    }
  });

  it('never rejects on an emit failure (a bridge tick must remain best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitGitSyncEgressedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('egressed-event'));
    warn.mockRestore();
  });

  it('emits precise keys for commits included by a later egress head', async () => {
    const emit = typedEmit();
    const ancestor = '1234567890abcdef1234567890abcdef12345678';
    emitGitSyncEgressedEvent(SHA, { emit, scope: SCOPE_A }, { includedShas: [SHA, ancestor, ancestor] });
    await new Promise((r) => setTimeout(r, 0));

    expect(emit.mock.calls.map((c) => c[0].key)).toEqual([
      'git-sync:egressed',
      `git-sync:egressed:${SHA}`,
      `git-sync:egressed:${ancestor}`,
    ]);
    const ancestorCall = emit.mock.calls.find((call) => call[0].key === `git-sync:egressed:${ancestor}`)?.[0];
    expect(ancestorCall).toMatchObject({
      source: 'git-sync',
      payload: { sha: ancestor, egressHead: SHA, ...SCOPE_A },
    });
    expect(ancestorCall?.summary).toContain(`includes ancestor ${ancestor.slice(0, 12)}`);
  });
});

describe('emitGitSyncLockRetryEvent (EI-20271766491179856)', () => {
  it('serializes Date-bearing holder state and emits a scoped retry signal', async () => {
    const emit = typedEmit();
    const holders = snapshotGitSyncLockHolders([HOLDER]);

    emitGitSyncLockRetryEvent('git-sync:harness-a', 'held_exclusive', holders, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));

    expect(holders).toEqual([
      expect.objectContaining({
        owner: 'su-peer',
        acquired_ts: '2026-08-21T10:00:00.000Z',
        expires_ts: '2026-08-21T10:10:00.000Z',
        fence_seq: 42,
      }),
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'git-sync:lock-retry',
      source: 'git-sync',
      payload: {
        ...SCOPE_A,
        resource: 'git-sync:harness-a',
        reason: 'held_exclusive',
        holders,
      },
    });
    expect(emit.mock.calls[0][0].summary).toContain('git-sync:harness-a');
  });

  it('never rejects on an emit failure (a lock skip must remain best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });

    expect(() =>
      emitGitSyncLockRetryEvent('git-sync:harness-a', 'held_exclusive', [], { emit: emit as never, scope: SCOPE_A }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock-retry-event'));
    warn.mockRestore();
  });
});

describe('emitResourceReleasedEvent (EI-22726196301284168)', () => {
  it('emits one exact resource key at the release boundary with scope and release time', async () => {
    const emit = typedEmit();
    emitResourceReleasedEvent('git-sync:harness-a', 'workspace-a', emit);
    await new Promise((r) => setTimeout(r, 0));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: resourceReleasedEventKey('git-sync:harness-a'),
      source: 'resource-locks',
      payload: {
        resource: 'git-sync:harness-a',
        workspaceId: 'workspace-a',
        releasedAtMs: expect.any(Number),
      },
    });
    expect(emit.mock.calls[0][0].summary).toContain('git-sync:harness-a');
  });

  it('omits an absent workspace scope without failing the release notification', async () => {
    const emit = typedEmit();
    emitResourceReleasedEvent('dev-server', undefined, emit);
    await new Promise((r) => setTimeout(r, 0));

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'resource:released:dev-server',
        payload: { resource: 'dev-server', releasedAtMs: expect.any(Number) },
      }),
    );
    expect(emit.mock.calls[0][0].payload).not.toHaveProperty('workspaceId');
  });

  it('never rejects on an emit failure (resource release remains best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });

    expect(() => emitResourceReleasedEvent('dev-server', 'workspace-a', emit as never)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resource-release-event'));
    warn.mockRestore();
  });
});

describe('isSystemGitSyncHolder (EI-22429374186419271)', () => {
  it('recognizes an in-flight git-sync holder for the requested install', () => {
    expect(
      isSystemGitSyncHolder(
        {
          owner: 'system:git-sync:3063386:026aff27-f42d-4d44-94b8-045f102f989a',
          owner_label: 'git-sync:harness-a',
          reason: 'auto-commit harness-a',
        },
        'harness-a',
      ),
    ).toBe(true);
  });

  it('does not misclassify a peer or another install as git-sync', () => {
    expect(
      isSystemGitSyncHolder(
        {
          owner: 'su-peer',
          owner_label: 'peer agent',
          reason: 'manual git work',
        },
        'harness-a',
      ),
    ).toBe(false);
    expect(
      isSystemGitSyncHolder(
        {
          owner: 'system:git-sync:3063386:026aff27-f42d-4d44-94b8-045f102f989a',
          owner_label: 'git-sync:harness-b',
          reason: 'auto-commit harness-b',
        },
        'harness-a',
      ),
    ).toBe(false);
  });
});
