'use client';

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { ClipboardList, FileText, Search, Users, ArrowUpRight, MessageSquare, X } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { FLAGS } from '@papercusp/flags';
import { toast } from 'sonner';
import { usePlan } from '@/app/admin/plans/plans-api';
import { advRosterArgs } from '@/lib/adv-roster-args';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { useFlag } from '@/lib/flag-hooks';
import { canUseContentOriginDesktopActions, isDesktop } from '@/lib/ipc-status-tauri';
import { focusWindow } from '@/lib/chat-actions/SessionActions';
import { useDebouncedValue } from '@/app/harness/picker-kit';
import { Button } from '@/app/harness/Button';
import { Modal } from '@/app/harness/Modal';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';
import {
  QUICK_SCOPES, quickResults, quickSelection, quickVisibleResults, quickFocusReason, quickAgentName,
  type QuickAgent, type QuickPlan, type QuickReport, type FullReport, type QuickResult,
} from './quick-access-model';
import './quick-access.css';

const SessionChatModal = lazy(() => import('@/app/_components/chat/SessionChatModal'));
const labels = { all: 'All', plans: 'Plans', agents: 'Agents', reports: 'Reports' };
const resultIcons = { plans: ClipboardList, agents: Users, reports: FileText };
type PlanSession = { coordOwnerId: string; label: string | null; live: boolean };

/** Native focus runs in the desktop session, including Windows/WSL. Unix
 * launch-record resolution remains in the canonical server action. */
export async function focusQuickAgent(agent: QuickAgent): Promise<void> {
  const reason = quickFocusReason(agent);
  if (reason) throw new Error(reason);
  if (!isDesktop()) throw new Error('Focus window is available in the desktop popup');
  if (agent.windowId) {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<unknown>('focus_window_by_title', { title: agent.windowId });
    if (result === true || (typeof result === 'object' && result !== null &&
      'focused' in result && result.focused === true)) return;
  }
  if (!await canUseContentOriginDesktopActions()) {
    throw new Error('This popup is not connected to the local desktop Server');
  }
  await focusWindow({ sessionOwnerId: agent.ownerId, ownerLabel: quickAgentName(agent),
    // A terminal server PID may be shared by several agent windows. Resolve
    // the recorded window or exact launch identity instead of guessing by PID.
    advSessionId: agent.advSessionId, windowId: agent.windowId });
}

function Person({ agent, onChat }: { agent: QuickAgent; onChat: (owner: string, label: string) => void }) {
  const [busy, setBusy] = useState(false);
  const reason = quickFocusReason(agent);
  const name = quickAgentName(agent);
  return <div className="pc-qa__person">
    <div className="pc-qa__avatar" aria-hidden>{name.slice(0, 2)}</div>
    <div className="pc-qa__person-copy"><strong>{name}</strong>
      <small>{agent.agent || 'Agent'} · {agent.sessionState || 'Activity unavailable'}</small>
      {agent.intent && <p>{agent.intent}</p>}</div>
    <div className="pc-qa__actions">
      <Button variant="ghost" onClick={() => onChat(agent.ownerId, name)} aria-label={`Talk to ${name}`}>
        <MessageSquare size={13} aria-hidden /> Talk
      </Button>
      <Button variant="ghost" disabled={!!reason || busy} aria-label={`Focus ${name} window`}
        onClick={async () => {
          setBusy(true);
          try { await focusQuickAgent(agent); }
          catch (error) { toast.error(error instanceof Error ? error.message : 'Window focus failed'); }
          finally { setBusy(false); }
        }}>
        <ArrowUpRight size={13} aria-hidden /> {busy ? 'Focusing…' : 'Focus window'}
      </Button>
      {reason && <small className="pc-qa__unavailable">{reason}</small>}
    </div>
  </div>;
}

function ReportBody({ reportId }: { reportId: string }) {
  const query = useSyncQuery<FullReport>({ queryName: 'reports.get', args: { reportId } });
  const report = query.data?.find(r => r.report_id === reportId);
  if (query.error) return <p role="alert">Could not load this report. {String(query.error)}</p>;
  if (!report) return <p role="status">{query.loading ? 'Loading report…' : 'Report not found or unavailable.'}</p>;
  return <div className="pc-qa__report"><MarkdownPreview value={report.body_md} /></div>;
}

function PlanPreview({ plan, agents, onChat }: {
  plan: QuickPlan; agents: QuickAgent[]; onChat: (owner: string, label: string) => void;
}) {
  const query = usePlan(plan.slug, { live: true, harnessSlug: plan.harness });
  const workspaceId = useWorkspaceId();
  const sessions = useSyncQuery<PlanSession>({ queryName: 'planSessions.list',
    args: { planSlug: plan.slug, harnessSlug: plan.harness, workspaceId: workspaceId ?? null } });
  const doc = query.data?.slug === plan.slug ? query.data : null;
  const items = doc?.items ?? [];
  const completed = items.filter(i => i.effectiveStatus === 'done').length;
  const owners = new Set(sessions.data?.map(s => s.coordOwnerId) ?? []);
  const people = agents.filter(a => owners.has(a.ownerId));
  return <>
    <div className="pc-qa__meta">{plan.status} · {plan.harness}</div>
    <h1>{plan.title || plan.slug}</h1>
    {plan.nextAction && <p className="pc-qa__description">{plan.nextAction}</p>}
    {query.loading && <p role="status">Loading plan…</p>}
    {query.error && <p role="alert">Plan details unavailable. {String(query.error)}</p>}
    {doc && <div className="pc-qa__progress"><span>{completed} of {items.length} tasks complete</span>
      <progress max={Math.max(1, items.length)} value={completed} aria-label="Plan progress" /></div>}
    <h2>People on this plan</h2>
    {sessions.loading && <p role="status">Loading plan conversations…</p>}
    {sessions.error && <p role="alert">Could not load plan conversations.</p>}
    {people.map(a => <Person key={a.ownerId} agent={a} onChat={onChat} />)}
    {(sessions.data ?? []).filter(s => !people.some(a => a.ownerId === s.coordOwnerId)).map(s =>
      <div className="pc-qa__historical" key={s.coordOwnerId}>
        <span>{s.label || s.coordOwnerId}<small>{s.live ? 'Live session' : 'Recorded conversation'}</small></span>
        <Button variant="ghost" onClick={() => onChat(s.coordOwnerId, s.label || s.coordOwnerId)}>Open conversation</Button>
      </div>)}
    {!sessions.loading && !sessions.error && !sessions.data?.length &&
      <p className="pc-qa__empty">No agent conversations are recorded for this plan.</p>}
  </>;
}

export default function QuickAccessLauncher({ queryPrefix = '' }: { queryPrefix?: string }) {
  const workspaceId = useWorkspaceId();
  const reportsEnabled = useFlag(FLAGS.REPORTS_LIBRARY);
  const [state, setState] = useQueryStates({
    [`${queryPrefix}laq`]: parseAsString.withDefault(''),
    [`${queryPrefix}lascope`]: parseAsStringEnum([...QUICK_SCOPES]).withDefault('all'),
    [`${queryPrefix}lasel`]: parseAsString.withDefault(''),
  });
  const query = state[`${queryPrefix}laq`] as string;
  const scope = state[`${queryPrefix}lascope`] as (typeof QUICK_SCOPES)[number];
  const selectedKey = state[`${queryPrefix}lasel`] as string;
  const debounced = useDebouncedValue(query, 200);
  // Read lightweight workspace metadata; resolve only the selected item graph.
  const plans = useSyncQuery<QuickPlan>({ queryName: 'plans.list',
    args: { workspaceWide: true, compact: true, includeFinished: true, includeArchived: false, order: 'updated' } });
  const roster = useSyncQuery<{ active?: QuickAgent[] }>({ queryName: 'advRoster.list', args: advRosterArgs(workspaceId) });
  const reports = useSyncQuery<QuickReport>({ queryName: 'reports.list',
    args: { limit: 50, ...(debounced.trim() ? { query: debounced.trim() } : {}) }, enabled: reportsEnabled });
  const agents = roster.data?.[0]?.active ?? [];
  const results = useMemo(() => quickResults(plans.data ?? [], agents,
    reportsEnabled ? reports.data ?? [] : [], query, scope), [plans.data, agents, reports.data, reportsEnabled, query, scope]);
  const visible = useMemo(() => quickVisibleResults(results, scope), [results, scope]);
  const selected = quickSelection(visible, selectedKey);
  const [conversation, setConversation] = useState<{ owner: string; label: string } | null>(null);
  const [reportOpen, setReportOpen] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const onChat = (owner: string, label: string) => setConversation({ owner, label });
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    selectedButton.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.key]);
  const select = (key: string) => void setState({ [`${queryPrefix}lasel`]: key });
  const activate = (r: QuickResult) => {
    if (r.kind === 'agents') onChat(r.agent.ownerId, r.title);
    if (r.kind === 'reports') setReportOpen(r.report.report_id);
    if (r.kind === 'plans') document.getElementById('quick-access-preview')?.focus();
  };
  const errors = [
    (scope === 'all' || scope === 'plans') && plans.error && 'Plans could not be loaded',
    (scope === 'all' || scope === 'agents') && roster.error && 'Agents could not be loaded',
    reportsEnabled && (scope === 'all' || scope === 'reports') && reports.error && 'Reports could not be loaded',
  ].filter(Boolean);
  const loading = ((scope === 'all' || scope === 'plans') && plans.loading) ||
    ((scope === 'all' || scope === 'agents') && roster.loading) ||
    (reportsEnabled && (scope === 'all' || scope === 'reports') && reports.loading);
  return <section className="pc-qa" aria-label="Quick Access launcher">
    <header className="pc-qa__header"><label className="pc-qa__search">
      <Search size={18} aria-hidden />
      <input ref={input} value={query} placeholder="Find a plan, report, or person…"
        aria-label="Search plans, agents and reports" aria-controls="quick-access-results"
        onChange={e => void setState({ [`${queryPrefix}laq`]: e.target.value, [`${queryPrefix}lasel`]: '' })}
        onKeyDown={e => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && visible.length) {
            e.preventDefault();
            const index = visible.findIndex(r => r.key === selected?.key);
            const next = visible[(index + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length];
            select(next.key);
          }
          if (e.key === 'Enter' && selected) { e.preventDefault(); activate(selected); }
          if (e.key === 'Escape' && query) {
            e.preventDefault(); e.stopPropagation();
            void setState({ [`${queryPrefix}laq`]: '', [`${queryPrefix}lasel`]: '' });
          }
        }} />
      {query && <button type="button" className="pc-qa__clear" aria-label="Clear search"
        onClick={() => { void setState({ [`${queryPrefix}laq`]: '', [`${queryPrefix}lasel`]: '' }); input.current?.focus(); }}><X size={14} /></button>}
    </label>
      <nav className="pc-qa__scopes" aria-label="Search scope">
        {QUICK_SCOPES.map(s => <button key={s} type="button" aria-pressed={scope === s}
          onClick={() => void setState({ [`${queryPrefix}lascope`]: s, [`${queryPrefix}lasel`]: '' })}>{labels[s]}</button>)}
        <span>Quick Access</span>
      </nav>
    </header>
    {errors.length > 0 && <p role="alert" className="pc-qa__notice">{errors.join(' · ')}. Available sources remain searchable.</p>}
    {scope === 'reports' && !reportsEnabled && <p role="status" className="pc-qa__notice">Reports library is disabled for this workspace.</p>}
    <div className="pc-qa__body">
      <div id="quick-access-results" className="pc-qa__results" aria-label="Search results">
        {loading && <p role="status" className="pc-qa__empty">Updating results…</p>}
        {!results.length && !loading && <p className="pc-qa__empty">No matching plans, agents, or reports.</p>}
        {visible.map((r, i) => {
          const Icon = resultIcons[r.kind];
          return <div key={r.key}>
            {(i === 0 || visible[i - 1].kind !== r.kind) && <h2>{labels[r.kind]}</h2>}
            <button type="button" className={`pc-qa__result${selected?.key === r.key ? ' is-selected' : ''}`}
              ref={selected?.key === r.key ? selectedButton : undefined}
              aria-pressed={selected?.key === r.key} onClick={() => select(r.key)} onDoubleClick={() => activate(r)}>
              <Icon size={17} aria-hidden /><span><strong>{r.title}</strong><small>{r.subtitle}</small></span>
            </button>
          </div>;
        })}
        {results.length > visible.length && <p className="pc-qa__empty">Showing {visible.length} of {results.length} matches. Refine your search.</p>}
        {(scope === 'all' || scope === 'reports') && reportsEnabled && <p className="pc-qa__limit">Reports: up to 50 recent matches. Search to find older reports.</p>}
      </div>
      <aside id="quick-access-preview" className="pc-qa__preview" tabIndex={-1} aria-label="Selection preview">
        {!selected && <p className="pc-qa__empty">Choose a result to preview it.</p>}
        {selected?.kind === 'plans' && <PlanPreview key={selected.key} plan={selected.plan} agents={agents} onChat={onChat} />}
        {selected?.kind === 'agents' && <>
          <div className="pc-qa__meta">Agent</div><h1>{selected.title}</h1>
          {selected.agent.currentPlanSlug && <p className="pc-qa__description">{selected.agent.currentPlanSlug}</p>}
          <Person key={selected.agent.ownerId} agent={selected.agent} onChat={onChat} />
        </>}
        {selected?.kind === 'reports' && <>
          <div className="pc-qa__meta">{selected.report.kind}</div><h1>{selected.title}</h1>
          <p className="pc-qa__description">{selected.report.summary}</p>
          <Button variant="ghost" onClick={() => setReportOpen(selected.report.report_id)}>Read report</Button>
          <ReportBody key={selected.key} reportId={selected.report.report_id} />
        </>}
      </aside>
    </div>
    <footer className="pc-qa__footer"><span>↑ ↓ Select · Enter Open · Esc Clear / Dismiss</span><span>Plans · People · Reports</span></footer>
    <Modal open={!!reportOpen} onOpenChange={open => { if (!open) setReportOpen(null); }}
      title="Report" contentStyle={{ width: 'min(900px, 94vw)', maxHeight: '90vh', overflow: 'auto' }}>
      {reportOpen && <ReportBody key={reportOpen} reportId={reportOpen} />}
    </Modal>
    {conversation && <Suspense fallback={<p role="status">Opening conversation…</p>}>
      <SessionChatModal sessionOwnerId={conversation.owner} ownerLabel={conversation.label} onClose={() => setConversation(null)} />
    </Suspense>}
  </section>;
}
