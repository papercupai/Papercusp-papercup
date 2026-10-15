/**
 * spec-predicate-partition.test.ts — unit pins for the claim-spec surface's call into the SHARED
 * predicate-partition primitive (EI-23760081161304754 · plan dry-run-for-claims…, P-005).
 *
 * No database. What this file pins is the ADAPTER's three load-bearing properties:
 *
 *  1. `textSql` renders the claim compiler's own predicate text with values INLINED — and refuses
 *     anything it cannot render exactly (a NUL byte, a non-finite number, a plain-function call),
 *     because a wrong literal here would make the preview measure a different predicate than
 *     `get_next` runs.
 *  2. The compiler is reached through the TAG form only. A Proxy that allows nothing but the tag
 *     call and `.unsafe` is driven over EVERY (field × op × value) the filter language permits and
 *     over the pool floors — so the day `compileLeaf` grows an `sql.json` / `sql.array` / `sql(...)`
 *     leg, this fails here instead of the preview silently degrading in production. A control
 *     proves the Proxy actually catches such a leg (otherwise the sweep passes vacuously).
 *  3. The partition is over TOP-LEVEL conjuncts, with the pool floors kept as SCOPE and a narrow
 *     filter coming back null (the boundary clause p002.narrow-reads-unchanged).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClaimSpec, FilterNode } from './claim-spec';
import { FILTER_OPS, FILTERABLE_ITEM_FIELDS } from './claim-spec';
import { compileFilter } from './get-next';
import { specPoolFloors, specPoolStates } from './spec-pool-preview';
import {
  buildSpecPartitionStatement,
  labelDimensions,
  planSpecPartition,
  previewSpecFilterPartition,
  textOf,
  textSql,
  topLevelConjuncts,
} from './spec-predicate-partition';
import type { OrgSql } from '../work-items';

// specPoolFloors resolves the operator-scope alias through issuesScopeWorkspace() whenever a
// harness is given; pin it so the harness-scoped cases stay deterministic and flag-free.
vi.mock('../issues-engineer', async () => {
  const actual = await vi.importActual<typeof import('../issues-engineer')>('../issues-engineer');
  return { ...actual, issuesScopeWorkspace: () => 'ws-under-test' };
});

const WS = 'ws-under-test';
const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

function spec(filter?: FilterNode, states?: string[]): ClaimSpec {
  return {
    specVersion: '1.0',
    specId: 'partition-unit',
    revision: 1,
    view: filter ? { filter } : {},
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    ...(states ? { states } : {}),
  } as ClaimSpec;
}

const KIND: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
const SEVERITY: FilterNode = { field: 'severity', op: 'in', value: ['critical', 'major'] };
const AGE: FilterNode = { field: 'age', op: '>', value: 5 };

// ─────────────────────────────────────────────────────────────────────────────
describe('textSql — literal rendering', () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    textOf((textSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values));

  it('renders strings, escaping quotes, and uses E-strings only when a backslash is present', () => {
    expect(t`x = ${'abc'}`).toBe("x = 'abc'");
    expect(t`x = ${"o'brien"}`).toBe("x = 'o''brien'");
    // A backslash must read the same under standard_conforming_strings on OR off — the E-form
    // with doubled backslashes does; compileLeaf's glob and word values both carry them.
    expect(t`x ~ ${'\\yfoo\\y'}`).toBe("x ~ E'\\\\yfoo\\\\y'");
    expect(t`x = ${"a\\'b"}`).toBe("x = E'a\\\\''b'");
  });

  it('renders numbers, bigint, booleans and null', () => {
    expect(t`${5} ${-1.5} ${10n} ${true} ${false} ${null} ${undefined}`).toBe('5 -1.5 10 TRUE FALSE NULL NULL');
  });

  it('renders arrays as ARRAY[...] (the compiler always follows them with an explicit ::type[] cast)', () => {
    expect(t`${['a', 'b']}::text[]`).toBe("ARRAY['a', 'b']::text[]");
    expect(t`${[1, 2]}::numeric[]`).toBe('ARRAY[1, 2]::numeric[]');
  });

  it('splices a nested fragment verbatim and honours .unsafe', () => {
    const inner = (textSql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)`a = ${1}`;
    expect(t`(${inner}) AND ${(textSql as unknown as { unsafe: (r: string) => unknown }).unsafe('TRUE')}`).toBe(
      '(a = 1) AND TRUE',
    );
  });

  it('refuses what it cannot render exactly', () => {
    expect(() => t`${'a\u0000b'}`).toThrow(/NUL/);
    expect(() => t`${Number.NaN}`).toThrow(/non-finite/);
    expect(() => t`${Number.POSITIVE_INFINITY}`).toThrow(/non-finite/);
    expect(() => t`${{ nested: true }}`).toThrow(/unsupported value type/);
  });

  it('refuses a plain-function call instead of misrendering it', () => {
    // postgres.js lets `sql(rows)` / `sql('col')` build identifiers and multi-row lists. Handed
    // one, a tag implementation would read strings[0] as TEMPLATE TEXT and emit plausible SQL.
    expect(() => (textSql as unknown as (v: unknown) => unknown)(['a', 'b'])).toThrow(/tagged-template/);
    expect(() => (textSql as unknown as (v: unknown) => unknown)('col')).toThrow(/tagged-template/);
  });

  it('textOf refuses anything that is not a textSql fragment', () => {
    expect(() => textOf('SELECT 1')).toThrow(/not a textSql fragment/);
    expect(() => textOf({ text: 'x' })).toThrow(/not a textSql fragment/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Proxy guard — the claim compiler is reached through the TAG form only', () => {
  class ProxyViolation extends Error {}
  const guard = (): OrgSql =>
    new Proxy(textSql as unknown as (...a: unknown[]) => unknown, {
      get(target, prop, receiver) {
        if (prop === 'unsafe') return Reflect.get(target, prop, receiver);
        throw new ProxyViolation(`sql.${String(prop)} reached — the compiler left the tag form`);
      },
    }) as unknown as OrgSql;

  it('control: the Proxy DOES catch an sql.json / sql.array leg (so the sweep below is not vacuous)', () => {
    const g = guard() as unknown as { json: (v: unknown) => unknown; array: (v: unknown) => unknown };
    expect(() => g.json({ a: 1 })).toThrow(ProxyViolation);
    expect(() => g.array([1])).toThrow(ProxyViolation);
    // …while the two permitted surfaces pass straight through.
    expect(() => textOf((guard() as unknown as (s: TemplateStringsArray) => unknown)`TRUE`)).not.toThrow();
    expect(textOf((guard() as unknown as { unsafe: (r: string) => unknown }).unsafe('1=1'))).toBe('1=1');
  });

  it('every filterable field × every op × every value shape compiles without leaving the tag form', () => {
    const values: Array<FilterNode extends infer N ? (N extends { value: infer V } ? V : never) : never> = [
      'x',
      ['x', 'y'],
      3,
      [3, 4],
    ] as never;
    let compiled = 0;
    for (const field of FILTERABLE_ITEM_FIELDS) {
      for (const op of FILTER_OPS) {
        let anyValueCompiled = false;
        for (const value of values) {
          try {
            const text = textOf(compileFilter(guard(), { field, op, value } as FilterNode));
            expect(typeof text).toBe('string');
            expect(text.length).toBeGreaterThan(0);
            anyValueCompiled = true;
            compiled += 1;
          } catch (e) {
            // A numeric field handed 'x' is Number('x') = NaN, which textSql refuses by design.
            if (e instanceof ProxyViolation) throw e;
            expect((e as Error).message).toMatch(/non-finite/);
          }
        }
        expect(anyValueCompiled, `${field} ${op}: no value shape compiled`).toBe(true);
      }
    }
    expect(compiled).toBeGreaterThan(FILTERABLE_ITEM_FIELDS.length * FILTER_OPS.length);
  });

  it('the combinators (all / any / not) stay inside the tag form too', () => {
    const tree: FilterNode = { all: [{ any: [KIND, { not: SEVERITY }] }, { not: { all: [AGE, KIND] } }] };
    expect(() => textOf(compileFilter(guard(), tree))).not.toThrow();
  });

  it('the pool floors stay inside the tag form, with and without a harness', () => {
    for (const harness of [null, 'papercusp']) {
      expect(() =>
        textOf(specPoolFloors(guard(), { workspaceId: WS, harness, states: ['open', 'wip'] })),
      ).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('topLevelConjuncts', () => {
  it('is empty for no filter and a single element for a lone leaf', () => {
    expect(topLevelConjuncts(undefined)).toEqual([]);
    expect(topLevelConjuncts(KIND)).toEqual([KIND]);
  });

  it('flattens nested all (AND is associative — what matches is unchanged)', () => {
    expect(topLevelConjuncts({ all: [KIND, { all: [SEVERITY, { all: [AGE] }] }] })).toEqual([KIND, SEVERITY, AGE]);
  });

  it('keeps any and not WHOLE — their arms are alternatives, not independent predicates', () => {
    const any: FilterNode = { any: [KIND, SEVERITY] };
    const not: FilterNode = { not: KIND };
    expect(topLevelConjuncts({ all: [any, not, AGE] })).toEqual([any, not, AGE]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildSpecPartitionStatement', () => {
  it('is null when the filter has nothing to partition by', () => {
    expect(buildSpecPartitionStatement(spec(undefined), { workspaceId: WS })).toBeNull();
  });

  it('is SELECT count(*) … WHERE (floors) AND (c1) AND (c2), with literals inlined and no bind markers', () => {
    const built = buildSpecPartitionStatement(spec({ all: [KIND, SEVERITY] }), { workspaceId: WS })!;
    expect(built.conjuncts.map((c) => c.node)).toEqual([KIND, SEVERITY]);
    expect(built.sql).toMatch(/^SELECT count\(\*\) FROM harness_shared\.work_items\n WHERE \(/);
    // the SAME floors previewSpecPoolEffect counts under
    const floors = textOf(
      specPoolFloors(textSql, { workspaceId: WS, harness: null, states: specPoolStates(spec(KIND)) }),
    );
    expect(built.sql).toContain(floors);
    for (const c of built.conjuncts) expect(built.sql).toContain(`   AND ${c.text}`);
    expect(built.sql).not.toMatch(/\$\d+/);
    expect(built.sql).toContain(`workspace_id = '${WS}'`);
    expect(built.sql).toContain("'critical'");
  });

  it('carries spec.states into the floors (defaulting to open) and the harness alias when scoped', () => {
    const states = buildSpecPartitionStatement(spec(KIND, ['wip', 'blocked']), { workspaceId: WS })!;
    expect(states.sql).toContain("ARRAY['wip', 'blocked']::text[]");
    const dflt = buildSpecPartitionStatement(spec(KIND), { workspaceId: WS })!;
    expect(dflt.sql).toContain("ARRAY['open']::text[]");
    const scoped = buildSpecPartitionStatement(spec(KIND), { workspaceId: WS, harness: 'papercusp' })!;
    expect(scoped.sql).toContain("harness_slug = 'papercusp'");
    expect(scoped.sql).toContain(`harness_slug = 'operator:${WS}'`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('planSpecPartition — through the SHARED planner', () => {
  const floorsOf = (harness: string | null = null) =>
    squash(textOf(specPoolFloors(textSql, { workspaceId: WS, harness, states: ['open'] })));

  it('returns null for a single non-jsonb dimension — narrow specs are reported exactly as before', () => {
    expect(planSpecPartition(spec(KIND), { workspaceId: WS })).toBeNull();
    expect(planSpecPartition(spec({ all: [KIND] }), { workspaceId: WS })).toBeNull();
    expect(planSpecPartition(spec(undefined), { workspaceId: WS })).toBeNull();
  });

  it('plans two independent dimensions and keeps the pool floors as SCOPE, not a dimension', () => {
    const planned = planSpecPartition(spec({ all: [KIND, AGE] }), { workspaceId: WS })!;
    expect(planned).not.toBeNull();
    expect(planned.plan.dimensions).toHaveLength(2);
    expect(planned.plan.droppedDimensions).toEqual([]);
    expect(planned.plan.touchesJsonb).toBe(false);
    expect(planned.plan.relation).toMatch(/work_items/);
    // the floors are what partitions-by-tenant would otherwise have made a dimension
    expect(planned.plan.scope).toHaveLength(1);
    expect(squash(planned.plan.scope[0]!)).toBe(floorsOf());
  });

  it('a single jsonb-path predicate qualifies on its own (the key may be ABSENT, i.e. NULL)', () => {
    const planned = planSpecPartition(spec(SEVERITY), { workspaceId: WS })!;
    expect(planned).not.toBeNull();
    expect(planned.plan.touchesJsonb).toBe(true);
    expect(planned.plan.dimensions).toHaveLength(1);
  });

  it('caps the dimensions and NAMES the ones it dropped, so the preview cannot imply completeness', () => {
    const four: FilterNode = {
      all: [KIND, AGE, { field: 'title', op: 'glob', value: '*x*' }, { field: 'assignee', op: '=', value: 'bee' }],
    };
    const planned = planSpecPartition(spec(four), { workspaceId: WS })!;
    expect(planned.plan.dimensions).toHaveLength(3);
    expect(planned.plan.droppedDimensions).toHaveLength(1);
  });

  it('an any is ONE dimension (not one per arm), beside a sibling leaf', () => {
    const planned = planSpecPartition(spec({ all: [{ any: [KIND, SEVERITY] }, AGE] }), { workspaceId: WS })!;
    expect(planned.plan.dimensions).toHaveLength(2);
  });

  it('no filterable field is mis-read as SCOPE or merged away: each pairs with kind into two dimensions', () => {
    // NON_SUMMING_SCOPE_RE classifies any conjunct naming workspace_id/harness_slug/… as scope. A
    // FIELD_MAP column expression that ever did so would silently vanish from the partition.
    for (const field of FILTERABLE_ITEM_FIELDS) {
      if (field === 'kind') continue;
      let planned: ReturnType<typeof planSpecPartition> = null;
      for (const value of ['x', 3] as const) {
        try {
          planned = planSpecPartition(spec({ all: [KIND, { field, op: '=', value } as FilterNode] }), {
            workspaceId: WS,
          });
          break;
        } catch (e) {
          expect((e as Error).message).toMatch(/non-finite/);
        }
      }
      expect(planned, `${field}: the pair did not qualify`).not.toBeNull();
      expect(planned!.plan.dimensions, `${field}`).toHaveLength(2);
      expect(planned!.plan.scope, `${field}`).toHaveLength(1);
    }
  });

  it('harness scoping stays inside the single SCOPE conjunct', () => {
    const planned = planSpecPartition(spec({ all: [KIND, AGE] }), { workspaceId: WS, harness: 'papercusp' })!;
    expect(planned.plan.scope).toHaveLength(1);
    expect(squash(planned.plan.scope[0]!)).toBe(floorsOf('papercusp'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('labelDimensions', () => {
  it('names each d<N> by the filter node it came from, in filter order', () => {
    const planned = planSpecPartition(spec({ all: [KIND, SEVERITY] }), { workspaceId: WS })!;
    const labels = labelDimensions(planned.plan, planned.statement);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^d1 = kind in /);
    expect(labels[1]).toMatch(/^d2 = severity in /);
  });

  it('leaves an unmatched dimension UNLABELLED rather than guessing (a wrong label sends the reader to the wrong predicate)', () => {
    const planned = planSpecPartition(spec({ all: [KIND, SEVERITY] }), { workspaceId: WS })!;
    const forged = { ...planned.plan, dimensions: ['(bogus = 1)', ...planned.plan.dimensions.slice(1)] };
    const labels = labelDimensions(forged, planned.statement);
    expect(labels[0]).toBe('d1 = (unlabelled)');
    expect(labels[1]).toMatch(/^d2 = severity in /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('previewSpecFilterPartition — no database', () => {
  it('is null for a narrow filter and never touches the client', async () => {
    const begin = vi.fn(() => {
      throw new Error('the client must not be used for a non-qualifying read');
    });
    const out = await previewSpecFilterPartition(spec(KIND), {
      workspaceId: WS,
      client: { begin } as unknown as OrgSql,
    });
    expect(out).toBeNull();
    expect(begin).not.toHaveBeenCalled();
  });

  it('FAILS OPEN: a probe that cannot run degrades to the statements, never to "no cells"', async () => {
    const begin = vi.fn(() => {
      throw new Error('connection refused');
    });
    const out = (await previewSpecFilterPartition(spec({ all: [KIND, SEVERITY] }), {
      workspaceId: WS,
      client: { begin } as unknown as OrgSql,
    }))!;
    expect(begin).toHaveBeenCalled();
    expect(out).toContain('CLAIM-SPEC PARTITION');
    expect(out).toContain('d1 = kind in ');
    expect(out).toContain('d2 = severity in ');
    expect(out).toContain('GROUP BY 1, 2');
    // an empty-cells rendering would read as "nothing fell through" — the false negative this prevents
    expect(out).not.toContain('PARTITION: the probe returned no cells');
    expect(out).not.toContain('FALL-THROUGH SAMPLE');
  });
});
