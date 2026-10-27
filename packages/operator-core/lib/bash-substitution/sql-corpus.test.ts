/**
 * The SQL corpus — atomizer, matcher, and the corpus boundary
 * (plan `sql-escape-tool-routing-2026-08-12`, P-007).
 *
 * ── WHY THE CONTROLS ARE HERE, PERMANENTLY ───────────────────────────────────
 * A guard test that has never failed is a guard nobody has tested. Every claim
 * this file makes about "the matcher refuses X" is paired with a case the matcher
 * MUST claim, so a matcher that had quietly stopped claiming anything at all
 * would fail the positive cases rather than pass the negative ones. That pairing
 * is the calibration the repo's mutation-probe guidance asks for, kept in the
 * test file rather than performed by mutating the tree — the subject here is an
 * imported module, which is the tier where a permanent in-test control is the
 * correct instrument.
 */

import { describe, expect, it } from 'vitest';
import { auditPair, matchingAtoms } from './equivalence';
import { ALL_PAIRS, BASH_GATE_PAIRS } from './pairs';
import { normalizeSqlAtom, sqlAtomize, sqlPairClaimsAtom, SQL_CORPUS_TOOL } from './sql-corpus';
import { corpusOf, isSqlPair, patternFlagsOf, patternSourceOf } from './types';
import type { SampledCommand, SqlSubstitutionPair } from './types';
import { aggregateSqlDemand, observeSqlDemand, type SqlDemandSource, type SqlDemandCoverage } from './sql-intent-corpus';
import type { SqlIntentScope } from './sql-intent-fingerprint';

/**
 * A pair over a relation with genuinely uniform traffic: `db:migrations` covers a
 * plain read of the applied-migration ledger, and nothing else claims it.
 */
const migrationsPair: SqlSubstitutionPair = {
  id: 'sql.schema-migrations',
  intentLabel: 'applied-migration-lookup',
  corpus: 'sql',
  relation: 'schema_migrations',
  toolName: 'db:migrations',
  advisoryText: 'db:migrations { like } reads the applied ledger and names WHY a zero-row match is empty.',
  routing: {
    want: 'whether a migration has been applied',
    use: '`db:migrations { like }`',
    insteadOf: 'a raw `SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE …`',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string) {
    return /\bfilename\b/i.test(atom)
      ? { covered: true, expression: 'db:migrations { like: "…" }' }
      : { covered: false, reason: 'selects something other than the filename ledger' };
  },
};

/**
 * The CONTROL: a pair that names a relation nothing in the sample reads. It must
 * claim nothing. If it ever claims an atom, the matcher has stopped consulting
 * the relation at all — and every other assertion here would still be passing.
 */
const wrongRelationPair: SqlSubstitutionPair = {
  ...migrationsPair,
  id: 'sql.control-wrong-relation',
  intentLabel: 'control-should-never-match',
  relation: 'a_relation_no_query_reads',
};

const sample = (atom: string, sid = 'su-test'): SampledCommand => ({ sid, ts: '2026-08-12T00:00:00.000Z', atom });

describe('normalizeSqlAtom', () => {
  it('collapses whitespace so one shape written two ways is ONE distinct atom', () => {
    const multiline = normalizeSqlAtom('SELECT filename\n  FROM harness_shared.schema_migrations\n WHERE filename LIKE \'795%\';');
    const oneline = normalizeSqlAtom("SELECT filename FROM harness_shared.schema_migrations WHERE filename LIKE '795%'");
    expect(multiline).toBe(oneline);
    // ...and that shared value is the readable one, not a mangled join.
    expect(multiline).toBe("SELECT filename FROM harness_shared.schema_migrations WHERE filename LIKE '795%'");
  });

  it('keeps literals and comments — they are what cover() judges', () => {
    const atom = normalizeSqlAtom("SELECT * FROM routines -- gate health\n WHERE target_role = 'system:green-checkpoint'");
    expect(atom).toContain('-- gate health');
    expect(atom).toContain("'system:green-checkpoint'");
  });

  it('rejects an empty query and one past the matcher length cap', () => {
    expect(normalizeSqlAtom('   \n  ')).toBeNull();
    expect(normalizeSqlAtom(`SELECT '${'x'.repeat(5000)}'`)).toBeNull();
    // CONTROL: an ordinary query is not rejected by the same path.
    expect(normalizeSqlAtom('SELECT 1 FROM work_items')).not.toBeNull();
  });

  it('sqlAtomize yields zero or one atom, mirroring atomize()', () => {
    expect(sqlAtomize('   ')).toEqual([]);
    expect(sqlAtomize('SELECT 1 FROM work_items;')).toEqual(['SELECT 1 FROM work_items']);
  });
});

describe('sqlPairClaimsAtom', () => {
  it('claims a plain single-relation read of its own relation', () => {
    expect(
      sqlPairClaimsAtom(migrationsPair, "SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'"),
    ).toBe(true);
  });

  it('claims the BARE-named form too — the relation, not the spelling, is the key', () => {
    expect(sqlPairClaimsAtom(migrationsPair, 'SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 5')).toBe(true);
  });

  it('refuses another relation (the control pair claims nothing at all)', () => {
    const atom = 'SELECT filename FROM harness_shared.schema_migrations';
    expect(sqlPairClaimsAtom(migrationsPair, atom)).toBe(true);
    expect(sqlPairClaimsAtom(wrongRelationPair, atom)).toBe(false);
  });

  it('refuses ANALYTIC shapes — those are dev:pg_query working as intended', () => {
    // Each of these is a real reason no verb replaces the query, and each is
    // paired above with the plain read that IS claimed.
    expect(sqlPairClaimsAtom(migrationsPair, 'SELECT count(*) FROM harness_shared.schema_migrations')).toBe(false);
    expect(
      sqlPairClaimsAtom(migrationsPair, 'SELECT applied_at::date, count(*) FROM harness_shared.schema_migrations GROUP BY 1'),
    ).toBe(false);
    expect(
      sqlPairClaimsAtom(
        migrationsPair,
        'SELECT m.filename FROM harness_shared.schema_migrations m JOIN harness_shared.work_items w ON w.id = m.filename',
      ),
    ).toBe(false);
  });

  it('narrows with sqlShape when a relation carries more than one answer', () => {
    const shaped: SqlSubstitutionPair = { ...migrationsPair, sqlShape: /\bapplied_at\b/i };
    expect(sqlPairClaimsAtom(shaped, 'SELECT filename, applied_at FROM schema_migrations')).toBe(true);
    expect(sqlPairClaimsAtom(shaped, 'SELECT filename FROM schema_migrations')).toBe(false);
  });

  it('strips stateful flags from sqlShape — a /g pattern must not skip every other atom', () => {
    const sticky: SqlSubstitutionPair = { ...migrationsPair, sqlShape: /\bfilename\b/g };
    const atom = 'SELECT filename FROM schema_migrations';
    // Called repeatedly: a retained lastIndex would make the SECOND call false.
    expect(sqlPairClaimsAtom(sticky, atom)).toBe(true);
    expect(sqlPairClaimsAtom(sticky, atom)).toBe(true);
    expect(sqlPairClaimsAtom(sticky, atom)).toBe(true);
  });

  it('refuses an unparseable query rather than guessing a relation', () => {
    expect(sqlPairClaimsAtom(migrationsPair, 'SELECT 1')).toBe(false);
    expect(sqlPairClaimsAtom(migrationsPair, 'not sql at all')).toBe(false);
  });
});

describe('the shared audit harness runs on SQL pairs unchanged', () => {
  const corpus: SampledCommand[] = [
    sample("SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '79%'", 'su-a'),
    sample('SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 1', 'su-b'),
    sample('SELECT count(*) FROM harness_shared.schema_migrations', 'su-c'),
    sample("SELECT id, title FROM harness_shared.work_items WHERE state = 'open'", 'su-d'),
  ];

  it('matchingAtoms selects by relation, leaving analytics and other tables alone', () => {
    const claimed = matchingAtoms(migrationsPair, corpus).map((entry) => entry.atom);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((atom) => /schema_migrations/.test(atom))).toBe(true);
    expect(claimed.some((atom) => /count\(/.test(atom))).toBe(false);
  });

  it('auditPair derives a verdict from cover(), and records the CORPUS it measured', () => {
    const audit = auditPair(migrationsPair, corpus, { totalAtoms: 4_000, totalSessions: 40 });
    expect(audit.corpus).toBe('sql');
    expect(audit.verdict).toBe('equivalent');
    expect(audit.sampleSize).toBe(2);
    expect(audit.sessionCount).toBe(2);
    // The record names what it audited without inventing a shell pattern.
    expect(audit.bashPattern).toBe('relation:schema_migrations');
    expect(audit.bashPatternFlags).toBe('');
  });

  it('a SQL pair whose verb does NOT cover the shapes fails, exactly like a bash one', () => {
    // CONTROL for the assertion above: `equivalent` has to be earnable AND
    // losable, or it is not a measurement.
    const uncovering: SqlSubstitutionPair = {
      ...migrationsPair,
      cover: () => ({ covered: false, reason: 'db:migrations cannot express this predicate' }),
    };
    const audit = auditPair(uncovering, corpus, { totalAtoms: 4_000, totalSessions: 40 });
    expect(audit.verdict).toBe('not-a-substitute');
    expect(audit.failingCases[0]?.reason).toMatch(/cannot express/);
  });
});

describe('the corpus boundary', () => {
  it('every shipped pair declares a corpus, and patternSourceOf never invents a regex', () => {
    for (const pair of ALL_PAIRS) {
      expect(['bash', 'sql']).toContain(corpusOf(pair));
      expect(patternSourceOf(pair).length).toBeGreaterThan(0);
      if (isSqlPair(pair)) {
        // A SQL pair must not smuggle a shell pattern in through the flags path,
        // where a consumer could recompile it and match a command with it.
        expect(patternFlagsOf(pair)).toBe('');
        expect(patternSourceOf(pair).startsWith('relation:')).toBe(true);
      }
    }
  });

  it('NO SQL pair reaches the shell gate registry', () => {
    // The failure this prevents is silent: a SQL row in
    // `bash_tool_substitutions` is never enforced, but looks in the table
    // exactly like a row that is.
    expect(BASH_GATE_PAIRS.every((pair) => corpusOf(pair) === 'bash')).toBe(true);
    expect(BASH_GATE_PAIRS.length).toBe(ALL_PAIRS.filter((pair) => corpusOf(pair) === 'bash').length);
    // CONTROL: the gate set is not empty, so the assertion above is not vacuous.
    expect(BASH_GATE_PAIRS.length).toBeGreaterThan(0);
  });

  it('names the tool whose calls ARE this corpus', () => {
    expect(SQL_CORPUS_TOOL).toBe('dev:pg_query');
  });
});

const demandScope: SqlIntentScope = { workspaceId: 'discovery-workspace', sourceBoundary: 'authorized-corpus',
  epoch: '2026-10', key: new Uint8Array(32).fill(37) };
const completeCoverage: SqlDemandCoverage = { status: 'complete', scannedRows: 1, cap: 100,
  retention: 'complete', providers: ['codex', 'claude', 'omp'] };
const demandSource = (over: Partial<SqlDemandSource> = {}): SqlDemandSource => ({
  workspaceId: demandScope.workspaceId, harnessSlug: 'harness-a', namespace: 'native-session-a',
  callId: 'call-1', resultCallId: 'call-1', identityAuthority: 'provider', provider: 'codex',
  actor: 'su-agent-a', verifiedAgent: true, at: '2026-10-24T23:59:59Z', origin: 'agent', status: 'ok',
  durationMs: 20, sql: "SELECT id FROM jobs WHERE id='one'", sourceComplete: true, copyRef: 'transcript:1', ...over,
});
const summarize = (sources: SqlDemandSource[], scope = demandScope) =>
  aggregateSqlDemand(sources.map(s => observeSqlDemand(s, scope)), completeCoverage);

describe('SQL logical demand', () => {
  it('counts the SQL child once while preserving the pure parent copy OUTCOME-P-002', () => {
    const child = demandSource();
    const parent = demandSource({ origin: 'wrapper', copyRef: 'parent:1', resultCallId: null });
    const result = summarize([parent, child]);
    expect(result.logicalCalls).toBe(1);
    expect(result.copiesCollapsed).toBe(1);
    expect(result.daily[0]).toMatchObject({ logicalCalls: 1, status: 'ok', distinctAgents: 1,
      duration: { measured: 1, totalMs: 20 } });
    expect(result.daily[0]!.sourceTokens).toHaveLength(2);
    // Counterexample: a distinct call to the SAME SQL must remain a second operation.
    expect(summarize([parent, child, demandSource({ callId: 'call-2', resultCallId: 'call-2' })]).logicalCalls).toBe(2);
  });

  it('deduplicates canonical copies without merging independent same-text calls R22-DEDUP', () => {
    for (const provider of ['codex', 'claude', 'omp']) {
      const source = demandSource({ provider });
      const result = summarize([source, { ...source, copyRef: 'activity:1' }, { ...source, copyRef: 'tool-log:1' },
        { ...source, callId: 'call-2', resultCallId: 'call-2', copyRef: 'transcript:2' }]);
      expect(result).toMatchObject({ logicalCalls: 2, copiesCollapsed: 2, distinctAgents: 1 });
      expect(result.daily[0]!.duration.totalMs).toBe(40);
    }
  });

  it('pairs only exact source IDs, including interleaved same-actor calls R21-PAIRING', () => {
    for (const provider of ['codex', 'claude', 'omp']) {
      const rows = [demandSource({ provider }),
        demandSource({ provider, callId: 'call-2', resultCallId: 'call-3' }),
        demandSource({ provider, callId: 'call-3', resultCallId: null }),
        demandSource({ provider, callId: 'call-4', resultCallId: 'call-4', sourceComplete: false }),
        demandSource({ provider, callId: null, resultCallId: null })];
      const result = summarize(rows);
      expect(result.unknownIdentityRows).toBe(1);
      expect(result.unknownParseOperations).toBe(1);
      expect(result.daily.filter(r => r.status === 'ok').reduce((n, r) => n + r.logicalCalls, 0)).toBe(1);
      expect(result.daily.filter(r => r.status === 'unknown').reduce((n, r) => n + r.logicalCalls, 0)).toBe(2);
    }
  });

  it('keeps conflicting canonical identities UNKNOWN rather than borrowing a success R21-PAIRING', () => {
    const a = demandSource(), b = demandSource({ sql: 'SELECT name FROM jobs', copyRef: 'collision' });
    expect(summarize([a, b])).toMatchObject({ logicalCalls: 0, collisions: 1, unknownParseOperations: 1 });
    const conflict = summarize([a, { ...a, status: 'error', copyRef: 'conflicting-result' }]);
    expect(conflict.daily[0]!.status).toBe('unknown');
    expect(conflict.daily[0]!.duration.measured).toBe(0);
  });

  it('partitions polling/system/failures and counts verified agents across UTC dates R2-CONTRACT', () => {
    const rows = [demandSource(), demandSource({ callId: '2', resultCallId: '2', at: '2026-10-25T00:00:01Z', actor: 'su-agent-b' }),
      ...(['polling', 'system', 'test', 'fixture', 'replay', 'unknown'] as const).map(origin =>
        demandSource({ callId: origin, resultCallId: origin, origin })),
      demandSource({ callId: 'error', resultCallId: 'error', status: 'error' }),
      demandSource({ callId: 'denied', resultCallId: 'denied', status: 'refused' }),
      demandSource({ callId: 'unverified', resultCallId: 'unverified', actor: 'shared', verifiedAgent: false })];
    const result = summarize(rows);
    expect(result).toMatchObject({ logicalCalls: 4, distinctAgents: 2, activeDays: ['2026-10-24', '2026-10-25'] });
    expect(result.daily.find(r => r.origin === 'polling')?.logicalCalls).toBe(1);
    expect(result.daily.find(r => r.status === 'error')?.logicalCalls).toBe(1);
    expect(result.daily.find(r => r.status === 'refused')?.logicalCalls).toBe(1);
  });

  it('retains parse/coverage gaps and does not promote capped input to a full census R2-CONTRACT', () => {
    const rows = [observeSqlDemand(demandSource(), demandScope),
      observeSqlDemand(demandSource({ callId: 'bad', resultCallId: 'bad', sql: 'SELECT (' }), demandScope)];
    const coverage = { ...completeCoverage, status: 'truncated' as const, retention: 'gap' as const };
    expect(aggregateSqlDemand(rows, coverage)).toMatchObject({ logicalCalls: 1, unknownParseOperations: 1, coverage });
    expect(summarize([demandSource({ sql: "SELECT set_config('must_not_execute','1',false)" })]).unknownParseOperations).toBe(1);
  });

  it('isolates source/workspace/epoch/harness and emits no private SQL or raw identity R2-CONTRACT', () => {
    const source = demandSource({ sql: "SELECT id FROM private_jobs WHERE id='private-entity'" });
    const first = observeSqlDemand(source, demandScope);
    expect(observeSqlDemand({ ...source, harnessSlug: 'harness-b' }, demandScope).operationToken).not.toBe(first.operationToken);
    expect(observeSqlDemand(source, { ...demandScope, sourceBoundary: 'other-source' }).operationToken).not.toBe(first.operationToken);
    expect(observeSqlDemand(source, { ...demandScope, epoch: '2026-11' }).operationToken).not.toBe(first.operationToken);
    expect(() => observeSqlDemand(source, { ...demandScope, workspaceId: 'wrong' })).toThrow('invalid_sql_demand_scope');
    for (const text of ['private_jobs', 'private-entity', 'su-agent-a', 'native-session-a', 'transcript:1'])
      expect(JSON.stringify(summarize([source]))).not.toContain(text);
  });

  it('replaces overlapping observations deterministically and measures each operation cost once R2-CONTRACT', () => {
    const one = demandSource(), two = demandSource({ callId: '2', resultCallId: '2', durationMs: 40 });
    const once = summarize([one, two]), replay = summarize([one, two, one, two]);
    expect(replay.daily).toEqual(once.daily);
    expect(replay.logicalCalls).toBe(2);
    expect(replay.daily[0]!.duration).toEqual({ measured: 2, totalMs: 60, p50Ms: 20, p95Ms: 40 });
  });
});
