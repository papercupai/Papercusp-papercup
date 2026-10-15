import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArmReport, CaseMeasurement, EngineRunMeta, PhaseCost, UpdateFixtureResult } from './engine-comparison';
import { ARM_ORDER, deriveRunMeta, orderReports, parseCliArgs, preregHash, renderEvidence } from './engine-comparison-report';
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const COST: PhaseCost = { wallMs: 60_000, peakRssKb: 2_048_000, ok: true, error: null, loadAvg1: 12 };
const META: EngineRunMeta = { runId: 'run-1', seed: 0, createdAt: '2026-10-01T00:00:00.000Z', preregHash: 'abc' };

const kase = (caseId: string, correct: boolean, error: string | null = null): CaseMeasurement => ({
  caseId,
  intent: 'callers',
  coldQueryMs: 120,
  warmQueryMs: 80,
  warmSamplesMs: [80],
  responseBytes: 400,
  estTokens: 100,
  correct,
  recall: correct ? 1 : 0,
  grade: { correct, missing: correct ? [] : ['a.ts:1'], extra: [], reason: correct ? 'ok' : 'missing a.ts:1' },
  returnedSites: [],
  error,
});

const fixture = (name: UpdateFixtureResult['name'], pass: boolean): UpdateFixtureResult => ({
  name,
  pass,
  detail: `${name} detail | with pipe`,
  refreshCost: COST,
  recoveryCost: COST,
  faultSurfaced: name === 'refresh-failure' ? true : null,
});

const report = (armId: string, fingerprint: string | null, ok: boolean): ArmReport => ({
  armId,
  version: '1.0.0',
  unavailable: null,
  treeFingerprint: fingerprint,
  coldIndex: COST,
  indexBytes: 10 * 1024 * 1024,
  cases: [kase('c1', ok), kase('c2', true)],
  fixtures: [fixture('edit', true), fixture('delete', ok), fixture('refresh-failure', true)],
  error: null,
});

describe('parseCliArgs', () => {
  it('defaults to every arm in canonical order, run mode, 3 warm samples', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'run', arms: [...ARM_ORDER], warmSamples: 3, outDir: null });
  });
  it('accepts a comma list, warm count, out dir and aggregate', () => {
    const o = parseCliArgs(['--arm', 'gitnexus-installed,codebase-memory', '--warm', '5', '--out', '/tmp/e', '--aggregate']);
    expect(o).toEqual({ mode: 'aggregate', arms: ['gitnexus-installed', 'codebase-memory'], warmSamples: 5, outDir: '/tmp/e' });
  });
  it('THROWS on every malformed input instead of silently defaulting', () => {
    expect(() => parseCliArgs(['--arm', 'nope'])).toThrow(/unknown arm/);
    expect(() => parseCliArgs(['--arm'])).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--arm', '--warm'])).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--warm', '0'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--warm', '2.5'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--warm', '21'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('preregHash', () => {
  it('is deterministic and changes with the case set or sample count', () => {
    expect(preregHash(['a', 'b'], 3)).toBe(preregHash(['a', 'b'], 3));
    expect(preregHash(['a', 'b'], 3)).not.toBe(preregHash(['a', 'c'], 3));
    expect(preregHash(['a', 'b'], 3)).not.toBe(preregHash(['a', 'b'], 4));
    expect(preregHash(['a', 'b'], 3)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('orderReports', () => {
  it('sorts by canonical arm order and keeps an unknown arm last, never dropped', () => {
    const out = orderReports([report('codebase-memory', 'f', true), report('zzz-extra', 'f', true), report('baseline-lsp-rg', 'f', true)]);
    expect(out.map((r) => r.armId)).toEqual(['baseline-lsp-rg', 'codebase-memory', 'zzz-extra']);
  });
});

describe('renderEvidence', () => {
  const all = ARM_ORDER.map((id) => report(id, 'tree-1', true));

  it('renders every section, the verdict and the disclosures', () => {
    const b = renderEvidence(all, META, ['note one']);
    for (const h of ['# Engine comparison — run run-1', '## Summary', '## Per-case measurements', '## Update fixtures', '## Source parity', '## Disposition', '## Disclosures']) {
      expect(b.markdown).toContain(h);
    }
    expect(b.markdown).toContain('- note one');
    expect(b.markdown).toMatch(/decision: \*\*(keep|upgrade|replace|inconclusive)\*\*/);
    expect(b.markdown).toContain('identical tree fingerprint across arms: **YES**');
    expect(JSON.parse(b.verdictJson).sourceParity.same).toBe(true);
    expect(Array.isArray(JSON.parse(b.taskRowsJson))).toBe(true);
    expect(JSON.parse(b.fairnessJson)).toBeTypeOf('object');
  });

  it('escapes pipes inside table cells so a detail string cannot break the row', () => {
    const b = renderEvidence(all, META, []);
    expect(b.markdown).toContain('edit detail \\| with pipe');
  });

  it('is deterministic for fixed input regardless of input order', () => {
    const a = renderEvidence(all, META, ['n']);
    const b = renderEvidence([...all].reverse(), META, ['n']);
    expect(b.markdown).toBe(a.markdown);
    expect(b.verdictJson).toBe(a.verdictJson);
  });

  it('flags a tree fingerprint mismatch and an unavailable arm as nonpassing residue', () => {
    const missing: ArmReport = { ...report('codebase-memory', null, true), unavailable: 'no report-codebase-memory.json — arm was not run', treeFingerprint: null, coldIndex: null, cases: [], fixtures: [] };
    const drift = [report('baseline-lsp-rg', 'tree-1', true), report('gitnexus-installed', 'tree-1+dirty', true), report('gitnexus-candidate', 'tree-1', true), missing];
    const b = renderEvidence(drift, META, []);
    expect(b.markdown).toContain('identical tree fingerprint across arms: **NO**');
    expect(b.markdown).toContain('UNAVAILABLE: no report-codebase-memory.json');
    const verdict = JSON.parse(b.verdictJson) as { decision: string; residue: string[] };
    expect(verdict.decision).toBe('inconclusive');
    expect(verdict.residue.join(' ')).toContain('codebase-memory');
  });

  it('marks a failed case NO and carries its error text', () => {
    const b = renderEvidence([report('baseline-lsp-rg', 'f', false)], META, []);
    expect(b.markdown).toMatch(/\| baseline-lsp-rg \| c1 \| callers \| NO \| 0\.00 \|/);
  });
});

// EI-24858052475884275 — re-aggregating the same reports must be byte-stable. runId/createdAt used to
// come from the wall clock, so every re-run on a new day rewrote the markdown header, task-runs.json and
// fairness-audit.json while verdict.json (which does not embed them) stayed identical.
describe('deriveRunMeta', () => {
  afterEach(() => vi.useRealTimers());
  const T1 = '2026-10-01T12:00:00.000Z';
  const T2 = '2026-10-02T15:14:23.000Z';

  it('is a pure function of the reports\' measuredAt: the wall clock never reaches it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const a = deriveRunMeta([T1, T2], 'abc');
    vi.setSystemTime(new Date('2031-06-15T00:00:00.000Z'));
    const b = deriveRunMeta([T1, T2], 'abc');
    expect(b).toEqual(a);
    expect(a.createdAt).toBe(T2);
    expect(a.runId).toBe('engine-comparison-2026-10-02');
    expect(a).toMatchObject({ seed: 0, preregHash: 'abc' });
  });

  it('is independent of arm/read order and moves only when a report is rewritten', () => {
    expect(deriveRunMeta([T2, T1], 'p')).toEqual(deriveRunMeta([T1, T2], 'p'));
    expect(deriveRunMeta([T1, '2026-10-02T15:15:23.000Z'], 'p').createdAt).not.toBe(deriveRunMeta([T1, T2], 'p').createdAt);
  });

  it('falls back to a FIXED epoch (never "now") when no usable report exists', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    for (const none of [[], [undefined, 'not-a-date', '1970-01-01T00:00:00.000Z']]) {
      const m = deriveRunMeta(none, 'p');
      expect(m.createdAt).toBe('1970-01-01T00:00:00.000Z');
      expect(m.runId).toBe('engine-comparison-1970-01-01');
    }
  });

  it('feeds renderEvidence deterministically: same reports + same measuredAt => identical bytes on any day', () => {
    vi.useFakeTimers();
    const reports = [report('baseline-lsp-rg', 'f', true)];
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const first = renderEvidence(reports, deriveRunMeta([T2], 'abc'), []);
    vi.setSystemTime(new Date('2031-06-15T00:00:00.000Z'));
    const second = renderEvidence(reports, deriveRunMeta([T2], 'abc'), []);
    expect(second.markdown).toBe(first.markdown);
    expect(second.taskRowsJson).toBe(first.taskRowsJson);
    expect(second.fairnessJson).toBe(first.fairnessJson);
    expect(second.verdictJson).toBe(first.verdictJson);
  });
});

describe('engine-comparison-cli aggregate() — recurrence guard (EI-24858052475884275)', () => {
  // Reads the CLI SOURCE (it runs at import time, so it cannot be imported by a test). The predicate is
  // proven falsifiable against the exact pre-fix shape inside this same test, so it cannot pass vacuously.
  // Clock reads AND file-mtime reads: an mtime is a filesystem property that a cp / fresh clone / the gate's
  // checkpoint checkout resets, so deriving run identity from it made the bytes depend on checkout time.
  // Use the maintained lexer so comments disappear without corrupting literals.
  const readsClock = (src: string): boolean => /new Date\(|Date\.now\(|\.stat\(|mtime/i.test(stripCommentsOnly(src, 'engine-comparison-cli.ts'));
  const aggregateBody = (src: string): string => {
    const start = src.indexOf('async function aggregate(');
    const end = src.indexOf('\n}\n', start);
    return start === -1 || end === -1 ? '' : src.slice(start, end);
  };

  it('ignores clock descriptions in line and block comments without hiding real reads after a URL literal', () => {
    expect(readsClock('/* Date.now() */\n// fs.stat(file).mtimeMs\nconst x = 1;')).toBe(false);
    expect(readsClock('const url = "https://example.invalid"; Date.now();')).toBe(true);
  });

  it('the detector flags the pre-fix clock-derived meta (negative control)', () => {
    const preFix = "async function aggregate(d: string) {\n  const meta = { runId: `x-${new Date().toISOString().slice(0, 10)}`, createdAt: new Date().toISOString() };\n}\n";
    expect(aggregateBody(preFix)).not.toBe('');
    expect(readsClock(aggregateBody(preFix))).toBe(true);
  });

  it('the detector also flags the first (mtime-derived) fix that a cp/clone defeated (negative control)', () => {
    const mtimeFix = "async function aggregate(d: string) {\n  const ms = (await fs.stat(file)).mtimeMs;\n  const meta = deriveRunMeta([ms], 'p');\n}\n";
    expect(aggregateBody(mtimeFix)).not.toBe('');
    expect(readsClock(aggregateBody(mtimeFix))).toBe(true);
  });

  it('aggregate() derives run identity from deriveRunMeta and never reads the clock or file mtimes', () => {
    const src = readFileSync(fileURLToPath(new URL('./engine-comparison-cli.ts', import.meta.url)), 'utf8');
    const body = aggregateBody(src);
    expect(body.length).toBeGreaterThan(200); // positive control: the slice really captured the function
    expect(body).toContain('deriveRunMeta(');
    expect(readsClock(body)).toBe(false);
  });
});

// The copy/clone failure the mtime-derived first fix had (su-d51b5df2, 2026-10-02): the COMMITTED evidence must
// already contain everything run identity is derived from, so any checkout — a cp, a fresh clone, the gate's
// checkpoint tree — re-aggregates to the same createdAt that the committed markdown and task-runs.json carry.
describe('committed engine-comparison evidence — run identity travels with the content (EI-24858052475884275)', () => {
  const dir = fileURLToPath(new URL('../../../../docs/evidence/gitnexus-engine-comparison-2026-10-01/', import.meta.url));
  const measuredAts = ARM_ORDER.map((id) => (JSON.parse(readFileSync(`${dir}report-${id}.json`, 'utf8')) as { measuredAt?: string }).measuredAt);

  it('every committed arm report carries its own parseable measuredAt', () => {
    expect(measuredAts).toHaveLength(ARM_ORDER.length);
    for (const m of measuredAts) expect(Number.isFinite(Date.parse(m ?? ''))).toBe(true);
  });

  it('the committed markdown header and task-runs.json carry exactly the createdAt/runId deriveRunMeta yields from those reports', () => {
    const meta = deriveRunMeta(measuredAts, 'unused-here');
    const md = readFileSync(`${dir}engine-comparison.md`, 'utf8');
    expect(md).toContain(`# Engine comparison — run ${meta.runId}`);
    expect(md).toContain(`created ${meta.createdAt} `);
    expect(readFileSync(`${dir}task-runs.json`, 'utf8')).toContain(meta.createdAt);
  });
});
