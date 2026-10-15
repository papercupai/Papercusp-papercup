/**
 * pg-log-kind-predicate.test.ts — WI-6988.
 *
 * THE DEFECT THIS PINS: all four bounded readers are
 * `ORDER BY id DESC LIMIT n` over `coord_event_log_surface_kind_id_idx
 * (workspace_id, surface, (body->>'kind'), id DESC)`. PostgreSQL cannot treat
 * an index scan as ORDERED on trailing columns when a preceding column is
 * matched by a ScalarArrayOpExpr — and `= ANY(array)` is a SAOP even with ONE
 * element. So the single-kind `= ANY(...)` form made the planner materialize
 * EVERY matching row and top-N heapsort it: the LIMIT stopped nothing.
 *
 * Measured live before the fix (surface='escalations', kinds=['escalation'],
 * LIMIT 500, identical rows out): `= ANY` -> Sort over 9,258 rows / 9,168
 * buffers / 31.8ms; plain `=` -> ordered Index Scan stopping at 500 / 486
 * buffers / 2.9ms. In production: 22,034 calls at a 4,432ms mean = 27.1h of DB
 * time in 23 days.
 *
 * WHY A TEXT ASSERTION IS THE RIGHT GUARD HERE. The cost is invisible to every
 * other check we have: the fs/in-memory log impls and the shared conformance
 * suite cannot observe a query PLAN, and the planner still PICKED the correct
 * index (then sorted), so even an EXPLAIN reads as "indexed". Worse, the plan
 * FLIPPED with data growth — migration 556, which added that index, recorded at
 * ~101.6k rows that the single-common-kind case "is left on the cheap
 * backward-scan plan, unaffected". That was true then; once `escalations` grew
 * the planner switched to index+Sort and the same code got ~19x more expensive
 * with no code change. A plan-shape assertion would therefore be pinning a
 * moving target. The emitted predicate is the invariant that actually controls
 * it, so that is what this pins — for all four readers, since the bug was the
 * same line copied four times.
 *
 * Run: cd packages/coordination && npx vitest run src/event-log/pg-log-kind-predicate.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { PgCoordLog } from './pg-log';

interface Recorded {
  text: string;
  /** Raw substitutions of the outer template — nested fragments appear as objects. */
  values: unknown[];
  /** The substitutions FLATTENED through nested fragments, i.e. what Postgres binds. */
  params: unknown[];
}

interface Fragment {
  __frag: true;
  text: string;
  values: unknown[];
  params: unknown[];
}

function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && (v as Fragment).__frag === true;
}

/**
 * A postgres-js stand-in that records what each tagged-template call would send.
 *
 * The one subtlety: JS evaluates a template's substitutions BEFORE the outer tag
 * runs, so nested `sql`...`` fragments are recorded first and the OUTER query is
 * always the LAST call. Fragments are spliced back into the outer text so the
 * recorded string is the statement Postgres would actually parse (with `?` for
 * real bound parameters), rather than `[object Object]`.
 */
function makeFakeSql(rows: unknown[] = []): { sql: Sql; outer: () => Recorded } {
  const calls: Recorded[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    const params: unknown[] = [];
    for (let i = 1; i < strings.length; i++) {
      const v = values[i - 1];
      if (isFragment(v)) {
        text += v.text;
        // A fragment's own bound values are spliced in at ITS position — which
        // is where Postgres numbers them, so `params` is the real bind order.
        params.push(...v.params);
      } else {
        text += '?';
        params.push(v);
      }
      text += strings[i];
    }
    calls.push({ text, values, params });
    // Awaited as the outer query, spliced as an inner fragment — it is both.
    // Deliberately un-annotated: the call sites see it through the `Sql` cast
    // below, so pinning a PromiseLike<T> here only fights inference.
    const out = {
      __frag: true as const,
      text,
      values,
      params,
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
    return out;
  };
  return {
    sql: tag as unknown as Sql,
    outer: () => {
      const last = calls[calls.length - 1];
      if (!last) throw new Error('no query was issued');
      return last;
    },
  };
}

function makeLog(sql: Sql): PgCoordLog {
  return new PgCoordLog({
    getSql: () => sql,
    ensureSchema: async () => {},
    workspaceId: 'ws-test',
  });
}

/** The four bounded readers, each driven with the same `kinds` argument. */
const READERS = [
  {
    name: 'readEventsBounded',
    run: (log: PgCoordLog, kinds?: string[]) =>
      log.readEventsBounded('escalations', { limit: 50, ...(kinds ? { kinds } : {}) }),
  },
  {
    name: 'readLinesBounded',
    run: (log: PgCoordLog, kinds?: string[]) =>
      log.readLinesBounded('messages', { limit: 50, ...(kinds ? { kinds } : {}) }),
  },
  {
    name: 'readEventsBoundedCursor',
    run: (log: PgCoordLog, kinds?: string[]) =>
      log.readEventsBoundedCursor('escalations', { limit: 50, ...(kinds ? { kinds } : {}) }),
  },
  {
    name: 'readLinesBoundedCursor',
    run: (log: PgCoordLog, kinds?: string[]) =>
      log.readLinesBoundedCursor('messages', { limit: 50, ...(kinds ? { kinds } : {}) }),
  },
] as const;

describe('PgCoordLog kinds predicate (WI-6988)', () => {
  for (const reader of READERS) {
    describe(reader.name, () => {
      it('emits a SCALAR equality for ONE kind — never a 1-element ANY(), which is a SAOP and forbids the ordered index scan the LIMIT depends on', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), ['escalation']);
        const { text, params } = outer();

        expect(text).toContain("AND body->>'kind' = ?");
        // The whole point: no ANY(...) anywhere in the emitted statement.
        expect(text).not.toContain('ANY(');
        expect(text).not.toContain('::text[]');
        // The kind must still be a BOUND parameter (never inlined into the SQL),
        // and bound as a bare string — NOT as a 1-element array, which would put
        // the SAOP straight back.
        expect(params).toContain('escalation');
      });

      it('keeps ANY() for MULTIPLE kinds — correct there, and the planner degrades it to a backward surface scan + filter, which is cheap exactly when a multi-kind filter is unselective', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), ['escalation', 'escalation_resolved']);
        const { text, params } = outer();

        expect(text).toContain("AND body->>'kind' = ANY(?::text[])");
        expect(params).toContainEqual(['escalation', 'escalation_resolved']);
      });

      it('emits NO kind predicate at all when kinds is absent', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), undefined);
        expect(outer().text).not.toContain("body->>'kind'");
      });

      it('emits NO kind predicate when every supplied kind is blank — the filter is dropped, never emitted as an empty match', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), ['', '   ']);
        expect(outer().text).not.toContain("body->>'kind'");
      });

      it('collapses to the scalar form when blanks leave exactly ONE real kind — the filtering happens BEFORE the length check, so a padded array must not fall through to ANY()', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), ['escalation', '  ']);
        const { text, params } = outer();

        expect(text).toContain("AND body->>'kind' = ?");
        expect(text).not.toContain('ANY(');
        expect(params).toContain('escalation');
      });

      it('still bounds the read with ORDER BY id DESC + LIMIT — the ordering the scalar predicate exists to make index-satisfiable', async () => {
        const { sql, outer } = makeFakeSql();
        await reader.run(makeLog(sql), ['escalation']);
        expect(outer().text).toMatch(/ORDER BY id DESC\s+LIMIT \?/);
      });
    });
  }
});

describe('PgCoordLog bounded cursor timestamp upper bound', () => {
  const beforeTs = '2026-06-23T12:00:00.000Z';

  it('filters event-surface candidates by the envelope timestamp before the page limit', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readEventsBoundedCursor('escalations', { limit: 50, beforeTs });
    const { text, params } = outer();

    expect(text).toContain("AND (body->>'ts')::timestamptz < ?::timestamptz");
    expect(params).toContain(beforeTs);
  });

  it('keeps the event boundary timestamp for the caller composite tie-break', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readEventsBoundedCursor('escalations', { limit: 50, beforeTs, beforeMsgId: 'm2' });

    expect(outer().text).toContain("AND (body->>'ts')::timestamptz <= ?::timestamptz");
  });

  it('filters line-surface candidates on the timestamp column before the page limit', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readLinesBoundedCursor('messages', { limit: 50, beforeTs });
    const { text, params } = outer();

    expect(text).toContain('AND ts < ?::timestamptz');
    expect(params).toContain(beforeTs);
  });

  it('keeps the line boundary timestamp for the caller composite tie-break', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readLinesBoundedCursor('messages', { limit: 50, beforeTs, beforeMsgId: 'm2' });

    expect(outer().text).toContain('AND ts <= ?::timestamptz');
  });
});

describe('PgCoordLog bounded cursor exact sender predicate', () => {
  it('pushes exact sender into the event-surface query', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readEventsBoundedCursor('handoffs', { limit: 50, from: 'agent-a' });
    const { text, params } = outer();

    expect(text).toContain("AND body->>'from' = ?");
    expect(params).toContain('agent-a');
  });

  it('pushes exact sender into the line-surface query', async () => {
    const { sql, outer } = makeFakeSql();
    await makeLog(sql).readLinesBoundedCursor('messages', { limit: 50, from: 'agent-a' });
    const { text, params } = outer();

    expect(text).toContain("AND body->>'from' = ?");
    expect(params).toContain('agent-a');
  });
});
