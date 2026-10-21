import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import {
  auditKnown,
  auditUnknown,
  auditWakeEvidence,
  createRosterAudit,
  pageRosterAudit,
  type AuditRecord,
} from './tools/roster-audit';
import {
  auditPopulationViolations,
  auditWakeOutcomeViolations,
  publicPageViolations,
  retryAuditRead,
  searchViolations,
  type Census,
  type Dispositions,
  type PageOracle,
  type Review,
  type SearchObservation,
  type WakeAudit,
} from './parked-agent-audit-controls';

const liveE2eSource = readFileSync(new URL('./parked-agent-audit.e2e.test.ts', import.meta.url), 'utf8');

describe('parked audit correct-layer controls', () => {
  it('runs synthetic controls in the unit layer and leaves live evidence in e2e', () => {
    expect(inject('papercuspTestLayer')).toBe('unit');
    for (const marker of [
      "describe('R-1 public pager detector controls'",
      "describe('R-1 public pager transport controls'",
      "describe('R-8 live discovery detector controls'",
      "describe('dynamic roster audit regression oracles'",
      "describe('parked audit population oracle controls'",
      "describe('conditional wake outcome oracle controls'",
    ]) {
      expect(liveE2eSource).not.toContain(marker);
    }
    expect(liveE2eSource).not.toContain('createRosterAudit(');
    expect(liveE2eSource).not.toContain('pageRosterAudit(');
    expect(liveE2eSource).not.toContain('auditKnown(');
    expect(liveE2eSource).not.toContain('auditUnknown(');
    expect(liveE2eSource).not.toContain('auditWakeEvidence(');
    expect(liveE2eSource).toContain("describe.skipIf(!CURRENT_LIVE_REQUESTED)('LIVE: bounded current public audit'");
    expect(liveE2eSource).toContain("describe.skipIf(!LIVE_REQUESTED)('LIVE: R-1 complete parked-agent census partition'");
  });
});

describe('R-1 public pager detector controls', () => {
  const time = '2026-10-18T00:00:00.000Z';
  const records: AuditRecord[] = ['a', 'b', 'c'].map(ownerId => ({ id: `agent:${ownerId}`, ownerId,
    kind: 'agent', fields: { state: auditKnown('parked', 'independent writer fixture', time) } }));
  const expected: PageOracle = { auditId: 'frozen', asOf: time, populationCount: 3, recordCount: 3,
    baseOffset: 0, baseCovered: 0, records };
  const page = () => ({ auditId: 'frozen', asOf: time, records: records.slice(0, 1), nextCursor: 'next',
    projection: { offset: 0 }, coverage: { total: 3, covered: 1, recordsRead: 1, totalRecords: 3,
      missing: 0, duplicates: 0, complete: false, truncatedByLimit: true } }) as ReturnType<typeof pageRosterAudit>;
  it('accepts a real page and rejects a truthful archive paired with an absent public tool', () => {
    expect(publicPageViolations(expected, page(), 0, null)).toEqual([]);
    expect(publicPageViolations(expected, null, 0, null)).toEqual(['public-page-unavailable']);
  });
  it('rejects an omitted middle page, repeated cursor, changed identity and false terminal coverage', () => {
    const omitted = page(); omitted.records = records.slice(2); omitted.projection.offset = 2;
    expect(publicPageViolations(expected, omitted, 1, 'prior')).toContain('record-stream-changed');
    const repeated = page(); repeated.nextCursor = 'prior';
    expect(publicPageViolations(expected, repeated, 0, 'prior')).toContain('cursor-did-not-progress');
    const changed = page(); changed.auditId = 'other';
    expect(publicPageViolations(expected, changed, 0, null)).toContain('snapshot-changed');
    const falseEnd = page(); falseEnd.coverage.complete = true; falseEnd.nextCursor = null;
    expect(publicPageViolations(expected, falseEnd, 0, null)).toContain('coverage-changed');
  });
});

describe('R-1 public pager transport controls', () => {
  it('retries an explicit refusal before dispatch without losing the measured result', async () => {
    let attempts = 0; const waits: number[] = [];
    expect(await retryAuditRead(async () => {
      if (++attempts < 3) throw new Error('operator rejected the request before dispatch (loop_pressure_critical) {"reason":"loop_pressure_critical"}');
      return { offset: 17, digest: 'measured' };
    }, async ms => { waits.push(ms); })).toEqual({ offset: 17, digest: 'measured' });
    expect(waits).toEqual([1000, 2000]);
  });
  it('fails immediately on a semantic error or an unknown dispatch outcome', async () => {
    for (const message of ['record-stream-changed', 'authenticated audit read exceeded 90s', 'connection lost',
      'superuser_native_session_verifier_unavailable', 'request_rejected: superuser_native_session_missing',
      'authenticated audit read exit 1: MCP_ERROR: request_rejected: superuser_native_session_mismatch']) {
      let attempts = 0;
      await expect(retryAuditRead(async () => { attempts++; throw new Error(message); }, async () => {
        throw new Error('must not retry');
      })).rejects.toThrow(message);
      expect(attempts).toBe(1);
    }
  });
  it('bounds repeated admission refusals', async () => {
    let attempts = 0;
    await expect(retryAuditRead(async () => {
      attempts++; throw new Error('operator rejected the request before dispatch (loop_pressure_critical) {"reason":"loop_pressure_critical"}');
    }, async () => {})).rejects.toThrow('loop_pressure_critical');
    expect(attempts).toBe(6);
  });
  it('re-authenticates an exact verifier refusal before dispatch and bounds persistent failure', async () => {
    const refusal = 'authenticated audit read exit 1: MCP_ERROR: {"content":[{"type":"text","text":"request_rejected: superuser_native_session_verifier_unavailable"}],"isError":true}';
    let attempts = 0;
    expect(await retryAuditRead(async () => {
      if (++attempts === 1) throw new Error(refusal);
      return { offset: 2034 };
    }, async () => {})).toEqual({ offset: 2034 });
    expect(attempts).toBe(2);
    attempts = 0;
    await expect(retryAuditRead(async () => { attempts++; throw new Error(refusal); }, async () => {}))
      .rejects.toThrow('superuser_native_session_verifier_unavailable');
    expect(attempts).toBe(6);
  });
  it('replays an interrupted frozen read only when the caller explicitly declares no writes', async () => {
    let attempts = 0;
    expect(await retryAuditRead(async () => {
      if (++attempts === 1) throw new Error('authenticated audit read exit 4: UND_ERR_SOCKET');
      return { offset: 42 };
    }, async () => {}, true)).toEqual({ offset: 42 });
    expect(attempts).toBe(2);
  });
});

function searchFixture(): SearchObservation {
  return { tools: { query: 'parked agent audit', hits: [{ tool: 'coord:roster', description: 'Use view=audit.' }] },
    docs: { hits: [{ slug: 'agent-insights/parked-agent-audit-roster-view', url: '/internal/docs/agent-insights/parked-agent-audit-roster-view' }], legs: { degraded: false } } };
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

describe('dynamic roster audit regression oracles', () => {
  it('retains the independently captured full record stream and owner provenance across every page', () => {
    const time = '2026-10-18T00:00:00Z';
    const scope = { workspaceId: 'dynamic-test', scope: 'workspace' as const, potId: null, owner: null };
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
