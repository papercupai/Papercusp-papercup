import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveHiveMemberDeviceSet,
  invalidateHiveMemberDeviceSet,
  _clearHiveMemberDeviceSetCacheForTest,
  MEMBER_SET_TTL_MS,
  resolveGithubIdentityForDevicePubkey,
  resolveGithubUserIdForDevicePubkey,
} from './hive-member-identity-set';
import type { listHiveMembers } from '../../hive-membership-store';
// EI-18777176681958978: the `loadMembers` seam now takes a LOCAL pot handle and resolves the
// federated read scope itself, so a stub must match THAT signature (a stub demanding the
// branded scope is correctly rejected as too narrow for the seam).
import type { listHiveMembersForLocalPot } from '../../federated-pot-scope';

/**
 * Hermetic — no PG. Inject a fake listHiveMembers (the federated hive_members read) +
 * a fake clock. The load-bearing property: the per-op apply path gets a CHEAP, FRESH
 * member-identity set — cached, invalidated on join/leave, TTL-backstopped.
 */
type Members = Awaited<ReturnType<typeof listHiveMembers>>;
function fakeMembers(
  rows: Array<Array<{ device_pubkey: string }>>,
): typeof listHiveMembersForLocalPot {
  return (async () =>
    rows.map((atts) => ({
      deviceAttestations: atts,
    }))) as unknown as typeof listHiveMembersForLocalPot;
}

beforeEach(() => _clearHiveMemberDeviceSetCacheForTest());

describe('receiver device-to-user authority', () => {
  function member(uid: number, login: string, device = 'device') {
    return { githubUserId: uid, githubUsername: login, deviceAttestations: [{ device_pubkey: device }],
      revokedPubkeys: [] as string[] } as unknown as Members[number];
  }

  it('resolves both user attributes from the current roster and sees revocation without a TTL', async () => {
    let rows = [member(42, 'alice')];
    const loadMembers = vi.fn(async () => rows);
    expect(await resolveGithubIdentityForDevicePubkey('w', 'h', 'device', undefined, { loadMembers }))
      .toEqual({ githubUserId: 42, githubUsername: 'alice' });
    rows = [{ ...rows[0]!, revokedPubkeys: ['device'] }];
    expect(await resolveGithubUserIdForDevicePubkey('w', 'h', 'device', undefined, { loadMembers })).toBeNull();
    expect(loadMembers).toHaveBeenCalledTimes(2);
  });

  it.each([
    [member(42, 'alice'), member(77, 'bob')],
    [member(42, 'alice'), member(42, 'other-login')],
    [member(0, 'alice')],
    [member(42, '')],
    [member(42, 'alice', 'other-device')],
  ])('refuses ambiguous, invalid or absent device ownership (%#)', async (...rows) => {
    const loadMembers = async () => rows;
    expect(await resolveGithubIdentityForDevicePubkey('w', 'h', 'device', undefined, { loadMembers })).toBeNull();
  });

  it('propagates a failed roster read so a policy pass can retry without advancing', async () => {
    const loadMembers = async () => { throw new Error('roster unavailable'); };
    await expect(resolveGithubIdentityForDevicePubkey('w', 'h', 'device', undefined, { loadMembers }))
      .rejects.toThrow('roster unavailable');
  });
});

describe('resolveHiveMemberDeviceSet', () => {
  it('extracts every member device pubkey — deduped union across members + multi-device', async () => {
    const loadMembers = fakeMembers([
      [{ device_pubkey: 'A1' }, { device_pubkey: 'A2' }], // member A: 2 devices
      [{ device_pubkey: 'B1' }], // member B
      [{ device_pubkey: 'A1' }], // a duplicate of A1
    ]);
    const set = await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    expect([...set].sort()).toEqual(['A1', 'A2', 'B1']);
  });

  it('CACHES within the TTL — a second call does not re-read hive_members', async () => {
    const loadMembers = vi.fn(fakeMembers([[{ device_pubkey: 'A1' }]]));
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    expect(loadMembers).toHaveBeenCalledTimes(1); // cached — cheap on the apply path
  });

  it('invalidate (the join/leave fast path) clears the cache → next call re-reads', async () => {
    const loadMembers = vi.fn(fakeMembers([[{ device_pubkey: 'A1' }]]));
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    invalidateHiveMemberDeviceSet('w', 'hive');
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    expect(loadMembers).toHaveBeenCalledTimes(2); // re-read after a membership change
  });

  it('TTL BACKSTOP — re-reads after the TTL even with NO explicit invalidate (a missed invalidation self-heals)', async () => {
    const loadMembers = vi.fn(fakeMembers([[{ device_pubkey: 'A1' }]]));
    let t = 1_000;
    const now = () => t;
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers, now });
    expect(loadMembers).toHaveBeenCalledTimes(1);
    t += MEMBER_SET_TTL_MS; // exactly at expiry (expiresAt > now is false)
    await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers, now });
    expect(loadMembers).toHaveBeenCalledTimes(2); // TTL elapsed → fresh read
  });

  it('separate (workspace, hive) keys never collide', async () => {
    const loadA = vi.fn(fakeMembers([[{ device_pubkey: 'A1' }]]));
    const loadB = vi.fn(fakeMembers([[{ device_pubkey: 'B1' }]]));
    const setA = await resolveHiveMemberDeviceSet('w', 'hiveA', undefined, { loadMembers: loadA });
    const setB = await resolveHiveMemberDeviceSet('w', 'hiveB', undefined, { loadMembers: loadB });
    expect([...setA]).toEqual(['A1']);
    expect([...setB]).toEqual(['B1']);
  });

  it('skips empty / non-string device_pubkey entries', async () => {
    const loadMembers = fakeMembers([
      [{ device_pubkey: '' }, { device_pubkey: 'A1' }],
    ]);
    const set = await resolveHiveMemberDeviceSet('w', 'hive', undefined, { loadMembers });
    expect([...set]).toEqual(['A1']);
  });
});
