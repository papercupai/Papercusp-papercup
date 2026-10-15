import { useEffect, useMemo, useState } from 'react';
import { onSyncBusEvent } from '@papercusp/sync';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { Select } from '@/app/harness/Select';
import { Table, type TableColumn } from '@/app/harness/Table';
import { HumanWorkSection } from '@/app/adv/harnesses/HumanWorkSection';
import RouteLink from '@/app/_components/RouteLink';
import type { DaoSection } from './dao-navigation';
interface Item { id: string; title: string; kind: string; state: string; summary?: string; assignee?: string; harness: string; payload?: { humanWork?: unknown }; }
interface PendingJoin { githubUserId: number; githubUsername: string; displayName: string | null; }
const ALL_PROJECTS = '__all_linked_projects__';
const DAO_TABLE_HEADER_STYLE = { padding: '12px', color: 'var(--fg-mute)', fontWeight: 500 } as const;
const DAO_TABLE_CELL_STYLE = { padding: '12px', borderBottom: '1px solid var(--border)' } as const;
export default function DaoExecution({ view, section }: { view: DaoWorkspaceView; section: DaoSection }) {
  const projects = view.projects?.status === 'ready' ? view.projects.value : [];
  const projectKey = projects.map(p => p.slug).join('\n');
  const [items, setItems] = useState<Item[]>([]); const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(false); const [reload, setReload] = useState(0);
  const [project, setProject] = useState(ALL_PROJECTS); const [query, setQuery] = useState(''); const [selected, setSelected] = useState('');
  const [title, setTitle] = useState(''); const [brief, setBrief] = useState(''); const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(''); const [joins, setJoins] = useState<PendingJoin[]>([]); const [canDecide, setCanDecide] = useState(false);
  const base = '/api/pot/' + encodeURIComponent(view.localHomeSlug!) + '/membership';
  useEffect(() => onSyncBusEvent(event => { if (/workItems|features|issues|hiveDirectory|members|plans\./i.test(event.name)) setReload(value => value + 1); }), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setFailures([]); setItems([]); setJoins([]); setCanDecide(false);
    void (async () => {
      const errors: string[] = [];
      const lists = await Promise.all(projects.map(async p => {
        try {
          const response = await fetch('/api/harness/' + encodeURIComponent(p.slug) + '/work-items?limit=200', { signal: controller.signal });
          const result = await response.json(); if (!response.ok || !Array.isArray(result.workItems)) throw new Error('Work records unavailable for ' + p.title);
          if (result.total > result.workItems.length) errors.push('Showing the first ' + result.workItems.length + ' of ' + result.total + ' work records in ' + p.title + '. Open the project workspace for the remaining records.');
          return result.workItems.map((item: Item) => ({ ...item, harness: p.slug })) as Item[];
        } catch (cause) { if (!controller.signal.aborted) errors.push(cause instanceof Error ? cause.message : 'Work records unavailable.'); return []; }
      }));
      if (section === 'inbox') {
        try {
          const response = await fetch(base, { signal: controller.signal }); const result = await response.json();
          if (!response.ok || !result.ok || !Array.isArray(result.pending)) throw new Error(result.error || 'Membership requests unavailable.');
          if (!controller.signal.aborted) { setJoins(result.pending); setCanDecide(result.canDecide === true); }
        } catch (cause) { if (!controller.signal.aborted) errors.push(cause instanceof Error ? cause.message : 'Membership requests unavailable.'); }
      }
      if (!controller.signal.aborted) { setItems(lists.flat()); setFailures(errors); setLoading(false); }
    })();
    return () => controller.abort();
  }, [projectKey, base, section, reload]);
  const visible = useMemo(() => items.filter(item => (project === ALL_PROJECTS || item.harness === project) &&
    (section !== 'reputation' || ['done', 'shipped'].includes(item.state)) &&
    (section !== 'inbox' || ['blocked', 'needs-human', 'proposed'].includes(item.state)) &&
    [item.title, item.id, item.assignee ?? ''].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())), [items, project, section, query]);
  const chosen = items.find(item => item.harness + '/' + item.id === selected);
  const workColumns: TableColumn<Item>[] = [
    { key: 'work', header: 'Work', headerStyle: DAO_TABLE_HEADER_STYLE, cellStyle: DAO_TABLE_CELL_STYLE,
      render: item => <><button type="button" onClick={() => setSelected(item.harness + '/' + item.id)}>{item.title}</button><small>{item.id} · {item.kind}</small></> },
    { key: 'project', header: 'Project', headerStyle: DAO_TABLE_HEADER_STYLE, cellStyle: DAO_TABLE_CELL_STYLE, render: item => item.harness },
    { key: 'state', header: 'State', headerStyle: DAO_TABLE_HEADER_STYLE, cellStyle: DAO_TABLE_CELL_STYLE, render: item => item.state },
    { key: 'assignee', header: 'Assigned contributor / agent', headerStyle: DAO_TABLE_HEADER_STYLE, cellStyle: DAO_TABLE_CELL_STYLE, render: item => item.assignee || 'Unassigned' },
  ];
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (project === ALL_PROJECTS || !projects.some(p => p.slug === project) || !title.trim() || pending) return;
    setPending(true); setMessage('');
    try {
      const response = await fetch('/api/harness/' + encodeURIComponent(project) + '/work-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'task', title: title.trim(), summary: brief.trim() }) });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || 'Work request refused.');
      setMessage('Work request ' + result.id + ' filed for admission review.'); setTitle(''); setBrief(''); setReload(value => value + 1);
    } catch (cause) { setFailures([cause instanceof Error ? cause.message : 'Work request refused.']); } finally { setPending(false); }
  }
  async function decide(githubUserId: number, decision: 'approve' | 'deny') {
    if (!canDecide || pending) return; setPending(true); setMessage('');
    try {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubUserId, decision }) });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || result.code || 'Membership decision refused.');
      setMessage(decision === 'approve' ? 'Membership approved.' : 'Membership denied.'); setReload(value => value + 1);
    } catch (cause) { setFailures([cause instanceof Error ? cause.message : 'Membership decision refused.']); } finally { setPending(false); }
  }
  return <div className="dao-overview-grid dao-execution"><section className="dao-card dao-purpose"><h2>{section === 'inbox' ? 'Organization attention' : section === 'reputation' ? 'Completed contribution records' : 'Project work & execution'}</h2>
    <div className="dao-form">
    <div className="dao-actions"><button type="button" className="dao-action" onClick={() => setReload(value => value + 1)} disabled={pending}>Refresh work</button></div>
    {loading ? <p role="status">Reading project work…</p> : null}{message ? <p role="status">{message}</p> : null}
    {failures.map((failure, index) => <p key={index} role="alert">{failure}</p>)}
    <label>Project scope<Select ariaLabel="Project scope" value={project} onChange={value => { setProject(value); setSelected(''); }}
      triggerClassName="h-select-trigger dao-select" options={[
        { value: ALL_PROJECTS, label: 'All linked projects' },
        ...projects.map(p => ({ value: p.slug, label: p.title })),
      ]} /></label>
    <label>Find work<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    {section === 'inbox' ? <section><h3>Pending membership requests</h3>{joins.map(join => <article key={join.githubUserId}><strong>{join.displayName || join.githubUsername}</strong><p>{join.githubUsername} · GitHub #{join.githubUserId}</p><button type="button" className="dao-action" disabled={!canDecide || pending} onClick={() => { void decide(join.githubUserId, 'approve'); }}>Approve {join.githubUsername}</button><button type="button" className="dao-action" disabled={!canDecide || pending} onClick={() => { void decide(join.githubUserId, 'deny'); }}>Deny {join.githubUsername}</button></article>)}{!loading && !joins.length && !failures.length ? <p>No pending membership requests.</p> : null}{!canDecide ? <p>Membership decisions require the organization’s canonical owner device and GitHub identity.</p> : null}</section> : null}
    <div className="dao-table-wrap"><Table ariaLabel="Project work" columns={workColumns} rows={visible}
      getRowKey={item => item.harness + '/' + item.id} /></div>
    {!loading && !visible.length && !failures.length ? <p>No work records match this view.</p> : null}
    {section === 'reputation' ? <p>These are completed work records. They do not establish a reputation score or equity allocation.</p> : section === 'work' || section === 'jobs' ? <form className="dao-proposal-form dao-form" onSubmit={event => { void create(event); }}><h3>File a work request</h3><p>Select one linked project to submit work for its admission review.</p><label>Work title<input value={title} onChange={event => setTitle(event.target.value)} required /></label><label>Work brief<textarea value={brief} onChange={event => setBrief(event.target.value)} /></label><button className="dao-action" disabled={project === ALL_PROJECTS || pending || !title.trim()}>Submit work request</button></form> : null}
  </section><section className="dao-card"><h2>Work evidence & participation</h2>{chosen ? <><h3>{chosen.title}</h3><p>{chosen.summary || 'No brief recorded.'}</p><p>{chosen.state} · {chosen.assignee || 'Unassigned'}</p><RouteLink className="dao-action" href={'/adv?slug=' + encodeURIComponent(chosen.harness) + '&tab=harnesses&sel=' + encodeURIComponent(chosen.id)}>Open complete work record</RouteLink>{chosen.payload?.humanWork ? <HumanWorkSection slug={chosen.harness} id={chosen.id} refreshKey={String(reload)} /> : null}</> : <p>Select a work record to review its brief and participation options.</p>}
    <h3>Linked plans</h3>{projects.map(p => <article key={p.slug}><strong>{p.title}</strong><ul className="dao-plan-list">{p.plans.map(plan => <li key={plan.slug}><RouteLink href={'/adv?slug=' + encodeURIComponent(p.slug) + '&tab=plans&plan=' + encodeURIComponent(plan.slug)}>{plan.title}</RouteLink><small>{plan.status}</small></li>)}</ul></article>)}
  </section></div>;
}
