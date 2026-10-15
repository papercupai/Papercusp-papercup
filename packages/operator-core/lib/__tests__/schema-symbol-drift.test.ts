// gate-test-reuse-yield-2026-10-01 P-007 (D-010): a regenerated DB schema reaches only the gate
// proofs that name a changed table. The rule lives in scripts/lib/schema-symbol-drift.mjs and is
// consulted by selectReusablePasses (scripts/lib/test-pass-reuse.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The subject module is overridable (SCHEMA_SYMBOL_DRIFT_SUBJECT = an absolute path to a copy) so
// scripts/mutation-probe.sh can run this suite against a mutated copy without touching the shared
// tree. Unset, it is the real module.
type DriftSubject = typeof import('../../../../scripts/lib/schema-symbol-drift.mjs');
const driftSubjectOverride = process.env.SCHEMA_SYMBOL_DRIFT_SUBJECT;
const driftSubject: DriftSubject = driftSubjectOverride
  ? await import(pathToFileURL(driftSubjectOverride).href)
  : await import('../../../../scripts/lib/schema-symbol-drift.mjs');
const {
  GENERATED_SCHEMA_FILES,
  changedSchemaSymbols,
  createSchemaDriftJudge,
  drizzleConstructionSmoke,
  exportBlocks,
  gitReadAtSha,
  moduleSchemaUse,
} = driftSubject;
import {
  TEST_REUSE_MAX_AGE_MS_DEFAULT,
  formatTestReuseLine,
  selectReusablePasses,
} from '../../../../scripts/lib/test-pass-reuse.mjs';

const ROOT = join(__dirname, '../../../..');
const [GEN, REL] = GENERATED_SCHEMA_FILES;
const CONN = 'libs/papercusp/libs/db/src/connection.ts';

const HEADER = 'import { pgSchema, text } from "drizzle-orm/pg-core"\n\nexport const harnessShared = pgSchema("harness_shared");\n';
const table = (name: string, pg: string, extra = '') =>
  `export const ${name} = harnessShared.table("${pg}", {\n\tid: text().primaryKey(),${extra}\n});\n`;
const GEN_A = HEADER + table('fooInHarnessShared', 'foo') + table('barInHarnessShared', 'bar');
const REL_A =
  'import { relations } from "drizzle-orm/relations";\nimport { fooInHarnessShared, barInHarnessShared } from "./generated";\n\n' +
  'export const fooInHarnessSharedRelations = relations(fooInHarnessShared, ({many}) => ({\n\tbarInHarnessShareds: many(barInHarnessShared),\n}));\n';

describe('exportBlocks / changedSchemaSymbols', () => {
  it('splits a header from one block per export', () => {
    const b = exportBlocks(GEN_A);
    expect([...b.blocks.keys()]).toEqual(['harnessShared', 'fooInHarnessShared', 'barInHarnessShared']);
    expect(b.header).toContain('import { pgSchema');
  });

  it('names only an ADDED table when nothing else references it', () => {
    const S = changedSchemaSymbols({ beforeGen: GEN_A, beforeRel: REL_A, afterGen: GEN_A + table('bazInHarnessShared', 'baz'), afterRel: REL_A });
    expect(S && [...S].sort()).toEqual(['bazInHarnessShared']);
  });

  it('closes over relations: a relation block that gains an edge brings its owner table in', () => {
    const relB = REL_A.replace('many(barInHarnessShared),', 'many(barInHarnessShared),\n\tbazInHarnessShareds: many(bazInHarnessShared),');
    const S = changedSchemaSymbols({ beforeGen: GEN_A, beforeRel: REL_A, afterGen: GEN_A + table('bazInHarnessShared', 'baz'), afterRel: relB });
    expect(S && [...S].sort()).toEqual(['bazInHarnessShared', 'fooInHarnessShared', 'fooInHarnessSharedRelations']);
  });

  it('closes over the table file: a foreign key to a changed table brings the referencing table in', () => {
    const genA = GEN_A + table('quxInHarnessShared', 'qux', '\n\tbarId: text().references(() => barInHarnessShared.id),');
    const genB = genA.replace('table("bar", {\n\tid: text().primaryKey(),', 'table("bar", {\n\tid: text().primaryKey(),\n\tnote: text(),');
    const S = changedSchemaSymbols({ beforeGen: genA, beforeRel: REL_A, afterGen: genB, afterRel: REL_A });
    // bar changed; qux references it; foo's relations name bar, so foo joins too.
    expect(S && [...S].sort()).toEqual(['barInHarnessShared', 'fooInHarnessShared', 'fooInHarnessSharedRelations', 'quxInHarnessShared']);
  });

  it('judges the file whole when the header changes or a changed block carries a foreign declaration', () => {
    expect(changedSchemaSymbols({ beforeGen: GEN_A, beforeRel: REL_A, afterGen: GEN_A.replace('pgSchema, text', 'pgSchema, text, uuid'), afterRel: REL_A })).toBeNull();
    const withHelper = GEN_A + 'const helper = 1;\n';
    expect(changedSchemaSymbols({ beforeGen: GEN_A, beforeRel: REL_A, afterGen: withHelper, afterRel: REL_A })).toBeNull();
    expect(changedSchemaSymbols({ beforeGen: '', beforeRel: REL_A, afterGen: GEN_A, afterRel: REL_A })).toBeNull();
  });

  it('a relations import-list change alone affects nothing', () => {
    const relB = REL_A.replace('barInHarnessShared } from', 'barInHarnessShared, bazInHarnessShared } from');
    const S = changedSchemaSymbols({ beforeGen: GEN_A, beforeRel: REL_A, afterGen: GEN_A, afterRel: relB });
    expect(S && [...S]).toEqual([]);
  });
});

describe('moduleSchemaUse', () => {
  it('collects tokens, including names in strings and comments', () => {
    const u = moduleSchemaUse("// fooInHarnessShared\nconst t = 'barInHarnessShared';");
    expect(u.tokens.has('fooInHarnessShared')).toBe(true);
    expect(u.tokens.has('barInHarnessShared')).toBe(true);
    expect(u.dynamic).toBe(false);
  });

  it('flags dynamic reads of an imported generated namespace under any alias, and of a drizzle instance', () => {
    expect(moduleSchemaUse("import { generated as g } from '@papercusp/db-org';\nfor (const [k, v] of Object.entries(g)) use(k, v);").dynamic).toBe(true);
    expect(moduleSchemaUse("import { generated } from '@papercusp/db';\nconst t = generated[name];").dynamic).toBe(true);
    expect(moduleSchemaUse("import * as gen from './schema/generated';\nconst all = { ...gen };").dynamic).toBe(true);
    expect(moduleSchemaUse('const rows = await db.query[name].findMany();').dynamic).toBe(true);
  });

  it('does not flag a LOCAL variable that happens to be named generated', () => {
    expect(moduleSchemaUse('const generated = run();\nfor (const k of Object.keys(generated)) log(k);').dynamic).toBe(false);
  });
});

describe('createSchemaDriftJudge', () => {
  const files: Record<string, string> = {
    [GEN]: GEN_A + table('bazInHarnessShared', 'baz'),
    [REL]: REL_A,
    'pkg/uses-baz.ts': 'export const q = () => db.select().from(generated.bazInHarnessShared);',
    'pkg/uses-foo.ts': 'export const q = () => db.query.fooInHarnessShared.findMany();',
    'pkg/dynamic.ts': "import { generated } from '@papercusp/db-org';\nexport const all = Object.keys(generated);",
    [CONN]: 'const fullSchema = { ...generatedSchema };',
  };
  const judge = (over: { smoke?: () => boolean; readJudged?: (rel: string) => string } = {}) =>
    createSchemaDriftJudge({
      judgedSha: 'new',
      readAtSha: (_sha: string, rel: string) => ({ [GEN]: GEN_A, [REL]: REL_A } as Record<string, string>)[rel] ?? '',
      readJudged: over.readJudged ?? ((rel: string) => {
        if (!(rel in files)) throw new Error(`missing ${rel}`);
        return files[rel];
      }),
      constructionSmoke: over.smoke ?? (() => true),
    });
  const p = (mods: string[]) => ({ recordedSha: 'old', executedModules: [GEN, REL, CONN, ...mods] });

  it('spares a proof that names no changed table, and convicts one that does', () => {
    const j = judge();
    expect(j(p(['pkg/uses-foo.ts']))).toBe(true);
    expect(j(p(['pkg/uses-baz.ts']))).toBe(false);
  });

  it('convicts a proof that reads the namespace dynamically, whatever it names', () => {
    expect(judge()(p(['pkg/uses-foo.ts', 'pkg/dynamic.ts']))).toBe(false);
  });

  it('fails closed: a failed construction smoke, an unreadable module, or the judged sha itself', () => {
    expect(judge({ smoke: () => false })(p(['pkg/uses-foo.ts']))).toBe(false);
    expect(judge({ smoke: () => { throw new Error('boom'); } })(p(['pkg/uses-foo.ts']))).toBe(false);
    expect(judge()(p(['pkg/gone.ts']))).toBe(false);
    expect(judge()({ recordedSha: 'new', executedModules: [GEN] })).toBe(false);
  });
});

describe('selectReusablePasses with a schema drift judge', () => {
  const CTX = 'green-checkpoint';
  const RUNNER = 'runner';
  const NOW = Date.UTC(2026, 9, 1, 18);
  const T = 'pkg/src/a.test.ts';
  const proof = (over: Record<string, unknown> = {}) => ({
    recordedSha: 'old',
    recordedAtMs: NOW - 3600_000,
    executedModules: [T, GEN, REL, CONN],
    readPaths: [] as string[],
    inputsCaptured: true,
    opaqueReasons: [] as string[],
    runContext: CTX,
    runnerIdentity: RUNNER,
    ...over,
  });
  const select = (pr: ReturnType<typeof proof>, drift: string[], schemaDriftJudge: ((x: unknown) => boolean) | null) =>
    selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, pr]]),
      judgedSha: 'new',
      changedBetween: () => new Set(drift),
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
      schemaDriftJudge,
    });

  it('reuses a proof whose only executed drift is the generated schema when the judge clears it', () => {
    const r = select(proof(), [GEN, REL], () => true);
    expect(r.summary).toMatchObject({ reused: 1, inputChanged: 0, schemaNarrowed: 1 });
    expect(formatTestReuseLine('@papercusp/x', r.summary)).toMatch(/ schemaNarrowed=1$/);
  });

  it('keeps the whole-file rule without a judge, when the judge says no or throws', () => {
    expect(select(proof(), [GEN], null).summary).toMatchObject({ reused: 0, inputChanged: 1, schemaNarrowed: 0 });
    expect(select(proof(), [GEN], () => false).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    expect(select(proof(), [GEN], () => { throw new Error('x'); }).summary).toMatchObject({ reused: 0, inputChanged: 1 });
  });

  it('reduces invalidated proofs on the same complete cohort while still rejecting changed-table users', () => {
    // This is a relative-yield detector, not the plan's historical 1,300/990 replay.
    const candidates = ['pkg/foo.test.ts', 'pkg/bar.test.ts', 'pkg/baz.test.ts', 'pkg/dynamic.test.ts'];
    const modules: Record<string, string> = {
      [GEN]: GEN_A + table('bazInHarnessShared', 'baz'),
      [REL]: REL_A,
      [CONN]: 'const fullSchema = { ...generatedSchema };',
      [candidates[0]!]: 'db.query.fooInHarnessShared.findMany();',
      [candidates[1]!]: 'db.query.barInHarnessShared.findMany();',
      [candidates[2]!]: 'db.query.bazInHarnessShared.findMany();',
      [candidates[3]!]: "import { generated } from '@papercusp/db-org'; Object.keys(generated);",
    };
    const proofs = new Map(candidates.map((file) => [file, proof({ executedModules: [file, GEN, REL, CONN] })]));
    const judge = createSchemaDriftJudge({
      judgedSha: 'new',
      readAtSha: (_sha: string, rel: string) => ({ [GEN]: GEN_A, [REL]: REL_A } as Record<string, string>)[rel] ?? '',
      readJudged: (rel: string) => {
        if (!(rel in modules)) throw new Error(`missing ${rel}`);
        return modules[rel]!;
      },
      constructionSmoke: () => true,
    });
    const replay = (schemaDriftJudge: typeof judge | null) => selectReusablePasses({
      candidates,
      proofs,
      judgedSha: 'new',
      changedBetween: () => new Set([GEN]),
      runContext: CTX,
      runnerIdentity: RUNNER,
      nowMs: NOW,
      maxAgeMs: TEST_REUSE_MAX_AGE_MS_DEFAULT,
      auditRate: 0,
      schemaDriftJudge,
    });
    const before = replay(null);
    const after = replay(judge);
    expect(before.summary).toMatchObject({ candidates: 4, reused: 0, inputChanged: 4 });
    expect(after.summary).toMatchObject({ candidates: 4, reused: 2, inputChanged: 2, schemaNarrowed: 2 });
    expect(after.summary.inputChanged).toBeLessThan(before.summary.inputChanged);
    expect(after.skip).toEqual([candidates[1], candidates[0]]);
    expect(after.skip).not.toContain(candidates[2]);
    expect(after.skip).not.toContain(candidates[3]);
  });

  it('never narrows other executed drift, nor a schema file the test READ through fs', () => {
    expect(select(proof(), [GEN, CONN], () => true).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    expect(select(proof({ readPaths: [GEN] }), [GEN], () => true).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    expect(select(proof({ readPaths: ['libs/papercusp/libs/db/src/schema/'] }), [GEN], () => true).summary).toMatchObject({ reused: 0, inputChanged: 1 });
  });
});

describe('real tree', () => {
  it('reads a submodule file at a superproject sha through its gitlink', () => {
    const exec = (f: string, a: string[], o: object) => execFileSync(f, a, o as never) as unknown as string;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const text = gitReadAtSha(exec, ROOT, head, REL);
    expect(text).toMatch(/^import \{ relations \} from "drizzle-orm\/relations";/);
    expect(() => gitReadAtSha(exec, ROOT, head, 'libs/papercusp/libs/db/src/schema/no-such-file.ts')).toThrow();
  });

  it('every changed block in the real generated files is an export-only block (no foreign declaration)', () => {
    // If the generator starts emitting helpers between exports, every schema change falls back
    // to the whole-file rule. That is safe but silently forfeits P-007's yield: fail loudly here.
    for (const rel of GENERATED_SCHEMA_FILES) {
      const { blocks } = exportBlocks(readFileSync(join(ROOT, rel), 'utf8'));
      expect(blocks.size).toBeGreaterThan(50);
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(changedSchemaSymbols({ beforeGen: src, beforeRel: src, afterGen: src, afterRel: src })).toEqual(new Set());
    }
  });

  it('the construction smoke passes on the real tree and fails on a relation that throws', () => {
    expect(drizzleConstructionSmoke({ repoRoot: ROOT })).toBe(true);
    // The smoke trusts only its marker: a child that prints nothing (it threw) is a failure.
    expect(drizzleConstructionSmoke({ repoRoot: ROOT, exec: () => '' })).toBe(false);
    expect(drizzleConstructionSmoke({ repoRoot: ROOT, exec: () => 'SCHEMA_CONSTRUCTION_SMOKE_OK tables=0' })).toBe(false);
  }, 180_000);
});
