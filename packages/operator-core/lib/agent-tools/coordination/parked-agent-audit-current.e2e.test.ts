/**
 * Current-runtime companion to the preserved complete public traversal.
 * This bounded check does not claim a new whole-population traversal.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';
import { pageRosterAudit, type RosterAuditSnapshot } from './tools/roster-audit';

const LIVE = process.env.PAPERCUSP_PARKED_CURRENT_LIVE === '1';
const ID = '45250822471a901a36bec955ae89fc2f8ab107058c6b9c93864b2fa8bfd8ef12';
allowRealPgForLiveSuite(LIVE);

describe.skipIf(!LIVE && inject('papercuspTestLayer') !== 'e2e')('LIVE: R-1 current public pager witness', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    expect(LIVE, 'the current witness requires a real public read').toBe(true);
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE)
      .toBe('packages/operator-core/test/parked-agent-audit.live-profile.json');
    const url = getHarnessAdminUrl();
    const address = new URL(url);
    expect(['localhost', '127.0.0.1', '::1', '[::1]']).toContain(address.hostname);
    expect(address.port || '5432').toBe('5432');
    sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 5 });
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  it('re-observes exact first, middle and terminal public pages with truthful terminal coverage', async () => {
    const stored = await sql<Array<{ content: string }>>`SELECT content FROM harness_shared.harness_text_artifacts
      WHERE workspace_id='papercusp-workspace' AND harness_slug='*'
      AND rel_path=${`audits/roster/24201c2745800b53/${ID}.json`}`;
    expect(stored).toHaveLength(1);
    const snapshot = JSON.parse(stored[0].content) as RosterAuditSnapshot;
    expect(snapshot.auditId).toBe(ID);
    expect(snapshot.records.length).toBe(7153);
    expect(snapshot.expectedPopulation).toBe(347);
    const selected = new Set([0, Math.floor(snapshot.records.length / 2), snapshot.records.length - 1]);
    const probes: Array<{ cursor: string | null; expected: ReturnType<typeof pageRosterAudit> }> = [];
    let cursor: string | null = null;
    // Derive real cursors from the frozen writer oracle, never from a sampled
    // endpoint response. Single-record pages make all three offsets exact.
    do {
      const page = pageRosterAudit(snapshot, snapshot.scope, { cursor: cursor ?? undefined, pageSize: 1 });
      if (selected.has(page.projection.offset)) probes.push({ cursor, expected: page });
      cursor = page.nextCursor;
    } while (cursor);
    expect(probes).toHaveLength(3);
    const owner = process.env.PAPERCUSP_SID;
    const workspace = process.env.PAPERCUSP_WORKSPACE;
    expect(owner).toBeTruthy(); expect(workspace).toBeTruthy();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const env = { ...process.env }; delete env.PAPERCUSP_SCRATCH_ROOT;
    const digest = (records: unknown) => {
      const text = JSON.stringify(records); let hash = 2166136261;
      for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
      return `${(hash >>> 0).toString(16)}:${text.length}`;
    };
    // Return a small canonical digest of each real public response. The full
    // archive stays an independent oracle and never substitutes for that read.
    const script = `const digest=${digest.toString()};`
      + "const out=[];for(const cursor of inputs.cursors){const p=await tools.coord.roster({view:'audit',scope:'workspace',auditId:inputs.id,cursor:cursor??undefined,pageSize:1});"
      + "out.push({auditId:p.auditId,asOf:p.asOf,offset:p.projection.offset,coverage:p.coverage,nextCursor:p.nextCursor,recordsDigest:digest(p.records)});}return out;";
    const result = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
      'code:run', '--port', '3170', '--client', owner!, '--workspace', workspace!, '--harness', '*',
      JSON.stringify({ script, inputs: { id: ID, cursors: probes.map(p => p.cursor) }, timeoutSec: 45,
        projection: { pick: ['ok', 'summary', 'summaryNotice', 'partial', 'childFailures'] } })],
    { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    const value = JSON.parse(result.stdout);
    expect(value.ok).toBe(true); expect(value.partial).not.toBe(true);
    expect(value.summaryNotice?.truncated, 'a clipped observation is unavailable').not.toBe(true);
    expect(value.childFailures ?? []).toEqual([]);
    const observed = value.summary;
    const expected = probes.map(({ expected: p }) => ({ auditId: p.auditId, asOf: p.asOf,
      offset: p.projection.offset, coverage: p.coverage, nextCursor: p.nextCursor, recordsDigest: digest(p.records) }));
    expect(observed).toEqual(expected);
    expect(observed[2].coverage).toMatchObject({ total: 347, covered: 347, missing: 0, duplicates: 0,
      recordsRead: 7153, totalRecords: 7153, complete: true, truncatedByLimit: false });
    expect(observed[2].nextCursor).toBeNull();
    process.stdout.write(`PARKED_AUDIT_R1_CURRENT ${JSON.stringify({ auditId: ID,
      offsets: [...selected], terminalRecords: 7153, terminalOwners: 347, errors: [] })}\n`);
  }, 120_000);
});
