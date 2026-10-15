import { useEffect, useMemo, useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { fetchPlan } from '@/app/admin/plans/plans-api';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';

interface Proposal { title?: string; raw?: string; prose?: string; contentHash: string }
interface Round {
  roundId: string; status: string; expiresAtMs: number;
  ballots: Array<{ memberId: string; choice: string; sequence: number }>;
  certificate: { admitted: boolean; reason: string; tally: { approveWeight: number; rejectWeight: number; abstainWeight: number } } | null;
}
interface Inspection {
  planRevisionHash: string;
  actor: { memberId: string; roles: string[] } | null;
  rounds: Round[]; integrityErrors: string[]; conflictedRoundIds: string[];
}

async function plansRequest(verb: string, args: object, signal?: AbortSignal) {
  const response = await fetch('/api/admin/plans/' + verb, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal });
  const result = await response.json();
  if (!response.ok || result.ok === false || result.error) throw new Error(result.detail || result.error?.message || result.error || 'The organization request failed.');
  return result;
}

export default function DaoGovernance({ view, onChanged }: { view: DaoWorkspaceView; onChanged?: () => void }) {
  const projects = view.projects?.status === 'ready' ? view.projects.value : [];
  const proposals = useMemo(() => projects.flatMap(project => project.plans.map(plan => ({ ...plan, harness: project.slug, key: project.slug + '/' + plan.slug }))), [projects]);
  const [selection, setSelection] = useState('');
  const selected = proposals.find(plan => plan.key === selection);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [projectSlug, setProjectSlug] = useState(view.localHomeSlug ?? '');

  useEffect(() => {
    setProposal(null); setInspection(null); setReviewed(false); setError(''); setMessage('');
    if (!selected) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const args = { harness: selected.harness, slug: selected.slug };
    void (async () => {
      const [document, decision] = await Promise.allSettled([
        fetchPlan(selected.slug, selected.harness, controller.signal, { includeEnrichments: false, trackInteraction: false }),
        plansRequest('governance-event', { ...args, op: 'inspect' }, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (document.status === 'fulfilled') {
        const value = document.value;
        if (typeof value.contentHash === 'string' && value.contentHash.trim())
          setProposal({ ...value, contentHash: value.contentHash });
        else setError('Unable to read this proposal’s exact revision. Reload to retry.');
      }
      else setError(document.reason instanceof Error ? document.reason.message : 'Unable to read this proposal.');
      if (decision.status === 'fulfilled') setInspection(decision.value);
      else setError(decision.reason instanceof Error ? decision.reason.message : 'Voting policy is unavailable.');
      setLoading(false);
    })();
    return () => controller.abort();
  }, [selected?.harness, selected?.slug, reload]);

  const revisionMatches = !!proposal && !!inspection && proposal.contentHash === inspection.planRevisionHash;
  const evidenceValid = !!inspection && !inspection.integrityErrors.length && !inspection.conflictedRoundIds.length;
  const canDecide = reviewed && revisionMatches && evidenceValid && !pending && !loading;

  async function act(action: { kind: 'open' } | { kind: 'vote'; roundId: string; choice: string } | { kind: 'finalize'; roundId: string }) {
    if (!selected || !proposal || !canDecide) return;
    setPending(true); setError(''); setMessage('');
    try {
      const result = await plansRequest('governance-event', { harness: selected.harness, slug: selected.slug,
        op: 'local-action', expectedRevisionHash: proposal.contentHash, action });
      setInspection(result);
      setMessage(action.kind === 'vote' ? 'Your ' + action.choice + ' vote was recorded.' : action.kind === 'open' ? 'Voting round opened.' : 'Decision result finalized.');
      onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The decision was refused.'); }
    finally { setPending(false); }
  }

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !projects.some(project => project.slug === projectSlug)) return;
    setPending(true); setError(''); setMessage('');
    try {
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'proposal';
      const content = '## Now\n\nDraft proposal for member review.\n\n## Background\n\n' + purpose.trim() +
        '\n\n## Requirements\n\n**R-1 — Accepted outcome.** ' + acceptance.trim() +
        '\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n| --- | --- | --- |\n| R-1 | P-001 | tree |\n\n## Phase 1\n\n- **P-001** `todo` ' + purpose.trim().split('\n')[0] + '\n\n## Decisions\n';
      const created = await plansRequest('new', { harness: projectSlug, slug, title: title.trim(), rationale: purpose.trim(), content });
      // plans:new adds its canonical date suffix to an undated requested slug.
      const confirmedSlug = typeof created.slug === 'string' && (created.slug === slug ||
        (created.slug.startsWith(slug + '-') && /^\d{4}-\d{2}-\d{2}$/.test(created.slug.slice(slug.length + 1))));
      if (created.ok !== true || !confirmedSlug) throw new Error('The server did not confirm this proposal was saved. Your draft is retained.');
      setMessage('Proposal saved as a draft. Review its scope before opening voting.');
      setTitle(''); setPurpose(''); setAcceptance(''); onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Proposal could not be saved.'); }
    finally { setPending(false); }
  }

  return <section className="dao-card dao-governance">
    <h2>Proposals & member decisions</h2>
    <details><summary>Propose work</summary><form className="dao-form" onSubmit={event => { void propose(event); }}>
      <label>Project<Select ariaLabel="Project" value={projectSlug} onChange={setProjectSlug}
        triggerClassName="h-select-trigger dao-select" options={projects.map(project => ({ value: project.slug, label: project.title }))} /></label>
      <label>Proposal title<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Purpose & scope<textarea required maxLength={4000} value={purpose} onChange={event => setPurpose(event.target.value)} /></label>
      <label>How members will verify success<textarea required maxLength={4000} value={acceptance} onChange={event => setAcceptance(event.target.value)} /></label>
      <button className="dao-action" disabled={pending || !projects.length}>Save draft proposal</button>
    </form></details>
    <label className="dao-picker">Review proposal<Select ariaLabel="Review proposal" value={selection}
      onChange={value => { setSelection(value); setReviewed(false); }} placeholder="Choose a proposal"
      triggerClassName="h-select-trigger dao-select"
      options={proposals.map(plan => ({ value: plan.key, label: plan.title + ' · ' + plan.harness }))} /></label>
    {!proposals.length ? <p>No proposal records in the linked projects.</p> : null}
    {loading ? <p role="status">Loading the proposal and voting policy…</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <div className="dao-notice" role="alert">{error}<button className="dao-action" onClick={() => setReload(value => value + 1)}>Reload decision</button></div> : null}
    {proposal && !loading ? <><h3>{proposal.title || selected?.title}</h3><details open><summary>Proposal to be decided</summary><pre>{proposal.raw || proposal.prose || 'The proposal has no authored text.'}</pre></details>
      <p className="dao-meta">Reviewed revision: {proposal.contentHash.slice(0, 12)}</p>
      {inspection && !revisionMatches ? <p role="alert">The proposal changed while loading. Reload before deciding.</p> : null}
      {inspection && !evidenceValid ? <p role="alert">Conflicting or unverifiable decision records prevent voting.</p> : null}
      <label className="dao-check"><Checkbox ariaLabel="I reviewed this proposal and its exact revision." checked={reviewed} onChange={setReviewed} />
        I reviewed this proposal and its exact revision.</label>
      {!inspection?.actor ? <p>Your current device is not enrolled as a signer in this organization’s verified voting policy.</p> : <p>Deciding as {inspection.actor.memberId}</p>}
      <button className="dao-action" disabled={!canDecide || !inspection?.actor?.roles.includes('round-open')} onClick={() => { void act({ kind: 'open' }); }}>Open voting round</button>
      {inspection?.rounds.map(round => <article className="dao-decision-list" key={round.roundId}><h3>Voting round</h3><p>{round.status} · closes {new Date(round.expiresAtMs).toLocaleString()}</p>
        <ul>{round.ballots.map(ballot => <li key={ballot.memberId + ':' + ballot.sequence}>{ballot.memberId}: {ballot.choice}{ballot.sequence > 0 ? ' (replacement)' : ''}</li>)}</ul>
        {round.certificate ? <p>{round.certificate.admitted ? 'Plan admission approved' : 'Plan admission refused'} · {round.certificate.tally.approveWeight} approve / {round.certificate.tally.rejectWeight} reject / {round.certificate.tally.abstainWeight} abstain weight</p> : null}
        <div className="dao-actions">{(['approve', 'reject', 'abstain'] as const).map(choice => <button key={choice} className="dao-action"
          disabled={!canDecide || !inspection.actor?.roles.includes('vote') || round.status !== 'open' || Date.now() >= round.expiresAtMs}
          onClick={() => { void act({ kind: 'vote', roundId: round.roundId, choice }); }}>{choice[0].toUpperCase() + choice.slice(1)}</button>)}
          <button className="dao-action" disabled={!canDecide || !inspection.actor?.roles.includes('finalize') || round.status !== 'open' || Date.now() >= round.expiresAtMs}
            onClick={() => { void act({ kind: 'finalize', roundId: round.roundId }); }}>Finalize result</button></div>
      </article>)}
    </> : null}
  </section>;
}
