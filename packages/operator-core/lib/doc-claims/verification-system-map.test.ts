/**
 * P-001 (verification-system-improvements-2026-10-10, bar R-1, clauses
 * AUTO-BAR-R-1-P-001 / SPEC-P-001-MAP / SPEC-P-001-BAR-TIMING): pin the
 * verification-system map doc, CLAUDE.md and the plan-completion runbook to the
 * code they describe.
 *
 * FIXTURE CONTROLS come first and are load-bearing: once the live assertions go
 * green they stop being evidence that the judges can say NO. Each control
 * reproduces a drift shape the bar's falsifier names. Each judge also has a
 * CALIBRATION case — a genuinely correct input it must accept — so a judge broken
 * into "everything fails" cannot pass the controls and look strong.
 *
 * The LIVE half derives the expected refusal-code set from the registered typed
 * unions with the TypeScript checker (noResolve over the gate modules: ~0.3s), so
 * adding a union member is enough to demand a map entry and a triggering test.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_GATE_CODE_TYPES,
  OPERATIONAL_DOOR_CODES,
  extractMapRefusalCodes,
  findUnregisteredDoorCodes,
  judgeBarTiming,
  judgeVerificationSystemMap,
  testAssertsOnCode,
} from './verification-system-map';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = join(ROOT, 'packages/operator-core/lib');
const DOCS = join(ROOT, 'apps/operator-docs/src/content/docs');
const MAP_DOC = join(DOCS, 'agent-insights/verification-system-map.mdx');
const RUNBOOK = join(DOCS, 'agent-insights/acceptance-rubrics-on-every-plan-runbook.mdx');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

/** Modules whose types a registered union is built from, beyond the registry's own. */
const EXTRA_ROOTS = ['agent-tools/plans/plan-input-validation.ts'];

/** Door modules scanned for refusal literals that escaped every registered union. */
const DOOR_MODULES = [
  'agent-tools/plans/set-plan-status.ts',
  'agent-tools/plans/start.ts',
  'agent-tools/plans/plan-start-gate.ts',
  'agent-tools/plans/draft-item-start-gate.ts',
  'agent-tools/plans/bind-spec-evidence.ts',
  'agent-tools/plans/acceptance-drain-disposition.ts',
];

const SELF = new Set(['verification-system-map.ts', 'verification-system-map.test.ts']);

// ---------------------------------------------------------------- fixtures

describe('judgeVerificationSystemMap — controls and calibration', () => {
  const derived = new Map<string, { door: string; source: string | null }>([
    ['zz_alpha_refused', { door: 'plans:start', source: 'a.ts:1' }],
    ['zz_beta_refused', { door: 'plans:start', source: 'a.ts:2' }],
  ]);
  const tests = new Map([['zz_alpha_refused', 'a.test.ts'], ['zz_beta_refused', 'b.test.ts']]);

  it('CALIBRATION: accepts a map naming exactly the derived codes, each sourced and tested', () => {
    const f = judgeVerificationSystemMap({ mapCodes: ['zz_alpha_refused', 'zz_beta_refused'], derived, triggeringTest: tests });
    expect(f).toEqual({ omitted: [], unknown: [], noSource: [], noTest: [] });
  });

  it('CONTROL: a code the gates emit but the map omits is reported', () => {
    const f = judgeVerificationSystemMap({ mapCodes: ['zz_alpha_refused'], derived, triggeringTest: tests });
    expect(f.omitted).toEqual(['zz_beta_refused']);
  });

  it('CONTROL: a code the map names but no gate declares is reported', () => {
    const f = judgeVerificationSystemMap({ mapCodes: ['zz_alpha_refused', 'zz_beta_refused', 'zz_gone_refused'], derived, triggeringTest: tests });
    expect(f.unknown).toEqual(['zz_gone_refused']);
  });

  it('CONTROL: a code with no source definition or no triggering test is reported', () => {
    const d2 = new Map(derived);
    d2.set('zz_beta_refused', { door: 'plans:start', source: null });
    const f = judgeVerificationSystemMap({
      mapCodes: ['zz_alpha_refused', 'zz_beta_refused'],
      derived: d2,
      triggeringTest: new Map([['zz_alpha_refused', null], ['zz_beta_refused', 'b.test.ts']]),
    });
    expect(f.noSource).toEqual(['zz_beta_refused']);
    expect(f.noTest).toEqual(['zz_alpha_refused']);
  });
});

describe('map doc extraction', () => {
  const doc = [
    '# Map', '', 'Uses `plans:start` and `set-plan-status`.', '',
    '## Refusal codes', '', '| code | meaning |', '|---|---|',
    '| `zz_alpha_refused` | x |', '| `zz-kebab-code` | y |', 'prose `zz_not_a_row`', '',
    '## Tables', '| `zz_other_section` | z |',
  ].join('\n');

  it('takes only first-column codes of table rows inside the Refusal codes section', () => {
    expect(extractMapRefusalCodes(doc)).toEqual(['zz_alpha_refused', 'zz-kebab-code']);
  });

  it('CONTROL: a page with no Refusal codes section names no codes', () => {
    expect(extractMapRefusalCodes('# Map\n| `zz_alpha_refused` | x |')).toEqual([]);
  });
});

describe('testAssertsOnCode', () => {
  it('CALIBRATION: counts a literal inside an expect(...) statement', () => {
    expect(testAssertsOnCode("expect(r).toMatchObject({\n  code: 'zz_alpha_refused',\n});", 'zz_alpha_refused')).toBe(true);
  });

  it('CONTROL: a literal used only to build a fixture does not count', () => {
    const t = "const input = { code: 'zz_alpha_refused' };\nconst x = 1;\nconst y = 2;\nconst z = 3;\nexpect(run(input)).toBe(true);";
    expect(testAssertsOnCode(t, 'zz_alpha_refused')).toBe(false);
  });

  it('CALIBRATION: counts a literal deep inside a multi-line toMatchObject', () => {
    const t = "expect(result).toMatchObject({\n  satisfied: false,\n  applicable: true,\n  mode: 'enforced',\n  code: 'zz_alpha_refused',\n});";
    expect(testAssertsOnCode(t, 'zz_alpha_refused')).toBe(true);
  });

  it('CONTROL: a literal on the line after a finished expect statement does not count', () => {
    const t = "expect(result.ok).toBe(false);\nconst next = { code: 'zz_alpha_refused' };";
    expect(testAssertsOnCode(t, 'zz_alpha_refused')).toBe(false);
  });

  it('CALIBRATION: follows a matcher chained on the next line after a balanced expect(...)', () => {
    const t = "expect(await store({ id: 1 }))\n  .toMatchObject({ status: 'zz_alpha_refused' });";
    expect(testAssertsOnCode(t, 'zz_alpha_refused')).toBe(true);
  });

  it('CONTROL: a statement after a chained matcher has finished does not count', () => {
    const t = "expect(await f())\n  .toBe(true);\nconst fixture = { status: 'zz_alpha_refused' };";
    expect(testAssertsOnCode(t, 'zz_alpha_refused')).toBe(false);
  });

  it('CALIBRATION: counts a literal passed to an expect*/assert* helper (EI-25652573114035984)', () => {
    expect(testAssertsOnCode("expectRefused(result, 'zz_alpha_refused');", 'zz_alpha_refused')).toBe(true);
    expect(testAssertsOnCode("assertRefusal(\n  result,\n  'zz_alpha_refused',\n);", 'zz_alpha_refused')).toBe(true);
    expect(testAssertsOnCode("assert.equal(result.code, 'zz_alpha_refused');", 'zz_alpha_refused')).toBe(true);
    const inlineBody = "const expectOk = (r: Result) => expect(r).toMatchObject({ code: 'zz_alpha_refused' });";
    expect(testAssertsOnCode(inlineBody, 'zz_alpha_refused')).toBe(true);
  });

  it('CONTROL: a helper definition line and look-alike names do not count', () => {
    const definition = "function expectRefused(r: Result, code = 'zz_alpha_refused') {\n  return r;\n}";
    expect(testAssertsOnCode(definition, 'zz_alpha_refused')).toBe(false);
    const arrow = "const assertCode = (r: Result) => r.code === 'zz_alpha_refused';";
    expect(testAssertsOnCode(arrow, 'zz_alpha_refused')).toBe(false);
    expect(testAssertsOnCode("const v = expected(input, 'zz_alpha_refused');", 'zz_alpha_refused')).toBe(false);
    expect(testAssertsOnCode("assertion(input, 'zz_alpha_refused');", 'zz_alpha_refused')).toBe(false);
  });
});

describe('findUnregisteredDoorCodes', () => {
  it('CONTROL: a refusal literal in no union and not classified operational is reported', () => {
    const mod = "return { error: 'zz_new_refusal', code: 'zz_alpha_refused' };\nreturn { error: 'not_found' };";
    expect(findUnregisteredDoorCodes(mod, new Set(['zz_alpha_refused']))).toEqual(['zz_new_refusal']);
  });

  it('CALIBRATION: registered and operational literals pass', () => {
    expect(findUnregisteredDoorCodes("return { code: 'zz_alpha_refused', error: 'busy' };", new Set(['zz_alpha_refused']))).toEqual([]);
  });
});

describe('judgeBarTiming', () => {
  const good = 'Acceptance bars are seeded at plan activation from the requirements; at completion you amend them to as-built reality.';
  it('CALIBRATION: two docs stating the same timing pass', () => {
    expect(judgeBarTiming({ a: good, b: good })).toEqual([]);
  });
  it('CONTROL: a doc still saying "author the rubric after implementation" fails', () => {
    const stale = 'Step 3. Author the rubric AFTER implementation.';
    const problems = judgeBarTiming({ a: good, b: stale });
    expect(problems.some((p) => p.startsWith('b: still says'))).toBe(true);
    expect(problems.some((p) => p.startsWith('b: missing'))).toBe(true);
  });
});

// ---------------------------------------------------------------- live tree

interface Derivation {
  derived: Map<string, { door: string; source: string | null }>;
  problems: string[];
}

function deriveContractCodes(): Derivation {
  const roots = [...new Set([...CONTRACT_GATE_CODE_TYPES.map((g) => g.module), ...EXTRA_ROOTS])];
  const program = ts.createProgram(roots.map((m) => join(LIB, m)), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    noResolve: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
  });
  const checker = program.getTypeChecker();
  const texts = new Map(roots.map((m) => [m, readFileSync(join(LIB, m), 'utf8')]));
  const derived = new Map<string, { door: string; source: string | null }>();
  const problems: string[] = [];
  const locate = (code: string, preferred: string): string | null => {
    for (const m of [preferred, ...roots.filter((r) => r !== preferred)]) {
      const lines = texts.get(m)!.split('\n');
      const i = lines.findIndex((l) => l.includes(`'${code}'`) || l.includes(`"${code}"`));
      if (i >= 0) return `packages/operator-core/lib/${m}:${i + 1}`;
    }
    return null;
  };
  for (const g of CONTRACT_GATE_CODE_TYPES) {
    const label = `${g.module}#${g.type}${g.property ? `.${g.property}` : ''}`;
    const sf = program.getSourceFile(join(LIB, g.module));
    const moduleSym = sf && checker.getSymbolAtLocation(sf);
    const sym = moduleSym && checker.getExportsOfModule(moduleSym).find((s) => s.name === g.type);
    if (!sym) { problems.push(`${label}: type is not exported`); continue; }
    let type = checker.getDeclaredTypeOfSymbol(sym);
    if (g.property) {
      const prop = type.getProperty(g.property);
      if (!prop) { problems.push(`${label}: no such property`); continue; }
      type = checker.getTypeOfSymbol(prop);
    }
    const parts = type.isUnion() ? type.types : [type];
    for (const p of parts) {
      if (!p.isStringLiteral()) { problems.push(`${label}: member ${checker.typeToString(p)} is not a string literal`); continue; }
      if (!derived.has(p.value)) derived.set(p.value, { door: g.door, source: locate(p.value, g.module) });
    }
  }
  return { derived, problems };
}

function testCorpus(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.test.ts') && !SELF.has(e)) out.push({ file: relative(ROOT, p), text: readFileSync(p, 'utf8') });
    }
  };
  walk(LIB);
  return out;
}

describe('LIVE: the verification-system map matches the contract gates', () => {
  const { derived, problems } = deriveContractCodes();

  it('every registered union resolves to string-literal codes', () => {
    expect(problems).toEqual([]);
    expect(derived.size).toBeGreaterThan(50);
  });

  it('the map names exactly the derived codes, each with a source definition and a triggering test', () => {
    const corpus = testCorpus();
    expect(corpus.length).toBeGreaterThan(1000);
    const triggeringTest = new Map<string, string | null>();
    for (const code of derived.keys()) {
      triggeringTest.set(code, corpus.find((t) => testAssertsOnCode(t.text, code))?.file ?? null);
    }
    const mapCodes = extractMapRefusalCodes(readFileSync(MAP_DOC, 'utf8'));
    expect(mapCodes.length).toBeGreaterThan(0);
    expect(judgeVerificationSystemMap({ mapCodes, derived, triggeringTest })).toEqual({
      omitted: [], unknown: [], noSource: [], noTest: [],
    });
  }, 60_000);

  it('no door module emits a refusal literal outside the registered unions', () => {
    const codes = new Set(derived.keys());
    const stray = DOOR_MODULES.flatMap((m) =>
      findUnregisteredDoorCodes(readFileSync(join(LIB, m), 'utf8'), codes).map((c) => `${m}: ${c}`));
    expect(stray).toEqual([]);
  });

  it('operational classifications are not also contract codes', () => {
    expect(Object.keys(OPERATIONAL_DOOR_CODES).filter((c) => derived.has(c))).toEqual([]);
  });
});

describe('LIVE: CLAUDE.md and the plan-completion runbook state the same bar timing', () => {
  it('both say bars are seeded at activation and amended to as-built at completion', () => {
    expect(judgeBarTiming({
      'CLAUDE.md': readFileSync(CLAUDE_MD, 'utf8'),
      'acceptance-rubrics-on-every-plan-runbook': readFileSync(RUNBOOK, 'utf8'),
    })).toEqual([]);
  });
});
