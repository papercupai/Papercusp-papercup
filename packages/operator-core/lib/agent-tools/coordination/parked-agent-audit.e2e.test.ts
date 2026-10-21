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
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';
import type { RosterAuditSnapshot } from './tools/roster-audit';
import { originalUnconfirmedPairs, parkedAuditOperatorRoute, parkedAuditToolFailure, pickupDispositionViolations, type PickupDisposition } from './parked-agent-audit-oracles';
import {
  auditPopulationViolations,
  auditWakeOutcomeViolations,
  retryAuditRead,
  searchViolations,
  type Census,
  type Dispositions,
  type Review,
  type WakeAudit,
} from './parked-agent-audit-controls';

const SEARCH_QUERY = 'parked agent audit';
const AUDIT_DOC = 'agent-insights/parked-agent-audit-roster-view';
const AUDIT_LIVE_PROFILE = 'packages/operator-core/test/parked-agent-audit.live-profile.json';
const PUBLIC_AUDIT_ID = '45250822471a901a36bec955ae89fc2f8ab107058c6b9c93864b2fa8bfd8ef12';
const PUBLIC_AUDIT_PATH = `audits/roster/24201c2745800b53/${PUBLIC_AUDIT_ID}.json`;
const AS_OF = '2026-10-10T01:09:46.552Z';

function recordDigest(row: unknown): string {
  const text = JSON.stringify(row);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
}

/** Use stdin for large independent page oracles; never shell-interpolate evidence. */
async function authenticatedAuditCode<T>(script: string, inputs: object = {}, frozenReadOnly = false): Promise<T> {
  expect(process.env.PAPERCUSP_SID).toBeTruthy();
  expect(process.env.PAPERCUSP_WORKSPACE).toBeTruthy();
  expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(AUDIT_LIVE_PROFILE);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const env = { ...process.env }; delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = await retryAuditRead(() => new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'), 'code:run', '--json', '-',
      '--port', parkedAuditOperatorRoute().port, '--client', process.env.PAPERCUSP_SID!, '--workspace', process.env.PAPERCUSP_WORKSPACE!,
      '--harness', '*'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('authenticated audit read exceeded 90s')); }, 90_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`authenticated audit read exit ${code}: ${stderr.slice(-1500)} ${stdout.slice(-2000)}`));
      else resolveResult({ stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ script, inputs, timeoutSec: 45,
      projection: { pick: ['ok', 'summary', 'summaryNotice', 'error', 'partial', 'childFailures', 'rejectedMutations', 'okFalseMutations'] } }));
  }), undefined, frozenReadOnly);
  const value = JSON.parse(result.stdout);
  expect(value.ok, result.stderr).toBe(true);
  expect(value.partial).not.toBe(true);
  expect(value.summaryNotice?.truncated, 'a clipped live measurement is unavailable').not.toBe(true);
  expect(value.childFailures ?? []).toEqual([]);
  return value.summary as T;
}
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
        tool, '--port', parkedAuditOperatorRoute().port, '--client', process.env.PAPERCUSP_SID!,
        '--workspace', process.env.PAPERCUSP_WORKSPACE!, JSON.stringify(args)],
      { env: toolEnv, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    };
    const tools = await call('tools:find', { query: SEARCH_QUERY,
      projection: { pick: ['query', 'hits[].tool', 'hits[].description'] } });
    const docs = await call('docs:search', { query: SEARCH_QUERY, harness: 'engineering', limit: 3,
      projection: { pick: ['hits[].slug', 'hits[].url', 'legs.degraded'] } });
    const errors = searchViolations({ tools, docs });
    process.stdout.write(`PARKED_AUDIT_R8 ${JSON.stringify({ query: SEARCH_QUERY, route: parkedAuditOperatorRoute().origin,
      toolRank: tools.hits?.findIndex((hit: { tool: string }) => hit.tool === 'coord:roster') + 1,
      docRank: docs.hits?.findIndex((hit: { slug: string }) => hit.slug === AUDIT_DOC) + 1, errors })}\n`);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe.skipIf(!SEARCH_LIVE_REQUESTED && SEARCH_TEST_LAYER !== 'e2e')('LIVE: R-6 owned finite pickup dispositions', () => {
  it('reads both current owners and one honest disposition for each frozen recipient/message pair', async () => {
    expect(SEARCH_LIVE_REQUESTED, 'R-6 requires an actual live measurement').toBe(true);
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(AUDIT_LIVE_PROFILE);
    expect(process.env.PAPERCUSP_SID).toBeTruthy();
    expect(process.env.PAPERCUSP_WORKSPACE).toBeTruthy();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const toolEnv = { ...process.env }; delete toolEnv.PAPERCUSP_SCRATCH_ROOT;
    const call = async (script: string) => {
      const result = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
        'code:run', '--port', parkedAuditOperatorRoute().port, '--client', process.env.PAPERCUSP_SID!,
        '--workspace', process.env.PAPERCUSP_WORKSPACE!, '--harness', 'papercusp',
        JSON.stringify({ script, timeoutSec: 45, projection: { pick: ['ok', 'summary', 'partial', 'childFailures', 'error', 'rejectedMutations', 'okFalseMutations'] } })],
      { env: toolEnv, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }).catch(parkedAuditToolFailure);
      const value = JSON.parse(result.stdout);
      expect(value.ok).toBe(true); expect(value.partial).not.toBe(true);
      expect(value.summaryNotice?.truncated, 'a clipped measurement is unavailable').not.toBe(true);
      expect(value.childFailures ?? []).toEqual([]);
      return value.summary;
    };
    const prefix = 'audits/parked-agent-resumption-2026-10-17-637d7/';
    const expected = await call(`const r=await tools.artifacts.load({slug:'papercusp',rel_path:'${prefix}final-edition.json'});const a=JSON.parse(r.results[0].content);return (${originalUnconfirmedPairs.toString()})(a.rows);`);
    const cases = await call(`const r=await tools.artifacts.load({slug:'papercusp',rel_path:'${prefix}pickup-reconciliation-7947311d.json'});return JSON.parse(r.results[0].content).cases;`);
    const items = await call("const r=await tools.work_items.get({ids:['WI-6554700010017003','WI-6554700010017004'],harness:'papercusp',threadLimit:0});return r.results.map(x=>({id:x.id,state:x.workItem.state,assignee:x.workItem.assignee,createdBy:x.workItem.createdBy,hasCompletionEvidence:x.hasCompletionEvidence===true}));");
    // The observer need not own the audited work. Its original accountable
    // agent is the proposal's recorded creator, independent of today's claim.
    const auditOwner = items.find((item: { id: string }) => item.id === 'WI-6554700010017003')?.createdBy;
    expect(typeof auditOwner === 'string' && auditOwner.trim().length > 0, 'original accountable agent is recorded').toBe(true);
    const errors = pickupDispositionViolations(expected, cases, items, auditOwner);
    process.stdout.write(`PARKED_AUDIT_R6 ${JSON.stringify({ observedAt: new Date().toISOString(), pairs: expected.length,
      dispositions: cases.length, replied: cases.filter((row: PickupDisposition) => row.outcome === 'recipient-replied').length,
      unconfirmed: cases.filter((row: PickupDisposition) => row.outcome === 'pickup-unconfirmed').length, errors })}\n`);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe.skipIf(!SEARCH_LIVE_REQUESTED && SEARCH_TEST_LAYER !== 'e2e')('LIVE: R-4 authenticated directive after persisted reload', () => {
  it('resolves the original ledger turn and preserves it through a separate authenticated reader', async () => {
    expect(SEARCH_LIVE_REQUESTED).toBe(true);
    // This directive predates this managed continuation. A separate subprocess
    // rehydrates the persisted audit, the canonical state boundary used by carry.
    const first = await authenticatedAuditCode<{ auditId: string; provenance: object; expectedQuote: string; expectedSourceRef: string }>(
      "const d=await tools.orders.get({id:1973});if(!d.directive?.verbatim||!d.directive.sourceTurnRef)throw Error('directive unavailable');"
      + "const p=await tools.coord.roster({view:'audit',scope:'workspace',owner:inputs.owner,auditDirectiveId:1973,pageSize:1});"
      + "if(p.provenance?.status!=='verified-owner'||p.provenance?.turnOrigin!=='owner-typed')throw Error('owner provenance not verified');"
      + "if(p.provenance.quote!==d.directive.verbatim.slice(0,180)||p.provenance.sourceRef!==d.directive.sourceTurnRef)throw Error('directive quote/source mismatch');"
      + "return {auditId:p.auditId,provenance:p.provenance,expectedQuote:d.directive.verbatim.slice(0,180),expectedSourceRef:d.directive.sourceTurnRef};",
      { owner: process.env.PAPERCUSP_SID });
    const restored = await authenticatedAuditCode<{ auditId: string; provenance: object }>(
      "const p=await tools.coord.roster({view:'audit',scope:'workspace',owner:inputs.owner,auditId:inputs.auditId,auditDirectiveId:1973,pageSize:1});"
      + "return {auditId:p.auditId,provenance:p.provenance};", { owner: process.env.PAPERCUSP_SID, auditId: first.auditId });
    expect(restored).toEqual({ auditId: first.auditId, provenance: first.provenance });
    process.stdout.write(`PARKED_AUDIT_R4 ${JSON.stringify({ directiveId: 1973, auditId: first.auditId,
      sourceRef: first.expectedSourceRef, persistedReload: true, errors: [] })}\n`);
  }, 240_000);
});

const LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_AUDIT_LIVE === '1';
const CURRENT_LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_CURRENT_LIVE === '1';
allowRealPgForLiveSuite(LIVE_REQUESTED || CURRENT_LIVE_REQUESTED);
describe.skipIf(!CURRENT_LIVE_REQUESTED)('LIVE: bounded current public audit', () => {
  it('creates a fresh owner-scoped audit and separately reloads every frozen page against persisted writer bytes', async () => {
    const owner = process.env.PAPERCUSP_PARKED_AUDIT_OWNER;
    expect(owner, 'choose one currently parked owner; this route never creates a full census').toBeTruthy();
    const startedAt = Date.now();
    const created = await authenticatedAuditCode<{ auditId: string; asOf: string; total: number }>(
      "const p=await tools.coord.roster({view:'audit',scope:'workspace',owner:inputs.owner,pageSize:1});"
      + "return {auditId:p.auditId,asOf:p.asOf,total:p.coverage.total};", { owner });
    expect(created.total).toBe(1);
    expect(Date.parse(created.asOf)).toBeGreaterThanOrEqual(startedAt);
    const adminUrl = getHarnessAdminUrl();
    const address = new URL(adminUrl);
    expect(['localhost', '127.0.0.1', '::1', '[::1]']).toContain(address.hostname);
    expect(address.port || '5432').toBe('5432');
    const sql = postgres(adminUrl, { max: 1, connect_timeout: 5, idle_timeout: 5 });
    let oracle: RosterAuditSnapshot;
    const artifactPath = 'audits/roster/' + createHash('sha256').update(process.env.PAPERCUSP_WORKSPACE!)
      .digest('hex').slice(0, 16) + '/' + created.auditId + '.json';
    try {
      const rows = await sql<Array<{ content: string }>>`SELECT content FROM harness_shared.harness_text_artifacts
        WHERE workspace_id=${process.env.PAPERCUSP_WORKSPACE!} AND harness_slug='*' AND rel_path=${artifactPath}`;
      expect(rows).toHaveLength(1);
      oracle = JSON.parse(rows[0].content) as RosterAuditSnapshot;
    } finally { await sql.end({ timeout: 5 }); }
    expect(oracle.auditId).toBe(created.auditId);
    expect(oracle.population).toEqual([owner]);
    expect(oracle.records.length, 'bounded owner scope exceeded the maintained 1280-record budget').toBeLessThanOrEqual(1280);
    expect(new Set(oracle.records.map(row => row.id)).size).toBe(oracle.records.length);
    process.stdout.write(`PARKED_AUDIT_CURRENT_CREATED ${JSON.stringify({ owner, ...created, records: oracle.records.length, artifactPath })}\n`);
    let cursor: string | null = null; let offset = 0; let covered = 0; let pages = 0;
    do {
      // Content truncation can return fewer than pageSize records. Nonempty,
      // progressing pages are bounded by the frozen record count, not size/10.
      const page: { digest: string; offset: number; covered: number; cursor: string | null; pages: number } = await authenticatedAuditCode(
        "const s={offset:inputs.offset,covered:inputs.covered,cursor:inputs.cursor??null,pages:0};const seen=[];const started=Date.now();let complete=false;"
        + "while(!complete&&s.pages<20&&Date.now()-started<10000){"
        + "const p=await tools.coord.roster({view:'audit',scope:'workspace',owner:inputs.owner,auditId:inputs.auditId,cursor:s.cursor??undefined,pageSize:10});"
        + "const end=s.offset+p.records.length;const covered=s.covered+p.records.filter(r=>r.kind==='agent').length;complete=end===inputs.records;"
        + "if(p.auditId!==inputs.auditId||p.asOf!==inputs.asOf||p.projection.offset!==s.offset)throw Error('snapshot-or-offset-changed');"
        + "if(!p.records.length||p.coverage.total!==1||p.coverage.covered!==covered||p.coverage.recordsRead!==end||p.coverage.totalRecords!==inputs.records||p.coverage.missing!==0||p.coverage.duplicates!==0||p.coverage.complete!==complete||p.coverage.truncatedByLimit!==!complete)throw Error('coverage-changed');"
        + "if(complete?p.nextCursor!==null:!p.nextCursor||p.nextCursor===s.cursor)throw Error('cursor-did-not-progress');"
        + "seen.push(...p.records);s.offset=end;s.covered=covered;s.cursor=p.nextCursor;s.pages++;}"
        + `return {digest:(${recordDigest.toString()})(seen),...s};`,
        { owner, auditId: created.auditId, asOf: created.asOf, cursor, offset, covered, records: oracle.records.length }, true);
      expect(page.offset).toBeGreaterThan(offset);
      expect(page.offset).toBeLessThanOrEqual(oracle.records.length);
      expect(page.digest).toBe(recordDigest(oracle.records.slice(offset, page.offset)));
      offset = page.offset; covered = page.covered; cursor = page.cursor; pages += page.pages;
      expect(pages).toBeLessThanOrEqual(oracle.records.length);
    } while (cursor !== null);
    expect(offset).toBe(oracle.records.length); expect(covered).toBe(1);
    process.stdout.write(`PARKED_AUDIT_CURRENT ${JSON.stringify({ owner, ...created, records: offset, pages,
      persistedReload: true, artifactPath, complete: true, errors: [] })}\n`);
  }, 600_000);
});
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

  it('walks the authenticated public audit pager to termination against the independent frozen writer records', async () => {
    // SQL is only the independent test oracle. Every measured page goes through
    // authenticated coord:roster; the dogfood caller still needs zero SQL.
    const rows = await sql<Array<{ content: string }>>`SELECT content FROM harness_shared.harness_text_artifacts
      WHERE workspace_id='papercusp-workspace' AND harness_slug='*' AND rel_path=${PUBLIC_AUDIT_PATH}`;
    expect(rows).toHaveLength(1);
    const oracle = JSON.parse(rows[0].content) as RosterAuditSnapshot;
    expect(oracle.auditId).toBe(PUBLIC_AUDIT_ID);
    expect(oracle.population.length).toBe(oracle.expectedPopulation);
    expect(new Set(oracle.population).size).toBe(oracle.expectedPopulation);
    expect(new Set(oracle.records.map(row => row.id)).size).toBe(oracle.records.length);
    let state = { cursor: null as string | null, offset: 0, covered: 0, pages: 0, complete: false };
    while (!state.complete) {
      const before = state.offset;
      const batch = await authenticatedAuditCode<{ digest: string; final: typeof state }>(
        `const digest=r=>{const t=JSON.stringify(r);let h=2166136261;for(let i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0')+':'+t.length;};`
        + "const s={cursor:inputs.cursor??null,offset:inputs.offset??0,covered:inputs.covered??0,pages:inputs.pages??0,complete:false};const seen=[];const start=Date.now();let count=0;"
        + "while(!s.complete&&count<20&&Date.now()-start<10000){const p=await tools.coord.roster({view:'audit',scope:'workspace',auditId:inputs.auditId,cursor:s.cursor??undefined,pageSize:10});"
        + "if(!p.records?.length)throw Error('public pager returned no records at offset '+s.offset);"
        + "const end=s.offset+p.records.length;const covered=s.covered+p.records.filter(r=>r.kind==='agent').length;const complete=end===inputs.recordCount;"
        + "if(p.auditId!==inputs.auditId||p.asOf!==inputs.asOf)throw Error('snapshot-changed');if(p.projection.offset!==s.offset)throw Error('offset-changed');"
        + "if(p.coverage.total!==inputs.populationCount||p.coverage.covered!==covered||p.coverage.missing!==0||p.coverage.duplicates!==0||p.coverage.recordsRead!==end||p.coverage.totalRecords!==inputs.recordCount||p.coverage.complete!==complete||p.coverage.truncatedByLimit!==!complete)throw Error('coverage-changed');"
        + "if(complete?p.nextCursor!==null:!p.nextCursor||p.nextCursor===s.cursor)throw Error('cursor-did-not-progress');"
        + "seen.push(...p.records);s.offset=end;s.covered=covered;s.cursor=p.nextCursor;s.complete=complete;s.pages++;count++;}return {digest:digest(seen),final:s};",
        { auditId: oracle.auditId, asOf: oracle.asOf, populationCount: oracle.expectedPopulation,
          recordCount: oracle.records.length, ...state }, true);
      expect(batch.digest).toBe(recordDigest(oracle.records.slice(before, batch.final.offset)));
      state = batch.final;
      expect(state.offset).toBeGreaterThan(before);
      expect(state.covered).toBe(oracle.records.slice(0, state.offset).filter(row => row.kind === 'agent').length);
      process.stdout.write(`PARKED_AUDIT_R1_PAGE ${JSON.stringify(state)}\n`);
    }
    expect(state.offset).toBe(oracle.records.length);
    expect(state.covered).toBe(oracle.expectedPopulation);
    expect(state.cursor).toBeNull();
    process.stdout.write(`PARKED_AUDIT_R1_PUBLIC ${JSON.stringify({ auditId: oracle.auditId, asOf: oracle.asOf,
      population: oracle.expectedPopulation, records: state.offset, pages: state.pages, complete: true, errors: [] })}\n`);
  }, 3_600_000);

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
