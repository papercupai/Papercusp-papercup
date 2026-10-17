import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findTrackedScratchPaths,
  isTrackedScratchPath,
  listTrackedIgnored,
  listTrackedScratchPaths,
} from './check-tracked-ignored.mjs';

test('detects a tracked unignored scratch path that the Git ignore scan misses', () => {
  const repo = mkdtempSync(join(tmpdir(), 'check-tracked-ignored-'));
  const scratchFile = '.tmp-papercusp-unignored-regression/output.txt';

  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: repo });
    mkdirSync(join(repo, '.tmp-papercusp-unignored-regression'), { recursive: true });
    writeFileSync(join(repo, scratchFile), 'temporary output\n');
    execFileSync('git', ['add', '--', scratchFile], { cwd: repo });

    assert.equal(
      execFileSync('git', ['ls-files', '--error-unmatch', '--', scratchFile], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      scratchFile,
    );
    assert.equal(listTrackedIgnored(repo).listed, 0);
    assert.deepEqual(listTrackedScratchPaths(repo), [scratchFile]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('detects host build output tracked before its ignore rule and clears after index-only removal', () => {
  const repo = mkdtempSync(join(tmpdir(), 'check-tracked-ignored-'));
  const output = 'apps/operator/dist-host-customer-terminal/index.js';
  const contents = 'generated host bundle\n';

  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: repo });
    mkdirSync(join(repo, 'apps/operator/dist-host-customer-terminal'), { recursive: true });
    writeFileSync(join(repo, output), contents);
    execFileSync('git', ['add', '--', output], { cwd: repo });
    assert.equal(listTrackedIgnored(repo).listed, 0);

    writeFileSync(join(repo, '.gitignore'), 'apps/operator/dist-host-*/\n');
    const result = listTrackedIgnored(repo);
    assert.equal(result.listed, 1);
    assert.deepEqual(result.offenders.map(({ path, source, pattern }) => ({ path, source, pattern })), [
      { path: output, source: '.gitignore', pattern: 'apps/operator/dist-host-*/' },
    ]);
    assert.deepEqual(result.machineLocal, []);

    execFileSync('git', ['rm', '--cached', '--', output], { cwd: repo });
    assert.equal(readFileSync(join(repo, output), 'utf8'), contents);
    assert.equal(listTrackedIgnored(repo).listed, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('detects tracked top-level scratch roots even without a matching ignore rule', () => {
  const tracked = [
    '.agent-tmp/node-compile-cache/v25/file',
    '.tmp/output.json',
    '.tmp-content-fixer/cache/file',
    '.tmp-vitest-wi1347/cache/file',
    '.tsx-tmp/output.js',
    'scratch/lockdom-run/file',
    'scratchpad/session/file',
    'scratch-preview/run/file',
  ];

  assert.deepEqual(findTrackedScratchPaths(tracked), [...tracked].sort());
});

test('detects generated Papercusp temp files and caches', () => {
  assert.equal(isTrackedScratchPath('.papercusp/node-compile-cache/v25/cache-entry'), true);
  assert.equal(isTrackedScratchPath('.papercusp/tsx-1000/output.js'), true);
  assert.equal(isTrackedScratchPath('.papercusp/tmp-registry-probe.ts'), true);
  assert.equal(isTrackedScratchPath('apps/operator/.papercusp/tsx-1000/output.js'), true);
});

test('detects generated operator host output even when a relative outfile nests the app path', () => {
  const outputs = [
    'apps/operator/dist-host/hono-host.mjs',
    'apps/operator/dist-host-native-fixture-debug-2001983/hono-host.mjs',
    'apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/hono-host.mjs',
    'apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/sql/schema.sql',
  ];

  assert.deepEqual(findTrackedScratchPaths(outputs), [...outputs].sort());
  assert.equal(isTrackedScratchPath('packages/operator-core/lib/dist-host-fixture.ts'), false);
  assert.equal(isTrackedScratchPath('apps/operator/lib/dist-host-fixture.ts'), false);
});

test('the maintained ignore rule covers nested operator host output', () => {
  const repo = mkdtempSync(join(tmpdir(), 'check-tracked-ignored-'));
  const output = 'apps/operator/apps/operator/dist-host-native-fixture-debug-2047298/hono-host.mjs';
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
    assert.equal(execFileSync('git', ['check-ignore', '--no-index', '--', output],
      { cwd: repo, encoding: 'utf8' }).trim(), output);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('does not flag nested product scratch paths or durable Papercusp state', () => {
  const tracked = [
    'packages/operator-core/src/scratch/parser.ts',
    'packages/operator-core/.tmp-fixture.test.ts',
    '.papercusp/reports/durable-parks/evidence.json',
    '.papercusp/state/escalations/provider-failure.md',
  ];

  assert.deepEqual(findTrackedScratchPaths(tracked), []);
});
