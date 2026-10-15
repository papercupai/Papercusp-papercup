import type { DaoWorkspaceView, DaoRead } from '@papercusp/operator-core/lib/dao-workspace-types';
import RouteLink from '@/app/_components/RouteLink';
import type { DaoSection } from './dao-navigation';
import DaoGovernance from './DaoGovernance';
import DaoPolicyEditor from './DaoPolicyEditor';
import DaoFinance from './DaoFinance';
import DaoExecution from './DaoExecution';
import PeopleViews from './people/PeopleViews';
import ContractAccessViews from './people/ContractAccessViews';

function ReadState({ read }: { read: DaoRead<unknown> | undefined }) {
  return read?.status === 'error' ? <p role="alert">{read.message}</p> : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default function DaoWorkspaceDetails({ section, view, loading, error, onChanged }: { section: DaoSection; view: DaoWorkspaceView | null; loading: boolean; error: string; onChanged?: () => void }) {
  if (loading) return <p role="status">Loading organization records…</p>;
  if (error) return <div className="dao-notice" role="alert">{error}</div>;
  if (!view || view.status === 'not-joined') return <section className="dao-card"><h2>Connect to this DAO</h2><p>Join its published projects to access organization records. Directory discovery alone does not grant membership or voting rights.</p>
    <ReadState read={view?.members} />{view?.contractHomeSlug?<ContractAccessViews key={view.contractHomeSlug} daoSlug={view.contractHomeSlug} onChanged={onChanged} />:null}</section>;
  const projects = view.projects?.status === 'ready' ? view.projects.value : [];
  const governance = view.governance?.status === 'ready' ? view.governance.value : null;
  const policy = view.policy?.status === 'ready' ? view.policy.value : null;
  const policyAvailable = view.policy?.status === 'ready';
  const rounds = governance?.events.filter(event => event.kind === 'round-open') ?? [];
  const operations = '/adv?slug=' + encodeURIComponent(view.localHomeSlug!);

  if (section === 'reputation' || section === 'work' || section === 'jobs' || section === 'inbox') return <><ReadState read={view.projects} /><DaoExecution key={view.directoryId} view={view} section={section} /></>;

  if (section === 'members') return <><ReadState read={view.members} /><PeopleViews view={view} onRefresh={onChanged} /></>;

  if (['proposals', 'vote', 'delegation', 'records'].includes(section)) return <div className="dao-overview-grid">
    {section === 'delegation' ? <DaoPolicyEditor view={view} onChanged={onChanged} /> : null}
    {section === 'proposals' || section === 'vote' ? <DaoGovernance key={view.directoryId} view={view} onChanged={onChanged} /> : null}
    <section className="dao-card dao-purpose"><h2>{section === 'delegation' ? 'Vote delegation policy' : 'Plan admission decisions'}</h2><ReadState read={view.governance} /><ReadState read={view.policy} />
      {governance?.integrityErrors.length ? <div role="alert" className="dao-notice">Some governance records could not be verified against the current policy. They cannot authorize decisions.<ul>{governance.integrityErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></div> : null}
      {section === 'delegation' ? <>
        <p>Delegations are bound to the organization’s signed policy and voter key epochs.</p>
        {policyAvailable ? <details><summary>Review recorded delegation rules</summary><pre>{JSON.stringify(policy?.delegations ?? [], null, 2)}</pre></details> : <p>Delegation rules are unavailable.</p>}
      </> : rounds.length ? <div className="dao-decision-list">{rounds.map(event => {
        const round = record(record(event.body).round);
        const ballots = governance!.events.filter(ballot => ballot.roundId === event.roundId && ballot.kind === 'vote');
        const conflicted = governance!.conflictedRoundIds.includes(event.roundId);
        return <article key={event.eventId}><span className="dao-badge">{conflicted ? 'Conflicting evidence' : 'Signed round'}</span><h3>{event.roundId}</h3>
          <p>Revision: <code>{String(round.planRevisionHash ?? 'unavailable')}</code></p><p>{ballots.length} recorded ballot events</p>
          <details><summary>Review exact decision evidence</summary><pre>{JSON.stringify(event.body, null, 2)}</pre></details>
        </article>;
      })}</div> : governance ? <p>No verified plan-admission rounds have been recorded.</p> : null}
      <RouteLink className="dao-action" href={operations + '&tab=plans'}>Open proposal and plan workspace</RouteLink>
    </section>
    <section className="dao-card"><h2>Governance policy</h2><p>{policyAvailable ? (policy?.version ? 'Policy version ' + policy.version : 'No policy recorded') : 'Policy unavailable'}</p><p>Admission: {policyAvailable ? policy?.membership ?? 'not configured' : 'unavailable'}</p>
      {policyAvailable ? <details><summary>Review admission thresholds</summary><pre>{JSON.stringify(policy?.admission ?? null, null, 2)}</pre></details> : null}
      <p>Plan admission does not authorize treasury transfers or ownership votes.</p>
    </section>
  </div>;

  if (section === 'settings') return <><DaoPolicyEditor view={view} onChanged={onChanged} /><section className="dao-card"><h2>Organization configuration</h2><p>Local organization home: <code>{view.localHomeSlug}</code></p><p>Membership mode: {policyAvailable ? policy?.membership ?? 'not configured' : 'unavailable'}</p><p>Policy version: {policyAvailable ? policy?.version || 'not configured' : 'unavailable'}</p><ReadState read={view.policy} />
    <div className="dao-actions"><RouteLink className="dao-action" href={operations + '&tab=settings'}>Open organization settings</RouteLink><RouteLink className="dao-action" href="/dao">Prepare legal entity and governance</RouteLink></div>
  </section></>;

  if (section === 'marketplace') return <section className="dao-card"><h2>Organization capabilities</h2><p>Browse maintained apps, tools and capabilities. Purchases retain the existing organization membership, seat and payment checks.</p><RouteLink className="dao-action" href="/cupboard">Browse marketplace</RouteLink></section>;

  return <DaoFinance key={view.directoryId} view={view} section={section} onChanged={onChanged} />;
}
