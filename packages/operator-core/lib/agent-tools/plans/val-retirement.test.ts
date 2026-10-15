import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VAL_BLOCK_HEADER_LINE_RE,
  VAL_RETIREMENT_DOC,
  VAL_RETIREMENT_REFUSAL_CODES,
  findValBlocks,
  valRetirementRefusal,
  type ValRetirementRefusalCode,
} from './val-retirement';
import { VAL_BLOCK_HEADER_PG_PATTERN } from '../../verification-health';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const PLAN = [
  '# Plan',
  'Prose that mentions [VAL-x-001] is not a block.',
  '- **P-001** `todo` First item.',
  '  - **[VAL-plan-001]**',
  '    - **Verify:** it works',
  '- **P-002** `todo` Second item.',
  '  - [VAL-plan-002] scoper-written form',
  '- **P-003** `todo` Third item, malformed block.',
  '    - **[VAL-',
  '- **P-004** `todo` No block.',
].join('\n');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('VAL_RETIREMENT_DOC names a doc marked retired (SPEC-P-003-DOC)', () => {
  it('the projected spec doc is superseded and leads with the retirement notice', () => {
    const rel = VAL_RETIREMENT_DOC.replace(/^\/internal\/docs\//, '');
    const file = resolve(ROOT, 'apps/operator-docs/src/content/docs', `${rel}.mdx`);
    const text = readFileSync(file, 'utf8');
    const fmEnd = text.indexOf('\n---\n', 4);
    expect(fmEnd).toBeGreaterThan(0);
    const frontmatter = text.slice(0, fmEnd);
    expect(frontmatter).toMatch(/^status: superseded$/m);
    expect(frontmatter).toMatch(/^title: .*\bretired\b/im);
    // The notice must precede the first section of the old format, so no reader takes
    // the historical VAL-* syntax as the current mechanism.
    const notice = text.indexOf('Retired: superseded by the requirement contract');
    const firstSection = text.indexOf('\n## ');
    expect(notice).toBeGreaterThan(fmEnd);
    expect(notice).toBeLessThan(firstSection);
  });
});

describe('retired VAL verification surfaces stay removed (SPEC-P-003-DETECTOR-SUCCESSOR)', () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

  it('names spec-test-adequacy, and the named gate is live in work_items:complete', () => {
    const map = read('apps/operator-docs/src/content/docs/agent-insights/verification-system-map.mdx');
    expect(map).toContain('SUCCESSOR SIGNAL: spec-test-adequacy');
    expect(map).toContain('specTestAdequacyCompletionGate');
    // Control: the pointer must name a successor that exists and runs at the close, or it
    // would point at nothing.
    expect(read('packages/operator-core/lib/agent-tools/work_items/spec-test-adequacy-gate.ts')).toMatch(
      /export async function specTestAdequacyCompletionGate\(/,
    );
    expect(read('packages/operator-core/lib/agent-tools/work_items/complete.ts')).toMatch(
      /await specTestAdequacyCompletionGate\(/,
    );
  });

  it.each([
    'harness-test-gate.ts',
    'harness-test-gate-provenance.test.ts',
    'harness-test-rollup.ts',
    'harness-test-rollup.test.ts',
    '__tests__/harness-test-rollup.test.ts',
    'harness/improvements/done-without-test-detect.ts',
    'harness/improvements/done-without-test-detect.test.ts',
    'harness/improvements/done-without-test-collect.integration.test.ts',
  ])('keeps the retired module or suite %s absent', (path) => {
    expect(existsSync(resolve(ROOT, 'packages/operator-core/lib', path))).toBe(false);
  });

  it('keeps the old completion gate and collector unregistered', () => {
    const completePath = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';
    const complete = stripCommentsOnly(read(completePath), completePath);
    expect(complete).toContain('specTestAdequacyCompletionGate');
    expect(complete).not.toContain('itemTestGate');
    expect(complete).not.toContain('harness-test-gate');
    const watchdogPath = 'packages/operator-core/lib/harness/improvements/watchdog.ts';
    const watchdog = stripCommentsOnly(read(watchdogPath), watchdogPath);
    expect(watchdog).toContain("name: 'papercusp-zero-promotion'");
    expect(watchdog).not.toContain("'papercusp-done-without-test'");
    expect(watchdog).not.toContain('collectDoneWithoutTestSignals');
  });

  it('rejects legacy-gate references in live source while allowing historical comments', () => {
    const pattern = '\\bitemTestGate\\b|harness-test-gate|harness-test-rollup|done-without-test-detect';
    const candidates = execFileSync('git', [
      'grep', '-l', '-I', '-E', pattern, '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs',
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n').filter(Boolean)
      .filter((path) => !/(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(\/__fixtures__\/)/.test(path));
    expect(candidates).toContain('packages/operator-core/lib/plan-item-provenance.ts');
    const retired = new RegExp(pattern);
    expect(candidates.filter((path) => retired.test(stripCommentsOnly(read(path), path)))).toEqual([]);
    expect(retired.test(stripCommentsOnly("import { itemTestGate } from './harness-test-gate';", 'x.ts'))).toBe(true);
    expect(retired.test(stripCommentsOnly('// harness-test-gate used itemTestGate\nexport {};', 'x.ts'))).toBe(false);
  });
});

describe('VAL-* retirement refusal codes', () => {
  it('exports exactly the three typed refusal codes', () => {
    const codes: readonly ValRetirementRefusalCode[] = VAL_RETIREMENT_REFUSAL_CODES;
    expect([...codes].sort()).toEqual(['val-block-retired', 'val-read-retired', 'val-write-retired']);
  });

  it.each(VAL_RETIREMENT_REFUSAL_CODES)('builds a typed refusal for %s', (code) => {
    const r = valRetirementRefusal(code, 'detail here');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(r.successor).toBe('requirement-contract');
    expect(r.message).toContain(code);
    expect(r.message).toContain('detail here');
    expect(r.repair.length).toBeGreaterThan(0);
    expect(r.httpStatus).toBe(code === 'val-block-retired' ? 409 : 410);
    // The P-003 census forbids naming the legacy store anywhere in non-test source;
    // the refusal text must not reintroduce it.
    expect(r.message).not.toMatch(/harness_plan_assert/);
  });
});

describe('findValBlocks', () => {
  it('finds header-shaped blocks, including malformed ones, and ignores prose mentions', () => {
    const blocks = findValBlocks(PLAN);
    expect(blocks.map((b) => [b.planItemId, b.valId])).toEqual([
      ['P-001', 'VAL-plan-001'],
      ['P-002', 'VAL-plan-002'],
      ['P-003', 'VAL-'],
    ]);
    expect(blocks[0].line).toBe(4);
  });

  it('scopes to the requested items', () => {
    expect(findValBlocks(PLAN, new Set(['P-002', 'P-004'])).map((b) => b.planItemId)).toEqual([
      'P-002',
    ]);
    expect(findValBlocks(PLAN, new Set(['P-004']))).toEqual([]);
  });

  it('agrees with the health-cell census pattern on every fixture line', () => {
    // The live census (verification-health) and the promotion gate must call the
    // same lines blocks, or the cell could read 0 while promotion still refuses.
    const pg = new RegExp(VAL_BLOCK_HEADER_PG_PATTERN);
    for (const line of PLAN.split('\n')) {
      expect(VAL_BLOCK_HEADER_LINE_RE.test(line)).toBe(pg.test(line));
    }
    expect(pg.test(PLAN)).toBe(true);
    expect(pg.test('Prose that mentions [VAL-x-001] only.')).toBe(false);
  });
});
