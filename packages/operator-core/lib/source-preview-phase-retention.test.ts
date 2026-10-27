import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureVerifierDependencies, readVerifierPhaseMeasurements, verifierPhaseRunner } from '../../../scripts/source-preview.mjs';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('verifier phase evidence retention', () => {
  it('keeps exact completed and failed phase bytes after temporary receipt deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const run = verifierPhaseRunner(path, { PAPERCUSP_HOME: join(root, 'persistent'),
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'retention-fixture' }, join(root, 'child.json'));
    await run('source.freeze', () => 1);
    const failure = new Error('fixture failed');
    await expect(run('child.run', () => { throw failure; })).rejects.toBe(failure);
    const original = readFileSync(path);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(run.archivePath.startsWith(join(root, 'persistent', 'checkpoint-logs') + '/')).toBe(true);
    expect(readFileSync(run.archivePath)).toEqual(original);
    expect(statSync(run.archivePath).mode & 0o777).toBe(0o600);
    rmSync(path);
    expect(existsSync(path)).toBe(false);
    expect(hash(readFileSync(run.archivePath))).toBe(hash(original));
    const rows = original.toString().trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4]);
    expect(rows.every(row => row.taskId === 'retention-fixture')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ phase: 'child.run', event: 'failed', error: 'fixture failed' });
    expect(readVerifierPhaseMeasurements(run.archivePath)).toEqual({ 'source.freeze': rows[1].durationMs });
    expect(() => readVerifierPhaseMeasurements(path)).toThrow('ENOENT');
  });

  it('honors the existing log directory override and refuses to overwrite a retained run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const env = { PAPERCUSP_CHECKPOINT_LOG_DIR: join(root, 'logs') };
    const run = verifierPhaseRunner(path, env, join(root, 'child.json'));
    await run('cleanup', () => undefined);
    const retained = readFileSync(run.archivePath);
    rmSync(path);
    expect(() => verifierPhaseRunner(path, env, join(root, 'child.json'))).toThrow('EEXIST');
    expect(readFileSync(run.archivePath)).toEqual(retained);
    expect(run.archivePath.startsWith(env.PAPERCUSP_CHECKPOINT_LOG_DIR + '/')).toBe(true);
  });

  it('retains bounded per-tree progress while preserving the complete dependency census', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-progress-'));
    fixtures.push(root);
    const trees = ['apps/operator/node_modules', 'node_modules'];
    for (const tree of trees) {
      const packageDir = join(root, tree, 'pkg');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'index.js'), 'module.exports = true;\n');
    }
    const write = (path: string, content: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    write(join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), [
      '#!/usr/bin/env bash',
      'test "$1" = trees || exit 2',
      "printf '%s\\n' node_modules apps/operator/node_modules",
      '',
    ].join('\n'));
    write(join(root, 'apps/operator/bin/release/dependency-generation.sh'), [
      'dependency_generation_source_records() {',
      "  printf 'pkg\\td\\t0755\\t1\\t1\\t0\\t0\\t0\\t0\\t\\npkg/index.js\\tf\\t0644\\t1\\t1\\t0\\t0\\t0\\t0\\t\\n' > \"$2\"",
      '}',
      '',
    ].join('\n'));

    const path = join(root, 'temporary.phases.jsonl');
    const run = verifierPhaseRunner(path, { PAPERCUSP_HOME: join(root, 'persistent') }, join(root, 'child.json'));
    const dependencies = await run('deps.postverify', () => captureVerifierDependencies({
      dest: root,
      receipt: { sourceCommit: 'fixture' },
      env: {},
      onProgress: progress => run.reportProgress?.('deps.postverify', progress),
    }));
    expect(dependencies.trees.map(tree => tree.path)).toEqual(trees);
    expect(dependencies.trees.map(tree => tree.files.map(file => file.path))).toEqual([
      ['pkg/index.js'], ['pkg/index.js'],
    ]);

    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const progress = rows.filter(row => row.event === 'progress');
    expect(progress.map(row => row.progress)).toEqual([
      { completedTrees: 0, totalTrees: 2, currentTree: trees[0] },
      { completedTrees: 1, totalTrees: 2, currentTree: trees[1] },
    ]);
    expect(rows.at(-1).event).toBe('completed');
    expect(readVerifierPhaseMeasurements(path)['deps.postverify']).toBe(rows.at(-1).durationMs);
  });
});
