import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { frozenRepairMarkerPath, projectFrozenRepairMarker, readFrozenRepairMarker } from './frozen-repair-edit-marker';

// P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3): the marker
// is the completion guard's ONLY evidence source, projected by the one queue write path, so
// its projection of the admission ledger + manifest legs is pinned here.

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'frozen-repair-marker-'));
  dirs.push(d);
  return join(d, 'marker.json');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const queue = {
  schemaVersion: 3,
  phase: 'repair-in-progress',
  candidate: 'c'.repeat(40),
  base: 'b'.repeat(40),
  repairHead: 'r'.repeat(40),
  worktreePath: '/tmp/repair',
  attempts: 1,
  openedAtMs: 1,
  updatedAtMs: 2,
  fixerSpawnId: 'fixer-1',
  failingTests: ['./a/failing.test.ts', 'b/failing.test.ts'],
  signature: [],
  admissions: [
    {
      atMs: 3,
      actor: 'su-1',
      source: { ref: 'staging', sha: 's'.repeat(40) },
      fromRepairHead: 'r'.repeat(40),
      toRepairHead: 't'.repeat(40),
      paths: ['a/failing.test.ts'],
      unchanged: ['lib/helper.ts'],
      blobs: { 'a/failing.test.ts': 'x'.repeat(40), 'lib/helper.ts': 'y'.repeat(40) },
    },
  ],
  manifest: {
    schemaVersion: 1,
    candidate: 'c'.repeat(40),
    repairHead: 'r'.repeat(40),
    signatureFingerprint: 'fp',
    builtAtMs: 4,
    rowsTruncated: 0,
    rows: [
      {
        legId: 'test-file:a/failing.test.ts',
        kind: 'test-file',
        recipe: '',
        subjectPaths: ['a/failing.test.ts'],
        subjectPathsTruncated: 0,
        subjectSource: 'leg-id',
        status: { kind: 'admitted', admission: 1, toRepairHead: 't'.repeat(40), paths: ['a/failing.test.ts'] },
        statusLabel: 'admitted-in-#1@tttttttt',
        admitCommand: null,
        claim: null,
      },
      {
        legId: 'test-file:b/failing.test.ts',
        kind: 'test-file',
        recipe: '',
        subjectPaths: ['b/failing.test.ts'],
        subjectPathsTruncated: 0,
        subjectSource: 'leg-id',
        status: { kind: 'red-at-candidate' },
        statusLabel: 'red-at-candidate',
        admitCommand: "release:repair-queue { op:'admit', paths:['b/failing.test.ts'] }",
        claim: null,
      },
      {
        legId: 'lint-leg:lint:tsc',
        kind: 'lint-leg',
        recipe: '',
        subjectPaths: [],
        subjectPathsTruncated: 0,
        subjectSource: 'none',
        status: { kind: 'green', head: 'g'.repeat(40) },
        statusLabel: 'green-at-gggggggg',
        admitCommand: null,
        claim: null,
      },
    ],
  },
} as unknown as FrozenCandidateRepairQueue;

const target = { workspaceId: 'workspace-a', installSlug: 'papercusp' };

describe('frozen-repair edit marker — P-022 ledger projection', () => {
  it('projects the admission ledger (paths ∪ unchanged, normalized) and the manifest legs, status-only', () => {
    const path = scratch();
    projectFrozenRepairMarker(queue, path);
    const m = readFrozenRepairMarker(path);
    expect(m).not.toBeNull();
    expect(m!.failingPaths).toEqual(['a/failing.test.ts', 'b/failing.test.ts']);
    expect(m!.admittedPaths).toEqual(['a/failing.test.ts', 'lib/helper.ts']);
    expect(m!.legs).toEqual([
      { legId: 'test-file:a/failing.test.ts', status: 'admitted', subjectPaths: ['a/failing.test.ts'] },
      { legId: 'test-file:b/failing.test.ts', status: 'red', subjectPaths: ['b/failing.test.ts'] },
      { legId: 'lint-leg:lint:tsc', status: 'green', subjectPaths: [] },
    ]);
  });

  it('a queue with no admissions and no manifest projects empty ledger fields (never absent)', () => {
    const path = scratch();
    projectFrozenRepairMarker({ ...queue, admissions: undefined, manifest: undefined } as FrozenCandidateRepairQueue, path);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(raw.admittedPaths).toEqual([]);
    expect(raw.legs).toEqual([]);
  });

  it('tolerates a marker written before P-022 — the ledger reads empty, the marker still parses', () => {
    const path = scratch();
    writeFileSync(
      path,
      JSON.stringify({
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        phase: 'repair-in-progress',
        failingPaths: ['a/failing.test.ts'],
        updatedAtMs: 1,
      }),
    );
    const m = readFrozenRepairMarker(path);
    expect(m).toMatchObject({ candidate: 'c'.repeat(40), admittedPaths: [], legs: [] });
  });

  it('drops malformed legs rather than failing the whole marker', () => {
    const path = scratch();
    writeFileSync(
      path,
      JSON.stringify({
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        phase: 'repair-in-progress',
        failingPaths: [],
        updatedAtMs: 1,
        admittedPaths: ['a', 7, null],
        legs: [{ legId: 'ok', status: 'bogus', subjectPaths: ['p', 1] }, 'junk', { status: 'red' }],
      }),
    );
    const m = readFrozenRepairMarker(path);
    expect(m!.admittedPaths).toEqual(['a']);
    expect(m!.legs).toEqual([{ legId: 'ok', status: 'red', subjectPaths: ['p'] }]);
  });

  it('clears the marker for ready-to-test and for no queue', () => {
    const path = scratch();
    projectFrozenRepairMarker(queue, path);
    projectFrozenRepairMarker({ ...queue, phase: 'ready-to-test' } as FrozenCandidateRepairQueue, path);
    expect(readFrozenRepairMarker(path)).toBeNull();
  });

  it('keeps marker files and identities isolated by workspace and install', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'frozen-repair-scope-'));
    dirs.push(stateDir);
    const previousStateDir = process.env.PAPERCUSP_STATE_DIR;
    process.env.PAPERCUSP_STATE_DIR = stateDir;
    try {
      const otherInstall = { workspaceId: 'workspace-a', installSlug: 'other-harness' };
      const otherWorkspace = { workspaceId: 'workspace-b', installSlug: 'papercusp' };
      const path = frozenRepairMarkerPath(target)!;
      expect(path).not.toBe(frozenRepairMarkerPath(otherInstall));
      expect(path).not.toBe(frozenRepairMarkerPath(otherWorkspace));

      projectFrozenRepairMarker(queue, target);
      projectFrozenRepairMarker({ ...queue, candidate: 'a'.repeat(40) } as FrozenCandidateRepairQueue, otherInstall);
      expect(readFrozenRepairMarker(target)).toMatchObject({ scope: target, candidate: 'c'.repeat(40) });
      expect(readFrozenRepairMarker(otherInstall)).toMatchObject({ scope: otherInstall, candidate: 'a'.repeat(40) });

      // Copying a valid marker into another scope's path cannot make it authoritative there.
      writeFileSync(frozenRepairMarkerPath(otherWorkspace)!, readFileSync(path, 'utf8'));
      expect(readFrozenRepairMarker(otherWorkspace)).toBeNull();
      // A pre-scope global marker is not a fallback for a missing or wildcard target.
      writeFileSync(join(stateDir, 'frozen-repair-edit-marker.json'), readFileSync(path, 'utf8'));
      expect(readFrozenRepairMarker(null)).toBeNull();
      expect(readFrozenRepairMarker({ workspaceId: '*', installSlug: 'papercusp' })).toBeNull();
    } finally {
      if (previousStateDir === undefined) delete process.env.PAPERCUSP_STATE_DIR;
      else process.env.PAPERCUSP_STATE_DIR = previousStateDir;
    }
  });
});
