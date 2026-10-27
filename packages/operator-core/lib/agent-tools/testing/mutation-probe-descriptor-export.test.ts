/**
 * Mutation descriptor export (plan mutation-probe-evidence-value-2026-10-11, P-001
 * hop 2 / BAR R-1; field set D-003, reader gate D-006).
 *
 * `scripts/mutation-probe.sh` builds ONE descriptor per invocation — subject path,
 * mode, the literal --mutate expression or the full historical commit, before/after
 * subject hashes, a bounded diff and the --test template hash — and exports it to
 * every guard leg as PAPERCUSP_MUTATION_DESCRIPTOR, where the test-run reporter
 * persists it at execution_details.mutation. In `auto` the export waits until the
 * deployed reader (its /api/health sha → libs/test-config gitlink) carries the
 * descriptor parser, because that reader parses execution_details strictly (D-001).
 *
 * Runs the real script against throwaway Git repositories; the guard is a recorder
 * that captures the environment each leg actually received. No mocks.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseMutationInvocationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../../../scripts/mutation-probe.sh');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

let dir: string;
let admissionBase: string;
let previousAdmissionBase: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-descriptor-'));
  previousAdmissionBase = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  admissionBase = mkdtempSync(join(tmpdir(), 'mutation-probe-descriptor-admission-'));
  process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = admissionBase;
});

afterEach(() => {
  rmSync(admissionBase, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  if (previousAdmissionBase === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  else process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = previousAdmissionBase;
});

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return (r.stdout ?? '').trim();
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
}

const ORIGINAL = 'stable-control\nguarded\n';
const HISTORICAL = 'stable-control\nlegacy-path\n';

/** subject.txt committed twice: a before-fix source (no `guarded`) then the current one. */
function makeSubjectRepo(): { file: string; oldSha: string } {
  const repo = join(dir, 'repo');
  initRepo(repo);
  const file = join(repo, 'subject.txt');
  writeFileSync(file, HISTORICAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'historical source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, ORIGINAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'fix source']);
  return { file, oldSha };
}

/** The guard: record (phase, descriptor) for every leg, fail unless the subject says `guarded`. */
function makeRecorder(requiredLine = 'guarded'): { recorder: string; log: string } {
  const recorder = join(dir, 'recorder.cjs');
  const log = join(dir, 'legs.jsonl');
  writeFileSync(
    recorder,
    `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  phase: process.env.PAPERCUSP_MUTATION_PHASE ?? null,
  descriptor: process.env.PAPERCUSP_MUTATION_DESCRIPTOR ?? null,
}) + '\\n');
process.exit(fs.readFileSync(process.argv[2], 'utf8').split(String.fromCharCode(10)).includes(${JSON.stringify(requiredLine)}) ? 0 : 1);
`,
  );
  return { recorder, log };
}

function legs(log: string): Array<{ phase: string | null; descriptor: string | null }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function probe(args: string[], env: Record<string, string | undefined>, script = SCRIPT): { code: number; out: string } {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    // A refused reader is final on the first read unless a case opts into the
    // restart-retry budget (EI-27128359939578808), so these cases stay fast.
    env: { ...process.env, PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const MUTATE = 's/^guarded$/MUTATED/';

describe('mutation-probe.sh descriptor export (R-1)', () => {
  it('auto: discovers the original script repository after the runner freezes itself outside Git', () => {
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    mkdirSync(join(sub, 'src'));
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'),
      readFileSync(resolve(__dirname, '../../../../../libs/test-config/src/mutation-descriptor.ts')));
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'replayable descriptor reader']);
    const script = join(reader, 'scripts', 'mutation-probe.sh');
    mkdirSync(join(reader, 'scripts'));
    writeFileSync(script, readFileSync(SCRIPT));
    git(reader, ['add', 'scripts/mutation-probe.sh', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'original runner and reader']);
    const operatorRoot = join(dir, 'operator');
    mkdirSync(join(operatorRoot, 'api'), { recursive: true });
    writeFileSync(join(operatorRoot, 'api', 'health'), JSON.stringify({ sha: git(reader, ['rev-parse', 'HEAD']).slice(0, 10) }));
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      // The intended reader comes from the ambient operator pin. The probe
      // must not silently fall back to the legacy :3070 reader when a staging
      // or desktop shell has selected another runtime.
      PAPERCUSP_OPERATOR_URL: `file://${operatorRoot}`,
      PAPERCUSP_OPERATOR_BASE: undefined,
      PAPERCUSP_HONO_PORT: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: undefined,
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://ledger.example:5444/papercusp',
    }, script);

    expect(code, out).toBe(0);
    expect(out).toMatch(/mutation descriptor on: deployed reader [0-9a-f]+ parses execution_details\.mutation/);
    const replay = JSON.parse(out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)![1]!);
    expect(replay.environment).toMatchObject({
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${operatorRoot}/api/health`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: 1,
    });
    const seen = legs(log);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(leg => leg.descriptor !== null
      && parseMutationInvocationDescriptor(JSON.parse(leg.descriptor)))).toBe(true);
  });

  it('auto: refuses before any guard leg when the selected reader is unavailable', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
      PAPERCUSP_OPERATOR_BASE: undefined,
      PAPERCUSP_HONO_PORT: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: undefined,
    });

    expect(code, out).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error phase=descriptor reason=reader-unavailable');
    expect(out).toContain('refusing to run an unbindable proof');
    // The refusal must name the reader it judged (on the RESULT line) and the
    // remedy for a close evaluated on another build (EI-26306001661366608: a
    // :3170-evaluated close was refused against the session's :3070 route with
    // no pointer to the fix).
    expect(out).toMatch(/MUTATION_PROBE_RESULT verdict=harness-error phase=descriptor reason=reader-unavailable reader_source=operator-url reader_url=http:\/\/127\.0\.0\.1:1\/api\/health /);
    expect(out).toMatch(/evaluated on a different build[\s\S]*PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL set to that build's \/api\/health/);
    expect(out).not.toContain('running baseline guard');
    expect(legs(log)).toEqual([]);
  });

  // WI-6554700010017564: EXPORT=never is the documented override ("always|never
  // overrides the check"). Under an ambient reader the requirement is only
  // INFERRED, so a deliberately unbound probe must run, not be refused with the
  // health-URL remedy (which does not apply: the reader is never consulted).
  it('never: an ambient reader does not refuse a deliberately unbound probe', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'never',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
      PAPERCUSP_OPERATOR_BASE: undefined,
      PAPERCUSP_HONO_PORT: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: undefined,
    });

    expect(code, out).toBe(0);
    expect(out).not.toContain('refusing to run an unbindable proof');
    expect(out).toContain('forced off (PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT=never)');
    const seen = legs(log);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l.descriptor === null)).toBe(true);
  });

  it('never + explicit READER_REQUIRED=1: refuses as a contradiction and names both remedies', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'never',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
      PAPERCUSP_OPERATOR_BASE: undefined,
      PAPERCUSP_HONO_PORT: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: '1',
    });

    expect(code, out).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error phase=descriptor reason=export-disabled-but-reader-required');
    expect(out).toContain('PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED=0');
    expect(out).toContain('Unset PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT');
    expect(out).not.toContain("set to that build's /api/health");
    expect(out).not.toContain('running baseline guard');
    expect(legs(log)).toEqual([]);
  });

  it('fails closed when the admitted descriptor builder crashes, without issuing a caught or survived verdict', () => {
    const { file } = makeSubjectRepo();
    const { recorder } = makeRecorder();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Fail only the descriptor construction process; the preflight and guard
    // still have a working Node, so this isolates the lost-metadata failure.
    writeFileSync(join(bin, 'node'), `#!/bin/bash\nif [ -n "$MPD_MODE" ]; then\n  echo descriptor-builder-crash >&2\n  exit 17\nfi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PATH: `${bin}:${process.env.PATH}`,
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
    });
    expect(code, out).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error phase=descriptor reason=build-failed');
    expect(out).toContain('descriptor-builder-crash');
    expect(out).not.toMatch(/MUTATION_PROBE_RESULT verdict=(caught|survived)/);
  });

  it('copy-out: every leg receives the SAME strict descriptor naming the subject, expression, hashes and diff', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const test = `node ${recorder} {}`;
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', test], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
    });

    expect(code, out).toBe(0);
    const seen = legs(log);
    expect(seen.map((l) => l.phase)).toEqual(expect.arrayContaining(['baseline', 'mutant']));
    const raw = seen[0]!.descriptor;
    expect(raw).not.toBeNull();
    expect(new Set(seen.map((l) => l.descriptor))).toEqual(new Set([raw]));

    const descriptor = parseMutationInvocationDescriptor(JSON.parse(raw!));
    expect(descriptor).toBeDefined();
    expect(descriptor).toMatchObject({
      mode: 'copy-out',
      subjectPath: 'subject.txt',
      mutateExpression: MUTATE,
      againstCommit: null,
      subjectBeforeSha256: sha256(ORIGINAL),
      subjectAfterSha256: sha256(ORIGINAL.replace(/^guarded$/m, 'MUTATED')),
      mutantDiffTruncated: false,
      testCommandSha256: sha256(test),
      testCommand: test,
    });
    expect(descriptor!.mutantDiff).toMatch(/^--- a\/subject\.txt$/m);
    expect(descriptor!.mutantDiff).toMatch(/^-guarded$/m);
    expect(descriptor!.mutantDiff).toMatch(/^\+MUTATED$/m);
    expect(out).toContain(`probeInvocationId=${descriptor!.probeInvocationId}`);
    const replay = probe(['--file', file, '--mutate', descriptor!.mutateExpression!, '--test', descriptor!.testCommand!], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
    });
    expect(replay.code, replay.out).toBe(0);
  });

  it('historical: replay uses the recorded commit, command and exact original controls', () => {
    const { file, oldSha } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const test = `node ${recorder} {}`;
    const { code, out } = probe(
      [
        '--file', file,
        '--against-commit', oldSha,
        '--must-be-absent', 'guarded',
        '--positive-control', 'stable-control',
        '--positive-control', 'control',
        '--calibration', 'grep -q "^stable-control$" {}',
        '--subject-must-behave', 'grep -q "^stable-control$" {}',
        '--test', test,
      ],
      { PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always' },
    );

    expect(code, out).toBe(0);
    const descriptors = new Set(legs(log).map((l) => l.descriptor));
    expect(descriptors.size).toBe(1);
    const descriptor = parseMutationInvocationDescriptor(JSON.parse([...descriptors][0]!));
    expect(descriptor).toMatchObject({
      mode: 'historical',
      subjectPath: 'subject.txt',
      mutateExpression: null,
      againstCommit: oldSha,
      subjectBeforeSha256: sha256(ORIGINAL),
      subjectAfterSha256: sha256(HISTORICAL),
      testCommand: test,
      historicalControls: {
        mustBeAbsent: 'guarded', positiveControls: ['stable-control', 'control'],
        calibrationCommand: 'grep -q "^stable-control$" {}',
        subjectMustBehave: 'grep -q "^stable-control$" {}',
      },
    });
    expect(oldSha).toMatch(/^[0-9a-f]{40}$/);
    const controls = descriptor!.historicalControls!;
    const replay = probe([
      '--file', file, '--against-commit', descriptor!.againstCommit!,
      '--must-be-absent', controls.mustBeAbsent,
      ...controls.positiveControls.flatMap((literal) => ['--positive-control', literal]),
      '--calibration', controls.calibrationCommand,
      '--subject-must-behave', controls.subjectMustBehave!, '--test', descriptor!.testCommand!,
    ], { PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always' });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toContain('mode=historical verdict=caught');
  });

  it('surviving historical mutant: baseline, mutant and consumption-control retain the SAME strict descriptor', () => {
    const { file, oldSha } = makeSubjectRepo();
    // This guard consumes each snapshot, but accepts both current and historical
    // sources. Only the poisoned snapshot lacks the stable positive control.
    const { recorder, log } = makeRecorder('stable-control');
    const test = `node ${recorder} {}`;
    const { code, out } = probe([
      '--file', file,
      '--against-commit', oldSha,
      '--must-be-absent', 'guarded',
      '--positive-control', 'stable-control',
      '--calibration', 'grep -q "^stable-control$" {}',
      '--test', test,
    ], { PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always' });

    expect(code, out).toBe(1);
    expect(out).toMatch(/mode=historical verdict=survived/);
    expect(out).toMatch(/consumption control: the guard FAILED against a poisoned snapshot/);
    const seen = legs(log);
    expect(seen.map((leg) => leg.phase)).toEqual(['baseline', 'historical', 'consumption-control']);
    const descriptors = seen.map((leg) => {
      expect(leg.descriptor).not.toBeNull();
      const descriptor = parseMutationInvocationDescriptor(JSON.parse(leg.descriptor!));
      expect(descriptor).toBeDefined();
      return descriptor!;
    });
    expect(new Set(seen.map((leg) => leg.descriptor))).toEqual(new Set([seen[0]!.descriptor]));
    expect(new Set(descriptors.map((descriptor) => descriptor.probeInvocationId)).size).toBe(1);
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({
        mode: 'historical', subjectPath: 'subject.txt', mutateExpression: null,
        againstCommit: oldSha, subjectBeforeSha256: sha256(ORIGINAL),
        subjectAfterSha256: sha256(HISTORICAL), testCommandSha256: sha256(test),
      });
    }
    expect(out).toContain(`probeInvocationId=${descriptors[0]!.probeInvocationId}`);
    const saved = descriptors[0]!;
    const controls = saved.historicalControls!;
    const replay = probe([
      '--file', file, '--against-commit', saved.againstCommit!, '--test', saved.testCommand!,
      '--must-be-absent', controls.mustBeAbsent,
      ...controls.positiveControls.flatMap((literal) => ['--positive-control', literal]),
      '--calibration', controls.calibrationCommand,
    ], { PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always' });
    expect(replay.code, replay.out).toBe(1);
    expect(replay.out).toContain('mode=historical verdict=survived');
    expect(replay.out).toContain('consumption control: the guard FAILED against a poisoned snapshot');
  });

  it('auto: withholds the export when the deployed reader is unreadable, and never forwards a stale caller value', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${join(dir, 'no-such-health.json')}`,
      // An explicit HEALTH_URL now REQUIRES the reader (3f9bb0a4d3), so the
      // withheld/unbound path these auto cases pin needs the explicit opt-out.
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: '0',
      PAPERCUSP_MUTATION_DESCRIPTOR: '{"stale":"caller value"}',
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/mutation descriptor withheld: the deployed reader's build sha is unreadable/);
    const seen = legs(log);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l.descriptor === null)).toBe(true);
  });

  it('auto: distinguishes an unavailable reader commit from an absent parser', () => {
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    writeFileSync(join(sub, 'README'), 'test-config\n');
    git(sub, ['add', 'README']);
    git(sub, ['commit', '-qm', 'available local reader']);
    const unavailableCommit = 'f'.repeat(40);
    git(reader, ['update-index', '--add', '--cacheinfo', `160000,${unavailableCommit},libs/test-config`]);
    git(reader, ['commit', '-qm', 'reader with unavailable gitlink object']);
    const health = join(dir, 'health.json');
    writeFileSync(health, JSON.stringify({ sha: git(reader, ['rev-parse', 'HEAD']).slice(0, 10) }));
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${health}`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: '0',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: reader,
    });

    expect(code, out).toBe(0);
    expect(out).toContain('reader commit object is unavailable');
    expect(out).not.toContain('predates the descriptor parser');
    expect(legs(log).length).toBeGreaterThan(0);
    expect(legs(log).every((leg) => leg.descriptor === null)).toBe(true);
  });

  it('auto: distinguishes an unreadable parser blob from an absent parser', () => {
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    mkdirSync(join(sub, 'src'));
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'), readFileSync(resolve(__dirname, '../../../../../libs/test-config/src/mutation-descriptor.ts')));
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'reader with parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with parser gitlink']);
    const parserBlob = git(sub, ['rev-parse', 'HEAD:src/mutation-descriptor.ts']);
    const blobPath = join(sub, '.git', 'objects', parserBlob.slice(0, 2), parserBlob.slice(2));
    expect(existsSync(blobPath)).toBe(true);
    rmSync(blobPath);
    const health = join(dir, 'health.json');
    writeFileSync(health, JSON.stringify({ sha: git(reader, ['rev-parse', 'HEAD']).slice(0, 10) }));
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${health}`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: '0',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: reader,
    });

    expect(code, out).toBe(0);
    expect(out).toContain('descriptor parser blob is unreadable');
    expect(out).not.toContain('predates the descriptor parser');
    expect(legs(log).length).toBeGreaterThan(0);
    expect(legs(log).every((leg) => leg.descriptor === null)).toBe(true);
  });

  it('auto: turns on only when the deployed build\'s libs/test-config gitlink carries the descriptor parser', () => {
    // A reader superproject whose libs/test-config is a gitlink: commit OLD predates
    // the parser, commit NEW contains src/mutation-descriptor.ts.
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    writeFileSync(join(sub, 'README'), 'test-config\n');
    git(sub, ['add', 'README']);
    git(sub, ['commit', '-qm', 'before parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader without parser']);
    const oldReader = git(reader, ['rev-parse', 'HEAD']);
    mkdirSync(join(sub, 'src'));
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'), 'export function parseMutationInvocationDescriptor(v: any) { return v.testCommand === undefined ? v : undefined; }\n');
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'descriptor parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with parser']);
    const hashOnlyReader = git(reader, ['rev-parse', 'HEAD']);
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'), 'export function parseMutationInvocationDescriptor(v: any) { return typeof v.testCommand === "string" && v.historicalControls === undefined ? v : undefined; }\n');
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'parser supports command only']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with command-only parser']);
    const commandOnlyReader = git(reader, ['rev-parse', 'HEAD']);
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'), readFileSync(resolve(__dirname, '../../../../../libs/test-config/src/mutation-descriptor.ts')));
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'parser supports historical replay']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with command parser']);
    const newReader = git(reader, ['rev-parse', 'HEAD']);

    const health = join(dir, 'health.json');
    const run = (readerSha: string) => {
      writeFileSync(health, JSON.stringify({ ok: true, service: 'papercusp-operator', sha: readerSha.slice(0, 10) }));
      const { file } = makeSubjectRepoAt(join(dir, `repo-${readerSha.slice(0, 6)}`));
      const { recorder, log } = makeRecorderAt(join(dir, `legs-${readerSha.slice(0, 6)}`));
      const result = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
        PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${health}`,
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: '0',
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: reader,
      });
      return { ...result, legs: legs(log) };
    };

    const before = run(oldReader);
    expect(before.code, before.out).toBe(0);
    expect(before.out).toMatch(/withheld: deployed reader [0-9a-f]+ .* predates the descriptor parser/);
    expect(before.legs.every((l) => l.descriptor === null)).toBe(true);

    const hashOnly = run(hashOnlyReader);
    expect(hashOnly.code, hashOnly.out).toBe(0);
    expect(hashOnly.out).toContain('does not accept the replayable testCommand');
    expect(hashOnly.legs.every((l) => l.descriptor === null)).toBe(true);

    const commandOnly = run(commandOnlyReader);
    expect(commandOnly.code, commandOnly.out).toBe(0);
    expect(commandOnly.out).toContain('does not accept the replayable testCommand/historicalControls');
    expect(commandOnly.legs.every((l) => l.descriptor === null)).toBe(true);

    const after = run(newReader);
    expect(after.code, after.out).toBe(0);
    expect(after.out).toMatch(/mutation descriptor on: deployed reader [0-9a-f]+ parses execution_details\.mutation/);
    expect(after.legs.length).toBeGreaterThan(0);
    expect(after.legs.every((l) => l.descriptor !== null && parseMutationInvocationDescriptor(JSON.parse(l.descriptor)))).toBe(true);
  });
});

// EI-27128359939578808: the staging :3170 reader restarts on every staging
// advance. One refused read used to refuse the whole proof run, so the
// preflight retries refused/timed-out connections and 5xx answers within
// PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC, and treats every other answer
// as final. The reader here is a real HTTP server in a separate process.
describe('mutation-probe.sh reader preflight survives a restarting reader', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /** A free loopback port, released before the reader process binds it. */
  async function freePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  /**
   * A reader that answers its Nth request with `responses[N-1]` — `'drop'` closes
   * the connection with no reply (a reader mid-restart), a number is that HTTP
   * status — and the health body once the list is exhausted. Resolves listening.
   */
  async function startReader(opts: { responses: Array<'drop' | number>; sha: string }): Promise<{ port: number; hits: string }> {
    const port = await freePort();
    const script = join(dir, 'reader-server.cjs');
    const hits = join(dir, 'reader-hits.log');
    writeFileSync(script, `const http = require('http'); const fs = require('fs');
const o = ${JSON.stringify({ ...opts, port })};
let n = 0;
http.createServer((req, res) => {
  n += 1; fs.appendFileSync(${JSON.stringify(hits)}, n + '\\n');
  const r = o.responses[n - 1];
  if (r === 'drop') { req.socket.destroy(); return; }
  if (typeof r === 'number') { res.writeHead(r); res.end('restarting'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'papercusp-operator', sha: o.sha }));
}).listen(o.port, '127.0.0.1');
setTimeout(() => process.exit(0), 80000);
`);
    children.push(spawn(process.execPath, [script], { stdio: 'ignore' }));
    for (let i = 0; i < 100 && !(await isListening(port)); i += 1) await new Promise((r) => setTimeout(r, 50));
    return { port, hits };
  }

  const hitCount = (hits: string) => (existsSync(hits) ? readFileSync(hits, 'utf8').trim().split('\n').filter(Boolean).length : 0);

  /** A reader superproject whose libs/test-config gitlink carries the real descriptor parser. */
  function makeParserReader(): { reader: string; sha: string } {
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    mkdirSync(join(sub, 'src'));
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'),
      readFileSync(resolve(__dirname, '../../../../../libs/test-config/src/mutation-descriptor.ts')));
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'reader with parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with parser gitlink']);
    return { reader, sha: git(reader, ['rev-parse', 'HEAD']).slice(0, 10) };
  }

  const readerJson = (out: string) =>
    JSON.parse(out.match(/^MUTATION_PROBE_READER_HTTP_JSON=(.+)$/m)![1]!) as { attempts: number; sha: string | null };

  it('retries a dropped connection and a 5xx answer, then binds the proof to the reader that came back', async () => {
    const { reader, sha } = makeParserReader();
    const { port, hits } = await startReader({ responses: ['drop', 503], sha });
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: reader,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC: '30',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_RETRY_SEC: '1',
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/^MUTATION_PROBE_READER_RETRY attempt=1 curl_exit=(52|56) /m);
    expect(out).toMatch(/^MUTATION_PROBE_READER_RETRY attempt=2 curl_exit=0 http=503 /m);
    expect(readerJson(out)).toMatchObject({ sha, attempts: 3 });
    expect(hitCount(hits)).toBe(3);
    expect(out).toMatch(/mutation descriptor on: deployed reader [0-9a-f]+ parses execution_details\.mutation/);
    const seen = legs(log);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((leg) => leg.descriptor !== null
      && parseMutationInvocationDescriptor(JSON.parse(leg.descriptor)))).toBe(true);
  });

  it('treats a non-transient answer (404) as final on the first read', async () => {
    const { port, hits } = await startReader({ responses: [404, 404, 404], sha: 'abcdef1234' });
    const { file } = makeSubjectRepo();
    const { recorder } = makeRecorder();
    const started = Date.now();
    const { out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC: '30',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_RETRY_SEC: '1',
    });

    expect(out).not.toContain('MUTATION_PROBE_READER_RETRY');
    expect(readerJson(out)).toMatchObject({ attempts: 1, sha: null });
    expect(hitCount(hits)).toBe(1);
    expect(out).toContain("the deployed reader's build sha is unreadable");
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it('gives up when the reader stays down past the wait budget', async () => {
    const port = await freePort();
    const { file } = makeSubjectRepo();
    const { recorder } = makeRecorder();
    const { out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC: '2',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_RETRY_SEC: '1',
    });

    expect(out).toMatch(/^MUTATION_PROBE_READER_RETRY attempt=1 curl_exit=7 /m);
    expect(readerJson(out).attempts).toBeGreaterThanOrEqual(2);
    expect(readerJson(out).sha).toBeNull();
    expect(out).toContain("the deployed reader's build sha is unreadable");
  });

  it('refuses a malformed wait budget instead of guessing one', () => {
    const { file } = makeSubjectRepo();
    const { recorder } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: 'http://127.0.0.1:1/api/health',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC: '2m',
    });

    expect(code, out).not.toBe(0);
    expect(out).toContain('PAPERCUSP_MUTATION_DESCRIPTOR_READER_WAIT_SEC must be a whole number of seconds');
  });
});

function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}

function makeSubjectRepoAt(repo: string): { file: string } {
  initRepo(repo);
  const file = join(repo, 'subject.txt');
  writeFileSync(file, ORIGINAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'source']);
  return { file };
}

function makeRecorderAt(base: string): { recorder: string; log: string } {
  mkdirSync(base, { recursive: true });
  const recorder = join(base, 'recorder.cjs');
  const log = join(base, 'legs.jsonl');
  writeFileSync(
    recorder,
    `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  phase: process.env.PAPERCUSP_MUTATION_PHASE ?? null,
  descriptor: process.env.PAPERCUSP_MUTATION_DESCRIPTOR ?? null,
}) + '\\n');
process.exit(/^guarded$/m.test(fs.readFileSync(process.argv[2], 'utf8')) ? 0 : 1);
`,
  );
  return { recorder, log };
}
