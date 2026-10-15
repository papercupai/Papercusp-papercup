/**
 * P-029 live hosted transport/performance acceptance.
 *
 * Run only through playwright.hosted-http1.config.ts. The profile requires a
 * private authenticated storage-state file, forces Chromium to HTTP/1.1, and
 * emits only a redacted receipt. This is intentionally one serial scenario:
 * socket pressure, cross-tab ownership and replay are temporal properties.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from './_egress';
import {
  isForcedHttp1,
  readHostedHttp1AcceptanceConfig,
  redactEvidenceUrl,
} from './_hosted-http1-config';

const acceptance = readHostedHttp1AcceptanceConfig();

// This profile is intentionally a browser client of the exact hosted origin it
// measures. Keep the allowance local and exact: every CDN/analytics/vendor
// origin must remain a foreign-egress failure.
test.use({ egressAllowedOrigins: [acceptance.origin] });

const CONTROL_QUERY = 'workspaceHosts.control';
const CONTROL_SSE_PATH = '/api/hosted/browser/sse';
const REST_QUERY_PATH = '/api/hosted/browser/rest-query';
const HIDDEN_TIMER_PRODUCTION_MS = 5 * 60_000;
const HIDDEN_TIMER_ACCEPTANCE_MS = 1_000;
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

interface SyncSnapshot {
  sse: {
    connectedSinceMs: number | null;
    reconnectCount: number;
    eventsReceived: number;
    lastEventLatencyMs: number | null;
  };
  invalidations: { fromSse: number; bySseName: Record<string, number> };
  transport: {
    requests: number;
    failures: number;
    timeouts: number;
    queued: number | null;
    queueWaitMsMax: number;
  };
  byQuery: Record<string, { requests: number; failures: number; requestMsMax: number }>;
}

interface SyncQueryEvent {
  name: string;
  outcome: 'ok' | 'error' | 'timeout' | 'aborted';
}

interface Evidence {
  contract: string;
  origin: string;
  startedAt: string;
  completedAt?: string;
  browserVersion?: string;
  forcedProtocol: string;
  protocols: Array<{ path: string; protocol: string }>;
  coldHydration?: Record<string, unknown>;
  socketPressure?: Record<string, unknown>;
  faults?: Record<string, unknown>;
  crossTab?: Record<string, unknown>;
  replay?: Record<string, unknown>;
  vitals?: Record<string, unknown>;
}

declare global {
  interface Window {
    __sync_metrics__?: { snapshot(): SyncSnapshot; queries(): SyncQueryEvent[] };
    __papercuspStreams?: () => Array<{ url: string }>;
    __p029ManualSse?: EventSource[];
    __p029Bulk?: {
      controller: AbortController;
      settled: boolean;
      outcome: string | null;
      bytes: number;
    };
    __p029Vitals?: { fcp: number | null; lcp: number | null; cls: number };
  }
}

type Cdp = Awaited<ReturnType<BrowserContext['newCDPSession']>>;

async function syncSnapshot(page: Page): Promise<SyncSnapshot> {
  return page.evaluate(() => {
    if (!window.__sync_metrics__) throw new Error('sync metrics global is absent');
    return window.__sync_metrics__.snapshot();
  });
}

async function waitForHydration(
  page: Page,
  { allowRecordedFailures = false }: { allowRecordedFailures?: boolean } = {},
): Promise<SyncSnapshot> {
  await page.waitForFunction(
    ({ queryName, allowRecordedFailures }) => {
      const metrics = window.__sync_metrics__;
      const snapshot = metrics?.snapshot();
      const latestControl = metrics?.queries().filter((event) => event.name === queryName).pop();
      return Boolean(
        snapshot &&
          snapshot.sse.connectedSinceMs !== null &&
          snapshot.byQuery[queryName]?.requests >= 1 &&
          (allowRecordedFailures
            ? latestControl?.outcome === 'ok'
            : snapshot.byQuery[queryName]?.failures === 0),
      );
    },
    { queryName: CONTROL_QUERY, allowRecordedFailures },
    { timeout: acceptance.slo.coldHydrationMs },
  );
  return syncSnapshot(page);
}

async function controlStreamCount(page: Page): Promise<number> {
  return page.evaluate((path) =>
    (window.__papercuspStreams?.() ?? []).filter((entry) => {
      try {
        return new URL(entry.url, location.href).pathname === path;
      } catch {
        return false;
      }
    }).length,
  CONTROL_SSE_PATH);
}

async function setSyntheticVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (nextHidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function openManualStreams(page: Page, count: number): Promise<void> {
  await page.evaluate(
    ({ count, path }) =>
      new Promise<void>((resolve, reject) => {
        window.__p029ManualSse?.forEach((source) => source.close());
        const sources: EventSource[] = [];
        window.__p029ManualSse = sources;
        let opened = 0;
        const timer = window.setTimeout(
          () => reject(new Error(`only ${opened}/${count} pressure streams opened`)),
          15_000,
        );
        for (let index = 0; index < count; index++) {
          const source = new EventSource(`${path}?acceptance-pressure=${index}-${Date.now()}`);
          sources.push(source);
          source.addEventListener('open', () => {
            opened += 1;
            if (opened === count) {
              window.clearTimeout(timer);
              resolve();
            }
          }, { once: true });
        }
      }),
    { count, path: CONTROL_SSE_PATH },
  );
}

async function closeManualStreams(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__p029ManualSse?.forEach((source) => source.close());
    window.__p029ManualSse = [];
  });
}

function networkProfile(offline: boolean, downloadThroughput = 10 * 1024 * 1024) {
  return {
    offline,
    latency: offline ? 0 : 20,
    downloadThroughput: offline ? 0 : downloadThroughput,
    uploadThroughput: offline ? 0 : 2 * 1024 * 1024,
  };
}

/**
 * Emit through the canonical host-only invalidation module. Playwright's test
 * loader cannot import that module in-process because @papercusp/db-org crosses
 * its ESM/CJS boundary; the repository's normal tsx host loader can. A short-
 * lived child also guarantees the PG client cannot keep the test worker alive.
 */
async function emitControlInvalidation(workspaceId: string, nonce: string): Promise<void> {
  const source = [
    '(async () => {',
    "  const { notifySyncInvalidate } = await import('@papercusp/operator-core/lib/sync-sse');",
    "  const workspaceId = process.env.P029_WORKSPACE_ID || '';",
    "  const nonce = process.env.P029_EVENT_NONCE || '';",
    "  if (!workspaceId || !nonce) throw new Error('p029_event_identity_missing');",
    "  await notifySyncInvalidate('workspaceHosts.control', { workspaceId, acceptanceNonce: nonce }, undefined, { dedupeWindowMs: 0 });",
    '  process.exit(0);',
    '})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });',
  ].join('\n');
  await execFileAsync(TSX_BIN, ['-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      P029_WORKSPACE_ID: workspaceId,
      P029_EVENT_NONCE: nonce,
    },
    timeout: 15_000,
  });
}

test.describe.configure({ mode: 'serial' });

test('forced six-connection HTTP/1.1 hosted matrix stays live and replays exactly once', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.slow();
  expect(browserName).toBe('chromium');

  const evidence: Evidence = {
    contract: 'papercusp-hosted-http1-acceptance/v1',
    origin: acceptance.origin,
    startedAt: new Date().toISOString(),
    forcedProtocol: 'http/1.1',
    protocols: [],
  };

  // Accelerate exactly the production 5-minute hidden-owner timer. The same
  // visibility handler, lease release and election code runs; only wall time is
  // compressed so the live acceptance does not burn five idle minutes.
  await context.addInitScript(
    ({ productionMs, acceptanceMs }) => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        nativeSetTimeout(
          handler,
          timeout === productionMs ? acceptanceMs : timeout,
          ...args,
        )) as typeof window.setTimeout;
      window.__p029Vitals = { fcp: null, lcp: null, cls: 0 };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') window.__p029Vitals!.fcp = entry.startTime;
          }
        }).observe({ type: 'paint', buffered: true });
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) window.__p029Vitals!.lcp = last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
            if (!entry.hadRecentInput) window.__p029Vitals!.cls += entry.value ?? 0;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {
        // The assertions below distinguish an absent expected metric from 0.
      }
      try { localStorage.clear(); } catch { /* cold cache is best-effort here */ }
      try { sessionStorage.clear(); } catch { /* cold cache is best-effort here */ }
    },
    { productionMs: HIDDEN_TIMER_PRODUCTION_MS, acceptanceMs: HIDDEN_TIMER_ACCEPTANCE_MS },
  );

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.clearBrowserCache');

  const protocolRows: Array<{ path: string; protocol: string }> = [];
  cdp.on('Network.responseReceived', (event) => {
    try {
      if (new URL(event.response.url).origin !== acceptance.origin) return;
      protocolRows.push({
        path: redactEvidenceUrl(event.response.url).slice(acceptance.origin.length) || '/',
        protocol: event.response.protocol ?? '',
      });
    } catch {
      /* malformed devtools row is not evidence */
    }
  });

  const coldStarted = Date.now();
  const navigation = await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  expect(navigation?.status()).toBe(200);
  const baseline = await waitForHydration(page);
  const coldHydrationMs = Date.now() - coldStarted;
  expect(coldHydrationMs).toBeLessThanOrEqual(acceptance.slo.coldHydrationMs);
  expect(baseline.transport.failures).toBe(0);
  expect(baseline.transport.queueWaitMsMax).toBeLessThanOrEqual(acceptance.slo.syncQueueWaitMs);

  const sessionProbe = await page.evaluate(async () => {
    const started = performance.now();
    const response = await fetch('/api/hosted/auth/session', { cache: 'no-store' });
    const body = await response.json().catch(() => null) as {
      ok?: boolean;
      session?: { workspaceId?: string; organizationId?: string; expiresAtMs?: number };
    } | null;
    return {
      status: response.status,
      durationMs: performance.now() - started,
      ok: body?.ok === true,
      workspaceId: body?.session?.workspaceId ?? null,
      organizationBound: Boolean(body?.session?.organizationId),
      expiresInMs: typeof body?.session?.expiresAtMs === 'number'
        ? body.session.expiresAtMs - Date.now()
        : null,
    };
  });
  expect(sessionProbe.status).toBe(200);
  expect(sessionProbe.ok).toBe(true);
  expect(sessionProbe.workspaceId).toBeTruthy();

  evidence.coldHydration = {
    durationMs: coldHydrationMs,
    authStatus: sessionProbe.status,
    authDurationMs: sessionProbe.durationMs,
    organizationBound: sessionProbe.organizationBound,
    sessionExpiresInMs: sessionProbe.expiresInMs,
    syncRequests: baseline.byQuery[CONTROL_QUERY]?.requests ?? 0,
    syncQueueWaitMsMax: baseline.transport.queueWaitMsMax,
    syncLastEventLatencyMs: baseline.sse.lastEventLatencyMs,
  };

  // One application control SSE + four explicit authenticated SSE streams
  // occupy five of Chromium's six HTTP/1.1 origin sockets. A throttled bulk
  // asset takes the sixth; cancellation must immediately free it for auth,
  // health and lifecycle traffic rather than leaving the page wedged.
  await openManualStreams(page, 4);
  const asset = await page.evaluate(() => {
    const candidates = performance.getEntriesByType('resource')
      .map((entry) => entry as PerformanceResourceTiming)
      .filter((entry) => {
        try {
          return new URL(entry.name).origin === location.origin && /\.(?:js|css|wasm)(?:\?|$)/.test(entry.name);
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.encodedBodySize - a.encodedBodySize);
    const chosen = candidates[0];
    return chosen ? { url: chosen.name, encodedBodySize: chosen.encodedBodySize } : null;
  });
  expect(asset, 'cold page exposed no same-origin bundle for the bulk-stream leg').not.toBeNull();
  expect(asset!.encodedBodySize, 'largest same-origin bundle is too small to be a meaningful bulk leg').toBeGreaterThan(64 * 1024);

  await cdp.send('Network.emulateNetworkConditions', networkProfile(false, 32 * 1024));
  const bulkUrl = `${asset!.url}${asset!.url.includes('?') ? '&' : '?'}p029-bulk=${Date.now()}`;
  const bulkRequest = page.waitForRequest((request) => request.url() === bulkUrl);
  await page.evaluate((url) => {
    const controller = new AbortController();
    window.__p029Bulk = { controller, settled: false, outcome: null, bytes: 0 };
    void fetch(url, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const bytes = (await response.arrayBuffer()).byteLength;
        Object.assign(window.__p029Bulk!, { settled: true, outcome: `status-${response.status}`, bytes });
      })
      .catch((error) => {
        Object.assign(window.__p029Bulk!, {
          settled: true,
          outcome: error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'error',
        });
      });
  }, bulkUrl);
  await bulkRequest;
  await page.waitForTimeout(150);

  const finite = page.evaluate(async () => {
    const timed = async (input: string, init?: RequestInit) => {
      const started = performance.now();
      const response = await fetch(input, { cache: 'no-store', ...init });
      await response.arrayBuffer();
      return { path: new URL(input, location.href).pathname, status: response.status, durationMs: performance.now() - started };
    };
    return Promise.all([
      timed('/api/hosted/auth/session'),
      timed('/api/health'),
      timed('/api/hosted/browser/workspace-hosts/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'validate-connection', connectionId: 'p029-acceptance-missing' }),
      }),
    ]);
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__p029Bulk?.controller.abort());
  const finiteResults = await finite;
  await page.waitForFunction(() => window.__p029Bulk?.settled === true);
  const cancelledBulk = await page.evaluate(() => ({
    outcome: window.__p029Bulk?.outcome ?? null,
    bytes: window.__p029Bulk?.bytes ?? 0,
  }));
  expect(cancelledBulk.outcome).toBe('aborted');
  expect(finiteResults.find((row) => row.path.endsWith('/auth/session'))?.status).toBe(200);
  expect(finiteResults.find((row) => row.path.endsWith('/health'))?.status).toBe(200);
  expect(finiteResults.find((row) => row.path.endsWith('/connection'))?.status).toBe(404);
  for (const row of finiteResults) {
    expect(row.durationMs, `${row.path} exceeded the finite-interaction SLO`).toBeLessThanOrEqual(
      acceptance.slo.finiteInteractionMs,
    );
  }

  await cdp.send('Network.emulateNetworkConditions', networkProfile(false, 512 * 1024));
  const completedBulk = await page.evaluate(async (url) => {
    const started = performance.now();
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}p029-complete=${Date.now()}`, {
      cache: 'no-store',
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    return { status: response.status, bytes, durationMs: performance.now() - started };
  }, asset!.url);
  expect(completedBulk.status).toBe(200);
  expect(completedBulk.bytes).toBeGreaterThan(64 * 1024);
  await closeManualStreams(page);
  await cdp.send('Network.emulateNetworkConditions', networkProfile(false));

  evidence.socketPressure = {
    connectionCap: 6,
    applicationControlSse: 1,
    pressureSse: 4,
    cancelledBulk,
    completedBulk,
    finite: finiteResults,
  };

  // One-shot transport failures hit the real hosted page boundary. Each cold
  // reload must retry through the production query client and return to a
  // connected, hydrated state; an anonymous/skipped run cannot satisfy this.
  type Fault = '429' | '500' | 'timeout';
  let fault: Fault | null = null;
  const injected: Record<Fault, { requests: number; failures: number; timeouts: number }> = {
    '429': { requests: 0, failures: 0, timeouts: 0 },
    '500': { requests: 0, failures: 0, timeouts: 0 },
    timeout: { requests: 0, failures: 0, timeouts: 0 },
  };
  await page.route(`**${REST_QUERY_PATH}**`, async (route) => {
    if (!fault) return route.fallback();
    const current = fault;
    fault = null;
    if (current === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.abort('timedout');
      return;
    }
    await route.fulfill({
      status: Number(current),
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: `acceptance_injected_${current}` }),
    });
  });

  for (const kind of ['429', '500', 'timeout'] as const) {
    fault = kind;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const recovered = await waitForHydration(page, { allowRecordedFailures: true });
    expect(fault, `${kind} injection was bypassed`).toBeNull();
    expect(recovered.transport.failures).toBeGreaterThanOrEqual(1);
    expect(recovered.byQuery[CONTROL_QUERY]?.requests ?? 0).toBeGreaterThanOrEqual(2);
    injected[kind] = {
      requests: recovered.transport.requests,
      failures: recovered.transport.failures,
      timeouts: recovered.transport.timeouts,
    };
  }
  await page.unroute(`**${REST_QUERY_PATH}**`);
  evidence.faults = { injected, recovered: true };

  // Two tabs must share one physical control SSE. Hide the owner (timer
  // accelerated above), prove the visible peer takes over, then close that
  // owner and prove the surviving default page reacquires the lease.
  const peerStarted = Date.now();
  const peer = await context.newPage();
  await peer.goto('/cloud-workspaces?acceptance-peer=1', { waitUntil: 'domcontentloaded' });
  await waitForHydration(peer);
  await expect.poll(async () => (await controlStreamCount(page)) + (await controlStreamCount(peer)), {
    timeout: 15_000,
  }).toBe(1);

  let owner = (await controlStreamCount(page)) === 1 ? page : peer;
  let follower = owner === page ? peer : page;
  const hiddenStarted = Date.now();
  await setSyntheticVisibility(owner, true);
  await expect.poll(() => controlStreamCount(owner), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => controlStreamCount(follower), { timeout: 10_000 }).toBe(1);
  const hiddenFailoverMs = Date.now() - hiddenStarted;
  await setSyntheticVisibility(owner, false);

  // Keep the fixture's default page alive for its egress-control teardown.
  // If it currently owns the stream, hide it so the expendable peer owns the
  // physical source before the genuine owner-death leg.
  if ((await controlStreamCount(peer)) !== 1) {
    await setSyntheticVisibility(page, true);
    await expect.poll(() => controlStreamCount(peer), { timeout: 10_000 }).toBe(1);
  }
  const lossStarted = Date.now();
  await peer.close();
  await setSyntheticVisibility(page, false);
  await expect.poll(() => controlStreamCount(page), { timeout: 15_000 }).toBe(1);
  await page.waitForFunction(() => window.__sync_metrics__?.snapshot().sse.connectedSinceMs !== null);
  const leaderLossFailoverMs = Date.now() - lossStarted;

  evidence.crossTab = {
    peerColdHydrationMs: Date.now() - peerStarted,
    physicalControlStreamsAcrossTwoTabs: 1,
    hiddenTimerProductionMs: HIDDEN_TIMER_PRODUCTION_MS,
    hiddenTimerAcceptanceMs: HIDDEN_TIMER_ACCEPTANCE_MS,
    hiddenFailoverMs,
    leaderLossFailoverMs,
  };

  // Seed one connected event, then emit another while Chromium is offline.
  // Delivery only after reconnection is direct live evidence of Last-Event-ID
  // replay; the exact +1 assertion rejects both loss and duplication.
  const workspaceId = sessionProbe.workspaceId as string;
  const connectedBefore = await syncSnapshot(page);
  const firstBefore = connectedBefore.invalidations.bySseName[CONTROL_QUERY] ?? 0;
  await emitControlInvalidation(workspaceId, `p029-connected-${Date.now()}`);
  await expect.poll(async () => (await syncSnapshot(page)).invalidations.bySseName[CONTROL_QUERY] ?? 0, {
    timeout: 10_000,
  }).toBe(firstBefore + 1);

  const beforeOffline = await syncSnapshot(page);
  const replayBase = beforeOffline.invalidations.bySseName[CONTROL_QUERY] ?? 0;
  await cdp.send('Network.emulateNetworkConditions', networkProfile(true));
  // CDP offline emulation does not promise to tear down an EventSource socket
  // that was already established. Drive the production visibility-pause path
  // while the browser is offline so the physical stream is deterministically
  // closed before the invalidation is emitted.
  await setSyntheticVisibility(page, true);
  await expect.poll(async () => (await syncSnapshot(page)).sse.connectedSinceMs, {
    timeout: 10_000,
  }).toBeNull();
  await emitControlInvalidation(workspaceId, `p029-offline-${Date.now()}`);
  await page.waitForTimeout(300);
  expect((await syncSnapshot(page)).invalidations.bySseName[CONTROL_QUERY] ?? 0).toBe(replayBase);

  const replayStarted = Date.now();
  await cdp.send('Network.emulateNetworkConditions', networkProfile(false));
  await setSyntheticVisibility(page, false);
  await expect.poll(async () => {
    const snapshot = await syncSnapshot(page);
    return {
      count: snapshot.invalidations.bySseName[CONTROL_QUERY] ?? 0,
      connected: snapshot.sse.connectedSinceMs !== null,
      reconnected: snapshot.sse.reconnectCount > beforeOffline.sse.reconnectCount,
    };
  }, { timeout: acceptance.slo.reconnectReplayMs }).toEqual({
    count: replayBase + 1,
    connected: true,
    reconnected: true,
  });
  await page.waitForTimeout(300);
  const afterReplay = await syncSnapshot(page);
  expect(afterReplay.invalidations.bySseName[CONTROL_QUERY] ?? 0).toBe(replayBase + 1);
  evidence.replay = {
    offlineEventCountBeforeReconnect: replayBase,
    eventCountAfterReconnect: replayBase + 1,
    replayDelta: 1,
    reconnectCountDelta: afterReplay.sse.reconnectCount - beforeOffline.sse.reconnectCount,
    durationMs: Date.now() - replayStarted,
  };

  await page.mouse.click(2, 2);
  await page.waitForTimeout(1_000);
  const vitals = await page.evaluate(() => ({
    ...window.__p029Vitals,
    domContentLoadedMs: performance.getEntriesByType('navigation')[0]
      ? (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventEnd
      : null,
  }));
  expect(vitals.fcp, 'FCP instrument produced no value').not.toBeNull();
  expect(vitals.lcp, 'LCP instrument produced no value').not.toBeNull();
  expect(vitals.fcp!).toBeLessThanOrEqual(acceptance.slo.fcpMs);
  expect(vitals.lcp!).toBeLessThanOrEqual(acceptance.slo.lcpMs);
  expect(vitals.cls).toBeLessThanOrEqual(0.1);
  evidence.vitals = vitals;

  evidence.browserVersion = await page.evaluate(() => navigator.userAgent.replace(/\([^)]*\)/g, '(redacted-platform)'));
  evidence.protocols = protocolRows;
  expect(protocolRows.length, 'CDP observed no same-origin responses').toBeGreaterThan(0);
  expect(
    protocolRows.filter((row) => !isForcedHttp1(row.protocol)),
    'HTTP/2 or HTTP/3 negotiated even though correctness acceptance is forced to HTTP/1.1',
  ).toEqual([]);

  evidence.completedAt = new Date().toISOString();
  await testInfo.attach('hosted-http1-acceptance-redacted', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
});
