/**
 * WI-6554700010030186 — `resolveSourceDrift` must answer about REPO-ROOT paths whatever
 * this process's cwd is.
 *
 * The operator hosts (bg-host :3271, :3070, :3170) run with cwd `<checkout>/apps/operator`.
 * git resolves a bare pathspec against the cwd, so there `packages/operator-core/lib/release/`
 * meant `apps/operator/packages/operator-core/lib/release/` and matched nothing: the
 * gate-code fast path of the stale-routine-executor watchdog saw "no drift" for every
 * gate-code commit, returned silently, and bg-host never advanced on its own
 * (gate-repair-plane-on-current-build-2026-10-15 R-6). Measured 2026-10-27 on
 * f579aa4d8b..3faacb0a3b: 6 non-test files from the repo root, 0 from apps/operator.
 *
 * The real-git case runs the SAME probe twice — from the repo root (the positive
 * control) and from apps/operator (bg-host's cwd) — and requires identical, non-empty
 * answers. Without the `:(top)` anchoring the second answer is empty.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  GATE_SOURCE_PATHSPECS,
  resolveSourceDrift,
  topAnchoredPathspec,
  type GitRead,
} from './process-boot-identity';

const pexec = promisify(execFile);

/** A real `git` read with an explicit cwd — the only variable between the two runs. */
const gitReadIn = (cwd: string): GitRead => async (args) =>
  String((await pexec('git', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })).stdout);

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  encoding: 'utf8',
}).trim();
const operatorAppDir = path.join(repoRoot, 'apps', 'operator');

/** The newest commit whose diff against its first parent touches non-test gate code. */
function findGateCodeCommit(): { parent: string; commit: string } | null {
  const specs = GATE_SOURCE_PATHSPECS.map(topAnchoredPathspec);
  try {
    const log = execFileSync('git', ['log', '--format=%H %P', '-n', '60', '--', ...specs], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20_000,
    });
    for (const line of log.split('\n')) {
      const [commit, parent] = line.trim().split(/\s+/);
      if (!commit || !parent) continue;
      const names = execFileSync('git', ['diff', '--name-only', '--no-renames', `${parent}..${commit}`, '--', ...specs], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 20_000,
      });
      if (names.split('\n').some((p) => p.trim() !== '' && !p.trim().endsWith('.test.ts'))) return { parent, commit };
    }
  } catch {
    // No usable history (e.g. a shallow clone): the real-git case is skipped, visibly.
  }
  return null;
}

const gateCodeCommit = existsSync(operatorAppDir) ? findGateCodeCommit() : null;

describe('resolveSourceDrift — pathspecs are repo-root-relative under any cwd (WI-6554700010030186)', () => {
  it('anchors every bare pathspec at the repository top and passes magic pathspecs through', async () => {
    const calls: string[][] = [];
    const read: GitRead = async (args) => {
      calls.push(args);
      return 'M\tpackages/operator-core/lib/release/a.ts\nA\tpackages/operator-core/lib/release/b.ts\nM\tpackages/operator-core/lib/release/a.test.ts\n';
    };
    const drift = await resolveSourceDrift(
      'a'.repeat(40),
      'b'.repeat(40),
      ['packages/operator-core/lib/release/', ':(top)already/anchored/', ':/rooted'],
      read,
    );
    expect(drift).toEqual({
      changed: ['packages/operator-core/lib/release/a.ts'],
      addedSinceBoot: ['packages/operator-core/lib/release/b.ts'],
    });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
      ':(top)packages/operator-core/lib/release/',
      ':(top)already/anchored/',
      ':/rooted',
    ]);
  });

  it.skipIf(gateCodeCommit === null)(
    'reports the same non-empty gate-code drift from apps/operator (bg-host cwd) as from the repo root',
    async () => {
      const { parent, commit } = gateCodeCommit!;
      const fromRoot = await resolveSourceDrift(parent, commit, GATE_SOURCE_PATHSPECS, gitReadIn(repoRoot));
      // Positive control: the probe can see this commit's gate-code change at all.
      expect(fromRoot).not.toBeNull();
      expect(fromRoot!.changed.length + fromRoot!.addedSinceBoot.length).toBeGreaterThan(0);

      const fromOperatorApp = await resolveSourceDrift(parent, commit, GATE_SOURCE_PATHSPECS, gitReadIn(operatorAppDir));
      expect(fromOperatorApp).toEqual(fromRoot);
    },
    60_000,
  );
});
