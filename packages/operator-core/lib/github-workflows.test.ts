/**
 * WI-10005302: label rules were copied into .github/workflows/labeler.yml,
 * so GitHub rejected every push before starting a job. Check workflow structure
 * and the trusted-base labeler contract in the real suite. The affected-test
 * registry also selects this file for workflow/config-only changes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { parseDocument, parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: string | string[] | Record<string, { types?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs?: Record<string, {
    'runs-on'?: string | string[];
    uses?: string;
    permissions?: Record<string, string>;
    steps?: Step[];
  }>;
}

describe('GitHub workflow structure', () => {
  it('discovers workflows instead of passing against an empty directory', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)('%s defines triggers and executable jobs', (name) => {
    const document = parseDocument(readFileSync(resolve(WORKFLOW_DIR, name), 'utf8'));
    expect(document.errors).toEqual([]);
    const workflow = document.toJS() as Workflow;
    expect(workflow.on, `${name} is missing workflow triggers`).toBeDefined();
    expect(Object.keys(workflow.on ?? {}).length).toBeGreaterThan(0);
    expect(workflow.jobs, `${name} is missing workflow jobs`).toBeDefined();
    expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(0);
    for (const job of Object.values(workflow.jobs ?? {})) {
      if (job.uses) continue; // A reusable workflow supplies its own runner/steps.
      expect(job['runs-on']).toBeDefined();
      expect(job.steps?.length).toBeGreaterThan(0);
      for (const step of job.steps ?? []) {
        expect(Boolean(step.uses) !== Boolean(step.run)).toBe(true);
      }
    }
  });
});

describe('PR labeler', () => {
  const workflow = parseYaml(readFileSync(resolve(WORKFLOW_DIR, 'labeler.yml'), 'utf8')) as Workflow;
  const rules = parseYaml(readFileSync(resolve(REPO_ROOT, '.github/labeler.yml'), 'utf8')) as
    Record<string, { 'changed-files': { 'any-glob-to-any-file': string[] }[] }[]>;

  it('labels new, updated and reopened PRs without running on staging pushes', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['pull_request_target']);
    const triggers = workflow.on as Record<string, { types?: string[] }>;
    expect(triggers.pull_request_target?.types).toEqual(expect.arrayContaining([
      'opened', 'synchronize', 'reopened',
    ]));
  });

  it('uses only the pinned labeler API action and trusted label configuration', () => {
    expect(workflow.permissions).toEqual({});
    const jobs = Object.values(workflow.jobs ?? {});
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write', // Creates run-visual/run-e2e if they are absent.
    });
    expect(job.steps).toHaveLength(1);
    const step = job.steps![0];
    expect(step.uses).toMatch(/^actions\/labeler@[a-f0-9]{40}$/);
    expect(step.run).toBeUndefined();
    expect(step.with?.['configuration-path']).toBe('.github/labeler.yml');
    // Keep explicitly requested tests even if the latest diff no longer matches.
    expect(step.with?.['sync-labels']).toBe('false');
  });

  it.each([
    ['libs/agent-chat/src/Button.stories.tsx', ['run-visual']],
    ['libs/generic/ui-primitives/src/Button.stories.ts', ['run-visual']],
    ['libs/agent-chat/lostpixel.config.ts', ['run-visual']],
    ['libs/agent-chat/.storybook/main.ts', ['run-visual']],
    ['libs/agent-chat/lostpixel-baseline/button.png', ['run-visual']],
    ['apps/operator/e2e/chat.spec.ts', ['run-e2e']],
    ['apps/operator/playwright.config.ts', ['run-e2e']],
    ['packages/operator-core/lib/harness.ts', []],
    ['README.md', []],
  ] as const)('maps %s to the intended test labels', (file, expected) => {
    const labels = Object.entries(rules).filter(([, matches]) => matches.some((match) =>
      match['changed-files'].some((changed) =>
        changed['any-glob-to-any-file'].some((glob) => minimatch(file, glob, { dot: true })),
      ),
    )).map(([label]) => label).sort();
    expect(labels).toEqual(expected);
  });
});
