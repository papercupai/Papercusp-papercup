/**
 * presence-rebootstrap.test.ts — P-010 re-bootstrap-on-compaction (D-007).
 *
 * The divergence case the plan calls out explicitly: a snapshot was dropped (the
 * agent's cached roster baseline was lost to compaction) but the cursor advanced
 * — so the next read must re-inject the snapshot ONCE, then never again. Exercised
 * over the InMemoryWatermarkStore (no PG), plus the pure render guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryWatermarkStore } from '@papercusp/pubsub-substrate/watermark-store';
import {
  configureWatermarkStore,
  resetWatermarkStore,
  readWatermark,
  writeWatermark,
} from './watermarks';
import {
  consumePresenceRebootstrap,
  renderPresenceRebootstrapBlock,
  type PresenceSnapshot,
} from './presence-snapshot';

describe('consumePresenceRebootstrap (P-010 / D-007)', () => {
  beforeEach(() => configureWatermarkStore(new InMemoryWatermarkStore()));
  afterEach(() => resetWatermarkStore());

  it('divergence case: re-injects the snapshot ONCE after a fresh-context flag, then never again', async () => {
    // A session-lifecycle start marked a re-bootstrap (the cursor advanced while
    // the cached baseline was lost).
    await writeWatermark('su-x', { snapshot_rebootstrap_pending: true });

    let builds = 0;
    const build = async () => {
      builds++;
      return 'BASELINE';
    };

    // Turn 1: flag set → block returned, build ran, flag cleared.
    const r1 = await consumePresenceRebootstrap('su-x', await readWatermark('su-x'), build);
    expect(r1).toBe('BASELINE');
    expect(builds).toBe(1);
    expect((await readWatermark('su-x')).snapshot_rebootstrap_pending).toBe(false);

    // Turn 2: flag cleared → no re-inject, build NOT called again (idempotent).
    const r2 = await consumePresenceRebootstrap('su-x', await readWatermark('su-x'), build);
    expect(r2).toBeNull();
    expect(builds).toBe(1);
  });

  it('no flag → no re-bootstrap, build is never called', async () => {
    let builds = 0;
    const r = await consumePresenceRebootstrap('su-fresh', await readWatermark('su-fresh'), async () => {
      builds++;
      return 'X';
    });
    expect(r).toBeNull();
    expect(builds).toBe(0);
  });

  it('build failure leaves the flag set to retry next turn (clear runs only after build)', async () => {
    await writeWatermark('su-y', { snapshot_rebootstrap_pending: true });
    await expect(
      consumePresenceRebootstrap('su-y', await readWatermark('su-y'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // flag still set → the next turn re-attempts the re-bootstrap.
    expect((await readWatermark('su-y')).snapshot_rebootstrap_pending).toBe(true);
  });

  it('a peer cursor write (omitting the flag) does NOT clear a pending re-bootstrap', async () => {
    await writeWatermark('su-z', { snapshot_rebootstrap_pending: true });
    // e.g. coord:watermark-set advancing a surface cursor — must preserve the flag.
    await writeWatermark('su-z', { messages_since_ts: '2026-06-15T00:00:00.000Z' });
    expect((await readWatermark('su-z')).snapshot_rebootstrap_pending).toBe(true);
  });
});

describe('renderPresenceRebootstrapBlock', () => {
  it('renders a terse line per agent (label / role / intent / plan) under an as_of header', () => {
    const snap: PresenceSnapshot = {
      as_of: '2026-06-15T02:00:00.000Z',
      scope: 'hive',
      summary: { active: 2, stale: 0, federated: 1, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 0, parked: 0, ended: 0, recorded: 0, unknown: 1 }, byContextPressure: { high: 0, critical: 0 } },
      active: [
        { ownerLabel: 'su · a', agentRole: 'su', intent: 'reviewing the fold', currentPlanSlug: 'presence-v2-2026-06-14', sessionState: 'live' },
        { ownerLabel: 'fed:42@box', intent: 'remote work', sessionState: null }, // no role/plan; liveness is unknown here
      ],
      etag: 'test-etag',
    };
    const block = renderPresenceRebootstrapBlock(snap);
    expect(block).toContain('[presence ⟲ 2]');
    expect(block).toContain('as_of 2026-06-15T02:00:00.000Z');
    expect(block).toContain('su · a [su] reviewing the fold (presence-v2-2026-06-14)');
    expect(block).toContain('fed:42@box [—] remote work [liveness unknown]');
  });

  it('below the inline threshold (14 agents) still lists every row', () => {
    const active = Array.from({ length: 14 }, (_, i) => ({
      ownerLabel: `su-${i}`,
      agentRole: 'su',
      intent: 'x',
      sessionState: 'live',
    }));
    const block = renderPresenceRebootstrapBlock({
      as_of: '2026-06-15T02:00:00.000Z',
      scope: 'workspace',
      summary: { active: 14, stale: 0, federated: 0, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 14, parked: 0, ended: 0, recorded: 0, unknown: 0 }, byContextPressure: { high: 0, critical: 0 } },
      active,
      etag: 'test-etag',
    });
    const lines = block.split('\n');
    expect(lines.length).toBe(1 + 14); // header + one row per agent, no summary/overflow line
    expect(lines).toContain('su-0 [su] x');
    expect(lines).toContain('su-13 [su] x');
  });

  it('EI-9029: at/above the inline threshold (15+ agents) collapses to a byState summary + on-demand pointer, never a per-row dump', () => {
    const active = Array.from({ length: 55 }, (_, i) => ({
      ownerLabel: `su-${i}`,
      agentRole: 'su',
      intent: 'x',
      sessionState: i < 50 ? 'live' : i < 54 ? 'parked' : null,
    }));
    const block = renderPresenceRebootstrapBlock({
      as_of: '2026-06-15T02:00:00.000Z',
      scope: 'workspace',
      summary: { active: 55, stale: 0, federated: 0, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 50, parked: 4, ended: 0, recorded: 0, unknown: 1 }, byContextPressure: { high: 0, critical: 0 } },
      active,
      etag: 'test-etag',
    });
    expect(block).toContain('[presence ⟲ 55]');
    // No per-agent rows at all — none of the row labels may appear.
    for (let i = 0; i < 55; i++) expect(block).not.toContain(`su-${i} [su] x`);
    expect(block).toContain('55 agents active (50 live, 4 parked, 1 unknown liveness)');
    expect(block).toContain('not inlined');
    expect(block).toContain('coord:presence');
    // Exactly two lines: header + summary — not a 40+-line dump.
    expect(block.split('\n').length).toBe(2);
  });
});
