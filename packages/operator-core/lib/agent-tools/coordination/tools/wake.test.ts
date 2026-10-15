/**
 * wake.test.ts — coord:wake (fleet-dispatch-wake-clarity P-006). The wake substrate
 * (wakeRecipients / reportIdleRecipients) + recipient resolve are mocked so we assert the
 * tool's contract: single-target only, fires the resolved key, and reports a dead miss LOUDLY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wakeRecipients = vi.fn();
const reportIdleRecipients = vi.fn();
const resolveRecipients = vi.fn();
const isSelectorOrWildcard = vi.fn((id: string) => id === '*' || id === 'human' || id.startsWith('@'));

vi.mock('../inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
  reportIdleRecipients: (...a: unknown[]) => reportIdleRecipients(...a),
}));
vi.mock('../recipient-resolve', () => ({
  resolveRecipients: (...a: unknown[]) => resolveRecipients(...a),
  isSelectorOrWildcard: (id: string) => isSelectorOrWildcard(id),
}));
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-me', workspaceId: 'ws' }),
}));

import wake from './wake';

const ctx = { uiClientId: 'su-me', isSuperuser: true, workspaceId: 'ws' } as never;
const out = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
const structured = (res: unknown) => (res as { structuredContent?: unknown }).structuredContent;

function expectWireEqual(res: unknown) {
  expect(structured(res)).toBeDefined();
  expect(JSON.parse(JSON.stringify(structured(res)))).toEqual(out(res));
}

describe('coord:wake', () => {
  beforeEach(() => {
    wakeRecipients.mockReset();
    reportIdleRecipients.mockReset();
    resolveRecipients.mockReset();
    resolveRecipients.mockResolvedValue({ resolved: ['su-bee-FULL'], unknown: [], ambiguous: [] });
    wakeRecipients.mockResolvedValue({ targets: ['su-bee-FULL'], keys: [], woken: 1, staged: 0 });
  });

  it('resolves the handle and reports a queued wake without claiming pickup', async () => {
    const raw = await wake.handler({ to: 'su-bee' } as never, ctx);
    const res = out(raw);
    expect(resolveRecipients).toHaveBeenCalled();
    // wakeRecipients fired on the RESOLVED full ownerId
    expect(wakeRecipients.mock.calls[0][0]).toEqual(['su-bee-FULL']);
    expect(res).toMatchObject({
      ok: true,
      to: 'su-bee-FULL',
      queued: 1,
      woken: 0,
      pickupConfirmed: false,
    });
    expect(res.warning).toMatch(/pickup is NOT confirmed/i);
    expectWireEqual(raw);
  });

  it('keeps queued count separate from the execution-confirmed pickup field', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-bee-FULL'], keys: [], woken: 2, staged: 0 });

    const res = out(await wake.handler({ to: 'su-bee' } as never, ctx));

    expect(res.queued).toBe(2);
    expect(res.woken).toBe(0);
    expect(res.pickupConfirmed).toBe(false);
  });

  // P-006 / D-005: pickup is reported by a LATER seam; the result hands over the key to await.
  it('surfaces the not-picked-up handle and names it in the warning, still pickupConfirmed:false', async () => {
    const pickup = [{ target: 'su-bee-FULL', event: 'wake:not-picked-up:su-bee-FULL', windowSec: 600 }];
    wakeRecipients.mockResolvedValue({ targets: ['su-bee-FULL'], keys: [], woken: 1, staged: 0, pickup });

    const res = out(await wake.handler({ to: 'su-bee' } as never, ctx));

    expect(res.pickupConfirmed).toBe(false);
    expect(res.pickup).toEqual(pickup);
    expect(res.warning).toMatch(/pickup is NOT confirmed/i);
    expect(res.warning).toContain('wake:not-picked-up:su-bee-FULL');
  });

  it('passes the note as the wake summary when given', async () => {
    await wake.handler({ to: 'su-bee', note: 'lane ready' } as never, ctx);
    expect(wakeRecipients.mock.calls[0][1]).toMatchObject({ summary: 'lane ready' });
  });

  it('refuses a wildcard/selector target (no thunder-herd)', async () => {
    const raw = await wake.handler({ to: '*' } as never, ctx);
    const res = out(raw);
    expect(res).toMatchObject({ ok: false, error: 'not_a_single_target' });
    expectWireEqual(raw);
    expect(structured(raw)).toMatchObject({ to: '*', queued: 0, woken: 0, pickupConfirmed: false });
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('a woken:0 miss to a DEAD target is a LOUD recipient_dead + relaunch warning', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-dead'], keys: [], woken: 0, staged: 0 });
    resolveRecipients.mockResolvedValue({ resolved: ['su-dead'], unknown: [], ambiguous: [] });
    reportIdleRecipients.mockResolvedValue({ idle: ['su-dead'], live: [], unknown: [], degraded: false });
    const res = out(await wake.handler({ to: 'su-dead' } as never, ctx));
    expect(res.queued).toBe(0);
    expect(res.woken).toBe(0);
    expect(res.pickupConfirmed).toBe(false);
    expect(res.recipient_dead).toEqual(['su-dead']);
    expect(res.warning).toMatch(/RELAUNCH|relaunch/);
  });

  it('a woken:0 miss to a live-but-paused target gets the softer confirm warning (no recipient_dead)', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-paused'], keys: [], woken: 0, staged: 0 });
    resolveRecipients.mockResolvedValue({ resolved: ['su-paused'], unknown: [], ambiguous: [] });
    reportIdleRecipients.mockResolvedValue({ idle: [], live: ['su-paused'], unknown: [], degraded: false });
    const res = out(await wake.handler({ to: 'su-paused' } as never, ctx));
    expect(res.queued).toBe(0);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.pickupConfirmed).toBe(false);
    expect(res.warning).toMatch(/confirm/i);
  });

  it('WI-5994: a woken:0 miss to a DORMANT-SCHEDULED target (armed loop, future fire) is NOT recipient_dead', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-loopy'], keys: [], woken: 0, staged: 0 });
    resolveRecipients.mockResolvedValue({ resolved: ['su-loopy'], unknown: [], ambiguous: [] });
    reportIdleRecipients.mockResolvedValue({
      idle: [],
      live: [],
      dormantScheduled: [{ ownerId: 'su-loopy', parked: false, nextFireAt: '2026-07-26T06:33:29.794Z' }],
      unknown: [],
      degraded: false,
    });
    const res = out(await wake.handler({ to: 'su-loopy' } as never, ctx));
    expect(res.queued).toBe(0);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.pickupConfirmed).toBe(false);
    expect(res.recipient_dormant_scheduled).toEqual([
      { ownerId: 'su-loopy', parked: false, nextFireAt: '2026-07-26T06:33:29.794Z' },
    ]);
    expect(res.warning).toMatch(/DORMANT BETWEEN LOOP FIRES/i);
    expect(res.warning).not.toMatch(/RELAUNCH/);
  });

  it('an unknown recipient is a loud error — nothing woken', async () => {
    resolveRecipients.mockResolvedValue({ resolved: [], unknown: ['nope'], ambiguous: [] });
    const raw = await wake.handler({ to: 'nope' } as never, ctx);
    const res = out(raw);
    expect(res).toMatchObject({ ok: false, error: 'unknown_recipient' });
    expectWireEqual(raw);
    expect(structured(raw)).toMatchObject({ to: 'nope', queued: 0, woken: 0, pickupConfirmed: false });
    expect(wakeRecipients).not.toHaveBeenCalled();
  });
});
