import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchSyncQuery } from '@papercusp/sync';
import type { ChatResultBlock } from '@papercusp/chat-protocol';
import { createOperatorResultHost } from './operator-result-host';

vi.mock('@papercusp/sync', () => ({ fetchSyncQuery: vi.fn() }));
const block: ChatResultBlock = { id: 'report-one', kind: 'report', title: 'Untrusted title', text: 'Untrusted body',
  sources: [{ ref: 'report:r-one', label: 'Source' }],
  actions: [{ id: 'open', kind: 'open', label: 'Open report', ref: 'report:r-one' }] };
const report = { report_id: 'r-one', workspace_id: 'workspace-one', title: 'Current report', body_md: 'Current body' };
const request = (result = block, authorizationKey = 'current') => ({ result, authorizationKey, signal: new AbortController().signal });
function host() {
  const openReport = vi.fn(), openWorkItem = vi.fn();
  return { ...createOperatorResultHost({ workspaceId: 'workspace-one', harnessSlug: 'papercusp',
    authorizationKey: 'current', openReport, openWorkItem }), openReport, openWorkItem };
}
beforeEach(() => vi.mocked(fetchSyncQuery).mockReset().mockResolvedValue([report]));

describe('operator structured result adapter', () => {
  it('uses current report content with exact reference provenance and no activation during resolution', async () => {
    const h = host();
    expect(await h.resolve(request())).toEqual({ ok: true, value: { ...block, title: report.title, text: report.body_md } });
    expect(fetchSyncQuery).toHaveBeenCalledExactlyOnceWith({ queryName: 'reports.get', args: { reportId: 'r-one' }, staleTime: 0 });
    expect(h.openReport).not.toHaveBeenCalled();
  });

  it('rechecks current authorization before navigation and refuses a missing or foreign report', async () => {
    const h = host();
    await h.resolve(request());
    vi.mocked(fetchSyncQuery).mockResolvedValue([]);
    const intent = { resultId: block.id, actionId: 'open', kind: 'open', ref: 'report:r-one' };
    expect(await h.activate!(intent, request())).toEqual({ ok: false, code: 'unavailable' });
    expect(h.openReport).not.toHaveBeenCalled();
    vi.mocked(fetchSyncQuery).mockResolvedValue([{ ...report, workspace_id: 'foreign' }]);
    expect(await h.resolve(request())).toEqual({ ok: false, code: 'unavailable' });
    vi.mocked(fetchSyncQuery).mockResolvedValue([report]);
    expect(await h.activate!(intent, request())).toEqual({ ok: true, value: undefined });
    expect(h.openReport).toHaveBeenCalledExactlyOnceWith('r-one');
  });

  it('rejects stale scope, abort, unsupported authority and forged actions', async () => {
    const h = host();
    expect(await h.resolve(request(block, 'foreign'))).toEqual({ ok: false, code: 'unauthorized' });
    const controller = new AbortController(); controller.abort();
    expect(await h.resolve({ ...request(), signal: controller.signal })).toEqual({ ok: false, code: 'unauthorized' });
    expect(await h.resolve(request({ ...block, kind: 'entity' }))).toEqual({ ok: false, code: 'unsupported' });
    expect(await h.activate!({ resultId: block.id, actionId: 'open', kind: 'delete', ref: 'report:r-one' }, request()))
      .toEqual({ ok: false, code: 'invalid' });
    expect(fetchSyncQuery).not.toHaveBeenCalled();
    expect(h.openReport).not.toHaveBeenCalled();
  });

  it('does not navigate when cancellation arrives during the current authorization read', async () => {
    const controller = new AbortController();
    vi.mocked(fetchSyncQuery).mockImplementation(async () => { controller.abort(); return [report]; });
    const h = host();
    expect(await h.activate!({ resultId: block.id, actionId: 'open', kind: 'open', ref: 'report:r-one' },
      { ...request(), signal: controller.signal })).toEqual({ ok: false, code: 'unauthorized' });
    expect(h.openReport).not.toHaveBeenCalled();
  });

  it('resolves work references in the host harness and opens only the offered safe action', async () => {
    const task: ChatResultBlock = { ...block, kind: 'task', sources: [{ ref: 'wi:WI-123' }],
      actions: [{ id: 'open', kind: 'open', label: 'Open work item', ref: 'wi:WI-123' }] };
    vi.mocked(fetchSyncQuery).mockResolvedValue([{ id: 'WI-123', title: 'Current work', summary: 'Verified scope' }]);
    const h = host();
    expect(await h.resolve(request(task))).toEqual({ ok: true, value: { ...task, title: 'Current work', text: 'Verified scope' } });
    expect(fetchSyncQuery).toHaveBeenCalledWith({ queryName: 'workItems.detail', args: { harnessSlug: 'papercusp', id: 'WI-123' }, staleTime: 0 });
    await h.activate!({ resultId: task.id, actionId: 'open', kind: 'open', ref: 'wi:WI-123' }, request(task));
    expect(h.openWorkItem).toHaveBeenCalledExactlyOnceWith('WI-123');
    expect(h.openReport).not.toHaveBeenCalled();
  });
});
