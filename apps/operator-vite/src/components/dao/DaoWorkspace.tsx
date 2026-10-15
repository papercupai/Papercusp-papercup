import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { switchWorkspace } from '@papercusp/operator-core/lib/workspaces-tauri';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { parseAsString, useQueryState } from 'nuqs';
import { onSyncBusEvent, useSyncQuery } from '@papercusp/sync';
import RouteLink from '@/app/_components/RouteLink';
import type { CloudWorkspacesControlRow } from '@/app/cloud-workspaces/workspace-view-model';
import { DAO_SECTIONS, daoSection, filterDaos, type DaoDirectoryEntry } from './dao-navigation';
import DaoWorkspaceDetails from './DaoWorkspaceDetails';
import './dao-workspace.css';

export default function DaoWorkspace() {
  const [selectedDao, setSelectedDao] = useQueryState('dao', parseAsString.withDefault(''));
  const [selectedSection, setSelectedSection] = useQueryState('daoSection', parseAsString.withDefault('directory'));
  const { data, error, invalidate } = useSyncQuery({ queryName: 'network.hiveDirectory', args: { includeLocalViews: true } });
  const { data: hostData, error: hostError, invalidate: invalidateHosts } = useSyncQuery({ queryName: 'workspaceHosts.control', args: {} });
  const rows = useMemo<DaoDirectoryEntry[]>(() => [
    ...((data as DaoDirectoryEntry[] | undefined) ?? []),
    ...((hostData as CloudWorkspacesControlRow[] | undefined) ?? []).filter(row => row.kind === 'workspace').map<DaoDirectoryEntry>(host => ({
      potId: 'host:' + host.id, workspaceHostId: host.id, title: host.name,
      description: [host.target, host.region].filter(Boolean).join(' · '),
      owner: 'Local', visibility: 'invite', source: 'local', memberLinks: [], memberTopics: [], memberCount: 0,
    })),
  ], [data, hostData]);
  const organizations = rows.filter(row => row.workspaceId === undefined && row.workspaceHostId === undefined);
  const directoryReady = data !== undefined && hostData !== undefined;
  const sectionId = daoSection(selectedSection);
  const section = DAO_SECTIONS.find(value => value.id === sectionId)!;
  const selected = organizations.find(row => row.potId === selectedDao);
  const [query, setQuery] = useState('');
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [workspace, setWorkspace] = useState<DaoWorkspaceView | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const loadedDao = useRef('');
  const filtered = useMemo(() => filterDaos(rows, query), [rows, query]);
  useEffect(() => onSyncBusEvent(event => {
    if (selectedDao && (event.name.startsWith('plans.') || ['network.hiveDirectory', 'hive.overrides', 'hive.steering', 'dev.assignableMembers', 'harnessProjects.lite'].includes(event.name)))
      setRefreshVersion(value => value + 1);
  }), [selectedDao]);

  useEffect(() => {
    const initialRead = loadedDao.current !== selectedDao;
    if (initialRead) setWorkspace(null);
    setWorkspaceError('');
    if (!selectedDao || !selected) { setWorkspaceLoading(false); return; }
    const controller = new AbortController();
    if (initialRead) setWorkspaceLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/discovery/pots?potId=' + encodeURIComponent(selectedDao) + '&includeLocalViews=true', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.workspace || result.workspace.directoryId !== selectedDao) throw new Error('Unable to read this organization’s records. Refresh to retry.');
        if (!controller.signal.aborted) { loadedDao.current = selectedDao; setWorkspace(result.workspace); }
      } catch (cause) {
        if (!controller.signal.aborted) setWorkspaceError(cause instanceof Error ? cause.message : 'Organization records are unavailable.');
      } finally {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedDao, Boolean(selected), refreshVersion]);

  function refresh() { invalidate(); invalidateHosts(); setRefreshVersion(value => value + 1); }

  async function choose(row: DaoDirectoryEntry) {
    setNotice('');
    if (row.workspaceId !== undefined) {
      try { await switchWorkspace(row.workspaceId); }
      catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Unable to open this workspace. Try again.'); }
      return;
    }
    setAcceptedTerms(false);
    await setSelectedDao(row.potId);
    await setSelectedSection('overview');
  }

  async function join() {
    if (!selected || !acceptedTerms || !selected.memberLinks.length || joining) return;
    setJoining(true);
    setNotice('');
    try {
      const response = await fetch('/api/discovery/join-pot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ potId: selected.potId, title: selected.title, memberLinks: selected.memberLinks }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Membership request failed.');
      setNotice('Joined ' + (result.potSlug ?? selected.title) + '. Review membership permissions before submitting decisions.');
      invalidate();
      setRefreshVersion(value => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Unable to join. Try again.');
    } finally { setJoining(false); }
  }

  return (
    <div className="dao-workspace" data-testid="dao-workspace">
      <aside className="dao-sidebar" aria-label="DAO workspace">
        <div className="dao-brand"><span aria-hidden="true">◈</span><div><strong>DAO Workbench</strong><small>Community · decisions · execution</small></div></div>
        <label className="dao-picker">Organization
          <Select ariaLabel="Choose a DAO" value={selectedDao} onChange={value => {
            void setSelectedDao(value); setAcceptedTerms(false); setNotice('');
          }} placeholder="Choose an organization" triggerClassName="h-select-trigger dao-select"
            options={organizations.map(row => ({ value: row.potId, label: row.title }))} />
        </label>
        <nav aria-label="DAO sections">
          {['Community', 'Governance', 'Execution', 'Finance', 'Organization'].map(group => (
            <div className="dao-nav-group" key={group}><h2>{group}</h2>
              {DAO_SECTIONS.filter(value => value.group === group).map(value => (
                <button key={value.id} type="button" aria-current={sectionId === value.id ? 'page' : undefined}
                  onClick={() => { setNotice(''); void setSelectedSection(value.id); }}>{value.label}</button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="dao-main">
        <header className="dao-page-header"><div><p className="dao-eyebrow">{selected?.title ?? 'Workspace network'} / {section.group}</p>
          <h1>{section.label}</h1><p>{section.description}</p></div>
          <div className="dao-actions"><RouteLink href="/dao" className="dao-action">Launch a DAO</RouteLink><button type="button" className="dao-action" onClick={refresh}>Refresh</button></div>
        </header>
        {notice && <div role="status" className="dao-notice">{notice}</div>}
        {error ? <div role="alert" className="dao-notice">Unable to load the workspace directory. <button type="button" onClick={() => invalidate()}>Try again</button></div> : null}
        {hostError ? <div role="alert" className="dao-notice">Unable to load cloud workspaces. <button type="button" onClick={() => invalidateHosts()}>Try again</button></div> : null}
        {!directoryReady && !error && !hostError ? <p role="status">Loading discovered workspaces…</p> : null}
        {sectionId === 'directory' ? <>
          <label className="dao-search">Search workspaces<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Workspace, DAO, purpose or founder" /></label>
          <div className="dao-directory">
            {filtered.map(row => <article className="dao-card" key={row.potId}>
              <div className="dao-card-heading"><span className="dao-avatar" aria-hidden="true">{row.title.slice(0, 1)}</span><span className="dao-badge">{row.workspaceHostId !== undefined ? 'Cloud workspace' : row.workspaceId !== undefined ? 'Workspace' : row.source === 'local' ? 'Local DAO' : row.visibility === 'invite' ? 'Invite-only DAO' : 'Public DAO'}</span></div>
              <h2>{row.title}</h2><p>{row.description || (row.workspaceId !== undefined || row.workspaceHostId !== undefined ? 'Open this workspace to view its projects and activity.' : 'No organization description published yet.')}</p>
              {row.workspaceId === undefined && row.workspaceHostId === undefined ? <dl><div><dt>Published by</dt><dd>{row.owner}</dd></div><div><dt>Linked projects</dt><dd>{row.memberCount}</dd></div></dl> : null}
              {row.workspaceHostId !== undefined ? <RouteLink href={'/cloud-workspaces?host=' + encodeURIComponent(row.workspaceHostId)} className="dao-action">Open workspace →</RouteLink> : <button type="button" className="dao-action" onClick={() => { void choose(row); }}>Open workspace →</button>}
            </article>)}
          </div>
          {directoryReady && !error && !hostError && !filtered.length ? <div className="dao-empty"><h2>{query ? 'No matching workspaces' : 'No workspaces discovered yet'}</h2><p>{query ? 'Try another name or purpose.' : 'Registered workspaces, cloud workspaces and published DAOs will appear here.'}</p></div> : null}
        </> : !selected ? (data !== undefined && !error ? <div className="dao-empty"><h2>{selectedDao ? 'This organization is not listed in this directory' : 'Choose an organization'}</h2><p>Select a DAO to open its workspace.</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('directory'); }}>Browse DAOs</button></div> : null) : <>
          {sectionId === 'overview' ? <div className="dao-overview-grid">
            <section className="dao-card dao-purpose"><p className="dao-eyebrow">Organization</p><h2>{selected.title}</h2><p>{selected.description || 'No purpose published yet.'}</p><div className="dao-meta">Published by {selected.owner} · {selected.visibility}</div></section>
            <section className="dao-card"><p className="dao-eyebrow">Projects</p><strong className="dao-stat">{selected.memberCount}</strong><p>Linked projects in the discovery record</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('work'); }}>Explore work →</button></section>
            <section className="dao-card"><p className="dao-eyebrow">Your next step</p><h2>Review membership</h2><p>Connect to the organization before participating in its plans.</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('join'); }}>Membership →</button></section>
          </div> : sectionId === 'join' ? <section className="dao-card dao-purpose"><h2>Join {selected.title}</h2><p>Joining connects this workspace to the organization’s published projects. Voting and spending retain their separate admission and signer requirements.</p>
            <label className="dao-check"><Checkbox ariaLabel="I want to connect to this organization’s published projects."
              checked={acceptedTerms} onChange={setAcceptedTerms} /> I want to connect to this organization’s published projects.</label>
            {!selected.memberLinks.length ? <p>This publisher has not provided the project links required to join.</p> : null}
            <button type="button" className="dao-action" disabled={!acceptedTerms || joining || !selected.memberLinks.length} onClick={() => { void join(); }}>{joining ? 'Joining…' : 'Join organization'}</button>
          </section> : <DaoWorkspaceDetails section={sectionId} view={workspace?.directoryId === selectedDao ? workspace : null} loading={workspaceLoading} error={workspaceError} onChanged={() => setRefreshVersion(value => value + 1)} />}
          <aside className="dao-evidence"><h2>Decision boundaries</h2><p>Member plan votes authorize plan admission. Treasury transactions require their signer approvals. Ownership votes use the equity governance contract.</p><p>Directory entries describe discovered organizations; they do not establish legal formation or financial assets.</p></aside>
        </>}
      </main>
    </div>
  );
}
