import { describe, expect, it } from 'vitest';
import { controlSocketProbeOutcome, decodeControl } from '../psu-pty-host.mjs';

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
});
