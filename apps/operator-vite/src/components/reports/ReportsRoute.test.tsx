// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { useEffect, useRef } from 'react';

const fixture = vi.hoisted(() => ({ enabled: true, queries: [] as { queryName: string; args: Record<string, unknown>; enabled?: boolean }[],
  list: [] as Record<string, unknown>[], catalog: null as Record<string, unknown>[] | null,
  detail: [] as Record<string, unknown>[], previous: [] as Record<string, unknown>[] | null,
  preferences: {} as Record<string, unknown>, history: [] as Record<string, unknown>[], error: null as Error | null }));
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => fixture.enabled }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (opts: { queryName: string; args: Record<string, unknown>; enabled?: boolean }) => {
  fixture.queries.push(opts);
  return { data: opts.queryName === 'reports.list' ? (Object.keys(opts.args || {}).length === 1 ? fixture.catalog ?? fixture.list : fixture.list)
    : opts.queryName === 'reports.get' ? (opts.args?.reportId === 'edition-1' && fixture.previous ? fixture.previous : fixture.detail)
    : opts.queryName === 'userPreferences.current' ? [{ payload: fixture.preferences }] : fixture.history, loading: false,
    error: fixture.error, invalidate: vi.fn() };
} }));
vi.mock('@/app/_components/MarkdownEditor', () => ({ MarkdownPreview: ({ value, onParsed }: { value: string; onParsed?: (root: HTMLElement) => void }) => {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (root.current) onParsed?.(root.current); }, [value, onParsed]);
  return <div ref={root} data-testid="markdown-preview"><span>{value}</span>{value.includes('## Outline fixture') && <><h2 id="repeated">Outline fixture</h2><h3 id="repeated">Nested section</h3></>}</div>;
} }));
vi.mock('@/app/_components/inbox/chat-seed', () => ({ seedOperatorChatDraft: vi.fn() }));
import ReportsRoute from './ReportsRoute';
import { reportFullFixture as report, reportSummaryFixture } from './reports-test-fixture';
import { seedOperatorChatDraft } from '@/app/_components/inbox/chat-seed';
import { reportsClearFiltersExpression, reportsHistoryFilterExpression } from '../../../../../scripts/tauri-surface-verify-reports.mts';

beforeEach(() => {
  fixture.enabled = true; fixture.queries = []; fixture.list = []; fixture.catalog = null; fixture.detail = []; fixture.previous = null;
  fixture.history = []; fixture.preferences = {}; fixture.error = null;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vi.mocked(seedOperatorChatDraft).mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = (searchParams = '', onUrlUpdate = vi.fn()) => {
  render(<NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}><ReportsRoute /></NuqsTestingAdapter>);
  return onUrlUpdate;
};

describe('Reports route', () => {
  it('fullscreens the complete reader and restores without remounting the report or resetting scroll', async () => {
    fixture.detail = [report];
    let active: Element | null = null;
    const request = vi.fn(async function(this: HTMLElement) {
      active = this;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exit = vi.fn(async () => { active = null; document.dispatchEvent(new Event('fullscreenchange')); });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    const onUrlUpdate = mount('?sel=edition-2&kind=audit');
    const reader = screen.getByRole('region', { name: 'Report reader' });
    Object.defineProperty(reader, 'requestFullscreen', { configurable: true, value: request });
    const content = screen.getByTestId('markdown-preview');
    const scroller = reader.querySelector('.reports-article-main')!;
    scroller.scrollTop = 240;
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen report reader' }));
    await waitFor(() => expect(reader.classList.contains('reports-reader--fullscreen')).toBe(true));
    expect(request.mock.instances[0]).toBe(reader);
    expect(screen.getByTestId('markdown-preview')).toBe(content);
    expect(reader.querySelector('[aria-label="On this page"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore report reader' }));
    await waitFor(() => expect(reader.classList.contains('reports-reader--fullscreen')).toBe(false));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(240);
    expect(screen.getByTestId('markdown-preview')).toBe(content);
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].queryString).toContain('sel=edition-2');
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].queryString).toContain('kind=audit');
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(document, 'fullscreenElement');
  });

  it('fills the window when display fullscreen is unavailable and restores with Escape', async () => {
    fixture.detail = [report];
    mount('?sel=edition-2');
    const reader = screen.getByRole('region', { name: 'Report reader' });
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen report reader' }));
    await waitFor(() => expect(reader.classList.contains('reports-reader--fullscreen')).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(reader.classList.contains('reports-reader--fullscreen')).toBe(false));
    expect(screen.getByTestId('markdown-preview').textContent).toBe(report.body_md);
  });

  it('gates the UI and all sync subscriptions when disabled', () => {
    fixture.enabled = false;
    mount('?sel=edition-2');
    expect(screen.getByText('Reports library is disabled.')).toBeTruthy();
    expect(fixture.queries).toEqual([]);
  });
  it('restores every filter and an exact report pin from a deep link', () => {
    fixture.detail = [report];
    mount('?kind=audit&subject=plan%3Aexample-plan&pot=pot-a&vis=owner&q=findings&tag=operations&since=2026-10-01&sel=edition-2&hist=true');
    expect(fixture.queries.find(q => q.queryName === 'reports.list')?.args).toEqual({ kind: 'audit',
      subject: { kind: 'plan', ref: 'example-plan' }, originHarnessSlug: 'pot-a', visibility: 'owner', query: 'findings',
      tags: ['operations'], since: '2026-10-01T00:00:00.000Z', limit: 200 });
    expect(fixture.queries.find(q => q.queryName === 'reports.get')?.args).toEqual({ reportId: 'edition-2' });
    expect(fixture.queries.find(q => q.queryName === 'reports.lineage')?.enabled).toBe(true);
    expect(screen.getByTestId('markdown-preview').textContent).toBe(report.body_md);
    expect(screen.getAllByText('writer')).toHaveLength(2);
  });
  it('accepts the native history and subject filter witness from the real button control', () => {
    const original = { ...report, report_id: 'edition-1', supersedes_report_id: null };
    const corrected = { ...reportSummaryFixture, title: 'Private audit correction' };
    fixture.detail = [original];
    fixture.list = [corrected];
    fixture.catalog = [corrected];
    fixture.history = [{ ...reportSummaryFixture, ...original }, corrected];
    const search = '?kind=audit&subject=plan%3Aexample-plan&q=Private+audit&sel=edition-1&hist=true';
    mount(search);
    const expression = reportsHistoryFilterExpression({ originalTitle: original.title,
      correctedTitle: corrected.title, subjectValue: 'plan:example-plan', subjectLabel: 'Example plan' });
    const evaluate = (params = search) => new Function('document', 'location', `return ${expression}`)(
      document, { href: `http://localhost/reports${params}` });
    const subject = screen.getByRole('button', { name: 'About: Example plan ▾' }) as HTMLButtonElement;
    expect(document.querySelector('[aria-label="Report subject"]')).toBeNull();
    expect(subject.textContent).toBe('About: Example plan ▾');
    expect(subject.value).toBe('');
    expect(fixture.queries.find(q => q.queryName === 'reports.list')?.args).toMatchObject({
      subject: { kind: 'plan', ref: 'example-plan' }, query: original.title,
    });
    expect(evaluate()).toBe(true);
    expect(evaluate(search.replace('plan%3Aexample-plan', 'plan%3Aanother-plan'))).toBe(false);
    expect(evaluate(search.replace('subject=plan%3Aexample-plan&', ''))).toBe(false);
    expect(evaluate()).toBe(true);
    const list = document.querySelector('.reports-list-item')!;
    const reader = document.querySelector('.reports-reader h2')!;
    const searchInput = screen.getByRole('textbox', { name: 'Search reports' }) as HTMLInputElement;
    const history = document.querySelector('.reports-history-item')!;
    const changeText = (node: Element, value: string) => {
      const saved = node.innerHTML;
      node.textContent = value;
      return () => { node.innerHTML = saved; };
    };
    const controls = [
      () => changeText(list, 'Unrelated edition'),
      () => changeText(reader, 'Unrelated reader'),
      () => changeText(subject, 'About: another subject ▾'),
      () => { const saved = searchInput.value; searchInput.value = 'Unrelated search';
        return () => { searchInput.value = saved; }; },
      () => { const extra = list.cloneNode(true); list.after(extra); return () => extra.parentNode?.removeChild(extra); },
      () => { const parent = history.parentNode!; const next = history.nextSibling; history.remove();
        return () => { parent.insertBefore(history, next); }; },
      () => { const parent = subject.parentNode!; const next = subject.nextSibling; subject.remove();
        return () => { parent.insertBefore(subject, next); }; },
    ];
    for (const applyControl of controls) {
      const restore = applyControl();
      try { expect(evaluate()).toBe(false); } finally { restore(); }
      expect(evaluate()).toBe(true);
    }
    const witness = (window as unknown as { __reportsHistoryFilterWitness: {
      actual: Record<string, unknown>; checks: Record<string, boolean>;
    } }).__reportsHistoryFilterWitness;
    expect(witness.actual).toMatchObject({ subjectValue: 'plan:example-plan',
      subjectLabel: 'About: Example plan ▾', listCount: 1, historyCount: 2 });
    expect(Object.values(witness.checks)).toEqual(Array(7).fill(true));
  });
  it.each([false, true])('keeps an unknown citation unavailable with an existing report and cached detail=%s', cached => {
    fixture.list = [reportSummaryFixture];
    fixture.detail = [report];
    mount('?sel=edition-2');
    expect(screen.getByRole('heading', { name: report.title, level: 2 })).toBeTruthy();
    expect(screen.getByTestId('markdown-preview').textContent).toBe(report.body_md);

    cleanup();
    fixture.detail = cached ? [report] : [];
    mount('?sel=unknown-edition');
    expect(fixture.queries.filter(q => q.queryName === 'reports.get').at(-1)?.args)
      .toEqual({ reportId: 'unknown-edition' });
    expect(screen.getByText('This report is unavailable.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: report.title, level: 2 })).toBeNull();
    expect(screen.queryByTestId('markdown-preview')).toBeNull();

    cleanup();
    fixture.detail = [report];
    mount('?sel=edition-2');
    expect(screen.getByRole('heading', { name: report.title, level: 2 })).toBeTruthy();
    expect(screen.getByTestId('markdown-preview').textContent).toBe(report.body_md);
  });
  it('renders every contract field in the report metadata strip, including kind', () => {
    fixture.detail = [report];
    mount('?sel=edition-2');
    const metadata = screen.getByRole('article').querySelector('.reports-metadata');
    expect(metadata).not.toBeNull();
    const fields = Object.fromEntries(Array.from(metadata!.querySelectorAll('div'), row => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ] as const));
    expect(fields).toMatchObject({
      Kind: report.kind,
      Subject: report.subject.label,
      'Written by': report.origin.author_owner_id,
      Pot: report.origin.harness_slug || 'Workspace',
      Visibility: report.visibility,
      Published: expect.any(String),
      Source: report.source,
      'Report ID': report.report_id,
    });
    expect(fields.Published).toBeTruthy();
  });
  it('writes selection to the URL and preserves filters', async () => {
    fixture.list = [reportSummaryFixture];
    const update = mount('?q=findings');
    fireEvent.click(screen.getByRole('button', { name: /Private audit/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get('sel')).toBe('edition-2');
    expect(params.get('q')).toBe('findings');
  });
  it('hides a cached reader snapshot when the selection is cleared', () => {
    fixture.detail = [report];
    fixture.history = [reportSummaryFixture];
    mount('?q=findings&hist=true');
    expect(screen.getByText('Select a report to read it.')).toBeTruthy();
    expect(screen.queryByTestId('markdown-preview')).toBeNull();
    expect(screen.queryByRole('heading', { name: report.title })).toBeNull();
    expect(fixture.queries.find(q => q.queryName === 'reports.get')?.enabled).toBe(false);
    expect(fixture.queries.some(q => q.queryName === 'reports.lineage')).toBe(false);
  });
  it('hides the previous cached edition while a different exact citation loads', async () => {
    fixture.detail = [report];
    const update = mount('?sel=edition-2&q=findings');
    expect(screen.getByTestId('markdown-preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('markdown-preview')).toBeNull());
    expect(fixture.queries.filter(q => q.queryName === 'reports.get').at(-1)?.args).toEqual({ reportId: 'edition-1' });
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('q')).toBe('findings');
  });
  it('copies complete Markdown with Mermaid fences and navigates to the previous edition', async () => {
    fixture.detail = [report];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const update = mount('?sel=edition-2');
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`# ${report.title}\n\n${report.body_md}`));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('sel')).toBe('edition-1');
  });
  it('shows an actionable query failure and a clear empty library', () => {
    mount();
    expect(screen.getByText('No reports match these filters.')).toBeTruthy();
    cleanup(); fixture.error = new Error('Connection unavailable'); mount();
    expect(screen.getAllByRole('alert').some(node => node.textContent?.includes('Connection unavailable'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
  it('keeps kind counts and real subject choices available while filtering, without losing the exact citation', async () => {
    fixture.catalog = [reportSummaryFixture, { ...reportSummaryFixture, report_id: 'review-1', kind: 'review', subject: { kind: 'work_item', ref: 'WI-123', label: 'Fix report navigation' } }];
    fixture.list = [reportSummaryFixture];
    const update = mount('?q=findings&sel=edition-2');
    const kinds = within(screen.getByRole('group', { name: 'Report kind' }));
    expect(kinds.getByRole('button', { name: 'All 2' })).toBeTruthy();
    fireEvent.click(kinds.getByRole('button', { name: 'Reviews 1' }));
    await waitFor(() => expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('kind')).toBe('review'));
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('sel')).toBe('edition-2');
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('q')).toBe('findings');
    fireEvent.click(screen.getByRole('button', { name: 'About: any subject ▾' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Fix report navigation' }));
    await waitFor(() => expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('subject')).toBe('work_item:WI-123'));
    expect(screen.queryByPlaceholderText('plan:plan-slug')).toBeNull();
  });
  it('clears every filter through the native action on the real toolbar, keeping the selected report and history', async () => {
    const update = mount('?kind=audit&subject=plan%3Aexample-plan&q=findings&since=2026-10-01&vis=owner&pot=pot-a&tag=operations&sel=edition-2&hist=true');
    expect(screen.queryByLabelText('Origin pot')).toBeNull();
    expect(fixture.queries.find(q => q.queryName === 'reports.list')?.args).toMatchObject({ visibility: 'owner', originHarnessSlug: 'pot-a', tags: ['operations'] });
    fireEvent.click(screen.getByRole('button', { name: 'More filters · active' }));
    expect((screen.getByLabelText('Origin pot') as HTMLInputElement).value).toBe('pot-a');
    const unrelated = document.createElement('button');
    unrelated.textContent = 'Clear filters';
    const unrelatedClick = vi.fn();
    unrelated.addEventListener('click', unrelatedClick);
    document.querySelector('.reports-heading')!.append(unrelated);
    new Function('document', `return ${reportsClearFiltersExpression()}`)(document);
    expect(unrelatedClick).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get('sel')).toBe('edition-2');
    expect(params.get('hist')).toBe('true');
    expect(['kind', 'subject', 'pot', 'vis', 'q', 'tag', 'since'].every(key => !params.has(key))).toBe(true);
  });
  it('refuses the native clear-filter action when no Reports filter control is available', () => {
    const update = mount('?sel=edition-2');
    expect(() => new Function('document', `return ${reportsClearFiltersExpression()}`)(document))
      .toThrow('Expected one Clear filters button in the Reports filter controls');
    expect(update).not.toHaveBeenCalled();
  });
  it('uses slash to focus search without intercepting text input', () => {
    mount();
    const search = screen.getByRole('textbox', { name: 'Search reports' });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(search);
    const prevented = !search.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(prevented).toBe(false);
  });
  it('groups reports by time and shows persisted per-user unread state', () => {
    const now = Date.now();
    fixture.list = [{ ...reportSummaryFixture, published_at: new Date(now - 10 * 60_000).toISOString() },
      { ...reportSummaryFixture, report_id: 'older', title: 'Older report', published_at: '2025-01-01T00:00:00Z' }];
    fixture.preferences = { 'reportsRead.edition-2': true };
    mount();
    expect(within(screen.getByRole('region', { name: 'Last hour' })).getByRole('button', { name: /Private audit/ })).toBeTruthy();
    const older = within(screen.getByRole('region', { name: 'Earlier' })).getByRole('button', { name: /Older report/ });
    expect(older.querySelector('[aria-label="Unread"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Private audit/ }).querySelector('[aria-label="Unread"]')).toBeNull();
  });
  it('marks an exact edition through existing per-user preferences, once, and surfaces write failures', async () => {
    fixture.detail = [report];
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    mount('?sel=edition-2');
    await screen.findByRole('alert');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/user/preferences', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ 'reportsRead.edition-2': true }) }));
    expect(screen.getByTestId('markdown-preview')).toBeTruthy();
  });
  it('keeps previously read editions and unknown citations from making read-marker writes', () => {
    fixture.detail = [report]; fixture.preferences = { 'reportsRead.edition-2': true };
    mount('?sel=edition-2'); expect(fetch).not.toHaveBeenCalled();
    cleanup(); mount('?sel=unknown'); expect(fetch).not.toHaveBeenCalled();
  });
  it('puts the summary before Markdown and derives a navigable outline from rendered headings', async () => {
    fixture.detail = [{ ...report, body_md: '## Outline fixture\n\n### Nested section' }];
    mount('?sel=edition-2');
    const summary = screen.getByRole('region', { name: 'Report summary' });
    const body = screen.getByTestId('markdown-preview');
    expect(summary.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const outline = within(screen.getByRole('navigation', { name: 'On this page' }));
    const nested = await outline.findByRole('link', { name: 'Nested section' });
    expect(nested.getAttribute('href')).toBe('#repeated-1');
    fireEvent.click(nested);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: -24, behavior: 'smooth' });
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(nested.getAttribute('aria-current')).toBe('location');
    expect(screen.getByRole('progressbar', { name: 'Reading progress' })).toBeTruthy();
  });
  it('always loads edition choices and compares only the exact previous citation', async () => {
    fixture.detail = [report];
    fixture.history = [{ ...reportSummaryFixture, report_id: 'edition-1', published_at: '2026-09-30T12:00:00Z' }, reportSummaryFixture];
    fixture.previous = [{ ...report, report_id: 'edition-1', title: 'Original audit', body_md: 'Original findings' }];
    mount('?sel=edition-2');
    expect(screen.getByRole('combobox', { name: 'Report edition' }).textContent).toContain('Edition 2 of 2');
    expect(fixture.queries.find(q => q.queryName === 'reports.lineage')?.enabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compare editions' }));
    expect(await screen.findByText('Original findings')).toBeTruthy();
    expect(fixture.queries.filter(q => q.queryName === 'reports.get').at(-1)).toMatchObject({ args: { reportId: 'edition-1' }, enabled: true });
  });
  it('links plan subjects and work-item tags through the shared popup grammar and seeds a follow-up without sending', async () => {
    fixture.detail = [{ ...report, tags: ['WI-123'] }];
    const update = mount('?sel=edition-2');
    expect(screen.getByRole('link', { name: 'Example plan ↗' }).getAttribute('href')).toContain('wppop=pot-a%3A%3Aexample-plan');
    expect(screen.getByRole('link', { name: 'WI-123' }).getAttribute('href')).toContain('wpop=pot-a%3A%3AWI-123');
    fireEvent.click(screen.getByRole('button', { name: 'Ask a follow-up' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(seedOperatorChatDraft).toHaveBeenCalledWith(expect.stringContaining('Exact edition: /reports?sel=edition-2'));
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get('sel')).toBe('edition-2'); expect(params.get('chat')).toBe('true');
  });
  it('labels the catalog ceiling instead of presenting partial counts as a whole-library census', () => {
    fixture.catalog = Array.from({ length: 200 }, (_, i) => ({ ...reportSummaryFixture, report_id: `id-${i}` }));
    mount();
    expect(screen.getByRole('button', { name: 'All 200+' })).toBeTruthy();
    expect(screen.getByText(/Counts and subject choices cover the 200 most recent reports/)).toBeTruthy();
  });
});
