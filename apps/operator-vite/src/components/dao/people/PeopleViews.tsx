import { useMemo } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import RouteLink from '@/app/_components/RouteLink';
import type { DaoPerson, DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { reportingForest, type OrgNode } from './org-chart';
import EquityViews from './EquityViews';
import HiringViews from './HiringViews';
import OnboardingViews from './OnboardingViews';
import ContractAccessViews from './ContractAccessViews';

const personKey = (person: DaoPerson) => person.personId ?? 'member:' + person.memberId;

function ReportingLines({ nodes, open }: { nodes: OrgNode[]; open: (person: DaoPerson) => void }) {
  return <ul>{nodes.map(node => <li key={node.person.memberId} aria-label={node.person.displayName + ' reporting line'}>
    <button type="button" className="dao-action" onClick={() => open(node.person)}>{node.person.displayName}</button>
    {node.person.profile ? <span> · {node.person.profile.title}</span> : null}
    {node.issue ? <p role="status">{node.issue}</p> : null}
    {node.reports.length ? <ReportingLines nodes={node.reports} open={open} /> : null}
  </li>)}</ul>;
}

export default function PeopleViews({ view, onRefresh }: { view: DaoWorkspaceView; onRefresh?: () => void }) {
  const [tab, setTab] = useQueryState('peopleTab', parseAsStringEnum(['directory', 'profile', 'org', 'cap', 'my', 'hiring', 'onboarding']).withDefault('directory'));
  const [onboardingOffer, setOnboardingOffer] = useQueryState('onboardingOffer', parseAsString.withDefault(''));
  const [selected, setSelected] = useQueryState('person', parseAsString.withDefault(''));
  const people = useMemo(() => view.people?.status === 'ready' ? view.people.value :
    view.members?.status === 'ready' ? view.members.value.map<DaoPerson>(member => ({
      memberId: member.id, personId: null, username: member.username, displayName: member.displayName || member.username,
      bindingStatus: member.bindingStatus, devices: member.devices,
      profile: null, equity: { status: 'error', message: 'Equity records are unavailable.' },
    })) : [], [view.people, view.members]);
  const person = people.find(row => personKey(row) === selected);
  const populationReady = view.people?.status === 'ready' || view.members?.status === 'ready';
  const showProfile = tab === 'profile';
  const showOrg = tab === 'org';
  const showEquity = tab === 'cap' || tab === 'my';
  const showHiring = tab === 'hiring';
  const showOnboarding = tab === 'onboarding';
  const org = useMemo(() => reportingForest(people), [people]);
  function open(row: DaoPerson) { void setSelected(personKey(row)); void setTab('profile'); }
  const columns: ColumnDef<DaoPerson>[] = [
    { key: 'person', header: 'Person', width: 2, toCopyText: row => row.displayName,
      render: ({ row }) => <button type="button" className="dao-action" onClick={() => open(row)}>{row.displayName}</button> },
    { key: 'role', header: 'Role', width: 1, toCopyText: row => row.profile?.title ?? '', render: ({ row }) => row.profile?.title ?? '—' },
    { key: 'team', header: 'Team', width: 1, toCopyText: row => row.profile?.team ?? '', render: ({ row }) => row.profile?.team ?? '—' },
    { key: 'member', header: 'Member', width: 1, toCopyText: row => row.username, render: ({ row }) => row.username },
    { key: 'binding', header: 'Membership binding', width: 1, toCopyText: row => row.bindingStatus, render: ({ row }) => row.bindingStatus },
    { key: 'devices', header: 'Bound devices', width: 1, toCopyText: row => String(row.devices), render: ({ row }) => row.devices },
  ];
  return <section className="dao-card" aria-label="People">
    <h2>People</h2>
    <div role="tablist" aria-label="People views" className="dao-actions">
      <button type="button" role="tab" aria-selected={!showProfile && !showOrg && !showEquity && !showHiring && !showOnboarding} onClick={() => { void setTab('directory'); }}>Directory</button>
      <button type="button" role="tab" aria-selected={showProfile} disabled={!selected} onClick={() => { void setTab('profile'); }}>Profile</button>
      <button type="button" role="tab" aria-selected={showOrg} onClick={() => { void setTab('org'); }}>Org chart</button>
      <button type="button" role="tab" aria-selected={tab === 'cap'} onClick={() => { void setTab('cap'); }}>Cap table</button>
      <button type="button" role="tab" aria-selected={tab === 'my'} onClick={() => { void setTab('my'); }}>My equity</button>
      <button type="button" role="tab" aria-selected={showHiring} onClick={() => { void setTab('hiring'); }}>Hiring</button>
      <button type="button" role="tab" aria-selected={showOnboarding} onClick={() => { void setTab('onboarding'); }}>Onboarding</button>
    </div>
    {view.people?.status === 'error' ? <p role="alert">{view.people.message} <button type="button" onClick={onRefresh}>Retry</button></p> :
      !view.people ? <p role="status" aria-live="polite">Work profiles are unavailable. <button type="button" onClick={onRefresh}>Refresh people</button></p> : null}
    {showOnboarding ? view.localHomeSlug ? <>
      <form className="dao-form" aria-label="Open signed offer" onSubmit={event => { event.preventDefault(); void setOnboardingOffer(String(new FormData(event.currentTarget).get('offer'))); }}>
        <label>Offer reference<input key={onboardingOffer} name="offer" defaultValue={onboardingOffer} required /></label><button type="submit">Open onboarding</button>
      </form>
      {onboardingOffer ? <OnboardingViews key={view.localHomeSlug + ':' + onboardingOffer} daoSlug={view.localHomeSlug} offerId={onboardingOffer} onChanged={onRefresh} /> : <p>Enter the offer reference from your hiring administrator.</p>}
    </> : <p>Connect to this DAO to open onboarding.</p> : showHiring ? view.localHomeSlug ? <HiringViews key={view.localHomeSlug} daoSlug={view.localHomeSlug} /> : <p>Connect to this DAO to view hiring.</p> : showEquity ? <EquityViews view={view} mine={tab === 'my'} onRefresh={onRefresh} /> : showOrg ? <section aria-label="Org chart"><h3>Reporting lines</h3>{people.length ? <ReportingLines nodes={org} open={open} /> :
      populationReady ? <p>No current members.</p> : null}</section> : !showProfile ? people.length ? <div role="table" aria-label="People directory"><RichGrid rows={people} columns={columns}
      getRowId={row => String(row.memberId)} /></div> :
      populationReady ? <p>No current members.</p> : null : person ? <article aria-label={person.displayName + ' profile'}>
      <h3>{person.displayName}</h3><p>@{person.username}</p>
      {person.profile ? <dl>
        <div><dt>Role</dt><dd>{person.profile.title}</dd></div><div><dt>Team</dt><dd>{person.profile.team ?? 'Not recorded'}</dd></div>
        <div><dt>Level</dt><dd>{person.profile.level ?? 'Not recorded'}</dd></div>
        <div><dt>Engagement</dt><dd>{person.profile.engagementType}</dd></div><div><dt>Jurisdiction</dt><dd>{person.profile.jurisdiction}</dd></div>
        <div><dt>Start date</dt><dd>{person.profile.startDate ?? 'Not recorded'}</dd></div>
      </dl> : <p>{view.people?.status === 'ready' ? 'No work profile recorded.' : 'Work profile is unavailable.'}</p>}
      <h3>Equity</h3>{person.equity.status === 'ready' ? <dl>
        <div><dt>Shares owned</dt><dd>{person.equity.value.shares}</dd></div>
        <div><dt>Ownership</dt><dd>{person.equity.value.ownershipPercent}%</dd></div>
      </dl> : <p>{person.equity.message}</p>}
      {'pay' in person ? <><h3>Pay terms</h3>{person.pay ? <p>{person.pay.amount} {person.pay.currency} · {person.pay.cadence}</p> : <p>No pay terms recorded.</p>}</> : null}
      {view.localHomeSlug?<ContractAccessViews key={view.localHomeSlug+':'+selected} daoSlug={view.localHomeSlug} onChanged={onRefresh} />:null}
    </article> : <p>The selected person is not a current member of this organization.</p>}
    {view.localHomeSlug ? <RouteLink className="dao-action" href={'/adv?slug=' + encodeURIComponent(view.localHomeSlug) + '&tab=harnesses'}>Open contributor work</RouteLink> : null}
  </section>;
}
