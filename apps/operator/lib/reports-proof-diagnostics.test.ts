import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, TestInfo } from '@playwright/test';

const persisted = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ writeFile: persisted, readFile: vi.fn() }));
vi.mock('../e2e/_egress', async () => ({ expect: (await import('vitest')).expect }));
import { observeReportReadiness } from '../e2e/_reports-proof';

function harness() {
  const page = new EventEmitter() as EventEmitter & {
    addInitScript: ReturnType<typeof vi.fn>; evaluate: ReturnType<typeof vi.fn>;
  };
  page.addInitScript = vi.fn(async () => {});
  page.evaluate = vi.fn(async (callback: () => unknown) => runInNewContext(`(${callback.toString()})()`, {
    document: { readyState: 'complete', querySelector: () => ({ textContent: 'Reports Loading' }) },
    window: { reportProofTimeline: [{ title: null }], __sync_metrics__: {
      snapshot: () => ({ scheduler: { queued: 2 } }), queries: () => [{ name: 'workspace.current' }],
    } },
  }));
  const testInfo = {
    outputPath: (name: string) => `/isolated-output/${name}`,
    attach: vi.fn(async () => {}),
  };
  return { page, testInfo, start: () => observeReportReadiness(page as unknown as Page, testInfo as unknown as TestInfo) };
}

function request(url: string, resourceType = 'fetch') {
  return { url: () => url, resourceType: () => resourceType, failure: () => ({ errorText: 'net::ERR_FAILED' }) };
}

describe('Reports proof startup diagnostics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves bootstrap, script, page and scheduler evidence before any Reports query', async () => {
    const h = harness(); const finish = await h.start();
    h.page.emit('request', request('http://localhost/api/flags/bootstrap?token=private'));
    const streamBody = vi.fn(() => new Promise(() => {}));
    h.page.emit('response', { url: () => 'http://localhost/api/flags/stream?token=private', status: () => 200, json: streamBody });
    h.page.emit('request', request('http://localhost/api/sync/rest-query?name=workspace.current&args=private'));
    h.page.emit('requestfailed', request('http://localhost/assets/startup.js?token=private#private', 'script'));
    h.page.emit('pageerror', new Error('startup import failed'));
    await finish();
    expect(streamBody).not.toHaveBeenCalled();
    const [path, text] = persisted.mock.calls[0]; const evidence = JSON.parse(text);
    expect(path).toBe('/isolated-output/report-readiness.json');
    expect(text).not.toContain('private');
    expect(evidence.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'requested', path: '/api/flags/bootstrap' }),
      expect.objectContaining({ phase: 'responded', path: '/api/flags/stream', status: 200 }),
      expect.objectContaining({ phase: 'requested', name: 'workspace.current' }),
    ]));
    expect(evidence.failures).toEqual([
      expect.objectContaining({ path: '/assets/startup.js', resourceType: 'script', error: 'net::ERR_FAILED' }),
      expect.objectContaining({ phase: 'pageerror', error: 'startup import failed' }),
    ]);
    expect(evidence.rendering).toMatchObject({ readyState: 'complete', status: 'Reports Loading',
      scheduler: { queued: 2 }, queries: [{ name: 'workspace.current' }] });
    expect(h.testInfo.attach).toHaveBeenCalledWith('report-readiness', { body: text, contentType: 'application/json' });
    for (const event of ['request', 'requestfailed', 'response', 'pageerror']) expect(h.page.listenerCount(event)).toBe(0);
  });

  it('retains selected report body completion and failure without recording report text', async () => {
    const h = harness(); const finish = await h.start();
    const response = { url: () => 'http://localhost/api/sync/rest-query?name=reports.get&args=private', status: () => 200 };
    h.page.emit('response', { ...response, json: async () => ({ rows: [{ report_id: 'actual-report', body_md: 'private' }] }) });
    h.page.emit('response', { ...response, json: async () => { throw new Error('body interrupted'); } });
    await finish();
    const text = persisted.mock.calls[0][1]; const evidence = JSON.parse(text);
    expect(evidence.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'completed', name: 'reports.get', reportIds: ['actual-report'] }),
      expect.objectContaining({ phase: 'body-failed', name: 'reports.get', error: 'Error: body interrupted' }),
    ]));
    expect(text).not.toContain('private');
  });

  it('bounds failure evidence and still writes when the failed page cannot be evaluated', async () => {
    const h = harness(); const finish = await h.start();
    for (let i = 0; i < 150; i++) {
      h.page.emit('request', request('http://localhost/api/flags/bootstrap'));
      h.page.emit('pageerror', new Error('startup failed'));
    }
    h.page.evaluate.mockRejectedValue(new Error('page already closed'));
    await finish();
    const evidence = JSON.parse(persisted.mock.calls[0][1]);
    expect(evidence.requests).toHaveLength(100); expect(evidence.failures).toHaveLength(100);
    expect(evidence.rendering.unavailable).toContain('page already closed');
  });
});
