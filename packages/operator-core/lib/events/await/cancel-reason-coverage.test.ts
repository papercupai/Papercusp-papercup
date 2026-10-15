/**
 * Recurrence guard for WI-10005938's CLASS: every UPDATE that cancels an
 * event_awaits row must stamp a non-null cancel_reason.
 *
 * Why it matters: goal-holder-behavior-metrics measures reminder delivery and
 * counts `cancel_reason IS NULL` as unexplained churn. In one measured 2h
 * goal-holder window, 22 agent-obligation watches were retired by
 * re-registration and 18 more by generic cleanup paths with no reason, so the
 * nudge-efficacy criterion could not be shown either way. The fix gave every
 * path a reason (cancel-reasons.ts); this test keeps a new path from
 * reintroducing NULL.
 *
 * Self-match: the scan reads non-test source only, and the fixtures below are
 * assembled from fragments at runtime, so this file cannot be its own subject.
 * Set CANCEL_REASON_SCAN_ROOT to scan a copy of the tree (mutation probing).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { presentOnDisk } from '../../../../../scripts/lib/tracked-files.mjs';

const TABLE = ['harness_shared', 'event_awaits'].join('.');

/**
 * One UPDATE of the awaits table: the table, an optional alias, then SET up to
 * the first WHERE. Requiring SET right after the table keeps prose that merely
 * names the table from matching; the span cap keeps a stray match from running
 * across unrelated code.
 */
const UPDATE_STATEMENT = new RegExp(
  String.raw`UPDATE\s+` + TABLE.replace('.', String.raw`\.`) + String.raw`(?:\s+(?:AS\s+)?\w+)?\s+SET\b([\s\S]{0,800}?)\bWHERE\b`,
  'g',
);

export interface ReasonlessCancel {
  line: number;
  problem: 'no-cancel-reason' | 'nullable-cancel-reason';
  setClause: string;
}

export interface CancelScan {
  /** UPDATE statements whose SET clause assigns cancelled_at. */
  cancelStatements: number;
  violations: ReasonlessCancel[];
}

export function scanCancelReasons(source: string): CancelScan {
  const violations: ReasonlessCancel[] = [];
  let cancelStatements = 0;
  for (const match of source.matchAll(UPDATE_STATEMENT)) {
    const setClause = match[1] ?? '';
    if (!/\bcancelled_at\s*=/.test(setClause)) continue;
    cancelStatements += 1;
    const line = source.slice(0, match.index ?? 0).split('\n').length;
    const reason = /\bcancel_reason\s*=\s*(\$\{[^}]*\}|[^,\n]*)/.exec(setClause);
    if (!reason) {
      violations.push({ line, problem: 'no-cancel-reason', setClause: setClause.trim() });
    } else if (/\bnull\b/i.test(reason[1] ?? '')) {
      violations.push({ line, problem: 'nullable-cancel-reason', setClause: setClause.trim() });
    }
  }
  return { cancelStatements, violations };
}

function repoRoot(): string {
  const override = process.env.CANCEL_REASON_SCAN_ROOT;
  if (override) return override;
  const here = fileURLToPath(new URL('.', import.meta.url));
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
}

function sourceFiles(root: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages/*.ts', 'packages/*.mts', 'apps/*.ts', 'apps/*.mts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const candidates = listed
    .split('\0')
    .filter(Boolean)
    .filter((p) => !/\.(test|spec)\.m?ts$/.test(p))
    .filter((p) => !/(^|\/)(test|__tests__|dist|dist-host|node_modules)\//.test(p));
  return presentOnDisk(candidates, root);
}

const stmt = (set: string, alias = '') => `await sql\`\n  UPDATE ${TABLE}${alias}\n     SET ${set}\n   WHERE id = \${id}\n\`;`;

describe('scanCancelReasons (fixtures)', () => {
  it('flags a cancel that stamps no reason', () => {
    const scan = scanCancelReasons(stmt('cancelled_at = now()'));
    expect(scan.cancelStatements).toBe(1);
    expect(scan.violations.map((v) => v.problem)).toEqual(['no-cancel-reason']);
  });

  it('flags a reason expression that can fall back to null', () => {
    const scan = scanCancelReasons(stmt("cancelled_at = now(), cancel_reason = ${src === 'operator' ? 'operator' : null}"));
    expect(scan.violations.map((v) => v.problem)).toEqual(['nullable-cancel-reason']);
    expect(scanCancelReasons(stmt('cancelled_at = now(), cancel_reason = ${input.reason ?? null}')).violations).toHaveLength(1);
  });

  it('accepts a cancel with a non-null reason, including an aliased table and a multi-line SET', () => {
    expect(scanCancelReasons(stmt('cancelled_at = now(), cancel_reason = ${R.ownerReaped}')).violations).toEqual([]);
    expect(
      scanCancelReasons(stmt("cancelled_at = now(),\n         cancel_reason = ${a ? 'operator' : R.internal}", ' AS a')).violations,
    ).toEqual([]);
  });

  it('ignores UPDATEs that do not cancel, and prose that only names the table', () => {
    const scan = scanCancelReasons(
      [stmt('fired_at = now()'), stmt('subscriber_id = ${t}, event_key = ${k}'), `// every UPDATE ${TABLE} must stamp a reason; see WHERE below`].join('\n'),
    );
    expect(scan.cancelStatements).toBe(0);
    expect(scan.violations).toEqual([]);
  });
});

describe('event_awaits cancel paths in the real tree', () => {
  it('every UPDATE that sets cancelled_at also sets a non-null cancel_reason', () => {
    const root = repoRoot();
    const files = sourceFiles(root);
    let cancelStatements = 0;
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      if (!source.includes(TABLE)) continue;
      const scan = scanCancelReasons(source);
      cancelStatements += scan.cancelStatements;
      for (const v of scan.violations) violations.push(`${file}:${v.line} ${v.problem}: SET ${v.setClause.replace(/\s+/g, ' ')}`);
    }
    // Calibration: the scan must actually see the known cancel paths (store.ts,
    // compose-store.ts, the idle-session reaper, rebind-identity). A broken
    // instrument would otherwise pass vacuously with zero statements found.
    expect(files.length).toBeGreaterThan(1000);
    expect(cancelStatements).toBeGreaterThanOrEqual(14);
    expect(violations).toEqual([]);
  });
});
