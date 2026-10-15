// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
const h = vi.hoisted(() => ({ data: [] as unknown[], toast: vi.fn(), sync: vi.fn() }));
vi.mock('@papercusp/sync', async (original) => ({ ...await original<typeof import('@papercusp/sync')>(), useSyncQuery: (args: unknown) => { h.sync(args); return { data: h.data }; } }));
vi.mock('sonner', () => ({ toast: h.toast }));
import { ReportProblemUpdate } from './ReportProblemDialog';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() });
  if (typeof localStorage.clear !== 'function') throw new Error('browser storage fixture is unavailable');
  h.toast.mockClear(); h.sync.mockClear(); h.data = [];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('reporter notifications subscribe to their saved source receipt', () => {
  it('notifies once for a published fix and opens the same report', () => {
    const onOpen = vi.fn();
    const view = render(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={onOpen} />);
    expect(h.toast).not.toHaveBeenCalled();
    h.data = [{ reporterStatus: { status: 'awaiting-release', label: 'Fix verified; awaiting release', release: null } }];
    view.rerender(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={onOpen} />);
    expect(h.toast).not.toHaveBeenCalled();
    h.data = [{ reporterStatus: { status: 'fixed', label: 'Fixed in v0.0.25', release: { completionRef: 'close1', artifactCommit: 'artifact1' } } }];
    view.rerender(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={onOpen} />);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls[0][0]).toBe('Fixed in v0.0.25');
    h.toast.mock.calls[0][1].action.onClick();
    expect(onOpen).toHaveBeenCalledOnce();
    view.unmount();
    render(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={onOpen} />);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledWith({ queryName: 'workItems.detail', args: { harnessSlug: 'papercusp', id: 'EI-report' } });
  });
  it('notifies of the one unanswered follow-up; a matching reply stops the question notification', () => {
    h.data = [{ reporterStatus: { status: 'being-fixed', followUp: { question: { id: 'q1', text: 'Which CSV file?' } } } }];
    const view = render(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={() => {}} />);
    expect(h.toast.mock.calls[0][0]).toBe('Which CSV file?');
    localStorage.clear();
    h.data = [{ reporterStatus: { status: 'being-fixed', followUp: { question: { id: 'q1', text: 'Which CSV file?' }, answer: { text: 'sample.csv' } } } }];
    view.rerender(<ReportProblemUpdate id="EI-report" workspaceId="ws1" onOpen={() => {}} />);
    expect(h.toast).toHaveBeenCalledTimes(1);
  });
});
