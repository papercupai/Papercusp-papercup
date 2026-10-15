/**
 * severe-event-owner.test.ts — EI-10060 Phase 1 (P-001).
 * Pure function, no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { resolveSevereEventOwner } from './severe-event-owner';

describe('resolveSevereEventOwner', () => {
  it('routes hosted availability incidents to the stable operational responder without capturing similar names', () => {
    expect(resolveSevereEventOwner('hosted-control-plane-degraded')).toMatchObject({
      ownerSelector: '@role:mug', source: 'registry', reason: expect.stringContaining('workspace-host controller'),
    });
    expect(resolveSevereEventOwner('hosted-control-plane-degraded:install')).toMatchObject({ ownerSelector: '@role:mug' });
    expect(resolveSevereEventOwner('hosted-control-plane-degraded-lookalike')).toBeNull();
  });
  it('resolves an EXACT registry match to its registered owner', () => {
    const r = resolveSevereEventOwner('health-tick-stale');
    expect(r).toMatchObject({ ownerSelector: '@role:mug', source: 'registry' });
  });

  it('resolves a SUFFIXED key (class:detail) to its prefix-registered owner', () => {
    const r = resolveSevereEventOwner('health-tick-stale:papercusp');
    expect(r).toMatchObject({ ownerSelector: '@role:mug', source: 'registry' });
  });

  it('a DIFFERENT prefix that merely starts with the same letters does NOT match', () => {
    // 'health-tick-stale-ish' is not the registered class 'health-tick-stale' and
    // is not suffixed with ':' either — must not false-positive.
    const r = resolveSevereEventOwner('health-tick-stale-ish', {});
    expect(r).toBeNull();
  });

  it('falls back to the fleet leader when the caller names a fleetSlug and no registry entry matches', () => {
    const r = resolveSevereEventOwner('some-unregistered-condition', { fleetSlug: 'backlog-drain' });
    expect(r).toMatchObject({ ownerSelector: '@fleet-leader:backlog-drain', source: 'fleet-leader' });
  });

  it('the registry wins over a supplied fleetSlug (a known class always routes to its registered owner)', () => {
    const r = resolveSevereEventOwner('dead-routines:papercusp', { fleetSlug: 'backlog-drain' });
    expect(r).toMatchObject({ ownerSelector: '@role:mug', source: 'registry' });
  });

  it('returns null when unregistered and no fleetSlug is supplied — the "escalate to human" signal', () => {
    expect(resolveSevereEventOwner('some-unregistered-condition')).toBeNull();
    expect(resolveSevereEventOwner('some-unregistered-condition', { fleetSlug: null })).toBeNull();
    expect(resolveSevereEventOwner('some-unregistered-condition', { fleetSlug: '' })).toBeNull();
  });

  it('returns null for an empty/blank condition key', () => {
    expect(resolveSevereEventOwner('')).toBeNull();
    expect(resolveSevereEventOwner('   ')).toBeNull();
  });
});
