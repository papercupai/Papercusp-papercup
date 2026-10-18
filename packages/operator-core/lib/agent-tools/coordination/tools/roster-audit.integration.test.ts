import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { createRosterAudit, auditKnown, pageRosterAudit, type AuditScope } from './roster-audit';
import { auditRequestProvenance, buildRosterAudit, loadRosterAudit, saveRosterAudit } from './roster-audit-store';
import { recordOwnerDirective } from '../../../owner-directives';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { publishReport } from '../../../report-library';
import { pickupDispositionViolations } from '../parked-agent-audit-oracles';

const fixture = vi.hoisted(() => ({ workspaceId: 'audit-test-ws', sql: null as unknown }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../../../workspace-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../../workspace-registry')>(), activeWorkspaceId: () => fixture.workspaceId,
}));
vi.mock('../log', () => ({ coordScopeReady: async () => {}, coordWorkspaceId: () => fixture.workspaceId }));

describe.skipIf(process.env.PAPERCUSP_PARKED_SEARCH_LIVE !== '1')('LIVE: R-5 current correction lineage', () => {
  it('compares public 2026-10-17 edition/count records with the canonical visible report bodies', () => {
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE)
      .toBe('packages/operator-core/test/parked-agent-audit.live-profile.json');
    expect(process.env.PAPERCUSP_SID).toBeTruthy();
    expect(process.env.PAPERCUSP_WORKSPACE).toBeTruthy();
    const auditId = '45250822471a901a36bec955ae89fc2f8ab107058c6b9c93864b2fa8bfd8ef12';
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const env = { ...process.env }; delete env.PAPERCUSP_SCRATCH_ROOT;
    const run = (script: string) => {
      const value = JSON.parse(execFileSync(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'), 'code:run', '--port', '3170',
        '--client', process.env.PAPERCUSP_SID!, '--workspace', process.env.PAPERCUSP_WORKSPACE!, '--harness', '*',
        JSON.stringify({ script, timeoutSec: 30, projection: { pick: ['ok', 'summary', 'summaryNotice', 'partial', 'childFailures', 'error'] } })],
      { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }));
      expect(value.ok, value.error).toBe(true); expect(value.partial).not.toBe(true);
      expect(value.childFailures ?? []).toEqual([]); expect(value.summaryNotice?.truncated).not.toBe(true);
      return value.summary;
    };
    // Each call reads one bounded public page. Report reads use the same digest
    // over exact quoted paragraphs, so neither full bodies nor the accumulated
    // lineage need to pass through a capped code:run summary.
    const digest = (value: unknown) => {
      const text = JSON.stringify(value); let hash = 2166136261;
      for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
      return `${(hash >>> 0).toString(16)}:${text.length}`;
    };
    const headers: Array<{ ref: string; supersedes: string | null; publishedAt: string; supersededBy: string[] }> = [];
    const quotes: Array<{ edition: string; part: number; quote: string }> = [];
    let cursor: string | null = null; let expectedCount: number | undefined; let done = false; let pages = 0;
    while (!done && pages < 200) {
      const page = run("const p=await tools.coord.roster({view:'audit',scope:'workspace',auditId:" + JSON.stringify(auditId)
        + ",cursor:" + (cursor === null ? 'undefined' : JSON.stringify(cursor)) + ",pageSize:1});const r=p.records[0];return {auditId:p.auditId,nextCursor:p.nextCursor,count:p.previous.correctionCount,kind:r?.kind,header:r?.fields.correction?.value,quote:r?.fields.reportedCountContext?.value};");
      expect(page.auditId).toBe(auditId); expectedCount = page.count;
      if (page.header) headers.push(page.header);
      if (page.quote) quotes.push(page.quote);
      done = page.kind !== 'history' || page.nextCursor === null;
      if (!done) expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor; pages++;
    }
    expect(done).toBe(true); expect(headers.length).toBe(expectedCount);
    expect(headers.some(h => h.ref === 'report:rpt_7a449b1b-64f6-4097-b3bd-5b5ec00d6eab')).toBe(true);
    let correctedInstanceSeen = false;
    for (const header of headers) {
      const report = run("const r=await tools.reports.get({id:" + JSON.stringify(header.ref.slice(7))
        + "});const p=r.results[0].report;if(!p?.body_md)throw Error('canonical visible report unavailable');"
        + "const quotes=p.body_md.split(/\\n\\s*\\n/).filter(p=>/\\d/.test(p)).flatMap(p=>p.match(/[\\s\\S]{1,1000}/g)??[]);"
        + "return {supersedes:p.supersedes_report_id,publishedAt:p.published_at,quoteDigest:(" + digest.toString()
        + ")(quotes),quoteCount:quotes.length,corrected:p.body_md.includes('WI-6554700010016838')};");
      expect(report.supersedes).toBe(header.supersedes); expect(report.publishedAt).toBe(header.publishedAt);
      const actual = quotes.filter(q => q.edition === header.ref).sort((a, b) => a.part - b.part);
      expect(actual.map(q => q.part)).toEqual(actual.map((_, i) => i));
      expect(actual.length).toBe(report.quoteCount); expect(digest(actual.map(q => q.quote))).toBe(report.quoteDigest);
      correctedInstanceSeen ||= report.corrected;
    }
    expect(correctedInstanceSeen).toBe(true);
    for (const header of headers) {
      expect(header.supersededBy.sort()).toEqual(headers.filter(h => h.supersedes === header.ref.slice(7)).map(h => h.ref).sort());
    }
    process.stdout.write(`PARKED_AUDIT_R5 ${JSON.stringify({ auditId, editions: headers.length, countQuoteRecords: quotes.length, pages, correctedInstanceSeen, errors: [] })}\n`);
  }, 600_000);
});

/** Independent inventory: a new output field requires an explicit detector review. */
function verifyFieldProvenance(snapshot: ReturnType<typeof createRosterAudit>) {
  const inventory: Record<string, string[]> = {
    agent: ['session', 'ownedWorkCount', 'wait', 'registeredAuto', 'wakeMode', 'independentWork', 'wakeWindow'],
    work: ['identity', 'next', 'left', 'blockers', 'executable'],
    blocker: ['blocker', 'clearance'],
    wake: ['request', 'queued', 'delivered', 'turnStarted', 'replied'],
    history: ['correction', 'edition', 'reportedCounts'],
    count: ['reportedCountContext'],
  };
  for (const [index, row] of snapshot.records.entries()) {
    const shape = row.kind === 'work' && 'blocker' in row.fields ? 'blocker'
      : row.kind === 'history' && 'reportedCountContext' in row.fields ? 'count' : row.kind;
    expect(Object.keys(row.fields).sort(), row.id).toEqual([...inventory[shape]].sort());
    for (const [name, field] of Object.entries(row.fields)) {
      expect(['known', 'unknown'], `${row.id}.${name}`).toContain(field.status);
      expect(field.source.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(field.observedAt))).toBe(true);
      for (const stamp of ['status', 'source', 'observedAt'] as const) {
        const mutant = structuredClone(snapshot);
        delete (mutant.records[index].fields[name] as unknown as Record<string, unknown>)[stamp];
        expect(() => createRosterAudit(mutant), `${row.id}.${name}.${stamp}`)
          .toThrowError(expect.objectContaining({ code: 'evidence_unlabelled' }));
      }
      if (field.status === 'unknown') {
        const mutant = structuredClone(snapshot);
        delete mutant.records[index].fields[name].reason;
        expect(() => createRosterAudit(mutant), `${row.id}.${name}.reason`)
          .toThrowError(expect.objectContaining({ code: 'unknown_unexplained' }));
      }
    }
  }
}

describe('roster frozen audit PG persistence', () => {
  let db: OrgTestDb;
  const harness = 'audit-test-' + randomUUID();
  const scope: AuditScope = { workspaceId: 'audit-test-ws', scope: 'workspace', potId: null, owner: null, readerId: 'reader-a' };
  beforeAll(async () => { db = await createOrgTestDb(); fixture.sql = db.adminSql; }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  const build = () => createRosterAudit({ asOf: '2026-10-18T00:00:00.000Z', scope, population: ['a', 'b'], expectedPopulation: 2,
    records: ['a', 'b'].map(ownerId => ({ id: 'agent:' + ownerId, ownerId, kind: 'agent' as const,
      fields: { state: auditKnown('parked', 'oracle', '2026-10-18T00:00:00.000Z') } })),
    provenance: { status: 'unknown', directiveId: null, sourceRef: null, turnOrigin: null, quote: null, reason: 'not requested' },
    previous: { status: 'known', auditId: null, asOf: null, total: null, corrections: [] },
  });
  it('persists one immutable snapshot and continues exactly after a fresh read', async () => {
    const snapshot = build();
    await saveRosterAudit(harness, snapshot);
    await saveRosterAudit(harness, snapshot);
    const page = pageRosterAudit(snapshot, scope, { pageSize: 1 });
    const restored = await loadRosterAudit(harness, snapshot.auditId, scope);
    expect(restored).toEqual(snapshot);
    const end = pageRosterAudit(restored!, scope, { cursor: page.nextCursor! });
    expect(end.records.map(row => row.ownerId)).toEqual(['b']);
    expect(end.coverage).toMatchObject({ total: 2, covered: 2, complete: true });
  });

  it('reads ten persisted dispositions and accountable follow-ups from PG', async () => {
    const expected = Array.from({ length: 10 }, (_, i) => ({ ownerId: 'owner-' + i, request: 'request-' + i }));
    for (const row of expected) {
      await db.adminSql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
        VALUES (${scope.workspaceId}, 'messages', ${row.request},
          ${db.adminSql.json({ ...row, outcome: 'pickup-unconfirmed', reply: null })},
          ${'2026-10-18T03:00:00.000Z'}::timestamptz)`;
    }
    const ids = ['WI-6554700010017003', 'WI-6554700010017004'];
    for (const id of ids) {
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by)
        VALUES (${scope.workspaceId}, ${harness}, ${id}, 'feature', 'accountable follow-up', 'wip', 'reader-a')`;
    }
    const cases = (await db.adminSql<{ body: { ownerId: string; request: string; outcome: string; reply: null } }[]>`
      SELECT body FROM harness_shared.coord_event_log WHERE workspace_id=${scope.workspaceId}
        AND surface='messages' AND msg_id = ANY(${expected.map(row => row.request)}) ORDER BY msg_id`).map(row => row.body);
    const readItems = async () => (await db.adminSql<{ feature_id: string; status: string; taken_by: string | null }[]>`
      SELECT feature_id, status, taken_by FROM harness_shared.work_items
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} AND feature_id = ANY(${ids})`)
      .map(row => ({ id: row.feature_id, state: row.status, assignee: row.taken_by, hasCompletionEvidence: false }));
    expect(pickupDispositionViolations(expected, cases, await readItems(), 'reader-a')).toEqual([]);
    const duplicate = cases.slice(); duplicate[9] = duplicate[0];
    expect(pickupDispositionViolations(expected, duplicate, await readItems(), 'reader-a')).toContain('disposition-population');
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by=NULL
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} AND feature_id=${ids[0]}`;
    expect(pickupDispositionViolations(expected, cases, await readItems(), 'reader-a'))
      .toContain('unowned-or-unverified:WI-6554700010017003');
  });
  it('resolves captured directive ledger rows after persistence without upgrading agent or unverified text', async () => {
    const text = 'Audit the parked population and retain the source owner request.';
    const capture = (suffix: string, verbatimText: string, capturedByHook: boolean) => recordOwnerDirective({
      workspaceId: scope.workspaceId, recordedBy: 'reader-a', sessionRef: `${harness}-${suffix}`,
      sourceTurnRef: `session_turn:codex:${harness}-${suffix}:0`, verbatimText, capturedByHook,
    }, db.adminSql);
    const owner = await capture('owner', text, true);
    const agent = await capture('agent', `⟦turn-origin:self-compaction nonce:test⟧\n${text}`, true);
    const unverified = await capture('unverified', text, false);
    const provenance = await auditRequestProvenance(scope.workspaceId, owner.id);
    expect(provenance).toMatchObject({ status: 'verified-owner', directiveId: owner.id,
      sourceRef: owner.sourceTurnRef, turnOrigin: 'owner-typed', quote: text });
    const snapshot = createRosterAudit({ ...build(), provenance });
    await saveRosterAudit(harness, snapshot);
    const restored = await loadRosterAudit(harness, snapshot.auditId, scope);
    expect(restored?.provenance).toEqual(provenance);
    expect(await auditRequestProvenance(scope.workspaceId, owner.id)).toEqual(provenance);
    expect(await auditRequestProvenance(scope.workspaceId, agent.id)).toMatchObject({ status: 'unverified' });
    expect(await auditRequestProvenance(scope.workspaceId, unverified.id)).toMatchObject({ status: 'unverified' });
    expect(await auditRequestProvenance(scope.workspaceId, Number.MAX_SAFE_INTEGER)).toMatchObject({ status: 'unknown' });
  });
  it('refuses another reader or workspace, including with the exact known audit id', async () => {
    const snapshot = build();
    await saveRosterAudit(harness, snapshot);
    await expect(loadRosterAudit(harness, snapshot.auditId, { ...scope, readerId: 'reader-b' })).rejects.toThrow(/content|scope/);
    await expect(loadRosterAudit(harness, snapshot.auditId, { ...scope, workspaceId: 'other-workspace' })).rejects.toThrow(/workspace/);
  });
  it('does not recapture an absent snapshot or accept modified stored evidence', async () => {
    expect(await loadRosterAudit(harness, 'f'.repeat(64), scope)).toBeNull();
    const snapshot = createRosterAudit({ ...build(), asOf: '2026-10-19T00:00:00.000Z' });
    await saveRosterAudit(harness, snapshot);
    await db.adminSql`UPDATE harness_shared.harness_text_artifacts SET content = ${JSON.stringify({ ...snapshot, population: ['a', 'a'] })}
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${harness} AND rel_path LIKE ${'%' + snapshot.auditId + '.json'}`;
    await expect(loadRosterAudit(harness, snapshot.auditId, scope)).rejects.toThrow(/content|population/);
  });

  it('keeps every frozen record unchanged when source evidence changes between pages', async () => {
    const sourceRecords = [
      ...build().records,
      { id: 'work:a:one', ownerId: 'a', kind: 'work' as const, fields: { next: auditKnown('original next step', 'fixture checkpoint', '2026-10-20T00:00:00.000Z') } },
      { id: 'work:a:two', ownerId: 'a', kind: 'work' as const, fields: { next: auditKnown('second next step', 'fixture checkpoint', '2026-10-20T00:00:00.000Z') } },
    ];
    const expected = JSON.parse(JSON.stringify(sourceRecords));
    const original = createRosterAudit({ ...build(), asOf: '2026-10-20T00:00:00.000Z', records: sourceRecords });
    await saveRosterAudit(harness, original);
    const first = pageRosterAudit(original, scope, { pageSize: 1 });
    original.records[2].fields.next.value = 'changed live source';
    const newer = createRosterAudit({ ...original, asOf: '2026-10-20T01:00:00.000Z' });
    await saveRosterAudit(harness, newer);
    const restored = (await loadRosterAudit(harness, first.auditId, scope))!;
    const actual = [...first.records];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = pageRosterAudit(restored, scope, { cursor, pageSize: 1 });
      expect([page.auditId, page.asOf]).toEqual([first.auditId, first.asOf]);
      actual.push(...page.records);
      cursor = page.nextCursor;
    }
    expect(actual).toEqual(expected);
    expect(() => pageRosterAudit(newer, scope, { cursor: first.nextCursor! }))
      .toThrowError(expect.objectContaining({ code: 'cursor_scope_mismatch' }));
  });

  it('preserves all stored artifacts and an existing valid snapshot on every invalid save', async () => {
    const original = createRosterAudit({ ...build(), asOf: '2026-10-21T00:00:00.000Z' });
    await saveRosterAudit(harness, original);
    const artifacts = () => db.adminSql<{ rel_path: string; content: string }[]>`SELECT rel_path, content
      FROM harness_shared.harness_text_artifacts WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} ORDER BY rel_path`;
    const before = await artifacts();
    const invalid: Array<{ snapshot: unknown; code: string }> = [
      ...[undefined, null, '2', true, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
        .map(expectedPopulation => ({ snapshot: { ...original, expectedPopulation }, code: 'writer_count_invalid' })),
      ...[1, 3].map(expectedPopulation => ({ snapshot: { ...original, expectedPopulation }, code: 'population_incomplete' })),
      { snapshot: { ...original, population: [], records: [], expectedPopulation: 1 }, code: 'population_incomplete' },
      { snapshot: { ...original, population: ['a', 'a'] }, code: 'population_duplicate' },
      { snapshot: { ...original, records: [...original.records, original.records[0]] }, code: 'agent_coverage_invalid' },
      { snapshot: { ...original, records: [...original.records, { ...original.records[0], kind: 'work' }] }, code: 'record_identity_invalid' },
      { snapshot: { ...original, auditId: 'f'.repeat(64) }, code: 'audit_identity_invalid' },
    ];
    for (const { snapshot, code } of invalid) {
      await expect(saveRosterAudit(harness, snapshot as typeof original)).rejects.toMatchObject({ code });
      expect(await artifacts()).toEqual(before);
      expect(await loadRosterAudit(harness, original.auditId, scope)).toEqual(original);
    }
  });

  it('persists the captured count while refusing a mismatch even after the live count converges', async () => {
    const live = { count: 2 };
    const captured = { ...build(), asOf: '2026-10-22T00:00:00.000Z', expectedPopulation: live.count };
    const snapshot = createRosterAudit(captured);
    live.count = 3;
    await saveRosterAudit(harness, snapshot);
    expect((await loadRosterAudit(harness, snapshot.auditId, scope))?.expectedPopulation).toBe(2);
    const mismatched = { ...build(), asOf: '2026-10-22T01:00:00.000Z', expectedPopulation: live.count };
    live.count = 2;
    const before = await db.adminSql`SELECT rel_path, content FROM harness_shared.harness_text_artifacts
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} ORDER BY rel_path`;
    await expect(saveRosterAudit(harness, mismatched)).rejects.toMatchObject({ code: 'population_incomplete' });
    expect(await db.adminSql`SELECT rel_path, content FROM harness_shared.harness_text_artifacts
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} ORDER BY rel_path`).toEqual(before);
  });

  it('assembles measured modes, no-work owners and exact message pickup from PG', async () => {
    const asOf = '2026-10-18T01:00:00.000Z';
    await db.adminSql`INSERT INTO harness_shared.agent_modes (workspace_id, owner_id, axis_key, mode, set_by)
      VALUES (${scope.workspaceId}, 'audit-agent-a', 'autonomy', 'auto', 'audit-agent-a')`;
    await db.adminSql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${scope.workspaceId}, 'messages', 'audit-request', ${db.adminSql.json({ from: 'requester', to: ['audit-agent-a'], wake: 'required' })}, ${asOf}::timestamptz),
      (${scope.workspaceId}, 'messages', 'audit-reply', ${db.adminSql.json({ from: 'audit-agent-a', to: ['requester'], related_msg_id: 'audit-request' })}, ${asOf}::timestamptz)`;
    await db.adminSql`INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, payload, status, turn_proof, turn_started_at, created_at)
      VALUES (${DEFAULT_COORD_WORKSPACE}, 1, 'audit-agent-a', 'coord:inbox-wake:audit-agent-a',
        ${db.adminSql.json({ msg_id: 'audit-request' })}, 'delivered', 'observed', ${asOf}::timestamptz, ${asOf}::timestamptz)`;
    const snapshot = await buildRosterAudit({ harness, scope, asOf, expectedPopulation: 2, viewer: { ownerId: 'reader-a' }, agents: [
      { ownerId: 'audit-agent-a', sessionState: 'parked', awaitingEventKey: 'coord:inbox-wake:audit-agent-a' },
      { ownerId: 'audit-agent-b', sessionState: 'parked', awaitingEventKey: 'work-item:done:WI-DEP', wakeMode: 'auto' },
    ] });
    const a = snapshot.records.find(row => row.id === 'agent:audit-agent-a')!;
    const b = snapshot.records.find(row => row.id === 'agent:audit-agent-b')!;
    expect(a.fields.ownedWorkCount).toMatchObject({ status: 'known', value: 0 });
    expect(a.fields.registeredAuto).toMatchObject({ status: 'known', value: true });
    expect(a.fields.wait.value).toMatchObject({ kind: 'listener' });
    expect(b.fields.registeredAuto).toMatchObject({ status: 'known', value: false });
    expect(b.fields.wait.value).toMatchObject({ kind: 'substantive' });
    const wake = snapshot.records.find(row => row.id === 'wake:audit-agent-a:audit-request')!;
    for (const field of ['queued', 'delivered', 'turnStarted', 'replied']) expect(wake.fields[field]).toMatchObject({ status: 'known', value: true });
    verifyFieldProvenance(snapshot);
    expect(snapshot.population).toEqual(['audit-agent-a', 'audit-agent-b']);
    await saveRosterAudit(harness, snapshot);
    expect(await loadRosterAudit(harness, snapshot.auditId, scope)).toEqual(snapshot);
  });

  it('does not promote PG queue or delivery rows into recipient pickup', async () => {
    const asOf = '2026-10-18T04:00:00.000Z';
    const owner = 'audit-stages';
    for (const msgId of ['stages-queued', 'stages-delivered']) {
      await db.adminSql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
        VALUES (${scope.workspaceId}, 'messages', ${msgId},
          ${db.adminSql.json({ from: 'requester', to: [owner], wake: 'required' })}, ${asOf}::timestamptz)`;
    }
    await db.adminSql`INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, payload, status, turn_proof, turn_started_at, created_at)
      VALUES (${DEFAULT_COORD_WORKSPACE}, 2, ${owner}, ${'coord:inbox-wake:' + owner},
        ${db.adminSql.json({ msg_id: 'stages-delivered' })}, 'delivered', 'awaiting', NULL, ${asOf}::timestamptz)`;
    const snapshot = await buildRosterAudit({ harness, scope, asOf, expectedPopulation: 1,
      viewer: { ownerId: 'reader-a' }, agents: [{ ownerId: owner, sessionState: 'parked' }] });
    const queued = snapshot.records.find(row => row.id === 'wake:' + owner + ':stages-queued')!;
    const delivered = snapshot.records.find(row => row.id === 'wake:' + owner + ':stages-delivered')!;
    expect(queued.fields.queued).toMatchObject({ status: 'known', value: true });
    expect(queued.fields.delivered.status).toBe('unknown');
    expect(delivered.fields.delivered).toMatchObject({ status: 'known', value: true });
    for (const row of [queued, delivered]) {
      expect(row.fields.turnStarted.status).toBe('unknown');
      expect(row.fields.replied.status).toBe('unknown');
    }
  });

  it('retains harness-qualified feature claims with unknown missing checkpoints', async () => {
    const asOf = '2026-10-18T02:00:00.000Z';
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by)
      VALUES (${scope.workspaceId}, ${harness}, 'F-1', 'feature', 'First harness', 'wip', 'audit-agent-work'),
        (${scope.workspaceId}, ${harness + '-second'}, 'F-2', 'feature', 'Second harness', 'wip', 'audit-agent-work')`;
    await db.adminSql`UPDATE harness_shared.work_items SET payload = ${db.adminSql.json({ externalBlockers: [{
      kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit', ref: 'fixture-runtime',
      summary: 'Fixture runtime remains unavailable', status: 'active', createdAt: asOf,
      updatedAt: asOf, createdBy: 'fixture',
    }] })} WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} AND feature_id='F-1'`;
    const snapshot = await buildRosterAudit({ harness, scope, asOf, expectedPopulation: 1,
      viewer: { ownerId: 'reader-a' }, agents: [{ ownerId: 'audit-agent-work', sessionState: 'parked', awaitingEvent: false }] });
    const work = snapshot.records.filter(row => row.kind === 'work' && 'identity' in row.fields);
    expect(work).toHaveLength(2);
    expect(work.map(row => (row.fields.identity.value as { harness: string }).harness).sort()).toEqual([harness, harness + '-second'].sort());
    expect(work.map(row => row.fields.next.status)).toEqual(['unknown', 'unknown']);
    expect(snapshot.records.some(row => row.kind === 'work' && 'clearance' in row.fields)).toBe(true);
    verifyFieldProvenance(snapshot);
  });

  it('retains each visible report edition count and correction link through frozen paging', async () => {
    const origin = { authorOwnerId: 'reader-a', harnessSlug: harness };
    const prior = await publishReport(db.adminSql, { workspaceId: scope.workspaceId, kind: 'audit', visibility: 'owner',
      title: 'Parked agent audit original', bodyMd: 'The census contained **2 parked agents**.\n\n1 recipient replied; 1 pickup remained unconfirmed.' }, origin);
    const corrected = await publishReport(db.adminSql, { workspaceId: scope.workspaceId, kind: 'audit', visibility: 'owner',
      title: 'Parked agent audit corrected', supersedes: prior.reportId,
      bodyMd: 'Correction: **3 parked agents**, not 2.\n\n2 recipients replied; 1 pickup remained unconfirmed.' }, origin);
    const hidden = await publishReport(db.adminSql, { workspaceId: scope.workspaceId, kind: 'audit', visibility: 'owner',
      title: 'Parked agent audit hidden', bodyMd: '999 private parked agents.' }, { authorOwnerId: 'other-reader' });
    const snapshot = await buildRosterAudit({ harness, scope, asOf: new Date().toISOString(), expectedPopulation: 0,
      viewer: { ownerId: 'reader-a' }, agents: [] });
    await saveRosterAudit(harness, snapshot);
    const frozen = (await loadRosterAudit(harness, snapshot.auditId, scope))!;
    const records: typeof frozen.records = [];
    let cursor: string | undefined;
    do {
      const page = pageRosterAudit(frozen, scope, { cursor, pageSize: 1 });
      records.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const original = records.find(row => row.id === 'history:report:' + prior.reportId)!;
    expect(original.fields.correction.value).toMatchObject({ supersededBy: ['report:' + corrected.reportId] });
    expect(original.fields.edition.value).toBe('superseded');
    const latest = records.find(row => row.id === 'history:report:' + corrected.reportId)!;
    expect(latest.fields.correction.value).toMatchObject({ supersedes: prior.reportId });
    expect(latest.fields.edition.value).toBe('latest-visible');
    const countQuotes = (reportId: string) => records.filter(row => row.id.startsWith('history:report:' + reportId + ':counts:'))
      .map(row => (row.fields.reportedCountContext.value as { quote: string }).quote);
    expect(countQuotes(prior.reportId)).toEqual(prior.bodyMd.split('\n\n'));
    expect(countQuotes(corrected.reportId)).toEqual(corrected.bodyMd.split('\n\n'));
    expect(records.some(row => row.id.includes(hidden.reportId))).toBe(false);
    expect(frozen.expectedPopulation).toBe(0);
    verifyFieldProvenance(frozen);
  });
});
