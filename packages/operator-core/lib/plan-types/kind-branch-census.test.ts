/**
 * The R-7 deliverable-kind branch census (./kind-branch-census.ts) and its committed-tree
 * instrument, `deliverable-kind-branch-census` (agent-tools/plans/tree-instruments.ts).
 *
 * The instrument is what lets a spec-evidence binding of plan-verification-profile-boundary.test.ts
 * read current: that test walks whole trees, so no bounded file set witnesses it. These cases pin
 * the property the binding relies on — the digest moves when, and only when, what the test asserts
 * about the committed tree moves.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTreeInstrumentMemoForTest,
  foldTreeInstrumentFingerprint,
  measureTreeInstrumentAtCommit,
} from '../agent-tools/plans/tree-instruments';
import { KIND_BRANCH_BASELINE, isKindScanPath, kindBranchCensus, kindBranchCensusOutput } from './kind-branch-census';

const KEY = 'deliverable-kind-branch-census' as const;
const GATE = 'packages/operator-core/lib/plan-acceptance-gate.ts';
const DOC_PIN = 'packages/operator-core/lib/doc-claims/verification-profiles-doc.ts';
/** The one baselined site, so a clean tree reports no stale entry. */
const DOC_PIN_BODY = 'export const pin = (deliverable: string[], expected: { deliverable: string }) => deliverable[0] !== expected.deliverable;\n';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Kind census test',
  '-c', 'user.email=kind-census-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

async function put(files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'step', '--allow-empty');
  return git('rev-parse', 'HEAD');
}

const measure = (commit: string) => measureTreeInstrumentAtCommit(KEY, root, commit);
const fp = (output: unknown) => foldTreeInstrumentFingerprint('sha256-file-set-v1:x', KEY, output);

beforeEach(async () => {
  __resetTreeInstrumentMemoForTest();
  root = await realpath(await mkdtemp(join(tmpdir(), 'kind-census-')));
  git('init', '-q');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isKindScanPath', () => {
  it('scans source under the R-7 roots and skips tests, declarations, skipped dirs and policy owners', () => {
    expect(isKindScanPath(GATE)).toBe(true);
    expect(isKindScanPath('apps/operator/app/admin/plans/PlanRail.tsx')).toBe(true);
    expect(isKindScanPath('libs/generic/plan-parser/src/parser.ts')).toBe(true);
    for (const path of [
      'packages/operator-core/lib/plan-acceptance-gate.test.ts',
      'apps/operator/e2e/plans.spec.ts',
      'apps/operator/types/env.d.ts',
      'apps/operator/dist-host/hono-host.ts',
      'packages/operator-core/lib/x/node_modules/y/index.ts',
      'packages/operator-core/lib/plan-verification-profile.ts',
      'packages/operator-core/lib/plan-types/registry.ts',
      'libs/generic/plan-parser/src/verification-vocabulary.ts',
      'packages/operator-core/lib/notes.md',
      'packages/other/lib/gate.ts',
    ]) {
      expect(isKindScanPath(path), path).toBe(false);
    }
  });
});

describe('deliverable-kind-branch-census tree instrument', () => {
  it('reports the census of the committed tree, not of the working tree', async () => {
    const commit = await put({
      [DOC_PIN]: DOC_PIN_BODY,
      [GATE]: "export const gate = (item: { deliverable: string }) => item.deliverable === 'code';\n",
      'packages/operator-core/lib/plan-acceptance-gate.test.ts': "if (item.deliverable === 'code') {}\n",
      'packages/operator-core/lib/plan-types/resolve.ts': "if (item.deliverable === 'code') {}\n",
    });
    // Uncommitted planted branch: not in the committed tree, so not in the census.
    await mkdir(join(root, 'apps/operator'), { recursive: true });
    await writeFile(join(root, 'apps/operator/Planted.tsx'), "if (row.deliverable === 'doc') {}\n");
    expect(await measure(commit)).toEqual({
      findings: [
        `${DOC_PIN} :: kind-comparison :: deliverable[0] !== expected.deliverable`,
        `${GATE} :: literal-equality :: item.deliverable === 'code'`,
      ],
      unexpected: [`${GATE} :: literal-equality :: item.deliverable === 'code'`],
      stale: [],
    });
  });

  it('stays current across unrelated commits, including one that moves a baselined site', async () => {
    const base = await put({
      [DOC_PIN]: DOC_PIN_BODY,
      [GATE]: 'export const gate = () => true;\n',
    });
    const before = await measure(base);
    expect(before).toEqual({ findings: [KIND_BRANCH_BASELINE[0]], unexpected: [], stale: [] });
    const unrelated = await put({
      [DOC_PIN]: `// a new first line moves the baselined site down\n${DOC_PIN_BODY}`,
      [GATE]: 'export const gate = () => false;\n',
      'packages/operator-core/lib/new-helper.ts': 'export const helper = (deliverable: string | null) => deliverable === null;\n',
      'docs/notes.md': "item.deliverable === 'code'\n",
    });
    const after = await measure(unrelated);
    expect(after).toEqual(before);
    expect(fp(after)).toBe(fp(before));
  });

  it('goes stale when a kind branch is planted, and when the baselined site goes away', async () => {
    const base = await put({ [DOC_PIN]: DOC_PIN_BODY, [GATE]: 'export const gate = () => true;\n' });
    const before = await measure(base);
    const planted = await put({ 'apps/operator/app/plans/Rail.tsx': "export const Rail = (p: { deliverable: string }) => p.deliverable === 'research';\n" });
    const afterPlant = await measure(planted);
    expect(afterPlant).toMatchObject({
      unexpected: ["apps/operator/app/plans/Rail.tsx :: literal-equality :: p.deliverable === 'research'"],
      stale: [],
    });
    expect(fp(afterPlant)).not.toBe(fp(before));
    const removed = await put({ [DOC_PIN]: 'export const pin = () => true;\n' });
    expect(await measure(removed)).toMatchObject({ stale: [KIND_BRANCH_BASELINE[0]] });
  });

  it('agrees with the working-tree census over the same files', async () => {
    const files = {
      [DOC_PIN]: DOC_PIN_BODY,
      [GATE]: "switch (item.deliverable) { case 'decision': break; }\n",
      'apps/operator/app/x.tsx': "export const x = (d: { deliverable: string }) => ['doc'].includes(d.deliverable);\n",
    };
    const commit = await put(files);
    const scanned = Object.keys(files).filter(isKindScanPath).sort();
    const census = kindBranchCensus(scanned, (path) => files[path as keyof typeof files]);
    expect(await measure(commit)).toEqual(kindBranchCensusOutput(census));
  });
});
