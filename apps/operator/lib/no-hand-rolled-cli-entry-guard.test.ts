import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS lint guard, imported for its scanner predicates.
import { findGuards, scanTree } from '../../../scripts/check-no-hand-rolled-cli-entry.mjs';

describe('lint:no-hand-rolled-cli-entry — predicate controls', () => {
  it('finds the pathToFileURL spelling, including nested argv aliases', () => {
    const source = `
      const argv1 = process.argv[1];
      if (import.meta.url === pathToFileURL(realpathSync(argv1)).href) main();
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual(['path-to-file-url']);
  });

  it('finds the template-literal and fileURLToPath spellings', () => {
    const source = `
      const a = import.meta.url === \`file://\${process.argv[1]}\`;
      const b = fileURLToPath(import.meta.url) === process.argv[1];
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual([
      'file-template',
      'file-url-to-path',
    ]);
  });

  it('finds fileURLToPath comparisons hidden behind resolve wrappers', () => {
    const source = `
      const invokedDirectly = process.argv[1] &&
        resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual(['file-url-to-path']);
  });

  it('ignores comments, strings, and regex bodies that quote the banned idiom', () => {
    const source = `
      // import.meta.url === pathToFileURL(process.argv[1]).href
      const prose = 'import.meta.url === pathToFileURL(process.argv[1]).href';
      const quoted = /import\\.meta\\.url === pathToFileURL\\(process\\.argv\\[1\\]\\)/;
    `;
    expect(findGuards(source)).toEqual([]);
  });

  it('does not flag the sanctioned helper call', () => {
    expect(findGuards("if (isCliEntry(import.meta.url)) main();")).toEqual([]);
  });
});

describe('lint:no-hand-rolled-cli-entry — build-output pruning', () => {
  it('excludes dist-* and storybook-static trees while scanning real source', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-cli-entry-scan-'));
    const guard = 'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();';
    const paths = [
      'apps/operator/src/live.mjs',
      'apps/operator/dist-devhost/server.mjs',
      'apps/operator/dist-hosted-control-plane/serve.mjs',
      'apps/operator/storybook-static/assets/story.mjs',
      'libs/generic/papergrid/grid-core/storybook-static/assets/story.mjs',
    ];
    try {
      for (const rel of paths) {
        const file = join(root, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, guard, 'utf8');
      }

      const result = scanTree({ root, sourceRoots: ['apps', 'libs'] });
      expect(result.everyGuard.map((hit: { rel: string }) => hit.rel)).toEqual([
        'apps/operator/src/live.mjs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('lint:no-hand-rolled-cli-entry — repository ratchet', () => {
  let repositoryScan: ReturnType<typeof scanTree>;

  beforeAll(() => {
    repositoryScan = scanTree();
  }, 60_000);

  it('has no unallowlisted guard and no stale baseline entry', () => {
    const result = repositoryScan;
    expect(result.violations.map((hit: { rel: string; line: number; kind: string }) => `${hit.rel}:${hit.line}:${hit.kind}`)).toEqual([]);
    expect(result.exemptions.map((hit: { rel: string; kind: string }) => [hit.rel, hit.kind]).sort()).toEqual([
      ['apps/operator/bin/release/dependency-generation-verifier.mjs', 'file-url-to-path'],
      ['apps/operator/scripts/hooks/cc/posttooluse-launch-prose-budget-nudge.mjs', 'file-url-to-path'],
      ['scripts/lib/verify-tauri-deadline.mjs', 'file-url-to-path'],
      ['scripts/reviewer-operator-assert.mjs', 'file-url-to-path'],
    ]);
    expect(result.exemptions.every((hit: { reason?: string }) => Boolean(hit.reason?.trim()))).toBe(true);
    expect(result.stale).toEqual([]);
    expect(result.staleExemptions).toEqual([]);
  });

  it('has no standalone exception for the dependency-free systemd runner', () => {
    const result = repositoryScan;
    expect(result.exemptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel: 'packages/operator-core/lib/systemd-scope-env-runner.mjs' }),
      ]),
    );
  });
});
