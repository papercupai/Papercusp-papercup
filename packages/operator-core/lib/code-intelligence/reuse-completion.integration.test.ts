/** R19: real canonical closes and issued ledger with controlled delivery inputs.
 * Producer semantics are covered separately; R22 retains native runtime proof.
 * Only external reactions/review launches and source-input discovery are isolated. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { REUSE_PROVIDER_POLICY, briefCodePoints, type ReuseBriefProvider, type ReuseProviderId } from './reuse-brief-providers';
import { coverageHash, type TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';
import { coverageBriefProvider } from './test-coverage-map';
import { nativeChangeReport } from './packer-facade';
import { firstPartyCallers } from './first-party-callers';
import { coChangeFromCommits } from './change-history';

const h = vi.hoisted(() => ({ root: '', providers: [] as ReuseBriefProvider[], report: undefined as typeof nativeChangeReport | undefined }));
vi.mock('../harness-registry', async original => ({
  ...await original<typeof import('../harness-registry')>(),
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'papercusp', path: h.root }] }),
  resolveHarnessContentPath: () => h.root,
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(),
  getFlag: async (key: string) => key === 'papercusp-code-intel-push-completion',
}));
vi.mock('../events', async original => ({ ...await original<typeof import('../events')>(), fireReactionInProcess: async () => ({ ok: true }) }));
vi.mock('../grading-integrity', async original => ({
  ...await original<typeof import('../grading-integrity')>(),
  dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
}));
vi.mock('../harness/improvements/completion-verification-store', async original => ({
  ...await original<typeof import('../harness/improvements/completion-verification-store')>(),
  spawnCompletionVerificationForClose: async () => ({ outcome: 'no-dependents' }),
  applyCompletionVerdictForClose: async () => null, acceptCompletionOnSettlementForSubject: async () => null,
}));
vi.mock('./task-brief', async original => {
  const actual = await original<typeof import('./task-brief')>();
  return { ...actual, getCompletionTimeBrief: (ref: Parameters<typeof actual.getCompletionTimeBrief>[0],
    deps: Parameters<typeof actual.getCompletionTimeBrief>[1]) => actual.getCompletionTimeBrief(ref, {
      ...deps, root: async () => h.root, report: h.report, runs: async () => null,
      cochange: async () => coChangeFromCommits({ end: new Date().toISOString(), paths: ['target.ts'],
        commit: null, complete: false, commits: [] }),
      reuse: { providers: h.providers },
    }) };
});

const { createIssue } = await import('../issues-engineer');
const { getWorkItem } = await import('../work-items');
const { declareChangeKinds } = await import('../work-item-change-kinds');
const complete = (await import('../agent-tools/work_items/complete')).default;
const { getCompletionTimeBrief } = await import('./task-brief');
const OWNER = 'su-p010-completion-integration';
const ids = Object.keys(REUSE_PROVIDER_POLICY) as ReuseProviderId[];
type Mode = 'match' | 'no-match' | 'oversized' | 'failed' | 'slow' | 'complete' | 'partial' | 'stale';
let fx: PlanPgFixture;

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  h.root = await mkdtemp(join(tmpdir(), 'p010-completion-'));
  await writeFile(join(h.root, 'target.ts'), 'export function target() { return 1; }\n');
  await writeFile(join(h.root, 'target.test.ts'), 'import { target } from "./target"; target();\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'source fixture']]) execFileSync('git', ['-C', h.root, ...args]);
  h.report = async (args, subject) => {
    const report = await nativeChangeReport(args, subject, { exec: async () => ({ stdout: '', stderr: '' }),
      writeArtifact: async () => 'fixture-report', graph: async () => firstPartyCallers({ ts, root: h.root,
        name: subject.symbol, filePath: subject.file, op: 'impact', direction: 'downstream', paths: ['.'], includeInterfaces: true }) });
    return { ...report, report: { ...report.report, changed: [{ path: 'target.ts', line1: 1,
      patch: 'diff --git a/target.ts b/target.ts\n--- a/target.ts\n+++ b/target.ts\n@@ -1 +1 @@\n-old\n+export function target() { return 1; }\n' }] } };
  };
  await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
    VALUES (${fx.workspaceId}, ${OWNER}, 'p010-completion-turn')`;
}, 180_000);
afterAll(async () => { await fx?.dispose(); if (h.root) await rm(h.root, { recursive: true, force: true }); });

function controlled(id: ReuseProviderId, mode: Mode): ReuseBriefProvider {
  if (id === 'coverage' && (mode === 'complete' || mode === 'partial' || mode === 'stale')) return coverageBriefProvider(async context => {
    const testHash = coverageHash(await readFile(join(h.root, 'target.test.ts')));
    const hashes = new Map(context.sourceFiles!.map(file => [file.path, file.sha256]));
    hashes.set('target.test.ts', testHash);
    const snapshot: TestCoverageSnapshot = { schemaVersion: 1, root: h.root, scopeRoot: h.root,
      testFile: 'target.test.ts', testSha256: testHash, observedAt: new Date().toISOString(),
      populationComplete: mode !== 'partial', population: [{ path: 'target.test.ts', sha256: testHash }],
      sources: [{ path: 'target.ts', sha256: mode === 'stale' ? '0'.repeat(64) : hashes.get('target.ts')!, executable: [1], covered: [] }] };
    return { snapshots: [snapshot], currentHashes: hashes, population: ['target.test.ts'] };
  });
  return { id, read: async (context, signal) => {
    if (id === 'sql' && mode === 'failed') throw new Error('controlled SQL provider failure');
    if (id === 'sql' && mode === 'slow') await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const lines = id === 'clones' ? ['Untouched sibling sibling.ts:1 sibling', 'New copy target.ts:2 plantedCopy']
      : id === 'cochange' ? ['Untouched partner.ts (3/3;90d)']
      : id === 'sql' ? ['SQL reader left unchecked reader.ts:1 public.fixture']
      : id === 'coverage' ? ['no recorded test executed changed lines target.ts:1'] : [];
    return { status: 'measured', sourceVersion: context.sourceVersion, indexVersion: `controlled-${id}-v1`,
      citedPaths: ['target.ts'], lines: mode === 'no-match' ? [] : mode === 'oversized' ? Array.from({ length: 200 }, () => lines).flat() : lines };
  } };
}

describe('R19 canonical completion remains advisory', () => {
  it.each(['match', 'no-match', 'oversized', 'failed', 'slow', 'complete', 'partial', 'stale'] as const)(
    '%s preserves close/base, payload classes, budgets and per-provider issued identity', async mode => {
      h.providers = ids.map(id => controlled(id, mode));
      const issue = await createIssue({ kind: 'change', scope: 'harness:papercusp', createdBy: OWNER,
        title: `P010 controlled completion ${mode}`, body: 'Private R19 handler-delivery fixture.' });
      await fx.admin`UPDATE harness_shared.work_items SET taken_by = ${OWNER}, taken_at = now(), admission = 'admitted'
        WHERE feature_id = ${issue.id}`;
      await declareChangeKinds({ workspaceId: fx.workspaceId, featureId: issue.id, kinds: ['logic'], step: 'claim', declaredBy: OWNER });
      const invocation = `p010-close-${mode}`, metadata = vi.fn();
      const base = await getCompletionTimeBrief({ workspaceId: fx.workspaceId, harness: 'papercusp', paths: ['target.ts'] });
      const started = Date.now();
      const response = await complete.handler(complete.args.parse({ id: issue.id, harness: 'papercusp', state: 'done', assumptions: 'none',
        completion: { summary: 'Checked private source fixture and its completion advice.',
          testsRun: 'npm run test:file -- packages/operator-core/lib/code-intelligence/reuse-completion.integration.test.ts',
          testResult: '1 passed', verifiedHow: 'Real handler and private PG readback', filesChanged: ['target.ts'] } }),
        { workspaceId: fx.workspaceId, uiClientId: OWNER, isSuperuser: true, dispatchCallId: invocation,
          signal: new AbortController().signal, metadata, log: vi.fn(), emit: vi.fn(), progress: vi.fn() } as never);
      expect(Date.now() - started).toBeLessThan(6_000);
      const result = (response as { data: { results: Array<Record<string, any>> } }).data.results[0]!;
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect((await getWorkItem(issue.id))?.state).toBe('done');
      const brief = result.completionBrief;
      expect(brief, JSON.stringify(result)).toBeDefined();
      expect(brief.changes).toEqual(base.changes);
      expect(brief.tests).toEqual(base.tests);
      expect(brief.executionCoverage).toBe('unmeasured');
      expect(briefCodePoints(JSON.stringify(brief))).toBeLessThanOrEqual(3_000);
      const text = brief.limitations.join('\n');
      if (mode === 'no-match') expect(brief.limitations).toEqual(base.limitations);
      else {
        expect(text).toContain('Untouched sibling'); expect(text).toContain('New copy');
        expect(text).toContain('Untouched partner.ts');
        if (mode !== 'failed' && mode !== 'slow') expect(text).toContain('SQL reader left unchecked');
        if (mode === 'partial' || mode === 'stale') {
          expect(text).toContain(mode === 'partial' ? 'execution absence unknown (partial coverage)' : 'execution unknown');
          expect(text).not.toContain('no recorded test executed changed lines');
        } else expect(text).toContain('no recorded test executed changed lines');
      }
      const observed = metadata.mock.calls.flatMap(([value]) => value.reuseBriefProviders ?? []).at(-1);
      expect(observed?.context).toMatchObject({ surface: 'completion', invocation, workItem: issue.id });
      for (const row of observed.observations) expect(row.chars).toBeLessThanOrEqual(REUSE_PROVIDER_POLICY[row.provider as ReuseProviderId].cap);
      if (mode === 'oversized') expect(observed.observations.some((row: { reason: string }) => row.reason === 'truncated')).toBe(true);
      if (mode === 'failed' || mode === 'slow') expect(observed.observations.find((row: { provider: string }) => row.provider === 'sql'))
        .toMatchObject({ status: 'unknown', reason: mode === 'failed' ? 'failure' : 'timeout' });
      const rows = await fx.admin`SELECT subject, chars, turn_id FROM harness_shared.code_intel_pushes
        WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${OWNER} AND subject::jsonb->>'invocation' = ${invocation}`;
      expect(rows).toHaveLength(observed.observations.filter((row: { status: string }) => row.status === 'issued').length);
      for (const row of rows) {
        expect(row.turn_id).toBe('p010-completion-turn');
        expect(JSON.parse(row.subject)).toMatchObject({ surface: 'completion', invocation, workItem: issue.id,
          sourceVersion: expect.any(String), indexVersion: expect.any(String) });
      }
    }, 30_000);
});
