import { describe, expect, it } from 'vitest';
import { hostCarryFenceBindable, PENDING_CARRY_FENCE_CAP } from './carry-fence-bindable';

// EI-27053660657887116: a nonce-bound carry is admitted by the host only when
// every fence identity field is non-empty (psu-carry-fence.mjs
// carryFenceIdentityMatches). A Claude host advertises the cap but has no native
// session id, so binding there guarantees a 'stale-carry-target' refusal.
describe('hostCarryFenceBindable', () => {
  const bindable = {
    caps: ['carry-respawn', PENDING_CARRY_FENCE_CAP],
    nativeSessionId: '019a0000-0000-7000-8000-000000000001',
    hostCodeVersion: '032905864641b79ebf0970a0c87d2287e5e4c389fa9f466e32d85241b64439c5',
    advSessionId: 52768,
    startedAt: 1_793_000_507_733,
    childGeneration: 5,
  };

  it('is true only when the cap is advertised AND every fence identity field is present', () => {
    expect(hostCarryFenceBindable(bindable)).toBe(true);
  });

  it('is false for a fence-capable host with no native session id (every Claude host)', () => {
    expect(hostCarryFenceBindable({ ...bindable, nativeSessionId: undefined })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, nativeSessionId: null })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, nativeSessionId: '' })).toBe(false);
  });

  it('is false when the host does not advertise the fence cap', () => {
    expect(hostCarryFenceBindable({ ...bindable, caps: ['carry-respawn'] })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, caps: undefined })).toBe(false);
  });

  it('is false when any other identity field would fail the host check', () => {
    expect(hostCarryFenceBindable({ ...bindable, hostCodeVersion: null })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, advSessionId: null })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, startedAt: 0 })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, childGeneration: 0 })).toBe(false);
    expect(hostCarryFenceBindable({ ...bindable, nativeSessionId: ' padded ' })).toBe(false);
  });

  it('is false for an absent host', () => {
    expect(hostCarryFenceBindable(null)).toBe(false);
    expect(hostCarryFenceBindable(undefined)).toBe(false);
  });
});
