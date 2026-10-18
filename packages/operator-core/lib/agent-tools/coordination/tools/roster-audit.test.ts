import { describe, expect, it } from 'vitest';
import { auditKnown, auditUnknown, auditWakeEvidence, createRosterAudit, pageRosterAudit, type AuditRecord, type AuditScope } from './roster-audit';

const asOf = '2026-10-18T00:00:00.000Z';
const scope: AuditScope = { workspaceId: 'ws-a', scope: 'workspace', potId: null, owner: null };
const record = (ownerId: string, kind: AuditRecord['kind'] = 'agent', suffix = ''): AuditRecord => ({
  id: `${kind}:${ownerId}${suffix}`, ownerId, kind,
  fields: { state: auditKnown('parked', 'presence oracle', asOf) },
});
function fixture(records: AuditRecord[] = [record('a'), record('a', 'work', ':WI-1'), record('b')]) {
  return createRosterAudit({ asOf, scope, population: ['a', 'b'], expectedPopulation: 2, records,
    provenance: { status: 'unknown', directiveId: null, sourceRef: null, turnOrigin: null, quote: null, reason: 'not supplied' },
    previous: { status: 'known', auditId: null, asOf: null, total: null, corrections: [] },
  });
}

describe('complete frozen roster audit paging', () => {
  it('covers the exact population across bounded pages, retaining all work records', () => {
    const snapshot = fixture();
    const rows: AuditRecord[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const page = pageRosterAudit(snapshot, scope, { cursor, pageSize: 1 });
      expect(page.auditId).toBe(snapshot.auditId);
      expect(page.asOf).toBe(asOf);
      expect(page.records).toHaveLength(1);
      rows.push(...page.records);
      cursor = page.nextCursor ?? undefined;
      expect(page.coverage).toMatchObject({ total: 2, missing: 0, duplicates: 0, complete: n === 2 });
      if (n === 2) expect(page.coverage).toMatchObject({ covered: 2, recordsRead: 3, totalRecords: 3, truncatedByLimit: false });
    }
    expect(rows).toEqual(snapshot.records);
    expect(rows.filter(row => row.kind === 'agent').map(row => row.ownerId)).toEqual(['a', 'b']);
  });
  it('pages a single agent with many work items instead of dropping its evidence', () => {
    const records = [record('a'), ...Array.from({ length: 100 }, (_, n) => record('a', 'work', `:${n}`)), record('b')];
    const snapshot = fixture(records);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = pageRosterAudit(snapshot, scope, { cursor, pageSize: 3 });
      ids.push(...page.records.map(row => row.id));
      expect(page.records.length).toBeLessThanOrEqual(3);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(records.map(row => row.id));
  });
  it('rejects incomplete, duplicate and foreign population evidence', () => {
    const snapshot = fixture();
    expect(() => createRosterAudit({ ...snapshot, expectedPopulation: 3 })).toThrow(/population/);
    expect(() => createRosterAudit({ ...snapshot, population: ['a', 'a'] })).toThrow(/duplicated/);
    expect(() => fixture([record('a'), record('a')])).toThrow(/exactly one/);
    expect(() => fixture([record('a'), record('b'), record('foreign', 'work')])).toThrow(/foreign/);
  });
  it.each([undefined, null, '2', true, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid writer count %s at the internal typed boundary', expectedPopulation => {
      expect(() => createRosterAudit({ ...fixture(), expectedPopulation: expectedPopulation as number }))
        .toThrow(/measured non-negative safe integer/);
    },
  );
  it.each([1, 3])('refuses either direction of population mismatch (%s)', expectedPopulation => {
    expect(() => createRosterAudit({ ...fixture(), expectedPopulation })).toThrow(/population/);
  });
  it('permits distinct work records for one owner and refuses a duplicated record identity', () => {
    const records = [record('a'), record('a', 'work', ':one'), record('a', 'work', ':two'), record('b')];
    expect(fixture(records).records).toEqual(records);
    expect(() => fixture([...records, records[1]])).toThrow(/duplicate identity/);
  });
  it('refuses cross-workspace, cross-lens, malformed and foreign-snapshot cursors', () => {
    const snapshot = fixture();
    const cursor = pageRosterAudit(snapshot, scope, { pageSize: 1 }).nextCursor!;
    expect(() => pageRosterAudit(snapshot, { ...scope, workspaceId: 'ws-b' }, { cursor })).toThrow(/workspace/);
    expect(() => pageRosterAudit(snapshot, { ...scope, owner: 'a' }, { cursor })).toThrow(/workspace/);
    expect(() => pageRosterAudit(snapshot, scope, { cursor: 'garbage' })).toThrow(/exact nextCursor/);
    const other = createRosterAudit({ ...snapshot, asOf: '2026-10-19T00:00:00Z' });
    expect(() => pageRosterAudit(other, scope, { cursor })).toThrow(/different audit/);
  });
  it('represents an empty measured population as complete without fabricating a row', () => {
    const snapshot = createRosterAudit({ ...fixture(), population: [], records: [], expectedPopulation: 0 });
    expect(pageRosterAudit(snapshot, scope)).toMatchObject({ records: [], nextCursor: null, coverage: { total: 0, covered: 0, complete: true } });
  });
  it('requires labelled unknowns and captured owner provenance', () => {
    const snapshot = fixture();
    const row = record('a');
    row.fields.next = auditUnknown('checkpoint', asOf, 'stale subject fingerprint');
    expect(fixture([row, record('b')]).records[0].fields.next.status).toBe('unknown');
    delete row.fields.next.reason;
    expect(() => fixture([row, record('b')])).toThrow(/requires a reason/);
    expect(() => createRosterAudit({ ...snapshot, provenance: { status: 'verified-owner', directiveId: 1, sourceRef: 'forged', turnOrigin: 'agent-injected', quote: 'owner said' } })).toThrow(/Owner authority/);
  });
  it('retains correction lineage and provenance through serialization and later cursor pages', () => {
    const snapshot = fixture();
    snapshot.previous = { status: 'known', auditId: 'prior', asOf, total: 2,
      corrections: [{ ref: 'report:corrected', supersedes: 'report:original', summary: 'fixed listener-as-blocker finding' }] };
    const restored = JSON.parse(JSON.stringify(snapshot));
    const first = pageRosterAudit(restored, scope, { pageSize: 1 });
    const next = pageRosterAudit(restored, scope, { cursor: first.nextCursor! });
    expect(next.previous).toEqual(snapshot.previous);
    expect(next.provenance).toEqual(snapshot.provenance);
  });
});

describe('message-linked wake outcome evidence', () => {
  const input = { ownerId: 'a', msgId: 'm-1', observedAt: asOf, messageExists: true, deliveries: [], replies: [] };
  it('never upgrades queued or delivered into a started turn or authored reply', () => {
    const result = auditWakeEvidence({ ...input, deliveries: [{ ownerId: 'a', msgId: 'm-1', status: 'delivered', turnProof: 'awaiting', turnStartedAt: null }] });
    expect(result.queued.value).toBe(true);
    expect(result.delivered.value).toBe(true);
    expect(result.turnStarted.status).toBe('unknown');
    expect(result.replied.status).toBe('unknown');
  });
  it('requires the exact recipient/message proof and exact related reply', () => {
    const result = auditWakeEvidence({ ...input,
      deliveries: [{ ownerId: 'b', msgId: 'm-1', status: 'delivered', turnProof: 'observed', turnStartedAt: asOf }],
      replies: [{ from: 'a', relatedMsgId: 'other' }],
    });
    expect(result.turnStarted.status).toBe('unknown');
    expect(result.replied.status).toBe('unknown');
    const positive = auditWakeEvidence({ ...input,
      deliveries: [{ ownerId: 'a', msgId: 'm-1', status: 'delivered', turnProof: 'observed', turnStartedAt: asOf }],
      replies: [{ from: 'a', relatedMsgId: 'm-1' }],
    });
    expect(positive.turnStarted.value).toBe(true);
    expect(positive.replied.value).toBe(true);
  });
});
