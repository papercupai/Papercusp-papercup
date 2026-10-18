/**
 * testing:record-run — register an already-executed non-Vitest check in the
 * canonical test_runs execution ledger.
 *
 * This is deliberately a recorder, not a shell runner. The evidence must be a
 * committed docs/evidence JSON artifact whose bytes describe the command,
 * timestamps, exit code, and individual assertions. The server derives the
 * verdict from those bytes, pins their SHA-256 and HEAD commit, and returns the
 * exact numeric row IDs that plans:bind-spec-evidence accepts. An archivedMutation
 * artifact can recover failed case identities from a committed raw mutation log
 * after validating it against the original scoped receipt. Recovery appends a
 * labelled row and preserves the original execution; it does not run a new test.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  parseTestRunExecutionDetails,
  isRecordedCaseTitle,
  MAX_RECORDED_PASSED_CASES,
  type RecordedRuntimeEnvironment,
  stableRecordedRuntimeEnvironment,
} from '@papercusp/test-config/execution-details';
import { listRuntimeVintage, measureRuntimeVintageEnvironment } from '../../runtime-vintage';
import { captureWorktreeSnapshotAsync, computeWorktreeDirty, type WorktreeGitSnapshot } from '../../testing-worktree';
import { runGit } from '../../harness/docs/git-runner';
import {
  findHarnessTestRunIds,
  persistHarnessTestRunsWithIds,
  type HarnessTestFileRow,
  type PersistHarnessTestRunsParams,
  type PersistHarnessTestRunsResult,
} from '../../testing-run-store';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { harnessArg, harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_OPERATIONAL_EVIDENCE_BYTES = 256 * 1024;

const mutationProbeReplaySchema = z.object({
  schemaVersion: z.literal(1),
  runnerPath: z.literal('scripts/mutation-probe.sh'),
  runnerSha256: sha256Schema,
  runnerCommit: z.string().regex(/^[a-f0-9]{40}$/),
  cwd: z.string().trim().min(1).max(400),
  argv: z.array(z.string().min(1).max(10_000)).min(2).max(50),
  result: z.object({
    verdict: z.enum(['caught', 'survived', 'harness-error', 'inconclusive']),
    expected: z.enum(['caught', 'survived']),
    target: z.string().trim().min(1).max(100),
    baselineExit: z.number().int(),
    guardExit: z.number().int(),
    mutantParse: z.string().trim().min(1).max(100),
    assertionEvidence: z.string().trim().min(1).max(300),
    relocation: z.string().trim().min(1).max(100),
  }),
});

const operationalEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('operational-test-evidence'),
    name: z.string().trim().min(1).max(300),
    framework: z.enum(['playwright', 'node', 'shell', 'cargo', 'operational']),
    command: z.array(z.string().min(1).max(1000)).min(1).max(50),
    exitCode: z.number().int(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    summary: z.string().trim().min(1).max(3000),
    assertions: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(200),
          passed: z.boolean(),
          evidence: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(100),
    mutationProbes: z.array(mutationProbeReplaySchema).min(1).max(100).optional(),
    archivedMutation: z.object({
      originalTestRunId: z.number().int().positive(),
      rawLogFile: z.string().min(1).max(400),
      rawLogSha256: sha256Schema,
      // Preserve raw proof in Git when the published working copy is redacted.
      rawLogCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    }).optional(),
  })
  .passthrough();

export type OperationalEvidenceArtifact = z.infer<typeof operationalEvidenceArtifactSchema>;

export interface CommittedOperationalEvidence {
  artifact: OperationalEvidenceArtifact;
  filePath: string;
  sha256: string;
  commit: string;
  /** Exact bytes from HEAD or rawLogCommit, never the redacted publication. */
  archiveLog?: string;
}

export interface ArchivedMutationRun {
  id: number | string;
  file_path: string;
  status: string;
  source: string;
  framework: string;
  workspace_id: string | null;
  harness_slug: string | null;
  commit_sha: string | null;
  worktree_dirty: boolean;
  started_at: string | Date;
  finished_at: string | Date | null;
  execution_details: unknown;
}

type RecordContext = {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  projectDir?: string;
};

export interface RecordOperationalRunDeps {
  inspectEvidence: (
    root: string,
    filePath: string,
    expectedSha256: string,
  ) => CommittedOperationalEvidence | Promise<CommittedOperationalEvidence>;
  findIds: typeof findHarnessTestRunIds;
  persist: (params: PersistHarnessTestRunsParams) => Promise<PersistHarnessTestRunsResult>;
  readArchivedRun?: (id: number, scope: { workspaceId: string; harnessSlug: string }) => Promise<ArchivedMutationRun | null>;
  verifyOriginalEvidence?: (original: ArchivedMutationRun, evidence: CommittedOperationalEvidence, root: string) => Promise<boolean>;
}

const DEFAULT_DEPS: RecordOperationalRunDeps = {
  inspectEvidence: inspectCommittedOperationalEvidence,
  findIds: findHarnessTestRunIds,
  persist: persistHarnessTestRunsWithIds,
  async readArchivedRun(id, scope) {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT id, file_path, status, source, framework, workspace_id, harness_slug,
             commit_sha, worktree_dirty, started_at, finished_at, execution_details
        FROM harness_shared.test_runs
       WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}`;
    return (rows[0] as unknown as ArchivedMutationRun | undefined) ?? null;
  },
  verifyOriginalEvidence: verifyOriginalOperationalEvidence,
};

export async function verifyOriginalOperationalEvidence(
  original: ArchivedMutationRun, evidence: CommittedOperationalEvidence, root: string,
): Promise<boolean> {
  if (!original.commit_sha || !/^[a-f0-9]{40}$/.test(original.commit_sha)) return false;
  try {
    const bytes = await gitOutput(root, ['show', `${original.commit_sha}:${evidence.filePath}`]);
    return createHash('sha256').update(bytes).digest('hex') === evidence.sha256;
  } catch {
    return false;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function gitOutput(root: string, args: string[]): Promise<Buffer> {
  const result = await runGit(args, root);
  if (result.code !== 0) throw new Error('git_command_failed');
  return Buffer.from(result.stdout, 'utf8');
}

export function parseOperationalEvidenceArtifact(bytes: Buffer): OperationalEvidenceArtifact {
  if (bytes.byteLength > MAX_OPERATIONAL_EVIDENCE_BYTES) {
    throw new Error(
      `evidence_too_large: ${bytes.byteLength} bytes exceeds the ${MAX_OPERATIONAL_EVIDENCE_BYTES}-byte limit. ` +
        'Store bulky payloads as a raw artifact pinned by SHA-256 and keep the docs/evidence JSON small.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('evidence_invalid_json');
  }
  const result = operationalEvidenceArtifactSchema.safeParse(parsed);
  if (!result.success) {
    // Name every failing field: a bare "expected string, received undefined"
    // gives an artifact author nothing to fix (WI-10003460).
    const issues = result.error.issues.slice(0, 5).map((issue) =>
      `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
    const more = result.error.issues.length > 5 ? ` (+${result.error.issues.length - 5} more)` : '';
    throw new Error(`evidence_schema_invalid: ${issues.join('; ') || 'invalid'}${more}`);
  }
  const artifact = result.data;
  if (artifact.archivedMutation && !artifact.mutationProbes?.length) {
    throw new Error('evidence_archived_mutation_probe_required');
  }
  // Classify by the RUNNER's own signatures, not the phrase "mutation probe" (EI-25254538716868224):
  // an artifact is scripts/mutation-probe.sh evidence when its command invokes that script, or its
  // summary/assertions quote what that script emits — a `MUTATION_PROBE_<FIELD>` record (e.g.
  // MUTATION_PROBE_RESULT, MUTATION_PROBE_EVIDENCE_JSON) or the script path. A bare substring match
  // also caught a git branch named `mutation-probe/<x>` and a CI job's own `MUTATION_PROBE unit=…`
  // label, demanding a mutation-probe.sh replay record that a mutant built and run elsewhere (e.g. a
  // macOS-CI Swift mutant) cannot have.
  const invokesRunner = (value: string) => /(?:^|[\s/'"=])mutation-probe\.sh\b/i.test(value);
  const runnerOutput = `${artifact.summary}\n${artifact.assertions.map((assertion) => assertion.evidence).join('\n')}`;
  const mutationProbeEvidence =
    artifact.mutationProbes !== undefined ||
    artifact.command.some(invokesRunner) ||
    invokesRunner(runnerOutput) ||
    /\bMUTATION_PROBE_[A-Z]/.test(runnerOutput);
  if (mutationProbeEvidence) {
    const referencesSharedScratch = (value: string) =>
      value.replace(/\\/g, '/').toLowerCase().includes('.papercusp/scratch');
    if (artifact.command.some(referencesSharedScratch)) {
      throw new Error('evidence_mutation_probe_scratch_command_invalid');
    }
    if (!artifact.mutationProbes?.length) {
      throw new Error('evidence_mutation_probe_replay_required');
    }
    for (const [index, probe] of artifact.mutationProbes.entries()) {
      if (
        probe.runnerPath.startsWith('/') ||
        probe.runnerPath.split('/').includes('..') ||
        probe.cwd.startsWith('/') ||
        probe.cwd.split('/').includes('..') ||
        probe.runnerPath.replace(/\\/g, '/').toLowerCase().includes('.papercusp/scratch') ||
        probe.argv.some(referencesSharedScratch)
      ) {
        throw new Error(`evidence_mutation_probe_replay_not_immutable: mutationProbes.${index}`);
      }
      const file = probe.argv.indexOf('--file');
      const test = probe.argv.indexOf('--test');
      const hasHistoricalSelector =
        probe.argv.includes('--against-commit') || probe.argv.includes('--against-last-without');
      const mutation = probe.argv.indexOf('--mutate');
      if (
        file < 0 || !probe.argv[file + 1] ||
        test < 0 || !probe.argv[test + 1] ||
        (!hasHistoricalSelector && (mutation < 0 || !probe.argv[mutation + 1]))
      ) {
        throw new Error(`evidence_mutation_probe_replay_incomplete: mutationProbes.${index}.argv`);
      }
    }
  }
  const startedAt = Date.parse(result.data.startedAt);
  const finishedAt = Date.parse(result.data.finishedAt);
  if (finishedAt < startedAt) throw new Error('evidence_time_order_invalid');
  return artifact;
}

/** Validate that the artifact bytes are exactly those stored at the caller tree's HEAD. */
export async function inspectCommittedOperationalEvidence(
  root: string,
  filePath: string,
  expectedSha256: string,
): Promise<CommittedOperationalEvidence> {
  const normalized = filePath.replace(/\\/g, '/');
  if (
    isAbsolute(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    !normalized.startsWith('docs/evidence/') ||
    !normalized.endsWith('.json')
  ) {
    throw new Error('evidence_path_invalid');
  }
  const realRoot = realpathSync(root);
  const absolute = realpathSync(resolve(realRoot, normalized));
  if (!insideRoot(realRoot, absolute) || !statSync(absolute).isFile()) throw new Error('evidence_path_invalid');

  const bytes = readFileSync(absolute);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('evidence_sha256_mismatch');
  const headBytes = await gitOutput(realRoot, ['show', `HEAD:${normalized}`]);
  if (!headBytes.equals(bytes)) throw new Error('evidence_not_committed');
  const commit = (await gitOutput(realRoot, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('evidence_commit_unreadable');

  const artifact = parseOperationalEvidenceArtifact(bytes);
  for (const [index, probe] of (artifact.mutationProbes ?? []).entries()) {
    let runnerSourceAvailable = false;
    let runnerSourceFound = false;
    for (const sourceCommit of [probe.runnerCommit, commit]) {
      try {
        const runnerBytes = await gitOutput(realRoot, ['show', `${sourceCommit}:${probe.runnerPath}`]);
        runnerSourceAvailable = true;
        if (createHash('sha256').update(runnerBytes).digest('hex') === probe.runnerSha256) {
          runnerSourceFound = true;
          break;
        }
      } catch {
        // The runner may have been dirty when it ran and committed with the
        // evidence artifact; in that case the artifact commit is its first
        // immutable source.
      }
    }
    if (!runnerSourceAvailable) {
      throw new Error(`evidence_mutation_probe_runner_unavailable: mutationProbes.${index}`);
    }
    if (!runnerSourceFound) {
      throw new Error(`evidence_mutation_probe_runner_sha256_mismatch: mutationProbes.${index}`);
    }
  }

  let archiveLog: string | undefined;
  if (artifact.archivedMutation) {
    const archive = artifact.archivedMutation;
    const path = archive.rawLogFile;
    if (!path.startsWith('docs/evidence/') || !path.endsWith('.log') || path.includes('\\')
      || path.split('/').includes('..') || path.includes('\0')) throw new Error('evidence_archive_path_invalid');
    let logBytes: Buffer;
    if (archive.rawLogCommit) {
      const object = `${archive.rawLogCommit}:${path}`;
      let size: number;
      try {
        size = Number((await gitOutput(realRoot, ['cat-file', '-s', object])).toString('utf8').trim());
      } catch {
        throw new Error('evidence_archive_commit_unavailable');
      }
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('evidence_archive_commit_unavailable');
      if (size > 2 * 1024 * 1024) throw new Error('evidence_archive_too_large');
      logBytes = await gitOutput(realRoot, ['show', object]);
    } else {
      const absoluteLog = realpathSync(resolve(realRoot, path));
      if (!insideRoot(realRoot, absoluteLog) || !statSync(absoluteLog).isFile()) throw new Error('evidence_archive_path_invalid');
      if (statSync(absoluteLog).size > 2 * 1024 * 1024) throw new Error('evidence_archive_too_large');
      logBytes = readFileSync(absoluteLog);
    }
    if (createHash('sha256').update(logBytes).digest('hex') !== archive.rawLogSha256) {
      throw new Error('evidence_archive_sha256_mismatch');
    }
    if (!archive.rawLogCommit && !(await gitOutput(realRoot, ['show', `HEAD:${path}`])).equals(logBytes)) {
      throw new Error('evidence_archive_not_committed');
    }
    archiveLog = logBytes.toString('utf8');
  }
  return {
    artifact,
    filePath: normalized,
    sha256,
    commit,
    ...(archiveLog === undefined ? {} : { archiveLog }),
  };
}

/** Validate a saved machine log against an exact scoped receipt. No historical row is updated. */
export function recoverArchivedMutationFailures(
  evidence: CommittedOperationalEvidence,
  original: ArchivedMutationRun | null,
  scope: { workspaceId: string; harnessSlug: string },
) {
  const archive = evidence.artifact.archivedMutation;
  const detail = parseTestRunExecutionDetails(original?.execution_details);
  if (!archive || !evidence.archiveLog || !original || !detail
    || Number(original.id) !== archive.originalTestRunId
    || original.workspace_id !== scope.workspaceId || original.harness_slug !== scope.harnessSlug
    || detail.workspaceId !== scope.workspaceId || detail.harnessSlug !== scope.harnessSlug
    || original.source !== 'mutation-probe' || original.status !== 'fail' || original.framework !== 'vitest'
    || original.worktree_dirty !== false || detail.worktreeDirty !== false
    || detail.collectionFailed !== false || detail.mutationPhase !== 'mutant'
    || detail.failed === 0 || original.commit_sha !== detail.commitSha
    || !original.commit_sha || !/^[a-f0-9]{40}$/.test(original.commit_sha)
    || original.file_path !== detail.filePath) throw new Error('evidence_archive_receipt_mismatch');
  const lines = evidence.archiveLog.split('\n');
  const titles: string[] = [];
  const quoted = '"(?:[^"\\\\]|\\\\.)*"';
  const assertion = new RegExp(`^TEST_FILE_ASSERTION_FAILURE file=(${quoted}) name=(${quoted}) message=`);
  for (const line of lines.filter(line => line.startsWith('TEST_FILE_ASSERTION_FAILURE '))) {
    const match = assertion.exec(line);
    if (!match) throw new Error('evidence_archive_assertion_invalid');
    const file: unknown = JSON.parse(match[1]);
    const title: unknown = JSON.parse(match[2]);
    if (file !== resolve(detail.root, detail.filePath) || !isRecordedCaseTitle(title)) {
      throw new Error('evidence_archive_assertion_mismatch');
    }
    titles.push(title);
  }
  if (titles.length !== detail.failed || new Set(titles).size !== titles.length
    || !parseTestRunExecutionDetails({ ...detail, failedCaseTitles: titles })
    || (detail.failedCaseTitles !== undefined && JSON.stringify(detail.failedCaseTitles) !== JSON.stringify(titles))) {
    throw new Error('evidence_archive_failed_cases_mismatch');
  }
  const probes = lines.filter(line => line.startsWith('MUTATION_PROBE_EVIDENCE_JSON='));
  if (probes.length !== 1 || evidence.artifact.mutationProbes?.length !== 1) throw new Error('evidence_archive_probe_mismatch');
  const probe = mutationProbeReplaySchema.parse(JSON.parse(probes[0].slice('MUTATION_PROBE_EVIDENCE_JSON='.length)));
  if (JSON.stringify(probe) !== JSON.stringify(evidence.artifact.mutationProbes[0])
    || probe.runnerCommit !== original.commit_sha || probe.result.verdict !== 'caught'
    || probe.result.expected !== 'caught' || probe.result.guardExit === 0 || probe.result.baselineExit !== 0
    || probe.result.assertionEvidence !== 'test-file-assertion-failure') throw new Error('evidence_archive_probe_mismatch');
  const marker = lines.filter(line => line.startsWith('TEST_FILE_RESULT ')).at(-1) ?? '';
  if (!marker.includes('requested=1 executed=1 matched=1 status=failed ')
    || !marker.includes(`head=${original.commit_sha.slice(0, 10)} `)
    || !marker.includes('uncommittedPaths=0/1 provenance=stamped ')
    || !marker.endsWith(`skippedTests=${detail.skipped}`)) throw new Error('evidence_archive_verdict_mismatch');
  const summary = lines.filter(line => /^\s*Tests\s/.test(line)).at(-1) ?? '';
  const count = (status: string) => Number(new RegExp(`(\\d+) ${status}`).exec(summary)?.[1] ?? 0);
  if (count('failed') !== detail.failed || count('passed') !== detail.passed || count('skipped') !== detail.skipped) {
    throw new Error('evidence_archive_counts_mismatch');
  }
  const stamps = lines.filter(line => line.startsWith('TEST_FILE_PROVENANCE ')).slice(-2);
  const pre = /phase=pre-run startedAt=(\S+)/.exec(stamps[0] ?? '');
  const post = /phase=post-run startedAt=(\S+)/.exec(stamps[1] ?? '');
  const startedAt = new Date(original.started_at);
  const finishedAt = new Date(original.finished_at ?? NaN);
  if (!pre || !post || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(finishedAt.getTime())
    || !(Date.parse(pre[1]) <= startedAt.getTime() && startedAt.getTime() <= finishedAt.getTime()
      && finishedAt.getTime() <= Date.parse(post[1]))) throw new Error('evidence_archive_time_mismatch');
  return { detail, titles, startedAt, finishedAt };
}

/**
 * The execution contract for an operational artifact, derived ONLY from the committed,
 * sha-verified bytes: each assertion is one executed case. A nonzero exit that no failing
 * assertion explains is one more failed case, so a `fail` verdict never carries failed=0.
 * testLayer is deliberately omitted: it is a runtime fact stamped by a runner, and an
 * operational check has no recorded layer.
 */
export function operationalExecution(artifact: OperationalEvidenceArtifact) {
  const failing = artifact.assertions.filter((assertion) => !assertion.passed);
  const unexplainedExit = artifact.exitCode !== 0 && failing.length === 0;
  const titles = [...new Set([
    ...failing.map((assertion) => assertion.id),
    ...(unexplainedExit ? [`nonzero-exit-${artifact.exitCode}`] : []),
  ])].filter((title) => isRecordedCaseTitle(title));
  const failedTitles = new Set(titles);
  const allPassedTitles = [...new Set(
    artifact.assertions.filter((assertion) => assertion.passed).map((assertion) => assertion.id),
  )].filter((title) => isRecordedCaseTitle(title) && !failedTitles.has(title));
  const passedTitles = allPassedTitles.slice(0, MAX_RECORDED_PASSED_CASES);
  const passedCaseTitlesTruncated = allPassedTitles.length > passedTitles.length;
  return {
    operational: { schemaVersion: 1 as const, command: [...artifact.command] },
    passed: artifact.assertions.length - failing.length,
    failed: failing.length + (unexplainedExit ? 1 : 0),
    skipped: 0,
    collectionFailed: false,
    runStartedAt: artifact.startedAt,
    ...(titles.length > 0 ? { failedCaseTitles: titles } : {}),
    ...(passedTitles.length > 0 ? { passedCaseTitles: passedTitles } : {}),
    ...(passedCaseTitlesTruncated ? { passedCaseTitlesTruncated: true as const } : {}),
  };
}

function derivedVerdict(artifact: OperationalEvidenceArtifact): 'pass' | 'fail' {
  return artifact.exitCode === 0 && artifact.assertions.every((assertion) => assertion.passed) ? 'pass' : 'fail';
}

export async function verifyOperationalCheckDefinitionAtCommit(
  root: string,
  filePath: string,
  commit: string | null,
): Promise<boolean> {
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) return false;
  try {
    const type = await gitOutput(root, ['cat-file', '-t', `${commit}:${filePath}`]);
    return type.toString('utf8').trim() === 'blob';
  } catch {
    return false;
  }
}

/**
 * Native operational producers execute here rather than importing fingerprints
 * from an artifact. Reuse the recorder's assertion contract and canonical ledger;
 * timing, source snapshots and runtime observations belong to this executor.
 * Missing or changing runtime witnesses remain unproven in the normal binder.
 * This function does not recover or restamp an already executed check.
 */
export async function executeOperationalRun(
  definition: {
    /** Committed check definition or expected-data fixture, never a future output artifact. */
    filePath: string;
    name: string;
    command: string[];
    framework: OperationalEvidenceArtifact['framework'];
    /** Empty for source-only checks; no runtime witness is claimed in that case. */
    runtimeUnits: string[];
    run: () => Promise<Pick<OperationalEvidenceArtifact, 'exitCode' | 'summary' | 'assertions'>>;
  },
  ctx: RecordContext,
  deps: {
    snapshot: (root: string) => WorktreeGitSnapshot | Promise<WorktreeGitSnapshot>;
    readRuntime: (units: string[], workspaceId: string) => Promise<string | null>;
    persist: RecordOperationalRunDeps['persist'];
    verifyDefinition?: typeof verifyOperationalCheckDefinitionAtCommit;
  } = {
    snapshot: captureWorktreeSnapshotAsync,
    readRuntime: async (units, workspaceId) =>
      measureRuntimeVintageEnvironment(await listRuntimeVintage(workspaceId), units),
    persist: persistHarnessTestRunsWithIds,
  },
) {
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return { ok: false, error: 'workspace_required' as const };
  const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
  if (!harnessSlug) return { ok: false, error: 'harness_required' as const };
  const units = [...definition.runtimeUnits];
  // Pin the arguments before execution: a callback cannot replace the install/window it checked.
  const command = [...definition.command];
  if (units.length > 32 || new Set(units).size !== units.length
    || units.some(unit => !unit || unit.trim() !== unit || unit.length > 120)) {
    return { ok: false, error: 'invalid_runtime_units' as const };
  }
  const root = resolveAgentWorkspaceRoot(ctx);
  const path = relative(root, resolve(root, definition.filePath));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return { ok: false, error: 'invalid_check_path' as const };
  }
  const observe = async (): Promise<RecordedRuntimeEnvironment | undefined> => {
    if (units.length === 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fingerprint = await Promise.race([
        Promise.resolve().then(() => deps.readRuntime([...units], workspaceId)),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000); }),
      ]);
      return typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint)
        ? { schemaVersion: 1, units: [...units], fingerprint, observedAt: new Date().toISOString() }
        : undefined;
    } catch { return undefined; }
    finally { if (timer) clearTimeout(timer); }
  };
  const before = await deps.snapshot(root);
  // A clean tree does not prove that the cited check exists in that tree. An
  // output artifact created after execution cannot be inspected at this source
  // commit, even when every assertion and runtime witness is otherwise valid.
  const definitionAvailable = await (deps.verifyDefinition ?? verifyOperationalCheckDefinitionAtCommit)(
    root, path.split(sep).join('/'), before.commit,
  ).catch(() => false);
  if (!definitionAvailable) {
    return { ok: false, error: 'operational_check_definition_unavailable' as const,
      filePath: path.split(sep).join('/'), commit: before.commit };
  }
  const runtimeEnvironmentBefore = await observe();
  const startedAt = new Date();
  let result: Pick<OperationalEvidenceArtifact, 'exitCode' | 'summary' | 'assertions'>;
  try { result = await definition.run(); }
  catch (error) {
    const message = String(error instanceof Error ? error.message : error).trim() || 'Unknown exception';
    // CLI errors often begin with connection/startup traces and end with the
    // actual refusal. Keep both ends rather than discarding that semantic tail.
    const omission = `\n[exception truncated: ${message.length} characters]\n`;
    const evidence = message.length <= 2000 ? message
      : message.slice(0, 600) + omission + message.slice(-(2000 - 600 - omission.length));
    result = { exitCode: 1, summary: 'Native operational check threw.', assertions: [{
      id: 'native-check-exception', passed: false,
      evidence,
    }] };
  }
  const finishedAt = new Date();
  const runtimeEnvironmentAfter = await observe();
  const after = await deps.snapshot(root);
  // Explicit fields prevent a callback from smuggling timestamps, layer or pins.
  const artifact = operationalEvidenceArtifactSchema.parse({
    schemaVersion: 1, kind: 'operational-test-evidence', name: definition.name,
    framework: definition.framework, command,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    exitCode: result.exitCode, summary: result.summary, assertions: result.assertions,
  });
  const runGroupId = `operational-native:${randomUUID()}`;
  const execution = {
    ...operationalExecution(artifact),
    ...(runtimeEnvironmentBefore ? { runtimeEnvironmentBefore } : {}),
    ...(runtimeEnvironmentAfter ? { runtimeEnvironmentAfter } : {}),
  };
  const persisted = await deps.persist({
    workspaceId, harnessSlug, root, runGroupId, source: 'local',
    commit: after.commit, worktreeDirty: computeWorktreeDirty(before, after),
    rows: [{ filePath: path.split(sep).join('/'), framework: artifact.framework,
      status: derivedVerdict(artifact), startedAt, finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outputTail: operationalOutputTail(artifact), execution }],
  });
  if (persisted.written !== 1 || persisted.ids.length !== 1) {
    return { ok: false, error: 'ledger_write_failed' as const, runGroupId };
  }
  return { ok: true, runGroupId, testRunIds: persisted.ids, status: derivedVerdict(artifact),
    runtimeEnvironmentMeasured: Boolean(stableRecordedRuntimeEnvironment(runtimeEnvironmentBefore, runtimeEnvironmentAfter)) };
}

function operationalOutputTail(artifact: OperationalEvidenceArtifact, sha256?: string): string {
  const passed = artifact.assertions.filter((assertion) => assertion.passed).length;
  return [
    artifact.summary,
    ...(sha256 ? [`artifact_sha256=${sha256}`] : []),
    `exit_code=${artifact.exitCode}`,
    `assertions=${passed}/${artifact.assertions.length}`,
    ...artifact.assertions.filter((assertion) => !assertion.passed)
      .map((assertion) => `${assertion.id}: ${assertion.evidence}`),
  ]
    .join('\n')
    .slice(-4000);
}

function outputTail(evidence: CommittedOperationalEvidence): string {
  return operationalOutputTail(evidence.artifact, evidence.sha256);
}

export async function recordOperationalRun(
  args: { evidenceFile: string; expectedSha256: string; harness?: string },
  ctx: RecordContext,
  deps: RecordOperationalRunDeps = DEFAULT_DEPS,
) {
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, error: 'workspace_required' as const };
  }
  const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
  if (!harnessSlug) return { ok: false, error: 'harness_required' as const };

  let evidence: CommittedOperationalEvidence;
  try {
    evidence = await deps.inspectEvidence(resolveAgentWorkspaceRoot(ctx), args.evidenceFile, args.expectedSha256);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'evidence_unreadable' };
  }

  if (evidence.artifact.archivedMutation) {
    const archive = evidence.artifact.archivedMutation;
    try {
      const original = await deps.readArchivedRun?.(archive.originalTestRunId, { workspaceId, harnessSlug }) ?? null;
      const recovered = recoverArchivedMutationFailures(evidence, original, { workspaceId, harnessSlug });
      const runGroupId = `archive-mutation:${archive.originalTestRunId}:${evidence.sha256.slice(0, 40)}`;
      const existing = await deps.findIds({ workspaceId, harnessSlug, runGroupId, filePath: original!.file_path });
      if (existing.length > 0) return { ok: true, alreadyRecorded: true, runGroupId, testRunIds: existing,
        status: 'fail' as const, recoveredFromTestRunId: archive.originalTestRunId,
        evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit } };
      const { root, testNamePattern, mutationPhase, passed, failed, skipped, collectionFailed,
        testLayer, runStartedAt } = recovered.detail;
      const execution = { passed, failed, skipped, collectionFailed,
        ...(testLayer === undefined ? {} : { testLayer }),
        ...(runStartedAt === undefined ? {} : { runStartedAt }) };
      const persisted = await deps.persist({ workspaceId, harnessSlug, runGroupId, root, testNamePattern, mutationPhase,
        source: 'mutation-probe', commit: original!.commit_sha, worktreeDirty: false,
        rows: [{ filePath: original!.file_path, framework: 'vitest', status: 'fail',
          startedAt: recovered.startedAt, finishedAt: recovered.finishedAt,
          durationMs: recovered.finishedAt.getTime() - recovered.startedAt.getTime(),
          outputTail: `ARCHIVED MUTATION: original_test_run_id=${archive.originalTestRunId}; artifact=${evidence.filePath}; artifact_sha256=${evidence.sha256}; raw_log_sha256=${archive.rawLogSha256}. No new test execution.`,
          execution: { ...execution, failedCaseTitles: recovered.titles } }],
      });
      if (persisted.written !== 1 || persisted.ids.length !== 1) return { ok: false, error: 'ledger_write_failed' as const, runGroupId };
      return { ok: true, alreadyRecorded: false, runGroupId, testRunIds: persisted.ids, status: 'fail' as const,
        recoveredFromTestRunId: archive.originalTestRunId,
        evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'evidence_archive_unreadable' };
    }
  }

  let runGroupId = `operational:${evidence.sha256.slice(0, 40)}`;
  const identity = { workspaceId, harnessSlug, runGroupId, filePath: evidence.filePath };
  const existing = await deps.findIds(identity);
  let recoveredFromTestRunId: number | undefined;
  let recordedCommit = evidence.commit;
  if (existing.length > 0) {
    // WI-10007016 repaired new recordings. Older receipts must not keep returning
    // NULL execution forever. Append a labelled recovery from the same committed
    // artifact, preserving the original receipt, timestamps, verdict and commit.
    if (existing.length !== 1) return { ok: false, error: 'evidence_operational_receipt_ambiguous' as const };
    const original = await deps.readArchivedRun?.(existing[0]!, { workspaceId, harnessSlug });
    if (!original) return { ok: false, error: 'evidence_operational_receipt_unavailable' as const };
    if (parseTestRunExecutionDetails(original.execution_details)) {
      return { ok: true, alreadyRecorded: true, runGroupId, testRunIds: existing,
        evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit },
        status: derivedVerdict(evidence.artifact) };
    }
    if (original.execution_details !== null || Number(original.id) !== existing[0]
      || original.workspace_id !== workspaceId || original.harness_slug !== harnessSlug
      || original.file_path !== evidence.filePath || original.source !== 'local'
      || original.framework !== evidence.artifact.framework || original.worktree_dirty
      || original.status !== derivedVerdict(evidence.artifact) || !original.commit_sha
      || new Date(original.started_at).getTime() !== Date.parse(evidence.artifact.startedAt)
      || original.finished_at === null
      || new Date(original.finished_at).getTime() !== Date.parse(evidence.artifact.finishedAt)
      || !await deps.verifyOriginalEvidence?.(original, evidence, resolveAgentWorkspaceRoot(ctx))) {
      return { ok: false, error: 'evidence_operational_receipt_mismatch' as const };
    }
    recoveredFromTestRunId = existing[0]!;
    recordedCommit = original.commit_sha;
    runGroupId = `operational-recovery:${recoveredFromTestRunId}:${evidence.sha256.slice(0, 40)}`;
    const recovered = await deps.findIds({ ...identity, runGroupId });
    if (recovered.length > 0) {
      const receipt = recovered.length === 1
        ? await deps.readArchivedRun?.(recovered[0]!, { workspaceId, harnessSlug }) : null;
      const execution = parseTestRunExecutionDetails(receipt?.execution_details);
      const expected = operationalExecution(evidence.artifact);
      if (!receipt || receipt.status !== derivedVerdict(evidence.artifact)
        || receipt.commit_sha !== recordedCommit || receipt.file_path !== evidence.filePath
        || receipt.workspace_id !== workspaceId || receipt.harness_slug !== harnessSlug
        || !execution || execution.runGroupId !== runGroupId
        || execution.passed !== expected.passed || execution.failed !== expected.failed
        || execution.skipped !== expected.skipped || execution.collectionFailed !== expected.collectionFailed) {
        return { ok: false, error: 'evidence_operational_recovery_invalid' as const };
      }
      return { ok: true, alreadyRecorded: true, runGroupId, testRunIds: recovered,
        recoveredFromTestRunId, evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: recordedCommit },
        status: derivedVerdict(evidence.artifact) };
    }
  }

  const startedAt = new Date(evidence.artifact.startedAt);
  const finishedAt = new Date(evidence.artifact.finishedAt);
  const row: HarnessTestFileRow = {
    filePath: evidence.filePath,
    framework: evidence.artifact.framework,
    status: derivedVerdict(evidence.artifact),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt,
    finishedAt,
    outputTail: recoveredFromTestRunId === undefined ? outputTail(evidence)
      : `RECOVERED OPERATIONAL: original_test_run_id=${recoveredFromTestRunId}; no new test execution.\n${outputTail(evidence)}`,
    // WI-10007016: without `execution` (and `root` below) the shared writer stores NULL
    // execution_details, so spec-test-adequacy can never verify an operational run.
    execution: operationalExecution(evidence.artifact),
  };
  const persisted = await deps.persist({
    harnessSlug,
    workspaceId,
    rows: [row],
    runGroupId,
    root: resolveAgentWorkspaceRoot(ctx),
    source: 'local',
    commit: recordedCommit,
    // The exact evidence bytes were compared with HEAD above. Unrelated dirty
    // files in the shared tree do not make this committed artifact ambiguous.
    worktreeDirty: false,
  });
  if (persisted.written !== 1 || persisted.ids.length !== 1) {
    return { ok: false, error: 'ledger_write_failed' as const, runGroupId };
  }
  return {
    ok: true,
    alreadyRecorded: false,
    runGroupId,
    testRunIds: persisted.ids,
    ...(recoveredFromTestRunId === undefined ? {} : { recoveredFromTestRunId }),
    status: row.status,
    evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: recordedCommit },
  };
}

/** Reuse the canonical plan reader/parser; an empty or partial census cannot prove closure. */
export async function inspectPlanTerminalCensus(
  row: Pick<import('../plans/source').PlanRow, 'items' | 'content' | 'contentHash' | 'version'> | null,
) {
  const { planItemsForRow } = await import('../plans/source');
  const { resolveEffectiveStatusForItems } = await import('../plans/effective-status');
  const items = row ? resolveEffectiveStatusForItems(planItemsForRow(row)).items : [];
  const unique = new Set(items.map(item => item.id));
  const complete = Boolean(row && items.length > 0 && items.length <= 98 && unique.size === items.length);
  const assertions: OperationalEvidenceArtifact['assertions'] = [{ id: 'plan-terminal-census:population',
    passed: complete, evidence: `version=${row?.version ?? 'missing'} contentHash=${row?.contentHash ?? 'missing'} ` +
      `population=${items.length} unique=${unique.size}; empty, duplicate and oversized populations fail.` }];
  if (complete) for (const item of items) {
    const note = /\s*—\s*note:\s*([\s\S]+)$/.exec(item.text)?.[1].trim();
    const terminal = item.effectiveStatus === 'done' || item.effectiveStatus === 'dropped';
    const reason = item.effectiveStatus !== 'dropped' || Boolean(note);
    assertions.push({ id: `plan-terminal-census:${item.id}`, passed: terminal && reason,
      evidence: (`stored=${item.storedStatus} effective=${item.effectiveStatus}; ` +
        (item.effectiveStatus === 'dropped' ? `drop reason=${note || 'missing'}` : 'requires done or an explicit drop with reason')).slice(0, 2000) });
  }
  const failed = assertions.some(assertion => !assertion.passed);
  return { exitCode: failed ? 1 : 0,
    summary: failed ? 'Plan terminal census failed; inspect per-item assertions.' : 'Every enumerated item is done or explicitly dropped with a reason.',
    assertions };
}

/** Executes the current canonical census, then records its actual assertions and runtime witnesses. */
export async function executePlanTerminalCensus(
  slug: string,
  ctx: RecordContext,
  deps?: {
    readPlan: (slug: string, ctx: RecordContext) => Promise<Parameters<typeof inspectPlanTerminalCensus>[0]>;
    execution: Parameters<typeof executeOperationalRun>[2];
  },
) {
  const readPlan = deps?.readPlan ?? (async (slug: string, ctx: RecordContext) => {
    const { getPlanRow } = await import('../plans/source');
    const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
    if (!harnessSlug) throw new Error('testing:record-run requires a concrete harness scope');
    return getPlanRow(slug, { workspaceId: ctx.workspaceId ?? undefined, harnessSlug });
  });
  const unit = process.env.PAPERCUSP_VINTAGE_UNIT?.trim() ||
    (process.env.PAPERCUSP_DESKTOP === '1' ? 'desktop-sidecar'
      : `hono-host:${process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? '3070'}`);
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/agent-tools/testing/record-run.ts',
    name: `Plan terminal census: ${slug}`, framework: 'operational',
    command: ['testing:record-run', 'planTerminalCensus', slug], runtimeUnits: [unit],
    run: async () => {
      const before = await readPlan(slug, ctx);
      const result = await inspectPlanTerminalCensus(before);
      const after = await readPlan(slug, ctx);
      const unchanged = Boolean(before && after && before.version === after.version &&
        before.contentHash === after.contentHash && JSON.stringify(before.items) === JSON.stringify(after.items));
      const assertions = [...result.assertions, { id: 'plan-terminal-census:unchanged', passed: unchanged,
        evidence: 'Canonical version, content hash and indexed population must remain unchanged across the check.' }];
      return { ...result, assertions, exitCode: result.exitCode || (unchanged ? 0 : 1),
        summary: unchanged ? result.summary : 'Plan changed or became unavailable during the terminal census.' };
    },
  }, ctx, deps?.execution);
}

export default defineTool({
  name: 'testing:record-run',
  description:
    'Live plan terminal check: pass planTerminalCensus:{slug} instead of evidenceFile/expectedSha256; it reads the canonical population, rejects unexplained drops/changes, and records operational evidence. ' +
    'Register completed non-Vitest runs in test_runs; bind returned IDs with plans:bind-spec-evidence. ' +
    'Evidence-file mode records an already-completed check; archivedMutation never reruns it. Commit docs/evidence/*.json with schemaVersion:1, kind:"operational-test-evidence", command, timestamps, exitCode, summary, and assertions; pass expectedSha256. ' +
    'Mutation probes require exact MUTATION_PROBE_EVIDENCE_JSON records; shared .papercusp/scratch is refused. archivedMutation restores failed-case identities from a committed raw log after validating its hash and scoped receipt; rawLogCommit pins redacted logs. Legacy NULL-execution receipts restore only when scope, outcome, timestamps, and committed bytes match. ' +
    `Evidence limit: ${MAX_OPERATIONAL_EVIDENCE_BYTES} bytes; pin bulky logs by SHA-256. Verdict uses exitCode + assertions; idempotent by artifact hash.`,
  guidance: {
    when: 'A completed Playwright, Cargo, node, shell, desktop, or other operational acceptance run needs a numeric ledger record; or historical mutation case identities need recovery.',
    notWhen:
      'Not for Vitest (use testing:run), temporary logs, or checks that did not run.',
    chaining:
      'Run check → commit docs/evidence JSON → testing:record-run → bind returned IDs with plans:bind-spec-evidence. The planTerminalCensus variant executes directly and returns the same numeric ledger IDs.',
  },
  capability: 'testing:run',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.union([z.object({
    harness: harnessArg,
    evidenceFile: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'Repo-relative committed JSON path under docs/evidence/. Absolute, temporary, untracked, dirty, and symlink-escape paths are refused.',
      ),
    expectedSha256: sha256Schema.describe('Lowercase SHA-256 of the exact committed evidence file bytes.'),
  }), z.object({
    harness: harnessArg,
    planTerminalCensus: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(200) })
      .describe('Execute a current canonical plan-item census and record its measured assertions. Non-terminal items, missing inline drop reasons, empty/duplicate populations and mid-check changes fail.'),
  })]),
  async handler(args, ctx) {
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!harnessSlug) return harnessRequiredResult('testing:record-run', ctx);
    if ('planTerminalCensus' in args) {
      return { data: await executePlanTerminalCensus(args.planTerminalCensus.slug, { ...ctx, harnessSlug }) };
    }
    return { data: await recordOperationalRun({ ...args, harness: harnessSlug }, ctx) };
  },
});
