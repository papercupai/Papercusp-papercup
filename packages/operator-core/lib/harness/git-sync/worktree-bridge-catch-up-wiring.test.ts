/**
 * WI-10003772 — wiring guard for the worktree-bridge retry sweep.
 *
 * The defect this pins was not in the retry mechanism: `bridgeStagingShaToWorktree`
 * was already documented and tested as "the RETRY path … call it from the sweep".
 * It was that NO caller ever ran a sweep. `runWorktreeBridgeLeg` returned early on
 * an idle tick (`if (feRows.length === 0) return;`), so a member whose advance was
 * deferred by a dirty overlap stayed on stale staging after the dirt drained
 * (P-505 run 25: its next commit conflicted at the integrator and staging froze).
 *
 * The mechanism is covered behaviourally in
 * `sync/pot-git/worktree-bridge.integration.test.ts`. This file pins the part a
 * library test cannot see: that the git-sync leg actually CALLS it, on the idle
 * path and after every tick (WI-10006476: accepting ticks too). `runWorktreeBridgeLeg` is internal and
 * PG-coupled, so the pin reads its source, scoped to the function body.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = process.env.WORKTREE_CATCH_UP_WIRING_SOURCE ?? join(here, 'git-sync-action.ts');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found in ${SOURCE_PATH}`).toBeGreaterThanOrEqual(0);
  // The next top-level declaration ends the body.
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('WI-10003772: runWorktreeBridgeLeg runs the deferred-advance retry sweep', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const leg = functionBody(source, 'async function runWorktreeBridgeLeg(');

  it('the idle branch (no new announcements) retries the persisted watermark before returning', () => {
    const idle = leg.match(/if \(feRows\.length === 0\) \{([\s\S]*?)\n    \}/);
    expect(idle, 'the idle branch must be a block, not a bare early return').not.toBeNull();
    expect(idle![1]).toMatch(/runWorktreeCatchUp\([^)]*priorWatermark\.stagingSha/);
    expect(leg).not.toMatch(/if \(feRows\.length === 0\) return;/);
  });

  // WI-10006476 (D-055): EVERY tick with a watermark sweeps, accepting ticks included. The
  // tick's own advance returns a conflict as an unrecorded `diverged-manual`, and while a
  // peer keeps committing every tick accepts — the old `acceptedCount === 0` gate meant a
  // live hive never recorded the divergence (c1006k, 10:52Z + 11:02Z ticks).
  it('every tick with a watermark retries against it, accepting ticks included', () => {
    expect(leg).toMatch(/if \(outcome\.watermark\.stagingSha\) \{\s*await runWorktreeCatchUp\(/);
    expect(leg).not.toMatch(/acceptedCount === 0 &&[^{]*\{\s*await runWorktreeCatchUp\(/);
  });

  it('the sweep delegates to the ff-only, dirty-safe library catch-up', () => {
    const sweep = functionBody(source, 'async function runWorktreeCatchUp(');
    expect(sweep).toMatch(/catchUpWorktreeToWatermark\(/);
  });

  // WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055: a member/hive
  // content conflict must be persisted, not just returned. Both call sites pass the
  // prior state read in the same SELECT, and the sweep writes the transition.
  it('the sweep persists a conflicting divergence (D-055)', () => {
    const sweep = functionBody(source, 'async function runWorktreeCatchUp(');
    expect(sweep).toMatch(/nextWorktreeDivergence\(/);
    expect(sweep).toMatch(/patchRoutineMetadata\([^)]*worktree_divergence/);
    expect(source).toMatch(/metadata->'worktree_divergence' AS worktree_divergence/);
    expect(source.match(/await runWorktreeCatchUp\(catchUpCtx,/g)?.length).toBe(2);
  });

  // WI-10006507 / D-055 step 2: the recorded conflict is RESOLVED, not just recorded. The
  // sweep hands it to the merge-resolver (deduped by the in-flight marker), persists the
  // dispatch mark, and the resolver is told to merge the hive head, not the push remote.
  it('the sweep dispatches the merge-resolver for a recorded conflict and persists the dispatch mark', () => {
    const sweep = functionBody(source, 'async function runWorktreeCatchUp(');
    expect(sweep).toMatch(/divergenceResolverDispatch\(next\)/);
    expect(sweep).toMatch(/if \(next && dispatch && !\(await resolverInFlight\(slug, ctx\.workspaceId\)\)\) \{/);
    expect(sweep).toMatch(/await spawnMergeResolver\([^;]*\{ mergeRef: dispatch\.mergeRef \}\)/);
    expect(sweep).toMatch(/next = \{ \.\.\.next, resolverDispatchedAt: now \};\s*write = true;/);
    expect(sweep).toMatch(/if \(write\) await patchRoutineMetadata\(slug, ctx\.workspaceId, \{ worktree_divergence: next \}\)/);
  });

  // WI-10006833: a member without the resolver's agent CLI (a Server install ships none)
  // died `spawn claude ENOENT` on every dispatch. The runtime is probed BEFORE the dispatch
  // is computed, and its result is what divergenceResolverDispatch sees.
  it('the sweep probes the resolver runtime before computing the dispatch', () => {
    const sweep = functionBody(source, 'async function runWorktreeCatchUp(');
    const probeAt = sweep.search(
      /applyResolverRuntimeProbe\(next, await probeMergeResolverRuntime\(slug, ctx\.workspaceId\), now\)/,
    );
    const dispatchAt = sweep.indexOf('divergenceResolverDispatch(next)');
    expect(probeAt, 'the runtime preflight is missing from the sweep').toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(dispatchAt);
    expect(sweep).toMatch(/if \(divergenceAwaitsResolver\(next\)\) \{/);
    expect(sweep).toMatch(/if \(applied\.change !== null\) write = true;\s*next = applied\.next;/);
  });

  it('probeMergeResolverRuntime probes the role the conflict launch blueprint names', () => {
    const probe = functionBody(source, 'async function probeMergeResolverRuntime(');
    expect(probe).toMatch(/resolveLaunchTargetForEvent\(CONFLICT_EVENT, \{ installSlug: slug, workspaceId \}\)/);
    expect(probe).toMatch(/probeRoleRuntime\(target\.role\)/);
    expect(probe).toMatch(/return p\.ok \? \{ ok: true \} : \{ ok: false, runtime: p\.bin \};/);
  });

  it('spawnMergeResolver forwards mergeRef to the resolver in its --git-sync-conflict extra', () => {
    const spawn = functionBody(source, 'async function spawnMergeResolver(');
    expect(spawn).toMatch(/opts: \{ mergeRef\?: string \} = \{\}/);
    expect(spawn).toMatch(/JSON\.stringify\(\{ scopes, files: filesSummary, authorship, \.\.\.\(opts\.mergeRef \? \{ mergeRef: opts\.mergeRef \} : \{\}\) \}\)/);
  });

  it('the merge-resolver prompt merges mergeRef (no fetch, no rebase) when the extra carries it', () => {
    const prompt = readFileSync(
      process.env.MERGE_RESOLVER_PROMPT_SOURCE ??
        join(here, '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/merge-resolver.md'),
      'utf8',
    );
    expect(prompt).toMatch(/carries a `mergeRef`/);
    expect(prompt).toMatch(/`git merge --no-edit <mergeRef>`/);
    expect(prompt).toMatch(/do NOT fetch/);
    expect(prompt).toMatch(/never a rebase/);
  });

  it('the merge-resolver prompt fetches the checked-out branch into its remote-tracking ref', () => {
    const prompt = readFileSync(
      process.env.MERGE_RESOLVER_PROMPT_SOURCE ??
        join(here, '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/merge-resolver.md'),
      'utf8',
    );
    expect(prompt).toContain('git fetch origin "+refs/heads/$BR:refs/remotes/origin/$BR"');
    expect(prompt).toContain('git merge --no-edit "origin/$BR"');
    expect(prompt).not.toContain('git fetch origin "$BR"');
  });
});
