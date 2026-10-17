import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARTIAL_TASK_CHECKPOINT_SCHEMA,
  PARTIAL_TASK_SKIP_LIST_SCHEMA,
  normalizePartialFiles,
  partialTaskCheckpointPath,
  partialTaskSkipListPath,
  readPartialTaskCheckpoint,
  writePartialTaskCheckpointAtomic,
} from '../../../../scripts/lib/partial-task-resume.mjs';

const ID = {
  root: '/repo',
  taskKey: '@papercusp/operator-core :: test:integration',
  sourceCommit: 'a'.repeat(40),
  sourceDigest: 'b'.repeat(64),
};

describe('partial-task-resume', () => {
  it('normalizes workspace paths and rejects paths outside the workspace', () => {
    expect(normalizePartialFiles(['./lib/a.test.ts', '/repo/lib/b.test.ts', '../escape.test.ts'], '/repo'))
      .toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
  });

  it('round-trips a checkpoint and bounds passed files to its selected manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, {
      ...ID,
      selectedFiles: ['lib/b.test.ts', 'lib/a.test.ts'],
      passedFiles: ['lib/a.test.ts', 'lib/foreign.test.ts'],
      state: 'partial',
    });
    expect(readPartialTaskCheckpoint(file, ID)).toMatchObject({
      schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
      selectedFiles: ['lib/a.test.ts', 'lib/b.test.ts'],
      passedFiles: ['lib/a.test.ts'],
      state: 'partial',
    });
  });

  it('refuses a checkpoint whose source identity moved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, { ...ID, selectedFiles: ['a.test.ts'], passedFiles: ['a.test.ts'], state: 'partial' });
    expect(readPartialTaskCheckpoint(file, { ...ID, sourceDigest: 'c'.repeat(64) })).toBeNull();
  });

  it('writes a distinct skip-list channel that cannot be mistaken for a pass proof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const skip = partialTaskSkipListPath(dir, { ...ID, passedFiles: ['lib/a.test.ts'] });
    const parsed = JSON.parse(readFileSync(skip.path, 'utf8'));
    expect(parsed).toEqual({
      schema: PARTIAL_TASK_SKIP_LIST_SCHEMA,
      taskKey: ID.taskKey,
      sourceCommit: ID.sourceCommit,
      sourceDigest: ID.sourceDigest,
      files: ['lib/a.test.ts'],
    });
    expect(parsed).not.toHaveProperty('runContext');
    expect(parsed).not.toHaveProperty('runnerIdentity');
  });
});
