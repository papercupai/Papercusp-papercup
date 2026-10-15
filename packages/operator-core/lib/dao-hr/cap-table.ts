import { getOrgPg } from '@papercusp/db-org';
import type { HivePolicy } from '../hive-policy-schema';
import type { DaoCapTable } from '../dao-workspace-types';
import { readDaoEquityCapTable } from '../dao-finance';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { listHiveMembersForLocalPot } from '../federated-pot-scope';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { getIssuingEntity } from './contract-templates';
import { listWorkProfiles } from './work-profile';
import type { PeopleDeps } from './people';
import type { EquityCapTable } from '../equity/cap-table';

/** Public to every member. Pay never enters this projection; self comes from the
 * server identity resolver and the already-verified wallet/person link. */
export async function readDaoCapTable(key: { workspaceId: string; daoSlug: string; policy: HivePolicy | null },
  deps: PeopleDeps & { inspectCapTable?: (policy: HivePolicy) => Promise<EquityCapTable> } = {}): Promise<DaoCapTable> {
  if (!key.policy?.finance?.equity) throw new Error('No owner-signed equity deployment is bound.');
  const sql = deps.sql ?? getOrgPg().sql;
  const [table, profiles, entity, members, viewer] = await Promise.all([
    (deps.inspectCapTable ?? readDaoEquityCapTable)(key.policy), listWorkProfiles(key, { sql }), getIssuingEntity(key, { sql }),
    (deps.members ?? listHiveMembersForLocalPot)(key.workspaceId, key.daoSlug),
    deps.viewerGithubId ? deps.viewerGithubId() : resolveLocalGithubIdentity().then(id => id.kind === 'ok' ? id.githubUserId : null),
  ]);
  if (table.chainId !== key.policy.finance.equity.chainId) throw new Error('Cap table read used another chain.');
  const byWallet = new Map(profiles.filter(p => p.wallet?.chainId === table.chainId).map(p => [p.wallet!.address.toLowerCase(), p]));
  const positions = await Promise.all(table.positions.map(async position => {
    const profile = byWallet.get(position.wallet.toLowerCase());
    const person = profile ? await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, profile.personId) : null;
    return { ...position, personId: person?.id ?? null, displayName: person?.title || position.wallet,
      isSelf: !!person && viewer !== null && profile?.memberGithubUserId === viewer && members.some(m => m.githubUserId === viewer) };
  }));
  return { ...table, positions, nonBinding: !entity };
}
