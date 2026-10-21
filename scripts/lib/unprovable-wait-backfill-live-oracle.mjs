// Oracle for the AUTO-BAR-R-12-P-006@3 live probe (event-wait-settlement-2026-10-20, WI-6554700010018158).
// Clause: every pre-existing active event blocker on an unprovable ref carries a re-check date after the
// backfill. docs/evidence/ews-p006-r12-backfill-live/run.mjs runs the probe and its negative controls; every
// pass/fail decision on a probe row is taken here, so it is unit-tested in
// unprovable-wait-backfill-live-oracle.test.ts (which also pins the probe's literal lists to the code).

export const R12_COLUMNS = [
  'active_waits',
  'stamped',
  'proving_concrete',
  'announced_live',
  'announced_fired',
  'unprovable_unstamped',
  'backfill_stamped_rows',
  'backfill_cleared',
  'stamped_inactive_unattributed',
];
const BUCKETS = ['stamped', 'proving_concrete', 'announced_live', 'announced_fired', 'unprovable_unstamped'];

/** Parse one `psql -At` row (pipe-separated) into named integer counts; refuse anything malformed. */
export function parseR12Row(line) {
  const text = String(line ?? '').trim();
  const parts = text.split('|');
  if (parts.length !== R12_COLUMNS.length) {
    throw new Error(`R-12 probe row must have ${R12_COLUMNS.length} fields, got ${parts.length}: ${JSON.stringify(text)}`);
  }
  const row = {};
  R12_COLUMNS.forEach((col, i) => {
    if (!/^\d+$/.test(parts[i])) throw new Error(`R-12 probe field ${col} is not a count: ${JSON.stringify(parts[i])}`);
    row[col] = Number(parts[i]);
  });
  return row;
}

/** Judge a parsed probe row. Passes only if every assertion passes. */
export function judgeR12(row) {
  const bucketSum = BUCKETS.reduce((n, b) => n + row[b], 0);
  const assertions = [
    {
      id: 'every-wait-classified-once',
      passed: bucketSum === row.active_waits,
      evidence: `${BUCKETS.map((b) => `${b}=${row[b]}`).join(' + ')} = ${bucketSum}; active_waits=${row.active_waits}`,
    },
    {
      id: 'no-unprovable-unstamped',
      passed: row.unprovable_unstamped === 0,
      evidence: `unprovable_unstamped=${row.unprovable_unstamped} (active event/gate rows with no re-check date that are neither a concrete condition-proving key nor announced)`,
    },
    {
      id: 'none-cleared-by-backfill',
      passed: row.backfill_cleared === 0,
      evidence: `backfill_cleared=${row.backfill_cleared} (rows whose clearedBy is system:unprovable-wait-backfill)`,
    },
    {
      id: 'no-unattributed-clear',
      passed: row.stamped_inactive_unattributed === 0,
      evidence: `stamped_inactive_unattributed=${row.stamped_inactive_unattributed} (backfill-stamped rows no longer active with no clearedBy)`,
    },
    {
      id: 'backfill-observed',
      passed: row.backfill_stamped_rows >= 1,
      evidence: `backfill_stamped_rows=${row.backfill_stamped_rows} (rows whose recheckSource is system:unprovable-wait-backfill)`,
    },
  ];
  return { passed: assertions.every((a) => a.passed), assertions };
}

/** The terminal-state literal the probe filters on (marker `/*@terminal*\/`). */
export function probeTerminalStates(probeSql) {
  const m = /ARRAY\[([^\]]*)\]::text\[\]\)\) \/\*@terminal\*\//.exec(String(probeSql));
  if (!m) throw new Error('probe has no /*@terminal*/ state list');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

/** The condition-proving family list in the probe's concrete-key regex (marker `/*@concrete*\/`). */
export function probeConditionFamilies(probeSql) {
  const m = /~ '\^\(([^)]*)\):\\S\+\$' \/\*@concrete\*\//.exec(String(probeSql));
  if (!m) throw new Error('probe has no /*@concrete*/ family list');
  return m[1].split('|');
}
