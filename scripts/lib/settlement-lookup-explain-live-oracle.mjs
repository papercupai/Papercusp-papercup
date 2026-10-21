// Oracle for the AUTO-BAR-R-3-P-002@3 live probe (event-wait-settlement-2026-10-20, WI-6554700010018154).
// Clause: "The settlement lookup for a fired key reads the new wait-ref index on live-size data."
// Falsifier: EXPLAIN (ANALYZE, BUFFERS) of the settlement lookup on the live papercusp database shows a
// sequential scan of work_items, misses the wait-ref index migration 1539 added for it, or takes more than
// 10 ms (baseline 2026-10-20 before the index: ~98 ms).
// docs/evidence/ews-p002-r3-settlement-lookup-live-2026-10-20.mts captures the REAL lookup statements and
// runs EXPLAIN on them; every pass/fail decision on an EXPLAIN plan is taken here, so it is unit-tested in
// settlement-lookup-explain-live-oracle.test.ts (which also pins the index names to migration 1539).

export const R3_MAX_MS = 10;

// The settlement lookups the probe measures, and the index migration 1539 added for each.
export const R3_LOOKUPS = [
  { name: 'externalBlockers', index: 'work_items_external_blockers_gin_idx' },
  { name: 'durableParks', index: 'work_items_claim_hold_release_trigger_idx' },
];

const flat = (node) => [node, ...(node.Plans ?? []).flatMap(flat)];
const label = (n) =>
  `${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : ''}${n['Relation Name'] ? `[${n['Relation Name']}]` : ''}`;

/** Pull the top plan out of an `EXPLAIN (ANALYZE, FORMAT JSON)` result row set; refuse anything else. */
export function explainTop(rows) {
  const plan = Array.isArray(rows) ? rows[0]?.['QUERY PLAN'] : undefined;
  const top = Array.isArray(plan) ? plan[0] : undefined;
  if (!top || typeof top !== 'object' || !top.Plan || typeof top.Plan['Node Type'] !== 'string') {
    throw new Error('R-3: not an EXPLAIN (FORMAT JSON) result: no QUERY PLAN[0].Plan node');
  }
  if (typeof top['Execution Time'] !== 'number') {
    throw new Error('R-3: EXPLAIN result has no Execution Time; run it with ANALYZE');
  }
  return top;
}

/** Judge one lookup's EXPLAIN plan against the clause falsifier. */
export function judgeLookup(top, { index, maxMs = R3_MAX_MS }) {
  const nodes = flat(top.Plan);
  const seqScanOnWorkItems = nodes.some((n) => n['Node Type'].includes('Seq Scan') && n['Relation Name'] === 'work_items');
  const indexes = nodes.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));
  const executionMs = top['Execution Time'];
  const assertions = [
    {
      id: 'no-seq-scan-on-work-items',
      passed: !seqScanOnWorkItems,
      evidence: seqScanOnWorkItems ? 'plan has a Seq Scan on work_items' : 'no Seq Scan on work_items',
    },
    {
      id: 'reads-wait-ref-index',
      passed: indexes.includes(index),
      evidence: `plan reads ${indexes.length ? indexes.join(', ') : 'no index'}; expected ${index}`,
    },
    {
      id: 'within-threshold',
      passed: executionMs <= maxMs,
      evidence: `execution ${executionMs} ms, threshold ${maxMs} ms`,
    },
  ];
  return {
    passed: assertions.every((a) => a.passed),
    executionMs,
    seqScanOnWorkItems,
    indexes,
    nodes: nodes.map(label),
    sharedHitBlocks: top.Plan['Shared Hit Blocks'],
    sharedReadBlocks: top.Plan['Shared Read Blocks'],
    assertions,
  };
}

/** Judge the whole reading: every lookup in R3_LOOKUPS must be present and pass. */
export function judgeR3(byName, { maxMs = R3_MAX_MS } = {}) {
  const results = {};
  for (const { name, index } of R3_LOOKUPS) {
    if (!byName[name]) throw new Error(`R-3: no EXPLAIN plan for lookup ${name}`);
    results[name] = judgeLookup(byName[name], { index, maxMs });
  }
  return { passed: Object.values(results).every((r) => r.passed), results };
}
