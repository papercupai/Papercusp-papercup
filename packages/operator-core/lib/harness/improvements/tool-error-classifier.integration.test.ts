/**
 * tool-error-classifier.integration.test.ts — the anti-drift guarantee with
 * TEETH (watchdog-and-exposed-systems-improvement-2026-06-18 P-011/P-012).
 *
 * The TS classifier and the watchdog's in-DB classification are GENERATED from
 * one rule table, so they can't drift by construction. This test PROVES it
 * against a real Postgres: it runs the GENERATED `toolErrorClassSqlCase` (real
 * `~*` POSIX-ERE) and `toolErrorFingerprintSqlCase` over the SAME fixture corpus
 * the unit test uses, and asserts row-by-row agreement with `classifyToolError`
 * / `toolErrorFingerprint`. If the SQL `~*` and the JS `RegExp` ever diverge on a
 * real shape (the bug class P-011 closes), this goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  classifyToolError,
  toolErrorFingerprint,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  FINGERPRINTED_TOOL_ERROR_CLASSES,
} from './tool-error-classifier';
import { collectToolErrorSignals } from './watchdog';
import { TOOL_ERROR_CORPUS } from './tool-error-corpus.fixture';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  await db.adminSql`
    CREATE TEMP TABLE tool_err_corpus (
      idx int, error_code text, status text, error_message text
    )`;
  for (const [idx, r] of TOOL_ERROR_CORPUS.entries()) {
    await db.adminSql`
      INSERT INTO tool_err_corpus (idx, error_code, status, error_message)
      VALUES (${idx}, ${r.errorCode}, ${r.status}, ${r.message})`;
  }
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('generated SQL CASE ↔ classifyToolError parity (P-011)', () => {
  it('prefers the primary exact error code over a conflicting secondary message match', async () => {
    const sql = db.adminSql;
    const rows = await sql<{ ord: number; error_code: string; klass: string }[]>`
      SELECT mixed.ord, mixed.error_code, ${toolErrorClassSqlCase(sql)} AS klass
        FROM (VALUES
          (
            1,
            'structured_result_shape'::text,
            'error'::text,
            'code:run returned a typed root; secondary text: superuser_native_session_verifier_unavailable'::text
          ),
          (
            2,
            'superuser_native_session_verifier_unavailable'::text,
            'error'::text,
            'secondary script text mentions structured_result_shape typed root'::text
          )
        ) AS mixed(ord, error_code, status, error_message)
       ORDER BY mixed.ord
    `;

    expect(rows).toEqual([
      { ord: 1, error_code: 'structured_result_shape', klass: 'caller' },
      { ord: 2, error_code: 'superuser_native_session_verifier_unavailable', klass: 'transient' },
    ]);
  });

  it('classifies capability:git-evidence cancellation as caller control flow in generated SQL', async () => {
    const sql = db.adminSql;
    const message =
      'git_command_interrupted: git ls-tree -z 26dba0b0757c551cd1590b6abec54a9e94ebe6da -- ' +
      'packages/operator-ui/src/onboarding/product-tutorial.test.tsx was aborted before returning a result';
    const rows = await sql<{ klass: string }[]>`
      SELECT ${toolErrorClassSqlCase(sql)} AS klass
        FROM (VALUES ('handler_error'::text, 'error'::text, ${message}::text))
             AS interrupted(error_code, status, error_message)
    `;
    expect(rows).toEqual([{ klass: 'caller' }]);
  });

  it('classifies every corpus row identically in SQL and TS', async () => {
    const sql = db.adminSql;
    const rows = await sql<{ idx: number; error_code: string | null; status: string; error_message: string | null; klass: string }[]>`
      SELECT idx, error_code, status, error_message, ${toolErrorClassSqlCase(sql)} AS klass
        FROM tool_err_corpus
       ORDER BY idx`;
    expect(rows.length).toBe(TOOL_ERROR_CORPUS.length);

    const disagreements: string[] = [];
    for (const row of rows) {
      const ts = classifyToolError(row.error_code, row.status, row.error_message);
      if (ts !== row.klass) {
        disagreements.push(`idx=${row.idx} code=${row.error_code} status=${row.status}: SQL=${row.klass} TS=${ts} :: ${String(row.error_message).slice(0, 60)}`);
      }
      // …and both must equal the pinned expected class.
      expect(row.klass).toBe(TOOL_ERROR_CORPUS[row.idx].expectedClass);
    }
    expect(disagreements).toEqual([]);
  });
});

describe('generated SQL fingerprint ↔ toolErrorFingerprint parity (P-012)', () => {
  it('computes the same fingerprint (and null-for-coarse-classes) in SQL and TS', async () => {
    const sql = db.adminSql;
    // The fingerprint CASE references `class` + `error_message`, so classify first.
    const rows = await sql<{ idx: number; klass: string; fingerprint: string | null }[]>`
      SELECT idx, class AS klass, ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM (
          SELECT idx, error_message, ${toolErrorClassSqlCase(sql)} AS class
            FROM tool_err_corpus
        ) f
       ORDER BY idx`;

    const disagreements: string[] = [];
    for (const row of rows) {
      const message = TOOL_ERROR_CORPUS[row.idx].message;
      const tsFingerprint = FINGERPRINTED_TOOL_ERROR_CLASSES.has(row.klass as never)
        ? toolErrorFingerprint(message)
        : null;
      const sqlFp = row.fingerprint ?? null;
      if (sqlFp !== tsFingerprint) {
        disagreements.push(`idx=${row.idx} class=${row.klass}: SQL=${sqlFp} TS=${tsFingerprint} :: ${message.slice(0, 60)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('keeps distinct lock failures with a shared boilerplate prefix on separate keys', async () => {
    const sql = db.adminSql;
    const messages = [
      'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
        'No edit attempted. Reconcile authoritative lock for crates/papercup-core/tests/android_uniffi_abi_guard.rs in mobile coordination_domain before writing or retrying.',
      'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
        'No edit attempted. Reconcile authoritative lock for packages/operator-core/lib/agent-tools/improvements/capture.test.ts in papercusp coordination before writing or retrying.',
    ];
    const rows = await sql<{ ord: number; fingerprint: string | null }[]>`
      SELECT input.ord, ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM (VALUES
          (1, 'transient'::text, ${messages[0]}::text),
          (2, 'transient'::text, ${messages[1]}::text)
        ) AS input(ord, class, error_message)
       ORDER BY input.ord`;

    expect(rows.map((row) => row.fingerprint)).toEqual(messages.map(toolErrorFingerprint));
    expect(rows[0]?.fingerprint).not.toBe(rows[1]?.fingerprint);
  });

  it('rate-limit rows are NEVER fingerprinted in SQL (kept coarse)', async () => {
    const sql = db.adminSql;
    const rows = await sql<{ fingerprint: string | null }[]>`
      SELECT ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM (
          SELECT error_message, ${toolErrorClassSqlCase(sql)} AS class
            FROM tool_err_corpus
        ) f
       WHERE class = 'rate-limit'`;
    expect(rows.length).toBeGreaterThan(0); // the corpus has rate-limit rows
    expect(rows.every((r) => r.fingerprint === null)).toBe(true);
  });
});

describe('the FULL collectToolErrorSignals query embeds the generated fragments validly (P-011)', () => {
  it('runs against real PG without a syntax error and emits new-shape fingerprinted keys', async () => {
    const sql = db.adminSql;
    // Two distinct caller modes + a timeout under the SAME tool — pre-P-012 these
    // collapsed onto one `:caller` / `:transient` key; the generated SQL must now
    // split the caller modes apart by fingerprint and run the whole CTE cleanly.
    // Counts are above the per-class FIRE bars (caller ≥10, transient ≥15) so the
    // signals actually fire; the two caller modes share the SAME tool so only the
    // fingerprint splits them (the P-012 win).
    const seed: { tool: string; status: string; code: string | null; msg: string; n: number }[] = [
      { tool: 'plans:new', status: 'error', code: null, msg: 'invalid_args: note: Too big: expected string to have <=400 characters', n: 11 },
      { tool: 'plans:new', status: 'error', code: 'handler_error', msg: 'invalid_args: status: Invalid option: expected one of "draft"|"ready"', n: 11 },
      { tool: 'tools:invoke', status: 'error', code: 'handler_error', msg: 'invalid_input: invalid_args: Unrecognized key: "workspace"', n: 11 },
      { tool: 'tools:invoke', status: 'error', code: 'handler_error', msg: 'role_not_allowed: Role "judge" cannot call tool "sessions:search" (allowed roles: operator)', n: 11 },
      { tool: 'plans:list', status: 'timeout', code: null, msg: 'tool "plans:list" exceeded timeout of 60s (handler returned but signal had aborted)', n: 16 },
      {
        tool: 'capability:git-evidence', status: 'error', code: 'handler_error',
        msg: 'git_command_interrupted: git ls-tree -z 26dba0b0757c551cd1590b6abec54a9e94ebe6da -- ' +
          'packages/operator-ui/src/onboarding/product-tutorial.test.tsx was aborted before returning a result',
        n: 2,
      },
    ];
    for (const s of seed) {
      for (let k = 0; k < s.n; k++) {
        await sql`
          INSERT INTO harness_shared.tool_invocations
            (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, error_code, error_message, invoked_at)
          VALUES ('*', '', '', ${s.tool}, 'su', '', '', ${s.status}, ${s.code}, ${s.msg}, now())`;
      }
    }

    const signals = await collectToolErrorSignals(sql, { toolLatencyBudgets: SEED_LATENCY_BUDGETS });
    expect(Array.isArray(signals)).toBe(true);
    const keys = signals.map((s) => s.key);
    // the two caller modes split into distinct fingerprinted keys (P-012)…
    const expectedFingerprintedKeys = seed.slice(0, 4).map((sample) =>
      `${sample.tool}:${classifyToolError(sample.code, sample.status, sample.msg)}:${toolErrorFingerprint(sample.msg)}`);
    for (const expected of expectedFingerprintedKeys) expect(keys).toContain(expected);
    expect(new Set(expectedFingerprintedKeys).size).toBe(4);
    // …and the timeout is a fingerprinted transient key.
    expect(keys.some((k) => k.startsWith('plans:list:transient:'))).toBe(true);
    // The same two cancellation rows that met the structural count floor must not
    // re-enter the auto-implementation lane as a false major bug.
    expect(keys.some((k) => k.startsWith('capability:git-evidence:structural:'))).toBe(false);
  });

  it('excludes marked dispatch-wrapper rows from both the failure count and per-tool denominator (P-012)', async () => {
    const sql = db.adminSql;
    // This integration fixture owns a throwaway database. Clear the earlier
    // rows so this exact per-tool denominator is isolated and reproducible.
    await sql`DELETE FROM harness_shared.tool_invocations`;

    const tool = 'tools:invoke';
    const message = 'column "initiative" does not exist';
    const wrapperMetadata = {
      dispatchWrapper: true,
      dispatchedTool: 'dev:session_detail',
      childFailureRefs: ['dev:session_detail'],
    };
    const insert = async (status: 'ok' | 'error', metadata?: typeof wrapperMetadata) => {
      await sql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
           status, error_code, error_message, invoked_at, metadata_json)
        VALUES (
          '*', '', '', ${tool}, 'su', '', '', ${status},
          ${status === 'error' ? 'handler_error' : null},
          ${status === 'error' ? message : null}, now(), ${metadata ? sql.json(metadata) : null}
        )`;
    };

    for (let i = 0; i < 3; i++) await insert('error');
    await insert('ok');
    for (let i = 0; i < 10; i++) await insert('ok', wrapperMetadata);
    for (let i = 0; i < 2; i++) await insert('error', wrapperMetadata);

    // With wrappers removed the real calls are 3/4 (75%), so the rate bar
    // fires despite the raised count bar. Counting wrapper errors yields 5/16
    // and crosses only the count bar; counting wrapper successes alone dilutes
    // the real rate below 50% and suppresses the signal.
    const signals = await collectToolErrorSignals(sql, {
      structuralMinCount: 5,
      toolLatencyBudgets: SEED_LATENCY_BUDGETS,
    });
    const signal = signals.find((s) => s.key.startsWith('tools:invoke:structural'));
    expect(signal?.body).toContain('3× (75% of 4 calls)');
  });
});

// A non-empty registry stand-in. The collector WARNS when the live registry yields no write
// tools (a blind detector must be a logged fact), and these fixtures run without the tool
// catalog loaded, so the cases above seed one inert write tool through the documented seam.
const SEED_LATENCY_BUDGETS = new Map([['x:never-invoked-write', { timeoutSec: null, effect: 'write' }]]);

describe('tool-latency-budget against real PG (WI-10005730)', () => {
  const seedCalls = async (tool: string, durationsMs: number[], status = 'ok') => {
    const sql = db.adminSql;
    for (const duration of durationsMs) {
      await sql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
           status, duration_ms, invoked_at)
        VALUES ('*', '', '', ${tool}, 'su', '', '', ${status}, ${duration}, now())`;
    }
  };
  // 25 calls: 24 fast + 1 at `slow`. percentile_cont(0.95) sits at position 0.95×24 = 22.8
  // (0-based), i.e. between the 23rd and 24th sorted values — both fast — so one outlier
  // cannot move p95. That is the property that makes p95 (not max) the right statistic.
  const tail = (fast: number, slow: number) => [...Array(24).fill(fast), slow];

  it('flags only the write tool whose measured p95 crosses 80% of its budget', async () => {
    const sql = db.adminSql;
    await sql`DELETE FROM harness_shared.tool_invocations`;
    await seedCalls('x:slow-write', Array(25).fill(55_000)); // p95 55s of 60s default ⇒ 92%
    await seedCalls('x:fast-write', Array(25).fill(5_000)); // 8%
    await seedCalls('x:slow-read', Array(25).fill(55_000)); // slow but read-only ⇒ never judged
    await seedCalls('x:thin-write', Array(5).fill(59_000)); // too few samples
    await seedCalls('x:declared-long-write', Array(25).fill(55_000)); // 55s of a 600s budget ⇒ 9%
    await seedCalls('x:edge-write', Array(25).fill(48_000)); // exactly 80% ⇒ STRICT, quiet
    await seedCalls('x:timeouts-write', Array(25).fill(60_000), 'timeout'); // aborted tail counts, ⇒ major

    const budgets = new Map([
      ['x:slow-write', { timeoutSec: null, effect: 'write' }],
      ['x:fast-write', { timeoutSec: null, effect: 'write' }],
      ['x:slow-read', { timeoutSec: null, effect: 'read' }],
      ['x:thin-write', { timeoutSec: null, effect: 'write' }],
      ['x:declared-long-write', { timeoutSec: 600, effect: 'write' }],
      ['x:edge-write', { timeoutSec: null, effect: 'write' }],
      ['x:timeouts-write', { timeoutSec: null, effect: 'write' }],
    ]);
    const signals = await collectToolErrorSignals(sql, { toolLatencyBudgets: budgets });
    const latency = signals.filter((s) => s.findingClass === 'tool-latency-budget');
    expect(latency.map((s) => s.key).sort()).toEqual([
      'tool-latency-budget:x:slow-write',
      'tool-latency-budget:x:timeouts-write',
    ]);
    const bySeverity = Object.fromEntries(latency.map((s) => [s.key, s.severity]));
    expect(bySeverity['tool-latency-budget:x:slow-write']).toBe('minor'); // 92%: approaching
    expect(bySeverity['tool-latency-budget:x:timeouts-write']).toBe('major'); // at budget: being aborted
  });

  it('a lone slow outlier among fast calls does not move p95 over the line', async () => {
    const sql = db.adminSql;
    await sql`DELETE FROM harness_shared.tool_invocations`;
    await seedCalls('x:outlier-write', tail(2_000, 59_000));
    const budgets = new Map([['x:outlier-write', { timeoutSec: null, effect: 'write' }]]);
    const signals = await collectToolErrorSignals(sql, { toolLatencyBudgets: budgets });
    expect(signals.filter((s) => s.findingClass === 'tool-latency-budget')).toEqual([]);
  });

  it('excludes marked dispatch-wrapper rows, like the rest of the tool-error sweep', async () => {
    const sql = db.adminSql;
    await sql`DELETE FROM harness_shared.tool_invocations`;
    for (let i = 0; i < 25; i++) {
      await sql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
           status, duration_ms, invoked_at, metadata_json)
        VALUES ('*', '', '', 'x:wrapped-write', 'su', '', '', 'ok', 58000, now(),
                ${sql.json({ dispatchWrapper: true, dispatchedTool: 'x:inner' })})`;
    }
    const budgets = new Map([['x:wrapped-write', { timeoutSec: null, effect: 'write' }]]);
    const signals = await collectToolErrorSignals(sql, { toolLatencyBudgets: budgets });
    expect(signals.filter((s) => s.findingClass === 'tool-latency-budget')).toEqual([]);
  });
});
