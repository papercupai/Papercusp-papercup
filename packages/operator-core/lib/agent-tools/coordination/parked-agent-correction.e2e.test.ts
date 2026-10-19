/** Read the retained correction stream through authenticated application calls.
 * This deliberately reuses the existing frozen audit, without creating a census.
 * Run with PAPERCUSP_PARKED_SEARCH_LIVE=1 and parked-agent-audit.live-profile.json.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { retryRejectedLiveRead } from '../../testing/live-integration';
import { parkedAuditOperatorRoute } from './parked-agent-audit-oracles';

const PROFILE = 'packages/operator-core/test/parked-agent-audit.live-profile.json';
const AUDIT_ID = '45250822471a901a36bec955ae89fc2f8ab107058c6b9c93864b2fa8bfd8ef12';
const CORRECTED_REPORT = 'report:rpt_7a449b1b-64f6-4097-b3bd-5b5ec00d6eab';
type Edition = { ref: string; supersedes: string | null; publishedAt: string; supersededBy: string[] };
type Quote = { edition: string; part: number; quote: string };

function digest(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

describe.skipIf(process.env.PAPERCUSP_PARKED_SEARCH_LIVE !== '1')('LIVE: R-5 authenticated correction lineage', () => {
  it('reloads retained correction editions and exact count quotes through the public pager and canonical reports', async () => {
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(PROFILE);
    expect(process.env.PAPERCUSP_SID).toBeTruthy();
    expect(process.env.PAPERCUSP_WORKSPACE).toBeTruthy();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const env = { ...process.env }; delete env.PAPERCUSP_SCRATCH_ROOT;
    // Each subprocess authenticates separately and reloads persisted state.
    const read = async <T,>(script: string): Promise<T> => {
      const response = await retryRejectedLiveRead(() => promisify(execFile)(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
        'code:run', '--port', parkedAuditOperatorRoute().port, '--client', process.env.PAPERCUSP_SID!,
        '--workspace', process.env.PAPERCUSP_WORKSPACE!, '--harness', '*',
        JSON.stringify({ script, timeoutSec: 30,
          projection: { pick: ['ok', 'summary', 'summaryNotice', 'partial', 'childFailures', 'error'] } })],
      { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }));
      const result = JSON.parse(response.stdout);
      expect(result.ok, result.error).toBe(true); expect(result.partial).not.toBe(true);
      expect(result.childFailures ?? []).toEqual([]); expect(result.summaryNotice?.truncated).not.toBe(true);
      return result.summary;
    };
    const editions: Edition[] = []; const quotes: Quote[] = [];
    let cursor: string | null = null; let complete = false; let count = -1; let pages = 0;
    while (!complete && pages < 200) {
      const page: { auditId: string; nextCursor: string | null; count: number;
        kind?: string; edition?: Edition; quote?: Quote } = await read<{ auditId: string; nextCursor: string | null; count: number;
        kind?: string; edition?: Edition; quote?: Quote }>(
        'const p=await tools.coord.roster({view:"audit",scope:"workspace",auditId:' + JSON.stringify(AUDIT_ID)
        + ',cursor:' + (cursor === null ? 'undefined' : JSON.stringify(cursor)) + ',pageSize:1});'
        + 'const r=p.records[0];return {auditId:p.auditId,nextCursor:p.nextCursor,count:p.previous.correctionCount,'
        + 'kind:r?.kind,edition:r?.fields.correction?.value,quote:r?.fields.reportedCountContext?.value};');
      expect(page.auditId).toBe(AUDIT_ID);
      if (count < 0) count = page.count;
      expect(page.count).toBe(count);
      if (page.edition) editions.push(page.edition);
      if (page.quote) quotes.push(page.quote);
      complete = page.kind !== 'history' || page.nextCursor === null;
      if (!complete) expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor; pages++;
    }
    expect(complete).toBe(true); expect(count).toBeGreaterThan(0); expect(editions).toHaveLength(count);
    expect(new Set(editions.map(edition => edition.ref)).size).toBe(count);
    expect(editions.some(edition => edition.ref === CORRECTED_REPORT)).toBe(true);
    let correctedInstanceSeen = false;
    for (const edition of editions) {
      const report = await read<{ supersedes: string | null; publishedAt: string; quoteDigest: string;
        quoteCount: number; corrected: boolean }>(
        'const r=await tools.reports.get({id:' + JSON.stringify(edition.ref.slice(7)) + '});const p=r.results[0].report;'
        + 'if(!p?.body_md)throw Error("canonical report unavailable");'
        + 'const q=p.body_md.split(/\\n\\s*\\n/).filter(p=>/\\d/.test(p)).flatMap(p=>p.match(/[\\s\\S]{1,1000}/g)??[]);'
        + 'return {supersedes:p.supersedes_report_id,publishedAt:p.published_at,quoteDigest:('
        + digest.toString() + ')(q),quoteCount:q.length,corrected:p.body_md.includes("WI-6554700010016838")};');
      expect(report.supersedes).toBe(edition.supersedes); expect(report.publishedAt).toBe(edition.publishedAt);
      const selected = quotes.filter(quote => quote.edition === edition.ref).sort((a, b) => a.part - b.part);
      expect(selected.map(quote => quote.part)).toEqual(selected.map((_, i) => i));
      expect(selected).toHaveLength(report.quoteCount);
      expect(digest(selected.map(quote => quote.quote))).toBe(report.quoteDigest);
      expect([...edition.supersededBy].sort())
        .toEqual(editions.filter(next => next.supersedes === edition.ref.slice(7)).map(next => next.ref).sort());
      correctedInstanceSeen ||= report.corrected;
    }
    expect(correctedInstanceSeen).toBe(true);
    process.stdout.write(`PARKED_AUDIT_R5_E2E ${JSON.stringify({ auditId: AUDIT_ID, editions: editions.length,
      countQuoteRecords: quotes.length, pages, correctedInstanceSeen, persistedReload: true, errors: [] })}\n`);
  }, 600_000);
});
