/**
 * plan-verification-profiles-2026-10-17 P-003 — generic citation kinds (R-7) and their
 * content-hash freshness (R-8). Pure: the store lookup is built in the test.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyContentHash,
  genericCitationStaleReason,
  genericCitationVerifies,
  loadGenericCitationLookup,
  parseGenericCitation,
  resolveGenericCitation,
  testRunContentHash,
  workItemContentHash,
  type GenericCitationLookup,
  type GenericTargetState,
} from './plan-audits-generic-citations';
import { entryHasVerifyingCitation, resolveCitation, summarizeCoverage, type AuditItemEntry } from './plan-audits';

const SNAPSHOT = 'a'.repeat(64);
const found = (contentHash: string, settled = true): GenericTargetState => ({ found: true, contentHash, settled });

function lookupOf(entries: Record<string, GenericTargetState>): GenericCitationLookup {
  return new Map(Object.entries(entries));
}

const LOOKUP = lookupOf({
  'report:rpt_abc123': found(bodyContentHash('# Findings\n')),
  'plan:some-plan': found(bodyContentHash('plan body')),
  'doc:agent-insights/x': found(bodyContentHash('doc body')),
  'work-item:WI-42': found(workItemContentHash({ status: 'done', closed_at: '2026-10-20T00:00:00Z' })),
  'work-item:WI-43': found(workItemContentHash({ status: 'open' }), false),
  'test-run:7': found(testRunContentHash({ status: 'pass', commit_sha: 'abc', file_path: 'x.test.ts' })),
  'test-run:8': found(testRunContentHash({ status: 'fail', commit_sha: 'abc', file_path: 'x.test.ts' }), false),
  'report:rpt_gone': { found: false, contentHash: null, settled: false },
});

describe('generic citation kinds verify non-code work (R-7)', () => {
  it('parses each of the four kinds into the store row it names', () => {
    expect(parseGenericCitation({ kind: 'artifact', ref: 'rpt_abc123' })).toMatchObject({ ok: true, locator: { store: 'report', key: 'report:rpt_abc123' } });
    expect(parseGenericCitation({ kind: 'artifact', ref: 'plan:some-plan' })).toMatchObject({ ok: true, locator: { store: 'plan' } });
    expect(parseGenericCitation({ kind: 'artifact', ref: '/internal/docs/agent-insights/x' })).toMatchObject({ ok: true, locator: { key: 'doc:agent-insights/x' } });
    expect(parseGenericCitation({ kind: 'work-item', ref: 'EI-123' })).toMatchObject({ ok: true, locator: { key: 'work-item:EI-123' } });
    expect(parseGenericCitation({ kind: 'measurement', ref: 'test-run:7' })).toMatchObject({ ok: true, locator: { key: 'test-run:7' } });
    expect(parseGenericCitation({ kind: 'external', url: 'https://example.com/a', snapshotHash: SNAPSHOT })).toMatchObject({ ok: true });
  });

  it('refuses malformed targets with a named reason', () => {
    expect(parseGenericCitation({ kind: 'artifact' })).toMatchObject({ ok: false, reason: 'ref_missing' });
    expect(parseGenericCitation({ kind: 'artifact', ref: 'my notes' })).toMatchObject({ ok: false, reason: 'ref_unrecognized' });
    expect(parseGenericCitation({ kind: 'work-item', ref: 'P-003' })).toMatchObject({ ok: false, reason: 'ref_unrecognized' });
    expect(parseGenericCitation({ kind: 'measurement', ref: 'select 1' })).toMatchObject({ ok: false, reason: 'ref_unrecognized' });
    expect(parseGenericCitation({ kind: 'external', url: 'file:///etc/passwd', snapshotHash: SNAPSHOT })).toMatchObject({ ok: false, reason: 'url_invalid' });
    expect(parseGenericCitation({ kind: 'external', url: 'https://example.com' })).toMatchObject({ ok: false, reason: 'snapshot_hash_missing' });
    expect(parseGenericCitation({ kind: 'external', url: 'https://example.com', snapshotHash: 'abc' })).toMatchObject({ ok: false, reason: 'snapshot_hash_invalid' });
  });

  it('resolves only a target that exists and is settled evidence', () => {
    expect(resolveGenericCitation({ kind: 'artifact', ref: 'rpt_abc123' }, LOOKUP)).toMatchObject({ ok: true });
    expect(resolveGenericCitation({ kind: 'work-item', ref: 'WI-42' }, LOOKUP)).toMatchObject({ ok: true });
    expect(resolveGenericCitation({ kind: 'measurement', ref: 'test-run:7' }, LOOKUP)).toMatchObject({ ok: true });
    expect(resolveGenericCitation({ kind: 'external', url: 'https://example.com', snapshotHash: SNAPSHOT }, LOOKUP))
      .toEqual(expect.objectContaining({ ok: true, contentHash: SNAPSHOT }));
    expect(resolveGenericCitation({ kind: 'artifact', ref: 'rpt_gone' }, LOOKUP)).toMatchObject({ ok: false, reason: 'target_not_found' });
    expect(resolveGenericCitation({ kind: 'work-item', ref: 'WI-43' }, LOOKUP)).toMatchObject({ ok: false, reason: 'target_unsettled' });
    expect(resolveGenericCitation({ kind: 'measurement', ref: 'test-run:8' }, LOOKUP)).toMatchObject({ ok: false, reason: 'target_unsettled' });
    // A target the caller never loaded is unmeasured, never "exists".
    expect(resolveGenericCitation({ kind: 'work-item', ref: 'WI-999' }, LOOKUP)).toMatchObject({ ok: false, reason: 'target_unmeasured' });
  });

  it('plan-audits resolveCitation delegates generic kinds to the loaded lookup', () => {
    const deps = { statFile: () => null, readFile: () => null, generic: LOOKUP };
    expect(resolveCitation({ kind: 'artifact', ref: 'rpt_abc123' }, deps)).toEqual({ ok: true });
    expect(resolveCitation({ kind: 'artifact', ref: 'rpt_gone' }, deps)).toMatchObject({ ok: false, reason: 'target_not_found' });
    expect(resolveCitation({ kind: 'work-item', ref: 'WI-42' }, { statFile: () => null, readFile: () => null }))
      .toMatchObject({ ok: false, reason: 'target_unmeasured' });
  });

  it('counts a generic citation as verifying for a non-code item, never for a code item', () => {
    expect(genericCitationVerifies({ kind: 'artifact' }, { codeDeliverable: false })).toBe(true);
    expect(genericCitationVerifies({ kind: 'artifact' }, { codeDeliverable: true })).toBe(false);
    // Unknown deliverable fails safe to "does not verify".
    expect(genericCitationVerifies({ kind: 'work-item' }, {})).toBe(false);
    expect(genericCitationVerifies({ kind: 'doc' }, { codeDeliverable: false })).toBe(false);

    const nonCode: AuditItemEntry = {
      itemId: 'P-001',
      verdict: 'not-code',
      note: 'the deliverable is the published findings report',
      citations: [{ kind: 'artifact', ref: 'rpt_abc123' }],
      deliverable: 'research',
      codeDeliverable: false,
    };
    const code: AuditItemEntry = {
      itemId: 'P-002',
      verdict: 'implemented',
      citations: [{ kind: 'artifact', ref: 'rpt_abc123' }],
      deliverable: 'code',
      codeDeliverable: true,
    };
    expect(entryHasVerifyingCitation(nonCode)).toBe(true);
    expect(entryHasVerifyingCitation(code)).toBe(false);
    const coverage = summarizeCoverage([nonCode, code]);
    expect(coverage.verifiedItems).toBe(1);
    expect(coverage.unverifiedItemIds).toEqual(['P-002']);
  });
});

describe('generic citation freshness (R-8)', () => {
  const stamped = (citation: Parameters<typeof resolveGenericCitation>[0]) => {
    const r = resolveGenericCitation(citation, LOOKUP);
    if (!r.ok) throw new Error(`fixture did not resolve: ${r.reason}`);
    return { ...citation, contentHash: r.contentHash };
  };

  it('is fresh while the target still hashes to the audit-time stamp', () => {
    expect(genericCitationStaleReason(stamped({ kind: 'artifact', ref: 'rpt_abc123' }), LOOKUP)).toBeNull();
    expect(genericCitationStaleReason(stamped({ kind: 'work-item', ref: 'WI-42' }), LOOKUP)).toBeNull();
    expect(genericCitationStaleReason(stamped({ kind: 'external', url: 'https://example.com', snapshotHash: SNAPSHOT }), LOOKUP)).toBeNull();
  });

  it('marks the citing audit stale when the artifact content hash changed', () => {
    const citation = stamped({ kind: 'artifact', ref: 'rpt_abc123' });
    const edited = lookupOf({ 'report:rpt_abc123': found(bodyContentHash('# Findings (revised)\n')) });
    expect(genericCitationStaleReason(citation, edited, 4)).toBe('artifact rpt_abc123 changed since audit (audit #4)');
  });

  it('marks it stale when a cited work item was reopened or a measurement re-ran red', () => {
    const wi = stamped({ kind: 'work-item', ref: 'WI-42' });
    const reopened = lookupOf({ 'work-item:WI-42': found(workItemContentHash({ status: 'open' }), false) });
    expect(genericCitationStaleReason(wi, reopened)).toMatch(/no longer resolves: target_unsettled/);
    const run = stamped({ kind: 'measurement', ref: 'test-run:7' });
    const gone = lookupOf({ 'test-run:7': { found: false, contentHash: null, settled: false } });
    expect(genericCitationStaleReason(run, gone)).toMatch(/no longer resolves: target_not_found/);
  });

  it('treats a citation with no audit-time hash as stale, never as fresh', () => {
    expect(genericCitationStaleReason({ kind: 'artifact', ref: 'rpt_abc123' }, LOOKUP)).toMatch(/no audit-time content hash/);
  });

  it('loads the store state the hashes are computed from', async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      if (sql.includes('report_library')) return { rows: [{ report_id: 'rpt_abc123', body_md: '# Findings\n', retired_at: null }] };
      if (sql.includes('work_items')) return { rows: [{ feature_id: 'WI-42', status: 'open', closed_at: null, payload_completion: null }] };
      return { rows: [] };
    };
    const lookup = await loadGenericCitationLookup(
      [
        { kind: 'artifact', ref: 'rpt_abc123' },
        { kind: 'work-item', ref: 'WI-42' },
        { kind: 'measurement', ref: 'test-run:9' },
        { kind: 'code' },
      ],
      { query, workspaceId: 'ws' },
    );
    expect(calls).toHaveLength(3);
    expect(lookup.get('report:rpt_abc123')).toEqual(found(bodyContentHash('# Findings\n')));
    expect(lookup.get('work-item:WI-42')).toMatchObject({ found: true, settled: false });
    expect(lookup.get('test-run:9')).toMatchObject({ found: false });
  });
});
