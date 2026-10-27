// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindQuickPanelEscape } from '@papercusp/operator-core/lib/client-navigation';
import QuickAccessLauncher, { focusQuickAgent } from './QuickAccessLauncher';
import type { QuickAgent } from './quick-access-model';

const mocks = vi.hoisted(() => ({
  focus: vi.fn(), invoke: vi.fn(), isDesktop: vi.fn(), ownsOrigin: vi.fn(), toast: vi.fn(),
  queries: vi.fn(), plan: vi.fn(), reportsEnabled: true, urlUpdate: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: mocks.queries }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'workspace-one' }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => mocks.reportsEnabled }));
vi.mock('@/lib/ipc-status-tauri', () => ({ isDesktop: mocks.isDesktop, canUseContentOriginDesktopActions: mocks.ownsOrigin }));
vi.mock('@/lib/chat-actions/SessionActions', () => ({ focusWindow: mocks.focus }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/app/admin/plans/plans-api', () => ({ usePlan: mocks.plan }));
vi.mock('@/app/harness/picker-kit', () => ({ useDebouncedValue: (s: string) => s }));
vi.mock('@/app/_components/MarkdownEditor', () => ({ MarkdownPreview: ({ value }: { value: string }) => <pre>{value}</pre> }));
vi.mock('@/app/_components/chat/SessionChatModal', () => ({
  default: ({ sessionOwnerId, onClose }: { sessionOwnerId: string; onClose: () => void }) =>
    <div role="dialog" aria-label="Agent conversation"><span>{sessionOwnerId}</span><button onClick={onClose}>Close chat</button></div>,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }));
const agent: QuickAgent = { ownerId: 'su-precise', label: 'Maya', intent: 'Build the launcher', agent: 'codex',
  currentPlanSlug: 'launch', sessionState: 'live', advSessionId: 42, windowId: 'window-42',
  pid: 99, stale: false, revoked: false, isLocal: true };
const plans = [{ slug: 'launch', harness: 'alpha', title: 'Launch experience', status: 'active' },
  { slug: 'other', harness: 'alpha', title: 'Other work', status: 'ready' }];
const report = { report_id: 'report-one', title: 'Keyboard review', summary: 'Review of the launcher',
  kind: 'review', published_at: '2026-10-26T10:00:00Z', subject: { kind: 'plan', ref: 'launch' } };

beforeEach(() => {
  vi.clearAllMocks(); mocks.reportsEnabled = true;
  mocks.isDesktop.mockReturnValue(true); mocks.ownsOrigin.mockResolvedValue(true);
  mocks.invoke.mockResolvedValue(false); mocks.focus.mockResolvedValue(undefined);
  mocks.plan.mockImplementation((slug: string) => ({ data: { slug, items: [{ effectiveStatus: 'done' }, { effectiveStatus: 'wip' }] }, loading: false, error: null }));
  mocks.queries.mockImplementation(({ queryName }: { queryName: string }) => {
    const data = {
      'plans.list': plans, 'advRoster.list': [{ active: [agent] }],
      'planSessions.list': [{ coordOwnerId: agent.ownerId, label: agent.label, live: true }],
      'reports.list': [report], 'reports.get': [{ ...report, body_md: 'Exact report body' }],
    }[queryName];
    return { data, loading: false, error: null };
  });
});
afterEach(cleanup);
function mount(params = '') {
  // The memory adapter re-renders for URL changes. Resetting its global queue
  // during those renders can notify the mounted launcher during React render.
  return render(<NuqsTestingAdapter searchParams={params} hasMemory resetUrlUpdateQueueOnMount={false} onUrlUpdate={mocks.urlUpdate}>
    <QuickAccessLauncher />
  </NuqsTestingAdapter>);
}
const scope = (name: string) => within(screen.getByRole('navigation', { name: 'Search scope' })).getByRole('button', { name });

describe('Quick Access launcher', () => {
  it('loads canonical workspace sources and targeted plan progress, then opens the exact owner conversation', async () => {
    mount();
    expect(screen.getByText('1 of 2 tasks complete')).toBeTruthy();
    expect(mocks.queries).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'plans.list',
      args: expect.objectContaining({ workspaceWide: true, compact: true }) }));
    expect(mocks.queries).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'advRoster.list',
      args: { workspaceId: 'workspace-one', endedLimit: 50 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Talk to Maya' }));
    expect(await screen.findByRole('dialog', { name: 'Agent conversation' })).toBeTruthy();
    expect(within(screen.getByRole('dialog', { name: 'Agent conversation' })).getByText('su-precise')).toBeTruthy();
  });
  it('supports scope, search, empty results and Escape clearing without changing host state', async () => {
    mount('?host=untouched');
    fireEvent.click(scope('Agents'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Maya', level: 1 })).toBeTruthy());
    const input = screen.getByRole('textbox', { name: 'Search plans, agents and reports' });
    fireEvent.change(input, { target: { value: 'not-present' } });
    await screen.findByText('No matching plans, agents, or reports.');
    await waitFor(() => expect(mocks.urlUpdate.mock.calls.at(-1)?.[0]?.searchParams.get('laq')).toBe('not-present'));
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(mocks.urlUpdate.mock.calls.at(-1)?.[0]?.searchParams.get('host')).toBe('untouched');
  });
  it('navigates results with arrows and Enter using selected identity', async () => {
    mount();
    const input = screen.getByRole('textbox', { name: 'Search plans, agents and reports' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await screen.findByRole('heading', { name: 'Other work', level: 1 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement?.id).toBe('quick-access-preview');
  });
  it('reads the report inside this popup', async () => {
    mount();
    fireEvent.click(scope('Reports'));
    expect(await screen.findByText('Exact report body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read report' }));
    expect(await screen.findByRole('dialog', { name: 'Report' })).toBeTruthy();
  });
  it('dismisses the nested report with Escape before dismissing the native popup', async () => {
    const dismiss = vi.fn();
    const unbind = bindQuickPanelEscape(document, null, dismiss);
    try {
      mount();
      fireEvent.click(scope('Reports'));
      await screen.findByText('Exact report body');
      fireEvent.click(screen.getByRole('button', { name: 'Read report' }));
      const dialog = await screen.findByRole('dialog', { name: 'Report' });
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Report' })).toBeNull());
      expect(dismiss).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(dismiss).toHaveBeenCalledOnce();
    } finally {
      unbind();
    }
  });
  it('refuses a stale body from a different report identity', async () => {
    const normal = mocks.queries.getMockImplementation()!;
    mocks.queries.mockImplementation((opts: { queryName: string }) =>
      opts.queryName === 'reports.get'
        ? { data: [{ ...report, report_id: 'previous-report', body_md: 'Private previous body' }], loading: false, error: null }
        : normal(opts));
    mount();
    fireEvent.click(scope('Reports'));
    expect(await screen.findByText('Report not found or unavailable.')).toBeTruthy();
    expect(screen.queryByText('Private previous body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report' });
    expect(within(dialog).getByText('Report not found or unavailable.')).toBeTruthy();
    expect(within(dialog).queryByText('Private previous body')).toBeNull();
  });
  it('shows partial-source errors and reports-disabled state instead of false empty success', async () => {
    mocks.reportsEnabled = false;
    const normal = mocks.queries.getMockImplementation()!;
    mocks.queries.mockImplementation((opts: { queryName: string }) =>
      opts.queryName === 'plans.list' ? { error: new Error('offline'), loading: false, data: [] } : normal(opts));
    mount();
    expect(screen.getByRole('alert').textContent).toContain('Plans could not be loaded');
    fireEvent.click(scope('Reports'));
    expect(await screen.findByText('Reports library is disabled for this workspace.')).toBeTruthy();
    expect(mocks.queries).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'reports.list', enabled: false }));
  });
});

describe('Exact agent-window focus', () => {
  it('uses observed native success without a second focus or guessed window', async () => {
    mocks.invoke.mockResolvedValue({ focused: true });
    await focusQuickAgent(agent);
    expect(mocks.invoke).toHaveBeenCalledWith('focus_window_by_title', { title: 'window-42' });
    expect(mocks.focus).not.toHaveBeenCalled();
  });
  it('resolves local launch records through the canonical focus action', async () => {
    await focusQuickAgent(agent);
    expect(mocks.focus).toHaveBeenCalledWith(expect.objectContaining({ sessionOwnerId: 'su-precise', advSessionId: 42, windowId: 'window-42' }));
    expect(mocks.focus.mock.calls[0][0]).not.toHaveProperty('pid');
  });
  it('uses the launch identity when a shared terminal PID has no recorded window', async () => {
    await focusQuickAgent({ ...agent, windowId: null });
    expect(mocks.focus).toHaveBeenCalledWith(expect.objectContaining({ sessionOwnerId: 'su-precise', advSessionId: 42 }));
    expect(mocks.focus.mock.calls[0][0]).not.toHaveProperty('pid');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('refuses browser, remote, ended and unrelated content-origin targets', async () => {
    mocks.isDesktop.mockReturnValue(false);
    await expect(focusQuickAgent(agent)).rejects.toThrow('desktop popup');
    mocks.isDesktop.mockReturnValue(true);
    await expect(focusQuickAgent({ ...agent, isLocal: false })).rejects.toThrow('another machine');
    await expect(focusQuickAgent({ ...agent, sessionState: 'ended' })).rejects.toThrow('no longer live');
    mocks.ownsOrigin.mockResolvedValue(false);
    await expect(focusQuickAgent({ ...agent, windowId: null })).rejects.toThrow('not connected');
    expect(mocks.focus).not.toHaveBeenCalled();
  });
  it('surfaces focus failure to the person who clicked', async () => {
    mocks.focus.mockRejectedValue(new Error('Window disappeared'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Focus Maya window' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Window disappeared'));
  });
});
