import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * FrontierSWE v2 control ledger → per-version task admission (plan benchmark-coverage-frontierswe-v2-2026-10-10
 * P-007, WI-10008254). A v2 task enters a SCORED task set only when its controls, measured at the SAME corpus
 * version, show the task can discriminate:
 *
 *   - FSWE-P007-GOLD@1  — the gold (reference-solution) control must earn FULL reward (1). Anything lower means the
 *     verifier cannot reach full marks even with the answer, so an arm's score there measures the task, not the arm.
 *   - FSWE-P007-EMPTY@1 — the empty (untouched starting code) control must earn ZERO. A positive empty reward means
 *     the verifier pays for doing nothing.
 *   - acceptance R-5 falsifier — a task with NO control evidence for its version must not enter a reported set
 *     either. Missing evidence, an errored control and a control measured at another corpus commit or image all
 *     exclude: fail closed, never "assume it is fine".
 *
 * The ledger is the JSONL the controls runner (scripts/frontier-swe-controls.ts) writes, one row per (task, mode),
 * carrying `corpusCommit` + `dockerImage`; evidence counts only when both equal the task's `upstreamCommit` /
 * `dockerImage`, so a re-pinned corpus needs fresh controls. Several rows for one (task, mode) — re-runs — resolve to
 * the LATEST by `finishedAt` (file order breaks ties), so re-running a control supersedes the earlier verdict.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from './types';

/** One control row as the controls runner writes it (the fields admission reads; the rest ride along). */
export interface FrontierSweControlLedgerRow {
  instanceId: string;
  mode: string;
  graderStatus: string;
  score: number | null;
  finishedAt?: string;
  corpusCommit?: string | null;
  dockerImage?: string | null;
  /** Absent on the historical open-egress campaign; those rows remain provisional. */
  networkPolicy?: { declaredMode: string; agentNetworkMode: string };
}

/** Why a task is out of the scored set. A task can carry several (e.g. no gold AND a positive empty). */
export type FrontierSweControlExclusion =
  | 'no-gold-control'
  | 'no-empty-control'
  | 'gold-control-error'
  | 'empty-control-error'
  | 'gold-network-unverified'
  | 'empty-network-unverified'
  | 'gold-below-full'
  | 'empty-above-zero';

export interface FrontierSweControlExcluded {
  instanceId: string;
  reasons: FrontierSweControlExclusion[];
  /** The deciding control scores (null = no usable row). */
  gold: number | null;
  empty: number | null;
}

export interface FrontierSweControlAdmission {
  admitted: BenchTask[];
  excluded: FrontierSweControlExcluded[];
}

/** Full reward for a v2 verifier (rewards are in [0, 1]). */
const FULL_REWARD = 1;

/** The published v2 control ledger (env-overridable), beside the v2 corpus it judges. */
export function frontierSweV2ControlsPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL ??
    papercuspPath('bench-results', 'frontier-swe-v2', 'controls.jsonl')
  );
}

/**
 * Read a control ledger. A missing file is an EMPTY ledger (every task then lacks evidence and is excluded); a line
 * that does not parse, or a row without an instanceId/mode, THROWS — silently skipping it would turn a corrupt
 * evidence row into a missing one without anyone noticing.
 */
export function readFrontierSweControlLedger(path: string): FrontierSweControlLedgerRow[] {
  if (!existsSync(path)) return [];
  const rows: FrontierSweControlLedgerRow[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (e) {
        throw new Error(`FrontierSWE control ledger ${path}:${i + 1} is not JSON (${e instanceof Error ? e.message : String(e)})`);
      }
      const r = row as Partial<FrontierSweControlLedgerRow>;
      if (typeof r.instanceId !== 'string' || typeof r.mode !== 'string') {
        throw new Error(`FrontierSWE control ledger ${path}:${i + 1} has no instanceId/mode`);
      }
      rows.push(r as FrontierSweControlLedgerRow);
    });
  return rows;
}

type ControlRead = { kind: 'missing' } | { kind: 'error' } | { kind: 'scored'; score: number; networkVerified: boolean };

/** The latest row for (task, mode) measured at the task's own version. */
function readControl(task: BenchTask, mode: 'gold' | 'empty', ledger: FrontierSweControlLedgerRow[]): ControlRead {
  const commit = task.graderMeta?.['upstreamCommit'];
  const image = task.graderMeta?.['dockerImage'];
  if (typeof commit !== 'string' || !commit) return { kind: 'missing' }; // an unversioned task can have no evidence
  let latest: FrontierSweControlLedgerRow | undefined;
  for (const row of ledger) {
    if (row.instanceId !== task.instanceId || row.mode !== mode) continue;
    if (row.corpusCommit !== commit) continue;
    if (row.dockerImage !== image) continue;
    if (!latest || (row.finishedAt ?? '') >= (latest.finishedAt ?? '')) latest = row;
  }
  if (!latest) return { kind: 'missing' };
  const scored = latest.graderStatus === 'passed' || latest.graderStatus === 'failed';
  if (!scored || typeof latest.score !== 'number' || !Number.isFinite(latest.score) || latest.score < 0 || latest.score > 1) {
    return { kind: 'error' };
  }
  const declaredMode = typeof task.graderMeta?.['networkMode'] === 'string' ? task.graderMeta['networkMode'].trim() : '';
  const networkVerified = ['allowlist', 'no-network', 'none'].includes(declaredMode) &&
    latest.networkPolicy?.declaredMode === declaredMode && latest.networkPolicy.agentNetworkMode === 'none';
  return { kind: 'scored', score: latest.score, networkVerified };
}

/**
 * Split `tasks` into those whose controls admit them and those excluded, with every reason. Pure — the caller
 * decides what to do with the excluded list (the loader drops them; a report discloses them).
 */
export function admitByFrontierSweControls(tasks: BenchTask[], ledger: FrontierSweControlLedgerRow[]): FrontierSweControlAdmission {
  const admitted: BenchTask[] = [];
  const excluded: FrontierSweControlExcluded[] = [];
  for (const task of tasks) {
    const gold = readControl(task, 'gold', ledger);
    const empty = readControl(task, 'empty', ledger);
    const reasons: FrontierSweControlExclusion[] = [];
    if (gold.kind === 'missing') reasons.push('no-gold-control');
    else if (gold.kind === 'error') reasons.push('gold-control-error');
    else {
      if (gold.score !== FULL_REWARD) reasons.push('gold-below-full');
      if (!gold.networkVerified) reasons.push('gold-network-unverified');
    }
    if (empty.kind === 'missing') reasons.push('no-empty-control');
    else if (empty.kind === 'error') reasons.push('empty-control-error');
    else {
      if (empty.score !== 0) reasons.push('empty-above-zero');
      if (!empty.networkVerified) reasons.push('empty-network-unverified');
    }
    if (reasons.length === 0) admitted.push(task);
    else {
      excluded.push({
        instanceId: task.instanceId,
        reasons,
        gold: gold.kind === 'scored' ? gold.score : null,
        empty: empty.kind === 'scored' ? empty.score : null,
      });
    }
  }
  return { admitted, excluded };
}
