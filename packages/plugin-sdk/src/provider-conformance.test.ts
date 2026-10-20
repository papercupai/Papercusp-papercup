/**
 * Provider conformance kit (provider-adapters-to-packages-2026-10-11 P-026).
 *
 * A conforming reference package passes every check; each deliberately flawed variant fails the
 * check written for that flaw. The flaw table is what proves each check can fail: a check no flaw
 * trips would be untested.
 */
import { describe, expect, it } from 'vitest';
import type { HostFetchResponse, ProviderAdapter, ProviderDescriptor, ProviderSyncPage } from './provider';
import { providerSocialDeleteResultIssue, providerSocialWriteResultIssue, providerSyncErrorOf } from './provider';
import {
  CONFORMANCE_UNREADABLE_CURSOR,
  PROVIDER_CONFORMANCE_CHECKS,
  formatProviderConformanceReport,
  jsonResponse,
  recordedHostFetch,
  runProviderConformance,
  type ProviderConformanceCheck,
  type ProviderConformanceHarness,
} from './provider-conformance';

const API = 'api.demo-social.example';
const ITEMS = [1, 2, 3, 4, 5].map((n) => ({ id: `post-${n}`, text: `hello ${n}`, updated: `2026-10-0${n}T12:00:00.000Z` }));

interface Flaws {
  /** A cursor it did not issue most recently is read inclusively, so a resume repeats a record. */
  inclusiveResume: boolean;
  escapeEgress: boolean;
  wrongSource: boolean;
  undeclaredDatatype: boolean;
  unstableIds: boolean;
  duplicateInPage: boolean;
  retryOn429: boolean;
  swallowAuth: boolean;
  retryOn503: boolean;
  coldStartOnUnreadableCursor: boolean;
  ignoreExpiredCursor: boolean;
  restartFromFinalCursor: boolean;
  dropRetryAfter: boolean;
  badPostShape: boolean;
  invokeRetries: boolean;
  acceptsUndeclared: boolean;
  declaresUnexercised: boolean;
  invalidDescriptor: boolean;
  neverEnds: boolean;
  ignoreRetentionLoss: boolean;
}

function readCursor(raw: string): { v?: unknown; after?: unknown } | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as { v?: unknown; after?: unknown }) : null;
  } catch {
    return null;
  }
}

function demoAdapter(flaws: Partial<Flaws> = {}): ProviderAdapter {
  let unstable = 0;
  let lastIssued: string | null = null;
  const descriptor: ProviderDescriptor = {
    id: flaws.invalidDescriptor ? 'Demo Social' : 'demo-social',
    contractVersion: 1,
    displayName: 'Demo social',
    datatypes: ['social-post'],
    capabilities: flaws.declaresUnexercised ? ['social.post', 'social.delete', 'social.reply'] : ['social.post', 'social.delete'],
    egressHosts: [API],
  };
  const issue = (after: number | null): string | null => {
    if (after === null) return null;
    lastIssued = JSON.stringify({ v: 1, after });
    return lastIssued;
  };
  return {
    describe: () => descriptor,
    async syncPage(request, host): Promise<ProviderSyncPage> {
      let after = 0;
      let retentionGap = false;
      if (request.cursor !== null) {
        const parsed = readCursor(request.cursor);
        if (!parsed || parsed.v !== 1 || typeof parsed.after !== 'number') {
          if (!flaws.coldStartOnUnreadableCursor) throw { kind: 'cursor-expired', message: 'demo_cursor_unreadable' };
        } else {
          after = parsed.after;
          retentionGap = after < 0;
          if (retentionGap) after = 0;
          if (flaws.inclusiveResume && request.cursor !== lastIssued && after > 0) after -= 1;
        }
      }
      if (flaws.restartFromFinalCursor && request.mode === 'incremental') after = 0;
      const url = `https://${flaws.escapeEgress ? 'cdn.elsewhere.example' : API}/items?after=${after}&limit=2`;
      const call = () => host.fetch({ source: flaws.wrongSource ? 'some-other-source' : request.source, request: { url } });
      let res = await call();
      if ((flaws.retryOn429 && res.status === 429) || (flaws.retryOn503 && res.status === 503)) res = await call();
      if (res.status === 429) {
        const retry = Number(res.headers['retry-after']);
        throw flaws.dropRetryAfter ? { kind: 'rate-limited', message: 'demo_rate_limited' } : { kind: 'rate-limited', retryAfterSeconds: retry, message: 'demo_rate_limited' };
      }
      if (res.status === 401) {
        if (flaws.swallowAuth) return { records: [], nextCursor: request.cursor, hasMore: false };
        throw { kind: 'auth', message: 'demo_access_denied' };
      }
      if (res.status === 410) {
        if (flaws.ignoreExpiredCursor) return { records: [], nextCursor: null, hasMore: false };
        throw { kind: 'cursor-expired', message: 'demo_cursor_expired' };
      }
      if (res.status >= 300) throw { kind: 'transient', message: `demo_http_${res.status}` };
      const body = JSON.parse(res.body) as { items: typeof ITEMS; nextAfter: number | null };
      const items = flaws.duplicateInPage && body.items.length > 0 ? [...body.items, body.items[0]!] : body.items;
      const records = items.map((item) => ({
        datatype: flaws.undeclaredDatatype ? 'tweet' : 'social-post',
        nativeId: flaws.unstableIds ? `${item.id}-${unstable++}` : item.id,
        event: 'post.seen',
        payload: { text: item.text },
        occurredAt: item.updated,
      }));
      if (flaws.neverEnds) return { records, nextCursor: issue(after + 1), hasMore: true };
      return { records, nextCursor: issue(body.nextAfter ?? after + body.items.length), hasMore: body.nextAfter !== null,
        ...(retentionGap && !flaws.ignoreRetentionLoss ? {
          catchUp: { path: 'backfill' as const, reason: 'cursor-expired' as const },
          lossRisk: { kind: 'retention-window-exceeded' as const, oldestReachableAt: ITEMS[0]!.updated, detail: 'Old events fell outside retention' },
        } : {}),
      };
    },
    async invoke(request, host) {
      if (request.capability === 'social.post') {
        const call = () =>
          host.fetch({ source: request.source, request: { url: `https://${API}/posts`, method: 'POST', body: JSON.stringify({ text: request.args.text }) } });
        let res = await call();
        if (flaws.invokeRetries && res.status === 429) res = await call();
        if (res.status === 429) throw { kind: 'rate-limited', message: 'demo_rate_limited' };
        const created = JSON.parse(res.body) as { id: string };
        return flaws.badPostShape ? { id: created.id } : { externalId: created.id, url: `https://demo-social.example/p/${created.id}` };
      }
      if (request.capability === 'social.delete') {
        const res = await host.fetch({ source: request.source, request: { url: `https://${API}/posts/${String(request.args.externalId)}`, method: 'DELETE' } });
        if (res.status === 429) throw { kind: 'rate-limited', message: 'demo_rate_limited' };
        return { deleted: res.status === 204 };
      }
      if (flaws.acceptsUndeclared) return {};
      throw new Error(`demo_capability_unsupported:${request.capability}`);
    },
  };
}

function demoWorld() {
  return recordedHostFetch([
    {
      method: 'GET',
      url: (url) => url.hostname === API && url.pathname === '/items',
      response: (request): HostFetchResponse => {
        const url = new URL(request.url);
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        const items = ITEMS.slice(after, after + limit);
        const nextAfter = after + limit < ITEMS.length ? after + limit : null;
        return jsonResponse(200, { items, nextAfter });
      },
    },
    { method: 'POST', url: `https://${API}/posts`, response: jsonResponse(201, { id: 'post-100' }) },
    { method: 'DELETE', url: `https://${API}/posts/post-100`, response: { status: 204, headers: {}, body: '', bodyEncoding: 'utf8' } },
  ]).fetch;
}

function harness(flaws: Partial<Flaws> = {}): ProviderConformanceHarness {
  return {
    adapter: demoAdapter(flaws),
    createFetch: demoWorld,
    retentionGap: { cursor: JSON.stringify({ v: 1, after: -1 }), oldestReachableAt: ITEMS[0]!.updated },
    faults: { expiredCursor: { cursor: JSON.stringify({ v: 1, after: 2 }), response: jsonResponse(410, { error: 'cursor too old' }) } },
    invocations: [
      { capability: 'social.post', args: { text: 'launch day' } },
      { capability: 'social.delete', args: { externalId: 'post-100' } },
    ],
  };
}

describe('runProviderConformance', () => {
  it('checks instance egress against the source connection, with foreign and missing-origin controls', async () => {
    const make = async (connectionOrigin?: string) => {
      const test = harness(); const original = test.adapter;
      const d = await original.describe();
      const translate = (host: Parameters<ProviderAdapter['syncPage']>[1]) => ({ fetch: (input: Parameters<typeof host.fetch>[0]) => host.fetch({
        ...input, request: { ...input.request, url: input.request.url.replace(`https://${API}`, 'https://one.example.com') },
      }) });
      test.adapter = { describe: () => ({ ...d, egressHosts: [], oauth: { instance: true, authorizeUrl: '/authorize', tokenUrl: '/token', scopes: ['read'] } }),
        syncPage: (request, host) => original.syncPage(request, translate(host)),
        invoke: (request, host) => original.invoke(request, translate(host)),
      };
      test.config = connectionOrigin ? { connectionOrigin } : {};
      test.createFetch = () => { const inner = demoWorld(); return (input) => inner({ ...input,
        request: { ...input.request, url: input.request.url.replace('https://one.example.com', `https://${API}`) },
      }); };
      return runProviderConformance(test);
    };
    const good = await make('https://one.example.com');
    expect(good.failures, formatProviderConformanceReport(good)).toEqual([]);
    expect(good.checksSkipped).toEqual([]);
    for (const origin of ['https://other.example.com', undefined]) {
      const bad = await make(origin);
      expect(bad.failures.map((f) => f.check)).toContain('egress-confined');
    }
  });
  it('passes a conforming package on every check, skipping none', async () => {
    const report = await runProviderConformance(harness());
    expect(report.failures, formatProviderConformanceReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.providerId).toBe('demo-social');
    expect(report.checksSkipped).toEqual([]);
    expect([...report.checksRun].sort()).toEqual([...PROVIDER_CONFORMANCE_CHECKS].sort());
  });

  const cases: Array<[keyof Flaws, ProviderConformanceCheck]> = [
    ['inclusiveResume', 'resume-without-duplicates'],
    ['escapeEgress', 'egress-confined'],
    ['wrongSource', 'fetch-uses-request-source'],
    ['undeclaredDatatype', 'records-well-formed'],
    ['unstableIds', 'native-ids-stable'],
    ['duplicateInPage', 'no-duplicate-records'],
    ['retryOn429', 'rate-limit-not-retried'],
    ['dropRetryAfter', 'rate-limit-not-retried'],
    ['swallowAuth', 'auth-not-retried'],
    ['retryOn503', 'server-error-not-retried'],
    ['coldStartOnUnreadableCursor', 'unreadable-cursor-is-cursor-expired'],
    ['ignoreExpiredCursor', 'expired-cursor-is-cursor-expired'],
    ['restartFromFinalCursor', 'final-cursor-does-not-restart'],
    ['badPostShape', 'invoke-result-shape'],
    ['invokeRetries', 'invoke-fault-not-retried'],
    ['acceptsUndeclared', 'undeclared-capability-refused'],
    ['declaresUnexercised', 'capability-exercised'],
    ['invalidDescriptor', 'descriptor-valid'],
    ['neverEnds', 'pages-to-completion'],
    ['ignoreRetentionLoss', 'retention-loss-reported'],
  ];

  it.each(cases)('a package with flaw %s fails %s', async (flaw, check) => {
    const report = await runProviderConformance(harness({ [flaw]: true }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.check), formatProviderConformanceReport(report)).toContain(check);
  });

  it('does not fault a capability that sends no request, but still faults one that swallows a 429', async () => {
    const base = harness();
    const inner = base.adapter;
    const declared = await inner.describe();
    const withTransform = (swallow429: boolean): ProviderAdapter => {
      const descriptor = { ...declared, capabilities: [...declared.capabilities, 'ingress.normalize'] };
      return {
        ...inner,
        describe: () => descriptor,
        async invoke(request, host) {
          // A pure transform: it reads its args and never calls host.fetch.
          if (request.capability === 'ingress.normalize') return { records: [] };
          if (swallow429 && request.capability === 'social.delete') {
            const res = await host.fetch({ source: request.source, request: { url: `https://${API}/posts/${String(request.args.externalId)}`, method: 'DELETE' } });
            return { deleted: res.status === 204 };
          }
          return inner.invoke(request, host);
        },
      };
    };
    const invocations = [...(base.invocations ?? []), { capability: 'ingress.normalize', args: { payload: {} } }];

    const clean = await runProviderConformance({ ...base, adapter: withTransform(false), invocations });
    expect(clean.failures, formatProviderConformanceReport(clean)).toEqual([]);

    const swallowing = await runProviderConformance({ ...base, adapter: withTransform(true), invocations });
    const findings = swallowing.failures.filter((f) => f.check === 'invoke-fault-not-retried');
    expect(findings.map((f) => f.detail)).toEqual(['social.delete resolved although its first request was rate-limited']);
  });

  it('fails a package whose syncPage repeats a record across resumed pages, and only on resume', async () => {
    const report = await runProviderConformance(harness({ inclusiveResume: true }));
    const checks = report.failures.map((f) => f.check);
    expect(checks).toEqual(['resume-without-duplicates']);
    expect(report.failures[0]!.detail).toContain('social-post:post-2:post.seen');
  });

  it('says which checks it skipped when the fake cannot exercise them', async () => {
    const single = recordedHostFetch([
      { url: (u) => u.pathname === '/items', response: jsonResponse(200, { items: ITEMS.slice(0, 1), nextAfter: null }) },
    ]).fetch;
    const report = await runProviderConformance({ ...harness(), createFetch: () => single, faults: {} });
    const skipped = report.checksSkipped.map((s) => s.check);
    expect(skipped).toContain('resume-without-duplicates');
    expect(skipped).toContain('expired-cursor-is-cursor-expired');
    expect(skipped).toContain('final-cursor-does-not-restart');
  });

  it('formats a failing report with one line per finding', async () => {
    const report = await runProviderConformance(harness({ escapeEgress: true }));
    expect(formatProviderConformanceReport(report)).toMatch(/^demo-social: \d+ conformance failure\(s\)\n {2}- \[/);
  });

  it('checks retention reporting after the host resets a rejected cursor', async () => {
    const test = harness();
    const adapter = test.adapter;
    test.adapter = { ...adapter, syncPage: async (request, host) => {
      if (request.cursor === test.retentionGap!.cursor) throw { kind: 'cursor-expired', message: 'old cursor' };
      return adapter.syncPage({ ...request, cursor: request.cursor === null ? request.catchUpFrom ?? null : request.cursor }, host);
    } };
    const report = await runProviderConformance(test);
    expect(report.failures, formatProviderConformanceReport(report)).toEqual([]);
    expect(report.checksRun).toContain('retention-loss-reported');
  });

  it('rejects a retention report naming the wrong reachable boundary', async () => {
    const test = harness();
    test.retentionGap!.oldestReachableAt = '2026-10-02T12:00:00Z';
    const report = await runProviderConformance(test);
    expect(report.failures.map((entry) => entry.check)).toEqual(['retention-loss-reported']);
  });
});

describe('recordedHostFetch', () => {
  it('answers the first matching exchange and records every call', async () => {
    const recorded = recordedHostFetch([
      { method: 'POST', url: 'https://a.example/x', response: jsonResponse(201, { ok: 1 }) },
      { url: /^https:\/\/a\.example\//, response: jsonResponse(200, { ok: 2 }) },
    ]);
    const post = await recorded.fetch({ source: 's', request: { url: 'https://a.example/x', method: 'post' } });
    const get = await recorded.fetch({ source: 's', request: { url: 'https://a.example/x' } });
    expect(post.status).toBe(201);
    expect(get.status).toBe(200);
    expect(recorded.calls.map((c) => c.request.method ?? 'GET')).toEqual(['post', 'GET']);
  });

  it('throws for a request the recording never saw', async () => {
    const recorded = recordedHostFetch([]);
    await expect(recorded.fetch({ source: 's', request: { url: 'https://a.example/y' } })).rejects.toThrow('recorded_fetch_unmatched: GET https://a.example/y');
  });

  it('matches on the body when the exchange declares a body predicate', async () => {
    const recorded = recordedHostFetch([
      { url: 'https://a.example/graphql', body: (b) => String(b).includes('Viewer'), response: jsonResponse(200, { who: 'viewer' }) },
      { url: 'https://a.example/graphql', response: jsonResponse(200, { who: 'other' }) },
    ]);
    const viewer = await recorded.fetch({ source: 's', request: { url: 'https://a.example/graphql', method: 'POST', body: 'query Viewer {}' } });
    expect(JSON.parse(viewer.body)).toEqual({ who: 'viewer' });
  });
});

describe('providerSyncErrorOf', () => {
  it('reads each kind from a thrown object, an Error with kind, or JSON-RPC data', () => {
    expect(providerSyncErrorOf({ kind: 'cursor-expired', message: 'old' })).toEqual({ kind: 'cursor-expired', message: 'old' });
    expect(providerSyncErrorOf(Object.assign(new Error('nope'), { kind: 'auth' }))).toEqual({ kind: 'auth', message: 'nope' });
    expect(providerSyncErrorOf({ code: -32000, message: 'rpc', data: { kind: 'transient', message: 'down' } })).toEqual({ kind: 'transient', message: 'down' });
    expect(providerSyncErrorOf({ kind: 'rate-limited', retryAfterSeconds: '12', message: 'slow' })).toEqual({ kind: 'rate-limited', retryAfterSeconds: 12, message: 'slow' });
    expect(providerSyncErrorOf({ kind: 'rate-limited', retryAfterSeconds: -1, message: 'slow' })).toEqual({ kind: 'rate-limited', message: 'slow' });
  });

  it('returns null for anything it does not recognise', () => {
    expect(providerSyncErrorOf(new Error('boom'))).toBeNull();
    expect(providerSyncErrorOf({ kind: 'teapot', message: 'x' })).toBeNull();
    expect(providerSyncErrorOf(null)).toBeNull();
    expect(providerSyncErrorOf(CONFORMANCE_UNREADABLE_CURSOR)).toBeNull();
  });
});

describe('social result shapes', () => {
  it('accepts a write result with an externalId and an https url', () => {
    expect(providerSocialWriteResultIssue({ externalId: '1', url: 'https://x.example/1' })).toBeNull();
    expect(providerSocialWriteResultIssue({ externalId: '1' })).toBeNull();
  });

  it('names what is wrong with a malformed write result', () => {
    expect(providerSocialWriteResultIssue({ id: '1' })).toBe('externalId must be a non-empty string');
    expect(providerSocialWriteResultIssue({ externalId: '1', url: 'ftp://x' })).toBe('url, when present, must be an https URL');
    expect(providerSocialWriteResultIssue([])).toBe('result must be an object');
  });

  it('requires a boolean deleted on a delete result', () => {
    expect(providerSocialDeleteResultIssue({ deleted: false, detail: 'gone already' })).toBeNull();
    expect(providerSocialDeleteResultIssue({ deleted: 'yes' })).toBe('deleted must be a boolean');
    expect(providerSocialDeleteResultIssue({ deleted: true, detail: 3 })).toBe('detail, when present, must be a string');
  });
});
