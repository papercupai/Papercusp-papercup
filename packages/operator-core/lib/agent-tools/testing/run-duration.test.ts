import { expect, it } from 'vitest';
import {
  mapHarnessTestRunDurationsByFile,
  mapHarnessTestRunIdsByFile,
  readHarnessTestRunIdsBounded,
  testingRunDurationFields,
} from './run';
import type { HarnessTestRunEvidence } from '../../testing-run-store';

const scope = {
  workspaceId: 'workspace-a',
  harnessSlug: 'harness-a',
  runGroupId: 'run-a',
  root: '/repo',
};

function row(overrides: Partial<HarnessTestRunEvidence> = {}): HarnessTestRunEvidence {
  return {
    id: 22164792,
    file_path: 'packages/sample.test.ts',
    status: 'pass',
    duration_ms: '1885',
    finished_at: '2026-10-26T09:37:09.059Z',
    workspace_id: scope.workspaceId,
    harness_slug: scope.harnessSlug,
    run_group_id: scope.runGroupId,
    commit_sha: 'abcdef1234567890',
    worktree_dirty: false,
    ...overrides,
  };
}

it('reports handler wall time separately from the runner-reported duration', () => {
  expect(testingRunDurationFields(109, 1885)).toEqual({
    durationMs: 1885,
    runnerDurationMs: 109,
  });
});

it('maps persisted per-file durations only from one exact scoped ledger row', () => {
  const byFile = {
    'packages/sample.test.ts': { passed: 30, failed: 0, skipped: 0, collectionFailed: false },
  };
  const rows = [
    row(),
    row({ id: 7, run_group_id: 'another-run', duration_ms: 9000 }),
    row({ id: 8, workspace_id: 'another-workspace', duration_ms: 9000 }),
  ];

  expect(mapHarnessTestRunIdsByFile(byFile, rows, scope)).toEqual({
    'packages/sample.test.ts': 22164792,
  });
  expect(mapHarnessTestRunDurationsByFile(byFile, rows, scope)).toEqual({
    'packages/sample.test.ts': 1885,
  });
  expect(mapHarnessTestRunDurationsByFile(byFile, [row({ duration_ms: null })], scope)).toEqual({
    'packages/sample.test.ts': null,
  });
});

it('returns ledger durations with IDs and omits ambiguous file matches', async () => {
  const byFile = {
    'packages/sample.test.ts': { passed: 30, failed: 0, skipped: 0, collectionFailed: false },
  };
  const rows = [row(), row({ id: 22164793, duration_ms: 1900 })];
  const readback = await readHarnessTestRunIdsBounded(
    { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: scope.runGroupId },
    { findEvidence: async () => rows, timeoutMs: 100, root: scope.root, byFile },
  );

  expect(readback).toMatchObject({
    ids: [22164792, 22164793],
    idsByFile: {},
    ledgerDurationsByFile: {},
    degraded: false,
  });
});
