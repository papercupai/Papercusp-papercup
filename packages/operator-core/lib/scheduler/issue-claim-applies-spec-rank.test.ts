/**
 * issue-claim-applies-spec-rank.test.ts — the issue-family claim door must APPLY the caller's
 * compiled `spec.rank`, and the tier-3 call site must THREAD it down.
 *
 * WHY THIS EXISTS (EI-19497592871345016). `claimNextIssueWorkItem`'s ORDER BY was hardcoded to
 * `feature_order ASC NULLS LAST, created_ts ASC` while the SAME query already honored the
 * caller's compiled `spec.view.filter`. So a claim spec could NARROW the issue family but never
 * REORDER it — and since `feature_order` is NULL across the issue pool, the effective order was
 * plain OLDEST-FIRST. The `severity_rank` term added to DEFAULT_CLAIM_SPEC by
 * EI-19286355119013384 was therefore INERT for the family its own comment says it was written
 * for: it reaches only the feature-family tiers 1/2, and the issue family is served exclusively
 * by tier 3.
 *
 * The BEHAVIOURAL half is work-items-issue-claim-spec-rank.integration.test.ts (real Postgres:
 * a newer critical must be served ahead of an older minor, with a no-spec control arm on the
 * same seed data proving the fallback is genuinely oldest-first). That test proves the ORDER BY
 * RESPONDS to `specOrderSql`. It cannot prove the tier-3 CALL SITE still passes one — remove
 * that single property and the integration test's spec arm keeps passing only because it calls
 * `claimNextIssueWorkItem` directly. This file closes exactly that gap.
 *
 * Static: no database, milliseconds, and it fails on the REMOVAL of the wiring rather than on
 * the next "why is the queue serving me month-old minors" incident.
 *
 * ⚠ Scope note, in the spirit of claim-door-census.test.ts's D-008: this asserts only that the
 * spec's rank REACHES the query. It deliberately says nothing about WHICH ordering is correct —
 * that is DEFAULT_CLAIM_SPEC's policy call (severity before priority before age), asserted
 * behaviourally in the integration sibling. A static test that pinned the term order would
 * fail working code the moment that policy is legitimately retuned.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIB_ROOT = resolve(__dirname, '..');
const WORK_ITEMS_TS = resolve(LIB_ROOT, 'work-items.ts');
const GET_NEXT_TS = resolve(LIB_ROOT, 'scheduler/get-next.ts');

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * The ORDER BY of the issue-family claim query. Anchored on the UPDATE against
 * `harness_shared.work_items` so it cannot accidentally match the feature-family query in the
 * same module (which targets harness_features_consolidated and is correctly NOT spec-ranked
 * here — get-next.ts tiers 1/2 rank that family themselves).
 */
function issueClaimOrderByClause(src: string): string {
  // Anchor on the FUNCTION, not on the `UPDATE harness_shared.work_items` text — that string
  // occurs several times in this module, and anchoring on its first occurrence lands in an
  // unrelated query (caught by this file's own CONTROL case on first run).
  const fnIdx = src.indexOf('export async function claimNextIssueWorkItem');
  expect(fnIdx, 'claimNextIssueWorkItem should exist in work-items.ts').toBeGreaterThan(-1);
  const orderIdx = src.indexOf('ORDER BY', fnIdx);
  expect(orderIdx, 'the issue-family claim query should have an ORDER BY').toBeGreaterThan(-1);
  const limitIdx = src.indexOf('LIMIT', orderIdx);
  expect(limitIdx, 'the ORDER BY should be followed by a LIMIT').toBeGreaterThan(orderIdx);
  return src.slice(orderIdx, limitIdx);
}

/** The opts object literal passed at get-next.ts's tier-3 `claimNextIssueWorkItem(` call. */
function tierThreeCallOpts(src: string): string {
  const callIdx = src.indexOf('claimed = await claimNextIssueWorkItem(');
  expect(callIdx, "get-next.ts's tier-3 claim call should exist").toBeGreaterThan(-1);
  const end = src.indexOf(');', callIdx);
  return src.slice(callIdx, end);
}

describe('the issue-family claim query applies the caller’s compiled spec.rank', () => {
  it('its ORDER BY references specOrderSql (not a hardcoded ordering)', () => {
    const clause = issueClaimOrderByClause(read(WORK_ITEMS_TS));
    expect(clause).toContain('specOrderSql');
  });

  it('retains a fallback ordering for the no-spec caller (legacy claimNextWorkItem tier 3)', () => {
    // The legacy door passes no spec, so removing the fallback would make its ordering
    // undefined rather than oldest-first. Both halves must be present.
    const clause = issueClaimOrderByClause(read(WORK_ITEMS_TS));
    expect(clause).toContain('created_ts ASC');
  });

  it('CONTROL: the same clause still carries the swarm-affinity leg', () => {
    // Calibration for the extractor above — if `issueClaimOrderByClause` ever drifted onto the
    // wrong query (or returned an empty slice), this control fails too, so a green result from
    // the two assertions above cannot be an artifact of matching nothing.
    const clause = issueClaimOrderByClause(read(WORK_ITEMS_TS));
    expect(clause).toContain('swarm_affinity');
  });
});

describe('get-next.ts tier 3 threads the compiled rank down to the issue door', () => {
  it('passes specOrderSql in the opts it hands claimNextIssueWorkItem', () => {
    expect(tierThreeCallOpts(read(GET_NEXT_TS))).toContain('specOrderSql');
  });

  it('CONTROL: it also still passes specFilterSql', () => {
    // The filter has been threaded since WI-5258 and is not what this file is about — it is
    // here as the control that proves `tierThreeCallOpts` is reading a real, populated opts
    // object rather than an empty slice that would make the assertion above vacuously green.
    expect(tierThreeCallOpts(read(GET_NEXT_TS))).toContain('specFilterSql');
  });

  it('compiles the rank from the spec actually selecting the claim', () => {
    const src = read(GET_NEXT_TS);
    expect(src).toMatch(/const\s+specOrderSql\s*=\s*compileRank\(/);
  });

  it('attributes the injected pool on the operation-read and feature-candidate transactions', () => {
    const src = read(GET_NEXT_TS);
    const operationStart = src.indexOf('const operationClaimRead = await boundedOrgTxn(');
    const operationEnd = src.indexOf('  if (operationClaimRead.status', operationStart);
    expect(operationStart).toBeGreaterThan(-1);
    expect(src.slice(operationStart, operationEnd)).toContain('acquirePool: opts.acquirePool');

    const attemptStart = src.indexOf('const attempt = async');
    const candidateStart = src.indexOf('const rows = await boundedOrgTxn(', attemptStart);
    const candidateEnd = src.indexOf('      );\n      return rows[0]', candidateStart);
    expect(candidateStart).toBeGreaterThan(-1);
    expect(src.slice(candidateStart, candidateEnd)).toContain('acquirePool: opts.acquirePool');
  });

  it('forwards injected-pool attribution through both issue-tier call paths and transaction', () => {
    const getNext = read(GET_NEXT_TS);
    const claimIssueStart = getNext.indexOf('const claimIssue =');
    const claimIssueEnd = getNext.indexOf('// The normal ladder', claimIssueStart);
    expect(claimIssueStart).toBeGreaterThan(-1);
    expect(getNext.slice(claimIssueStart, claimIssueEnd)).toContain('acquirePool: opts.acquirePool');
    expect(tierThreeCallOpts(getNext)).toContain('acquirePool: opts.acquirePool');

    const workItems = read(WORK_ITEMS_TS);
    const issueClaimStart = workItems.indexOf('export async function claimNextIssueWorkItem(');
    const issueTxnStart = workItems.indexOf('const claimed = await measureResolutionStep', issueClaimStart);
    const issueTxnEnd = workItems.indexOf(').catch(async (error)', issueTxnStart);
    expect(issueClaimStart).toBeGreaterThan(-1);
    expect(workItems.slice(issueTxnStart, issueTxnEnd)).toContain('acquirePool: opts.acquirePool');
  });
});
