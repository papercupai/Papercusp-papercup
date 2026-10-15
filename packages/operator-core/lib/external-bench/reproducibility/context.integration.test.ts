/**
 * context.integration.test.ts — matched arms' frozen initial context across a real Postgres
 * pre-registration, a real git commit of the protocol, and physical per-assignment restoration
 * (current-benchmark-modernization-2026-10-09 P-006: BM-P-006-equal-context, BM-P-006-solution-isolation).
 *
 * Behaviours a unit test with hand-built inputs can't prove:
 *  - two matched arms admitted from ONE committed protocol restore byte-identical corpus/memory and an
 *    identical rendered context, pinned to the committed snapshot bytes, and neither can inherit more;
 *  - one arm's output and hidden grader answers present on disk never reach another arm's context
 *    or checkout, and a committed snapshot that carries a forbidden source is refused before anything
 *    is written into the assignment checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { currentProtocolFixture } from './_protocol-test-fixture';

const { preregister, requireCommittedPreregistration } = await import('./prereg');
const { restoreBenchmarkContext, readRestoredBenchmarkContext } = await import('./context');
const { currentBenchmarkProtocolSchema } = await import('./schema');

const WS = 'ws-bench-context';
const CORPUS_REF = 'bench/context/corpus.json';
const MEMORY_REF = 'bench/context/memory.json';
let rootSql: postgres.Sql;
const scope = () => ({ sql: rootSql as never, workspaceId: WS });
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** An isolated git fixture whose single commit introduces every listed file (never the shared checkout). */
function commitFixture(repoRoot: string, files: Record<string, string>): void {
  execFileSync('git', ['-c', 'init.defaultBranch=fixture-other', 'init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const entries = Object.entries(files);
  const blobs = entries.map(([, body], i) => `blob\nmark :${i + 1}\ndata ${Buffer.byteLength(body)}\n${body}\n`).join('');
  const tree = entries.map(([file], i) => `M 100644 :${i + 1} ${file}\n`).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot,
    input: `${blobs}commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\n${tree}\ndone\n` });
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
}

/** Every regular file under a root, recursively (the whole assignment checkout an arm can read). */
function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const file = path.join(root, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

interface Study {
  repoRoot: string; runId: string; preregHash: string;
  context: ReturnType<typeof currentProtocolFixture>['context'];
  corpus: string; memory: string;
}

/** Pre-register a protocol pinning these snapshot bytes, commit it, and admit it exactly as current-su does. */
async function committedStudy(runId: string, corpus: string, memory: string): Promise<Study> {
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'bench-context-repo-')));
  mkdirSync(path.join(repoRoot, 'bench/context'), { recursive: true });
  writeFileSync(path.join(repoRoot, CORPUS_REF), corpus);
  writeFileSync(path.join(repoRoot, MEMORY_REF), memory);
  const protocol = currentProtocolFixture(runId);
  protocol.context = { corpusHash: sha256(corpus), memoryHash: sha256(memory), corpusRef: CORPUS_REF, memoryRef: MEMORY_REF,
    isolation: 'fresh-per-assignment', forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] };
  const config = JSON.parse(JSON.stringify(currentBenchmarkProtocolSchema.parse(protocol))) as Record<string, unknown>;
  const res = await preregister({ ...scope(), runId, suites: [], config, repoRoot });
  commitFixture(repoRoot, { [res.filePath]: readFileSync(res.absFilePath, 'utf8'), [CORPUS_REF]: corpus, [MEMORY_REF]: memory });
  const admitted = await requireCommittedPreregistration(runId, { preregHash: res.preregHash, config }, { ...scope(), repoRoot });
  expect(admitted.preregHash).toBe(res.preregHash);
  const frozen = currentBenchmarkProtocolSchema.parse(config);
  return { repoRoot, runId, preregHash: res.preregHash, context: frozen.context, corpus, memory };
}

function armInput(study: Study, armId: string) {
  const checkout = realpathSync(mkdtempSync(path.join(tmpdir(), `bench-context-${armId}-`)));
  return { context: study.context, checkout, snapshotRoot: study.repoRoot,
    binding: { workspaceId: WS, runId: study.runId, preregHash: study.preregHash,
      assignmentId: `bench-assignment:${study.runId}:${armId}:t1:1`, harnessSlug: `bench-${armId}` } };
}

const snapshot = (entries: Array<{ key: string; text: string }>) => JSON.stringify({ schemaVersion: 1, entries });

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `bench_context_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Same shape as prereg.integration.test.ts (migration 291: PK prereg_hash + UNIQUE(workspace_id, run_id)).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.benchmark_prereg (
      prereg_hash text NOT NULL PRIMARY KEY, run_id text NOT NULL, workspace_id text NOT NULL,
      label text, suites jsonb NOT NULL DEFAULT '[]'::jsonb, config jsonb NOT NULL, file_path text NOT NULL,
      git_committed boolean NOT NULL DEFAULT false, git_commit_sha text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, run_id)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.benchmark_run_result (
      run_id text NOT NULL, workspace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('matched arms restore one committed initial context (PG prereg + git + physical restore)', () => {
  it('gives both matched arms the byte-identical committed corpus and memory and refuses any inherited extra', async () => {
    const study = await committedStudy('CTX-EQUAL',
      snapshot([{ key: 'doc:readme', text: 'permitted corpus fact' }]),
      snapshot([{ key: 'memory:style', text: 'permitted memory fact' }]));
    const [a, b] = ['papercusp', 'baseline'].map((arm) => armInput(study, arm));
    const ra = restoreBenchmarkContext(a);
    const rb = restoreBenchmarkContext(b);
    for (const receipt of [ra, rb]) {
      expect(receipt.corpusHash).toBe(sha256(study.corpus));
      expect(receipt.memoryHash).toBe(sha256(study.memory));
      expect(readFileSync(receipt.corpusPath, 'utf8')).toBe(
        execFileSync('git', ['show', `HEAD:${CORPUS_REF}`], { cwd: study.repoRoot, encoding: 'utf8' }));
      expect(readFileSync(receipt.memoryPath, 'utf8')).toBe(
        execFileSync('git', ['show', `HEAD:${MEMORY_REF}`], { cwd: study.repoRoot, encoding: 'utf8' }));
    }
    expect(rb.contextText).toBe(ra.contextText);
    expect(rb.contextTextSha256).toBe(ra.contextTextSha256);
    expect(rb.receiptRef).not.toBe(ra.receiptRef); // distinct assignments, same permitted content
    expect(readRestoredBenchmarkContext(b).contextText).toBe(ra.contextText);

    // One arm cannot begin with more memory or corpus than its matched arm.
    writeFileSync(path.join(b.checkout, '.papercusp/benchmark-context/inherited.json'), snapshot([{ key: 'memory:extra', text: 'x' }]));
    expect(() => readRestoredBenchmarkContext(b)).toThrow(/unexpected assignment files/);
    writeFileSync(path.join(a.checkout, '.papercusp/benchmark-context/memory.json'),
      snapshot([{ key: 'memory:style', text: 'permitted memory fact' }, { key: 'memory:extra', text: 'x' }]));
    expect(() => readRestoredBenchmarkContext(a)).toThrow(/differ from the frozen protocol/);
    // A reused assignment checkout is refused rather than silently re-seeded.
    expect(() => restoreBenchmarkContext(a)).toThrow();
  });
});

describe('generation context excludes other-arm solutions and hidden grader answers', () => {
  it('keeps a previous arm output and hidden grader content out of the next arm context and checkout', async () => {
    const study = await committedStudy('CTX-ISOLATION',
      snapshot([{ key: 'doc:readme', text: 'permitted corpus fact' }]),
      snapshot([{ key: 'memory:style', text: 'permitted memory fact' }]));
    const SENT_ARM = `SENTINEL-OTHER-ARM-${randomBytes(6).toString('hex')}`;
    const SENT_GRADER = `SENTINEL-HIDDEN-GRADER-${randomBytes(6).toString('hex')}`;
    const first = armInput(study, 'papercusp');
    restoreBenchmarkContext(first);
    // The first arm produces a solution; hidden grading answers sit beside the frozen snapshots.
    writeFileSync(path.join(first.checkout, 'solution.patch'), `diff --git a/x b/x\n+${SENT_ARM}\n`);
    mkdirSync(path.join(study.repoRoot, 'bench/grader'), { recursive: true });
    writeFileSync(path.join(study.repoRoot, 'bench/grader/hidden-answers.json'), JSON.stringify({ t1: SENT_GRADER }));

    const second = armInput(study, 'baseline');
    const receipt = restoreBenchmarkContext(second);
    expect(receipt.contextText).not.toContain(SENT_ARM);
    expect(receipt.contextText).not.toContain(SENT_GRADER);
    for (const file of filesUnder(second.checkout)) {
      const bytes = readFileSync(file, 'utf8');
      expect(bytes, file).not.toContain(SENT_ARM);
      expect(bytes, file).not.toContain(SENT_GRADER);
    }
    expect(filesUnder(second.checkout).map((f) => path.relative(second.checkout, f)).sort()).toEqual([
      '.papercusp/benchmark-context/corpus.json', '.papercusp/benchmark-context/memory.json', '.papercusp/benchmark-context/receipt.json']);
  });

  it.each([
    ['other-arm-solutions', 'other-arm-solutions:papercusp'],
    ['hidden-grader-answers', 'hidden-grader-answers:t1'],
  ])('refuses a committed snapshot carrying %s before writing into the checkout', async (source, key) => {
    const sentinel = `SENTINEL-${source}-${randomBytes(6).toString('hex')}`;
    const study = await committedStudy(`CTX-FORBIDDEN-${source}`,
      snapshot([{ key: 'doc:readme', text: 'permitted corpus fact' }, { key, text: sentinel }]),
      snapshot([{ key: 'memory:style', text: 'permitted memory fact' }]));
    const arm = armInput(study, 'baseline');
    expect(() => restoreBenchmarkContext(arm)).toThrow(/forbidden source/);
    expect(existsSync(path.join(arm.checkout, '.papercusp/benchmark-context'))).toBe(false);
    for (const file of filesUnder(arm.checkout)) expect(readFileSync(file, 'utf8')).not.toContain(sentinel);
  });
});
