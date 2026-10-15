import { useCallback, useEffect, useRef, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryStates } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@papercusp/flags/client';
import { TextInput } from '@papercusp/ui-primitives/controls';
import { Button } from '@/app/harness/Button';
import { Select } from '@/app/harness/Select';
import { ComboboxMenu } from '@/app/harness/Combobox';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';
import { seedOperatorChatDraft } from '@/app/_components/inbox/chat-seed';
import { encodeScopedRef } from '@/app/_components/chat/chat-ref-popup-params';
import type { toReportFull, toReportSummary } from '@papercusp/operator-core/lib/agent-tools/reports/_shared';
import type { ReportKind, ReportVisibility, ReportSubjectKind } from '@papercusp/operator-core/lib/report-library';
import './ReportsRoute.css';

type Summary = ReturnType<typeof toReportSummary>;
type Full = ReturnType<typeof toReportFull>;
const kinds: ReportKind[] = ['audit', 'review', 'analysis', 'postmortem', 'status-digest', 'proposal', 'other'];
const visibility: ReportVisibility[] = ['owner', 'pot', 'workspace'];
const subjects: ReportSubjectKind[] = ['pot', 'plan', 'work_item', 'fleet', 'goal', 'repo', 'external', 'none'];
const kindLabels: Record<ReportKind, [string, string]> = {
  audit: ['Audit', 'Audits'], review: ['Review', 'Reviews'], analysis: ['Analysis', 'Analyses'],
  postmortem: ['Postmortem', 'Postmortems'], 'status-digest': ['Digest', 'Digests'],
  proposal: ['Proposal', 'Proposals'], other: ['Other', 'Other'],
};
const parsers = { kind: parseAsString.withDefault(''), subject: parseAsString.withDefault(''),
  pot: parseAsString.withDefault(''), vis: parseAsString.withDefault(''), q: parseAsString.withDefault(''),
  tag: parseAsString.withDefault(''), since: parseAsString.withDefault(''), sel: parseAsString.withDefault(''),
  hist: parseAsBoolean.withDefault(false), chat: parseAsBoolean.withDefault(false),
  opcv: parseAsString.withDefault('chat') };

function published(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function relativeTime(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return value;
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function subjectLabel(item: Summary) {
  return item.subject.label || item.subject.ref || (item.subject.kind === 'none' ? 'General' : item.subject.kind.replace('_', ' '));
}

function subjectKey(item: Summary) {
  return `${item.subject.kind}${item.subject.ref ? `:${item.subject.ref}` : ''}`;
}

/** Reuse the same URL encoding and popup hosts as chat work references. */
function subjectHref(item: Summary, ref = item.subject.ref) {
  if (!ref) return null;
  const params = new URLSearchParams(window.location.search);
  if (/^(WI|EI|F)-/.test(ref) || item.subject.kind === 'work_item') params.set('wpop', encodeScopedRef(item.origin.harness_slug || '', ref));
  else if (item.subject.kind === 'plan') params.set('wppop', encodeScopedRef(item.origin.harness_slug || '', ref));
  else return null;
  return `${window.location.pathname}?${params}`;
}

function KindBadge({ kind }: { kind: ReportKind }) {
  return <span className={`reports-kind reports-kind--${kind}`}>{kindLabels[kind][0]}</span>;
}

function ReportReader({ report, onSelect, historyOpen, onHistoryChange, onFollowUp }: {
  report: Full; onSelect: (id: string) => void; historyOpen: boolean;
  onHistoryChange: () => void; onFollowUp: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [compare, setCompare] = useState(false);
  const [outline, setOutline] = useState<{ id: string; text: string; level: number; node: HTMLElement }[]>([]);
  const [reading, setReading] = useState({ progress: 0, active: '' });
  const scroller = useRef<HTMLDivElement>(null);
  const headings = useRef<HTMLElement[]>([]);
  const history = useSyncQuery<Summary>({ queryName: 'reports.lineage', args: { lineageId: report.lineage_id }, enabled: true });
  const editions = [...history.data].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.report_id.localeCompare(b.report_id));
  const edition = editions.findIndex(item => item.report_id === report.report_id);
  const previous = useSyncQuery<Full>({ queryName: 'reports.get', args: { reportId: report.supersedes_report_id || '__none__' },
    enabled: compare && !!report.supersedes_report_id });
  const previousReport = previous.data.find(item => item.report_id === report.supersedes_report_id);
  const updateReading = useCallback(() => {
    const root = scroller.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top + 32;
    const active = [...headings.current].reverse().find(node => node.getBoundingClientRect().top <= top) || headings.current[0];
    const range = root.scrollHeight - root.clientHeight;
    setReading({ progress: range > 0 ? Math.round(Math.min(1, Math.max(0, root.scrollTop / range)) * 100) : 100, active: active?.id || '' });
  }, []);
  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateReading);
    if (scroller.current) observer?.observe(scroller.current);
    window.addEventListener('resize', updateReading);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateReading); };
  }, [updateReading]);
  const onParsed = useCallback((root: HTMLElement) => {
    // Use the actual Markdown renderer's headings: code fences, Mermaid and
    // duplicate headings must not create a second, disagreeing Markdown parser.
    headings.current = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
    const seen = new Set<string>();
    const next = headings.current.map((node, i) => {
      let id = node.id || `report-section-${i}`;
      if (seen.has(id)) id = `${id}-${i}`;
      seen.add(id); node.id = id;
      return { id, text: node.textContent || 'Section', level: Number(node.tagName[1]), node };
    });
    setOutline(next); updateReading();
  }, [updateReading]);
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(`# ${report.title}\n\n${report.body_md}`);
      setCopied(true); setCopyError(false);
    } catch { setCopyError(true); }
  }
  const href = subjectHref(report);
  const readMinutes = Math.max(1, Math.ceil(report.body_md.split(/\s+/).filter(Boolean).length / 220));
  return <article className="reports-reading-grid">
    <div className="reports-article-main" ref={scroller} onScroll={updateReading}>
      <div className="reports-breadcrumb"><KindBadge kind={report.kind} /><span>about</span>
        {href ? <a className="reports-chip" href={href}>{subjectLabel(report)} ↗</a> : <span className="reports-chip">{subjectLabel(report)}</span>}
      </div>
      <h2>{report.title}</h2>
      <div className="reports-byline"><span>Written by <strong>{report.origin.author_owner_id || 'Unknown author'}</strong></span>
        <time dateTime={report.published_at} title={published(report.published_at)}>{published(report.published_at)}</time>
        <span>{readMinutes} min read</span><span>{report.visibility === 'owner' ? 'Only you' : report.visibility === 'pot' ? 'Shared with pot' : 'Shared with workspace'}</span>
      </div>
      <div className="reports-actions">
        <Select ariaLabel="Report edition" value={report.report_id} options={editions.length ? editions.map((item, i) => ({ value: item.report_id,
          label: `Edition ${i + 1} of ${editions.length}${i === editions.length - 1 ? ' · latest' : ''} — ${item.summary || item.title}` }))
          : [{ value: report.report_id, label: history.loading ? 'Loading editions…' : report.supersedes_report_id ? 'Revised edition' : 'Original edition' }]} onChange={onSelect} />
        <Button onClick={() => { void copyReport(); }}>{copied ? 'Copied' : 'Copy as Markdown'}</Button>
        <Button onClick={onFollowUp}>Ask a follow-up</Button>
        <Button onClick={onHistoryChange} aria-expanded={historyOpen}>Version history</Button>
        {report.supersedes_report_id && <><Button onClick={() => onSelect(report.supersedes_report_id!)}>Previous version</Button>
          <Button onClick={() => setCompare(value => !value)} aria-expanded={compare}>{compare ? 'Close comparison' : 'Compare editions'}</Button></>}
      </div>
      {copyError && <p role="alert">Could not copy the report. Try copying the text directly.</p>}
      {history.error && <div role="alert">Could not load editions. <Button onClick={history.invalidate}>Retry editions</Button></div>}
      {report.retired_at && <p role="status">This report was retired. Its saved citation remains readable.</p>}
      {report.summary && <section className="reports-summary" aria-label="Report summary"><h3>Summary</h3><p>{report.summary}</p></section>}
      {historyOpen && <section className="reports-editions" aria-label="Version history"><h3>Version history</h3>
        {history.loading && <p role="status">Loading history…</p>}
        {editions.map((version, i) => <button type="button" key={version.report_id} className="reports-history-item" onClick={() => onSelect(version.report_id)}
          aria-current={version.report_id === report.report_id ? 'true' : undefined}><strong>Edition {i + 1} · {version.title}</strong>
          <span>{version.summary}</span><small>{published(version.published_at)}{version.retired_at ? ' · retired' : ''}</small></button>)}
      </section>}
      {compare && <section className="reports-comparison" aria-label="Edition comparison"><h3>Compare editions</h3>
        {previous.loading && <p role="status">Loading previous edition…</p>}
        {previous.error && <div role="alert">Could not load the previous edition. <Button onClick={previous.invalidate}>Retry comparison</Button></div>}
        {!previous.loading && !previous.error && !previousReport && <p>The previous edition is unavailable.</p>}
        {previousReport && <div className="reports-comparison-columns"><section><h4>Previous · {previousReport.title}</h4><MarkdownPreview value={previousReport.body_md} /></section>
          <section><h4>Selected · {report.title}</h4><MarkdownPreview value={report.body_md} /></section></div>}
      </section>}
      <MarkdownPreview value={report.body_md} className="reports-body" onParsed={onParsed} />
    </div>
    <aside className="reports-outline">
      <nav aria-label="On this page"><h3>On this page</h3>
        {!outline.length && <p className="reports-muted">No section headings</p>}
        {outline.map(item => <a key={item.id} href={`#${encodeURIComponent(item.id)}`} style={{ paddingLeft: `${12 + Math.max(0, item.level - 2) * 10}px` }}
          aria-current={reading.active === item.id ? 'location' : undefined} onClick={event => { event.preventDefault();
            const root = scroller.current;
            if (root) root.scrollTo({ top: root.scrollTop + item.node.getBoundingClientRect().top - root.getBoundingClientRect().top - 24,
              behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
            setReading(value => ({ ...value, active: item.id })); }}>{item.text}</a>)}
      </nav>
      <progress aria-label="Reading progress" max={100} value={reading.progress} /><span className="reports-muted">{reading.progress}% read</span>
      {!!report.tags.length && <section><h3>Tags</h3><div className="reports-tags">{report.tags.map(tag => {
        const tagHref = /^(WI|EI|F)-/.test(tag) ? subjectHref(report, tag) : null;
        const params = new URLSearchParams(window.location.search); params.set('tag', tag);
        return <a key={tag} className="reports-chip" href={tagHref || `${window.location.pathname}?${params}`}>{tag}</a>;
      })}</div></section>}
      <section><h3>Details</h3><dl className="reports-metadata">
        <div><dt>Kind</dt><dd>{report.kind}</dd></div><div><dt>Written by</dt><dd>{report.origin.author_owner_id || 'Unknown author'}</dd></div>
        <div><dt>Pot</dt><dd>{report.origin.harness_slug || 'Workspace'}</dd></div><div><dt>Subject</dt><dd>{subjectLabel(report)}</dd></div>
        <div><dt>Visibility</dt><dd>{report.visibility}</dd></div><div><dt>Published</dt><dd>{published(report.published_at)}</dd></div>
        <div><dt>Source</dt><dd>{report.source}</dd></div><div><dt>Report ID</dt><dd>{report.report_id}</dd></div>
      </dl></section>
      {edition >= 0 && <p className="reports-muted">Edition {edition + 1} of {editions.length}</p>}
    </aside>
  </article>;
}

export default function ReportsRoute() {
  const enabled = useFlag(FLAGS.REPORTS_LIBRARY);
  return enabled ? <ReportsLibrary /> : <main className="reports-page"><h1>Reports</h1><p>Reports library is disabled.</p></main>;
}

export function ReportsLibrary() {
  const [state, setState] = useQueryStates(parsers, { history: 'push' });
  const [moreFilters, setMoreFilters] = useState(false);
  const [readError, setReadError] = useState(false);
  const [read, setRead] = useState<Record<string, boolean>>({});
  const search = useRef<HTMLInputElement>(null);
  const [subjectKind, ...subjectRef] = state.subject.split(':');
  const kind = kinds.find(k => k === state.kind);
  const vis = visibility.find(v => v === state.vis);
  const subject = subjects.find(s => s === subjectKind);
  const since = state.since && !Number.isNaN(Date.parse(state.since)) ? new Date(state.since).toISOString() : undefined;
  const library = useSyncQuery<Summary>({ queryName: 'reports.list', args: {
    ...(kind ? { kind } : {}), ...(vis ? { visibility: vis } : {}),
    ...(subject ? { subject: { kind: subject, ...(subjectRef.length ? { ref: subjectRef.join(':') } : {}) } } : {}),
    ...(state.pot ? { originHarnessSlug: state.pot } : {}), ...(state.q ? { query: state.q } : {}),
    ...(state.tag ? { tags: state.tag.split(',').map(t => t.trim()).filter(Boolean) } : {}),
    ...(since ? { since } : {}), limit: 200,
  } });
  // One bounded catalog supplies real subjects and counts, independent of the
  // current filters. At the query ceiling these are explicitly lower bounds.
  const catalog = useSyncQuery<Summary>({ queryName: 'reports.list', args: { limit: 200 } });
  const preferences = useSyncQuery<{ payload: Record<string, unknown> }>({ queryName: 'userPreferences.current' });
  const detail = useSyncQuery<Full>({ queryName: 'reports.get', args: { reportId: state.sel || '__none__' }, enabled: !!state.sel });
  // A disabled or changing subscription may still hold its previous snapshot.
  const report = state.sel ? detail.data.find(row => row.report_id === state.sel) : undefined;
  const marked = useRef(new Set<string>());
  useEffect(() => {
    if (!report || detail.loading || detail.error || preferences.loading || preferences.error) return;
    const key = `reportsRead.${report.report_id}`;
    if (preferences.data[0]?.payload?.[key] || marked.current.has(report.report_id)) return;
    marked.current.add(report.report_id);
    const id = report.report_id;
    // Flat keys let concurrent opens merge through the existing per-user,
    // per-workspace preference store without replacing another window's map.
    void fetch('/api/user/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: true }) })
      .then(response => { if (!response.ok) throw new Error('read-marker'); setRead(value => ({ ...value, [id]: true })); setReadError(false); })
      .catch(() => setReadError(true));
  }, [report, detail.loading, detail.error, preferences.loading, preferences.error, preferences.data]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey
        || target instanceof Element && (target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"]'))) return;
      event.preventDefault(); search.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const change = (key: keyof typeof state, value: string) => { void setState({ [key]: value }); };
  const options = (values: string[]) => [{ value: '__all__', label: 'All' }, ...values.map(value => ({ value, label: value }))];
  const select = (id: string) => { void setState({ sel: id }); };
  const counts = Object.fromEntries(kinds.map(value => [value, catalog.data.filter(item => item.kind === value).length]));
  const subjectOptions = new Map<string, { value: string; label: string; keywords: string[] }>();
  for (const item of [...catalog.data, ...(report ? [report] : [])]) {
    const value = subjectKey(item);
    subjectOptions.set(value, { value, label: subjectLabel(item), keywords: [item.subject.kind, item.subject.ref || ''] });
  }
  if (state.subject && !subjectOptions.has(state.subject)) subjectOptions.set(state.subject, { value: state.subject, label: state.subject, keywords: [] });
  const now = Date.now();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, Summary[]>();
  for (const item of [...library.data].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))) {
    const time = Date.parse(item.published_at);
    const group = time >= now - 3_600_000 ? 'Last hour' : time >= today.getTime() ? 'Earlier today' : time >= yesterday.getTime() ? 'Yesterday' : 'Earlier';
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  const advanced = !!(state.vis || state.pot || state.tag);
  const anyFilters = !!(state.q || state.kind || state.subject || state.since || advanced);
  const boundedCount = (count: number) => catalog.loading || catalog.error ? '…' : `${count}${catalog.data.length === 200 ? '+' : ''}`;
  return <main className="reports-page" data-testid="reports-library">
    <header className="reports-heading"><h1>Reports</h1><span className="reports-count" role="status">{catalog.loading ? 'Loading…' : `${boundedCount(catalog.data.length)} reports`}
      {!catalog.loading && <> · <span>{boundedCount(catalog.data.filter(item => Date.parse(item.published_at) >= today.getTime()).length)} today</span></>}</span>
      <TextInput ref={search} className="reports-search" aria-label="Search reports" value={state.q} placeholder="Search titles, summaries and full text"
        maxLength={500} onChange={e => change('q', e.target.value)} leading={<span aria-hidden="true">⌕</span>} trailing={<kbd aria-hidden="true">/</kbd>} />
    </header>
    <form onSubmit={event => event.preventDefault()} aria-label="Report filters">
      <div className="reports-filter-bar"><div className="reports-kind-filters" role="group" aria-label="Report kind">
        <button type="button" aria-pressed={!kind} onClick={() => change('kind', '')}>All <span>{boundedCount(catalog.data.length)}</span></button>
        {kinds.map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => change('kind', value)}>
          <span className={`reports-kind-label reports-kind--${value}`}>{kindLabels[value][1]}</span>{' '}<span>{boundedCount(counts[value])}</span></button>)}
      </div><div className="reports-filter-controls">
        <ComboboxMenu ariaLabel="Report subject" value={state.subject || '__all__'} options={[{ value: '__all__', label: 'Any subject' }, ...subjectOptions.values()]}
          onChange={value => change('subject', value === '__all__' ? '' : value)} triggerChildren={`About: ${subjectOptions.get(state.subject)?.label || 'any subject'} ▾`}
          searchPlaceholder="Find a plan, goal or work item…" triggerClassName="reports-subject-picker" />
        <label className="reports-time-filter"><span>Since</span><TextInput aria-label="Published since" type="date" value={state.since} onChange={e => change('since', e.target.value)} /></label>
        <Button onClick={() => setMoreFilters(value => !value)} aria-expanded={moreFilters} aria-controls="reports-more-filters">More filters{advanced ? ' · active' : ''}</Button>
        {anyFilters && <Button onClick={() => { void setState({ kind: '', subject: '', pot: '', vis: '', q: '', tag: '', since: '' }); }}>Clear filters</Button>}
      </div></div>
      {moreFilters && <div id="reports-more-filters" className="reports-filters">
        <label>Visibility<Select ariaLabel="Report visibility" value={state.vis || '__all__'} options={options(visibility)} onChange={v => change('vis', v === '__all__' ? '' : v)} /></label>
        <label>Written in pot<TextInput aria-label="Origin pot" value={state.pot} onChange={e => change('pot', e.target.value)} /></label>
        <label>Tags<TextInput aria-label="Report tags" value={state.tag} placeholder="Comma-separated tags" onChange={e => change('tag', e.target.value)} /></label>
      </div>}
    </form>
    {catalog.data.length === 200 && <p className="reports-catalog-note">Counts and subject choices cover the 200 most recent reports. Search to find older reports.</p>}
    {catalog.error && <p role="alert">Could not load filter counts. <Button onClick={catalog.invalidate}>Retry filters</Button></p>}
    {readError && <p role="alert">Read status could not be saved. Your report remains readable.</p>}
    <div className="reports-workspace">
      <section className="reports-list" aria-label="Reports library">
        {library.loading && <p role="status">Loading reports…</p>}
        {library.error && <div role="alert"><p>{library.error.message}</p><Button onClick={library.invalidate}>Retry</Button></div>}
        {!library.loading && !library.error && !library.data.length && <p>No reports match these filters.</p>}
        {[...groups].map(([group, items]) => <section key={group} aria-label={group}><h2 className="reports-group-heading">{group}</h2>
          {items.map(item => {
            const unread = !preferences.loading && !preferences.error && !preferences.data[0]?.payload?.[`reportsRead.${item.report_id}`] && !read[item.report_id] && item.report_id !== report?.report_id;
            return <button key={item.report_id} type="button" className="reports-list-item" aria-pressed={item.report_id === state.sel} onClick={() => select(item.report_id)}>
              <span className="reports-row-top"><span className="reports-unread" data-unread={unread} aria-label={unread ? 'Unread' : undefined} />
                <strong>{item.title}</strong><time dateTime={item.published_at} title={published(item.published_at)}>{relativeTime(item.published_at, now)}</time></span>
              <span className="reports-row-summary">{item.summary || `${kindLabels[item.kind][0]} · ${item.visibility === 'owner' ? 'Only you' : `Shared with ${item.visibility}`}`}</span>
              <span className="reports-row-meta"><KindBadge kind={item.kind} /><span className="reports-chip">{subjectLabel(item)}</span>
                {item.supersedes_report_id && <small>Revised</small>}<small title="Estimated from report size">~{Math.max(1, Math.ceil(item.body_bytes / 1400))} min read</small></span>
            </button>;
          })}</section>)}
        {library.data.length === 200 && <p>Narrow the filters to find more reports.</p>}
      </section>
      <section className="reports-reader" aria-label="Report reader">
        {!state.sel && <p>Select a report to read it.</p>}
        {state.sel && detail.loading && <p role="status">Loading report…</p>}
        {state.sel && detail.error && <div role="alert"><p>{detail.error.message}</p><Button onClick={detail.invalidate}>Retry</Button></div>}
        {state.sel && !detail.loading && !detail.error && !report && <p>This report is unavailable.</p>}
        {report && <ReportReader key={report.report_id} report={report} onSelect={select} historyOpen={state.hist} onHistoryChange={() => { void setState({ hist: !state.hist }); }}
          onFollowUp={() => {
            seedOperatorChatDraft(`I'd like to discuss this report: ${report.title}\nExact edition: ${report.path}\nReport ID: ${report.report_id}\n\n${report.summary}\n\nMy question: `);
            void setState({ chat: true, opcv: 'chat' });
          }} />}
      </section>
    </div>
  </main>;
}
