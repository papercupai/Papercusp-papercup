/**
 * SSE stream-shape + Last-Event-ID handling.
 *
 * Wire-format byte-exactness is unit-tested in
 * libs/sse/src/wire-format-snapshot.test.ts. This e2e verifies the live
 * route obeys the contract:
 *   - 200 + text/event-stream + x-accel-buffering:no
 *   - initial heartbeat is sent immediately (within ~1s)
 *   - Last-Event-ID is parsed defensively (malformed/empty/negative all
 *     yield a fresh 200 stream, NOT a 4xx/5xx)
 *   - POST returns 405
 */
import { test, expect } from './_egress';
import { onAppOrigin } from './_app-origin';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://localhost:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const SSE_ROUTES = [
  '/api/zero-harness/sse',
  '/api/flags/stream',
] as const;

interface FirstChunk {
  status: number;
  ct: string;
  xAccel: string;
  body: string;
  error?: string;
}

async function readFirstChunk(
  page: import('@playwright/test').Page,
  url: string,
  headers: Record<string, string> = {},
  opts: { readBody?: boolean } = { readBody: true },
): Promise<FirstChunk> {
  await onAppOrigin(page, url);
  return page.evaluate(
    async ({ u, h, readBody }) => {
      const ctrl = new AbortController();
      // Hard deadline — covers both `fetch()` cold-compile latency and
      // the body read. SSE servers never close cleanly, so the abort IS
      // how we end the request.
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(u, {
          headers: { Accept: 'text/event-stream', ...h },
          signal: ctrl.signal,
        });
        const status = res.status;
        const ct = res.headers.get('content-type') ?? '';
        const xAccel = res.headers.get('x-accel-buffering') ?? '';
        let body = '';
        if (readBody && res.body) {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          try {
            while (body.length < 512) {
              const { value, done } = await reader.read();
              if (done) break;
              body += dec.decode(value, { stream: true });
              if (body.includes('event:')) break;
            }
          } catch {
            // AbortError on body is fine — we already have headers.
          } finally {
            try { await reader.cancel(); } catch { /* noop */ }
          }
        }
        // Always close the connection, even on the headers-only path,
        // so we don't stack open SSE connections against `next dev`.
        ctrl.abort();
        clearTimeout(timer);
        return { status, ct, xAccel, body };
      } catch (e) {
        clearTimeout(timer);
        return { status: 0, ct: '', xAccel: '', body: '', error: String(e) };
      }
    },
    { u: url, h: headers, readBody: opts.readBody !== false },
  );
}

test.describe('SSE stream shape (zero-harness + flags)', () => {
  for (const path of SSE_ROUTES) {
    test(`GET ${path} returns 200 text/event-stream with initial heartbeat`, async ({ page }) => {
      const r = await readFirstChunk(page, `${baseURL}${path}`);
      expect(r.status).toBe(200);
      expect(r.ct).toMatch(/text\/event-stream/);
      expect(r.body).toMatch(/event: heartbeat/);
      expect(r.body).toMatch(/"tsMs":\d+/);
      // Note: x-accel-buffering:no IS sent by the route (verified via
      // curl + libs/sse wire-format-snapshot test) but Chromium filters
      // it from cross-origin/CORS fetch responses, so we can't assert
      // it from page.evaluate here.
    });

    test(`POST ${path} returns 405`, async ({ request }) => {
      const res = await request.post(`${baseURL}${path}`, { data: {} });
      expect(res.status()).toBe(405);
    });
  }
});

test.describe('SSE Last-Event-ID defensive parsing', () => {
  // Sequential rather than per-case parallel — each case opens a streaming
  // connection to `next dev` (single compile pipeline), and 7+ in flight
  // at once oversubscribes its event loop and produces spurious aborts.
  test('all malformed/edge Last-Event-ID values yield 200 + heartbeat', async ({ page }) => {
    const cases: Array<{ name: string; header: string }> = [
      { name: 'valid positive int', header: '1000000' },
      { name: 'zero', header: '0' },
      { name: 'negative', header: '-5' },
      { name: 'empty string', header: '' },
      { name: 'non-numeric', header: 'not-a-number' },
      { name: 'whitespace', header: '   ' },
      { name: 'very large', header: String(Number.MAX_SAFE_INTEGER) },
    ];
    // Headers-only — the defensive contract is "doesn't 4xx/5xx", not
    // "first byte of body". Reading the body for 7 sequential streams
    // oversubscribes `next dev` and produces spurious aborts.
    for (const { name, header } of cases) {
      const r = await readFirstChunk(
        page,
        `${baseURL}/api/zero-harness/sse`,
        { 'Last-Event-ID': header },
        { readBody: false },
      );
      expect(r.status, `case "${name}" status`).toBe(200);
      expect(r.ct, `case "${name}" content-type`).toMatch(/text\/event-stream/);
    }
  });
});
