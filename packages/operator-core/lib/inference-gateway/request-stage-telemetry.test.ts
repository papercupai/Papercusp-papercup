import { describe, expect, it } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import http from 'node:http';

describe('provider queue-wait retention', () => {
  it('keeps sparse-lane waits after another provider fills the shared timeline ring', () => {
    let now = 0;
    const collector = new GatewayRequestTelemetry({ recentCapacity: 2, now: () => now });
    const complete = (provider: 'claude' | 'codex', wait: number) => {
      const span = collector.begin({ provider, protocol: provider === 'claude' ? 'anthropic-messages' : 'openai-responses' });
      span.routeSelected();
      now += wait;
      span.admitted();
      span.finish('ok', 200);
    };
    complete('claude', 10);
    complete('claude', 20);
    for (let i = 0; i < 5; i++) complete('codex', 100 + i);
    const snapshot = collector.snapshot();
    expect(snapshot.recent.every(row => row.provider === 'codex')).toBe(true);
    expect(snapshot.providerQueueWait.claude).toMatchObject({ count: 2, retained: 2, p50: 10 });
    expect(snapshot.providerQueueWait.codex).toMatchObject({ count: 5, retained: 2, p50: 103 });
    expect(snapshot.providerQueueWait.local).toMatchObject({ count: 0, retained: 0, p50: null });
    snapshot.providerQueueWait.claude.p50 = -1;
    expect(collector.snapshot().providerQueueWait.claude.p50).toBe(10);
  });
});

describe('provider identity observations', () => {
  it('delivers exact owner/request/model/effort/account evidence to the maintained startup sink', () => {
    const records: unknown[] = [];
    const collector = new GatewayRequestTelemetry({ onStartupEvidence: (_line, record) => records.push(record) });
    const span = collector.begin({ provider: 'codex', protocol: 'openai-responses', ownerId: 's-primary' });
    span.setModel('gpt-5.4');
    span.setCacheShape(Buffer.from('{"reasoning":{"effort":"high"}}'));
    span.setServingAccount('pool-a');
    span.finish('ok', 200);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ownerId: 's-primary', requestId: span.requestId,
      model: 'gpt-5.4', effort: 'high', authorizationScope: 'pool-a', finalStatus: 200 });
  });
  it('keeps request controls separate from the provider model and clones returned evidence', () => {
    const collector = new GatewayRequestTelemetry();
    const span = collector.begin({ provider: 'codex', protocol: 'openai-responses', ownerId: 'su-observed' });
    span.setModel('requested-model');
    span.setCacheShape(Buffer.from(JSON.stringify({ reasoning: { effort: 'high' }, tools: [], instructions: 'PRIVATE_PROMPT' })));
    span.recordAttempt();
    span.recordProviderIdentity('resp-exact', 'served-model', null, 'account-exact');
    span.finish('ok', 200);
    const row = collector.snapshot().recent[0];
    expect(row).toMatchObject({ model: 'requested-model', forwardedEffort: 'high',
      providerIdentity: { responseId: 'resp-exact', model: 'served-model', effort: null, accountId: 'account-exact' } });
    row.providerIdentity!.model = 'tampered';
    expect(collector.snapshotForOwner('su-observed').recent[0].providerIdentity?.model).toBe('served-model');
    expect(JSON.stringify(collector.snapshot())).not.toContain('PRIVATE_PROMPT');
  });
  it('discards earlier response evidence on retry, invalid response, and invalid request shape', () => {
    const collector = new GatewayRequestTelemetry();
    const span = collector.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setCacheShape(Buffer.from('{"reasoning":{"effort":"high"}}'));
    span.recordProviderIdentity('resp-old', 'served-old', 'high', 'account-old');
    span.recordAttempt();
    span.recordProviderIdentity('resp-new', 'served-new', 'high', 'account-new');
    span.recordProviderIdentity('response with whitespace', 'served-new', null, 'account-new');
    span.setCacheShape(Buffer.from('invalid'));
    expect(span.finish('ok', 200)).toMatchObject({ forwardedEffort: null, providerIdentity: null });
  });
});

describe('owner execution leases', () => {
  it('counts queued/pre-provider requests independently of completed history', () => {
    let now = 100;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const first = telemetry.begin({ ownerId: 'su-a', provider: 'claude', protocol: 'anthropic-messages' });
    now = 200;
    const second = telemetry.begin({ ownerId: 'su-a', provider: 'claude', protocol: 'anthropic-messages' });
    const other = telemetry.begin({ ownerId: 'su-b', provider: 'claude', protocol: 'anthropic-messages' });
    expect(telemetry.snapshotForOwner('su-a')).toMatchObject({ active: 2, oldestActiveAt: 100, finalized: 0 });
    first.finish('gateway-error', 503);
    expect(telemetry.snapshotForOwner('su-a')).toMatchObject({ active: 1, oldestActiveAt: 200 });
    second.finish('ok', 200);
    second.finish('ok', 200);
    expect(telemetry.snapshotForOwner('su-a')).toMatchObject({ active: 0, oldestActiveAt: null, finalized: 2 });
    expect(telemetry.snapshotForOwner('su-b').active).toBe(1);
    other.finish('cancelled', null);
    expect(telemetry.snapshotForOwner('su-b').active).toBe(0);
  });
});
import {
  GatewayRequestTelemetry,
  MAX_CACHE_FINGERPRINT_BYTES,
  assertCompleteGatewayRequestTimeline,
  classifyGatewayTelemetryOutcome,
  assessStartupCacheSharing,
  assessStartupPrefixCohorts,
  parseStartupCacheEvidenceLine,
  parseStartupPrefixRowLine,
  splitAtSystemReminders,
  type StartupCacheEvidence,
  type StartupPrefixRow,
} from './request-stage-telemetry';

describe('bounded upstream HTTP write observations', () => {
  const target = 'http://127.0.0.1:12345/private-path?secret=PRIVATE_QUERY';
  const request = () => ({ origin: 'http://127.0.0.1:12345', path: '/private-path?secret=PRIVATE_QUERY', method: 'POST' });
  const emit = (phase: 'create' | 'bodySent' | 'error' | 'sendHeaders', outgoing: object) =>
    channel(`undici:${phase === 'sendHeaders' ? 'client' : 'request'}:${phase}`).publish({ request: outgoing,
      headers: 'PRIVATE_HEADER', error: new Error('PRIVATE_ERROR') });
  const fixture = () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'su-writes', provider: 'codex', protocol: 'openai-responses', transport: 'bearer-http' });
    return { telemetry, span };
  };

  it('observes real global-fetch socket writes without storing the target, request body or credentials', async () => {
    const { telemetry, span } = fixture();
    let received = '';
    const server = http.createServer(async (req, res) => {
      for await (const chunk of req) received += String(chunk);
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/PRIVATE_PATH`;
    try {
      const response = await span.observeUpstreamFetch(url, 'POST', 'prepared-account', () => fetch(url,
        { method: 'POST', body: 'PRIVATE_BODY', headers: { authorization: 'PRIVATE_AUTH' } }));
      expect(await response.text()).toBe('ok');
      expect(received).toBe('PRIVATE_BODY');
      span.finish('ok', 200);
      const snapshot = telemetry.snapshot(), call = snapshot.recent[0].upstreamWrites.calls[0];
      expect(call).toMatchObject({ accountId: 'prepared-account', clock: 'performance.now', outcome: 'returned',
        responseStatus: 200, matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
      expect(call.events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
      expect(call.events.map(event => event.requestOrdinal)).toEqual([1, 1, 1]);
      expect(call.clockId).toMatch(/^process-monotonic:/);
      for (let i = 1; i < call.events.length; i++) expect(call.events[i].atMs).toBeGreaterThanOrEqual(call.events[i - 1].atMs);
      expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|127\.0\.0\.1/);
      call.events[0].atMs = -1;
      const owner = telemetry.snapshotForOwner('su-writes');
      expect(owner.recent[0].upstreamWrites.calls[0].events[0].atMs).toBeGreaterThan(0);
      owner.recent[0].upstreamWrites.calls[0].accountId = 'tampered';
      expect(telemetry.snapshot().recent[0].upstreamWrites.calls[0].accountId).toBe('prepared-account');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps unsupported fetches unobserved and preserves errors and listener cleanup', async () => {
    const before = channel('undici:request:create').hasSubscribers;
    const { telemetry, span } = fixture(), sentinel = new Error('PRIVATE_FAILURE');
    expect(await span.observeUpstreamFetch(target, 'POST', 'account', async () => 7)).toBe(7);
    await expect(span.observeUpstreamFetch(target, 'POST', 'account', async () => { throw sentinel; })).rejects.toBe(sentinel);
    expect(channel('undici:request:create').hasSubscribers).toBe(before);
    span.finish('upstream-error', 502);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.outcome)).toEqual(['returned', 'threw']);
    expect(calls.every(call => call.matchedRequests === 0 && call.events.length === 0)).toBe(true);
  });

  it('joins pooled-socket events by request object across overlapping foreign async contexts', async () => {
    const { telemetry, span } = fixture();
    const a = request(), b = request();
    await span.observeUpstreamFetch(target, 'POST', 'account-a', async () => {
      emit('create', a);
      await span.observeUpstreamFetch(target, 'POST', 'account-b', async () => {
        emit('create', b); emit('sendHeaders', a); emit('sendHeaders', b); emit('bodySent', a); emit('error', b);
      });
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.accountId)).toEqual(['account-a', 'account-b']);
    expect(calls[0].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
    expect(calls[1].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'error']);
    expect(JSON.stringify(calls)).not.toMatch(/PRIVATE_/);
  });

  it('retains pre-send failures and repeated transport writes without collapsing attempts', async () => {
    const { telemetry, span } = fixture();
    await span.observeUpstreamFetch(target, 'POST', 'failed-account', async () => {
      const outgoing = request(); emit('create', outgoing); emit('error', outgoing);
    });
    await span.observeUpstreamFetch(target, 'POST', 'next-account', async () => {
      const outgoing = request(); emit('create', outgoing); emit('sendHeaders', outgoing); emit('error', outgoing);
      emit('sendHeaders', outgoing); emit('bodySent', outgoing);
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls.map(call => call.ordinal)).toEqual([1, 2]);
    expect(calls[0].events.map(event => event.phase)).toEqual(['created', 'error']);
    expect(calls[1].events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'error', 'headers-write-start', 'body-write-complete']);
  });

  it('exposes unexpected targets and ignores late events after the fetch has settled', async () => {
    const { telemetry, span } = fixture(), outgoing = request();
    await span.observeUpstreamFetch(target, 'POST', 'account-a', async () => {
      emit('create', outgoing); emit('create', { ...request(), path: '/unexpected' });
    });
    await span.observeUpstreamFetch(target, 'POST', 'account-b', async () => {
      emit('bodySent', outgoing); // old request must not attach to B or mutate A
    });
    span.finish('ok', 200);
    const calls = telemetry.snapshot().recent[0].upstreamWrites.calls;
    expect(calls[0]).toMatchObject({ matchedRequests: 1, unexpectedRequests: 1 });
    expect(calls[0].events.map(event => event.phase)).toEqual(['created']);
    expect(calls[1].events).toEqual([]);
  });

  it('bounds requests, events and calls with explicit overflow, without suppressing fetches', async () => {
    const { telemetry, span } = fixture(); let invoked = 0;
    for (let i = 0; i < 34; i++) await span.observeUpstreamFetch(target, 'POST', 'account', async () => {
      invoked++;
      for (let j = 0; j < 10; j++) {
        const outgoing = request(); emit('create', outgoing);
        for (let k = 0; k < 6; k++) emit('sendHeaders', outgoing);
      }
    });
    span.finish('ok', 200);
    const writes = telemetry.snapshot().recent[0].upstreamWrites;
    expect(invoked).toBe(34); expect(writes.droppedCalls).toBe(2); expect(writes.calls).toHaveLength(32);
    expect(writes.calls[0]).toMatchObject({ matchedRequests: 10, droppedRequests: 2, droppedEvents: 24 });
    expect(writes.calls.every(call => call.events.length === 32)).toBe(true);
  });

  it('does not manufacture a matching account by truncation or track after span finalization', async () => {
    const { telemetry, span } = fixture();
    await span.observeUpstreamFetch(target, 'POST', 'x'.repeat(121), async () => undefined);
    span.finish('ok', 200);
    let ran = false;
    await span.observeUpstreamFetch(target, 'POST', 'later-account', async () => { ran = true; });
    expect(ran).toBe(true);
    const writes = telemetry.snapshot().recent[0].upstreamWrites;
    expect(writes.calls).toHaveLength(1); expect(writes.calls[0].accountId).toBeNull();
  });

  it('does not attribute an unobserved nested fetch to its parent observation', async () => {
    const { telemetry, span } = fixture();
    const ended = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    ended.finish('ok', 200);
    await span.observeUpstreamFetch(target, 'POST', 'parent', async () => {
      emit('create', request());
      await ended.observeUpstreamFetch(target, 'POST', 'unobserved', async () => {
        const child = request(); emit('create', child); emit('bodySent', child);
      });
    });
    span.finish('ok', 200);
    const writes = telemetry.snapshotForOwner('su-writes').recent[0].upstreamWrites;
    expect(writes.calls[0].matchedRequests).toBe(1);
    expect(writes.calls[0].events.map(event => event.phase)).toEqual(['created']);
  });
});

describe('ten-agent startup sharing evidence (R-10)', () => {
  const fingerprint = { sha256: 'a'.repeat(64), bytes: 1000, hashedBytes: 1000 };
  const cohort = (): StartupCacheEvidence[] => Array.from({ length: 10 }, (_, index) => ({
    authorizationScope: 'tenant-a/provider-project-a', model: 'test-model', transport: 'bearer-http',
    tools: { ...fingerprint }, instructions: { ...fingerprint }, startedAt: index * 100,
    availableAt: index * 100 + 50, expiresAt: 300000, cacheReadTokens: null, cacheWriteTokens: null,
  }));
  it('finds nine sequential component matches but never promises one write and nine hits', () => {
    expect(assessStartupCacheSharing(cohort())).toEqual({ requests: 10, comparable: 10, unknown: 0,
      componentGroups: 1, withEarlierEligibleComponentMatch: 9, coldOrConcurrent: 1, timingUnknown: 0,
      observedReadRequests: 0, observedWriteRequests: 0, readCoverage: 0, writeCoverage: 0,
      singleWriteGuaranteed: false });
  });
  it('allows all ten simultaneous cold starts to require writes before any cache is eligible', () => {
    const concurrent = cohort().map(row => ({ ...row, startedAt: 0, availableAt: 50,
      cacheReadTokens: 0, cacheWriteTokens: 1000 }));
    expect(assessStartupCacheSharing(concurrent)).toMatchObject({ coldOrConcurrent: 10,
      withEarlierEligibleComponentMatch: 0, observedWriteRequests: 10, singleWriteGuaranteed: false });
  });
  it('never groups across authorization scope, model or transport boundaries', () => {
    for (const dimension of ['authorizationScope', 'model', 'transport'] as const) {
      const rows = cohort().map((row, index) => ({ ...row,
        [dimension]: dimension === 'transport' ? (index < 5 ? 'bearer-http' : 'oauth-http') : `${dimension}-${index}`,
      })) as StartupCacheEvidence[];
      expect(assessStartupCacheSharing(rows).componentGroups).toBe(dimension === 'transport' ? 2 : 10);
    }
  });
  it('treats absent authorization and partial fingerprints as unknown, not identical', () => {
    const rows = cohort().map((row, index) => index < 5 ? { ...row, authorizationScope: null }
      : { ...row, instructions: { ...fingerprint, bytes: 100000, hashedBytes: 65536 } });
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 0, unknown: 10,
      withEarlierEligibleComponentMatch: 0 });
  });
  it('honors expiry and leaves unobservable subscription timing unknown', () => {
    expect(assessStartupCacheSharing(cohort().map(row => ({ ...row, expiresAt: row.availableAt! + 10 }))))
      .toMatchObject({ withEarlierEligibleComponentMatch: 0, coldOrConcurrent: 10 });
    expect(assessStartupCacheSharing(cohort().map(row => ({ ...row, availableAt: null, expiresAt: null }))))
      .toMatchObject({ withEarlierEligibleComponentMatch: 0, timingUnknown: 9 });
  });
  it('detects changed tool order/schema and instruction content without retaining raw content', () => {
    const telemetry = new GatewayRequestTelemetry();
    const shapes = [
      { tools: [{ name: 'a' }, { name: 'b' }], instructions: 'base' },
      { tools: [{ name: 'b' }, { name: 'a' }], instructions: 'base' },
      { tools: [{ name: 'a', description: 'changed' }, { name: 'b' }], instructions: 'base' },
      { tools: [{ name: 'a' }, { name: 'b' }], instructions: 'base with volatile text before stable boundary' },
    ];
    const rows = shapes.map((body, index) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify(body)));
      const cache = span.finish('ok', 200)!.cache;
      return { ...cohort()[index], tools: cache.tools, instructions: cache.instructions };
    });
    expect(assessStartupCacheSharing(rows).componentGroups).toBe(4);
    expect(JSON.stringify(assessStartupCacheSharing(rows))).not.toContain('volatile');
  });
});

describe('R-10 startup PREFIX cohorts from the journal layout (D-077)', () => {
  const hash = (seed: string) => ({ sha16: seed.padEnd(16, '0').slice(0, 16), bytes: 100 });
  const startup = (index: number, over: Partial<StartupPrefixRow> = {}, messages = 2, toolsCount = 88): StartupPrefixRow => ({
    ownerId: `su-owner-${index}`, requestId: index, authorizationScope: 'acct-a', model: 'claude-test', transport: 'bearer-http',
    tools: { sha256: 'b'.repeat(64), bytes: 433464, hashedBytes: 433464 },
    layout: {
      tools: { count: toolsCount, deferred: 74 },
      // blocks 0..2 are the stable, breakpointed prefix; block 3 is per-owner (after the last breakpoint)
      system: { form: 'blocks', blockCount: 4, blocks: [hash('aa'), hash('bb'), hash('cc'), hash(`own${index}`)] },
      messages: { count: messages, first: { role: 'user', blockCount: 1, hash: hash(`m${index}`), blocks: [hash(`m${index}`)] } },
      markers: [{ section: 'system', index: 1, block: null, ttl: '1h' }, { section: 'system', index: 2, block: null, ttl: '1h' },
        { section: 'messages', index: messages - 1, block: 0, ttl: '1h' }],
      truncated: false,
    },
    startedAt: index * 1000, inputTokens: 2, cacheReadTokens: index === 0 ? 0 : 71027, cacheWriteTokens: index === 0 ? 133000 : 62667,
    outcome: 'ok', ...over,
  });
  const cohort = (n = 10) => Array.from({ length: n }, (_, i) => startup(i));

  it('sizes ten same-form startups as ONE cohort even though every owner has a different last system block and first message', () => {
    const result = assessStartupPrefixCohorts(cohort());
    expect(result).toMatchObject({ startups: 10, unkeyed: 0, cohortCount: 1, largestCohortOwners: 10,
      verdict: 'cohort-present', sharingVerified: false });
    expect(result.cohorts[0].laterStarterReadFraction).toBeCloseTo(71027 / (2 + 71027 + 62667), 5);
    // The retired key (whole-instructions hash) would split these: the per-owner block makes each unique.
    expect(new Set(cohort().map((row) => row.layout!.system.blocks[3].sha16)).size).toBe(10);
  });

  it('counts only true startups: mid-conversation rows and tool-less preflights are excluded, not folded in', () => {
    const rows = [...cohort(9), startup(9, {}, 40), startup(10, {}, 2, 0), startup(11, { outcome: 'cancelled' })];
    expect(assessStartupPrefixCohorts(rows)).toMatchObject({ startups: 9, largestCohortOwners: 9, verdict: 'cohort-too-small' });
  });

  it('splits cohorts on model, scope, tools hash and any stable system block', () => {
    const split = (change: (row: StartupPrefixRow) => StartupPrefixRow) =>
      assessStartupPrefixCohorts(cohort().map((row, i) => (i < 5 ? row : change(row)))).cohortCount;
    expect(split((row) => ({ ...row, model: 'other' }))).toBe(2);
    expect(split((row) => ({ ...row, authorizationScope: 'acct-b' }))).toBe(2);
    expect(split((row) => ({ ...row, tools: { ...row.tools!, sha256: 'c'.repeat(64) } }))).toBe(2);
    expect(split((row) => ({ ...row, layout: { ...row.layout!, system: { ...row.layout!.system,
      blocks: [hash('zz'), ...row.layout!.system.blocks.slice(1)] } } }))).toBe(2);
  });

  it('reports rows it cannot key as unkeyed (no system breakpoint, truncated tools hash) and ignores layout-less rows', () => {
    const noMarker = startup(20, { layout: { ...startup(20).layout!, markers: [] } });
    const partialTools = startup(21, { tools: { sha256: 'b'.repeat(64), bytes: 433464, hashedBytes: 65536 } });
    const legacy = startup(22, { layout: null });
    expect(assessStartupPrefixCohorts([noMarker, partialTools, legacy])).toMatchObject({
      rows: 3, startups: 2, unkeyed: 2, cohortCount: 0, largestCohortOwners: 0, verdict: 'cohort-too-small' });
  });

  it('parses a journal line into a cohort row and rejects an ownerless or foreign line', () => {
    const base = startup(1);
    const line = `startup-cache-evidence/v1 ${JSON.stringify({ schema: 'startup-cache-evidence/v1', requestId: 1,
      ownerId: base.ownerId, transport: 'bearer-http', model: base.model, authorizationScope: base.authorizationScope,
      tools: base.tools, instructions: null, layout: base.layout, startedAt: 5, inputTokens: 2, cacheReadTokens: 7,
      cacheWriteTokens: 9, outcome: 'ok' })}`;
    expect(parseStartupPrefixRowLine(line)).toMatchObject({ ownerId: 'su-owner-1', requestId: 1, startedAt: 5, cacheReadTokens: 7, outcome: 'ok' });
    expect(parseStartupPrefixRowLine(line.replace('"requestId":1,', ''))!.requestId).toBeNull();
    expect(parseStartupPrefixRowLine(line)!.layout!.system.blocks).toHaveLength(4);
    expect(parseStartupPrefixRowLine(line.replace('"layout":', '"layout":{"junk":1},"x":'))!.layout).toBeNull();
    expect(parseStartupPrefixRowLine(line.replace(`"ownerId":"${base.ownerId}"`, '"ownerId":""'))).toBeNull();
    expect(parseStartupPrefixRowLine('unrelated journal line')).toBeNull();
  });
});

function completeCloudSpan(telemetry: GatewayRequestTelemetry, advance: (ms: number) => void, owner = 'su-test') {
  const span = telemetry.begin({
    ownerId: owner,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
  });
  advance(1);
  span.routeSelected();
  advance(2);
  span.admitted();
  span.beginStage('bodyRead');
  advance(3);
  span.endStage('bodyRead');
  span.beginStage('auth');
  advance(4);
  span.endStage('auth');
  span.setModel('claude-opus-4');
  span.setCacheRouting('rewritten');
  span.recordAttempt();
  span.beginStage('upstreamTtfb');
  advance(5);
  span.endStage('upstreamTtfb');
  span.setStreaming(true);
  span.beginStage('stream');
  advance(6);
  span.endStage('stream');
  return span.finish('ok', 200)!;
}

describe('GatewayRequestTelemetry', () => {
  const nativeIds = { session_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc',
    thread_id: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc', turn_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d30',
    window_id: '01a0cf6d-a2ba-7b43-b095-f73f45732d31:0' };
  const nativeBody = (meta: unknown = nativeIds) => ({
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify(meta) },
  });

  it('retains only exact native ids, independently of serving account, and isolates returned snapshots', () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
    const body = nativeBody({ ...nativeIds, ownerId: 'forged-owner', servingAccountId: 'forged-account',
      prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_TOKEN', nested: { password: 'PRIVATE_PASSWORD' } });
    span.setNativeCorrelation(body);
    body.client_metadata['x-codex-turn-metadata'] = 'changed';
    span.setServingAccount('actual-account');
    span.finish('ok', 200);
    const before = telemetry.snapshot();
    expect(before.recent[0]).toMatchObject({ ownerId: 'su-native', cache: { servingAccountId: 'actual-account' },
      nativeCorrelation: { status: 'observed', sessionId: nativeIds.session_id, threadId: nativeIds.thread_id,
        turnId: nativeIds.turn_id, windowId: nativeIds.window_id } });
    expect(JSON.stringify(before)).not.toMatch(/PRIVATE_|forged-/);
    before.recent[0].nativeCorrelation.threadId = 'changed';
    const owner = telemetry.snapshotForOwner('su-native');
    expect(owner.recent[0].nativeCorrelation.threadId).toBe(nativeIds.thread_id);
    owner.recent[0].nativeCorrelation.turnId = 'changed';
    expect(telemetry.snapshot().recent[0].nativeCorrelation.turnId).toBe(nativeIds.turn_id);
    span.setNativeCorrelation(nativeBody({ ...nativeIds, turn_id: nativeIds.window_id }));
    expect(telemetry.snapshot().recent[0].nativeCorrelation.turnId).toBe(nativeIds.turn_id);
  });

  it.each([
    ['no-client', {}, 'missing'], ['no-meta', { client_metadata: {} }, 'missing'],
    ['null-body', null, 'invalid'], ['array-body', [], 'invalid'],
    ['null-client', { client_metadata: null }, 'invalid'],
    ['object-meta', { client_metadata: { 'x-codex-turn-metadata': nativeIds } }, 'invalid'],
    ['bad-json', { client_metadata: { 'x-codex-turn-metadata': '{' } }, 'invalid'],
    ['array-meta', nativeBody([]), 'invalid'],
    ['missing-turn', nativeBody({ thread_id: nativeIds.thread_id }), 'invalid'],
    ['overlong-id', nativeBody({ ...nativeIds, turn_id: nativeIds.turn_id + 'x' }), 'invalid'],
    ['whitespace-id', nativeBody({ ...nativeIds, turn_id: ' ' + nativeIds.turn_id }), 'invalid'],
    ['invalid-optional', nativeBody({ ...nativeIds, session_id: null }), 'invalid'],
    ['invalid-window', nativeBody({ ...nativeIds, window_id: nativeIds.window_id + ':extra' }), 'invalid'],
    ['oversized-meta', nativeBody({ ...nativeIds, extra: 'x'.repeat(4096) }), 'oversized'],
    ['multibyte-meta', nativeBody({ ...nativeIds, extra: '界'.repeat(1400) }), 'oversized'],
  ])('keeps %s metadata explicitly unknown without stale identifiers', (_name, body, status) => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setNativeCorrelation(nativeBody());
    span.setNativeCorrelation(body);
    expect(span.finish('client-error', 400)?.nativeCorrelation).toEqual({ status,
      sessionId: null, threadId: null, turnId: null, windowId: null });
  });

  it('does not infer native identity from owner or equate a native turn with one request', () => {
    const telemetry = new GatewayRequestTelemetry();
    const absent = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
    expect(absent.finish('shed', 503)?.nativeCorrelation.status).toBe('unobserved');
    for (const outcome of ['ok', 'upstream-error'] as const) {
      const span = telemetry.begin({ ownerId: 'su-native', provider: 'codex', protocol: 'openai-responses' });
      span.setNativeCorrelation(nativeBody({ thread_id: nativeIds.thread_id, turn_id: nativeIds.turn_id }));
      span.recordAttempt(); span.recordAttempt(); span.recordFailover();
      span.finish(outcome, outcome === 'ok' ? 200 : 500);
    }
    const rows = telemetry.snapshotForOwner('su-native').recent.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].requestId).not.toBe(rows[1].requestId);
    expect(rows[0].nativeCorrelation).toEqual(rows[1].nativeCorrelation);
    expect(rows.every(row => row.cache.servingAccountId === null && row.attempts === 2 && row.failovers === 1)).toBe(true);
  });

  it('reports observed account/cache usage with explicit unknown miss cause and bounded coverage', () => {
    const telemetry = new GatewayRequestTelemetry();
    expect(telemetry.snapshot().requests.cacheUsageCoverage).toBeNull();
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    span.setServingAccount('actually-served');
    span.recordFailover();
    span.recordCacheUsage(10, 0, 20, 'msg-native');
    span.finish('ok', 200);
    telemetry.begin({ provider: 'codex', protocol: 'openai-responses' }).finish('shed', 503);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({ finalized: 2, cacheUsageObserved: 1, cacheUsageCoverage: 0.5 });
    expect(snapshot.recent[0].cache).toMatchObject({ servingAccountId: 'actually-served', providerRequestId: 'msg-native',
      inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 0, reuse: 'zero-read', missReason: 'unknown' });
    expect(snapshot.recent[1].cache.reuse).toBe('unobserved');
    expect(snapshot.recent[1].cache.servingAccountId).toBeNull();
  });

  it('fingerprints tools and instructions without retaining their content or the dynamic conversation', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = (message: string) => Buffer.from(JSON.stringify({ tools: [{ name: 'private-tool', description: 'not-for-logs' }],
      instructions: 'secret-instructions', input: message }));
    const first = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    first.setCacheShape(body('first dynamic message'));
    first.recordCacheUsage(20, 80, 0);
    first.finish('ok', 200);
    const second = telemetry.begin({ ownerId: 'su-test', provider: 'codex', protocol: 'openai-responses' });
    second.setCacheShape(body('different dynamic message'));
    second.recordCacheUsage(0, 100, 0);
    second.finish('ok', 200);
    const snapshot = telemetry.snapshot();
    expect(snapshot.recent[0].cache.tools).toEqual(snapshot.recent[1].cache.tools);
    expect(snapshot.recent[0].cache.instructions).toEqual(snapshot.recent[1].cache.instructions);
    expect(snapshot.recent[0].cache.reuse).toBe('partial-hit');
    expect(snapshot.recent[1].cache.reuse).toBe('full-hit');
    expect(snapshot.recent[1].previousObservedRequestGapMs).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/private-tool|not-for-logs|secret-instructions|dynamic message/);
    snapshot.recent[0].cache.tools!.sha256 = 'corrupted-caller-copy';
    expect(telemetry.snapshotForOwner('su-test').recent[0].cache.tools!.sha256).not.toBe('corrupted-caller-copy');
  });

  it('fingerprints the native Codex developer prefix while excluding dynamic turns', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = (toolDescription: string, instruction: string, userText: string) => Buffer.from(JSON.stringify({
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ name: 'synthetic', description: toolDescription }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: instruction }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'late dynamic guidance' }] },
      ],
    }));
    const capture = (tools: string, instructions: string, user: string) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(body(tools, instructions, user));
      return span.finish('ok', 200)!.cache;
    };
    const first = capture('stable tool', 'stable instructions', 'first user turn');
    const second = capture('stable tool', 'stable instructions', 'different user turn');
    const changedTools = capture('changed tool', 'stable instructions', 'first user turn');
    const changedInstructions = capture('stable tool', 'changed instructions', 'first user turn');
    expect(first.tools).toEqual(second.tools);
    expect(first.instructions).toEqual(second.instructions);
    expect(first.tools).not.toEqual(changedTools.tools);
    expect(first.instructions).not.toEqual(changedInstructions.instructions);
    expect(JSON.stringify(telemetry.snapshot())).not.toMatch(/stable instructions|first user turn|stable tool/);
  });

  it('binds a native instruction template while retaining exact transport and resource-path hashes', () => {
    const capture = (id: string, root: string, advice = 'Use the maintained instructions.') => {
      const span = new GatewayRequestTelemetry().begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify({ input: [{ type: 'message', role: 'developer', id,
        content: [{ type: 'input_text', text: `${advice}\n<skills_instructions>\n- \`r0\` = \`${root}\`\nRead \`${root}/imagegen/SKILL.md\`.\n</skills_instructions>` }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A public task.' }] }] })));
      return span.finish('gateway-error', 400)!.cache;
    };
    const first = capture('msg_first', '/private/home-1/skills/.system');
    const second = capture('msg_second', '/private/home-2/skills/.system');
    expect(first.instructions).not.toEqual(second.instructions);
    expect(first.nativeInstructionTemplate?.fingerprint).toEqual(second.nativeInstructionTemplate?.fingerprint);
    expect(first.nativeInstructionTemplate?.fingerprint?.bytes).toBeGreaterThan(0);
    expect(first.nativeInstructionTemplate?.skillsRootHash).not.toBe(second.nativeInstructionTemplate?.skillsRootHash);
    expect(capture('msg_third', '/private/home-2/skills/.system', 'Changed authority.').nativeInstructionTemplate?.fingerprint)
      .not.toEqual(first.nativeInstructionTemplate?.fingerprint);
    expect(JSON.stringify(first)).not.toMatch(/private\/home|maintained instructions|msg_first/);
  });

  it('leaves ambiguous or malformed native skill-root templates unmeasured', () => {
    for (const text of ['<skills_instructions>missing root</skills_instructions>',
      '<skills_instructions>\n- `r0` = `relative/skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a/skills/.system`\n- `r0` = `/b/skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a/../b/skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a/./skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a\\b/skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a\u0000b/skills/.system`\n</skills_instructions>',
      '<skills_instructions>\n- `r0` = `/a/skills/.system`\n</skills_instructions>\n<skills_instructions>\n- `r0` = `/b/skills/.system`\n</skills_instructions>']) {
      const span = new GatewayRequestTelemetry().begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify({ input: [{ type: 'message', role: 'developer',
        content: [{ type: 'input_text', text }] }] })));
      expect(span.finish('gateway-error', 400)!.cache.nativeInstructionTemplate).toBeNull();
    }
  });

  it('includes both top-level and developer-prefix components when a request carries both', () => {
    const telemetry = new GatewayRequestTelemetry();
    const fingerprint = (prefixTool: string, prefixInstruction: string) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify({ tools: [], instructions: 'top-level instruction', input: [
        { type: 'additional_tools', role: 'developer', tools: [{ name: prefixTool }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: prefixInstruction }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'dynamic user' }] },
      ] })));
      return span.finish('ok', 200)!.cache;
    };
    const first = fingerprint('first', 'same');
    expect(first.tools).not.toEqual(fingerprint('second', 'same').tools);
    expect(first.instructions).not.toEqual(fingerprint('first', 'different').instructions);
  });

  it('journals ONE bounded startup-evidence line per owner start, and the reader feeds the assessor', () => {
    const lines: string[] = [];
    const telemetry = new GatewayRequestTelemetry({ onStartupEvidence: (line) => lines.push(line) });
    const run = (ownerId: string | null, secretUser: string) => {
      const span = telemetry.begin({ ownerId, provider: 'codex', protocol: 'openai-responses', transport: 'oauth-http' });
      span.setCacheShape(Buffer.from(JSON.stringify({ model: 'gpt-x', tools: [{ name: 'private-tool' }],
        instructions: 'secret-instructions', input: secretUser })));
      span.recordCacheUsage(10, 90, 0);
      span.finish('ok', 200);
    };
    for (let i = 0; i < 3; i++) run(`su-owner-${i}`, `not-for-logs-${i}`);
    run('su-owner-0', 'second request of an owner already seen');
    run(null, 'ownerless request');
    // Only each owner's FIRST observed request is durable; repeats and ownerless rows are not.
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/private-tool|secret-instructions|not-for-logs|second request|ownerless/);
    for (const line of lines) expect(line.length).toBeLessThan(2048);
    const evidence = lines.map((line) => parseStartupCacheEvidenceLine(line));
    expect(evidence.every((row) => row !== null)).toBe(true);
    // No eligibility source exists in the line, so the assessor must say timing is unknown, never infer a window.
    const assessed = assessStartupCacheSharing(evidence as StartupCacheEvidence[]);
    expect(assessed).toMatchObject({ requests: 3, singleWriteGuaranteed: false, withEarlierEligibleComponentMatch: 0 });
    expect(evidence[0]).toMatchObject({ availableAt: null, expiresAt: null });
    // Garbage and foreign lines are rejected, not coerced.
    for (const bad of ['', 'startup-cache-evidence/v1 {not json', 'startup-cache-evidence/v1 {"schema":"other"}',
      'unrelated journal line']) expect(parseStartupCacheEvidenceLine(bad)).toBeNull();
  });

  it('journals a content-free per-section LAYOUT so a startup cohort can show which span is shared (D-077)', () => {
    const lines: string[] = [];
    const telemetry = new GatewayRequestTelemetry({ onStartupEvidence: (line) => lines.push(line) });
    const system = (marker: boolean) => [
      { type: 'text', text: 'claude-code-base-prefix-secret' },
      { type: 'text', text: 'role-instructions-secret', ...(marker ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) },
    ];
    const run = (ownerId: string, firstUser: string, marker = true) => {
      const span = telemetry.begin({ ownerId, provider: 'claude', protocol: 'anthropic-messages', transport: 'oauth-http' });
      span.setCacheShape(Buffer.from(JSON.stringify({
        model: 'claude-x', system: system(marker),
        tools: [{ name: 'a-secret-tool' }, { name: 'b-secret-tool', defer_loading: true },
          { name: 'c-secret-tool', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: firstUser, cache_control: { type: 'ephemeral', ttl: '5m' } }] },
          { role: 'assistant', content: 'later turn' }],
      })));
      span.recordCacheUsage(10, 0, 90);
      span.finish('ok', 200);
    };
    run('su-a', 'frozen brief secret A');
    run('su-b', 'frozen brief secret B');
    run('su-c', 'frozen brief secret A', false);
    run('su-a', 'second request of an owner already seen');
    // One line per owner start; the repeat request pays and journals nothing.
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/secret|later turn|already seen/);
    for (const line of lines) expect(line.length).toBeLessThan(2048);
    const layouts = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))).layout);
    expect(layouts[0]).toMatchObject({
      tools: { count: 3, deferred: 1 },
      system: { form: 'blocks', blockCount: 2 },
      messages: { count: 2, first: { role: 'user', blockCount: 1 } },
      truncated: false,
    });
    expect(layouts[0].markers).toEqual([
      { section: 'tools', index: 2, block: null, ttl: 'default' },
      { section: 'system', index: 1, block: null, ttl: '1h' },
      { section: 'messages', index: 0, block: 0, ttl: '5m' },
    ]);
    // The shared span is visible: identical system blocks across owners ...
    expect(layouts[0].system.blocks).toEqual(layouts[1].system.blocks);
    // ... a different first message is visible as the unshared per-task write ...
    expect(layouts[0].messages.first.hash.sha16).not.toBe(layouts[1].messages.first.hash.sha16);
    // ... and moving or removing a breakpoint never changes a content hash (cache_control is stripped).
    expect(layouts[2].system.blocks).toEqual(layouts[0].system.blocks);
    expect(layouts[2].messages.first.hash.sha16).toBe(layouts[0].messages.first.hash.sha16);
    expect(layouts[2].markers.map((m: { section: string }) => m.section)).toEqual(['tools', 'messages']);
    // Steady-state traffic is not measured: only an owner's first request computes a layout.
    expect(telemetry.snapshot().recent.map((t) => t.cache.layout === null)).toEqual([false, false, false, true]);
  });

  it('cuts message 0 at <system-reminder> boundaries so a shared leading span inside ONE block is locatable (WI-10005042)', () => {
    expect(splitAtSystemReminders('no reminder here')).toEqual(['no reminder here']);
    expect(splitAtSystemReminders('<system-reminder>a</system-reminder>')).toEqual(['<system-reminder>a</system-reminder>']);
    const joined = ['lead', '<system-reminder>one</system-reminder>', '<system-reminder>two</system-reminder>', 'tail'].join('');
    const parts = splitAtSystemReminders(joined);
    expect(parts).toEqual(['lead', '<system-reminder>one</system-reminder>', '<system-reminder>two</system-reminder>tail']);
    expect(parts.join('')).toBe(joined); // lossless: hashing the parts covers every byte once
    // Bounded: the Nth segment absorbs the remainder, never dropping bytes.
    const many = Array.from({ length: 25 }, (_, i) => `<system-reminder>${i}</system-reminder>`).join('');
    const bounded = splitAtSystemReminders(many, 4);
    expect(bounded).toHaveLength(4);
    expect(bounded.join('')).toBe(many);

    const lines: string[] = [];
    const telemetry = new GatewayRequestTelemetry({ onStartupEvidence: (line) => lines.push(line) });
    const reminder = (n: string) => `<system-reminder>${n}</system-reminder>`;
    const run = (ownerId: string, perOwner: string, content?: unknown) => {
      const span = telemetry.begin({ ownerId, provider: 'claude', protocol: 'anthropic-messages', transport: 'oauth-http' });
      span.setCacheShape(Buffer.from(JSON.stringify({
        model: 'claude-x', system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools: [{ name: 't' }],
        messages: [{ role: 'user', content: content ?? [{ type: 'text', text: reminder('shared claude.md') + reminder('shared skills') + reminder(perOwner) }] }],
      })));
      span.recordCacheUsage(2, 0, 100);
      span.finish('ok', 200);
    };
    run('su-a', 'carry A');
    run('su-b', 'carry B');
    run('su-c', 'x', 'plain string first message');
    const [a, b, c] = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))).layout.messages.first);
    expect(a.segments).toMatchObject({ block: 0, parts: expect.any(Array) });
    expect(a.segments.parts).toHaveLength(3);
    // Two owners share the leading segments and differ only in the last one: the splittable shared prefix.
    expect(a.segments.parts.slice(0, 2)).toEqual(b.segments.parts.slice(0, 2));
    expect(a.segments.parts[2].sha16).not.toBe(b.segments.parts[2].sha16);
    // The whole-message hash differs, which is why a single block can never be a partial cache hit.
    expect(a.hash.sha16).not.toBe(b.hash.sha16);
    expect(c.segments ?? null).toBeNull(); // no reminder cut -> no extra bytes in the journal row
    expect(lines.join('\n')).not.toMatch(/shared claude|carry A|carry B|plain string/);
    for (const line of lines) expect(line.length).toBeLessThan(2048);
  });

  it('bounds the layout: marker and system-block overflow is flagged, non-Anthropic and empty bodies stay null', () => {
    const lines: string[] = [];
    const telemetry = new GatewayRequestTelemetry({ onStartupEvidence: (line) => lines.push(line) });
    const begin = (ownerId: string, protocol: 'anthropic-messages' | 'openai-responses') =>
      telemetry.begin({ ownerId, provider: protocol === 'openai-responses' ? 'codex' : 'claude', protocol });
    const over = begin('su-over', 'anthropic-messages');
    over.setCacheShape(Buffer.from(JSON.stringify({
      system: Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `block-${i}`, cache_control: { type: 'ephemeral' } })),
      messages: [{ role: 'user', content: 'hi' }] })));
    over.finish('ok', 200);
    const codex = begin('su-codex', 'openai-responses');
    codex.setCacheShape(Buffer.from(JSON.stringify({ instructions: 'x', input: 'y' })));
    codex.finish('ok', 200);
    const empty = begin('su-empty', 'anthropic-messages');
    empty.setCacheShape(Buffer.from(JSON.stringify({ model: 'claude-x' })));
    empty.finish('ok', 200);
    const [overRow, codexRow, emptyRow] = telemetry.snapshot().recent;
    expect(overRow.cache.layout).toMatchObject({ truncated: true, system: { blockCount: 12 } });
    expect(overRow.cache.layout!.system.blocks).toHaveLength(8);
    expect(overRow.cache.layout!.markers).toHaveLength(8);
    expect(codexRow.cache.layout).toBeNull();
    expect(emptyRow.cache.layout).toBeNull();
    for (const line of lines) expect(line.length).toBeLessThan(2048);
  });

  it('a throwing durable sink never fails a completed request', () => {
    const telemetry = new GatewayRequestTelemetry({ onStartupEvidence: () => { throw new Error('journal down'); } });
    const span = telemetry.begin({ ownerId: 'su-x', provider: 'claude', protocol: 'anthropic-messages' });
    expect(span.finish('ok', 200)).not.toBeNull();
    expect(telemetry.snapshot().requests.finalized).toBe(1);
  });

  it('compares complete representative large tool and instruction blocks', () => {
    const telemetry = new GatewayRequestTelemetry();
    const body = {
      tools: [{ name: 'large-tool', description: 't'.repeat(230_000) }],
      instructions: 'i'.repeat(157_000),
    };
    const rows = ['first conversation', 'second conversation'].map((input, index) => {
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify({ ...body, input })));
      const cache = span.finish('ok', 200)!.cache;
      expect(cache.tools!.hashedBytes).toBe(cache.tools!.bytes);
      expect(cache.instructions!.hashedBytes).toBe(cache.instructions!.bytes);
      return { authorizationScope: 'same-observed-scope', model: 'same-model', transport: 'bearer-http' as const,
        tools: cache.tools, instructions: cache.instructions, startedAt: index * 100,
        availableAt: index * 100 + 50, expiresAt: 1000, cacheReadTokens: null, cacheWriteTokens: null };
    });
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 2, componentGroups: 1,
      withEarlierEligibleComponentMatch: 1, singleWriteGuaranteed: false });
  });

  it.each(['tools', 'instructions'] as const)('distinguishes equal-length %s changes after the old 64KiB cutoff', (field) => {
    const telemetry = new GatewayRequestTelemetry();
    const rows = ['A', 'B'].map((suffix, index) => {
      const value = 'x'.repeat(70_000) + suffix;
      const body = { tools: [{ name: 'stable-tool', description: field === 'tools' ? value : 'stable' }],
        instructions: field === 'instructions' ? value : 'stable' };
      const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      span.setCacheShape(Buffer.from(JSON.stringify(body)));
      const cache = span.finish('ok', 200)!.cache;
      return { authorizationScope: 'same-observed-scope', model: 'same-model', transport: 'bearer-http' as const,
        tools: cache.tools, instructions: cache.instructions, startedAt: index * 100,
        availableAt: null, expiresAt: null, cacheReadTokens: null, cacheWriteTokens: null };
    });
    // The grouping key includes bytes: unequal lengths would hide a truncated-hash bug.
    expect(rows[0][field]!.bytes).toBe(rows[1][field]!.bytes);
    expect(rows[0][field]!.sha256).not.toBe(rows[1][field]!.sha256);
    expect(assessStartupCacheSharing(rows)).toMatchObject({ comparable: 2, componentGroups: 2 });
  });

  it('bounds fingerprint work and does not call partial or missing observations exact', () => {
    const telemetry = new GatewayRequestTelemetry({ recentCapacity: 1 });
    const capped = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    const instructions = 'x'.repeat(MAX_CACHE_FINGERPRINT_BYTES + 1);
    capped.setCacheShape(Buffer.from(JSON.stringify({ instructions })));
    const first = capped.finish('ok', 200)!;
    expect(first.cache.instructions).toMatchObject({ bytes: Buffer.byteLength(JSON.stringify(instructions)),
      hashedBytes: MAX_CACHE_FINGERPRINT_BYTES });
    const oversized = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    oversized.setCacheShape(Buffer.alloc(2_097_153));
    oversized.recordCacheUsage(Number.NaN, 0, 0);
    expect(oversized.finish('ok', 200)?.cache).toMatchObject({ shape: 'oversized', reuse: 'unobserved', instructions: null });
    expect(telemetry.snapshot().recent).toHaveLength(1);
  });

  it('measures fingerprint overhead and rejects non-object request shapes', () => {
    let clock = 0;
    const telemetry = new GatewayRequestTelemetry({ now: () => ++clock });
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setCacheShape(Buffer.from('null'));
    const timeline = span.finish('client-error', 400)!;
    expect(timeline.cacheObservationMs).toBe(1);
    expect(timeline.cache.shape).toBe('invalid');
  });

  it('does not mislabel missing write usage as a measured zero or full hit', () => {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.recordCacheUsage(0, 100, undefined);
    expect(span.finish('ok', 200)?.cache).toMatchObject({ cacheWriteTokens: null, reuse: 'hit-unknown-write' });
    expect(telemetry.snapshot().requests).toMatchObject({ cacheUsageObserved: 1, cacheWriteObserved: 0 });
  });

  it('publishes bounded p50/p95/p99 samples with exact request/outcome reconciliation', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, sampleCapacity: 3, recentCapacity: 2 });
    const advance = (ms: number) => { now += ms; };

    for (let i = 0; i < 5; i++) {
      const timeline = completeCloudSpan(telemetry, (ms) => advance(ms + i), `su-${i}`);
      assertCompleteGatewayRequestTimeline(timeline);
    }
    const active = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
    active.routeSelected();

    const snapshot = telemetry.snapshot();
    expect(snapshot.requests).toMatchObject({
      started: 6,
      finalized: 5,
      active: 1,
      sampled: 5,
      coverage: 1,
      reconciled: true,
      outcomeReconciled: true,
      missingStageTimelines: 0,
    });
    expect(snapshot.outcomes.ok).toBe(5);
    expect(snapshot.outcomes.unclassified).toBe(0);
    expect(snapshot.stages.upstreamTtfb).toMatchObject({ count: 5, retained: 3 });
    expect(snapshot.stages.upstreamTtfb.p50).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p95).not.toBeNull();
    expect(snapshot.stages.upstreamTtfb.p99).not.toBeNull();
    expect(snapshot.recent).toHaveLength(2);
  });

  it('makes a missing required stage a loud validation failure and counted telemetry defect', () => {
    let now = 10;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({ provider: 'claude', protocol: 'anthropic-messages' });
    now += 1;
    span.routeSelected();
    now += 1;
    span.admitted();
    // Deliberately omit body/auth/upstream stages.
    const timeline = span.finish('ok', 200)!;

    expect(() => assertCompleteGatewayRequestTimeline(timeline)).toThrow(/bodyRead.*upstreamTtfb.*auth/);
    const snapshot = telemetry.snapshot();
    expect(snapshot.requests.missingStageTimelines).toBe(1);
    expect(snapshot.missingStageByName.bodyRead).toBe(1);
    expect(snapshot.missingStageByName.auth).toBe(1);
    expect(snapshot.missingStageByName.upstreamTtfb).toBe(1);
  });

  it('attributes aggregate queueWait to typed durable/provider admission segments with queue state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const span = telemetry.begin({
      ownerId: 'su-latency',
      provider: 'codex',
      protocol: 'openai-responses',
      transport: 'oauth-http',
    });
    span.routeSelected();

    span.admissionQueued('payloadSpool');
    now += 5;
    span.admissionAdmitted('payloadSpool');

    span.admissionQueued('durable', { priority: 20 });
    now += 12;
    span.admissionAdmitted('durable', { priority: 20 });

    span.admissionQueued('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 849,
        queued: 17,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 721, queued: 16 }],
      },
    });
    now += 66_110;
    span.admissionAdmitted('provider', {
      priority: 20,
      tier: 2,
      queue: {
        running: 850,
        queued: 16,
        maxConcurrent: 850,
        tier1Reserve: 128,
        byTier: [{ tier: 2, minShare: 1, inFlight: 722, queued: 15 }],
      },
    });
    span.admitted();
    span.beginStage('bodyRead');
    span.endStage('bodyRead');
    span.beginStage('auth');
    span.endStage('auth');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 3;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    expect(timeline.durationsMs.queueWait).toBe(66_127);
    expect(timeline.admission).toEqual({
      payloadSpool: {
        queued: expect.objectContaining({ offsetMs: 0 }),
        admitted: expect.objectContaining({ offsetMs: 5 }),
        waitMs: 5,
      },
      durable: {
        queued: expect.objectContaining({ offsetMs: 5, priority: 20 }),
        admitted: expect.objectContaining({ offsetMs: 17, priority: 20 }),
        waitMs: 12,
      },
      provider: {
        queued: {
          offsetMs: 17,
          priority: 20,
          tier: 2,
          running: 849,
          queued: 17,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 721,
          tierQueued: 16,
        },
        admitted: {
          offsetMs: 66_127,
          priority: 20,
          tier: 2,
          running: 850,
          queued: 16,
          maxConcurrent: 850,
          tier1Reserve: 128,
          tierMinShare: 1,
          tierInFlight: 722,
          tierQueued: 15,
        },
        waitMs: 66_110,
      },
    });
    expect(telemetry.snapshotForOwner('su-latency').recent[0]?.admission.provider?.waitMs).toBe(66_110);
  });

  it('never retains arbitrary bodies, credentials, headers, URLs, or error prose', () => {
    let now = 100;
    const telemetry = new GatewayRequestTelemetry({ now: () => now });
    const seed = {
      ownerId: 'su safe owner\nBearer SECRET_TOKEN',
      provider: 'local' as const,
      protocol: 'openai-chat' as const,
      transport: 'local-http' as const,
      requestBody: 'PROMPT_SECRET',
      authorization: 'Bearer SECRET_TOKEN',
      url: 'https://secret.invalid/private',
    };
    const span = telemetry.begin(seed);
    span.routeSelected();
    span.admitted();
    span.beginStage('bodyRead');
    now += 1;
    span.endStage('bodyRead');
    span.setModel('model\nSECRET_MODEL_SUFFIX');
    span.recordAttempt();
    span.beginStage('upstreamTtfb');
    now += 1;
    span.endStage('upstreamTtfb');
    const timeline = span.finish('ok', 200)!;
    assertCompleteGatewayRequestTimeline(timeline);

    const serialized = JSON.stringify(telemetry.snapshot());
    expect(serialized).not.toContain('PROMPT_SECRET');
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toContain('secret.invalid');
    expect(timeline.ownerId).toBe('su');
    expect(timeline.model).toBe('model?SECRET_MODEL_SUFFIX');
  });

  it('classifies one stable final outcome from status and terminal conditions', () => {
    expect(classifyGatewayTelemetryOutcome(200)).toBe('ok');
    expect(classifyGatewayTelemetryOutcome(400)).toBe('client-error');
    expect(classifyGatewayTelemetryOutcome(429)).toBe('upstream-429');
    expect(classifyGatewayTelemetryOutcome(503)).toBe('upstream-error');
    expect(classifyGatewayTelemetryOutcome(null, { cancelled: true })).toBe('cancelled');
    expect(classifyGatewayTelemetryOutcome(429, { shed: true })).toBe('shed');
    expect(classifyGatewayTelemetryOutcome(500, { gatewayError: true })).toBe('gateway-error');
    expect(classifyGatewayTelemetryOutcome(null)).toBe('unclassified');
  });

  it('adds owner summaries to the existing per-owner read without unbounded per-owner state', () => {
    let now = 1_000;
    const telemetry = new GatewayRequestTelemetry({ now: () => now, recentCapacity: 3 });
    for (const owner of ['su-a', 'su-b', 'su-a']) {
      completeCloudSpan(telemetry, (ms) => { now += ms; }, owner);
    }
    const owner = telemetry.snapshotForOwner('su-a');
    expect(owner.finalized).toBe(2);
    expect(owner.outcomes.ok).toBe(2);
    expect(owner.stages.total.count).toBe(2);
    expect(owner.recent.every((timeline) => timeline.ownerId === 'su-a')).toBe(true);
  });
});
