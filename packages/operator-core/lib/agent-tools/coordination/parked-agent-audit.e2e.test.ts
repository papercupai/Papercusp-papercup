/**
 * P-001 / R-1 of parked-agent-census-resumption-and-root-cause-2026-10-09.
 * Re-read the complete frozen population from PG, independently of the disk projections
 * and disposition writer. Missing, duplicate, foreign or unexplained rows fail closed.
 * The controls always run; the read-only live check requires an explicit opt-in:
 *
 * PAPERCUSP_PARKED_AUDIT_LIVE=1 PAPERCUSP_SKIP_PG_DISCOVERY=1
 * PAPERCUSP_APP_OPERATION_LIVE_PROFILE=packages/operator-core/test/parked-agent-audit.live-profile.json
 *   npm run test:file -- <this file>
 *
 * Uses the maintained vitest.e2e.config.ts for measured e2e layer attribution.
 * Reuses the canonical artifact store and live-suite PG gate. It creates no watchdog,
 * alternative census, or changes to the archived start population.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';
import { auditKnown, auditUnknown, auditWakeEvidence, createRosterAudit, pageRosterAudit, type AuditRecord } from './tools/roster-audit';

const SEARCH_QUERY = 'parked agent audit';
const AUDIT_DOC = 'agent-insights/parked-agent-audit-roster-view';
const AUDIT_LIVE_PROFILE = 'packages/operator-core/test/parked-agent-audit.live-profile.json';
interface SearchObservation {
  tools: { query: string; hits: Array<{ tool: string; description: string }> };
  docs: { hits: Array<{ slug: string; url: string }>; legs: { degraded: boolean } };
}

function searchViolations(observation: SearchObservation | null): string[] {
  if (!observation || !Array.isArray(observation.tools?.hits) || !Array.isArray(observation.docs?.hits)) {
    return ['live-search-unavailable'];
  }
  const errors: string[] = [];
  if (observation.tools.query !== SEARCH_QUERY) errors.push('wrong-query');
  if (!observation.tools.hits.slice(0, 3).some(hit => hit.tool === 'coord:roster'
    && /view\s*[:=]\s*["']?audit\b/.test(hit.description))) errors.push('tools:find:missing-top-three');
  if (!observation.docs.hits.slice(0, 3).some(hit => hit.slug === AUDIT_DOC
    && hit.url === `/internal/docs/${AUDIT_DOC}`)) errors.push('docs:search:missing-top-three');
  if (observation.docs.legs?.degraded !== false) errors.push('docs:search:unavailable-ranking');
  return errors;
}

function searchFixture(): SearchObservation {
  // Fixed identities from the required view/doc, independent of search output.
  return { tools: { query: SEARCH_QUERY, hits: [{ tool: 'coord:roster', description: 'Use view=audit.' }] },
    docs: { hits: [{ slug: AUDIT_DOC, url: `/internal/docs/${AUDIT_DOC}` }], legs: { degraded: false } } };
}

describe('R-8 live discovery detector controls', () => {
  it('accepts the intended view and document identities in the top three', () => {
    expect(searchViolations(searchFixture())).toEqual([]);
  });
  it.each(['tools', 'docs'] as const)('rejects omission or rank four on %s independently', surface => {
    const omitted = searchFixture();
    omitted[surface].hits = [];
    expect(searchViolations(omitted)).toContain(surface === 'tools'
      ? 'tools:find:missing-top-three' : 'docs:search:missing-top-three');
    const rankFour = searchFixture();
    if (surface === 'tools') rankFour.tools.hits.unshift(...Array.from({ length: 3 }, () => ({ tool: 'other', description: '' })));
    else rankFour.docs.hits.unshift(...Array.from({ length: 3 }, () => ({ slug: 'other', url: '/other' })));
    expect(searchViolations(rankFour)).toContain(surface === 'tools'
      ? 'tools:find:missing-top-three' : 'docs:search:missing-top-three');
  });
  it('rejects lookalike identities, a wrong query and unavailable measurements', () => {
    const lookalike = searchFixture();
    lookalike.tools.hits[0]!.tool = 'audit:list';
    lookalike.docs.hits[0]!.slug = 'other';
    expect(searchViolations(lookalike)).toEqual(['tools:find:missing-top-three', 'docs:search:missing-top-three']);
    const wrongQuery = searchFixture();
    wrongQuery.tools.query = 'another query';
    expect(searchViolations(wrongQuery)).toContain('wrong-query');
    expect(searchViolations(null)).toEqual(['live-search-unavailable']);
    const degraded = searchFixture();
    degraded.docs.legs.degraded = true;
    expect(searchViolations(degraded)).toEqual(['docs:search:unavailable-ranking']);
  });
});

const SEARCH_LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_SEARCH_LIVE === '1';
const SEARCH_TEST_LAYER = inject('papercuspTestLayer');
// A measured e2e run must execute the searches. Missing opt-in/configuration
// fails that run; a unit-only controls run cannot supply healthy live evidence.
describe.skipIf(!SEARCH_LIVE_REQUESTED && SEARCH_TEST_LAYER !== 'e2e')('LIVE: R-8 parked agent audit discovery', () => {
  it('finds the intended view and how-to in each live search top three', async () => {
    expect(SEARCH_LIVE_REQUESTED, 'R-8 requires an actual live measurement').toBe(true);
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(AUDIT_LIVE_PROFILE);
    expect(process.env.PAPERCUSP_SID, 'retain the authenticated session principal').toBeTruthy();
    expect(process.env.PAPERCUSP_WORKSPACE, 'retain the workspace scope').toBeTruthy();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const toolEnv = { ...process.env };
    delete toolEnv.PAPERCUSP_SCRATCH_ROOT;
    const call = async (tool: string, args: object) => {
      const result = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
        tool, '--port', '3170', '--client', process.env.PAPERCUSP_SID!,
        '--workspace', process.env.PAPERCUSP_WORKSPACE!, JSON.stringify(args)],
      { env: toolEnv, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    };
    const tools = await call('tools:find', { query: SEARCH_QUERY,
      projection: { pick: ['query', 'hits[].tool', 'hits[].description'] } });
    const docs = await call('docs:search', { query: SEARCH_QUERY, harness: 'engineering', limit: 3,
      projection: { pick: ['hits[].slug', 'hits[].url', 'legs.degraded'] } });
    const errors = searchViolations({ tools, docs });
    process.stdout.write(`PARKED_AUDIT_R8 ${JSON.stringify({ query: SEARCH_QUERY, route: 'http://127.0.0.1:3170',
      toolRank: tools.hits?.findIndex((hit: { tool: string }) => hit.tool === 'coord:roster') + 1,
      docRank: docs.hits?.findIndex((hit: { slug: string }) => hit.slug === AUDIT_DOC) + 1, errors })}\n`);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe('dynamic roster audit regression oracles', () => {
  it('retains the independently captured full record stream and owner provenance across every page', () => {
    const time = '2026-10-18T00:00:00Z';
    const scope = { workspaceId: 'dynamic-test', scope: 'workspace' as const, potId: null, owner: null };
    // Capture the source oracle before constructing or paging the snapshot. The
    // expected stream must not come from snapshot.records or the page builder.
    const source: AuditRecord[] = [
      { id: 'agent:a', ownerId: 'a', kind: 'agent', fields: {
        wait: auditKnown({ kind: 'listener', event: 'coord:inbox-wake:a' }, 'presence.awaitingEventKey', time),
        registeredAuto: auditKnown(false, 'agent_modes registry', time),
        wakeMode: auditKnown('auto', 'presence wake configuration (not registered authority)', time),
      } },
      { id: 'work:a:one', ownerId: 'a', kind: 'work', fields: {
        next: auditUnknown('carry_notes.latestUpdate.next', time, 'Checkpoint subject is stale.'),
        blockers: auditUnknown('work_items', time, 'No live clearance measured.'),
        executable: auditUnknown('work_items + checkpoint', time, 'Preserve owner and dependency gates.'),
      } },
      { id: 'work:a:two', ownerId: 'a', kind: 'work', fields: {
        blocker: auditKnown({ ref: 'owner-hold', kind: 'owner' }, 'work_items.payload.externalBlockers', time),
        clearance: auditUnknown('live blocker producer', time, 'Recorded hold remains in force.'),
      } },
      { id: 'agent:b', ownerId: 'b', kind: 'agent', fields: { state: auditKnown('parked', 'presence', time) } },
    ];
    const expected = structuredClone(source);
    const provenance = { status: 'verified-owner' as const, directiveId: 1,
      sourceRef: 'session_turn:codex:captured:0', turnOrigin: 'owner-typed', quote: 'Audit the parked agents.' };
    const captured = createRosterAudit({ asOf: time, scope, population: ['a', 'b'], expectedPopulation: 2,
      records: source, provenance,
      previous: { status: 'known', auditId: null, asOf: null, total: null, corrections: [] },
    });
    // The store freezes JSON bytes; replay those bytes rather than sharing the
    // builder's mutable input references with the later source observation.
    const snapshot = JSON.parse(JSON.stringify(captured)) as typeof captured;
    source[0].fields.registeredAuto.value = true;
    source[1].fields.next = auditKnown('changed after capture', 'later checkpoint', time);
    const observed: AuditRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageRosterAudit(snapshot, scope, { pageSize: 1, cursor });
      expect(page.auditId).toBe(snapshot.auditId);
      expect(page.asOf).toBe(time);
      expect(page.provenance).toEqual(provenance);
      expect(page.projection.offset).toBe(observed.length);
      observed.push(...page.records);
      cursor = page.nextCursor ?? undefined;
      expect(page.coverage.truncatedByLimit).toBe(Boolean(cursor));
      if (!cursor) expect(page.coverage).toMatchObject({ total: 2, covered: 2, recordsRead: 4,
        totalRecords: 4, complete: true, missing: 0, duplicates: 0 });
    } while (cursor);
    expect(observed).toEqual(expected);
    expect(new Set(observed.map(row => row.id)).size).toBe(expected.length);
  });
  it('refuses missing and duplicate owner evidence instead of certifying declared coverage', () => {
    const time = '2026-10-18T00:00:00Z';
    const scope = { workspaceId: 'dynamic-test', scope: 'workspace' as const, potId: null, owner: null };
    const a: AuditRecord = { id: 'agent:a', ownerId: 'a', kind: 'agent', fields: { state: auditKnown('parked', 'presence', time) } };
    const input = { asOf: time, scope, population: ['a', 'b'], expectedPopulation: 2, records: [a],
      provenance: { status: 'unknown' as const, directiveId: null, sourceRef: null, turnOrigin: null, quote: null, reason: 'fixture' },
      previous: { status: 'known' as const, auditId: null, asOf: null, total: null, corrections: [] },
    };
    expect(() => createRosterAudit(input)).toThrowError(expect.objectContaining({ code: 'agent_coverage_invalid' }));
    expect(() => createRosterAudit({ ...input, records: [a, { ...a, id: 'agent:a:duplicate' }] }))
      .toThrowError(expect.objectContaining({ code: 'agent_coverage_invalid' }));
    expect(() => createRosterAudit({ ...input, population: ['a'], expectedPopulation: undefined as unknown as number }))
      .toThrowError(expect.objectContaining({ code: 'writer_count_invalid' }));
  });
  it('assembles exact multi-page owner coverage without changing the frozen historical census', () => {
    const time = '2026-10-18T00:00:00Z';
    const scope = { workspaceId: 'dynamic-test', scope: 'workspace' as const, potId: null, owner: null };
    const owners = Array.from({ length: 131 }, (_, i) => 'dynamic-owner-' + i);
    const snapshot = createRosterAudit({ asOf: time, scope, population: owners, expectedPopulation: 131,
      records: owners.map(ownerId => ({ id: 'agent:' + ownerId, ownerId, kind: 'agent' as const, fields: { state: auditKnown('parked', 'oracle fixture', time) } })),
      provenance: { status: 'unknown', directiveId: null, sourceRef: null, turnOrigin: null, quote: null, reason: 'fixture' },
      previous: { status: 'known', auditId: null, asOf: null, total: null, corrections: [] },
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = pageRosterAudit(snapshot, scope, { pageSize: 10, cursor });
      seen.push(...page.records.filter(row => row.kind === 'agent').map(row => row.ownerId));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) expect(page.coverage).toMatchObject({ total: 131, covered: 131, missing: 0, duplicates: 0, complete: true });
    } while (cursor);
    expect(seen).toEqual(owners);
    expect(new Set(seen).size).toBe(131);
  });
  it('never treats enqueue or an unrelated response as recipient pickup', () => {
    const evidence = auditWakeEvidence({ ownerId: 'owner-a', msgId: 'request-a', observedAt: '2026-10-18T00:00:00Z', messageExists: true,
      deliveries: [{ ownerId: 'owner-a', msgId: 'request-a', status: 'delivered', turnProof: 'not-picked-up', turnStartedAt: null }],
      replies: [{ from: 'different-owner', relatedMsgId: 'request-a' }],
    });
    expect(evidence.queued.status).toBe('known');
    expect(evidence.delivered.status).toBe('known');
    expect(evidence.turnStarted.status).toBe('unknown');
    expect(evidence.replied.status).toBe('unknown');
  });
});

interface Census {
  asOf: string;
  startCount: number;
  records: Array<{ presence: { ownerId: string; sessionState: string } }>;
}
interface Dispositions {
  asOf: string;
  population: number;
  decisions: Array<{
    ownerId: string;
    decision: string;
    reason: string;
    evidence: string[];
    reviewed: boolean;
  }>;
}
interface Review {
  asOf: string;
  population: number;
  rows: Array<{
    ownerId: string;
    work: Array<{
      id: string;
      next: { status: string };
      blockers: { status: string };
      left: { status: string };
    }>;
  }>;
}

interface WakeAudit {
  observedAt: string;
  targets: number;
  requestCount: number;
  rows: Array<{
    ownerId: string;
    requests: Array<{
      ownerId: string;
      msgId: string;
      at: string;
      receipt?: { pickupConfirmed?: boolean };
    }>;
    deliveries: Array<{
      id: string | null;
      owner_id: string;
      msg_id: string;
      first_agent_call: string | null;
    }>;
    outcome: string;
  }>;
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
}

/** Independent set oracle; the declared counts are checked against the actual rows. */
export function auditPopulationViolations(census: Census, dispositions: Dispositions, review: Review): string[] {
  const errors: string[] = [];
  const owners = census.records.map((row) => row.presence.ownerId);
  const population = new Set(owners);
  if (!owners.length) errors.push('empty-population');
  if (owners.length !== census.startCount) errors.push('census-count-mismatch');
  if (duplicates(owners).length) errors.push('duplicate-census-owner');
  if (census.records.some((row) => !row.presence.ownerId || row.presence.sessionState !== 'parked')) {
    errors.push('invalid-start-population');
  }
  for (const [name, rows, count, asOf] of [
    ['dispositions', dispositions.decisions, dispositions.population, dispositions.asOf],
    ['review', review.rows, review.population, review.asOf],
  ] as const) {
    const ids = rows.map((row) => row.ownerId);
    if (asOf !== census.asOf) errors.push(`${name}:snapshot-mismatch`);
    if (count !== census.startCount || ids.length !== count) errors.push(`${name}:count-mismatch`);
    if (duplicates(ids).length) errors.push(`${name}:duplicate-owner`);
    for (const id of population) if (!ids.includes(id)) errors.push(`${name}:missing:${id}`);
    for (const id of ids) if (!population.has(id)) errors.push(`${name}:foreign:${id}`);
  }
  for (const row of dispositions.decisions) {
    if (!row.reviewed || !row.decision?.trim() || !row.reason?.trim() || !row.evidence?.length) {
      errors.push(`dispositions:unexplained:${row.ownerId}`);
    }
  }
  for (const row of review.rows) {
    for (const work of row.work) {
      for (const field of ['next', 'blockers', 'left'] as const) {
        if (!['known', 'unknown'].includes(work[field]?.status)) {
          errors.push(`review:unlabelled:${row.ownerId}:${work.id}:${field}`);
        }
      }
    }
  }
  return errors.sort();
}

/** R-2 records request outcomes; activity after a request does not establish causation. */
export function auditWakeOutcomeViolations(dispositions: Dispositions, audit: WakeAudit, nonWakingMessageIds: string[] = []): string[] {
  const errors: string[] = [];
  const candidates = dispositions.decisions.filter((row) => row.decision === 'resume-candidate').map((row) => row.ownerId);
  const owners = audit.rows.map((row) => row.ownerId);
  if (!candidates.length) errors.push('empty-resume-population');
  if (duplicates(candidates).length) errors.push('duplicate-resume-candidate');
  if (duplicates(owners).length) errors.push('duplicate-wake-owner');
  if (audit.targets !== candidates.length || owners.length !== candidates.length) errors.push('wake-count-mismatch');
  for (const owner of candidates) if (!owners.includes(owner)) errors.push(`missing-wake-outcome:${owner}`);
  for (const owner of owners) if (!candidates.includes(owner)) errors.push(`foreign-wake-owner:${owner}`);
  const requests = audit.rows.flatMap((row) => row.requests);
  if (requests.length !== audit.requestCount) errors.push('request-count-mismatch');
  if (duplicates(requests.map((row) => row.msgId)).length) errors.push('duplicate-request-id');
  if (duplicates(audit.rows.flatMap((row) => row.deliveries.flatMap((delivery) => delivery.id ? [delivery.id] : []))).length) {
    errors.push('duplicate-delivery-id');
  }
  for (const row of audit.rows) {
    if (!row.requests.some((request) => request.receipt)) errors.push(`missing-request:${row.ownerId}`);
    for (const request of row.requests) {
      if (request.ownerId !== row.ownerId || !request.msgId || !Number.isFinite(Date.parse(request.at))) {
        errors.push(`invalid-request:${row.ownerId}`);
      }
      if (request.receipt?.pickupConfirmed === true) errors.push(`enqueue-claims-pickup:${row.ownerId}`);
      if (!request.receipt) {
        if (!nonWakingMessageIds.includes(request.msgId)) errors.push(`unverified-nonwake:${row.ownerId}:${request.msgId}`);
        continue;
      }
      if (nonWakingMessageIds.includes(request.msgId)) errors.push(`wake-labelled-nonwake:${row.ownerId}:${request.msgId}`);
      if (!row.deliveries.some((delivery) => delivery.id && delivery.owner_id === row.ownerId && delivery.msg_id === request.msgId)) {
        errors.push(`missing-delivery:${row.ownerId}:${request.msgId}`);
      }
    }
    for (const delivery of row.deliveries) {
      if (delivery.owner_id !== row.ownerId || !row.requests.some((request) => request.msgId === delivery.msg_id)) {
        errors.push(`foreign-delivery:${row.ownerId}`);
      }
      if (!delivery.id && (!nonWakingMessageIds.includes(delivery.msg_id) || delivery.first_agent_call !== null)) {
        errors.push(`unverified-null-delivery:${row.ownerId}:${delivery.msg_id}`);
      }
    }
    const activityObserved = row.deliveries.some((delivery) => {
      const request = row.requests.find((request) => request.msgId === delivery.msg_id);
      const callAt = delivery.first_agent_call ? Date.parse(delivery.first_agent_call) : NaN;
      const requestAt = request ? Date.parse(request.at) : NaN;
      return Boolean(delivery.id && request?.receipt) && Number.isFinite(callAt) && callAt >= requestAt && callAt <= requestAt + 600_000;
    });
    const expected = activityObserved ? 'turn-observed-after-wake' : 'delivery-recorded-pickup-unconfirmed';
    if (row.outcome !== expected) errors.push(`unsupported-outcome:${row.ownerId}`);
  }
  return errors.sort();
}

const AS_OF = '2026-10-10T01:09:46.552Z';
function fixture(): [Census, Dispositions, Review] {
  return [
    { asOf: AS_OF, startCount: 2, records: ['a', 'b'].map((ownerId) => ({ presence: { ownerId, sessionState: 'parked' } })) },
    { asOf: AS_OF, population: 2, decisions: ['a', 'b'].map((ownerId) => ({ ownerId, decision: 'justified-scoped-wait', reason: 'Named dependency', evidence: ['census.json', 'review-data.json'], reviewed: true })) },
    { asOf: AS_OF, population: 2, rows: ['a', 'b'].map((ownerId) => ({ ownerId, work: [{ id: 'WI-1', next: { status: 'unknown' }, blockers: { status: 'known' }, left: { status: 'unknown' } }] })) },
  ];
}

describe('parked audit population oracle controls', () => {
  it('accepts an exact evidence-backed partition with explicit unknowns', () => {
    expect(auditPopulationViolations(...fixture())).toEqual([]);
  });
  it('rejects a missing disposition even when its declared count is unchanged', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions.pop();
    expect(auditPopulationViolations(census, dispositions, review)).toContain('dispositions:missing:b');
  });
  it('rejects duplicate rows that preserve the declared count but omit an agent', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions[1] = { ...dispositions.decisions[0] };
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('dispositions:duplicate-owner');
    expect(errors).toContain('dispositions:missing:b');
  });
  it('rejects a foreign agent and a mismatched observation window', () => {
    const [census, dispositions, review] = fixture();
    review.rows[1].ownerId = 'foreign';
    dispositions.asOf = '2026-10-11T01:09:46.552Z';
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('review:foreign:foreign');
    expect(errors).toContain('dispositions:snapshot-mismatch');
  });
  it('rejects an unexplained decision and an unlabelled unknown', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions[0].reason = '';
    review.rows[0].work[0].next.status = '';
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('dispositions:unexplained:a');
    expect(errors).toContain('review:unlabelled:a:WI-1:next');
  });
  it('rejects an empty population instead of passing vacuously', () => {
    const [census, dispositions, review] = fixture();
    census.records = [];
    census.startCount = 0;
    expect(auditPopulationViolations(census, dispositions, review)).toContain('empty-population');
  });
});

function wakeFixture(): [Dispositions, WakeAudit] {
  const [, dispositions] = fixture();
  dispositions.decisions[0].decision = 'resume-candidate';
  return [dispositions, {
    observedAt: AS_OF,
    targets: 1,
    requestCount: 1,
    rows: [{
      ownerId: 'a',
      requests: [{ ownerId: 'a', msgId: 'msg-a', at: AS_OF, receipt: { pickupConfirmed: false } }],
      deliveries: [{ id: 'delivery-a', owner_id: 'a', msg_id: 'msg-a', first_agent_call: null }],
      outcome: 'delivery-recorded-pickup-unconfirmed',
    }],
  }];
}

describe('conditional wake outcome oracle controls', () => {
  it('accepts a retained delivery with explicitly unconfirmed pickup', () => {
    expect(auditWakeOutcomeViolations(...wakeFixture())).toEqual([]);
  });
  it('rejects an omitted candidate even if the outcome table changes its declared count', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows = [];
    audit.targets = 0;
    audit.requestCount = 0;
    expect(auditWakeOutcomeViolations(dispositions, audit)).toContain('missing-wake-outcome:a');
  });
  it('rejects waking a justified wait in place of the actual resume candidate', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows[0].ownerId = 'b';
    expect(auditWakeOutcomeViolations(dispositions, audit)).toContain('foreign-wake-owner:b');
  });
  it('rejects a retained receipt joined to the wrong message', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows[0].deliveries[0].msg_id = 'different-message';
    const errors = auditWakeOutcomeViolations(dispositions, audit);
    expect(errors).toContain('missing-delivery:a:msg-a');
    expect(errors).toContain('foreign-delivery:a');
  });
  it('does not promote queued delivery or activity outside the observation window to pickup', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows[0].outcome = 'turn-observed-after-wake';
    audit.rows[0].deliveries[0].first_agent_call = new Date(Date.parse(AS_OF) + 600_001).toISOString();
    expect(auditWakeOutcomeViolations(dispositions, audit)).toContain('unsupported-outcome:a');
    audit.rows[0].requests[0].receipt = { pickupConfirmed: true };
    expect(auditWakeOutcomeViolations(dispositions, audit)).toContain('enqueue-claims-pickup:a');
  });
  it('records activity inside the window without claiming the request caused it', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows[0].outcome = 'turn-observed-after-wake';
    audit.rows[0].deliveries[0].first_agent_call = new Date(Date.parse(AS_OF) + 1000).toISOString();
    expect(auditWakeOutcomeViolations(dispositions, audit)).toEqual([]);
  });
  it('permits an explicitly verified non-waking message part without fabricating a delivery', () => {
    const [dispositions, audit] = wakeFixture();
    audit.rows[0].requests.push({ ownerId: 'a', msgId: 'msg-part', at: AS_OF });
    audit.rows[0].deliveries.push({ id: null, owner_id: 'a', msg_id: 'msg-part', first_agent_call: null });
    audit.requestCount = 2;
    expect(auditWakeOutcomeViolations(dispositions, audit)).toContain('unverified-nonwake:a:msg-part');
    expect(auditWakeOutcomeViolations(dispositions, audit, ['msg-part'])).toEqual([]);
    audit.rows[0].requests[0].receipt = undefined;
    expect(auditWakeOutcomeViolations(dispositions, audit, ['msg-part', 'msg-a'])).toContain('missing-request:a');
  });
});

const LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_AUDIT_LIVE === '1';
allowRealPgForLiveSuite(LIVE_REQUESTED);
describe.skipIf(!LIVE_REQUESTED)('LIVE: R-1 complete parked-agent census partition', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    // Reuse the e2e reporter's runtime-vintage witness. The live subject here is
    // the canonical artifact-store PostgreSQL, rather than an API host that this
    // read-only census never calls. Refuse a mismatched route before reading it.
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(
      'packages/operator-core/test/parked-agent-audit.live-profile.json',
    );
    const adminUrl = getHarnessAdminUrl();
    const address = new URL(adminUrl);
    expect(['localhost', '127.0.0.1', '::1', '[::1]']).toContain(address.hostname);
    expect(address.port || '5432').toBe('5432');
    sql = postgres(adminUrl, { max: 1, connect_timeout: 5, idle_timeout: 5 });
    await sql`SELECT 1`;
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  it('every frozen start-population agent has exactly one disposition and explicit evidence unknowns', async () => {
    const prefix = 'audits/parked-agent-resumption-2026-10-09/';
    const paths = ['census.json', 'dispositions.json', 'review-data.json'].map((name) => prefix + name);
    const rows = await sql<Array<{ rel_path: string; content: string }>>`
      SELECT rel_path, content FROM harness_shared.harness_text_artifacts
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND rel_path IN ${sql(paths)}
    `;
    expect(rows.map((row) => row.rel_path).sort(), 'the canonical audit artifacts must all exist').toEqual([...paths].sort());
    const byPath = new Map(rows.map((row) => [row.rel_path, JSON.parse(row.content)]));
    const census = byPath.get(paths[0]) as Census;
    const dispositions = byPath.get(paths[1]) as Dispositions;
    const review = byPath.get(paths[2]) as Review;
    expect(census.asOf, 'the audit must keep its original start population').toBe(AS_OF);
    const errors = auditPopulationViolations(census, dispositions, review);
    const unknowns = review.rows.flatMap((row) => row.work.flatMap((work) =>
      ['next', 'blockers', 'left'].filter((field) => work[field as keyof Pick<typeof work, 'next' | 'blockers' | 'left'>].status === 'unknown')
        .map((field) => `${row.ownerId}:${work.id}:${field}`),
    ));
    process.stdout.write(`PARKED_AUDIT_R1 ${JSON.stringify({ asOf: census.asOf, observedAt: new Date().toISOString(), population: census.records.length, dispositions: dispositions.decisions.length, reviewRows: review.rows.length, explicitlyUnknownFields: unknowns.length, errors })}\n`);
    expect(errors).toEqual([]);
  });

  it('every frozen resume candidate has exact request/delivery joins and an honest recorded outcome', async () => {
    const prefix = 'audits/parked-agent-resumption-2026-10-09/';
    const paths = [prefix + 'dispositions.json', prefix + 'wake-outcomes-2026-10-11-verified.json', prefix + 'wakes/ce4-capacity.json'];
    const rows = await sql<Array<{ rel_path: string; content: string }>>`
      SELECT rel_path, content FROM harness_shared.harness_text_artifacts
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND rel_path IN ${sql(paths)}
    `;
    expect(rows.map((row) => row.rel_path).sort()).toEqual([...paths].sort());
    const byPath = new Map(rows.map((row) => [row.rel_path, JSON.parse(row.content)]));
    const dispositions = byPath.get(paths[0]) as Dispositions;
    const audit = byPath.get(paths[1]) as WakeAudit;
    const archive = byPath.get(paths[2]) as {
      send: {
        chunked: Array<{ parts: number; msgIds: string[]; askMsgId: string }>;
        results: Array<{ msg_id: string; wake?: unknown }>;
      };
    };
    expect(archive.send.chunked).toHaveLength(1);
    const group = archive.send.chunked[0];
    expect(group.parts).toBe(group.msgIds.length);
    expect(group.msgIds).toEqual(archive.send.results.map((result) => result.msg_id));
    expect(group.askMsgId).toBe(group.msgIds.at(-1));
    expect(archive.send.results.find((result) => result.msg_id === group.askMsgId)?.wake,
      'the final part must carry the actual wake receipt').toBeDefined();
    const nonWakingMessageIds = group.msgIds.filter((id) => id !== group.askMsgId);
    for (const id of nonWakingMessageIds) {
      expect(archive.send.results.find((result) => result.msg_id === id)?.wake).toBeUndefined();
    }
    expect(dispositions.asOf).toBe(AS_OF);
    expect(audit.targets).toBe(113);
    expect(audit.requestCount).toBe(114);
    const wakeRequests = audit.rows.flatMap((row) => row.requests).filter((request) => request.receipt).length;
    expect(wakeRequests).toBe(113);
    const errors = auditWakeOutcomeViolations(dispositions, audit, nonWakingMessageIds);
    process.stdout.write(`PARKED_AUDIT_R2 ${JSON.stringify({ observedAt: audit.observedAt, targets: audit.targets, messageParts: audit.requestCount, wakeRequests, nonWakingMessageIds, errors })}\n`);
    expect(errors).toEqual([]);
  });
});
