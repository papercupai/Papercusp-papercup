import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Request hosts must not fork git from their own multi-GB process (WI-10002829 / P-007).
 *
 * Measured 2026-09-26 on :3170: a native plan-popup open took 17,625ms because the staging
 * request host's main thread was saturated. 84% of the captured loop profile was native
 * `spawn` under gitPipelinePosition -> realGit. fork() cost scales with parent RSS
 * (EI-18808838427010743), so every git read on a 2GB+ host is charged as synchronous
 * main-thread time.
 *
 * Offload is opt-in per caller through `gitSidecarEnabled('<explicit var>')`, and request
 * hosts never receive the broad PAPERCUSP_SPAWNER_SIDECAR switch. The failure this guards
 * against is silent: a git-heavy caller acquires an explicit var and nobody enables it on the
 * request hosts. That is how git-pipeline-position got its sidecar route for the bg-host in
 * EI-22737582656157929 while :3070/:3170 kept forking locally.
 *
 * So the population of explicit vars is DERIVED from source, and every member must be
 * classified here. A new var fails this test until its author decides where it runs.
 */

const REPO_ROOT = resolve(join(__dirname, '..', '..', '..', '..'));
const SOURCE_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib', 'apps/operator/bin'];
const REQUEST_HOST_DROP_INS = [
  'apps/operator/scripts/systemd/papercup-dev-api.service.d/86-git-spawn-sidecar.conf',
  'apps/operator/scripts/systemd/papercup-staging-api.service.d/86-git-spawn-sidecar.conf',
];

/** Enabled on both request hosts by the tracked 86-git-spawn-sidecar.conf drop-ins. */
const ENABLED_ON_REQUEST_HOSTS = new Set([
  'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
  'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR',
  'PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR',
  // P-007: plan-audits citation prewarm (`git ls-files -s`) — measured on the :3170 loop profile.
  'PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR',
]);

/**
 * Deliberately not enabled on request hosts, each with the reason. These are not claims that
 * the caller never runs there; they record that no request-host profile has shown it hot yet.
 * Move one to ENABLED (and add it to both drop-ins) when a profile does.
 */
const EXEMPT_ON_REQUEST_HOSTS: Record<string, string> = {
  PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR:
    'git-sync executes as a bg-host routine, which carries the broad PAPERCUSP_SPAWNER_SIDECAR switch',
  PAPERCUSP_POT_GIT_SPAWN_SIDECAR:
    'not observed on a request-host loop profile; the bg-host broad switch covers its routine path',
  PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR:
    'not observed on a request-host loop profile; the bg-host broad switch covers its projection path',
  PAPERCUSP_WORKTREE_COVERAGE_SPAWN_SIDECAR:
    'a DBOS-bootstrap watchdog, not a request path; not observed on a request-host loop profile',
};

const CALL = /gitSidecarEnabled\(\s*'(PAPERCUSP_[A-Z0-9_]+)'/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('dist') || name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
}

function discoverExplicitVars(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SOURCE_ROOTS) {
    const files: string[] = [];
    walk(join(REPO_ROOT, root), files);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(CALL)) {
        const sites = found.get(match[1]) ?? [];
        sites.push(file.slice(REPO_ROOT.length + 1));
        found.set(match[1], sites);
      }
    }
  }
  return found;
}

function enabledVars(dropInPath: string): Set<string> {
  const text = readFileSync(join(REPO_ROOT, dropInPath), 'utf8');
  const vars = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^Environment=(PAPERCUSP_[A-Z0-9_]+_SPAWN_SIDECAR)=1\s*$/.exec(line.trim());
    if (m) vars.add(m[1]);
  }
  return vars;
}

describe('request-host git spawn offload', () => {
  const discovered = discoverExplicitVars();

  it('discovers the git-pipeline-position caller (scanner positive control)', () => {
    expect(discovered.get('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR')).toEqual(
      expect.arrayContaining(['packages/operator-core/lib/git-pipeline-position.ts']),
    );
  });

  it('classifies every explicit per-caller sidecar var found in source', () => {
    const unclassified = [...discovered.keys()].filter(
      (v) => !ENABLED_ON_REQUEST_HOSTS.has(v) && !(v in EXEMPT_ON_REQUEST_HOSTS),
    );
    expect(
      unclassified.map((v) => `${v} (${discovered.get(v)!.join(', ')})`),
      'classify each new gitSidecarEnabled var as ENABLED (and add it to both request-host drop-ins) or EXEMPT with a reason',
    ).toEqual([]);
  });

  it('keeps no stale classification for a var that source no longer uses', () => {
    const classified = [...ENABLED_ON_REQUEST_HOSTS, ...Object.keys(EXEMPT_ON_REQUEST_HOSTS)];
    expect(classified.filter((v) => !discovered.has(v))).toEqual([]);
  });

  it.each(REQUEST_HOST_DROP_INS)('%s enables every ENABLED var and nothing else', (dropIn) => {
    expect([...enabledVars(dropIn)].sort()).toEqual([...ENABLED_ON_REQUEST_HOSTS].sort());
  });

  it('never gives a request host the broad spawner switch', () => {
    for (const dropIn of REQUEST_HOST_DROP_INS) {
      const text = readFileSync(join(REPO_ROOT, dropIn), 'utf8');
      expect(text).not.toMatch(/^Environment=PAPERCUSP_SPAWNER_SIDECAR=/m);
    }
  });
});
