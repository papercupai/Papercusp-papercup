'use client';

import { useEffect, useRef, useState } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { ArrowDown, ArrowUp, Check, Infinity as InfinityIcon, Plus, RefreshCw, Search, Settings2,
  X } from 'lucide-react';
import { Modal } from '@/app/harness/Modal';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { Table, type TableColumn } from '@/app/harness/Table';
import { TextInput, TextArea } from '@/app/harness/TextInput';
import { Tooltip } from '@/app/harness/Tooltip';
import GoalStatusControl from './GoalStatusControl';
import GoalSettingsSection from './GoalSettingsSection';
import { type GoalDetailInput } from './goal-detail-model';
import { ongoingWorkView } from './ongoing-work-model';
import { draftRows, moveDraft, toggleDraft, worklistChanges, type WorklistDraft } from './ongoing-work-draft';
import { STATE_KEYS, STATE_LABEL, completionSeries, filterAndSort, inScope, loadProblem, percent, progressRows,
  sumCounts, total, type PlanStateKey, type ProgressCounts, type ProgressRow } from './woe-progress-model';
import './WorkOnEverythingPanel.css';

const SCOPES = ['all', 'in', 'out'] as const;
const SORTS = ['left', 'pct', 'rank', 'name'] as const;
const SORT_LABEL = { left: 'Most work left', pct: 'Least finished', rank: 'Worklist order', name: 'Name' } as const;

const RUBRIC_DUTIES = [
  ['rubric-coverage-stewardship', 'Maintain rubric coverage', 'Reuse suitable rubrics. Create and review one when an important target has a gap.'],
  ['rubric-quality-stewardship', 'Improve rubric quality', 'Strengthen criteria and evidence requirements through reviewed, versioned changes.'],
  ['grading-correction-closure', 'Grade, improve and re-grade', 'Assign graders, preserve a baseline, verify repairs and compare the result.'],
] as const;

type GradingCycle = NonNullable<GoalDetailInput['rubricStewardship']>['cycles'][number];

const WOE_TABLE_HEADER_STYLE = {
  padding: '9px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--fg-mute)',
  opacity: 1,
  background: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
} as const;

const WOE_TABLE_CELL_STYLE = {
  padding: '9px 12px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
  minWidth: 0,
} as const;

function RubricStewardship({ data, onOpenWorkItem }: { data: GoalDetailInput; onOpenWorkItem?: (id: string) => void }) {
  const quality = data.rubricStewardship;
  const cycleColumns: TableColumn<GradingCycle>[] = [
    {
      key: 'target',
      header: 'Target / rubric',
      headerStyle: WOE_TABLE_HEADER_STYLE,
      cellStyle: WOE_TABLE_CELL_STYLE,
      render: (cycle) => <><strong>{cycle.target}</strong>
        <small>{cycle.rubricRef}{cycle.rubricRevision ? ` · revision ${cycle.rubricRevision}` : ''}</small></>,
    },
    {
      key: 'progress',
      header: 'Progress',
      headerStyle: WOE_TABLE_HEADER_STYLE,
      cellStyle: WOE_TABLE_CELL_STYLE,
      render: (cycle) => <><span className="woe__state" data-state={cycle.status}>
        {({ baseline: 'Baseline recorded', 'needs-repair': 'Repairs needed', 'needs-regrade': 'Re-grade needed',
          unverified: 'Needs verification', incomparable: 'Fresh baseline needed', verified: 'Improvement verified' })[cycle.status]}</span>
        <p className="woe__muted">{cycle.reason}</p></>,
    },
    {
      key: 'evidence',
      header: 'Evidence',
      headerStyle: WOE_TABLE_HEADER_STYLE,
      cellStyle: WOE_TABLE_CELL_STYLE,
      render: (cycle) => <>
        {[...(cycle.baselineRef ? [{ ref: cycle.baselineRef, label: 'Baseline' }] : []),
          { ref: cycle.scorecardRef, label: 'Scorecard' }, ...cycle.repairRefs.map(ref => ({ ref, label: ref }))]
          .map(item => onOpenWorkItem
            ? <button key={item.ref} type="button" className="woe__link" onClick={() => onOpenWorkItem(item.ref)}>{item.label}</button>
            : <span key={item.ref}>{item.ref} </span>)}
      </>,
    },
  ];
  return <section className="woe__quality" aria-label="Rubric stewardship">
    <div className="woe__quality-heading"><h3>Rubrics &amp; continuous improvement</h3>
      <Tooltip label="Browse the Work on everything stewardship rubric"><a className="woe__link" href="/rubrics">
        Browse rubrics{quality?.rubricRevision ? ` · stewardship revision ${quality.rubricRevision}` : ''}</a></Tooltip></div>
    <div className="woe__quality-duties">{RUBRIC_DUTIES.map(([key, title, description]) => {
      const measured = quality?.criteria[key];
      return <div key={key}><h4>{title}</h4><p>{description}</p>
        <span className="woe__state" data-state={measured ? measured.rating : 'unmeasured'}>
          {measured?.rating ?? 'Not measured'}</span>
        {measured ? onOpenWorkItem ? <Tooltip label={measured.evidence}><button type="button" className="woe__link"
          onClick={() => onOpenWorkItem(measured.scorecardRef)}>View evidence</button></Tooltip> : <span>{measured.scorecardRef}</span> : null}</div>;
    })}</div>
    {quality?.error ? <p role="alert" className="woe__warning">{quality.error}</p> :
      !quality ? <p className="woe__muted">Quality evidence has not loaded. Refresh to check this goal’s grading activity.</p> :
      <><p className="woe__muted">Recent grading evidence · since {new Date(quality.windowStart).toLocaleDateString()}
        {!quality.complete ? ' · limited recent page; older evidence may be missing' : ''}</p>
        {quality.cycles.length ? <div className="woe__table-wrap"><Table className="woe__table" ariaLabel="Grading cycles"
          columns={cycleColumns} rows={quality.cycles} getRowKey={cycle => cycle.scorecardRef} /></div>
          : <p className="woe__muted">No goal-attributed grading cycles are recorded in this window.</p>}</>}
  </section>;
}

function ProgressBar({ counts, large }: { counts: ProgressCounts | null | undefined; large?: boolean }) {
  if (!counts) return <span className="woe__muted">Not measured</span>;
  const t = total(counts);
  const seg = (n: number, key: string) => n ? <span className={'woe__seg woe__seg--' + key} style={{ width: `${(100 * n) / t}%` }} /> : null;
  return <span className={'woe__bar' + (large ? ' woe__bar--lg' : '')} role="img"
    aria-label={t ? `${counts.done} of ${t} items done` : 'No items'}
    title={`${counts.done} done · ${counts.wip} in progress · ${counts.needsHuman} need you · ${counts.blocked} blocked · ${counts.todo} to do`}>
    {seg(counts.done, 'done')}{seg(counts.wip, 'moving')}{seg(counts.needsHuman, 'you')}{seg(counts.blocked, 'stuck')}{seg(counts.todo, 'todo')}
  </span>;
}

function GoalCockpit({ data, rows, onOpenPlan, onOpenWorkItem, onOpenAgent }: {
  data: GoalDetailInput; rows: ProgressRow[];
  onOpenPlan?: (harness: string, plan: string) => void;
  onOpenWorkItem?: (id: string) => void; onOpenAgent?: (owner: string) => void;
}) {
  const goal = data.goal!;
  const view = ongoingWorkView(goal, data);
  const owner = data.agents?.find(a => a.live === true);
  const [showFinished, setShowFinished] = useQueryState('hudwoefinished', parseAsBoolean.withDefault(false));
  const [browseAll, setBrowseAll] = useQueryState('hudwoebrowse', parseAsBoolean.withDefault(false));
  const selected = rows.filter(r => r.selected);
  const measured = selected.filter(r => r.counts);
  const totals = sumCounts(measured);
  const itemTotal = total(totals);
  const finished = selected.filter(r => r.st.key === 'signoff').length;
  const visible = rows.filter(r => (browseAll || r.selected) && (showFinished || r.st.key !== 'signoff'));
  const waiting = data.waitingOnYou ?? [];
  const activity = [
    ...(data.goalData?.worklistHistory ?? []).map(e => ({ key: `history:${e.id}:${e.ref}`,
      plan: e.ref.match(/^plan:([^/]+)\/(.+)$/), workItemRef: null,
      title: e.label, detail: [rows.find(r => r.id === e.ref)?.label ?? e.ref, e.detail].filter(Boolean).join(' · '), at: e.at })),
    ...(data.activity ?? []).map(e => {
      const completed = e.status === 'done' && !!e.closedAt && Number.isFinite(Date.parse(e.closedAt));
      return { key: 'work:' + e.id, plan: null, workItemRef: e.id, title: e.title,
        detail: [completed ? 'Completed' : e.status === 'done' ? 'Done · closure unconfirmed' : e.status ?? 'Status unavailable',
          e.planSlug ?? e.harnessSlug].filter(Boolean).join(' · '), at: completed ? e.closedAt! : e.updatedAt };
    }),
  ].filter(e => e.at && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  return <div className="woe__cockpit" aria-label="Goal cockpit">
    <aside className="woe__sidebar">
      <section className="woe__health" aria-label="Goal health" data-tone={view.status.tone}>
        <h3>{view.status.label}</h3>
        <p>{goal.status === 'paused' ? 'No new work starts while this goal is paused.' :
          goal.status === 'killed' || goal.status === 'achieved' ? 'This goal is no longer placing new work.' :
          view.status.label === 'Running' ? 'The steward is working through your selected priorities.' :
          view.status.label === 'Not running' ? 'There is no live holder placing new work for this goal.' :
          'The goal’s current running state has not been verified.'}</p>
        {view.attention !== null && view.attention > 0 ? <p>{view.attention} {view.attention === 1 ? 'item needs' : 'items need'} your response.
          {goal.status === 'paused' ? ' Resuming alone will not answer them.' : ''}</p> : null}
        <GoalStatusControl goalId={goal.id} status={goal.status} effectiveStatus={data.effectiveStatus}
          holderLiveness={data.holderLiveness} variant="card" />
      </section>
      <section className="woe__overall" aria-label="Selected plan progress">
        <h3>Selected plan progress</h3>
        {measured.length ? <><strong>{itemTotal ? `${totals.done} of ${itemTotal} items done` : 'No items in measured plans'}</strong>
          <ProgressBar counts={totals} large />
          {itemTotal ? <span className="woe__muted">{percent(totals)}% of measured items complete</span> : null}</> :
          <strong>{selected.length ? 'Progress not measured' : 'No plans selected'}</strong>}
        <p className="woe__muted">{measured.length} of {selected.length} selected plans measured
          {measured.length < selected.length ? ` · ${selected.length - measured.length} not measured; totals are partial` : ''}.</p>
      </section>
      <section className="woe__needs" aria-label="Needs you">
        <h3>Needs you <span>{view.attention ?? 'Not measured'}</span></h3>
        {waiting.map(item => <article className="woe__need" key={item.id}><h4>{item.title}</h4>
          <p>{item.harnessSlug ?? item.id}</p>
          {onOpenWorkItem ? <button type="button" className="pc-ctl-act" onClick={() => onOpenWorkItem(item.id)}>Open question</button> :
            <span className="woe__muted">{item.id}</span>}</article>)}
        {!waiting.length ? <p className="woe__muted">{view.attention === 0 ? 'No items are waiting on you.' :
          'Decision details have not loaded.'}</p> : <p className="woe__muted">Showing {waiting.length}
          {view.attention !== null ? ` of ${view.attention} items` : ' items; decision total unavailable'}.</p>}
        {selected.filter(r => (r.counts?.needsHuman ?? 0) > 0).map(row => <article className="woe__need" key={row.id}>
          <h4>{row.label}</h4><p>{row.counts!.needsHuman} {row.counts!.needsHuman === 1 ? 'item needs' : 'items need'} your decision.</p>
          {row.harness && row.planSlug && onOpenPlan ? <button type="button" className="woe__link"
            onClick={() => onOpenPlan(row.harness!, row.planSlug!)}>Open plan</button> : null}</article>)}
      </section>
      <dl className="woe__facts">
        <div><dt>Plans on list</dt><dd>{selected.length}</dd></div>
        <div><dt>Awaiting sign-off</dt><dd>{finished}</dd></div>
        <div className="woe__fact-wide"><dt>Recent spend</dt><dd>{view.spend ?? 'Spend unavailable'}</dd></div>
        <div className="woe__fact-wide"><dt>Spend cap</dt><dd>{view.budget ?? 'Budget unavailable'}</dd></div>
        <div className="woe__fact-wide"><dt>Steward</dt><dd>{owner ? onOpenAgent ?
          <button type="button" className="woe__link" onClick={() => onOpenAgent(owner.ownerId)}>Ask steward</button> :
          'Steward available' : 'Live steward unavailable'}</dd></div>
      </dl>
    </aside>
    <div className="woe__main">
      <RubricStewardship data={data} onOpenWorkItem={onOpenWorkItem} />
      <section className="woe__priority" aria-label="Priority plans">
        <div className="woe__section-heading"><div><h3>{browseAll ? 'All available plans' : 'Plans in priority order'}</h3>
          <p className="woe__muted">{selected.length} selected · {finished} awaiting sign-off</p></div>
          <div className="woe__actions"><button type="button" className="pc-ctl-act" aria-pressed={showFinished}
            onClick={() => void setShowFinished(!showFinished)}>{showFinished ? 'Hide finished' : 'Show finished'}</button>
            <button type="button" className="pc-ctl-act" aria-pressed={browseAll}
              onClick={() => void setBrowseAll(!browseAll)}>{browseAll ? 'Show selected plans' : 'Browse all plans'}</button></div></div>
        <ol className="woe__priority-list">{visible.map(row => <li key={row.id} data-testid="ongoing-priority-row" data-worklist-id={row.id}>
          <span className="woe__rank">{row.selected ? String(row.rank + 1).padStart(2, '0') : '—'}</span>
          <div className="woe__priority-name">{row.harness && row.planSlug && onOpenPlan ?
            <button type="button" className="woe__plan-link" onClick={() => onOpenPlan(row.harness!, row.planSlug!)}>{row.label}</button> :
            <strong>{row.label}</strong>}<p>{row.selected ? row.nextStep ?? row.st.why : `Outside this worklist · ${row.st.why}`}</p></div>
          <div className="woe__priority-progress"><ProgressBar counts={row.counts} />
            {row.counts ? <span className="woe__num">{row.counts.done}/{total(row.counts)}</span> : null}</div>
          <span className="woe__state" data-state={row.st.key}><span aria-hidden />{row.st.label}</span>
        </li>)}</ol>
        {!visible.length ? <p className="woe__empty">{selected.length ? 'Selected plans are awaiting sign-off. Show finished to inspect them.' :
          'No plans selected. Edit priorities to choose what the steward works on.'}</p> : null}
      </section>
      <section className="woe__activity" aria-label="Recent activity">
        <div className="woe__section-heading"><h3>Recent activity on this goal</h3><span className="woe__muted">Goal history and work items</span></div>
        {data.goalData?.historyError ? <p role="alert" className="woe__warning">History unavailable: {data.goalData.historyError}</p> : null}
        {activity.length ? <ol>{activity.slice(0, 12).map(e => <li key={e.key}>
          <time dateTime={e.at!}>{new Date(e.at!).toLocaleString()}</time><div>{e.plan && onOpenPlan ?
            <button type="button" className="woe__link" onClick={() => onOpenPlan(e.plan![1], e.plan![2])}>{e.title}</button> :
            e.workItemRef && onOpenWorkItem ? <button type="button" className="woe__link"
              onClick={() => onOpenWorkItem(e.workItemRef!)}>{e.title}</button> : <strong>{e.title}</strong>}
            {e.detail ? <p>{e.detail}</p> : null}</div></li>)}</ol> :
          <p className="woe__muted woe__activity-empty">No dated activity is available in this recent snapshot.</p>}
        {activity.length ? <p className="woe__muted woe__activity-empty">Showing {Math.min(12, activity.length)} recent entries; older activity may be outside this snapshot.</p> : null}
      </section>
    </div>
  </div>;
}

export default function WorkOnEverythingPanel({ data, nowMs, onClose, onOpenPlan, onOpenWorkItem, onOpenAgent, refresh }: {
  data: GoalDetailInput; nowMs: number; onClose: () => void; refresh: () => void;
  onOpenPlan?: (harness: string, plan: string) => void;
  onOpenWorkItem?: (id: string) => void; onOpenAgent?: (owner: string) => void;
}) {
  const goal = data.goal!;
  const [query, setQuery] = useQueryState('hudwoesearch', parseAsString.withDefault(''));
  const [scope, setScope] = useQueryState('hudwoescope', parseAsStringEnum([...SCOPES]).withDefault('all'));
  const [stateFilter, setStateFilter] = useQueryState('hudwoestate', parseAsStringEnum<PlanStateKey>([...STATE_KEYS]));
  const [sort, setSort] = useQueryState('hudwoesort', parseAsStringEnum([...SORTS]).withDefault('left'));
  const [showEmpty, setShowEmpty] = useQueryState('hudwoeempty', parseAsBoolean.withDefault(false));
  const [reviewOpen, setReviewOpen] = useQueryState('hudwoereview', parseAsBoolean.withDefault(false));
  const [settingsOpen, setSettingsOpen] = useQueryState('hudwoesettings', parseAsBoolean.withDefault(false));
  const [editMode, setEditMode] = useQueryState('hudwoeedit', parseAsBoolean.withDefault(false));
  const [draft, setDraft] = useState<WorklistDraft | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [awaitingVersion, setAwaitingVersion] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const unavailable = loadProblem(data);
  // Declared source identifies this collection; titles are freely editable.
  const collection = unavailable ? undefined : Object.values(data.goalData?.collections ?? {}).find((c) =>
    c.selection.ok && c.selection.configured && c.selection.collection.source === 'active-workspace-plans');
  const configured = collection?.selection.ok && collection.selection.configured ? collection.selection : null;
  const version = configured?.policyVersion ?? null;
  const rows = progressRows(collection ? draftRows(collection, draft) : []);
  const included = rows.filter((r) => r.selected);
  const changes = collection ? worklistChanges(collection, draft) : [];
  const stale = !!draft && draft.version !== version && awaitingVersion === null;
  const locked = saving || awaitingVersion !== null;
  const view = ongoingWorkView(goal, data);
  const owner = data.agents?.find((a) => a.live === true);
  const before = collection?.rows.filter((r) => r.selected) ?? [];
  const countable = rows.filter((r) => showEmpty || r.st.key !== 'empty');
  const scoped = countable.filter((r) => inScope(r, scope));
  const measuredScope = scoped.filter(r => r.counts);
  const totals = sumCounts(scoped);
  const byState = (key: PlanStateKey) => scoped.filter((r) => r.st.key === key);
  const visible = filterAndSort(rows, { scope, state: stateFilter, showEmpty, query, sort });
  const series = completionSeries(data, nowMs);
  const seriesMax = Math.max(1, ...(series ?? []).map((d) => d.done));
  const emptyHidden = rows.filter((r) => r.st.key === 'empty').length;

  useEffect(() => {
    if (awaitingVersion !== null && version === awaitingVersion) {
      setDraft(null); setAwaitingVersion(null); setReason('');
      setNotice('Worklist applied. The steward uses it for new work; running tasks keep their owners.');
    } else if (awaitingVersion !== null && version !== null && version > awaitingVersion) {
      setAwaitingVersion(null);
      setProblem('A newer edit arrived before confirmation. Your draft is kept; compare it with the current worklist before continuing.');
    }
  }, [version, awaitingVersion]);

  function stage(next: WorklistDraft | null) {
    if (!collection || locked) return;
    setDraft(worklistChanges(collection, next).length ? next : null);
    setProblem(null); setNotice(null);
  }
  async function apply() {
    if (!configured || !draft || !changes.length || stale || busy.current || locked) return;
    busy.current = true; setSaving(true); setProblem(null);
    try {
      const response = await fetch('/api/admin/goals/set-property', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: goal.id, property: configured.collection.policy,
          value: draft.policy, expectedVersion: draft.version, reason: reason.trim() || undefined }) });
      const result = await response.json();
      if (!response.ok || result.ok === false || result.error) {
        throw new Error(result.message ?? result.detail ??
          (typeof result.error === 'string' ? result.error : result.error?.message) ?? ('HTTP ' + response.status));
      }
      if (typeof result.version !== 'number') {
        throw new Error('The save did not return a version. Refresh to check the outcome; your draft is kept.');
      }
      setAwaitingVersion(result.version); void setReviewOpen(false);
      setNotice('Saved. Waiting for the confirmed worklist…');
      refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error)); refresh();
    } finally { busy.current = false; setSaving(false); }
  }
  function discard() {
    if (locked) return;
    setDraft(null); setReason(''); setProblem(null); void setReviewOpen(false);
    setNotice('Draft discarded. The saved worklist is unchanged.');
  }

  const tiles: Array<{ key: PlanStateKey | null; label: string; value: string; unit: string; sub: string }> = [
    { key: null, label: 'Work in this scope', value: measuredScope.length ? totals.done.toLocaleString() : 'Not measured',
      unit: measuredScope.length ? `of ${total(totals).toLocaleString()} items done` : '',
      sub: measuredScope.length ? `${percent(totals)}% of measured items complete across ${measuredScope.length} plans` : 'Plan progress is unavailable' },
    { key: 'you', label: STATE_LABEL.you, value: String(totals.needsHuman), unit: 'items', sub: `in ${byState('you').length} plans` },
    { key: 'stuck', label: STATE_LABEL.stuck, value: String(byState('stuck').length), unit: 'plans', sub: `${totals.blocked} items wait on other items` },
    { key: 'moving', label: STATE_LABEL.moving, value: String(totals.wip), unit: 'items', sub: `in ${byState('moving').length} plans` },
    { key: 'idle', label: STATE_LABEL.idle, value: String(byState('idle').length), unit: 'plans',
      sub: `${byState('idle').reduce((n, r) => n + (r.counts?.todo ?? 0), 0)} items ready to start` },
    { key: 'signoff', label: STATE_LABEL.signoff, value: String(byState('signoff').length), unit: 'plans', sub: 'all items done' },
  ];

  const rowChange = (row: ProgressRow) => changes.find((change) => change.id === row.id);
  const worklistColumns: TableColumn<ProgressRow>[] = [
    {
      key: 'worklist', header: 'Worklist', headerStyle: WOE_TABLE_HEADER_STYLE, cellStyle: WOE_TABLE_CELL_STYLE,
      render: row => <span className="woe__scope-cell">{row.selected
        ? <Tooltip label={'In the worklist (priority ' + (row.rank + 1) + '). Click to remove.'}>
          <button type="button" className="woe__scope woe__scope--in" disabled={locked} aria-label={'Remove ' + row.label}
            onClick={() => stage(toggleDraft(collection!, draft, row.id))}><span className="woe__scope-content">#{row.rank + 1}</span></button></Tooltip>
        : <Tooltip label="Not in the worklist. Click to add.">
          <button type="button" className="woe__scope" disabled={locked} aria-label={'Add ' + row.label}
            onClick={() => stage(toggleDraft(collection!, draft, row.id))}><span className="woe__scope-content"><Plus size={12} aria-hidden />Add</span></button></Tooltip>}
        {row.selected && sort === 'rank' ? <span className="woe__reorder">
          <button type="button" disabled={locked || row.rank === 0} aria-label={'Move ' + row.label + ' up'}
            onClick={() => stage(moveDraft(collection!, draft, row.id, -1))}><span className="woe__reorder-icon"><ArrowUp size={12} aria-hidden /></span></button>
          <button type="button" disabled={locked || row.rank === included.length - 1} aria-label={'Move ' + row.label + ' down'}
            onClick={() => stage(moveDraft(collection!, draft, row.id, 1))}><span className="woe__reorder-icon"><ArrowDown size={12} aria-hidden /></span></button>
        </span> : null}
        {rowChange(row) ? <span className="woe__change">{rowChange(row)!.label}</span> : null}</span>,
    },
    {
      key: 'plan', header: 'Plan', headerStyle: WOE_TABLE_HEADER_STYLE, cellStyle: WOE_TABLE_CELL_STYLE,
      render: row => <div className="woe__plan">{row.harness && row.planSlug && onOpenPlan
        ? <button type="button" className="woe__plan-link" onClick={() => onOpenPlan(row.harness!, row.planSlug!)}>{row.label}</button>
        : <strong>{row.label}</strong>}
        <small>{[row.harness, row.planSlug].filter(Boolean).join(' · ') || row.id}</small></div>,
    },
    {
      key: 'progress', header: 'Progress', headerStyle: WOE_TABLE_HEADER_STYLE, cellStyle: WOE_TABLE_CELL_STYLE,
      render: row => <span className="woe__progress-cell"><ProgressBar counts={row.counts} />
        {row.counts ? <span className="woe__num">{row.counts.done}/{total(row.counts)}</span> : null}</span>,
    },
    {
      key: 'state', header: 'State', headerStyle: WOE_TABLE_HEADER_STYLE, cellStyle: WOE_TABLE_CELL_STYLE,
      render: row => <span className="woe__state" data-state={row.st.key}><span aria-hidden />{row.st.label}</span>,
    },
    {
      key: 'why', header: 'Why / next step', headerStyle: WOE_TABLE_HEADER_STYLE, cellStyle: WOE_TABLE_CELL_STYLE,
      render: row => <span className="woe__why">{row.selected ? row.nextStep ?? row.st.why : row.st.why}</span>,
    },
  ];

  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={goal.title}
    description="Progress across every plan" srOnlyTitle contentStyle={{ width: 'min(1540px, 96vw)',
      maxWidth: 'none', height: 'min(940px, 94dvh)', padding: 0, display: 'flex', flexDirection: 'column' }}>
    <section className="woe" data-testid="work-on-everything-console" aria-label="Work on everything progress">
      <header className="woe__header"><div className="woe__identity"><span className="woe__mark"><InfinityIcon size={24} aria-hidden /></span>
        <div><div className="woe__title"><h2>{goal.title}</h2><span className={'hud__chip hud__chip--' + view.status.tone}>{view.status.label}</span></div>
        <p>{editMode ? 'Draft your worklist changes, then review and apply.' : 'Goal health, your priorities and continuous improvement.'}</p></div></div>
        <div className="woe__actions">
          {editMode ? <GoalStatusControl goalId={goal.id} status={goal.status}
            effectiveStatus={data.effectiveStatus} holderLiveness={data.holderLiveness} variant="card" /> : null}
          <button className="pc-ctl-act" type="button" aria-pressed={editMode} onClick={() => void setEditMode(!editMode)}>
            {editMode ? 'Back to overview' : `Edit priorities${changes.length ? ` · ${changes.length} pending` : ''}`}</button>
          <button className="pc-ctl-act" type="button" onClick={() => void setSettingsOpen(true)}><span><Settings2 size={14} />Settings</span></button>
          <button className="pc-ctl-act" type="button" aria-label="Close ongoing work" onClick={onClose}><X size={15} /></button>
        </div></header>
      {unavailable || !collection ? <div className="woe__body"><div className="woe__unavailable" role="alert">
        <h3>{unavailable?.title ?? 'Plans could not be loaded'}</h3><p>{unavailable?.detail ?? 'Retry; your saved worklist is unchanged.'}</p>
        <button type="button" className="pc-ctl-act" onClick={refresh}><span><RefreshCw size={14} aria-hidden />Retry</span></button></div></div> :
      <div className="woe__body">
        {!editMode ? <GoalCockpit data={data} rows={progressRows(collection.rows)} onOpenPlan={onOpenPlan}
          onOpenWorkItem={onOpenWorkItem} onOpenAgent={onOpenAgent} /> : <>
        <div className="woe__kpis" role="group" aria-label="Totals">{tiles.map((t) =>
          <button type="button" key={t.label} className="woe__kpi" aria-pressed={t.key !== null && stateFilter === t.key}
            onClick={() => void setStateFilter(t.key === null || stateFilter === t.key ? null : t.key)}>
            <span className="woe__kpi-content">
              <span className="woe__kpi-label">{t.key ? <i className={'woe__dot woe__dot--' + t.key} aria-hidden /> : null}{t.label}</span>
              <span className="woe__kpi-value">{t.value} <small>{t.unit}</small></span>
              {t.key === null && measuredScope.length ? <ProgressBar counts={totals} large /> : null}
              <span className="woe__kpi-sub">{t.sub}</span>
            </span></button>)}</div>
        {measuredScope.length < scoped.length ? <p className="woe__filter-note">{scoped.length - measuredScope.length} plans have unmeasured progress; totals count measured plans only.</p> : null}
        <RubricStewardship data={data} onOpenWorkItem={onOpenWorkItem} />
        <div className="woe__chart"><h3>Work finished per day for this goal{series ? ` (last ${series.length} days)` : ''}</h3>
          {series ? <svg viewBox={`0 0 ${series.length * 36} 96`} preserveAspectRatio="none" role="img"
            aria-label={`${series.reduce((n, d) => n + d.done, 0)} work items finished in the last ${series.length} days`}>
            {series.map((d, i) => <rect key={d.day} x={i * 36 + 4} width={28} rx={3}
              y={80 - (d.done / seriesMax) * 76} height={Math.max(1, (d.done / seriesMax) * 76)} className="woe__chart-bar">
              <title>{`${d.day}: ${d.done} finished`}</title></rect>)}
            {series.map((d, i) => i % 5 === 0 || i === series.length - 1 ? <text key={'t' + d.day} x={i * 36 + 18} y={94}
              textAnchor="middle" className="woe__chart-label">{d.day.slice(5).replace('-', '/')}</text> : null)}
          </svg> : <p className="woe__muted">Daily history needs a newer server build.</p>}</div>
        {configured?.seededFromList ? <p className="woe__seeded" role="status">Your worklist starts from the {included.length} plans
          saved on this goal. The first change you apply saves it as your own pick list.</p> : null}
        <div className="woe__toolbar">
          <div className="woe__seg-group" role="group" aria-label="Scope">{SCOPES.map((s) => {
            const n = countable.filter((r) => inScope(r, s)).length;
            return <button type="button" key={s} aria-pressed={scope === s} onClick={() => void setScope(s)}>
              {s === 'all' ? `All plans · ${n}` : s === 'in' ? `In worklist · ${n}` : `Not in worklist · ${n}`}</button>;
          })}</div>
          <label className="woe__toggle"><Checkbox ariaLabel="Show plans with no items" checked={showEmpty}
            onChange={checked => void setShowEmpty(checked)} /> Show plans with no items</label>
          <Select ariaLabel="Sort plans" value={sort} onChange={value => void setSort(value as typeof sort)}
            triggerClassName="h-select-trigger woe__sort"
            options={SORTS.map(s => ({ value: s, label: SORT_LABEL[s] }))} />
          <label className="woe__search"><TextInput leading={<Search size={15} />} style={{ width: '100%' }}
            aria-label="Search plans" placeholder="Search plans…" value={query}
            onChange={(e) => void setQuery(e.target.value)} /></label>
        </div>
        {stateFilter ? <p className="woe__filter-note">Showing only “{STATE_LABEL[stateFilter]}”.
          <button type="button" className="woe__link" onClick={() => void setStateFilter(null)}>Clear filter</button></p> : null}
        <div className="woe__table-wrap"><Table className="woe__table" ariaLabel="Plans" columns={worklistColumns}
          rows={visible} getRowKey={row => row.id}
          rowClassName={row => (row.selected ? '' : 'woe__row--out') + (rowChange(row) ? ' woe__row--changed' : '')}
          rowTestId={() => 'ongoing-worklist-row'}
          rowDataAttributes={row => ({ 'data-worklist-id': row.id })} />
          {!visible.length ? <p className="woe__empty">{rows.length ? 'No plans match these filters.' : 'No active plans are available.'}</p> : null}</div>
        <div className="woe__table-foot"><span className="woe__legend">{(['done', 'moving', 'you', 'stuck', 'todo'] as const).map((k) =>
          <span key={k}><i className={'woe__dot woe__dot--' + k} aria-hidden />{{ done: 'Done', moving: 'In progress', you: 'Needs you', stuck: 'Blocked', todo: 'To do' }[k]}</span>)}</span>
          <span>Showing {visible.length} of {rows.length} plans{!showEmpty && emptyHidden ? ` · ${emptyHidden} with no items hidden` : ''}</span></div>
        {stale ? <div className="woe__warning" role="alert">The worklist changed while you were editing. Your draft is kept. Discard it to start from the current worklist.</div> : null}
        {problem ? <p className="woe__warning" role="alert">Could not apply: {problem}</p> : null}
        {notice ? <p className="woe__notice" role="status">{notice}</p> : null}
        {changes.length ? <div className="woe__draft-bar" role="region" aria-label="Pending changes">
          <span className="woe__draft-count">{changes.length}</span><div><strong>{changes.length} {changes.length === 1 ? 'plan' : 'plans'} changed</strong>
            <p>Draft only. Review before changing the worklist.</p></div>
          <div className="woe__actions"><button type="button" className="pc-ctl-act" disabled={locked} onClick={discard}>Discard</button>
            <button type="button" className="pc-ctl-act pc-ctl-act--primary" disabled={locked || stale}
              onClick={() => void setReviewOpen(true)}>Review &amp; apply</button></div></div> :
          <div className="woe__idle"><Check size={15} aria-hidden /><span>No pending changes. Add or remove plans to start a draft.</span></div>}
        </>}
      </div>}
      <footer className="woe__footer"><span><span className={'woe__live-dot' + (owner ? ' woe__live-dot--available' : '')} aria-hidden />{view.status.label} · {owner ? 'Steward available' : 'Live steward unavailable'}</span>
        <span>Changes apply to new work. Running tasks stay assigned.</span></footer>
    </section>
    <Modal open={reviewOpen && !!changes.length} onOpenChange={(open) => { if (!saving) void setReviewOpen(open); }}
      title="Review worklist changes" description="Compare scope and priority before applying" contentStyle={{ width: 'min(780px, 94vw)' }}>
      <div className="woe__review"><p>The steward uses the new scope and priority for future work. Already running tasks keep their current owners.</p>
        <div className="woe__diff"><div><h4>Now</h4><ol>{before.map((r) => <li key={r.id}>{r.label}</li>)}</ol></div>
          <div><h4>After apply</h4><ol>{included.map((r) => <li key={r.id} className={changes.some((c) => c.id === r.id) ? 'woe__diff-change' : ''}>{r.label}</li>)}</ol></div></div>
        <h4>Effect on agents</h4><p>Only plans in the worklist get new work from this goal. Current owners are kept.</p>
        {changes.filter((c) => c.label === 'Removing').map((c) => <p key={c.id}>
          {rows.find((r) => r.id === c.id)?.label}: no new work from this goal.</p>)}
        <label className="woe__reason">Why? <small>Optional. Saved with this edit and shared in plan history.</small>
          <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3}
            placeholder="e.g. Desktop needs to ship before Friday’s demo" /></label>
        {stale ? <p role="alert">The saved worklist changed. Discard this draft and review the current list.</p> : null}
        {problem ? <p role="alert">{problem}</p> : null}
        <div className="woe__actions"><button type="button" className="pc-ctl-act" disabled={locked} onClick={() => void setReviewOpen(false)}>Keep editing</button>
          <button type="button" className="pc-ctl-act pc-ctl-act--primary" disabled={locked || stale} onClick={() => void apply()}>{saving ? 'Applying…' : 'Apply changes'}</button></div>
      </div>
    </Modal>
    <Modal open={settingsOpen} onOpenChange={(open) => void setSettingsOpen(open)} title="Ongoing work settings">
      <GoalSettingsSection goalId={goal.id} settings={data.launchSettings} settingsInvalid={data.launchSettingsInvalid}
        settingsUnknownKeys={data.launchSettingsUnknownKeys} options={data.launchSettingsOptions} defaults={data.launchSettingsDefaults} />
    </Modal>
  </Modal>;
}
