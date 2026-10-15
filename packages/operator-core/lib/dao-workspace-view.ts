/** Read composition for the DAO UI; existing stores remain authoritative. */
import type { HiveDirectoryBrowseRow } from './discovery-hive-rows';
import type { ProjectEntry } from './harness-registry';
import type { HiveRecord } from './hive-store';
import type { HiveMemberRecord } from './hive-membership-store';
import type { ResolvedHivePolicy } from './hive-policy-store';
import type { PlanAdmissionGovernanceSnapshot } from './agent-tools/plans/plan-admission-governance-store';
import type { PlanIndexRow } from './agent-tools/plans/source';
import type { DaoCapTable, DaoPerson, DaoRead, DaoWorkspaceView } from './dao-workspace-types';
export type { DaoRead, DaoWorkspaceView } from './dao-workspace-types';

export interface DaoWorkspaceDeps {
  viewerGithubId(): Promise<number | null>;
  projects(workspaceId: string): Promise<ProjectEntry[]>;
  hive(workspaceId: string, slug: string): Promise<HiveRecord | null>;
  members(workspaceId: string, slug: string): Promise<HiveMemberRecord[]>;
  policyScope(workspaceId: string, localSlug: string): Promise<string>;
  policy(workspaceId: string, slug: string): Promise<ResolvedHivePolicy | null>;
  governance(workspaceId: string, slug: string): Promise<PlanAdmissionGovernanceSnapshot>;
  plans(workspaceId: string, slug: string): Promise<PlanIndexRow[]>;
  people?(workspaceId: string, slug: string): Promise<DaoPerson[]>;
  capTable?(workspaceId: string, slug: string): Promise<DaoCapTable>;
}

const stores: DaoWorkspaceDeps = {
  viewerGithubId: async () => {
    const identity = await (await import('./identity/resolve-local-github-identity')).resolveLocalGithubIdentity();
    return identity.kind === 'ok' ? identity.githubUserId : null;
  },
  projects: async workspace => (await (await import('./harness-registry')).loadHarnessRegistry(workspace)).projects,
  hive: async (workspace, slug) => (await import('./hive-store')).getHiveBySlug(workspace, slug),
  // Resolve the owner-authored federated scope; a joiner's local slug can differ.
  members: async (workspace, slug) => (await import('./federated-pot-scope')).listHiveMembersForLocalPot(workspace, slug),
  policyScope: async (workspace, slug) => (await import('./federated-pot-scope')).resolveFederatedPotScope(workspace, slug),
  policy: async (workspace, slug) => (await import('./hive-policy-store')).getHivePolicy(workspace, slug),
  governance: async (workspaceId, potHomeSlug) => (await import('./agent-tools/plans/plan-admission-governance-store')).readPlanAdmissionGovernanceSnapshot({ workspaceId, potHomeSlug }),
  plans: async (workspaceId, harnessSlug) => (await import('./agent-tools/plans/source')).listPlanIndexRows({ workspaceId, harnessSlug, includeArchived: false, heavyFields: true }),
  people: async (workspaceId, daoSlug) => {
    const scope = await stores.policyScope(workspaceId, daoSlug);
    const signed = await stores.policy(workspaceId, scope);
    return (await import('./dao-hr/people')).readDaoPeople({ workspaceId, daoSlug, policy: signed?.policy ?? null });
  },
  capTable: async (workspaceId, daoSlug) => {
    const signed = await stores.policy(workspaceId, await stores.policyScope(workspaceId, daoSlug));
    return (await import('./dao-hr/cap-table')).readDaoCapTable({ workspaceId, daoSlug, policy: signed?.policy ?? null });
  },
};

async function read<T>(operation: () => Promise<T>): Promise<DaoRead<T>> {
  try { return { status: 'ready', value: await operation() }; }
  catch { return { status: 'error', message: 'These records could not be read. Refresh to retry.' }; }
}

export async function buildDaoWorkspaceView(
  workspaceId: string,
  directory: HiveDirectoryBrowseRow,
  deps: DaoWorkspaceDeps = stores,
): Promise<DaoWorkspaceView> {
  const projects = await deps.projects(workspaceId);
  const homes = projects.filter(project => project.harness_kind === 'hive');
  // A discovered ID is not automatically a local home slug. Bind by identity.
  const bindings = await Promise.all(homes.map(async project => ({ project, hive: await deps.hive(workspaceId, project.slug) })));
  const binding = directory.hivePubkey ? bindings.find(({ project, hive }) =>
    (hive?.pubkeyBase64 ?? project.hive_pubkey) === directory.hivePubkey) : undefined;
  if (!binding) return { directoryId: directory.potId, localHomeSlug: null, status: 'not-joined' };
  const slug = binding.project.slug;
  // A retained local checkout is not an access grant. Re-read the authenticated
  // viewer and owner-scoped roster on every request, including after offboarding.
  const access = await read(async () => {
    const viewer = await deps.viewerGithubId();
    if (viewer === null) return null;
    const members = await deps.members(workspaceId, slug);
    return members.some(member => member.githubUserId === viewer) ? members : null;
  });
  if (access.status !== 'ready' || !access.value) return {
    directoryId: directory.potId, localHomeSlug: null, status: 'not-joined', contractHomeSlug: slug,
    ...(access.status === 'error' ? { members: access } : {}),
  };
  const admittedMembers = access.value;
  const children = projects.filter(project => project.slug === slug || project.hive_slug === slug);
  const [members, policy, governance, work, people, capTable] = await Promise.all([
    read(async () => admittedMembers.map(member => ({ id: member.githubUserId, username: member.githubUsername, displayName: member.displayName, bindingStatus: member.bindingStatus, devices: member.deviceAttestations.length }))),
    read(async () => {
      const signed = await deps.policy(workspaceId, await deps.policyScope(workspaceId, slug));
      return { version: signed?.policyVersion ?? 0, membership: signed?.policy.membership ?? null, admission: signed?.policy.governance?.planAdmission ?? null, delegations: signed?.policy.governance?.signingAuthority?.delegations ?? [] };
    }),
    read(async () => {
      const snapshot = await deps.governance(workspaceId, slug);
      return { events: snapshot.events.map(event => ({ eventId: event.eventId, roundId: event.roundId, kind: event.body.kind, body: event.body })), integrityErrors: snapshot.integrityErrors, conflictedRoundIds: [...snapshot.conflictedRoundIds] };
    }),
    read(async () => Promise.all(children.map(async project => ({
      slug: project.slug, title: project.slug === slug ? directory.title : project.slug,
      plans: (await deps.plans(workspaceId, project.slug)).map(plan => ({ slug: plan.planSlug, title: plan.title ?? plan.planSlug, status: plan.status ?? 'draft', owner: plan.owner ?? null, itemCount: plan.items.length })),
    })))),
    deps.people ? read(() => deps.people!(workspaceId, slug)) : undefined,
    deps.capTable ? read(() => deps.capTable!(workspaceId, slug)) : undefined,
  ]);
  return { directoryId: directory.potId, localHomeSlug: slug, status: 'connected', members, policy, governance, projects: work, ...(people ? { people } : {}), ...(capTable ? { capTable } : {}) };
}
