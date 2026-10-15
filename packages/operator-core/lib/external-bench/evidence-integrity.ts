/**
 * Pre-grade evidence-integrity check (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-020 / D-008).
 *
 * Before an in-container attempt is scored, `docker diff` lists every path the attempt added, changed or
 * deleted relative to its image. Any entry at or under a PROTECTED path (the verifier, scorer, reward file or a
 * task-declared fixture) means the attempt touched its own evidence, so the grader must refuse to score it:
 * the caller maps `tampered` to GraderStatus 'invalid' and `unverifiable` to 'error' (a missing measurement,
 * never a silent score). `docker diff` sees WRITES only; an attempt that merely READ hidden tests is not detected.
 */
import type { ProcExec } from './grader/swe-bench-pro';

/** Paths no FrontierSWE attempt may touch (D-003 item 1: v2 images bake the verifier at /root/tests; v1 stages
 *  /tests and, in oracle mode, /solution at grade time; Harbor reads the reward from /logs/verifier). */
export const FRONTIER_SWE_PROTECTED_PATHS: readonly string[] = ['/tests', '/solution', '/logs/verifier', '/root/tests'];

export interface DockerDiffEntry {
  /** A = added, C = changed, D = deleted (docker diff's own codes). */
  kind: 'A' | 'C' | 'D';
  path: string;
}

export type EvidenceIntegrity =
  | { verdict: 'clean'; protectedPaths: string[] }
  | { verdict: 'tampered'; protectedPaths: string[]; violations: DockerDiffEntry[] }
  | { verdict: 'unverifiable'; protectedPaths: string[]; error: string };

/** Parse `docker diff` output. An unrecognized line throws: an output we cannot read is not evidence of "clean". */
export function parseDockerDiff(stdout: string): DockerDiffEntry[] {
  const out: DockerDiffEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([ACD]) (\/.*)$/.exec(line);
    if (!m) throw new Error(`unrecognized docker diff line: ${JSON.stringify(line.slice(0, 200))}`);
    out.push({ kind: m[1] as DockerDiffEntry['kind'], path: m[2] });
  }
  return out;
}

/** Validate + normalize a protected path: absolute, not root, no `.`/`..` segments, no trailing slash. */
export function normalizeProtectedPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  if (!trimmed.startsWith('/') || trimmed === '' || trimmed.split('/').some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))) {
    throw new Error(`invalid protected path ${JSON.stringify(p)} (must be an absolute, non-root, normalized path)`);
  }
  return trimmed;
}

/** Entries at or under any protected path. A parent-directory change (`C /logs` when /logs/verifier is
 *  protected) is not a violation by itself; the protected child appears as its own entry when touched. */
export function protectedPathViolations(entries: readonly DockerDiffEntry[], protectedPaths: readonly string[]): DockerDiffEntry[] {
  return entries.filter((e) => protectedPaths.some((p) => e.path === p || e.path.startsWith(`${p}/`)));
}

/** Run the check against a live container. Never throws: every failure is an `unverifiable` verdict. */
export async function checkContainerEvidenceIntegrity(
  exec: ProcExec,
  containerId: string,
  protectedPaths: readonly string[],
): Promise<EvidenceIntegrity> {
  let paths: string[];
  try {
    paths = [...new Set(protectedPaths.map(normalizeProtectedPath))];
  } catch (e) {
    return { verdict: 'unverifiable', protectedPaths: [...protectedPaths], error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const r = await exec('docker', ['diff', containerId]);
    if (r.code !== 0) {
      return { verdict: 'unverifiable', protectedPaths: paths, error: `docker diff exit ${r.code}: ${r.stderr.slice(0, 300)}` };
    }
    const violations = protectedPathViolations(parseDockerDiff(r.stdout), paths);
    return violations.length ? { verdict: 'tampered', protectedPaths: paths, violations } : { verdict: 'clean', protectedPaths: paths };
  } catch (e) {
    return { verdict: 'unverifiable', protectedPaths: paths, error: e instanceof Error ? e.message : String(e) };
  }
}
