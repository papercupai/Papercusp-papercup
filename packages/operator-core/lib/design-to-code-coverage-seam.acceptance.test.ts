/**
 * Executable acceptance checks for the objective halves of the
 * design-to-code-coverage-seam plan's record-integrity criteria.
 *
 * The accompanying rubric still asks a grader to judge whether Decisions carry
 * meaningful measurements. These checks own only the mechanical facts that can
 * and should fail without relying on that judgment: the refuted wiring is absent,
 * the searched corpora are real, and the three not-code classifications did not
 * pass over an implementation-shaped artifact.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presentOnDisk } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function trackedSourceFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    // The tracked workspace is intentionally larger than Node's 1 MiB default
    // child-process buffer. Truncating it would turn every absence assertion
    // below into false confidence, so fail only above a deliberate 16 MiB cap.
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.error, `git ls-files failed to spawn: ${result.error?.message}`).toBeUndefined();
  expect(result.status, `git ls-files failed: ${result.stderr ?? ''}`).toBe(0);
  const files = (result.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .filter((file) => /\.(?:ts|mjs|json)$/.test(file))
    .filter((file) => !file.includes('/node_modules/') && !file.includes('/docs/'));
  // The index keeps listing an rm'd path until git-sync commits the deletion;
  // reading it would throw ENOENT on the shared tree (WI-10004173).
  return presentOnDisk(files, REPO_ROOT);
}

function readTracked(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('design-to-code coverage seam: measured course correction', () => {
  it('keeps the refuted patch-coverage call absent while the two-snapshot detector remains', () => {
    const source = readTracked('packages/operator-core/lib/qodo-cover-loop.ts');
    const executable = withoutComments(source);

    // Positive controls: the searched module and rejected subject both still
    // exist. Without these, deleting or renaming the whole mechanism could make
    // the negative assertion pass vacuously.
    expect(source).toContain('judgePatchCoverage');
    expect(executable).toContain('export function computeCoverageDelta');
    expect(executable).not.toMatch(/import[^;]*judgePatchCoverage|judgePatchCoverage\s*\(/);
  });
});

describe('design-to-code coverage seam: not-code accounting searches', () => {
  it('replays the three source-corpus falsifiers with positive controls', () => {
    const files = trackedSourceFiles();
    expect(files).toContain('packages/operator-core/lib/qodo-cover-loop.ts');
    expect(files.length).toBeGreaterThan(100);

    // Implementation absence is a claim about production/config source, not
    // about the acceptance test that names the thing it is looking for. This
    // filter is intentionally applied BEFORE the search so the check behaves
    // identically while untracked and after its own file enters git ls-files.
    const implementationFiles = files
      .filter((file) => /^(?:packages|libs|scripts|apps)\//.test(file))
      .filter((file) => !/\.(?:test|spec)\.[^.]+$/.test(file));
    expect(implementationFiles).toContain('packages/operator-core/package.json');
    expect(implementationFiles).toContain('packages/operator-core/lib/qodo-cover-loop.ts');

    const monocartHits = implementationFiles.filter((file) => readTracked(file).includes('monocart'));
    expect(
      monocartHits,
      'P-012 was an evaluation-to-defer; an implementation hit makes its not-code verdict false',
    ).toEqual([]);

    const registrations = readTracked('packages/operator-core/lib/cell-registrations.ts');
    const coverageFloor = registrations.indexOf("cell: 'testing.coverage.floor'");
    expect(coverageFloor, 'the P-008 measurement must refer to a real pre-existing instrument').toBeGreaterThan(-1);
    expect(registrations.slice(coverageFloor, coverageFloor + 200)).toContain("registeredOn: '2026-08-18'");

    // P-004's named corpus is production TypeScript under the four source
    // roots—not the wider JSON corpus P-012 searches. Keeping those scopes
    // separate prevents generated report fixtures from masquerading as an
    // implementation of a completion-authority distribution.
    const authorityCorpus = implementationFiles
      .filter((file) => /\.(?:ts|mjs)$/.test(file) && !file.includes('.test.'))
      .filter((file) => /completionAuthority|completion_authority/.test(readTracked(file)));
    expect(authorityCorpus).toContain('packages/operator-core/lib/work-item-completion-authority.ts');
    // The falsifier is an AUTHORITY distribution, so "distribution" must sit next
    // to "authority" (either order). A bare /distribution/ also matched unrelated
    // vocabulary in the same files, e.g. the scorecard rating key
    // 'canonicalRatings.degenerate-distribution.rating' in result-door.ts.
    const authorityDistribution =
      /authorit\w*[\s_.:-]*distribution|distribution[\s_.:-]*(?:(?:of|by|per|across)[\s_.:-]*)?(?:completion[\s_.:-]*)?authorit/i;
    for (const positive of [
      'const completionAuthorityDistribution = new Map();',
      'export function authority_distribution(rows) {',
      'return { distributionByAuthority };',
      "label: 'distribution of completion authority',",
    ]) {
      expect(authorityDistribution.test(positive), `positive control: ${positive}`).toBe(true);
    }
    expect(authorityDistribution.test("'canonicalRatings.degenerate-distribution.rating',")).toBe(false);
    const distributionHits = authorityCorpus.flatMap((file) =>
      withoutComments(readTracked(file))
        .split('\n')
        .filter((line) => authorityDistribution.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(
      distributionHits,
      'P-004 was publish/announce work; an authority-distribution implementation makes not-code false',
    ).toEqual([]);
  });
});
