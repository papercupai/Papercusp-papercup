/** Candidate input for the existing package lifecycle suite, independent of its harness HEAD. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — reuse the packager's JavaScript lock-path resolver.
import { lockedPackageKeyResolver } from '../../../../apps/tui/scripts/bundle-psu-dependencies.mjs';

export interface PackageResult {
  archive: string;
  sha256: string;
  name: string;
  version: string;
  target: string;
  sourceSha: string;
  glibcFloor: string;
}

const INPUTS = ['PUI_PUBLIC_PACKAGE_ARCHIVE', 'PUI_PUBLIC_PACKAGE_SOURCE_SHA', 'PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256'] as const;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Git blob bodies are file inputs, not bounded subprocess diagnostic output. */
export function readPackageBuildLock(root: string, sourceSha: string): Record<string, { version?: string; link?: boolean }> {
  const work = mkdtempSync(path.join(tmpdir(), 'pui-build-lock-'));
  const file = path.join(work, 'package-lock.json');
  try {
    const fd = openSync(file, 'w');
    try {
      execFileSync('git', ['-C', root, 'show', `${sourceSha}:package-lock.json`], { stdio: ['ignore', fd, 'pipe'] });
    } finally { closeSync(fd); }
    return JSON.parse(readFileSync(file, 'utf8')).packages;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Check the bundler's native build prerequisites before spending time in Cargo. */
export function assertPackageBuildDependencies(root: string, packages: Record<string, { version?: string; link?: boolean }>): void {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const packageKey = lockedPackageKeyResolver(root, packages);
  const inputs = [path.dirname(requireFromRoot.resolve('esbuild/package.json')),
    realpathSync(path.join(root, 'node_modules', '@lydell', 'node-pty'))];
  for (const directory of inputs) {
    const key = packageKey(directory) as string;
    const installed = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name: string; version: string };
    if (installed.version !== packages[key]?.version) {
      throw new Error(`package build dependency ${installed.name}@${installed.version} disagrees with committed ${key}@${packages[key]?.version}`);
    }
  }
}

/**
 * Reuse a release archive as generation B without rebuilding or changing it.
 * All three pins are mandatory. Validate and snapshot BEFORE the suite builds
 * generation A or the cold reproducibility control; later tests use only the
 * checked snapshot. Unset inputs preserve the normal two-build/mutation route.
 */
export function loadPinnedPackageCandidate(
  env: NodeJS.ProcessEnv, snapshotDir: string, target: string,
): PackageResult | undefined {
  if (INPUTS.every((key) => env[key] === undefined)) return undefined;
  if (INPUTS.some((key) => !env[key]?.trim())) {
    throw new Error(`pinned package candidate requires all of ${INPUTS.join(', ')}`);
  }
  if (env.PUI_PUBLIC_PACKAGE_SUBJECT || env.PUI_PUBLIC_PACKAGE_SUBJECT_PATH) {
    throw new Error('a pinned package candidate cannot be combined with PUI_PUBLIC_PACKAGE_SUBJECT mutation inputs');
  }
  const archive = path.resolve(env.PUI_PUBLIC_PACKAGE_ARCHIVE!);
  const sourceSha = env.PUI_PUBLIC_PACKAGE_SOURCE_SHA!;
  const digest = env.PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256!;
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('PUI_PUBLIC_PACKAGE_SOURCE_SHA must be a full committed SHA');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256 must be a full SHA-256');
  if (sha256(archive) !== digest) throw new Error(`pinned package candidate archive digest mismatch: ${archive}`);

  mkdirSync(snapshotDir, { recursive: true });
  const snapshot = path.join(snapshotDir, 'candidate.tar.gz');
  copyFileSync(archive, snapshot);
  if (sha256(snapshot) !== digest) throw new Error('pinned package candidate changed while being copied');
  const members = execFileSync('tar', ['-tzf', snapshot], { encoding: 'utf8' }).trim().split('\n');
  const provenanceMembers = members.filter((name) => /^[^/]+\/PROVENANCE\.json$/.test(name));
  if (provenanceMembers.length !== 1) throw new Error('pinned package candidate must contain exactly one root PROVENANCE.json');
  const provenance = JSON.parse(execFileSync('tar', ['-xzOf', snapshot, provenanceMembers[0]!], { encoding: 'utf8' })) as {
    version?: string; target?: string; source?: { commit?: string }; runtime?: { glibcFloor?: string | null };
  };
  if (provenance.source?.commit !== sourceSha) throw new Error('pinned package candidate source SHA mismatch');
  if (provenance.target !== target) throw new Error(`pinned package candidate target mismatch: expected ${target}`);
  if (typeof provenance.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.+-]*$/.test(provenance.version)) {
    throw new Error('pinned package candidate has no valid version');
  }
  const name = `pui-${provenance.version}-${target}`;
  if (provenanceMembers[0] !== `${name}/PROVENANCE.json` || members.some((member) =>
    !member.startsWith(`${name}/`) || member.split('/').includes('..'))) {
    throw new Error('pinned package candidate has an unexpected archive root');
  }
  const result = { archive: path.join(snapshotDir, `${name}.tar.gz`), sha256: digest, name,
    version: provenance.version, target, sourceSha, glibcFloor: provenance.runtime?.glibcFloor ?? '' };
  renameSync(snapshot, result.archive);
  writeFileSync(path.join(snapshotDir, 'SHA256SUMS'), `${digest}  ${name}.tar.gz\n`);
  return result;
}
