/** DAO HR P-009: member-backed directory with server-side pay visibility. */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { HiveMemberRecord } from '../hive-membership-store';
import type { HivePolicy } from '../hive-policy-schema';
import type { DaoPerson, DaoPersonEquity, DaoRead } from '../dao-workspace-types';
import { listHiveMembersForLocalPot } from '../federated-pot-scope';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { readDaoMemberEquity } from '../dao-finance';
import { isDaoHrAdmin } from './contract-templates';
import { listWorkProfiles, type WorkProfile } from './work-profile';

export interface PeopleDeps {
  sql?: Sql;
  members?: (workspaceId: string, daoSlug: string) => Promise<HiveMemberRecord[]>;
  /** Trusted server identity resolver; never taken from a URL or request body. */
  viewerGithubId?: () => Promise<number | null>;
  inspectEquity?: (policy: HivePolicy, holder: string) => Promise<unknown>;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Validate the existing chain inspection before reducing it to the profile's public fields. */
export function projectPersonEquity(inspection: unknown, wallet: string): DaoPersonEquity {
  const value = object(inspection);
  const holder = object(value.holder);
  if (value.governanceBound !== true || value.supplyInvariant !== true) throw new Error('Equity integrity checks failed.');
  if (typeof holder.wallet !== 'string' || holder.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('Equity holder differs from the verified wallet.');
  if (!Number.isSafeInteger(value.chainId) || Number(value.chainId) < 1) throw new Error('Equity chain is unavailable.');
  const shares = holder.balance;
  const supply = value.issuedShares;
  if (typeof shares !== 'string' || !/^\d+$/.test(shares) || typeof supply !== 'string' || !/^\d+$/.test(supply)) throw new Error('Equity balances are unavailable.');
  const bps = BigInt(supply) === 0n ? 0n : BigInt(shares) * 10_000n / BigInt(supply);
  return { wallet: holder.wallet, chainId: Number(value.chainId), shares, issuedShares: supply,
    ownershipPercent: `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}` };
}

async function memberEquity(profile: WorkProfile | undefined, policy: HivePolicy | null, deps: PeopleDeps): Promise<DaoRead<DaoPersonEquity>> {
  if (!profile?.wallet) return { status: 'error', message: 'No verified wallet is linked to this member.' };
  if (!policy?.finance?.equity) return { status: 'error', message: 'No owner-signed equity deployment is bound.' };
  if (profile.wallet.chainId !== policy.finance.equity.chainId) return { status: 'error', message: 'The verified wallet is on another chain.' };
  try {
    const inspected = await (deps.inspectEquity ?? readDaoMemberEquity)(policy, profile.wallet.address);
    const value = projectPersonEquity(inspected, profile.wallet.address);
    if (value.chainId !== profile.wallet.chainId) throw new Error('Equity read used another chain.');
    return { status: 'ready', value };
  } catch { return { status: 'error', message: 'Equity records could not be read. Refresh to retry.' }; }
}

export async function readDaoPeople(
  key: { workspaceId: string; daoSlug: string; policy: HivePolicy | null },
  deps: PeopleDeps = {},
): Promise<DaoPerson[]> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [members, profiles, viewer] = await Promise.all([
    (deps.members ?? listHiveMembersForLocalPot)(key.workspaceId, key.daoSlug),
    listWorkProfiles(key, { sql }),
    deps.viewerGithubId ? deps.viewerGithubId() : resolveLocalGithubIdentity().then(id => id.kind === 'ok' ? id.githubUserId : null),
  ]);
  const byMember = new Map(profiles.filter(p => p.memberGithubUserId !== null).map(p => [p.memberGithubUserId!, p]));
  const viewerProfile = members.some(m => m.githubUserId === viewer) && viewer !== null ? byMember.get(viewer) : undefined;
  const admin = viewerProfile ? await isDaoHrAdmin({ ...key, personId: viewerProfile.personId }, { sql }) : false;
  // Membership is the population. An unlinked candidate profile cannot add a row,
  // and an admitted member without any work profile cannot disappear.
  return Promise.all(members.map(async member => {
    const profile = byMember.get(member.githubUserId);
    const person = profile ? await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, profile.personId) : null;
    const validProfile = person ? profile : undefined;
    const result: DaoPerson = {
      memberId: member.githubUserId, personId: person?.id ?? null, username: member.githubUsername,
      displayName: person?.title || member.displayName || member.githubUsername,
      bindingStatus: member.bindingStatus, devices: member.deviceAttestations.length,
      profile: validProfile ? { title: validProfile.title, team: validProfile.team, managerPersonId: validProfile.managerPersonId,
        level: validProfile.level, startDate: validProfile.startDate, engagementType: validProfile.engagementType,
        jurisdiction: validProfile.jurisdiction, status: validProfile.status } : null,
      equity: await memberEquity(validProfile, key.policy, deps),
    };
    // Enumerate the public profile fields above. Never spread a raw WorkProfile:
    // doing so would send pay to another member before the UI could hide it.
    if (validProfile && (admin || viewer === member.githubUserId)) result.pay = validProfile.pay;
    return result;
  }));
}
