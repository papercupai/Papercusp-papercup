import { describe, expect, it } from 'vitest';
import { closeControlServerForRebind, controlSocketProbeOutcome, controlSocketSelfHealAction, decodeControl } from '../psu-pty-host.mjs';

describe('psu-pty-host control socket probe', () => {
  it('decodes an owner-bound no-op probe and rejects a different owner', () => {
    const message = decodeControl(JSON.stringify({
      v: 1,
      mode: 'probe',
      data: '',
      ownerId: 'su-probe-owner',
    }));

    expect(message).toMatchObject({
      mode: 'probe',
      gated: false,
      ownerId: 'su-probe-owner',
    });
    expect(controlSocketProbeOutcome(message, 'su-probe-owner')).toEqual({
      ok: true,
      reason: 'control-socket-live',
    });
    expect(controlSocketProbeOutcome(message, 'su-other-owner')).toEqual({
      ok: false,
      reason: 'ownerId-mismatch',
    });
    expect(controlSocketProbeOutcome({ ...message, mode: 'turn' }, 'su-probe-owner')).toBeNull();
  });

  it('rebinds when the socket path exists but its server is not listening', () => {
    expect(controlSocketSelfHealAction({ metaMine: true, sockOnDisk: true, serverListening: false })).toBe('rebind');
    expect(controlSocketSelfHealAction({ metaMine: true, sockOnDisk: true, serverListening: true })).toBe('healthy');

    let closeCalls = 0;
    let rebindCalls = 0;
    closeControlServerForRebind({
      listening: false,
      close: () => { closeCalls += 1; },
    }, () => { rebindCalls += 1; });
    expect(closeCalls).toBe(0);
    expect(rebindCalls).toBe(1);
  });
});
