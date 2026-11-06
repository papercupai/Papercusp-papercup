import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wake-mode', () => ({ resolveWakeMode: vi.fn() }));
vi.mock('./pending-wakes', () => ({ stagePendingWake: vi.fn() }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
// Listener recovery has its own persistence boundary. These dispatcher unit
// tests must not fall through to that boundary using their query-only SQL mock.
vi.mock('../../events/await/store', () => ({ listActiveAwaitsForKey: vi.fn() }));
vi.mock('../../events/await/inbox-wake-arm', () => ({ ensureInboxWakeArmedForActiveSession: vi.fn() }));
vi.mock('./wake-fanout-pacing', async (orig) => {
  const m = await orig<typeof import('./wake-fanout-pacing')>();
  return { ...m, reserveWakeFanout: vi.fn(async (count: number, workspaceId = 'ws-1') =>
    m.reserveWakeTimes(5, count, Date.now()).times.map((notBeforeMs) => ({ workspaceId, notBeforeMs }))) };
});
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
// Isolate from the LIVE coord roster: resolveBestEffortAgainstRoster resolves a short
// ownerId PREFIX against coord_presence (owner-2026-06-17), so a real live session whose
// id starts with a test recipient (e.g. 's-1' ⊂ 's-1782…') would leak into `targets`.
// Identity-resolve keeps these unit tests deterministic regardless of who is live; the
// real isSelectorOrWildcard is preserved via importActual.
vi.mock('./recipient-resolve', async (importActual) => ({
  ...(await importActual<typeof import('./recipient-resolve')>()),
  resolveBestEffortAgainstRoster: vi.fn(async (recipients: readonly string[]) => [...recipients]),
  // EI-9971: default to "roster unavailable" (null = fail OPEN) so every EXISTING
  // test below (none of which mock this) keeps staging exactly as before — only
  // the dedicated tests further down override it to exercise the skip path.
  knownOwnerIdSet: vi.fn(async () => null),
}));

import {
  wakeRecipients,
  buildStagedWakeNote,
  isDeliveryLadderWakeSource,
  isEscalationSlaRerouteWakeSource,
  isOwnerGuiWakeSource,
  ESCALATION_SLA_REROUTE_WAKE_SOURCE,
  COORD_WAKE_TARGET_TIMEOUT_MS,
  wakePickupHandle,
} from './inbox-wake';
import { buildKey } from '../../events/await/catalog';
import { ADMIN_COORD_UI_OWNER } from './identity';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { EmitResult } from '../../events/await/engine';
import { resolveWakeMode } from './wake-mode';
import { stagePendingWake } from './pending-wakes';
import { emitAwaitedEvent } from '../../events/await/engine';
import { listActiveAwaitsForKey } from '../../events/await/store';
import { ensureInboxWakeArmedForActiveSession } from '../../events/await/inbox-wake-arm';
import { knownOwnerIdSet, resolveBestEffortAgainstRoster } from './recipient-resolve';
import { getOrgPg } from '@papercusp/db-org';
import { reserveWakeFanout, readWakeFanoutPacing } from './wake-fanout-pacing';

const sqlMock = vi.fn(async (..._args: unknown[]) => []);

beforeEach(() => {
  vi.mocked(resolveWakeMode).mockResolvedValue('auto' as never);
  vi.mocked(stagePendingWake).mockResolvedValue(undefined as never);
  vi.mocked(listActiveAwaitsForKey).mockResolvedValue([{ id: 1 }] as never);
  vi.mocked(ensureInboxWakeArmedForActiveSession).mockResolvedValue(undefined as never);
  vi.mocked(emitAwaitedEvent).mockImplementation(async (opts) => {
    const deferred = (readWakeFanoutPacing(opts.payload)?.notBeforeMs ?? 0) > Date.now() ? 1 : 0;
    return { woken: 1 - deferred, deferred } as EmitResult;
  });
  vi.mocked(knownOwnerIdSet).mockResolvedValue(null);
  vi.mocked(getOrgPg).mockReturnValue({ sql: sqlMock } as never);
});
afterEach(() => vi.clearAllMocks());

// The gate is GRADUATED off the POT_AGENT_TABS flag (start-hive-wake P-007 /
// OQ-2): it is the hive's PAUSE primitive, so it holds unconditionally — the
// resolved wake-mode alone decides fire-vs-stage. Default (everything `auto`)
// remains the shipped fire-immediately behavior.
describe('wakeRecipients wake-mode gate (hive-agent-tabs D-005, graduated by start-hive P-007)', () => {
  it('default (auto) → fires every wake, nothing staged', async () => {
    const r = await wakeRecipients(['s-1', 's-2']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(2);
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(r.woken).toBe(2);
    expect(r.staged).toBe(0);
  });

  it('recovers a missing listener before dispatching the recipient wake', async () => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValueOnce([]);

    const result = await wakeRecipients(['s-recover'], { workspaceId: 'ws-1' });

    expect(listActiveAwaitsForKey).toHaveBeenCalledWith('coord:inbox-wake:s-recover');
    expect(ensureInboxWakeArmedForActiveSession).toHaveBeenCalledWith({
      ownerId: 's-recover',
      forceRecheck: true,
      workspaceId: 'ws-1',
    });
    expect(ensureInboxWakeArmedForActiveSession).toHaveBeenCalledBefore(vi.mocked(emitAwaitedEvent));
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({ key: 'coord:inbox-wake:s-recover' }));
    expect(result.woken).toBe(1);
  });

  it('required wake records each completed fire outcome in one batched ledger write', async () => {
    vi.mocked(emitAwaitedEvent).mockImplementation(async (input: { key: string }) => ({
      woken: input.key.endsWith('s-queued') ? 1 : 0,
    }) as never);

    const r = await wakeRecipients(['s-queued', 's-missed'], {
      requiredWake: true,
      workspaceId: 'ws-1',
    });

    expect(r).toMatchObject({ woken: 1, targets: ['s-queued', 's-missed'] });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]?.slice(1)).toEqual([
      'ws-1',
      ['s-queued', 's-missed'],
      ['coord:inbox-wake:s-queued', 'coord:inbox-wake:s-missed'],
      ['queued', 'missed'],
    ]);
  });

  it('a ledger failure is fail-soft and does not turn a delivered wake into a send failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlMock.mockRejectedValueOnce(new Error('ledger unavailable'));
    try {
      const r = await wakeRecipients(['s-1'], { requiredWake: true, workspaceId: 'ws-1' });
      expect(r).toMatchObject({ woken: 1, targets: ['s-1'] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('required-wake attempt ledger write failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('EI-24053245865903237: a stalled required-wake ledger write cannot hold a successful wake response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      sqlMock.mockImplementationOnce(() => new Promise<never[]>(() => {}));
      const pending = wakeRecipients(['s-1'], { requiredWake: true, workspaceId: 'ws-1' });
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.waitFor(() => expect(sqlMock).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 10 });
      await vi.advanceTimersByTimeAsync(COORD_WAKE_TARGET_TIMEOUT_MS + 1);

      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({ woken: 1, targets: ['s-1'] });
      expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('required-wake attempt ledger write failed'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('required staged wakes do not create completed-fire evidence', async () => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    await wakeRecipients(['s-1'], { requiredWake: true, workspaceId: 'ws-1' });
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('EI-20239029846984233: a stalled roster preflight degrades before the wake transport timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.mocked(resolveBestEffortAgainstRoster).mockImplementationOnce(
        () => new Promise<string[]>(() => {}),
      );
      const pending = wakeRecipients(['s-1'], { source: 'coord:send' });
      await vi.advanceTimersByTimeAsync(COORD_WAKE_TARGET_TIMEOUT_MS + 1);
      const r = await pending;
      expect(r.targets).toEqual(['s-1']);
      expect(r.woken).toBe(1);
      expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('coord:inbox-wake:roster'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('manual → STAGES, does NOT fire (the Pause path — no flag involved)', async () => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { summary: 'hi', workspaceId: 'ws-1' });
    expect(stagePendingWake).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 's-1', summary: 'hi', workspaceId: 'ws-1' }),
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.woken).toBe(0);
    expect(r.staged).toBe(1);
    expect(r.stagedTargets).toEqual(['s-1']); // EI-5957: names WHO staged
  });

  it('mixed modes → fires auto, stages manual', async () => {
    vi.mocked(resolveWakeMode).mockImplementation(
      (async (o: string) => (o === 's-manual' ? 'manual' : 'auto')) as never,
    );
    const r = await wakeRecipients(['s-auto', 's-manual']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(r.woken).toBe(1);
    expect(r.staged).toBe(1);
    expect(r.stagedTargets).toEqual(['s-manual']); // EI-5957: only the manual one
  });

  it('a LOOP self-wake (source loop:<routineId>) FIRES even in manual mode — staging a self-wake would DEADLOCK the loop', async () => {
    // Live 2026-06-23: global default was `manual` (pot:pause), so a self-armed loop fired ~10×
    // into a manual session and every wake STAGED → the loop never executed. A loop wake is the
    // agent driving itself: the asleep agent waiting on the wake is the only one who could release
    // a staged one, so it MUST bypass the manual pause/edit gate and fire.
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { source: 'loop:rt_abc123', summary: 'loop wake' });
    expect(stagePendingWake).not.toHaveBeenCalled(); // NOT staged despite manual mode
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1); // fired instead
    expect(r.staged).toBe(0);
    expect(r.woken).toBe(1);
  });

  it('the delivery-ladder rescue wake FIRES in manual mode so the detector cannot be muted by the pause', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-1'], {
      source: 'system:delivery-ladder',
      summary: 'delivery-ladder rescue',
    });
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r.staged).toBe(0);
    expect(r.woken).toBe(1);
  });

  it('the escalation-SLA reroute wake FIRES in manual mode so its time-bound handoff is delivered', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-1'], {
      source: ESCALATION_SLA_REROUTE_WAKE_SOURCE,
      summary: 'take over unacknowledged escalation',
    });
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ woken: 1, staged: 0, stagedTargets: [] });
  });

  it('a NON-loop wake in manual mode still STAGES (the bypass is scoped to loop sources only)', async () => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { source: 'coord:send', summary: 'peer message' });
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.staged).toBe(1);
  });

  // WI-37858 (owner-reported: "the chat window opens but stays empty"). The GUI composer
  // (SessionChatModal) POSTs /api/admin/coord/send → coord:send { wake:'required' }, and the
  // admin routes pin the caller identity to ADMIN_COORD_UI_OWNER — so under a `manual` global
  // default every message the OWNER typed staged into a queue only the owner can release,
  // i.e. staged for the sender's own review. Measured: pending_wakes row 51591,
  // source='pc-admin-coord-ui'. Same deadlock shape as the self-loop case above.
  it("the OWNER's own GUI wake FIRES in manual mode — staging it queues the owner's message for the owner's own review", async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-hud-launched'], {
      source: ADMIN_COORD_UI_OWNER,
      summary: 'hello from the GUI - please reply with OK',
    });
    expect(stagePendingWake).not.toHaveBeenCalled(); // NOT staged despite manual mode
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1); // delivered instead
    expect(r.staged).toBe(0);
    expect(r.woken).toBe(1);
  });

  it('the owner-GUI bypass does NOT un-pause agent→agent wakes (an agent source still STAGES)', async () => {
    // The manual default IS the hive pause primitive; only the human's own directed send
    // escapes it. An agent whose ownerId merely CONTAINS the GUI id must not slip through.
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-1'], {
      source: `su-89beac53-${ADMIN_COORD_UI_OWNER}`,
      summary: 'peer steering wake',
    });
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.staged).toBe(1);
  });

  it('EI-21420024752195459: an owner-verified relay FIRES in manual mode instead of staging the resume for owner review', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-paused'], {
      source: 'su-relaying-agent',
      summary: 'OWNER-VERIFIED SYSTEM-WIDE RESUME',
      relayProvenance: {
        tier: 'owner-verified-turn',
        quote: 'tell all agents system-wide to resume their work',
        origin: 'owner',
      },
    });
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ woken: 1, staged: 0, stagedTargets: [] });
  });

  it('an unverified or agent-origin relay still STAGES in manual mode', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    await wakeRecipients(['s-paused'], {
      source: 'su-relaying-agent',
      relayProvenance: { tier: 'unverified', quote: 'the owner said resume', origin: 'owner' },
    });
    await wakeRecipients(['s-paused'], {
      source: 'su-relaying-agent',
      relayProvenance: { tier: 'coord-origin', quote: 'resume', origin: 'agent' },
    });
    expect(stagePendingWake).toHaveBeenCalledTimes(2);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('isOwnerGuiWakeSource is exact-match (a missing source never bypasses)', () => {
    expect(isOwnerGuiWakeSource(ADMIN_COORD_UI_OWNER)).toBe(true);
    expect(isOwnerGuiWakeSource(undefined)).toBe(false);
    expect(isOwnerGuiWakeSource('')).toBe(false);
    expect(isOwnerGuiWakeSource('pc-admin-coord-ui-x')).toBe(false);
  });

  it('isDeliveryLadderWakeSource is exact-match', () => {
    expect(isDeliveryLadderWakeSource('system:delivery-ladder')).toBe(true);
    expect(isDeliveryLadderWakeSource(undefined)).toBe(false);
    expect(isDeliveryLadderWakeSource('system:delivery-ladder-extra')).toBe(false);
  });

  it('isEscalationSlaRerouteWakeSource is exact-match', () => {
    expect(isEscalationSlaRerouteWakeSource(ESCALATION_SLA_REROUTE_WAKE_SOURCE)).toBe(true);
    expect(isEscalationSlaRerouteWakeSource(undefined)).toBe(false);
    expect(isEscalationSlaRerouteWakeSource('')).toBe(false);
    expect(isEscalationSlaRerouteWakeSource(`${ESCALATION_SLA_REROUTE_WAKE_SOURCE}:extra`)).toBe(false);
  });

  // QUARANTINED (flaky: selector resolves against live presence/session state, nondeterministic; de-quarantine + root-cause in WI-1053)
  it.skip('filters non-wakeable selectors (*/human/empty)', async () => {
    const r = await wakeRecipients(['*', 'human', '', 's-1']);
    expect(r.targets).toEqual(['s-1']);
  });

  it('fail-open: an unreadable mode store falls back to fire-immediately', async () => {
    vi.mocked(resolveWakeMode).mockRejectedValue(new Error('mode store down') as never);
    const r = await wakeRecipients(['s-1']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r.staged).toBe(0);
  });
});

// EI-9971 (coord-invariant wake-queue depth/age growth): a manual-mode target
// that matches NO known agent would stage undeletable `pending_wakes` debris
// (observed live: owner_id='B', staged 5x, source='me' — a garbage/typo'd
// coord:send recipient). Root-cause fix: skip STAGING (never firing either —
// there's nothing to protect there) for a target the roster confirms unknown,
// while a roster-unavailable/empty read (null) fails OPEN exactly as before.
describe('wakeRecipients skips staging debris for an UNKNOWN recipient (EI-9971)', () => {
  beforeEach(() => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
  });

  it('a manual-mode target NOT in the known roster is skipped — no stage, no fire, no debris', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(knownOwnerIdSet).mockResolvedValue(new Set(['su-real-agent']));
    const r = await wakeRecipients(['B'], { summary: 'phase 1 done', source: 'me' });
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.staged).toBe(0);
    expect(r.woken).toBe(0);
    expect(r.stagedTargets).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping wake-stage'));
    warnSpy.mockRestore();
  });

  it('a manual-mode target that IS in the known roster still stages normally', async () => {
    vi.mocked(knownOwnerIdSet).mockResolvedValue(new Set(['su-real-agent']));
    const r = await wakeRecipients(['su-real-agent'], { summary: 'hi' });
    expect(stagePendingWake).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-real-agent' }),
    );
    expect(r.staged).toBe(1);
    expect(r.stagedTargets).toEqual(['su-real-agent']);
  });

  it('roster UNAVAILABLE (null) fails OPEN — stages as before rather than guessing', async () => {
    vi.mocked(knownOwnerIdSet).mockResolvedValue(null);
    const r = await wakeRecipients(['whoever-1'], { summary: 'hi' });
    expect(stagePendingWake).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'whoever-1' }),
    );
    expect(r.staged).toBe(1);
  });

  it('mixed known + unknown targets: only the known one stages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(knownOwnerIdSet).mockResolvedValue(new Set(['su-known']));
    const r = await wakeRecipients(['su-known', 'garbage-id'], { summary: 'hi' });
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(stagePendingWake).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-known' }));
    expect(r.staged).toBe(1);
    expect(r.stagedTargets).toEqual(['su-known']);
    warnSpy.mockRestore();
  });

  it('auto mode is unaffected by the roster check (the skip only guards the STAGING branch)', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'auto');
    vi.mocked(knownOwnerIdSet).mockResolvedValue(new Set(['su-known']));
    const r = await wakeRecipients(['garbage-id'], { summary: 'hi' });
    // auto mode fires regardless of roster membership — firing a key nobody
    // watches is a harmless no-op (unlike staging, it leaves no debris).
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(r.woken).toBe(1);
  });
});

// P-006 / D-005: the enqueue seam cannot confirm pickup (pickupConfirmed stays the literal
// false), so it hands the sender the key the pump's pickup sweep fires when a queued wake
// was NOT picked up — built from the same catalog template the sweep emits with.
describe('wakeRecipients pickup handle (P-006 / D-005)', () => {
  it('returns one not-picked-up handle per QUEUED target, keyed exactly as the pickup sweep emits', async () => {
    mockImplementationTyped(vi.mocked(emitAwaitedEvent), async (input) => {
      const woken = input.key.endsWith(':s-quiet') ? 0 : 1;
      const result: EmitResult = { ok: true, key: input.key, woken, notified: [], msgId: null, waiters: woken };
      return result;
    });
    const r = await wakeRecipients(['s-live', 's-quiet']);
    expect(r.pickupConfirmed).toBe(false);
    expect(r.pickup).toEqual([
      { target: 's-live', event: buildKey('wake-not-picked-up', { subscriberId: 's-live' }), windowSec: 600 },
    ]);
    expect(r.pickup[0]!.event).toBe('wake:not-picked-up:s-live');
  });

  it('a staged (manual-mode) target gets no handle: nothing was queued, so nothing can expire', async () => {
    mockResolvedTyped(vi.mocked(resolveWakeMode), 'manual');
    const r = await wakeRecipients(['s-paused']);
    expect(r.staged).toBe(1);
    expect(r.pickup).toEqual([]);
  });

  it('the window follows PAPERCUSP_WAKE_PICKUP_WINDOW_SEC, the same knob the sweep reads', async () => {
    vi.stubEnv('PAPERCUSP_WAKE_PICKUP_WINDOW_SEC', '120');
    try {
      expect(wakePickupHandle('s-x').windowSec).toBe(120);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('buildStagedWakeNote (EI-5957 — loud staged-directive signal)', () => {
  it('names the staged target(s) and both remedies (release / flip to auto)', () => {
    const note = buildStagedWakeNote(['su-member-1']);
    expect(note).toContain('su-member-1');
    expect(note).toMatch(/STAGED/);
    expect(note).toMatch(/MANUAL wake-mode/);
    expect(note).toMatch(/wake-queue/); // release remedy
    expect(note).toMatch(/wake-mode/); // flip-to-auto remedy
  });

  it('lists every staged target when multiple', () => {
    const note = buildStagedWakeNote(['su-a', 'su-b']);
    expect(note).toContain('su-a, su-b');
  });
});

describe('WI-6554700010009434 — durable bulk wake pacing', () => {
  it('paces a 200-target fan-out over more than a minute without dropping overflow', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `su-agent-${i}`);
    const now = Date.now();
    const r = await wakeRecipients(many, { summary: 'resume fleet', workspaceId: 'ws-1', requiredWake: true });
    expect(r.targets).toEqual(many);
    expect(r.fanoutCapped).toEqual([]);
    expect(r.woken).toBe(5);
    expect(r.deferred).toBe(195);
    expect(r.deferredTargets).toEqual(many.slice(5));
    const schedules = vi.mocked(emitAwaitedEvent).mock.calls.map(([opts]) => readWakeFanoutPacing(opts.payload)!);
    expect(schedules.filter((p) => p.notBeforeMs <= now + 60_000).length).toBeLessThanOrEqual(15);
    expect(schedules.at(-1)!.notBeforeMs - now).toBeGreaterThan(60_000);
    expect(r.pickup).toHaveLength(5);
    // A large fan also records bounded-timeout telemetry through the same PG
    // handle. Assert the required-wake table, not the last unrelated write.
    const ledgerWrites = sqlMock.mock.calls.filter(([parts]) => Array.isArray(parts) && parts.join('').includes('event_wake_attempts'));
    expect(ledgerWrites).toEqual([
      [expect.anything(), 'ws-1', many.slice(0, 5), many.slice(0, 5).map((id) => `coord:inbox-wake:${id}`), Array(5).fill('queued')],
    ]);
  });

  it.each(['loop:rt_loop', ESCALATION_SLA_REROUTE_WAKE_SOURCE, 'system:delivery-ladder'])('keeps urgent %s wakes immediate', async (source) => {
    const r = await wakeRecipients(Array.from({ length: 20 }, (_, i) => `urgent-${i}`), { source });
    expect(r.woken).toBe(20);
    expect(r.deferred).toBe(0);
    expect(reserveWakeFanout).not.toHaveBeenCalled();
  });

  it('an owner resume of a large fleet is paced while a directed owner wake stays immediate', async () => {
    await wakeRecipients(['direct'], { source: ADMIN_COORD_UI_OWNER });
    expect(reserveWakeFanout).not.toHaveBeenCalled();
    const r = await wakeRecipients(Array.from({ length: 20 }, (_, i) => `owner-${i}`), { source: ADMIN_COORD_UI_OWNER });
    expect(r.deferred).toBe(15);
  });

  it('never fails open into a herd when PG admission is unavailable', async () => {
    vi.mocked(reserveWakeFanout).mockRejectedValueOnce(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const targets = Array.from({ length: 10 }, (_, i) => `no-db-${i}`);
      const r = await wakeRecipients(targets);
      expect(r.timedOutTargets).toEqual(targets);
      expect(r.woken).toBe(0);
      expect(emitAwaitedEvent).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('a normal directed set is untouched (fanoutCapped empty)', async () => {
    const r = await wakeRecipients(['su-a', 'su-b']);
    expect(r.fanoutCapped).toEqual([]);
    expect(r.targets).toEqual(['su-a', 'su-b']);
  });
});
