/**
 * WI-6554700010011967: fleet:member-quota-starved:<slug> — the leader-facing form of
 * the psu pty host's quota-block starvation verdict.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildKey, EVENT_CATALOG } from './events/await/catalog';
import {
  emitFleetMemberQuotaStarvedEvent,
  fleetTransitionKey,
  type FleetMemberQuotaStarvation,
} from './fleet-transition-events';

const SIGNAL: FleetMemberQuotaStarvation = {
  blockedSinceMs: 1_000,
  ageMs: 7 * 60_000,
  thresholdMs: 5 * 60_000,
  attemptedGatedInjections: 3,
  successfulGatedInjections: 0,
  agent: 'claude',
  accountId: 'acct-max-2',
};

describe('emitFleetMemberQuotaStarvedEvent', () => {
  it('fires fleet:member-quota-starved:<slug> with the member, account and episode in the payload', async () => {
    const emit = vi.fn(async () => ({}));
    const ok = await emitFleetMemberQuotaStarvedEvent('enterprise-readiness', 'su-a', SIGNAL, {
      emit: emit as never,
    });
    expect(ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = (emit.mock.calls[0] as unknown[])[0] as {
      key: string;
      summary: string;
      payload: Record<string, unknown>;
      source: string;
    };
    expect(arg.key).toBe('fleet:member-quota-starved:enterprise-readiness');
    expect(arg.source).toBe('fleet');
    expect(arg.payload).toMatchObject({
      fleetSlug: 'enterprise-readiness',
      transition: 'member-quota-starved',
      agentId: 'su-a',
      accountId: 'acct-max-2',
      agent: 'claude',
      ageMs: 7 * 60_000,
      attemptedGatedInjections: 3,
    });
    expect(arg.summary).toContain('su-a is quota-blocked for 7m with 3 undelivered wake(s)');
  });

  it('builds the same key as the catalog template and the module key helper', () => {
    expect(buildKey('fleet-member-quota-starved', { slug: 's1' })).toBe(
      fleetTransitionKey('s1', 'member-quota-starved'),
    );
    const entry = EVENT_CATALOG.find((e) => e.family === 'fleet-member-quota-starved');
    expect(entry?.keyTemplate).toBe('fleet:member-quota-starved:<slug>');
    expect(entry?.exists).toBe(true);
  });

  it('fires nothing for a member outside any fleet', async () => {
    const emit = vi.fn(async () => ({}));
    expect(await emitFleetMemberQuotaStarvedEvent(null, 'su-a', SIGNAL, { emit: emit as never })).toBe(false);
    expect(await emitFleetMemberQuotaStarvedEvent('s1', '', SIGNAL, { emit: emit as never })).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('resolves false instead of rejecting when the emit fails', async () => {
    const emit = vi.fn(async () => {
      throw new Error('relation "event_key_fires" does not exist');
    });
    await expect(
      emitFleetMemberQuotaStarvedEvent('s1', 'su-a', SIGNAL, { emit: emit as never }),
    ).resolves.toBe(false);
  });

  it('omits the duration when the host did not report one', async () => {
    const emit = vi.fn(async () => ({}));
    await emitFleetMemberQuotaStarvedEvent('s1', 'su-a', { ...SIGNAL, ageMs: null, attemptedGatedInjections: null }, {
      emit: emit as never,
    });
    const arg = (emit.mock.calls[0] as unknown[])[0] as { summary: string };
    expect(arg.summary).toContain('su-a is quota-blocked with 0 undelivered wake(s)');
  });
});
