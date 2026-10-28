/**
 * The LIVE-SCHEMA half of the prose column width contract (EI-19366433214266471).
 *
 * `prose-vector-dims.test.ts` is a UNIT test: it checks the CODE side only —
 * that `PROSE_VECTOR_DIMS` agrees with each prose-eligible mode's declared
 * `targetDims`, and that the column lists are well-formed. Nothing in it
 * compares either list against an actual database, so the failure the whole
 * contract exists to prevent stayed undetected: a new prose surface created at
 * `vector(384)`, or a migration that widens only a SUBSET of the columns,
 * passes every check and then fails only inside a background embed sweep that
 * nobody watches.
 *
 * That is not hypothetical. Shipping the 768 constant while the columns were
 * still `vector(384)` produced 9.5 hours of total, SILENT embed failure — every
 * UPDATE rejected by pgvector, swallowed by a per-row catch, zero rows written,
 * zero log output. `fitsProseColumns` cannot catch it by construction: it
 * compares the emitter against the CONSTANT, so when the constant has moved and
 * the migration has not, both sides agree and the guard sails through. Only a
 * read of the live catalog closes that gap.
 *
 * WHAT EACH LEG IS FOR — legs 1-2 verify what we remembered to write down;
 * leg 3 is the only one that fails when someone adds a surface and tells no one:
 *
 *   1. every `WIDTH_MIGRATION_WIPE_SET` column EXISTS, is a table, and is
 *      `vector(PROSE_VECTOR_DIMS)`;
 *   2. every `PROSE_VECTOR_DEPENDENT_VIEWS` entry exists, is a view, and
 *      reports `PROSE_VECTOR_DIMS` (a view left at the old width is the visible
 *      symptom of a half-applied width migration);
 *   3. THE CLOSING LEG — every vector column anywhere in `harness_shared` is
 *      either enumerated with its declared width, or a frozen snapshot. An
 *      UNENUMERATED column fails even at the right width, because the next
 *      width migration will silently skip it (that is exactly WI-7326);
 *   4. the recursive `pg_depend`/`pg_rewrite` closure over the target columns
 *      contains no relkind other than `'v'` — a materialized view would need
 *      repopulating plus its own indexes, which migration 727 deliberately
 *      REFUSES rather than guesses.
 *
 * Runs against the integration tier's baseline-schema DB (`inject`ed by
 * `BASELINE_SCHEMA_GLOBAL_SETUP_PATH`), which applies the REAL migration set —
 * so "the live schema" here means "what the committed migrations actually
 * produce", which is the thing worth asserting. READ-ONLY: it touches nothing,
 * so it is safe against that shared read-heavy database.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/search/prose-vector-dims.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { MODE_DIMS, VEC_TABLE, type ResolvedVecMode } from '@papercusp/memory';
import { CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE } from '../capability-class-registry-store';
import {
  PROSE_VECTOR_DIMS,
  PROSE_VECTOR_COLUMNS,
  PROSE_VECTOR_DEPENDENT_VIEWS,
  WIDTH_MIGRATION_WIPE_SET,
  computeProseColumnWidthSkew,
} from './prose-vector-dims';

/** The schema the shared prose contract governs. */
const SCHEMA = 'harness_shared';

/**
 * Frozen pre-migration snapshots — deliberately NOT migrated, because their
 * whole purpose is to preserve the OLD state as evidence. Matched by prefix so
 * the next one does not have to be added here by hand.
 */
const SNAPSHOT_PREFIX = /^(bak_|_pot_backfill_)/;

/**
 * A vector column measured from the catalog.
 *
 * `dims` comes from `pg_attribute.atttypmod`, which for pgvector holds the
 * dimension DIRECTLY — there is no varchar-style `+4` offset. Verified against
 * the live catalog: atttypmod 768 renders as `vector(768)`, 384 as
 * `vector(384)`, 1024 as `vector(1024)`.
 */
interface MeasuredColumn {
  relname: string;
  attname: string;
  /** `r` table, `p` partitioned table, `v` view, `m` materialized view. */
  relkind: string;
  typname: string;
  dims: number;
}

/**
 * A client the catalog reads accept — either the pooled connection or a
 * transaction handle, so the negative control below can measure INSIDE its
 * rolled-back transaction and see its own uncommitted DDL.
 */
type PgClient = postgres.Sql | postgres.TransactionSql;

const key = (relname: string, attname: string): string => `${relname}.${attname}`;
/** `harness_shared.session_turns` → `session_turns` (catalog stores the bare name). */
const bare = (qualified: string): string => qualified.split('.').pop() as string;

/**
 * Every vector column in `harness_shared`, on relations that actually STORE a
 * width.
 *
 * ⚠ `relkind = 'i'` IS EXCLUDED ON PURPOSE, and the exclusion is load-bearing.
 * An INDEX over a vector column has its own `pg_attribute` row with
 * `typname = 'vector'`, so an unfiltered scan double-reports every column —
 * once for the table, once for each HNSW index — and, worse, reports the
 * excluded spaces again under a different name (`memory_vec_local_hnsw_idx`).
 * An index column merely mirrors the column it indexes, so it carries no
 * independent signal. This is the same `relkind`-blindness that produced the
 * original 727 bug (EI-19364746461986832), from the other direction.
 *
 * ⚠ `typname` is scanned across ALL pgvector types, not just `vector`. A new
 * surface declared `halfvec(384)` would slip straight past a `vector`-only
 * scan, which would leave the "closing" leg with a hole in exactly the place it
 * claims to close. Types other than `vector` have no contract yet, so leg 3
 * reports one as an unknown surface rather than silently accepting it.
 */
async function measureVectorColumns(sql: PgClient): Promise<MeasuredColumn[]> {
  return sql<MeasuredColumn[]>`
    SELECT c.relname      AS relname,
           a.attname      AS attname,
           c.relkind::text AS relkind,
           t.typname      AS typname,
           a.atttypmod    AS dims
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type      t ON t.oid = a.atttypid
     WHERE n.nspname = ${SCHEMA}
       AND t.typname IN ('vector', 'halfvec', 'sparsevec')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND c.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY c.relname, a.attname`;
}

/**
 * The recursive dependent closure over the prose target columns — the SAME walk
 * migration 727 performs, run as an assertion.
 *
 * Deliberately mirrors 727's query rather than naming views literally: the
 * dependency graph is neither shallow nor confined to this schema
 * (`work_items.embedding` <- `work_items_claimable` <- every per-harness
 * schema's `harness_features`), and that last rank grows with every pot
 * created — 37 views across 35 schemas in the live DB when this was written.
 *
 * `refobjsubid` is the COLUMN: a view reading OTHER columns of the same table
 * does not block the ALTER and must not be counted.
 */
async function measureDependentClosure(
  sql: postgres.Sql,
  targets: ReadonlyArray<{ table: string; column: string }>,
): Promise<Array<{ nspname: string; relname: string; relkind: string }>> {
  const tables = targets.map((t) => bare(t.table));
  const columns = targets.map((t) => t.column);
  return sql<Array<{ nspname: string; relname: string; relkind: string }>>`
    WITH RECURSIVE tgt AS (
      SELECT cl.oid, a.attnum
        FROM unnest(${tables}::text[], ${columns}::text[]) AS u(tname, cname)
        JOIN pg_class     cl ON cl.relname = u.tname AND cl.relkind = 'r'
        JOIN pg_namespace n  ON n.oid = cl.relnamespace AND n.nspname = ${SCHEMA}
        JOIN pg_attribute a  ON a.attrelid = cl.oid AND a.attname = u.cname
                            AND a.attnum > 0 AND NOT a.attisdropped
    ),
    dep(view_oid, depth) AS (
      SELECT r.ev_class, 1
        FROM pg_depend  d
        JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
       WHERE d.refclassid = 'pg_class'::regclass
         AND (d.refobjid, d.refobjsubid) IN (SELECT oid, attnum FROM tgt)
         AND r.ev_class <> d.refobjid
      UNION
      SELECT r.ev_class, dep.depth + 1
        FROM dep
        JOIN pg_depend  d ON d.refobjid = dep.view_oid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
       WHERE r.ev_class <> dep.view_oid AND dep.depth < 20
    )
    SELECT n.nspname::text AS nspname, c.relname::text AS relname, c.relkind::text AS relkind
      FROM dep
      JOIN pg_class     c ON c.oid = dep.view_oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     GROUP BY 1, 2, 3
     ORDER BY 1, 2`;
}

/**
 * Expected width for every column we know about, derived from the STORAGE-FACT
 * declarations rather than restated here:
 *   - `WIDTH_MIGRATION_WIPE_SET`      → `PROSE_VECTOR_DIMS` (shared contract)
 *   - `VEC_TABLE[mode]`               → `MODE_DIMS[mode]`   (per-mode spaces)
 *   - `PROSE_VECTOR_DEPENDENT_VIEWS`  → `PROSE_VECTOR_DIMS` (inherited)
 *
 * The first two are deliberately independent of `EMBEDDER_DIM_SPECS` for the
 * same documented reason, so consulting them here keeps this test honest: it
 * asserts the DATABASE matches what the code claims the database is, and a
 * hardcoded number in this file would just be a third thing to drift.
 *
 * The views are enumerated too — NOT because they need migrating (they inherit
 * the base column's type), but because the audit below asks a different
 * question from leg 2: "is this column accounted for ANYWHERE". Omitting them
 * made the audit report all three as unknown surfaces on its first run. Within
 * `harness_shared` that list IS exhaustive; the per-harness copies that make it
 * non-exhaustive at runtime live in other schemas, which this
 * `harness_shared`-scoped scan never sees.
 */
function expectedWidths(): Map<string, { dims: number; why: string }> {
  const m = new Map<string, { dims: number; why: string }>();
  for (const { table, column } of WIDTH_MIGRATION_WIPE_SET) {
    m.set(key(bare(table), column), {
      dims: PROSE_VECTOR_DIMS,
      why: 'shared prose width contract (WIDTH_MIGRATION_WIPE_SET)',
    });
  }
  for (const [mode, table] of Object.entries(VEC_TABLE) as Array<[ResolvedVecMode, string]>) {
    m.set(key(table, 'vector'), {
      dims: MODE_DIMS[mode],
      why: `per-mode memory space for '${mode}' (MODE_DIMS)`,
    });
  }
  for (const { view, column } of PROSE_VECTOR_DEPENDENT_VIEWS) {
    m.set(key(bare(view), column), {
      dims: PROSE_VECTOR_DIMS,
      why: 'dependent view inheriting the base column (PROSE_VECTOR_DEPENDENT_VIEWS)',
    });
  }
  const capabilityClass = CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE;
  m.set(key(capabilityClass.table, capabilityClass.column), {
    dims: capabilityClass.dimensions,
    why:
      'profile-bound capability-class storage ' +
      `(CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE; discriminator=${capabilityClass.profileColumn})`,
  });
  // Migrations 1166 and 1170 add these physical vector(768) columns. They are
  // not in WIDTH_MIGRATION_WIPE_SET, so pin their schema facts here without
  // claiming they participate in the active prose refill contract. If either
  // gains a semantic reader, move it into that contract with its refill path.
  m.set(key('report_library_chunks', 'embedding'), {
    dims: 768,
    why: 'physical storage contract from migration 1166 (report library chunks)',
  });
  m.set(key('event_key_registry', 'embedding'), {
    dims: 768,
    why: 'physical storage contract from migration 1170 (event key registry)',
  });
  // Migration 1327 renamed personal_documents -> documents and left a
  // compatibility VIEW whose embedding column inherits the base vector(768).
  m.set(key('personal_documents', 'embedding'), {
    dims: 768,
    why: 'compatibility view from migration 1327 (personal_documents -> documents)',
  });
  // Migration 1568 declares an UNCONSTRAINED `vector` (atttypmod -1): the
  // semantic code index stores whatever width its code-embedding model emits,
  // so the catalog reports -1. Pin that, so a width change here is deliberate.
  m.set(key('semantic_code_functions', 'embedding'), {
    dims: -1,
    why: 'unconstrained vector from migration 1568 (semantic code index)',
  });
  return m;
}

/**
 * The closing leg's judgement, as a function of measured rows — so the assertion
 * and its NEGATIVE CONTROL exercise the same code rather than two hand-copied
 * loops that could drift into agreeing with each other.
 */
function auditSurfaces(measured: readonly MeasuredColumn[]): string[] {
  const expected = expectedWidths();
  const problems: string[] = [];

  for (const m of measured) {
    if (SNAPSHOT_PREFIX.test(m.relname)) continue; // frozen pre-migration evidence
    const k = key(m.relname, m.attname);
    const want = expected.get(k);

    if (!want) {
      // THE FAILURE THIS LEG EXISTS FOR. Note it fires even when the width is
      // already correct: an unenumerated column is invisible to the NEXT width
      // migration, which is precisely how WI-7326 happened.
      problems.push(
        `${SCHEMA}.${k} (${m.typname}(${m.dims}), relkind='${m.relkind}') is NOT enumerated. ` +
          `Add its physical storage-fact declaration to expectedWidths (and to ` +
          `PROSE_VECTOR_COLUMNS when it is shared prose) — an unlisted column can be ` +
          `silently compared in a foreign space or skipped by the next applicable width migration.`,
      );
      continue;
    }
    if (m.typname !== 'vector') {
      problems.push(
        `${SCHEMA}.${k} is ${m.typname}, not vector — the width contract is defined ` +
          `over pgvector's 'vector' type only.`,
      );
      continue;
    }
    if (m.relkind === 'm') {
      problems.push(
        `${SCHEMA}.${k} is a MATERIALIZED view. Migration 727 deliberately REFUSES ` +
          `these rather than guessing: a matview needs repopulating plus its own ` +
          `indexes rebuilt, which a width migration cannot infer.`,
      );
      continue;
    }
    if (m.dims !== want.dims) {
      problems.push(`${SCHEMA}.${k} is vector(${m.dims}) but ${want.why} declares ${want.dims}.`);
    }
  }

  return problems;
}

/** Thrown to unwind `sql.begin`, which rolls back on any thrown error. */
class Rollback extends Error {}

describe('the prose column width contract — asserted against the LIVE schema', () => {
  let sql: postgres.Sql;
  let measured: MeasuredColumn[];
  let byName: Map<string, MeasuredColumn>;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    // The globalSetup's own health check ran once, potentially minutes ago; on a
    // loaded box that is long enough for a transient blip. Confirm with a bounded
    // retry so a real failure reads as environment churn, not a cryptic catalog miss.
    await assertPgReachable(dsn, 'prose-vector-dims.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
    measured = await measureVectorColumns(sql);
    byName = new Map(measured.map((m) => [key(m.relname, m.attname), m]));
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('measures a non-empty catalog (guards against a silently vacuous suite)', () => {
    // Every leg below is a "nothing is wrong" assertion, and all of them pass
    // trivially against an empty measurement — a mistyped schema name or a
    // catalog query that stopped matching would read as a clean green.
    expect(
      measured.length,
      `no vector columns found in ${SCHEMA} — the measurement is broken, not the schema`,
    ).toBeGreaterThan(0);
  });

  describe('leg 1 — every column a width migration must ALTER', () => {
    it('exists as a TABLE', () => {
      const problems = WIDTH_MIGRATION_WIPE_SET.flatMap(({ table, column }) => {
        const m = byName.get(key(bare(table), column));
        if (!m) return [`${table}.${column} — ABSENT from the live schema`];
        if (m.relkind !== 'r') {
          return [
            `${table}.${column} — relkind='${m.relkind}', expected 'r'. ` +
              `ALTER TABLE ... ALTER COLUMN against a view fails outright ` +
              `(EI-19364746461986832); a view belongs in PROSE_VECTOR_DEPENDENT_VIEWS.`,
          ];
        }
        return [];
      });
      // Asserted SEPARATELY from the width below because
      // `computeProseColumnWidthSkew` deliberately SKIPS a column absent from the
      // measurement ("absence of evidence is not skew"). That is right for its
      // own contract — a table that does not exist yet is unjudgeable, not
      // broken — but it means a DROPPED prose table would read as "no skew".
      expect(problems, problems.join('\n')).toEqual([]);
    });

    it(`is vector(${PROSE_VECTOR_DIMS})`, () => {
      // Routed through the SAME pure classifier the backfill sweep uses, so this
      // also proves that function is fed the units it documents (atttypmod, with
      // no varchar-style +4 offset) rather than agreeing with itself in a unit test.
      const skew = computeProseColumnWidthSkew(
        WIDTH_MIGRATION_WIPE_SET.flatMap(({ table, column }) => {
          const m = byName.get(key(bare(table), column));
          return m ? [{ table, column, dims: m.dims }] : [];
        }),
      );
      expect(
        skew,
        skew
          .map(
            (s) =>
              `${s.table}.${s.column} is vector(${s.liveDims}) but the code emits ` +
              `${s.declaredDims} — every write to it fails inside a background sweep`,
          )
          .join('\n'),
      ).toEqual([]);
    });
  });

  describe('leg 2 — the dependent views in harness_shared', () => {
    it(`exist as VIEWS reporting ${PROSE_VECTOR_DIMS}`, () => {
      const problems = PROSE_VECTOR_DEPENDENT_VIEWS.flatMap(({ view, column }) => {
        const m = byName.get(key(bare(view), column));
        if (!m) return [`${view}.${column} — ABSENT from the live schema`];
        if (m.relkind !== 'v') return [`${view}.${column} — relkind='${m.relkind}', expected 'v'`];
        if (m.dims !== PROSE_VECTOR_DIMS) {
          return [
            `${view}.${column} reports vector(${m.dims}), expected ${PROSE_VECTOR_DIMS}. ` +
              `A view inherits its base column's type, so a stale width here means the ` +
              `view was recreated against a column the ALTER never reached — the visible ` +
              `symptom of a HALF-APPLIED width migration.`,
          ];
        }
        return [];
      });
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });

  describe('leg 3 — THE CLOSING LEG: no unenumerated or mis-sized vector column', () => {
    it('the two storage-fact declarations agree where they OVERLAP', () => {
      // `memory_vec_gemma`/`memory_vec_openai` are governed by BOTH lists. If they
      // ever disagreed, the expectation map above would silently take one side and
      // this whole leg would assert something nobody intended.
      const disagreements = WIDTH_MIGRATION_WIPE_SET.flatMap(({ table, column }) => {
        const entry = (Object.entries(VEC_TABLE) as Array<[ResolvedVecMode, string]>).find(
          ([, t]) => t === bare(table) && column === 'vector',
        );
        if (!entry) return [];
        const [mode] = entry;
        return MODE_DIMS[mode] === PROSE_VECTOR_DIMS
          ? []
          : [
              `${table}.${column}: MODE_DIMS['${mode}']=${MODE_DIMS[mode]} but the prose ` +
                `contract says ${PROSE_VECTOR_DIMS}. A mode is prose-eligible exactly when ` +
                `it emits PROSE_VECTOR_DIMS, so these cannot disagree.`,
            ];
      });
      expect(disagreements, disagreements.join('\n')).toEqual([]);
    });

    it('every vector column is enumerated, and at its declared width', () => {
      const problems = auditSurfaces(measured);
      expect(problems, problems.join('\n')).toEqual([]);
    });

    /**
     * NEGATIVE CONTROL — proves the leg above BITES rather than passing vacuously.
     *
     * Every other assertion in this file is a "nothing is wrong" shape, and the
     * whole point of leg 3 is a failure mode nobody has produced yet, so "it is
     * green" is weak evidence on its own. Here we actually create the thing it
     * is supposed to catch — a brand-new prose surface at the OLD width — and
     * assert it is reported.
     *
     * This is not theatre: the leg was written with a real hole (it omitted
     * `PROSE_VECTOR_DEPENDENT_VIEWS`, so it reported three legitimate views as
     * unknown surfaces on its first run). A guard this file can be wrong about
     * is a guard worth controlling for.
     *
     * SAFE AGAINST THE SHARED DB. The whole thing runs inside a transaction that
     * always rolls back — Postgres makes DDL transactional, and a dropped
     * connection rolls back too, so there is no path that leaves the control
     * table behind. The table is created, measured, and unwound without any
     * other test being able to observe it.
     */
    it('CATCHES a new prose surface created at the old width (negative control)', async () => {
      const CONTROL = 'zz_prose_width_negative_control';
      let findings: string[] = [];

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(
            `CREATE TABLE ${SCHEMA}.${CONTROL} (id int PRIMARY KEY, embedding vector(384))`,
          );
          findings = auditSurfaces(await measureVectorColumns(tx));
          throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }

      const hit = findings.find((f) => f.includes(CONTROL));
      expect(
        hit,
        `leg 3 did NOT report a new vector(384) surface — it would pass vacuously ` +
          `against exactly the regression it exists to prevent. Findings: ${findings.join('; ')}`,
      ).toBeDefined();
      expect(hit).toContain('is NOT enumerated');

      // ...and the rollback really happened, so this test cannot poison the
      // shared baseline DB for every other file in the tier.
      const [{ present }] = await sql<{ present: boolean }[]>`
        SELECT to_regclass(${`${SCHEMA}.${CONTROL}`}) IS NOT NULL AS present`;
      expect(present, 'the negative-control table SURVIVED the rollback').toBe(false);
    });
  });

  describe('leg 4 — the dependent closure a width migration must drop and recreate', () => {
    it('contains VIEWS only', async () => {
      const closure = await measureDependentClosure(sql, PROSE_VECTOR_COLUMNS);

      // A non-empty closure is itself part of the assertion: an empty one would
      // mean the walk stopped matching, and "no offending relkinds" would then be
      // vacuously true — the same silent-pass shape the measurement guard above
      // exists to prevent.
      expect(
        closure.length,
        'the dependent closure is EMPTY — the pg_depend/pg_rewrite walk is broken, ' +
          'not the schema (work_items.embedding alone has dependents)',
      ).toBeGreaterThan(0);

      const nonViews = closure.filter((c) => c.relkind !== 'v');
      expect(
        nonViews,
        nonViews
          .map(
            (c) =>
              `${c.nspname}.${c.relname} has relkind='${c.relkind}' in the dependent ` +
              `closure. Only plain views ('v') are safe to drop and recreate around the ` +
              `ALTER — anything else needs repopulating or its own indexes rebuilt.`,
          )
          .join('\n'),
      ).toEqual([]);
    });
  });
});
