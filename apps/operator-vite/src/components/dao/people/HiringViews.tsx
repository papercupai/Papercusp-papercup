import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import ContractSigningViews from './ContractSigningViews';
import OnboardingViews from './OnboardingViews';
import EngagementViews from './EngagementViews';

const cadences = ['hourly','weekly','biweekly','monthly','annual','per-milestone'];
const engagementOptions = [{ value: 'employee', label: 'Employee' }, { value: 'contractor', label: 'Contractor' }];
/** The shared Select drops empty-value options, so "no manager" needs a non-empty sentinel to stay re-selectable. */
const NO_MANAGER = '__no-manager__';
const states: Record<string, string> = { offered: 'Awaiting internal approval', approved: 'Approved for contract', 'contract-generated': 'Awaiting signatures', signed: 'Signed; awaiting hire vote', 'hire-proposed': 'Hire vote open', hired: 'Hired', rejected: 'Rejected', lapsed: 'Lapsed' };
type Offer = HiringView['offers'][number];
type Role = HiringView['roles'][number];

export default function HiringViews({ daoSlug }: { daoSlug: string }) {
  const [data, setData] = useState<HiringView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [roleId, setRoleId] = useQueryState('hiringRole', parseAsString.withDefault(''));
  const [offerId, setOfferId] = useQueryState('hiringOffer', parseAsString.withDefault(''));
  const generation = useRef(0);
  // Form selections are controlled (shared Select/Checkbox primitives do not take part in FormData).
  const [managerId, setManagerId] = useState('');
  const [exclusive, setExclusive] = useState(false);
  const [candidateId, setCandidateId] = useState('');
  const [offerPersonId, setOfferPersonId] = useState('');
  const [engagementType, setEngagementType] = useState('employee');
  const [cadence, setCadence] = useState('monthly');
  const url = '/api/pot/' + encodeURIComponent(daoSlug) + '/hiring';
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const response = await fetch(url);
      const result = await response.json();
      if (!response.ok || !result.ok || !result.hiring) throw new Error(result.message || 'Hiring records could not be read.');
      if (request === generation.current) setData(result.hiring);
    } catch (cause) { if (request === generation.current) { setData(null); setError(cause instanceof Error ? cause.message : 'Hiring records could not be read.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [url]);
  useEffect(() => { setData(null); void load(); return () => { generation.current++; }; }, [load]);
  async function action(payload: unknown) {
    setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'The hiring action was refused.');
      await load();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The hiring action was refused.'); return false; }
    finally { setBusy(false); }
  }
  if (loading && !data) return <p role="status" aria-live="polite">Loading hiring records…</p>;
  if (!data) return <div role="alert"><p>{error || 'Hiring records are unavailable.'}</p><button type="button" onClick={() => void load()}>Retry</button></div>;
  const role = data.roles.find(r => r.roleId === roleId);
  const offer = data.offers.find(o => o.offerId === offerId);
  const name = (id: string) => data.people.find(p => p.personId === id)?.displayName ?? id;
  const roleColumns: ColumnDef<Role>[] = [
    { key: 'title', header: 'Role', width: 2, toCopyText: row => row.title, render: ({ row }) => <button type="button" onClick={() => void setRoleId(row.roleId)}>{row.title}</button> },
    { key: 'level', header: 'Level', width: 1, toCopyText: row => row.level, render: ({ row }) => row.level },
    { key: 'candidates', header: 'Candidates', width: 1, toCopyText: row => String(row.candidates.length), render: ({ row }) => row.candidates.length },
  ];
  const offerColumns: ColumnDef<Offer>[] = [
    { key: 'person', header: 'Candidate', width: 2, toCopyText: row => name(row.personId), render: ({ row }) => <button type="button" onClick={() => void setOfferId(row.offerId)}>{name(row.personId)}</button> },
    { key: 'state', header: 'Stage', width: 2, toCopyText: row => states[row.state], render: ({ row }) => states[row.state] },
    { key: 'equity', header: 'Equity preview', width: 2, toCopyText: row => String(row.terms.equity.shares), render: ({ row }) => <>{row.terms.equity.shares} shares · {row.preview ? row.preview.fullyDilutedPercent + '% fully diluted' : 'Percentage unavailable'}</> },
    { key: 'pay', header: 'Regular pay', width: 2, toCopyText: row => row.terms.pay.amount + ' ' + row.terms.pay.currency,
      render: ({ row }) => <>{row.terms.pay.amount} {row.terms.pay.currency} · {row.terms.pay.cadence}</> },
  ];
  const peopleOptions = data.people.map(person => ({ value: person.personId, label: person.displayName }));
  const isPerson = (id: string) => data.people.some(p => p.personId === id);
  const manager = isPerson(managerId) ? managerId : '';
  const candidate = isPerson(candidateId) ? candidateId : '';
  const offerPerson = role?.candidates.includes(offerPersonId) ? offerPersonId : role?.candidates[0] ?? '';
  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    if (await action({ action: 'role', title: fields.get('title'), level: fields.get('level'), managerPersonId: manager || null, exclusive })) { form.reset(); setManagerId(''); setExclusive(false); }
  }
  async function addCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!candidate) return;
    await action({ action: 'candidate', roleId: role!.roleId, personId: candidate });
  }
  async function createOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const overrides: Record<string, number> = {};
    for (const key of ['shares','vestingDays','cliffDays']) { const value = fields.get(key); if (value !== null && value !== '') overrides[key] = Number(value); }
    await action({ action: 'offer', roleId: role!.roleId, personId: offerPerson, engagementType, jurisdiction: fields.get('jurisdiction'),
      pay: { amount: fields.get('amount'), currency: fields.get('currency'), cadence }, overrides });
  }
  async function createAmendment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields=new FormData(event.currentTarget);
    await action({action:'offer',roleId:offer!.roleId,personId:offer!.personId,amendsOfferId:offer!.offerId,
      engagementType:offer!.terms.engagementType,jurisdiction:offer!.terms.jurisdiction,
      pay:{amount:fields.get('amount'),currency:offer!.terms.pay.currency,cadence:offer!.terms.pay.cadence},
      overrides:{shares:Number(fields.get('shares')),vestingDays:offer!.terms.equity.vestingDays,cliffDays:offer!.terms.equity.cliffDays}});
  }
  return <section aria-label="Hiring">
    <h3>Hiring</h3><p>Role → candidate → offer → internal approval → contract → hire vote.</p>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">Refreshing hiring records…</p> : null}
    <button type="button" disabled={busy || loading} onClick={() => void load()}>Refresh hiring</button>
    {data.nonBinding ? <p role="status">Test chain — non-binding. No formed issuing entity is recorded.</p> : null}
    {data.chainError ? <p role="alert">{data.chainError}</p> : data.chain ? <p>Preview uses chain block {data.chain.blockNumber}.</p> : null}
    <h4>Open roles</h4>{data.roles.length ? <RichGrid rows={data.roles} columns={roleColumns} getRowId={row => row.roleId} /> : <p>Create a role to begin hiring.</p>}
    <details><summary>Create a role</summary><form className="dao-form" aria-label="Create role" onSubmit={createRole}>
      <label>Role title<input name="title" required maxLength={120} /></label>
      <label>Level<input name="level" required maxLength={60} /></label>
      <label>Manager<Select className="dao-select" ariaLabel="Manager" value={manager || NO_MANAGER} onChange={value => setManagerId(value === NO_MANAGER ? '' : value)}
        options={[{ value: NO_MANAGER, label: 'No manager' }, ...peopleOptions]} /></label>
      <label><Checkbox ariaLabel="Exclusive engagement" checked={exclusive} onChange={setExclusive} />Exclusive engagement</label>
      <button type="submit" className="dao-action" disabled={busy}>Create role</button>
    </form></details>
    {role ? <section aria-label={role.title + ' candidates'}><h4>{role.title} · {role.level}</h4>
      <form className="dao-form" aria-label="Add candidate" onSubmit={addCandidate}>
        <label>Candidate<Select className="dao-select" ariaLabel="Candidate" placeholder="Select a person" value={candidate} onChange={setCandidateId} options={peopleOptions} /></label>
        <button type="submit" className="dao-action" disabled={busy || !data.people.length || !candidate}>Add candidate</button>
      </form>
      {!data.people.length ? <p>No shared person records are available. Add the person to your workspace contacts first.</p> : null}
      {role.candidates.length ? <form className="dao-form" aria-label="Create offer" onSubmit={createOffer}>
        <h4>Offer terms</h4><p>Empty equity overrides use the current policy for this role and level. The saved offer freezes its terms.</p>
        <label>Offer candidate<Select className="dao-select" ariaLabel="Offer candidate" value={offerPerson} onChange={setOfferPersonId} options={role.candidates.map(id => ({ value: id, label: name(id) }))} /></label>
        <label>Engagement<Select className="dao-select" ariaLabel="Engagement" value={engagementType} onChange={setEngagementType} options={engagementOptions} /></label>
        <label>Jurisdiction<input name="jurisdiction" required maxLength={200} /></label>
        <label>Pay amount<input name="amount" required inputMode="decimal" pattern="[0-9]{1,16}(\.[0-9]{1,2})?" /></label>
        <label>Currency<input name="currency" defaultValue="USD" required pattern="[A-Z]{3}" maxLength={3} /></label>
        <label>Pay cadence<Select className="dao-select" ariaLabel="Pay cadence" value={cadence} onChange={setCadence} options={cadences.map(c => ({ value: c, label: c }))} /></label>
        <label>Shares override<input name="shares" type="number" min="1" step="1" /></label>
        <label>Vesting days override<input name="vestingDays" type="number" min="1" max="3650" step="1" /></label>
        <label>Cliff days override<input name="cliffDays" type="number" min="0" max="3650" step="1" /></label>
        <button type="submit" className="dao-action" disabled={busy}>Create offer</button>
      </form> : <p>Add a candidate before creating an offer.</p>}
    </section> : roleId ? <p>The selected role is unavailable in this DAO.</p> : null}
    <h4>Offers</h4>{data.offers.length ? <RichGrid rows={data.offers} columns={offerColumns} getRowId={row => row.offerId} /> : <p>No offers yet.</p>}
    {offer ? <article aria-label="Offer detail"><h4>{name(offer.personId)}</h4><p>{states[offer.state]}</p>
      <p>{offer.terms.engagementType} · {offer.terms.jurisdiction} · policy version {offer.terms.equity.policyVersion ?? 'default'}</p>
      <p>{offer.terms.equity.shares} shares · {offer.terms.equity.vestingDays} days vesting · {offer.terms.equity.cliffDays} day cliff</p>
      {offer.preview ? <p>{offer.preview.fullyDilutedPercent}% of {offer.preview.proposedFullyDilutedShares} fully diluted shares, including this offer.</p> : null}
      {offer.terms.employmentLike ? <p role="alert">This contractor offer looks like employment: fixed-cadence pay, a named manager and exclusive work. Review the engagement classification before signing.</p> : null}
      <p>Approvals: {offer.approvedBy.length} of {offer.approvalsRequired}. Author: {name(offer.authoredBy)}.</p>
      {offer.state === 'offered' ? <>
        <button type="button" className="dao-action" disabled={busy || offer.authoredBy === data.actorPersonId || offer.approvedBy.includes(data.actorPersonId)}
          onClick={() => void action({ action: 'approve', offerId: offer.offerId })}>Approve offer</button>
        {offer.authoredBy === data.actorPersonId ? <p>Another HR admin must approve your offer.</p> : null}
      </> : null}
      <h4>Offer history</h4><ol>{data.history.filter(h => h.subjectKind === 'offer' && h.subjectId === offer.offerId).slice().reverse().map(h =>
        <li key={h.id}>{h.state} · {name(h.actorPersonId)} · <time>{h.at}</time></li>)}</ol>
      {offer.state === 'offered' ? <p>Internal approval is required before contract generation.</p> :
        <ContractSigningViews key={offer.offerId} daoSlug={daoSlug} offer={offer} people={data.people} onChanged={() => void load()} />}
      {offer.state==='hired'?<form className="dao-form" aria-label="Create engagement amendment" onSubmit={createAmendment}>
        <h4>Amend pay or equity</h4><p>This creates a new amendment for internal approval and both signatures. The vesting schedule is preserved.</p>
        <label>Amended pay amount<input name="amount" defaultValue={offer.terms.pay.amount} required inputMode="decimal" pattern="[0-9]{1,16}(\.[0-9]{1,2})?" /></label>
        <label>Amended total grant shares<input name="shares" type="number" min={offer.terms.equity.shares} defaultValue={offer.terms.equity.shares} step="1" required /></label>
        <button type="submit" disabled={busy}>Create amendment for signatures</button>
      </form>:null}
      {!offer.amendsOfferId&&['signed','hire-proposed','hired','lapsed'].includes(offer.state) ? <>
        <p>Candidate onboarding offer reference: <code>{offer.offerId}</code>. The candidate can open it in People → Onboarding.</p>
        <OnboardingViews key={'onboarding:' + offer.offerId} daoSlug={daoSlug} offerId={offer.offerId} onChanged={() => void load()} />
      </> : null}
      {offer.state==='hired'||(offer.amendsOfferId&&offer.state==='signed')?<EngagementViews key={'engagement:'+offer.offerId} daoSlug={daoSlug} offerId={offer.offerId} onChanged={()=>void load()} />:null}
    </article> : offerId ? <p>The selected offer is unavailable in this DAO.</p> : null}
  </section>;
}
