import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sweepHarnessDocs } from './freshness-sweep';
import type { HarnessDocRecord } from './doc-record';
import type { DriftResult } from './drift';
import type { GitRunner } from './subject-ref';
import graphQuery from '../../agent-tools/gitnexus/query';
import type { CodeIntelAnswer } from '../../code-intelligence/contracts';
import { generateNativeArchitecture } from './native-architecture';

describe('native P029 architecture citations through the real compiler', () => {
  const request = { name: 'entry', file: 'api.ts', paths: ['api.ts', 'target.ts'] };
  async function fixture(run: (root: string, query: () => Promise<CodeIntelAnswer>) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'native-architecture-doc-'));
    try {
      writeFileSync(join(root, 'target.ts'), 'export function leaf() { return 1; }\n');
      writeFileSync(join(root, 'api.ts'), 'import { leaf } from "./target";\nexport function entry() { return leaf(); }\n');
      const query = async () => (await graphQuery.handler(graphQuery.args.parse({ op: 'context',
        name: request.name, file_path: request.file, paths: request.paths }),
      { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
      await run(root, query);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  it('generates static relationships with current endpoint hashes and automatic drift anchors', async () => {
    await fixture(async (root, query) => {
      const generated = await generateNativeArchitecture(root, request, query);
      expect(generated.statements).toBeGreaterThan(0);
      expect(generated.documents).toEqual(['api.ts', 'target.ts']);
      expect(generated.body).toContain('callees');
      expect(generated.body).toContain('api.ts:2');
      expect(generated.body).toContain('target.ts:1');
      expect(generated.body).toContain(createHash('sha256').update('export function leaf() { return 1; }\n').digest('hex'));
      expect(generated.body).toContain('Runtime execution and source completeness remain unverified');
      const statements = generated.body.split('\n').filter(line => line.startsWith('- The compiler'));
      expect(statements.every(line => (line.match(/SHA-256/g) ?? []).length === 2)).toBe(true);
    });
  }, 60_000);
  it('refuses a captured relationship after its target changes before authoring', async () => {
    await fixture(async (root, query) => {
      const captured = await query();
      expect(captured.error).toBeNull();
      writeFileSync(join(root, 'target.ts'), 'export function replacement() { return 2; }\n');
      await expect(generateNativeArchitecture(root, request, async () => captured)).rejects.toThrow('native_architecture_stale_source');
    });
  }, 60_000);
  it('refuses an observed relationship whose target citation is missing', async () => {
    await fixture(async (root, query) => {
      const captured = await query();
      expect(captured.error).toBeNull();
      const uncited: CodeIntelAnswer = { ...captured, evidence: { ...captured.evidence!,
        relationships: captured.evidence!.relationships.map(relation => relation.kind === 'callees'
          ? { ...relation, target: undefined } : relation) } };
      await expect(generateNativeArchitecture(root, request, async () => uncited)).rejects.toThrow('native_architecture_uncited_relationship');
    });
  }, 60_000);
});

describe('native P016 documentation anchor-to-steward integration', () => {
  it('flags a real committed documented rename and delivers its scoped pinned candidate through the existing review hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-doc-change-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const runGit: GitRunner = async args => {
      try { return { code: 0, stdout: git(...args), stderr: '' }; }
      catch (error) { const e = error as { status?: number; stderr?: Buffer }; return { code: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? error) }; }
    };
    try {
      git('init', '--quiet');
      const before = 'export function readApi() { return "old"; }\n';
      const after = 'export function readApiV2() { return "new"; }\n';
      writeFileSync(join(root, 'api.ts'), before); git('add', 'api.ts'); git('commit', '--quiet', '-m', 'fixture baseline');
      const baseline = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(root, 'api.ts'), after); git('add', 'api.ts'); git('commit', '--quiet', '-m', 'fixture rename');
      const current = git('rev-parse', 'HEAD').trim();
      const doc = { docId: 'api-guide.md', source: 'manual', status: 'fresh', statusDetail: null,
        subjectRef: [{ kind: 'symbol', file: 'api.ts', name: 'readApi' }], anchorPaths: ['api.ts'],
        lastVerifiedSha: baseline, reverifyAttempts: 0, reverifyFlaggedAt: null } as HarnessDocRecord;
      let delivered: DriftResult | undefined;
      const statuses: string[] = [];
      const result = await sweepHarnessDocs({ harnessSlug: 'fixture', repoRoot: root, runGit, changedPaths: ['api.ts'],
        store: { load: async () => [doc], setStatus: async (_id, status) => { statuses.push(status); },
          touchRegen: async () => {}, touchReverify: async () => {} },
        onReverifyNeeded: (candidate, _detail, becameDrifted, drift) => {
          expect(candidate.docId).toBe('api-guide.md'); expect(becameDrifted).toBe(true); delivered = drift;
        } });
      expect(result.reverifyFlagged).toEqual(['api-guide.md']); expect(statuses).toEqual(['review']);
      expect(doc.status).toBe('fresh'); // review output never rewrites or verifies the document itself
      expect(delivered?.sourceChanges).toContainEqual(expect.objectContaining({ path: 'api.ts', status: 'measured',
        before: { commit: baseline, sha256: createHash('sha256').update(before).digest('hex') },
        after: { commit: current, sha256: createHash('sha256').update(after).digest('hex') }, removedSymbols: ['readApi'] }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
