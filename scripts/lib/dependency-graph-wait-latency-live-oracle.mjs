// Oracle for the AUTO-BAR-R-19-P-009@3 live timing (event-wait-settlement-2026-10-20, WI-6554700010018160).
// Clause: the dependency-graph resolver, including the wait leg, returns within the pane's 10 s deadline on
// the papercusp harness. docs/evidence/ews-p009-r19-latency-live/run.mjs times the resolvers against the live
// operator database and runs negative controls; every pass/fail decision on a measurement is taken here, so
// it is unit-tested in dependency-graph-wait-latency-live-oracle.test.ts (which also pins the bar's deadline
// to the sync layer's resolver timeout in packages/operator-core/lib/sync-resolver/read-deadline.ts).

/** The deadline the bar states ("the pane's 10 s deadline"). Pinned to RESOLVER_READ_TIMEOUT_MS by the test. */
export const R19_BAR_DEADLINE_MS = 10_000;

/** Fewest timed runs a receipt may rest on; one fast run can be a warm-cache accident. */
export const R19_MIN_RUNS = 5;

/** Every assertion the oracle can fail, in evaluation order. */
export const R19_ASSERTIONS = [
  'min-runs',
  'operator-db',
  'graph-non-empty',
  'wait-leg-ran',
  'before-recorded',
  'within-deadline',
];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** `<dbname>@<port>` for a postgres connection string — the form the probe reads back from the server. */
export function expectedDbFromDsn(dsn) {
  const u = new URL(String(dsn));
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!name) throw new Error('connection string names no database');
  return `${name}@${u.port || '5432'}`;
}

/**
 * Judge one live measurement.
 * @param {{ db: unknown, expectedDb: unknown, deadlineMs: unknown, runs: unknown }} m
 *   runs[]: { edgesMs, edgesPlusWaitsMs, waitsAloneMs, edges, waits } — edgesMs is depEdges alone (what the pane
 *   loaded before the wait leg), edgesPlusWaitsMs is depEdges + depWaits concurrently (what it loads now).
 * @returns {{ ok: boolean, failedIds: string[], maxEdgesMs: number|null, maxEdgesPlusWaitsMs: number|null, maxWaitsAloneMs: number|null }}
 */
export function judgeR19(m) {
  const runs = Array.isArray(m?.runs) ? m.runs : [];
  const failed = new Set();

  if (runs.length < R19_MIN_RUNS) failed.add('min-runs');

  const expectedDb = typeof m?.expectedDb === 'string' ? m.expectedDb : '';
  if (!expectedDb || m?.db !== expectedDb) failed.add('operator-db');

  // A real harness graph was read: an empty graph would time nothing worth timing.
  if (runs.length === 0 || runs.some((r) => !finite(r?.edges) || r.edges <= 0)) failed.add('graph-non-empty');

  // The wait leg executed and returned rows, both alone and beside depEdges.
  if (
    runs.length === 0 ||
    runs.some((r) => !finite(r?.waitsAloneMs) || !finite(r?.edgesPlusWaitsMs) || !finite(r?.waits) || r.waits <= 0)
  ) {
    failed.add('wait-leg-ran');
  }

  // The "before" side of the before/after record: depEdges timed alone.
  if (runs.length === 0 || runs.some((r) => !finite(r?.edgesMs))) failed.add('before-recorded');

  // Every RECORDED timing is under the deadline. A missing timing is owned by wait-leg-ran / before-recorded, so
  // each negative control fails exactly the assertion it targets; with no timing at all this fails too.
  const deadline = m?.deadlineMs;
  const timings = runs.flatMap((r) => [r?.edgesMs, r?.edgesPlusWaitsMs, r?.waitsAloneMs]).filter(finite);
  if (!finite(deadline) || deadline <= 0 || timings.length === 0 || timings.some((t) => t >= deadline)) {
    failed.add('within-deadline');
  }

  const max = (k) => {
    const v = runs.map((r) => r?.[k]).filter(finite);
    return v.length ? Math.max(...v) : null;
  };
  const failedIds = R19_ASSERTIONS.filter((id) => failed.has(id));
  return {
    ok: failedIds.length === 0,
    failedIds,
    maxEdgesMs: max('edgesMs'),
    maxEdgesPlusWaitsMs: max('edgesPlusWaitsMs'),
    maxWaitsAloneMs: max('waitsAloneMs'),
  };
}
