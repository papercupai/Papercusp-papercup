#!/usr/bin/env node
/** Rebuild after the compiled source tree, including linked packages, stays stable. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { withPortalHandoffLock } from './portal-reconcile-lock.mts';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// The timer samples every five minutes; require two quiet intervals before a full build.
const SOURCE_STABILITY_WINDOW_MS = 10 * 60 * 1000;
// A busy shared tree may never be quiet. The compiler freezes its source inputs
// and promotion still verifies the root digest; debounce must not starve it.
const MAX_SOURCE_DEFERRAL_MS = 30 * 60 * 1000;

async function run(command, args, cwd, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}

async function fingerprint(portalRoot) {
  const source = pathToFileURL(join(portalRoot, 'scripts/source-integrity.mjs')).href;
  const { fingerprintReleaseSource } = await import(source);
  const result = await fingerprintReleaseSource(portalRoot);
  if (!result.digest || !result.rootDigest) throw new Error('portal_source_digest_unavailable');
  return result;
}

async function releaseAt(runtimeRoot) {
  const path = await realpath(join(runtimeRoot, 'current'));
  const manifest = JSON.parse(await readFile(join(path, '.papercusp-release.json'), 'utf8'));
  return { path, manifest };
}

async function receiptAt(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeReceipt(path, receipt) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function releaseNamesAt(runtimeRoot) {
  try {
    return (await readdir(join(runtimeRoot, 'releases'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function findStagedRelease(runtimeRoot, priorNames, portalRoot, rootDigest) {
  const prior = new Set(priorNames);
  const names = await releaseNamesAt(runtimeRoot);
  const candidates = [];
  for (const name of names) {
    if (prior.has(name)) continue;
    const path = join(runtimeRoot, 'releases', name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(path, '.papercusp-release.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (resolve(manifest.sourceRoot ?? '') === portalRoot
      && manifest.sourceRootDigest === rootDigest) {
      candidates.push({ path, manifest });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`portal_staged_release_ambiguous:${candidates.length}`);
  }
  return candidates[0];
}

/** Atomically retarget `current` to a staged release after its source is checked. */
async function promoteCurrentRelease(runtimeRoot, releasePath, expectedCurrentPath) {
  const runtime = resolve(runtimeRoot);
  const releasesRoot = await realpath(join(runtime, 'releases'));
  const candidate = await realpath(releasePath);
  const candidateRelative = relative(releasesRoot, candidate);
  if (!candidateRelative || candidateRelative === '..'
    || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
    throw new Error('portal_staged_release_outside_runtime');
  }

  const currentLink = join(runtime, 'current');
  const actualCurrent = await realpath(currentLink);
  if (resolve(actualCurrent) !== resolve(expectedCurrentPath)) {
    throw new Error('portal_current_changed_before_promotion');
  }

  const temporaryLink = join(runtime, `.current-${randomUUID()}.tmp`);
  await symlink(relative(runtime, candidate), temporaryLink, 'dir');
  try {
    await rename(temporaryLink, currentLink);
  } finally {
    await rm(temporaryLink, { force: true });
  }
  return candidate;
}

// Acceptance builds use the same snapshot as reconciliation. Requiring a link
// prevents a successful but unconfigured build from reaching a download test.
export async function publicLinksSnapshot(path, inherited, { required = [] } = {}) {
  const keys = ['NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL', 'NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL',
    'NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL', 'NEXT_PUBLIC_PORTAL_IPHONE_DOWNLOAD_URL'];
  let values = {};
  try {
    values = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (Object.keys(values).some((key) => !keys.includes(key))) throw new Error('portal_public_links_unknown_key');
  const env = { ...inherited, ...values };
  const links = Object.fromEntries(keys.map((key) => [key, env[key] ?? '']));
  for (const key of required) {
    if (!keys.includes(key)) throw new Error('portal_public_links_unknown_key');
    if (!links[key]) throw new Error(`portal_public_links_required:${key}`);
  }
  for (const value of Object.values(links)) {
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error('portal_public_links_invalid_url'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('portal_public_links_invalid_url');
  }
  return { env, links, digest: createHash('sha256').update(JSON.stringify(links)).digest('hex') };
}

/**
 * A download link is only certified into a Portal build if it answers 2xx right now.
 * WI-10003250: both Portal download buttons shipped pointing at a page that did not exist,
 * and nothing between the links file and the rendered href ever asked whether it resolved.
 */
async function linkLive(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function assertPublicLinksLive(links, check) {
  for (const [key, value] of Object.entries(links)) {
    if (value && !(await check(value))) throw new Error(`portal_public_links_dead_link:${key}`);
  }
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function reconcilePortal(config, deps = {}) {
  const portalRoot = resolve(config.portalRoot);
  const runtimeRoot = resolve(config.runtimeRoot);
  const receiptPath = join(runtimeRoot, '.papercusp-reconcile.json');
  const candidatePath = join(runtimeRoot, '.papercusp-reconcile-candidate.json');
  const getFingerprint = deps.fingerprint ?? fingerprint;
  const getRelease = deps.releaseAt ?? releaseAt;
  const getReceipt = deps.receiptAt ?? receiptAt;
  const saveReceipt = deps.writeReceipt ?? writeReceipt;
  const getCandidate = deps.candidateAt ?? getReceipt;
  const saveCandidate = deps.writeCandidate ?? saveReceipt;
  const clearCandidate = deps.clearCandidate ?? (async () => rm(candidatePath, { force: true }));
  const getReleaseNames = deps.releaseNames ?? releaseNamesAt;
  const findCandidateRelease = deps.findStagedRelease ?? findStagedRelease;
  const promoteRelease = deps.promoteRelease ?? promoteCurrentRelease;
  const readPublicLinks = () => publicLinksSnapshot(publicLinksEnv, config.env);
  const getPublicLinksDigest = deps.publicLinksDigest ?? (async () => (await readPublicLinks()).digest);
  const checkHealth = deps.healthy ?? healthy;
  const runCommand = deps.run ?? run;
  const withHandoffLock = deps.withHandoffLock ?? withPortalHandoffLock;
  const now = deps.now ?? (() => Date.now());
  const stabilityWindowMs = deps.stabilityWindowMs ?? SOURCE_STABILITY_WINDOW_MS;
  await mkdir(runtimeRoot, { recursive: true });

  const publicLinksEnv = resolve(config.publicLinksEnv
    ?? join(homedir(), '.config/papercusp/portal-public-links.env'));
  const before = await getFingerprint(portalRoot);
  const publicLinks = await readPublicLinks();
  const beforePublicLinksDigest = deps.publicLinksDigest ? await getPublicLinksDigest(publicLinksEnv) : publicLinks.digest;
  const current = await getRelease(runtimeRoot);
  const receipt = await getReceipt(receiptPath);
  const sameRelease = receipt?.releasePath === current.path;
  const sameSource = receipt?.sourceDigest === before.digest
    && receipt?.sourceRootDigest === before.rootDigest;
  const samePublicLinks = receipt?.publicLinksDigest === beforePublicLinksDigest;
  // Availability is independent of source stability. Recover the already-selected
  // immutable release before a changing source tree can defer a rebuild forever.
  // --install-only refreshes the credential boot launcher without promoting any
  // candidate, bypassing freshness checks, or claiming that new source is served.
  if (!(await checkHealth(config.port))) {
    await withHandoffLock(async () => {
      const selected = await getRelease(runtimeRoot);
      if (resolve(selected.path) !== resolve(current.path)) {
        throw new Error('portal_current_changed_before_recovery');
      }
      await runCommand('bash', [config.deployScript, '--install-only'], config.integrationRoot, config.env);
      const systemctl = config.env.PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL || 'systemctl';
      const unit = config.env.PAPERCUSP_CLOUD_PORTAL_UNIT || 'papercusp-cloud-portal.service';
      await runCommand(systemctl, ['--user', 'reset-failed', unit], config.integrationRoot, config.env);
      await runCommand(systemctl, ['--user', 'restart', unit], config.integrationRoot, config.env);
      if (!(await checkHealth(config.port))) throw new Error('portal_recovery_health_failed');
      const recovered = await getRelease(runtimeRoot);
      if (resolve(recovered.path) !== resolve(current.path)) {
        throw new Error('portal_current_changed_during_recovery');
      }
    });
    if (sameRelease && sameSource && samePublicLinks) await clearCandidate(candidatePath);
    return { status: 'recovered', releasePath: current.path };
  }
  if (sameRelease && sameSource && samePublicLinks) {
    await clearCandidate(candidatePath);
    return { status: 'fresh', releasePath: current.path };
  }

  const snapshot = (fingerprintResult, linksDigest, firstSeenAtMs, pendingSinceAtMs = firstSeenAtMs) => ({
    schemaVersion: 1,
    sourceDigest: fingerprintResult.digest,
    sourceRootDigest: fingerprintResult.rootDigest,
    publicLinksDigest: linksDigest,
    firstSeenAtMs,
    pendingSinceAtMs,
  });
  const observedAt = now();
  if (stabilityWindowMs > 0) {
    const candidate = await getCandidate(candidatePath);
    const candidateMatches = candidate?.schemaVersion === 1
      && candidate.sourceDigest === before.digest
      && candidate.sourceRootDigest === before.rootDigest
      && candidate.publicLinksDigest === beforePublicLinksDigest
      && Number.isFinite(candidate.firstSeenAtMs);
    // Accept receipts written before pendingSinceAtMs existed. Persist the age
    // across fingerprint changes, including across separate timer processes.
    const pendingSinceAtMs = candidate?.schemaVersion === 1
      && Number.isFinite(candidate.pendingSinceAtMs ?? candidate.firstSeenAtMs)
      ? Math.min(candidate.pendingSinceAtMs ?? candidate.firstSeenAtMs, observedAt)
      : observedAt;
    const deferralExpired = observedAt - pendingSinceAtMs >= MAX_SOURCE_DEFERRAL_MS;
    if (!candidateMatches) {
      await saveCandidate(candidatePath, snapshot(before, beforePublicLinksDigest, observedAt, pendingSinceAtMs));
      if (!deferralExpired) {
        return { status: 'deferred', reason: 'source_not_stable', releasePath: current.path };
      }
    }
    if (candidateMatches && observedAt - candidate.firstSeenAtMs < stabilityWindowMs && !deferralExpired) {
      return { status: 'deferred', reason: 'source_not_stable', releasePath: current.path };
    }
  }

  await assertPublicLinksLive(publicLinks.links, deps.linkLive ?? linkLive);
  const priorReleaseNames = await getReleaseNames(runtimeRoot);
  const buildEnv = { ...publicLinks.env, PORTAL_BUILD_ONLY: '1', PORTAL_PROMOTE: '0' };
  await runCommand(config.npm, ['run', 'build'], portalRoot, buildEnv);
  const afterBuild = await getFingerprint(portalRoot);
  const afterBuildPublicLinksDigest = await getPublicLinksDigest(publicLinksEnv);
  if (before.rootDigest !== afterBuild.rootDigest) {
    await saveCandidate(candidatePath, snapshot(afterBuild, afterBuildPublicLinksDigest, now()));
    return { status: 'deferred', reason: 'root_source_changed_during_build', releasePath: current.path };
  }
  if (before.digest !== afterBuild.digest) {
    console.warn('cloud-portal-reconcile: linked sources changed during build; handing off the completed release and retaining the earlier digest for the next reconciliation');
  }
  if (beforePublicLinksDigest !== afterBuildPublicLinksDigest) {
    await saveCandidate(candidatePath, snapshot(afterBuild, afterBuildPublicLinksDigest, now()));
    return { status: 'deferred', reason: 'public_links_changed_during_build', releasePath: current.path };
  }

  const stagedRelease = await findCandidateRelease(
    runtimeRoot,
    priorReleaseNames,
    portalRoot,
    before.rootDigest,
  );
  if (resolve(stagedRelease.manifest.sourceRoot ?? '') !== portalRoot
    || stagedRelease.manifest.sourceRootDigest !== before.rootDigest) {
    throw new Error('portal_staged_release_source_mismatch');
  }

  return withHandoffLock(async () => {
    const currentBeforePromotion = await getRelease(runtimeRoot);
    if (resolve(currentBeforePromotion.path) !== resolve(current.path)) {
      return {
        status: 'deferred',
        reason: 'current_changed_during_build',
        releasePath: currentBeforePromotion.path,
      };
    }

    const finalSource = await getFingerprint(portalRoot);
    const finalPublicLinksDigest = await getPublicLinksDigest(publicLinksEnv);
    if (finalSource.rootDigest !== before.rootDigest
      || finalPublicLinksDigest !== beforePublicLinksDigest) {
      await saveCandidate(candidatePath, snapshot(finalSource, finalPublicLinksDigest, now()));
      return {
        status: 'deferred',
        reason: finalSource.rootDigest !== before.rootDigest
          ? 'root_source_changed_before_promotion'
          : 'public_links_changed_before_promotion',
        releasePath: current.path,
      };
    }
    if (before.digest !== finalSource.digest) {
      console.warn('cloud-portal-reconcile: linked sources changed before promotion; recording the earlier digest so the next stable reconciliation rebuilds them');
    }

    try {
      await promoteRelease(runtimeRoot, stagedRelease.path, current.path);
      await runCommand('bash', [config.deployScript, '--handoff'], config.integrationRoot, config.env);
      if (!(await checkHealth(config.port))) throw new Error('portal_handoff_health_failed');
      const deployed = await getRelease(runtimeRoot);
      if (resolve(deployed.path) !== resolve(stagedRelease.path)) {
        throw new Error('portal_current_changed_during_handoff');
      }
    } catch (error) {
      try {
        const actual = await getRelease(runtimeRoot);
        if (resolve(actual.path) === resolve(stagedRelease.path)) {
          await promoteRelease(runtimeRoot, current.path, stagedRelease.path);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'portal_reconcile_promotion_rollback_failed');
      }
      throw error;
    }

    await saveReceipt(receiptPath, {
      schemaVersion: 2,
      releasePath: stagedRelease.path,
      sourceDigest: before.digest,
      sourceRootDigest: before.rootDigest,
      publicLinksDigest: beforePublicLinksDigest,
    });
    await clearCandidate(candidatePath);
    return { status: 'deployed', releasePath: stagedRelease.path };
  });
}

/** A one-shot service must terminate after its lock/DB work, even if the pool keeps handles open. */
export async function settleReconcileProcess(task) {
  let code = 0;
  let message;
  try {
    const result = await task;
    message = `cloud-portal-reconcile: ${result.status} ${result.releasePath}`;
  } catch (error) {
    code = 1;
    message = `cloud-portal-reconcile: ${error instanceof Error ? error.message : String(error)}`;
  }
  const stream = code === 0 ? process.stdout : process.stderr;
  await new Promise((resolveWrite) => stream.write(`${message}\n`, resolveWrite));
  process.exit(code);
}

if (isCliEntry(import.meta.url)) {
  const portalRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_ROOT
    ?? join(homedir(), '.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal'));
  const runtimeRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT
    ?? join(dirname(portalRoot), '.portal-runtime', 'portal'));
  const integrationRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT
    ?? join(scriptDir, '../../../..'));
  settleReconcileProcess(reconcilePortal({
    portalRoot,
    runtimeRoot,
    integrationRoot,
    publicLinksEnv: resolve(process.env.PAPERCUSP_CLOUD_PORTAL_PUBLIC_LINKS_ENV
      ?? join(homedir(), '.config/papercusp/portal-public-links.env')),
    deployScript: process.env.PAPERCUSP_CLOUD_PORTAL_DEPLOY_SCRIPT
      ?? join(scriptDir, 'deploy-cloud-portal.sh'),
    npm: process.env.PAPERCUSP_CLOUD_PORTAL_NPM ?? 'npm',
    port: Number(process.env.PAPERCUSP_CLOUD_PORTAL_PORT ?? 3801),
    env: process.env,
  }));
}
