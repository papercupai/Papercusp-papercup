import { describe, expect, it, vi } from 'vitest';
import {
  parseSessionTaskBlockerRef,
  resolveSessionTaskBlocker,
  validateSessionTaskBlockerRef,
} from './session-task-blockers';

const scope = {
  workspaceId: 'ws',
  harness: 'papercusp',
  planSlug: 'cockpit',
  coordinationDomain: '/repo',
};

function sqlReturning(rows: unknown[]) {
  // The wi: branch splices a static kind list via `sql.unsafe(...)`; the fake
  // must expose it like a real postgres.js tag does.
  return Object.assign(vi.fn(async () => rows), { unsafe: (text: string) => text }) as never;
}

describe('session task typed blocker refs', () => {
  it.each([
    ['lock:packages/a.ts', 'lock', 'packages/a.ts'],
    ['event:fleet:ready', 'event', 'fleet:ready'],
    ['wi:WI-9', 'wi', 'WI-9'],
    ['plan:P-004', 'plan', 'P-004'],
    ['waiting for a person', 'text', 'waiting for a person'],
  ])('parses %s as %s', (ref, kind, target) => {
    expect(parseSessionTaskBlockerRef(ref)).toMatchObject({ kind, target, typed: kind !== 'text' });
  });

  it('rejects malformed typed refs without treating them as manual free text', () => {
    expect(() => validateSessionTaskBlockerRef('event:')).toThrow(/requires a target/);
    expect(() => validateSessionTaskBlockerRef('plan:P-4')).toThrow(/plan:P-NNN/);
  });

  it('keeps free text manual', async () => {
    const state = await resolveSessionTaskBlocker(sqlReturning([]), scope, 'waiting for a person');
    expect(state).toMatchObject({ kind: 'text', status: 'manual', autoUnblocks: false });
  });

  it('clears a released lock and waits on a live holder', async () => {
    const releasedSql = vi.fn(async (_strings: TemplateStringsArray, _coordinationDomain: string) => []);
    await expect(resolveSessionTaskBlocker(releasedSql as never, scope, 'lock:a.ts'))
      .resolves.toMatchObject({ status: 'cleared', autoUnblocks: true });
    expect(releasedSql.mock.calls[0]?.[1]).toBe('/repo');
    await expect(resolveSessionTaskBlocker(sqlReturning([{ owner: 'peer', expires_ts: '2026-08-27T00:00:00Z' }]), scope, 'lock:a.ts'))
      .resolves.toMatchObject({ status: 'waiting', detail: 'Held by peer.' });
  });

  it('clears fired events and terminal work/plan items', async () => {
    await expect(resolveSessionTaskBlocker(sqlReturning([{ last_fired_at: '2026-08-26T00:00:00Z', fire_count: 2 }]), scope, 'event:ready'))
      .resolves.toMatchObject({ status: 'cleared' });
    await expect(resolveSessionTaskBlocker(sqlReturning([{ status: 'resolved', updated_ts: '2026-08-26T00:00:00Z' }]), scope, 'wi:WI-9'))
      .resolves.toMatchObject({ status: 'cleared', detail: 'Work item is resolved.' });
    await expect(resolveSessionTaskBlocker(sqlReturning([{ plan_slug: 'cockpit', status: 'done', updated_at: '2026-08-26T00:00:00Z' }]), scope, 'plan:P-004'))
      .resolves.toMatchObject({ status: 'cleared', detail: 'cockpit#P-004 is done.' });
  });

  it('does not auto-clear missing or ambiguous referents', async () => {
    await expect(resolveSessionTaskBlocker(sqlReturning([]), scope, 'wi:WI-404'))
      .resolves.toMatchObject({ status: 'missing' });
    await expect(resolveSessionTaskBlocker(sqlReturning([
      { plan_slug: 'a', status: 'done', updated_at: '2026-08-26T00:00:00Z' },
      { plan_slug: 'b', status: 'done', updated_at: '2026-08-26T00:00:00Z' },
    ]), { ...scope, planSlug: null }, 'plan:P-004'))
      .resolves.toMatchObject({ status: 'ambiguous' });
  });
});
