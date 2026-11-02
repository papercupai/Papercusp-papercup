/**
 * loop-wall-nag — unit tests (compaction-continuity-hardening-2026-07-07 P-006).
 * The detector + renderer are pure; the stash/take cycle runs through injected
 * store seams. Load-bearing contracts: PRECISION-first detection (a noisy nag
 * trains agents to ignore it), take clears exactly once, and every impure path
 * fails soft — a broken store must never disturb the turn-outcome handler or
 * the fire path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  detectOwnerAsk,
  loopWallNagScope,
  renderWallNagLine,
  stashLoopWallNag,
  takeLoopWallNag,
  LOOP_WALL_NAG_EXCERPT_MAX,
} from './loop-wall-nag';

describe('detectOwnerAsk — precision-first final-text scan', () => {
  it.each([
    'The zombie PIDs await owner OK to kill.',
    'Blocked on the owner for the capital arming decision.',
    "Everything else is green; this needs the owner's sign-off.",
    'Deploy is ready, pending owner approval.',
    'This surface is owner-gated, so I stopped there.',
    'I will ask the owner about raising the watermark.',
    'Waiting on the owner to confirm the teardown.',
  ])('fires on: %s', (line) => {
    expect(detectOwnerAsk(`progress notes\n\n${line}`)).toBe(line);
  });

  it.each([
    'All tests green; task complete.',
    'Waiting for CI to finish before the next step.',
    'The deploy needs approval from the release gate suite.', // no OWNER — generic approval prose stays silent
    'I own this lane and will continue next wake.',
  ])('stays silent on: %s', (text) => {
    expect(detectOwnerAsk(text)).toBeNull();
  });

  it('returns the LAST matching line (the ask nearest the turn end names the open commitment)', () => {
    const text = ['Earlier: pending owner approval on X (resolved above).', 'mid work', 'Still awaiting owner OK on Y.'].join('\n');
    expect(detectOwnerAsk(text)).toBe('Still awaiting owner OK on Y.');
  });

  it('caps a very long ask line and handles blank/null input', () => {
    const long = `needs the owner ${'x'.repeat(500)}`;
    expect(detectOwnerAsk(long)!.length).toBeLessThanOrEqual(LOOP_WALL_NAG_EXCERPT_MAX);
    expect(detectOwnerAsk(long)!.endsWith('…')).toBe(true);
    expect(detectOwnerAsk('')).toBeNull();
    expect(detectOwnerAsk(null)).toBeNull();
  });
});

describe('stash / take — the durable one-shot nag cycle', () => {
  const REF = { harness: 'papercusp', ownerId: 'su-abc' };

  it('stash writes a journal-less JSON row under the nag scope; take reads, CLEARS, and parses it', async () => {
    let stored: string | null = null;
    const set = vi.fn(async (_ref: unknown, note: string | null | undefined) => {
      stored = note ?? null;
      return stored;
    });
    const get = vi.fn(async () => stored);

    expect(await stashLoopWallNag(REF, 'awaiting owner OK on Y', 777, { set: set as never })).toBe(true);
    expect(set).toHaveBeenCalledWith(
      { scope: loopWallNagScope('papercusp', 'su-abc'), workspaceId: expect.any(String) },
      JSON.stringify({ atMs: 777, excerpt: 'awaiting owner OK on Y' }),
      { journal: false },
    );

    const nag = await takeLoopWallNag(REF, { get: get as never, set: set as never });
    expect(nag).toEqual({ atMs: 777, excerpt: 'awaiting owner OK on Y' });
    expect(stored).toBeNull(); // cleared — delivered exactly once
    expect(await takeLoopWallNag(REF, { get: get as never, set: set as never })).toBeNull();
  });

  it('fails soft: a throwing store yields false/null, never a throw', async () => {
    const boom = vi.fn(async () => {
      throw new Error('pg down');
    });
    expect(await stashLoopWallNag(REF, 'x', 1, { set: boom as never })).toBe(false);
    expect(await takeLoopWallNag(REF, { get: boom as never, set: boom as never })).toBeNull();
  });

  it('take tolerates a corrupt row (clears it, returns null)', async () => {
    let stored: string | null = 'not json at all';
    const get = vi.fn(async () => stored);
    const set = vi.fn(async () => {
      stored = null;
      return null;
    });
    expect(await takeLoopWallNag(REF, { get: get as never, set: set as never })).toBeNull();
    expect(stored).toBeNull();
  });
});

describe('renderWallNagLine — the hard-style mandate', () => {
  it('names the concrete pending ask and demands the row NOW', () => {
    const line = renderWallNagLine({ atMs: 1, excerpt: 'awaiting owner OK on the zombie PIDs' });
    expect(line).toContain('TURN-SETTLE NAG');
    expect(line).toContain('"awaiting owner OK on the zombie PIDs"');
    expect(line).toContain('loop:checkpoint { walls:');
    expect(line).toContain("origin: 'owner'");
    expect(line).toContain('blocked work_item');
  });
});
