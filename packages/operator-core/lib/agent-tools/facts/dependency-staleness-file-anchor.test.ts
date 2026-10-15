/**
 * P-012 (derived-status-not-hand-written-2026-10-12) — FILE ANCHORS on facts.
 *
 * SPEC-P-012:          facts:assert records the blob of each `file:` anchor at assert time.
 * AUTO-BAR-R-11-P-012: facts:list reports a file-anchored fact stale after the anchored
 *                      file's content changes; an anchored fact may omit ttlSec.
 *
 * Every input is built inline: a throwaway checkout root under the OS temp dir, files
 * written by the test, and the real `file:` freshness resolver pointed at that root
 * through its caller-owned `repoRoot` override. The expected blob is computed here
 * independently (sha256 of the bytes, first 16 hex), not read back from the module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFactDependencies, markStaleDependencyFacts, FILE_ANCHOR_READ_BUDGET } from './dependency-staleness';
import {
  FILE_ANCHORED_DEFAULT_TTL_SEC,
  isFactFileAnchor,
  resolveFactLifetime,
  validateFactLifetime,
  type AgentFact,
  type FactDependency,
} from '../../agent-facts/store';
import type { CellReadEnv } from '../../cell-read';
import type { CellReader } from '../../cell-registry';
import assertTool from './assert';

const env: CellReadEnv = { workspaceId: 'ws-file-anchor-test', harnessSlug: null, role: 'su' };
// File anchors never touch the cell registry; a reader that throws proves it.
const reader = new Proxy({}, {
  get() {
    throw new Error('file anchors must not dispatch a cell read');
  },
}) as unknown as CellReader;

function expectedBlob(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
}

function factWith(dependsOn: FactDependency[]): AgentFact {
  return { scope: 'workspace', scopeRef: null, key: 'p012-probe', body: 'probe', dependsOn } as unknown as AgentFact;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p012-file-anchor-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SPEC-P-012: facts:assert records the blob of each file anchor at assert time', () => {
  it('stores the file content blob as the dependency digest, for every anchor', async () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.md'), '# b\n');
    const deps = await captureFactDependencies(['file:a.ts', 'file:b.md'], reader, env, undefined, { fileRepoRoot: root });
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({ cell: 'file:a.ts', digest: expectedBlob('export const a = 1;\n'), observed: expectedBlob('export const a = 1;\n') });
    expect(deps[1]).toMatchObject({ cell: 'file:b.md', digest: expectedBlob('# b\n') });
    for (const d of deps) {
      expect(d.unknown).toBeUndefined();
      expect(typeof d.observedAt).toBe('string');
    }
  });

  it('records an anchor that does not resolve as unknown, never as a blob', async () => {
    const deps = await captureFactDependencies(['file:missing.ts', 'file:../escape.ts'], reader, env, undefined, { fileRepoRoot: root });
    expect(deps.map((d) => [d.cell, d.digest, d.unknown])).toEqual([
      ['file:missing.ts', undefined, 'absent'],
      ['file:../escape.ts', undefined, 'absent'],
    ]);
  });
});

describe('AUTO-BAR-R-11: a file-anchored fact goes stale when the anchored file changes', () => {
  it('reports fresh while the file is unchanged, then stale naming the old and new blob after an edit', async () => {
    const path = join(root, 'subject.ts');
    writeFileSync(path, 'v1\n');
    const deps = await captureFactDependencies(['file:subject.ts'], reader, env, undefined, { fileRepoRoot: root });

    const [unchanged] = await markStaleDependencyFacts([factWith(deps)], reader, env, { fileRepoRoot: root });
    expect(unchanged!.depsStale?.status).toBe('fresh');

    writeFileSync(path, 'v2\n');
    const [edited] = await markStaleDependencyFacts([factWith(deps)], reader, env, { fileRepoRoot: root });
    expect(edited!.depsStale?.status).toBe('stale');
    expect(edited!.depsStale?.changed).toEqual(['file:subject.ts']);
    expect(edited!.depsStale?.deps[0]).toMatchObject({ status: 'changed', was: expectedBlob('v1\n'), now: expectedBlob('v2\n') });
    expect(edited!.depsStale?.note).toContain('STALE');
  });

  it('a touch that keeps the bytes identical does NOT make the fact stale (content, not mtime)', async () => {
    const path = join(root, 'same.ts');
    writeFileSync(path, 'same\n');
    const deps = await captureFactDependencies(['file:same.ts'], reader, env, undefined, { fileRepoRoot: root });
    writeFileSync(path, 'same\n');
    const [again] = await markStaleDependencyFacts([factWith(deps)], reader, env, { fileRepoRoot: root });
    expect(again!.depsStale?.status).toBe('fresh');
  });

  it('a deleted anchored file is never reported fresh', async () => {
    const path = join(root, 'gone.ts');
    writeFileSync(path, 'here\n');
    const deps = await captureFactDependencies(['file:gone.ts'], reader, env, undefined, { fileRepoRoot: root });
    unlinkSync(path);
    const [after] = await markStaleDependencyFacts([factWith(deps)], reader, env, { fileRepoRoot: root });
    expect(after!.depsStale?.status).toBe('undeterminable');
    expect(after!.depsStale?.deps[0]?.detail).toContain('anchored file');
  });

  it('anchors past the per-pass budget report undeterminable naming the budget, never fresh', async () => {
    const deps: FactDependency[] = [];
    for (let i = 0; i <= FILE_ANCHOR_READ_BUDGET; i += 1) {
      writeFileSync(join(root, `f${i}.ts`), `${i}\n`);
      deps.push(...(await captureFactDependencies([`file:f${i}.ts`], reader, env, undefined, { fileRepoRoot: root })));
    }
    // One fact per anchor so the store's per-fact dependency cap does not hide the budget.
    const marked = await markStaleDependencyFacts(deps.map((d) => factWith([d])), reader, env, { fileRepoRoot: root });
    const last = marked[marked.length - 1]!;
    expect(marked.slice(0, FILE_ANCHOR_READ_BUDGET).every((f) => f.depsStale?.status === 'fresh')).toBe(true);
    expect(last.depsStale?.status).toBe('undeterminable');
    expect(last.depsStale?.deps[0]?.detail).toContain('read-budget-exceeded');
  });
});

describe('AUTO-BAR-R-11: an anchored fact may omit ttlSec', () => {
  it('isFactFileAnchor recognizes only a non-empty file: ref', () => {
    expect(isFactFileAnchor('file:a.ts')).toBe(true);
    expect(isFactFileAnchor(' file:a.ts ')).toBe(true);
    expect(isFactFileAnchor('file:')).toBe(false);
    expect(isFactFileAnchor('deploy.3070.sha')).toBe(false);
  });

  it('the store accepts a resolved anchor in place of ttlSec, and still refuses a bare ordinary fact', () => {
    expect(validateFactLifetime({ key: 'k', fileAnchored: true })).toBeNull();
    expect(validateFactLifetime({ key: 'k' })).toContain('state how long this fact should live');
    expect(validateFactLifetime({ key: 'k', fileAnchored: false })).toContain('file:');
  });

  it('an anchored fact with no ttlSec gets the finite anchored bound, never infinity', () => {
    expect(
      resolveFactLifetime({ key: 'k', subjectVolatile: false, effectiveTtlSec: null, fileAnchored: true }),
    ).toEqual({ permanent: false, ttlSec: FILE_ANCHORED_DEFAULT_TTL_SEC });
  });

  it('an explicit ttlSec and a hedge confidence both outrank the anchored bound', () => {
    expect(
      resolveFactLifetime({ key: 'k', subjectVolatile: false, effectiveTtlSec: 3600, fileAnchored: true }),
    ).toEqual({ permanent: false, ttlSec: 3600 });
    const hedged = resolveFactLifetime({ key: 'k', subjectVolatile: false, effectiveTtlSec: null, fileAnchored: true, confidence: 'suspected' });
    expect(hedged.permanent).toBe(false);
    expect(hedged.ttlSec).toBeLessThan(FILE_ANCHORED_DEFAULT_TTL_SEC);
  });

  it('facts:assert preflight accepts a file-anchored fact with no ttlSec, and refuses the same fact without the anchor', () => {
    const base = { scope: 'workspace', key: 'p012-preflight', body: 'the reconciler lives in work-items.ts' };
    expect(assertTool.args.safeParse({ ...base, dependsOn: ['file:packages/operator-core/lib/work-items.ts'] }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...base, dependsOn: [{ cell: 'file:packages/operator-core/lib/work-items.ts' }] }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...base, dependsOn: ['deploy.3070.sha'] }).success).toBe(false);
    expect(assertTool.args.safeParse(base).success).toBe(false);
  });
});
