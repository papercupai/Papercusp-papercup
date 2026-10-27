#!/usr/bin/env -S tsx
/**
 * One cleanup-campaign round (code-cleanup-campaigns-2026-10-26 P-009, R-8; D-015, D-017).
 *
 *   node --max-old-space-size=3072 --import ./node_modules/tsx/dist/loader.mjs \
 *     scripts/code-cleanup-campaign-round.mts <config.json>
 *
 * Config: { root, workspaceId, harness, campaignId, runnerItemId, self, out,
 *           aggressiveness?, defaultReview?, cap?, running?, maxPaths?, live? }
 *
 * Like scripts/clone-family-sweep.mts, only this child enumerates and parses the repository.
 * It ranks clone families, turns the top ones (bounded by a triage path budget) into triage inputs,
 * reads change history, pre-triages them, reads the coverage map for the surviving families' members
 * only (at most 50 paths), reads the landed batches and gate reds, and runs planCampaignRound with
 * the native deps. The full result (including each
 * started batch's planned edits) is written to `out`; a summary is printed.
 *
 * Dry by default. `live: true` files diverged-copy bugs, saves a throttle trip, and admits batches
 * whose locks the applying agent takes on the edit path (D-017): it applies no edit itself.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { coverageHash } from '@papercusp/test-config/test-coverage-map';
import { CloneIndex, classifyClonePath } from '../packages/operator-core/lib/code-intelligence/clone-index';
import { cloneSweepInputSchema, rankCloneSweep } from '../packages/operator-core/lib/code-intelligence/clone-sweep';
import { FULL_WINDOW_HISTORY_BOUNDS, readHistoryCommits } from '../packages/operator-core/lib/code-intelligence/change-history';
import { readNativeCoverageScope } from '../packages/operator-core/lib/code-intelligence/test-coverage-map';
import { planCampaignRound } from '../packages/operator-core/lib/code-cleanup/campaign-runner';
import { editPathAcquire, nativeCampaignRoundDeps, readNativeThrottleInputs } from '../packages/operator-core/lib/code-cleanup/campaign-native';
import { coverageViewFromScope, type CleanupAggressiveness, type CoverageView } from '../packages/operator-core/lib/code-cleanup/executor';
import { DEFAULT_CAMPAIGN_REVIEW, type CampaignReview } from '../packages/operator-core/lib/code-cleanup/campaign-plan';
import { DEFAULT_REGRESSION_WINDOW_MS } from '../packages/operator-core/lib/code-cleanup/throttle';
import { boundCoveragePaths, nativeDivergenceBugLookup, nativeMemberHistory, selectRoundFamilies, triageCloneFamilies,
  triageFamilyFromRanked, type TriageFamily } from '../packages/operator-core/lib/code-cleanup/triage';
import { listFilesIncludingUntracked } from './lib/tracked-files.mjs';

/** readTestCoverage answers for at most 50 source paths; a round never asks past that. */
const COVERAGE_PATH_LIMIT = 50;
/** Bounds triage cost (file reads and co-change queries), not coverage: coverage is read only
 * for the families that survive triage (boundCoveragePaths). Round 4 (2026-10-27) triaged 36
 * families, and 3 survived. */
const TRIAGE_PATH_LIMIT = 1000;

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  root: string; workspaceId: string; harness: string; campaignId: string; runnerItemId: string; self: string; out: string;
  aggressiveness?: CleanupAggressiveness; defaultReview?: CampaignReview; cap?: number; running?: string[];
  maxPaths?: number; live?: boolean;
};
for (const key of ['root', 'workspaceId', 'harness', 'campaignId', 'runnerItemId', 'self', 'out'] as const) {
  if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Campaign round config needs ${key}`);
}
if (!isAbsolute(config.root) || !isAbsolute(config.out)) throw new Error('Campaign round root and out must be absolute');
const root = realpathSync(config.root);
const now = new Date();
const live = config.live === true;

// ── corpus + clone index (the sweep's population rules) ─────────────────────
const corpus = listFilesIncludingUntracked(root);
if (corpus.unscanned.length) throw new Error(`Campaign round corpus incomplete: ${corpus.unscanned.join(', ')}`);
const index = new CloneIndex();
const incomplete: string[] = [];
for (const path of [...new Set<string>(corpus.files)].sort()) {
  if (!/\.tsx?$/.test(path) || /\.d\.ts$|\.gen\.tsx?$/.test(path)) continue;
  const classification = classifyClonePath(path);
  if (classification.test || classification.retired) continue;
  const absolute = resolve(root, path);
  if (!lstatSync(absolute).isFile() || relative(root, realpathSync(absolute)).startsWith('..')) { incomplete.push(path); continue; }
  const file = index.update({ path, source: readFileSync(absolute, 'utf8') }).file;
  if (file.status === 'syntax-error' || file.status === 'unavailable') incomplete.push(path);
}
if (!index.size || incomplete.length) throw new Error(`Campaign round corpus incomplete: ${incomplete.join(', ') || 'empty source census'}`);

// ── ranked families, bounded by the coverage map's path limit ───────────────
const ranked = rankCloneSweep(index, cloneSweepInputSchema.parse({ root }), now);
const pathLimit = config.maxPaths ?? TRIAGE_PATH_LIMIT;
const selection = selectRoundFamilies(ranked, pathLimit);
const memberPaths = new Set(selection.memberPaths);
const read = (path: string) => readFile(join(root, path), 'utf8');
const families: TriageFamily[] = [];
for (const row of selection.chosen) families.push(await triageFamilyFromRanked(row, read));

// ── history, coverage, throttle inputs ──────────────────────────────────────
// The in-process cap (1000 commits) never reads complete on a tree that commits every few minutes,
// and triage excludes every family whose history is incomplete. This child has its own heap.
const historyRead = await readHistoryCommits(root, now.toISOString(), undefined, FULL_WINDOW_HISTORY_BOUNDS);
const history = { commits: historyRead.commits, end: now.toISOString(), commit: historyRead.commit, complete: historyRead.complete };

// Only families that survive triage need coverage. Pre-triage (planCampaignRound triages again over
// the same index-backed history, which is cheap) and read coverage for the survivors' members.
const divergenceBug = nativeDivergenceBugLookup({ workspaceId: config.workspaceId, harness: config.harness });
// Member-level co-change (D-022). One lookup serves both triages: its per-range cache means the
// round's own triage runs no git.
const memberHistory = nativeMemberHistory(root);
const preTriage = await triageCloneFamilies({ families, history, divergenceBug, memberHistory });
const coverageBound = boundCoveragePaths(preTriage.batches, COVERAGE_PATH_LIMIT);
const dropped = new Set(coverageBound.dropped);
const roundFamilies = families.filter(f => !dropped.has(f.id));

const NO_COVERAGE: CoverageView = { takenAt: { commit: null, observedAt: null }, coveringTests: () => null };
let coverage = NO_COVERAGE;
let coverageNote = 'no surviving family members';
if (coverageBound.paths.length) {
  const paths = coverageBound.paths;
  const sourceFiles = await Promise.all(paths.map(async path => ({ path, sha256: coverageHash(await readFile(join(root, path))) })));
  const scope = await readNativeCoverageScope({
    surface: 'completion', workspaceId: config.workspaceId, owner: config.self, invocation: 'code-cleanup:campaign-round',
    paths, sourceVersion: coverageHash(JSON.stringify(sourceFiles.map(s => [s.path, s.sha256]))),
    repository: { workspaceId: config.workspaceId, rootPath: root, harness: config.harness }, sourceFiles,
  }, AbortSignal.timeout(60_000));
  if (scope) { coverage = await coverageViewFromScope(root, scope); coverageNote = `${scope.snapshots.length} source-bound snapshot(s)`; }
  else coverageNote = 'the coverage map has no source-bound scope for the member paths: every member reads as uncovered';
}

const throttleInputs = await readNativeThrottleInputs({
  workspaceId: config.workspaceId, harness: config.harness, root, campaignId: config.campaignId,
  windowStart: new Date(now.getTime() - DEFAULT_REGRESSION_WINDOW_MS), windowEnd: now,
});

// ── the round ───────────────────────────────────────────────────────────────
const deps = nativeCampaignRoundDeps({
  root, workspaceId: config.workspaceId, harness: config.harness, runnerItemId: config.runnerItemId,
  defaultReview: config.defaultReview ?? DEFAULT_CAMPAIGN_REVIEW, ...(live ? { acquire: editPathAcquire } : {}), memberHistory,
});
const result = await planCampaignRound({
  campaignId: config.campaignId, self: config.self, aggressiveness: config.aggressiveness ?? 'safe',
  families: roundFamilies, history, coverage, running: config.running ?? [],
  reds: throttleInputs.reds, landed: throttleInputs.landed, cap: config.cap, now, dryRun: !live,
}, deps);

const inputs = {
  indexed: index.size, ranked: ranked.length, chosenFamilies: families.length, notChosen: selection.skipped,
  memberPaths: memberPaths.size, pathLimit,
  survivingFamilies: preTriage.batches.reduce((n, b) => n + b.families.length, 0),
  survivingByBasis: preTriage.batches.flatMap(b => b.families).reduce<Record<string, number>>(
    (n, f) => ({ ...n, [f.coChange.basis]: (n[f.coChange.basis] ?? 0) + 1 }), {}),
  coveragePaths: coverageBound.paths.length, coverageDropped: coverageBound.dropped.length,
  historyCommits: history.commits.length, historyComplete: history.complete, coverage: coverageNote,
  landed: throttleInputs.landed.length, reds: throttleInputs.reds.length, redsWithoutRadius: throttleInputs.redsWithoutRadius,
};
writeFileSync(config.out, JSON.stringify({
  schemaVersion: 1, at: now.toISOString(), live, inputs, memberPaths: [...memberPaths].sort(),
  coveragePaths: coverageBound.paths, coverageDropped: coverageBound.dropped, result,
}, null, 2));
console.log(JSON.stringify({
  schemaVersion: 1, live, out: config.out, inputs,
  excluded: result.excluded.length, diverged: result.diverged.length, divergedFiled: result.divergedFiled.length,
  withheldUnits: result.withheldUnits.length, codemodRefused: result.codemodRefused.length,
  withheldBatches: result.withheldBatches.map(b => ({ batchId: b.batchId, reason: b.reason, detail: b.detail })),
  started: result.started.map(b => ({ batchId: b.batchId, lockId: b.lockId, targetFiles: b.targetFiles, families: b.familyIds })),
  skipped: result.skipped.map(s => ({ batchId: s.batchId, reason: s.reason })),
  throttle: { tripped: result.throttle.tripped, count: result.throttle.count, throttled: result.throttle.state.throttled },
}));
// A single-use CLI must release the pool the native readers opened.
const { getOrgPg } = await import('@papercusp/db-org');
await getOrgPg().sql.end({ timeout: 5 });
