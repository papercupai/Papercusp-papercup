/**
 * Provider conformance kit (provider-adapters-to-packages-2026-10-11 P-026, D-003 shared piece 1).
 *
 * One executable definition of "a correct provider package", run unmodified against every
 * package: the in-repo social packages and any package an outside author writes. It replaces the
 * in-app social adapter kit (operator-core external-triggers/social/conformance.ts), whose checks
 * assumed adapters that owned their own cursors, retries and egress. Under the provider contract
 * the HOST owns those, so the checks here ask the opposite questions: does the package stay inside
 * its declared egress hosts, page to completion, resume from its own cursor without repeating
 * records, and hand rate-limit / auth / cursor-expired conditions back to the host as
 * {@link ProviderSyncError} kinds instead of retrying them itself?
 *
 * WHY A PURE FUNCTION AND NOT A vitest `describe`: it returns a structured report, so the same
 * checks run under any test framework (an outside author's package may not use vitest) and can be
 * pointed at a live account for an attestation run later. When a platform needs a check changed to
 * pass, that is a finding about the contract and must be recorded, not patched per package.
 *
 * The kit drives the adapter through a fake `host.fetch` the harness supplies (see
 * {@link recordedHostFetch} for a ready-made one built from recorded HTTP exchanges). Every request
 * the package makes is checked against the descriptor's `egressHosts` and refused the way the
 * host refuses it.
 */
import {
  PROVIDER_SEARCH_LIVE_CAPABILITY,
  PROVIDER_SOCIAL_DELETE_CAPABILITY,
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
  providerSourceEgressAllows,
  providerLiveSearchResultIssue,
  providerSocialDeleteResultIssue,
  providerSocialWriteResultIssue,
  providerCoverageIssues,
  providerSyncProgressIssues,
  providerSyncErrorOf,
  validateProviderDescriptor,
  type HostFetch,
  type HostFetchRequest,
  type HostFetchResponse,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderRecord,
  type ProviderServices,
  type ProviderSourceScope,
  type ProviderSyncError,
  type ProviderSyncPage,
} from './provider';

/* ── recorded HTTP fake ──────────────────────────────────────────────────── */

/** One recorded request/response pair. */
export interface RecordedExchange {
  /** HTTP method to match (case-insensitive). Omit to match any method. */
  method?: string;
  /** The full URL, a pattern over it, or a predicate over the parsed URL. */
  url: string | RegExp | ((url: URL, request: HostFetchRequest) => boolean);
  /** Optional predicate over the request body (for GraphQL or form posts sharing one URL). */
  body?: (body: string | undefined, request: HostFetchRequest) => boolean;
  /** The recorded response, or a function computing it from the request. */
  response: HostFetchResponse | ((request: HostFetchRequest) => HostFetchResponse);
}

export interface RecordedHostFetch {
  fetch: HostFetch;
  /** Every request the provider made, in order. */
  calls: Array<{ source: string; request: HostFetchRequest }>;
}

/** A JSON {@link HostFetchResponse}. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    bodyEncoding: 'utf8',
  };
}

function exchangeMatches(exchange: RecordedExchange, request: HostFetchRequest): boolean {
  const method = (request.method ?? 'GET').toUpperCase();
  if (exchange.method && exchange.method.toUpperCase() !== method) return false;
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return false;
  }
  const matcher = exchange.url;
  const urlOk =
    typeof matcher === 'string' ? matcher === request.url : matcher instanceof RegExp ? matcher.test(request.url) : matcher(parsed, request);
  if (!urlOk) return false;
  return exchange.body ? exchange.body(request.body, request) : true;
}

/**
 * A `host.fetch` that answers from recorded exchanges (first match wins) and records every call.
 * An unmatched request throws `recorded_fetch_unmatched`, so a package that calls an endpoint the
 * recording never saw fails loudly instead of receiving an invented answer.
 */
export function recordedHostFetch(exchanges: readonly RecordedExchange[]): RecordedHostFetch {
  const calls: RecordedHostFetch['calls'] = [];
  const fetch: HostFetch = async ({ source, request }) => {
    calls.push({ source, request });
    const exchange = exchanges.find((candidate) => exchangeMatches(candidate, request));
    if (!exchange) throw new Error(`recorded_fetch_unmatched: ${(request.method ?? 'GET').toUpperCase()} ${request.url}`);
    return typeof exchange.response === 'function' ? exchange.response(request) : exchange.response;
  };
  return { fetch, calls };
}

/* ── harness + report ────────────────────────────────────────────────────── */

/** One call of a declared capability the kit makes, with the args a real caller would pass. */
export interface ProviderConformanceInvocation {
  capability: string;
  args: Record<string, unknown>;
  /** Extra shape check beyond the documented one. Return why the result is wrong, or null. */
  check?: (result: unknown) => string | null;
}

export interface ProviderConformanceHarness {
  adapter: ProviderAdapter;
  /** A fresh fake `host.fetch` (a fresh recorded world). Called once per check so checks cannot leak. */
  createFetch(): HostFetch;
  /** Source id passed on every request. Default `conformance-source`. */
  source?: string;
  config?: Record<string, unknown>;
  services?: ProviderServices;
  scope?: ProviderSourceScope;
  /** Pages a drain may take before the kit calls it non-terminating. Default 25. */
  maxPages?: number;
  /** A known gap beyond the remote retention window, with an independently expected boundary. */
  retentionGap?: { cursor: string; oldestReachableAt: string; response?: HostFetchResponse; createFetch?: () => HostFetch };
  faults?: {
    /** Response for a rate-limited call. Default a 429 with `retry-after: 30`; `false` skips the check. */
    rateLimited?: HostFetchResponse | false;
    /** Response for a revoked grant. Default a 401; `false` skips the check. */
    auth?: HostFetchResponse | false;
    /** Response for a server fault. Default a 503; `false` skips the check. */
    serverError?: HostFetchResponse | false;
    /**
     * A cursor the platform refuses (e.g. older than its retention window) and, optionally, the
     * response that refuses it (returned for the first call). Omit when the platform cannot refuse
     * a cursor; the check is then skipped and the report says so.
     */
    expiredCursor?: { cursor: string; response?: HostFetchResponse };
  };
  /** Calls for the declared capabilities. Every declared capability needs at least one. */
  invocations?: readonly ProviderConformanceInvocation[];
  /** Canonical payload check for a datatype (e.g. against its registered JSON schema). Return why it fails, or null. */
  validatePayload?: (datatype: string, payload: Record<string, unknown>) => string | null;
}

export interface ProviderConformanceFinding {
  check: string;
  detail: string;
}

export interface ProviderConformanceReport {
  providerId: string;
  checksRun: string[];
  checksSkipped: { check: string; why: string }[];
  failures: ProviderConformanceFinding[];
  ok: boolean;
}

/** Every check name the kit can run, so a package test can assert the ones it expects. */
export const PROVIDER_CONFORMANCE_CHECKS = [
  'descriptor-valid',
  'egress-confined',
  'fetch-uses-request-source',
  'pages-to-completion',
  'records-well-formed',
  'no-duplicate-records',
  'native-ids-stable',
  'resume-without-duplicates',
  'final-cursor-does-not-restart',
  'unreadable-cursor-is-cursor-expired',
  'expired-cursor-is-cursor-expired',
  'retention-loss-reported',
  'rate-limit-not-retried',
  'auth-not-retried',
  'server-error-not-retried',
  'capability-exercised',
  'invoke-result-shape',
  'invoke-fault-not-retried',
  'undeclared-capability-refused',
] as const;
export type ProviderConformanceCheck = (typeof PROVIDER_CONFORMANCE_CHECKS)[number];

/** Result shapes the SDK documents for a capability. Null = the SDK documents none. */
function documentedShapeIssue(capability: string, result: unknown): string | null {
  switch (capability) {
    case PROVIDER_SOCIAL_POST_CAPABILITY:
    case PROVIDER_SOCIAL_REPLY_CAPABILITY:
      return providerSocialWriteResultIssue(result);
    case PROVIDER_SOCIAL_DELETE_CAPABILITY:
      return providerSocialDeleteResultIssue(result);
    case PROVIDER_SEARCH_LIVE_CAPABILITY:
      return providerLiveSearchResultIssue(result);
    default:
      return null;
  }
}

const DEFAULT_RATE_LIMITED: HostFetchResponse = jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '30' });
const DEFAULT_AUTH: HostFetchResponse = jsonResponse(401, { error: 'invalid token' });
const DEFAULT_SERVER_ERROR: HostFetchResponse = jsonResponse(503, { error: 'unavailable' });
/** A cursor no package can have issued. */
export const CONFORMANCE_UNREADABLE_CURSOR = 'conformance:unreadable-cursor';
const UNDECLARED_CAPABILITY = 'conformance.undeclared';

function recordKey(record: ProviderRecord): string {
  return `${record.datatype}\u0000${record.nativeId}\u0000${record.event}`;
}

function describeKey(key: string): string {
  return key.split('\u0000').join(':');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface DrainResult {
  pages: ProviderSyncPage[];
  records: ProviderRecord[];
  /** cursors[i] = the cursor returned by page i. */
  cursors: Array<string | null>;
  error?: unknown;
  /** The drain hit maxPages with hasMore still true. */
  truncated: boolean;
  /** A page was malformed (reported by the drain itself). */
  malformed?: string;
}

/**
 * Run every conformance check against one provider adapter.
 *
 * Never throws for a conformance failure: failures are returned so a caller sees all of them at
 * once. It does propagate an error from the harness itself, because then a check could not run,
 * which is not the same as the package failing it.
 */
export async function runProviderConformance(harness: ProviderConformanceHarness): Promise<ProviderConformanceReport> {
  const failures: ProviderConformanceFinding[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { check: string; why: string }[] = [];
  const fail = (check: ProviderConformanceCheck, detail: string) => failures.push({ check, detail });
  const run = (check: ProviderConformanceCheck) => {
    if (!checksRun.includes(check)) checksRun.push(check);
  };
  const skip = (check: ProviderConformanceCheck, why: string) => checksSkipped.push({ check, why });

  const source = harness.source ?? 'conformance-source';
  const maxPages = harness.maxPages ?? 25;
  const adapter = harness.adapter;

  // ── the descriptor validates ───────────────────────────────────────────────
  run('descriptor-valid');
  let descriptor: ProviderDescriptor;
  try {
    descriptor = await adapter.describe();
  } catch (error) {
    fail('descriptor-valid', `describe() threw: ${errorText(error)}`);
    return { providerId: 'unknown', checksRun, checksSkipped, failures, ok: false };
  }
  const providerId = typeof descriptor?.id === 'string' ? descriptor.id : 'unknown';
  const descriptorIssues = validateProviderDescriptor(descriptor);
  for (const issue of descriptorIssues) fail('descriptor-valid', issue);
  const datatypes = new Set(Array.isArray(descriptor?.datatypes) ? descriptor.datatypes : []);
  const capabilities = Array.isArray(descriptor?.capabilities) ? descriptor.capabilities : [];

  // ── every request stays inside egressHosts (checked on every call of every check) ──
  run('egress-confined');
  run('fetch-uses-request-source');
  const egressViolations = new Set<string>();
  const foreignSources = new Set<string>();
  /**
   * Wrap a fresh harness fetch: refuse what the host would refuse, count calls, and optionally
   * answer the FIRST call with a fault response (any later call after a fault is a retry).
   */
  const guardedFetch = (fault?: HostFetchResponse, createFetch = harness.createFetch) => {
    const inner = createFetch();
    const state = { calls: 0 };
    const fetch: HostFetch = async (input) => {
      state.calls += 1;
      if (input.source !== source) foreignSources.add(input.source);
      let url: URL | null = null;
      try {
        url = new URL(input.request.url);
      } catch {
        url = null;
      }
      if (!url || !providerSourceEgressAllows(descriptor, url, harness.config)) {
        egressViolations.add(input.request.url);
        throw new Error(`egress_refused: ${input.request.url} is outside the declared egressHosts`);
      }
      if (fault && state.calls === 1) return fault;
      return inner(input);
    };
    return { host: { fetch }, state };
  };

  const syncPage = (cursor: string | null, mode: 'backfill' | 'incremental', host: { fetch: HostFetch }) =>
    adapter.syncPage({ source, cursor, mode, config: harness.config, services: harness.services, scope: harness.scope }, host);

  const drain = async (startCursor: string | null, mode: 'backfill' | 'incremental'): Promise<DrainResult> => {
    const { host } = guardedFetch();
    const result: DrainResult = { pages: [], records: [], cursors: [], truncated: false };
    let cursor = startCursor;
    for (let i = 0; i < maxPages; i++) {
      let page: ProviderSyncPage;
      try {
        page = await syncPage(cursor, mode, host);
      } catch (error) {
        result.error = error;
        return result;
      }
      if (!isPlainObject(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        result.malformed = 'syncPage returned a page without a records array and a boolean hasMore';
        return result;
      }
      if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
        result.malformed = 'nextCursor must be a string or null';
        return result;
      }
      // The host refuses a page with malformed coverage (it would tombstone the wrong window).
      const coverageIssues = providerCoverageIssues(page.coverage, descriptor.datatypes ?? []);
      if (coverageIssues.length > 0) {
        result.malformed = `malformed coverage: ${coverageIssues.join('; ')}`;
        return result;
      }
      const progressIssues = providerSyncProgressIssues(page);
      if (progressIssues.length > 0) {
        result.malformed = `malformed sync progress: ${progressIssues.join('; ')}`;
        return result;
      }
      result.pages.push(page);
      result.records.push(...page.records);
      result.cursors.push(page.nextCursor);
      if (!page.hasMore) return result;
      if (page.nextCursor === null) {
        result.malformed = 'a page with hasMore:true returned no nextCursor, so the host cannot ask for the next page';
        return result;
      }
      if (page.nextCursor === cursor) {
        result.malformed = 'a page with hasMore:true returned the cursor it was given, so the drain makes no progress';
        return result;
      }
      cursor = page.nextCursor;
    }
    result.truncated = true;
    return result;
  };

  // ── syncPage pages to completion ──────────────────────────────────────────
  run('pages-to-completion');
  const full = await drain(null, 'backfill');
  let drained = true;
  if (full.error !== undefined) {
    drained = false;
    const signal = providerSyncErrorOf(full.error);
    fail('pages-to-completion', `syncPage threw on page ${full.pages.length + 1}: ${signal ? `${signal.kind}: ${signal.message}` : errorText(full.error)}`);
  } else if (full.malformed) {
    drained = false;
    fail('pages-to-completion', full.malformed);
  } else if (full.truncated) {
    drained = false;
    fail('pages-to-completion', `still hasMore after ${maxPages} pages`);
  }

  // ── records carry declared datatypes and well-formed identities ───────────
  run('records-well-formed');
  for (const record of full.records) {
    const where = `record ${String((record as ProviderRecord)?.nativeId ?? '?')}`;
    if (!isPlainObject(record)) {
      fail('records-well-formed', 'a record is not an object');
      continue;
    }
    if (!datatypes.has(record.datatype)) fail('records-well-formed', `${where} has undeclared datatype '${String(record.datatype)}'`);
    if (typeof record.nativeId !== 'string' || record.nativeId.trim() === '') fail('records-well-formed', `${where} has no nativeId`);
    if (typeof record.event !== 'string' || record.event.trim() === '') fail('records-well-formed', `${where} has no event name`);
    if (!isPlainObject(record.payload)) fail('records-well-formed', `${where} payload is not an object`);
    if (record.occurredAt !== undefined && (typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt)))) {
      fail('records-well-formed', `${where} occurredAt is not an ISO-8601 time`);
    }
    if (record.deleted !== undefined && typeof record.deleted !== 'boolean') fail('records-well-formed', `${where} deleted must be a boolean`);
    if (record.version !== undefined && (typeof record.version !== 'string' || record.version === '')) {
      fail('records-well-formed', `${where} version must be a non-empty string`);
    }
    if (harness.validatePayload && isPlainObject(record.payload) && datatypes.has(record.datatype)) {
      const issue = harness.validatePayload(record.datatype, record.payload);
      if (issue) fail('records-well-formed', `${where} payload fails its ${record.datatype} schema: ${issue}`);
    }
  }

  // ── no record twice within one drain ──────────────────────────────────────
  run('no-duplicate-records');
  const fullKeys = full.records.map(recordKey);
  const repeated = fullKeys.filter((key, i) => fullKeys.indexOf(key) !== i);
  if (repeated.length > 0) {
    fail('no-duplicate-records', `records emitted more than once in one drain: ${[...new Set(repeated)].map(describeKey).join(', ')}`);
  }

  if (drained) {
    // ── native ids are stable across identical drains ───────────────────────
    // An id built from wall-clock time or randomness looks fine in one run and defeats the host's
    // dedupe on the second one, which is the run nobody tests.
    run('native-ids-stable');
    const again = await drain(null, 'backfill');
    const againKeys = again.records.map(recordKey);
    if (again.error !== undefined || again.malformed) {
      fail('native-ids-stable', `a second identical drain failed: ${again.malformed ?? errorText(again.error)}`);
    } else if ([...fullKeys].sort().join('|') !== [...againKeys].sort().join('|')) {
      fail('native-ids-stable', 'two identical drains emitted different record identities; nativeIds must come from provider facts, not time or randomness');
    }

    // ── resuming from a returned cursor repeats nothing and loses nothing ────
    if (full.pages.length >= 2) {
      run('resume-without-duplicates');
      const firstPageKeys = new Set(full.pages[0]!.records.map(recordKey));
      const resumed = await drain(full.cursors[0] ?? null, 'backfill');
      if (resumed.error !== undefined || resumed.malformed) {
        fail('resume-without-duplicates', `resuming from the cursor page 1 returned failed: ${resumed.malformed ?? errorText(resumed.error)}`);
      } else {
        const resumedKeys = resumed.records.map(recordKey);
        const repeatedAcross = resumedKeys.filter((key) => firstPageKeys.has(key));
        if (repeatedAcross.length > 0) {
          fail(
            'resume-without-duplicates',
            `resuming from page 1's cursor repeated records page 1 already returned: ${[...new Set(repeatedAcross)].map(describeKey).join(', ')}`,
          );
        }
        const covered = new Set([...firstPageKeys, ...resumedKeys]);
        const lost = [...new Set(fullKeys)].filter((key) => !covered.has(key));
        if (lost.length > 0) {
          fail('resume-without-duplicates', `resuming from page 1's cursor lost records: ${lost.map(describeKey).join(', ')}`);
        }
      }
    } else {
      skip('resume-without-duplicates', 'the fake answers the drain in one page; record at least two pages so resuming can be checked');
    }

    // ── an incremental pass from the final cursor does not start over ───────
    // Re-reading the whole account on every pass loses nothing and is still broken: it multiplies
    // API cost (a pay-per-use API makes that a bill) and re-delivers every record.
    const finalCursor = full.cursors[full.cursors.length - 1] ?? null;
    const uniqueFull = new Set(fullKeys);
    if (finalCursor !== null && uniqueFull.size >= 2) {
      run('final-cursor-does-not-restart');
      const tail = await drain(finalCursor, 'incremental');
      if (tail.error !== undefined || tail.malformed) {
        const signal = tail.error !== undefined ? providerSyncErrorOf(tail.error) : null;
        fail('final-cursor-does-not-restart', `an incremental pass from the final cursor failed: ${tail.malformed ?? (signal ? `${signal.kind}: ${signal.message}` : errorText(tail.error))}`);
      } else {
        const tailKeys = new Set(tail.records.map(recordKey));
        if ([...uniqueFull].every((key) => tailKeys.has(key))) {
          fail('final-cursor-does-not-restart', `an incremental pass from the final cursor re-emitted all ${uniqueFull.size} records, so every pass re-reads the account`);
        }
      }
    } else {
      skip('final-cursor-does-not-restart', 'the drain returned no final cursor or fewer than two records');
    }
  } else {
    for (const check of ['native-ids-stable', 'resume-without-duplicates', 'final-cursor-does-not-restart'] as const) {
      skip(check, 'the first drain did not complete (see pages-to-completion)');
    }
  }

  // ── conditions the host interprets surface as ProviderSyncError kinds ─────
  const expectSignal = async (
    check: ProviderConformanceCheck,
    cursor: string | null,
    fault: HostFetchResponse | undefined,
    expected: ProviderSyncError['kind'] | 'any',
    what: string,
  ): Promise<ProviderSyncError | null> => {
    run(check);
    const { host, state } = guardedFetch(fault);
    let page: ProviderSyncPage;
    try {
      page = await syncPage(cursor, cursor === null ? 'backfill' : 'incremental', host);
    } catch (error) {
      const signal = providerSyncErrorOf(error);
      if (expected !== 'any' && signal?.kind !== expected) {
        fail(check, `${what} surfaced as ${signal ? `'${signal.kind}'` : `an unclassified error (${errorText(error)})`}, expected '${expected}'`);
      }
      if (fault && state.calls > 1) {
        fail(check, `${what}: the package called host.fetch ${state.calls} times; it must hand the condition to the host instead of retrying`);
      }
      return signal;
    }
    const count = Array.isArray(page?.records) ? page.records.length : 0;
    fail(check, `${what} returned a page (${count} records) instead of raising${expected === 'any' ? ' an error' : ` '${expected}'`}${state.calls > 1 ? ` after ${state.calls} calls (a retry)` : ''}`);
    return null;
  };

  await expectSignal('unreadable-cursor-is-cursor-expired', CONFORMANCE_UNREADABLE_CURSOR, undefined, 'cursor-expired', 'a cursor the package never issued');

  const faults = harness.faults ?? {};
  if (harness.retentionGap) {
    run('retention-loss-reported');
    const gap = harness.retentionGap;
    const { host } = guardedFetch(gap.response, gap.createFetch);
    try {
      let page: ProviderSyncPage;
      try {
        page = await syncPage(gap.cursor, 'incremental', host);
      } catch (cause) {
        if (providerSyncErrorOf(cause)?.kind !== 'cursor-expired') throw cause;
        // The same reset the host performs preserves the rejected cursor for loss reporting.
        page = await adapter.syncPage({ source, cursor: null, mode: 'backfill', catchUpFrom: gap.cursor,
          config: harness.config, services: harness.services, scope: harness.scope }, host);
      }
      let reported = false;
      const issues: string[] = [];
      for (let n = 0; n < maxPages; n++) {
        issues.push(...providerSyncProgressIssues(page));
        if (page.lossRisk && Date.parse(page.lossRisk.oldestReachableAt) === Date.parse(gap.oldestReachableAt)) reported = true;
        if (!page.hasMore) break;
        if (!page.nextCursor || n === maxPages - 1) throw new Error('retention catch-up did not complete');
        page = await adapter.syncPage({ source, cursor: page.nextCursor, mode: 'backfill', catchUpFrom: gap.cursor,
          config: harness.config, services: harness.services, scope: harness.scope }, host);
      }
      if (issues.length > 0 || !reported) {
        fail('retention-loss-reported', `known retention gap did not report its oldest reachable instant ${gap.oldestReachableAt}${issues.length ? `: ${issues.join('; ')}` : ''}`);
      }
    } catch (cause) {
      fail('retention-loss-reported', `retention catch-up failed: ${errorText(cause)}`);
    }
  } else {
    skip('retention-loss-reported', 'harness declares no known retention gap');
  }
  if (faults.expiredCursor) {
    await expectSignal('expired-cursor-is-cursor-expired', faults.expiredCursor.cursor, faults.expiredCursor.response, 'cursor-expired', 'a cursor the platform refuses');
  } else {
    skip('expired-cursor-is-cursor-expired', 'harness declares no expiredCursor: this platform cannot refuse a cursor');
  }

  if (faults.rateLimited !== false) {
    const response = faults.rateLimited ?? DEFAULT_RATE_LIMITED;
    const signal = await expectSignal('rate-limit-not-retried', null, response, 'rate-limited', 'a rate-limited response');
    const retryHeader = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
    if (signal?.kind === 'rate-limited' && retryHeader !== undefined && signal.retryAfterSeconds === undefined) {
      fail('rate-limit-not-retried', `the response said retry-after: ${retryHeader} but the error carries no retryAfterSeconds for the host to honour`);
    }
  } else {
    skip('rate-limit-not-retried', 'harness disabled the rate-limit fault');
  }

  if (faults.auth !== false) {
    await expectSignal('auth-not-retried', null, faults.auth ?? DEFAULT_AUTH, 'auth', 'a revoked-grant response');
  } else {
    skip('auth-not-retried', 'harness disabled the auth fault');
  }

  if (faults.serverError !== false) {
    await expectSignal('server-error-not-retried', null, faults.serverError ?? DEFAULT_SERVER_ERROR, 'any', 'a server-error response');
  } else {
    skip('server-error-not-retried', 'harness disabled the server-error fault');
  }

  // ── each declared capability's invoke result has the documented shape ────
  const invocations = harness.invocations ?? [];
  if (capabilities.length > 0) {
    run('capability-exercised');
    for (const capability of capabilities) {
      if (!invocations.some((invocation) => invocation.capability === capability)) {
        fail('capability-exercised', `declared capability '${capability}' has no invocation in the harness`);
      }
    }
  }
  for (const invocation of invocations) {
    run('invoke-result-shape');
    if (!capabilities.includes(invocation.capability)) {
      fail('invoke-result-shape', `the harness invokes '${invocation.capability}', which the descriptor does not declare`);
      continue;
    }
    const { host } = guardedFetch();
    let result: unknown;
    try {
      result = await adapter.invoke(
        { source, capability: invocation.capability, args: invocation.args, config: harness.config, services: harness.services },
        host,
      );
    } catch (error) {
      fail('invoke-result-shape', `${invocation.capability} threw: ${errorText(error)}`);
      continue;
    }
    try {
      JSON.stringify(result);
    } catch {
      fail('invoke-result-shape', `${invocation.capability} returned a value that is not JSON-serialisable`);
      continue;
    }
    const documented = documentedShapeIssue(invocation.capability, result);
    if (documented) fail('invoke-result-shape', `${invocation.capability}: ${documented}`);
    const extra = invocation.check?.(result) ?? null;
    if (extra) fail('invoke-result-shape', `${invocation.capability}: ${extra}`);

    // A write retried by the package can post twice; the host decides whether to retry.
    run('invoke-fault-not-retried');
    const faulted = guardedFetch(faults.rateLimited === false || faults.rateLimited === undefined ? DEFAULT_RATE_LIMITED : faults.rateLimited);
    try {
      await adapter.invoke(
        { source, capability: invocation.capability, args: invocation.args, config: harness.config, services: harness.services },
        faulted.host,
      );
      // A capability that sends no request (a pure transform such as ingress.normalize) had no
      // first request to rate-limit, so it has nothing to swallow or retry.
      if (faulted.state.calls > 0) {
        fail('invoke-fault-not-retried', `${invocation.capability} resolved although its first request was rate-limited${faulted.state.calls > 1 ? ` (it retried: ${faulted.state.calls} calls)` : ''}`);
      }
    } catch {
      if (faulted.state.calls > 1) {
        fail('invoke-fault-not-retried', `${invocation.capability} called host.fetch ${faulted.state.calls} times after a rate-limited response; it must not retry`);
      }
    }
  }
  if (capabilities.length === 0 && invocations.length === 0) {
    skip('invoke-result-shape', 'the descriptor declares no capabilities');
    skip('invoke-fault-not-retried', 'the descriptor declares no capabilities');
  }

  run('undeclared-capability-refused');
  {
    const { host } = guardedFetch();
    try {
      await adapter.invoke({ source, capability: UNDECLARED_CAPABILITY, args: {} }, host);
      fail('undeclared-capability-refused', `invoke accepted '${UNDECLARED_CAPABILITY}', which the descriptor does not declare`);
    } catch {
      // refused, as required
    }
  }

  for (const url of egressViolations) fail('egress-confined', `requested ${url}, outside ${descriptor.oauth?.instance
    ? 'the source connection origin' : `egressHosts [${descriptor.egressHosts.join(', ')}]`}`);
  for (const other of foreignSources) fail('fetch-uses-request-source', `host.fetch was called for source '${other}', not the request's source '${source}'`);

  return { providerId, checksRun, checksSkipped, failures, ok: failures.length === 0 };
}

/** Human summary of a report, for a test failure message or a live attestation log. */
export function formatProviderConformanceReport(report: ProviderConformanceReport): string {
  if (report.ok) {
    const skipped = report.checksSkipped.length ? `, ${report.checksSkipped.length} skipped` : '';
    return `${report.providerId}: ${report.checksRun.length} checks passed${skipped}`;
  }
  const lines = report.failures.map((f) => `  - [${f.check}] ${f.detail}`);
  return `${report.providerId}: ${report.failures.length} conformance failure(s)\n${lines.join('\n')}`;
}
