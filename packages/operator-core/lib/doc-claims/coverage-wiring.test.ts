/**
 * P-007 (design-to-code-coverage-seam-2026-09-02): the coverage provider config
 * and the nightly workflow must not drift back into documenting each other while
 * nothing connects them. See `./coverage-wiring.ts` for the incident.
 *
 * The FIXTURE controls are load-bearing, for the reason the sibling doc-claims
 * tests state: once the live assertion goes green it stops being evidence that
 * the detector works at all. Each fixture reproduces a shape that MUST be
 * caught — including the exact arrangement that stood in the tree until
 * 2026-09-02, where every individual artifact looked correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeCoverageWiring,
  judgeCoverageCompleteness,
  stripYamlComments,
  DISCLAIMER_SENTINEL,
  TOOLING_EXCLUDES,
} from './coverage-wiring';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUNNER = join(ROOT, 'scripts/affected-tests.mjs');
const CONFIG = join(ROOT, 'libs/test-config/src/vitest-config.ts');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');

const INERT_CONFIG_WITH_DISCLAIMER = `
      // ⚠ ${DISCLAIMER_SENTINEL} \`--coverage\`. This block runs only when a
      // human or agent types the flag.
      coverage: {
        provider: 'v8',
        reportsDirectory: './coverage',
      },
`;

const UPLOAD_STEP = `
      - name: Upload coverage artifacts (if produced)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: '**/coverage/**'
          if-no-files-found: ignore
`;

describe('coverage-wiring doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('recognizes supported custom and built-in coverage providers without accepting an unknown provider', () => {
      for (const provider of ['v8', 'istanbul', 'custom', 'unknown']) {
        const verdict = judgeCoverageWiring({
          runnerSource: "const args = ['--coverage'];",
          workflows: [],
          configSource: `coverage: { provider: '${provider}', customProviderModule: './coverage-provider.ts' },`,
        });
        expect(verdict.providerBlockPresent, provider).toBe(provider !== 'unknown');
      }
    });

    it('preserves quoted globs before real coverage providers and producers', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: "const glob = '**/*';\nconst args = ['--coverage'];",
        workflows: [{ name: 'test.yml', source: UPLOAD_STEP }],
        configSource: "const glob = '**/*';\nconst url = 'https://example.test';\ncoverage: { provider: 'v8' },",
      });
      expect(verdict.providerBlockPresent).toBe(true);
      expect(verdict.producerSites).toEqual(['scripts/affected-tests.mjs:2']);
      expect(verdict.ok).toBe(true);
    });

    it('does not promote provider or producer text inside inline block comments', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: "const glob = '**/*'; /* args.push('--coverage') */",
        workflows: [{ name: 'test.yml', source: UPLOAD_STEP }],
        configSource: "const glob = '**/*'; /* provider: 'v8' */",
      });
      expect(verdict.providerBlockPresent).toBe(false);
      expect(verdict.producerSites).toEqual([]);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toContain('consumer with no producer');
    });

    it('catches the exact pre-2026-09-02 tree: an upload step with no producer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all", "--integration"];',
        workflows: [
          { name: 'test-nightly.yml', source: `      - run: node scripts/affected-tests.mjs --all --integration\n${UPLOAD_STEP}` },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.artifactConsumerSites.length).toBeGreaterThan(0);
      expect(verdict.producerSites).toHaveLength(0);
      expect(verdict.violations.join('\n')).toMatch(/can never fire/);
    });

    it('catches a stale disclaimer once a producer is wired up', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all", "--coverage"];',
        workflows: [],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.producerSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/still says/);
    });

    it('catches an inert provider block that does not admit it is inert', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all"];',
        workflows: [],
        configSource: "coverage: { provider: 'v8' },",
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/does not say it is inert/);
    });

    it('accepts coverage genuinely wired: a producer, a consumer, no disclaimer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'if (has("--coverage")) forward.push("--coverage");',
        workflows: [{ name: 'test-nightly.yml', source: UPLOAD_STEP }],
        configSource: "coverage: { provider: 'v8' },",
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.violations).toEqual([]);
    });

    it('does not mistake a COMMENTED-OUT producer for a real one', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: '// someday: accept --coverage here\nconst KNOWN_FLAGS = ["--all"];',
        workflows: [
          { name: 'test-nightly.yml', source: '      # the --coverage flag is deliberately absent\n' },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.producerSites).toHaveLength(0);
      expect(verdict.ok).toBe(true);
    });

    it('does not mistake an unrelated "…-coverage" lint name for an artifact consumer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all"];',
        workflows: [
          { name: 'test.yml', source: '      - name: Lint tests (four-framework + tab-coverage guard)\n' },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.artifactConsumerSites).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });

  describe('stripYamlComments', () => {
    it('drops full-line comments', () => {
      expect(stripYamlComments('  # path: "**/coverage/**"').join('')).toBe('');
    });

    it('never truncates a quoted glob that could contain a #', () => {
      const line = "          path: '**/coverage/**' # trailing";
      expect(stripYamlComments(line)[0]).toContain('**/coverage/**');
    });
  });

  describe('the live tree', () => {
    it('keeps the coverage config and the workflows in agreement', () => {
      const workflows = readdirSync(WORKFLOW_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((name) => ({ name, source: readFileSync(join(WORKFLOW_DIR, name), 'utf8') }));

      // A zero-length workflow list would make the consumer check vacuous.
      expect(workflows.length).toBeGreaterThan(0);

      const verdict = judgeCoverageWiring({
        runnerSource: readFileSync(RUNNER, 'utf8'),
        workflows,
        configSource: readFileSync(CONFIG, 'utf8'),
      });

      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      // Calibration: the config really does still declare a provider block, so
      // the rules above are being exercised rather than skipped.
      expect(verdict.providerBlockPresent).toBe(true);
    });
  });

  /**
   * WI-2142887 — the report must be able to SEE a file no test imports.
   *
   * Same fixture-control discipline as above, and for a sharper reason: this claim
   * regresses SILENTLY. Dropping `all: true` does not redden anything — the patch
   * gate simply returns `undetermined` for a third of the diff while still printing
   * a healthy number. A guard that only ever runs against the live (correct) config
   * would prove nothing, so each fixture below reproduces a shape that must be caught.
   */
  describe('coverage completeness (WI-2142887)', () => {
    const COMPLETE_CONFIG = `
      coverage: {
        provider: 'v8',
        include: ['**/*.{ts,tsx}'],
        exclude: [${TOOLING_EXCLUDES.map((g) => `'${g}'`).join(', ')}],
      },
    `;

    describe('fixture controls (the detector must be able to FAIL)', () => {
      it('catches a config that dropped `coverage.include` — the silent regression', () => {
        const verdict = judgeCoverageCompleteness(`
          coverage: {
            provider: 'v8',
            exclude: [${TOOLING_EXCLUDES.map((g) => `'${g}'`).join(', ')}],
          },
        `);
        expect(verdict.ok).toBe(false);
        expect(verdict.includePresent).toBe(false);
        expect(verdict.violations.join('\n')).toMatch(/undetermined/);
      });

      it('is not satisfied by a COMMENT that merely mentions the include', () => {
        // The each-end-documents-the-other trap, one level down: the shipped config
        // explains the include at length in prose, and that prose must not stand in
        // for the setting. This is the control that makes comment-stripping load-bearing.
        const verdict = judgeCoverageCompleteness(`
          // WHY: include: ['**/*.{ts,tsx}'] instruments every matching file, so a
          // changed file with no test is reported at 0 hits instead of going unjudged.
          coverage: {
            provider: 'v8',
            exclude: [${TOOLING_EXCLUDES.map((g) => `'${g}'`).join(', ')}],
          },
        `);
        expect(verdict.includePresent).toBe(false);
        expect(verdict.ok).toBe(false);
      });

      it('does not let a glob containing `/*` swallow the exclude list', () => {
        // Regression control. A character-scanning comment stripper reads the `/`+`*`
        // inside '**/bin/**' as a block-comment opener and eats the rest of the file,
        // which reports every exclude as MISSING — a false violation that fails a
        // correct config. That is why this judge strips comments line-wise.
        const verdict = judgeCoverageCompleteness(COMPLETE_CONFIG);
        expect(verdict.missingToolingExcludes).toEqual([]);
      });

      it('catches tooling excludes dropped once the include is set', () => {
        const verdict = judgeCoverageCompleteness(`
          coverage: {
            provider: 'v8',
            include: ['**/*.{ts,tsx}'],
            exclude: ['**/bin/**'],
          },
        `);
        expect(verdict.ok).toBe(false);
        expect(verdict.missingToolingExcludes).toContain('**/scripts/**');
        expect(verdict.missingToolingExcludes).not.toContain('**/bin/**');
      });

      it('passes a complete config — so the rules above are discriminating, not just strict', () => {
        const verdict = judgeCoverageCompleteness(COMPLETE_CONFIG);
        expect(verdict.violations).toEqual([]);
        expect(verdict.ok).toBe(true);
      });
    });

    describe('the live tree', () => {
      it('keeps the shared vitest config able to judge files no test imports', () => {
        const verdict = judgeCoverageCompleteness(readFileSync(CONFIG, 'utf8'));

        expect(verdict.violations).toEqual([]);
        expect(verdict.ok).toBe(true);
        // Calibration: assert the settings positively, so a future refactor that makes
        // the judge vacuous (e.g. always-empty violations) fails here too.
        expect(verdict.includePresent).toBe(true);
        expect(verdict.missingToolingExcludes).toEqual([]);
      });

      it('never re-adds `coverage.all`, which Vitest 4 removed', () => {
        // The first draft of WI-2142887 set `all: true` beside the include. It
        // type-errors (TS2769) and does nothing at runtime — the 263-file result was
        // identical with and without it. Left in, it reads to the next author as the
        // setting that carries the behaviour, so pin its absence rather than trusting
        // the comment that explains it.
        const configSource = readFileSync(CONFIG, 'utf8');
        const settingLines = configSource
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('//'));
        expect(settingLines.some((line) => /(?:^|[{,\s])all:\s*true\b/.test(line))).toBe(false);
      });
    });
  });
});
