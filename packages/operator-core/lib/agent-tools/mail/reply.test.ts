import { describe, expect, it } from 'vitest';
import mailReply, { mailPersonalAccessRefusal } from './reply';

describe('mail:reply personal authorization refusal', () => {
  it('does not present owner-directed AUTO as a Gmail grant or a draft bypass', () => {
    expect(mailPersonalAccessRefusal('no_live_grant')).toEqual({
      allowed: false,
      refusal: 'no_live_grant',
      requiredScope: 'personal:mail',
      autoAuthoritySufficient: false,
      draftAvailable: false,
      guidance:
        'Owner-directed AUTO authorizes execution posture but is not a personal-vault grant. ' +
        'Establish a live principal-bound personal:mail grant first; both draft and send modes require it.',
    });
  });

  it('accepts the sourceId minted by personal:search for account-safe routing', () => {
    const shape = (mailReply.args as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain('sourceId');
    expect(mailReply.guidance?.when).toContain('sourceId');
  });
});
