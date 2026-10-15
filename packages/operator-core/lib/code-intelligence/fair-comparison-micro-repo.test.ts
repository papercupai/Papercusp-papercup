import { describe, expect, it } from 'vitest';
import { FAIR_INTENTS, scoreCase, type ArmCapabilities, type FairCase } from './fair-comparison';
import {
  deriveMicroKeys,
  MICRO_CASES,
  MICRO_REPO_FILES,
  MICRO_REPO_MARKED,
  microRepoKeys,
  parseMicroMarkers,
  stripMicroMarkers,
} from './fair-comparison-micro-repo';

const keyOf = (id: string) => {
  const k = microRepoKeys().find((x) => x.caseId === id);
  if (!k) throw new Error(`no key ${id}`);
  return k;
};
const caseOf = (id: string): FairCase => {
  const c = MICRO_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const allIntents: ArmCapabilities = { armId: 'test', version: '0', intents: [...FAIR_INTENTS], licence: 'first-party' };
const site = (s: string) => {
  const i = s.lastIndexOf(':');
  return { path: s.slice(0, i), line1: Number(s.slice(i + 1)), kind: null };
};
const answerOf = (id: string, sites: readonly string[]) => ({ caseId: id, status: 'answered' as const, sites: sites.map(site), latencyMs: 1 });

describe('micro repo markers (P-017 calibration fixture)', () => {
  it('derives a consistent key for every case', () => {
    const { keys, problems } = deriveMicroKeys(MICRO_REPO_MARKED, MICRO_CASES);
    expect(problems).toEqual([]);
    expect(keys.map((k) => k.caseId).sort()).toEqual(MICRO_CASES.map((c) => c.id).sort());
  });

  it('has a plain case for every intent and unique case ids', () => {
    for (const intent of FAIR_INTENTS) expect(MICRO_CASES.some((c) => c.intent === intent && c.tags.length === 0)).toBe(true);
    expect(new Set(MICRO_CASES.map((c) => c.id)).size).toBe(MICRO_CASES.length);
    expect(MICRO_CASES.every((c) => c.source === 'micro-repo')).toBe(true);
  });

  it('strips every marker without moving a line', () => {
    for (const [path, lines] of Object.entries(MICRO_REPO_MARKED)) {
      const body = MICRO_REPO_FILES[path]!;
      expect(body).not.toContain('@fair');
      expect(body.split('\n').length).toBe(lines.length + 1);
      for (const c of MICRO_CASES) expect(body).not.toContain(c.id);
    }
  });

  it('records the D-012 answer units for the barrel/same-name callers case', () => {
    const k = keyOf('micro-callers-add');
    expect(k.sites).toEqual(['src/app/report.ts:4', 'src/app/report.ts:7', 'src/util/math.ts:7']);
    expect(k.aliases).toEqual({
      'src/util/math.ts:6': 'src/util/math.ts:7',
      // D-013 module scope: line 1 stands for the module's top level, so it aliases the first top-level call.
      'src/app/report.ts:1': 'src/app/report.ts:4',
      'src/app/report.ts:6': 'src/app/report.ts:7',
      'src/app/report.ts:8': 'src/app/report.ts:7',
    });
    expect(k.neutral).toEqual(['src/util/math.ts:2']);
    // The barrel's line 1 is a re-export, and the barrel has no top-level call: rejected.
    expect(k.rejected).toEqual(['src/app/format.ts:8', 'src/util/index.ts:1']);
  });

  it('scores a function-granularity answer and a line-granularity answer the same', () => {
    const kase = caseOf('micro-callers-add');
    const key = keyOf('micro-callers-add');
    const byScopeDecl = scoreCase(kase, allIntents, key, answerOf(kase.id, ['src/util/math.ts:6', 'src/app/report.ts:6', 'src/app/report.ts:4']));
    const byCallLine = scoreCase(kase, allIntents, key, answerOf(kase.id, ['src/util/math.ts:7', 'src/app/report.ts:7', 'src/app/report.ts:8', 'src/app/report.ts:4']));
    expect(byScopeDecl.outcome).toBe('correct');
    expect(byCallLine.outcome).toBe('correct');
  });

  it('penalises the same-name trap and counts no unruled site', () => {
    const kase = caseOf('micro-callers-add');
    const s = scoreCase(kase, allIntents, keyOf(kase.id), answerOf(kase.id, ['src/util/math.ts:7', 'src/app/report.ts:7', 'src/app/report.ts:4', 'src/app/format.ts:8']));
    expect(s.outcome).toBe('partial');
    expect(s.precision).toBeCloseTo(0.75);
    expect(s.unadjudicated).toBe(0);
  });

  it('keeps absence cases empty and flags a false positive on them', () => {
    for (const c of MICRO_CASES.filter((x) => x.tags.includes('absence'))) expect(keyOf(c.id).sites).toEqual([]);
    const kase = caseOf('micro-callers-never-called');
    const s = scoreCase(kase, allIntents, keyOf(kase.id), answerOf(kase.id, ['src/util/index.ts:1']));
    expect(s.absenceFalsePositive).toBe(true);
  });

  it('keys every line that contains the text-search literal', () => {
    expect(keyOf('micro-text-search-grand-total').sites).toEqual(['src/app/report.ts:18', 'src/app/report.ts:3']);
  });
});

describe('deriveMicroKeys refuses an inconsistent marker set', () => {
  const kase: FairCase = { id: 'micro-x', intent: 'callers', subject: 'foo', tags: [], source: 'micro-repo' };
  const derive = (lines: string[], cases: FairCase[] = [kase]) => deriveMicroKeys({ 'src/a.ts': lines }, cases).problems;

  it('accepts a minimal valid set (control)', () => {
    expect(derive(['function bar() {', '  foo(); // @fair k:micro-x#bar', '}']).filter((p) => !p.startsWith('intent '))).toEqual([]);
  });

  it('flags an alias whose unit has no canonical site', () => {
    expect(derive(['function bar() { // @fair a:micro-x#bar', '  foo(); // @fair k:micro-x#baz', '}'])).toContainEqual(expect.stringContaining('alias src/a.ts:1 names unit bar'));
  });

  it('flags two canonical sites for one unit', () => {
    expect(derive(['foo(); // @fair k:micro-x#u', 'foo(); // @fair k:micro-x#u'])).toContainEqual(expect.stringContaining('two canonical'));
  });

  it('flags a canonical line that does not name the subject', () => {
    expect(derive(['bar(); // @fair k:micro-x'])).toContainEqual(expect.stringContaining('does not name foo'));
  });

  it('flags a non-absence case with no answer and an absence case with one', () => {
    expect(derive(['foo();'])).toContainEqual(expect.stringContaining('not tagged absence'));
    expect(derive(['foo(); // @fair k:micro-x'], [{ ...kase, tags: ['absence'] }])).toContainEqual(expect.stringContaining('tagged absence'));
  });

  it('flags a marker for an unknown case and a malformed marker', () => {
    const p = derive(['foo(); // @fair k:micro-x', 'foo(); // @fair k:micro-unknown', 'foo(); // @fair zz']);
    expect(p).toContainEqual(expect.stringContaining('names no case'));
    expect(p).toContainEqual(expect.stringContaining('malformed'));
  });

  it('flags a text-search line that contains the literal but is not keyed', () => {
    const t: FairCase = { id: 'micro-t', intent: 'text-search', subject: 'needle', tags: [], source: 'micro-repo' };
    expect(derive(["const a = 'needle'; // @fair k:micro-t", "const b = 'needle';"], [t])).toContainEqual(expect.stringContaining('src/a.ts:2 contains the literal'));
  });

  it('parses multiple tokens on one line and strips them', () => {
    const marked = { 'src/a.ts': ['foo(); // @fair k:micro-x#u n:micro-y r:micro-z'] };
    expect(parseMicroMarkers(marked).map((m) => `${m.kind}:${m.caseId}#${m.unit}`)).toEqual(['k:micro-x#u', 'n:micro-y#null', 'r:micro-z#null']);
    expect(stripMicroMarkers(marked)['src/a.ts']).toBe('foo();\n');
  });
});
