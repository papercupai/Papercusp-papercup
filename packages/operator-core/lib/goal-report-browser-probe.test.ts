import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { goalReportBrowserFeedProbeScript } from '../test/fixtures/goal-owner-report';

describe('native GOAL report browser feed probe', () => {
  it('reads the real fetch result with immutable Tauri internals and declares unmeasured transmission', async () => {
    const invoke = () => { throw new Error('must not intercept invoke'); };
    const internals = Object.defineProperty({}, 'invoke', { value: invoke });
    const window: any = { __PAPERCUSP_WS__: 'fixture-workspace' };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals });
    const request = '/api/zero-harness/rest-query?name=plans.attention';
    const pin = { rows: [{ items: [{ id: 'coord-message:fixture', report: { goalReport: { reportId: 'pinned' } } }] }] };
    const requests: string[] = [];
    runInNewContext(goalReportBrowserFeedProbeScript(request), {
      window, location: { href: '/inbox' }, Object,
      fetch: async (path: string) => { requests.push(path); return { status: 200, json: async () => pin }; },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(requests).toEqual([request]);
    expect(window.__goalReportFeedProbe).toMatchObject({ done: true, status: 200, data: pin,
      browserWorkspace: 'fixture-workspace', ipcTransmission: { status: 'unknown', invokeWritable: false, invokeConfigurable: false } });
    expect(window.__TAURI_INTERNALS__).toBe(internals);
    expect(internals).toHaveProperty('invoke', invoke);
  });

  it('preserves the failed browser request instead of reporting routing success', async () => {
    const window: any = {};
    runInNewContext(goalReportBrowserFeedProbeScript('/api/failed'), {
      window, location: { href: '/inbox' }, Object,
      fetch: async () => { throw new Error('bridge unavailable'); },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(window.__goalReportFeedProbe).toMatchObject({ done: true, error: 'Error: bridge unavailable',
      ipcTransmission: { status: 'unknown' } });
    expect(window.__goalReportFeedProbe.status).toBeUndefined();
  });
});
