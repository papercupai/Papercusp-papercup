import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => ({ fixtures: {} as Record<string, any> }));
vi.mock('@playwright/test', async () => {
  const { expect } = await import('vitest');
  return {
    expect,
    test: { extend: (fixtures: Record<string, any>) => { registered.fixtures = fixtures; return {}; } },
  };
});
import '../e2e/_egress';

function harness(status = 'timedOut', controlFails = false) {
  const context = new EventEmitter() as EventEmitter & { pages(): EventEmitter[] };
  const page = new EventEmitter() as EventEmitter & {
    evaluate: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
  };
  const pages: EventEmitter[] = [page];
  const order: string[] = [];
  const attachments: Array<{ name: string; value: any }> = [];
  context.pages = () => pages;
  page.evaluate = vi.fn(async (_callback, url: string) => {
    order.push('control');
    if (controlFails) throw new Error('page already closed');
    context.emit('request', { url: () => url });
  });
  page.waitForTimeout = vi.fn(async () => {});
  const testInfo = {
    status, expectedStatus: 'passed',
    attach: vi.fn(async (name: string, attachment: { body: string; contentType: string }) => {
      expect(attachment.contentType).toBe('application/json');
      order.push(name);
      attachments.push({ name, value: JSON.parse(attachment.body) });
    }),
  };
  const run = (body: () => void) => registered.fixtures.egressAudit[0](
    { context, page, baseURL: 'http://localhost:40135', egressAllowedOrigins: [] },
    async () => { body(); }, testInfo,
  );
  return { context, page, pages, testInfo, run, order, attachments };
}

function failedRequest(url: string, resourceType = 'script', errorText: string | null = 'net::ERR_NETWORK_CHANGED') {
  return { url: () => url, resourceType: () => resourceType, failure: () => errorText === null ? null : { errorText } };
}

describe('maintained Playwright failure diagnostics', () => {
  it('retains module and page errors when setup times out before a final assertion', async () => {
    const h = harness();
    await h.run(() => {
      h.page.emit('pageerror', new Error('Failed to fetch dynamically imported module'));
      h.context.emit('requestfailed', failedRequest('http://localhost:40135/src/main.tsx?token=private#fragment'));
    });
    expect(h.attachments.find(a => a.name === 'browser-diagnostics')?.value).toEqual({
      pageErrors: ['Failed to fetch dynamically imported module'],
      failedScripts: [{ path: '/src/main.tsx', error: 'net::ERR_NETWORK_CHANGED' }],
    });
    expect(h.order.indexOf('browser-diagnostics')).toBeLessThan(h.order.indexOf('control'));
    expect(h.attachments.some(a => a.name === 'egress-report')).toBe(true);
  });

  it('captures popup failures, excludes unrelated requests, and detaches its listeners', async () => {
    const h = harness('failed');
    const popup = new EventEmitter();
    await h.run(() => {
      h.pages.push(popup);
      h.context.emit('page', popup);
      popup.emit('pageerror', new Error('popup module failed'));
      h.context.emit('requestfailed', failedRequest('http://localhost:40135/image.png', 'image'));
      h.context.emit('requestfailed', failedRequest('http://localhost:40135/chunk.js?secret=x', 'script', null));
    });
    expect(h.attachments.find(a => a.name === 'browser-diagnostics')?.value).toEqual({
      pageErrors: ['popup module failed'], failedScripts: [{ path: '/chunk.js', error: 'unknown' }],
    });
    expect(h.context.listenerCount('requestfailed')).toBe(0);
    expect(h.page.listenerCount('pageerror')).toBe(0);
    expect(popup.listenerCount('pageerror')).toBe(0);
  });

  it('retains errors even when the teardown control cannot use the failed page', async () => {
    const h = harness('failed', true);
    await h.run(() => h.page.emit('pageerror', new Error('startup failed')));
    expect(h.attachments.find(a => a.name === 'browser-diagnostics')?.value.pageErrors).toEqual(['startup failed']);
    expect(h.order[0]).toBe('browser-diagnostics');
    const report = h.attachments.find(a => a.name === 'egress-report')?.value;
    expect(report.sensor.blindTo.join(' ')).toContain('page already closed');
  });

  it('preserves a successful sensor verdict without a failure attachment', async () => {
    const h = harness('passed');
    await h.run(() => h.context.emit('request', { url: () => 'http://localhost:40135/src/main.tsx' }));
    expect(h.page.evaluate).toHaveBeenCalledOnce();
    expect(h.attachments).toEqual([]);
  });
});
