/**
 * Historical-mode consumption control (plan mutation-probe-evidence-value-2026-10-11,
 * P-003 / BAR R-3; EI-25263495315968521, WI-10006508).
 *
 * A guard that reads its subject by a FIXED path never sees the snapshot `{}`
 * names, so it passes against the historical source and the probe used to call
 * that SURVIVED. Before a SURVIVED verdict the probe now re-runs the guard
 * against a poisoned snapshot; a guard that still passes is reported
 * INCONCLUSIVE (exit 2) instead.
 *
 * Runs the real script against a real throwaway Git history — no mocks.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../../../scripts/mutation-probe.sh');

let dir: string;
let admissionBase: string;
let previousAdmissionBase: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-consumption-'));
  previousAdmissionBase = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  admissionBase = mkdtempSync(join(tmpdir(), 'mutation-probe-consumption-admission-'));
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

/** before-fix commit lacks NEW_GUARD; the working file (current) has it. */
function makeRepo(): { file: string; oldSha: string } {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const file = join(repo, 'subject.txt');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(file, 'stable-control\nlegacy-path\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'historical source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, 'stable-control\nNEW_GUARD\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'fix source']);
  return { file, oldSha };
}

function probe(file: string, oldSha: string, test: string): { code: number; out: string } {
  const r = spawnSync(
    'bash',
    [
      SCRIPT,
      '--file', file,
      '--against-commit', oldSha,
      '--must-be-absent', 'NEW_GUARD',
      '--positive-control', 'stable-control',
      '--calibration', 'grep -q "^stable-control$" {}',
      '--test', test,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('mutation-probe.sh historical consumption control (R-3)', () => {
  it('a guard that reads the subject by a fixed path is INCONCLUSIVE (exit 2), never SURVIVED', () => {
    const { file, oldSha } = makeRepo();
    // `{}` is named but never read: the guard greps the live working file.
    const { code, out } = probe(file, oldSha, `test -n {} && grep -q '^NEW_GUARD$' ${JSON.stringify(file)}`);

    expect(code).toBe(2);
    expect(out).toMatch(/mode=historical verdict=inconclusive/);
    expect(out).toMatch(/reason=guard-ignores-subject/);
    expect(out).toMatch(/FIXED path/);
    expect(out).not.toMatch(/HISTORICAL SOURCE SURVIVED/);
  });

  it('a guard that reads {} but does not constrain the fix still gets an honest SURVIVED (exit 1)', () => {
    const { file, oldSha } = makeRepo();
    const { code, out } = probe(file, oldSha, 'grep -q "^stable-control$" {}');

    expect(code).toBe(1);
    expect(out).toMatch(/consumption control: the guard FAILED against a poisoned snapshot/);
    expect(out).toMatch(/mode=historical verdict=survived/);
  });

  it('a poisoned-snapshot failure for an unrelated reason (environment crash, exit 7) is INCONCLUSIVE, not consumption', () => {
    const { file, oldSha } = makeRepo();
    // Fails on the poisoned run with an environment error, never an assertion,
    // and prints nothing that came from the subject.
    const guard = 'if grep -q MUTATION_PROBE_POISONED_SUBJECT {}; then echo "Error: connect ECONNREFUSED 127.0.0.1:5432" >&2; exit 7; fi; grep -q "^stable-control$" {}';
    const { code, out } = probe(file, oldSha, guard);

    expect(code).toBe(2);
    expect(out).toMatch(/mode=historical verdict=inconclusive/);
    expect(out).toMatch(/reason=consumption-unproven/);
    expect(out).toMatch(/consumption_exit=7/);
    expect(out).not.toMatch(/HISTORICAL SOURCE SURVIVED/);
  });

  it('a non-1 poisoned-snapshot failure that carries the poison sentinel still proves consumption', () => {
    const { file, oldSha } = makeRepo();
    // Exit 3 is outside the plain-guard convention; the subject's own sentinel
    // in the output is what shows the failure came from `{}`.
    const { code, out } = probe(file, oldSha, 'grep -q "^stable-control$" {} || { cat {} >&2; exit 3; }');

    expect(code).toBe(1);
    expect(out).toMatch(/consumption_evidence=poison-sentinel/);
    expect(out).toMatch(/mode=historical verdict=survived/);
  });

  it('CONTROL: a guard that catches the historical source never needs the consumption control', () => {
    const { file, oldSha } = makeRepo();
    const { code, out } = probe(file, oldSha, 'grep -q "^NEW_GUARD$" {}');

    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical verdict=caught/);
    expect(out).not.toMatch(/consumption control/);
  });
});
