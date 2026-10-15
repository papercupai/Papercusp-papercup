/**
 * The generic SU scope guidance says to add `harness` to most project-facing
 * calls. Keep the explicit exception in every Papercusp SU source that can
 * reach an operator session, so live schemas are not obscured by that rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELEASE_SOURCES = [
  'papercusp-su-engineer.tools.md',
  'pot-instances/papercup-pot.su.md',
];
const RUBRIC_SOURCES = [
  ...RELEASE_SOURCES,
  'papercusp-su-power.tools.md',
];

describe('SU harness reader scope guidance', () => {
  for (const source of RELEASE_SOURCES) {
    it(`${source} keeps harness:get/status on their slug arguments`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');
      const genericTools = prompt.match(/harness-scoped tools \(([^)]*)\)/s)?.[1] ?? '';

      expect(genericTools).not.toContain('harness:get');
      expect(genericTools).not.toContain('harness:status');
      expect(prompt).toMatch(
        /Important exception:\s+`harness:get` takes its own `slug` and `harness:status` takes `slug`\/`slugs`;\s+do\s+\*\*not\*\* add a top-level `harness` field/,
      );
      expect(prompt).toMatch(
        /Both accept an optional `workspace` argument for unscoped superuser calls that need a workspace transaction/,
      );
    });
  }
});

describe('SU workspace-global scope guidance', () => {
  for (const source of RELEASE_SOURCES) {
    it(`${source} identifies release:checkpoint-run as workspace-global`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');

      expect(prompt).toMatch(
        /`release:checkpoint-run` is workspace-global, not\s+harness-scoped\./,
      );
      expect(prompt).toMatch(
        /live schema accepts only `force`, `replaceStale`, `paths`,\s+`waitForEligibility`, and `reason`/,
      );
      expect(prompt).toContain('do **not** pass `harness` to it');
    });

    it(`${source} identifies release:trace as workspace-global`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');

      expect(prompt).toMatch(
        /`release:trace` is also workspace-global, not\s+harness-scoped\./,
      );
      expect(prompt).toMatch(
        /`release:trace` is also workspace-global[\s\S]*?live schema\s+accepts only `path`, `sha`, `work_item`, and `after_generation`/,
      );
      expect(prompt).toContain('`harness` in its JSON arguments');
    });
  }

  for (const source of RUBRIC_SOURCES) {
    it(`${source} identifies rubrics:list as workspace-global`, () => {
      const prompt = readFileSync(join(PROMPTS, source), 'utf8');

      expect(prompt).toMatch(
        /`rubrics:list` is also workspace-global, not\s+harness-scoped\./,
      );
      expect(prompt).toMatch(
        /Its live schema\s+accepts only `status`, `characteristic`, `kind`, and `limit`/,
      );
      expect(prompt).toMatch(/do \*\*not\*\* pass\s+`harness`\s+to it/);
    });
  }
});

describe('SU two-port staging checkout guidance', () => {
  it('keeps the canonical guide and engineer playbook honest about :3170', () => {
    const sources = [
      readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8'),
      readFileSync(join(PROMPTS, 'papercusp-su-engineer.tools.md'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('separate `papercusp-staging` checkout');
      expect(source).toContain('pinned to `origin/staging`');
      expect(source).toMatch(/uncommitted\s+edit/);
      expect(source).toContain('dev:restart');
      expect(source).not.toContain(':3170 serves the working tree at current HEAD');
      expect(source).not.toContain('systemctl --user restart\npapercup-staging-api.service');
    }
  });
});
