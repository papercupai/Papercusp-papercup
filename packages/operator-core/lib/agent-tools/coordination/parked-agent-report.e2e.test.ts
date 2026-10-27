/** R-3: authenticated reports:get readback, preserving the frozen census.
 * Separate from the R-1/R-2 instrument so its accepted fingerprints stay intact.
 * The live case is read-only and pins the accepted report id and body digest.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';

const REPORT_ID = 'rpt_18581993-b959-48ca-88dc-28e1f0176296';
const REPORT_SHA256 = '3762b8eec60dee0575349369560a45eeecb3123cc873edc30915c32f8149e38e';
const LIVE_PROFILE = 'packages/operator-core/test/parked-agent-report.live-profile.json';

function liveConfigurationErrors(env: NodeJS.ProcessEnv, layer: string | undefined): string[] {
  const errors: string[] = [];
  if (layer === 'e2e' && env.PAPERCUSP_PARKED_REPORT_LIVE !== '1') errors.push('live-readback-required');
  if (env.PAPERCUSP_PARKED_REPORT_ID !== undefined && env.PAPERCUSP_PARKED_REPORT_ID !== REPORT_ID) {
    errors.push('canonical-report-id-mismatch');
  }
  if (env.PAPERCUSP_PARKED_REPORT_SHA256 !== undefined && env.PAPERCUSP_PARKED_REPORT_SHA256 !== REPORT_SHA256) {
    errors.push('canonical-report-digest-mismatch');
  }
  return errors;
}

interface ReportRead {
  ok: boolean;
  results: Array<{ ok: boolean; id: string; report?: {
    report_id: string;
    visibility: string;
    path: string;
    body_md: string;
  } }>;
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function reportViolations(read: ReportRead, id: string, expectedDigest: string, owners: string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(read.results)) return ['invalid-read-envelope'];
  const matches = read.results.filter(row => row.id === id);
  if (!read.ok || matches.length !== 1 || !matches[0]?.ok || !matches[0]?.report) return ['missing-report'];
  const report = matches[0].report;
  if (report.report_id !== id) errors.push('foreign-report');
  // Migration 1580 publicized this frozen edition under directives #2316/#2319.
  if (report.visibility !== 'workspace') errors.push('wrong-visibility');
  if (report.path !== `/reports?sel=${id}`) errors.push('wrong-deep-link');
  if (digest(report.body_md) !== expectedDigest) errors.push('body-not-complete');
  const rows = report.body_md.split('\n').filter(line => line.startsWith('| su-'))
    .map(line => line.split('|')[1]!.trim());
  if (rows.length !== owners.length || new Set(rows).size !== rows.length
    || JSON.stringify([...rows].sort()) !== JSON.stringify([...owners].sort())) errors.push('population-mismatch');
  return errors.sort();
}

function fixture(): { read: ReportRead; id: string; hash: string; owners: string[] } {
  const id = 'rpt_control';
  const body = '# Measured parking causes\n\n| su-a | resume-candidate | unconfirmed |\n| su-b | owner-stop | preserved |\n';
  return { id, hash: digest(body), owners: ['su-a', 'su-b'], read: { ok: true, results: [{
    ok: true, id, report: { report_id: id, visibility: 'workspace', path: `/reports?sel=${id}`, body_md: body },
  }] } };
}

describe('R-3 report readback controls', () => {
  it('requires live readback in the configured e2e layer', () => {
    expect(liveConfigurationErrors({}, 'e2e')).toEqual(['live-readback-required']);
    expect(liveConfigurationErrors({}, 'unit')).toEqual([]);
    expect(liveConfigurationErrors({ PAPERCUSP_PARKED_REPORT_LIVE: '1' }, 'e2e')).toEqual([]);
  });
  it('refuses a report id override instead of redirecting the accepted target', () => {
    expect(liveConfigurationErrors({ PAPERCUSP_PARKED_REPORT_LIVE: '1',
      PAPERCUSP_PARKED_REPORT_ID: 'rpt_other' }, 'e2e')).toEqual(['canonical-report-id-mismatch']);
  });
  it('refuses a digest override instead of accepting another report body', () => {
    expect(liveConfigurationErrors({ PAPERCUSP_PARKED_REPORT_LIVE: '1',
      PAPERCUSP_PARKED_REPORT_SHA256: '0'.repeat(64) }, 'e2e')).toEqual(['canonical-report-digest-mismatch']);
  });
  it('accepts environment confirmations of the canonical target', () => {
    expect(liveConfigurationErrors({ PAPERCUSP_PARKED_REPORT_LIVE: '1',
      PAPERCUSP_PARKED_REPORT_ID: REPORT_ID, PAPERCUSP_PARKED_REPORT_SHA256: REPORT_SHA256 }, 'e2e')).toEqual([]);
  });
  it('accepts the complete owner report and exact population', () => {
    const f = fixture();
    expect(reportViolations(f.read, f.id, f.hash, f.owners)).toEqual([]);
  });
  it('rejects a missing report', () => {
    const f = fixture();
    f.read.results = [];
    expect(reportViolations(f.read, f.id, f.hash, f.owners)).toContain('missing-report');
  });
  it('rejects a malformed transport envelope without throwing', () => {
    const f = fixture();
    expect(reportViolations({ ok: true } as ReportRead, f.id, f.hash, f.owners)).toEqual(['invalid-read-envelope']);
  });
  it('rejects a truncated diagnostic report', () => {
    const f = fixture();
    f.read.results[0]!.report!.body_md = f.read.results[0]!.report!.body_md.slice(0, -10);
    expect(reportViolations(f.read, f.id, f.hash, f.owners)).toContain('body-not-complete');
  });
  it('rejects a foreign report identity', () => {
    const f = fixture();
    f.read.results[0]!.report!.report_id = 'rpt_other';
    expect(reportViolations(f.read, f.id, f.hash, f.owners)).toContain('foreign-report');
  });
  it('rejects changed visibility or the wrong GUI target', () => {
    const f = fixture();
    f.read.results[0]!.report!.visibility = 'owner';
    f.read.results[0]!.report!.path = '/reports?sel=rpt_other';
    expect(reportViolations(f.read, f.id, f.hash, f.owners)).toEqual(['wrong-deep-link', 'wrong-visibility']);
  });
  it.each(['missing', 'duplicate', 'foreign'])('rejects %s population rows even with a matching digest', (kind) => {
    const f = fixture();
    const report = f.read.results[0]!.report!;
    report.body_md = kind === 'missing' ? report.body_md.replace('| su-b | owner-stop | preserved |\n', '')
      : report.body_md.replace('| su-b |', kind === 'duplicate' ? '| su-a |' : '| su-c |');
    expect(reportViolations(f.read, f.id, digest(report.body_md), f.owners)).toContain('population-mismatch');
  });
});

const LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_REPORT_LIVE === '1';
const TEST_LAYER = inject('papercuspTestLayer');
allowRealPgForLiveSuite(LIVE_REQUESTED);
// E2e execution must collect the real case even when its opt-in was omitted.
// Ordinary unit runs keep the real-PG rail and exercise only the controls.
describe.skipIf(!LIVE_REQUESTED && TEST_LAYER !== 'e2e')('LIVE: R-3 published diagnostic report', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    expect(liveConfigurationErrors(process.env, TEST_LAYER), 'R-3 live configuration').toEqual([]);
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(LIVE_PROFILE);
    const address = new URL(getHarnessAdminUrl());
    expect(['localhost', '127.0.0.1', '::1', '[::1]']).toContain(address.hostname);
    expect(address.port || '5432').toBe('5432');
    sql = postgres(address.href, { max: 1, connect_timeout: 5, idle_timeout: 5 });
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  it('reports:get returns the complete owner diagnostic with every frozen population row', async () => {
    const id = REPORT_ID;
    const hash = REPORT_SHA256;
    expect(process.env.PAPERCUSP_SID, 'retain this session authenticated principal').toBeTruthy();
    const rows = await sql<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_text_artifacts
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND rel_path = 'audits/parked-agent-resumption-2026-10-09/census.json'`;
    expect(rows).toHaveLength(1);
    const census = JSON.parse(rows[0]!.content) as { asOf: string; records: Array<{ presence: { ownerId: string } }> };
    expect(census.asOf).toBe('2026-10-10T01:09:46.552Z');
    const owners = census.records.map(row => row.presence.ownerId);
    expect(owners).toHaveLength(273);
    expect(new Set(owners).size).toBe(owners.length);
    // Sanctioned MCP CLI retains PAPERCUSP_SID; no invented actor or direct HTTP.
    // Use this checkout's maintained CLI. Its external server spills live in
    // native scratch, not the private scratch installed for this test process.
    // Keep local hermetic storage untouched; only the read-only child differs.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const toolEnv = { ...process.env };
    delete toolEnv.PAPERCUSP_SCRATCH_ROOT;
    const raw = execFileSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
      'reports:get', '--url=http://127.0.0.1:3170', '--json', '-'], {
      env: toolEnv,
      input: JSON.stringify({ id, payloadTier: 'full' }), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    const read = JSON.parse(raw) as ReportRead;
    expect(Array.isArray(read.results), `reports:get returned another envelope: ${JSON.stringify(read).slice(0, 2500)}`).toBe(true);
    const errors = reportViolations(read, id, hash, owners);
    process.stdout.write(`PARKED_AUDIT_R3 ${JSON.stringify({ reportId: id, sha256: hash, population: owners.length,
      route: 'http://127.0.0.1:3170', errors })}\n`);
    expect(errors).toEqual([]);
  });
});
