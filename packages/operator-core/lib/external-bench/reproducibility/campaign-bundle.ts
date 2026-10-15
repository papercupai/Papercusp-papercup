/**
 * Dated campaign bundles — plan benchmark-coverage-frontierswe-v2-2026-10-10 P-022 / D-009.
 *
 * One bundle per completed benchmark campaign:
 *
 *   benchmarks/campaigns/<YYYY-MM-DD>-<campaignId>/manifest.json
 *   benchmarks/campaigns/<YYYY-MM-DD>-<campaignId>/tasks/<arm>/<suite>__<taskId>__seed-<n>.json
 *
 * Each task file holds the attempt's trace pointer, its scorer output and its prediction. The manifest's
 * `complete` flag is a VERDICT computed from the entries (every attempt has a trace or an explicit
 * absence reason, AND scorer output), never an assumption: an incomplete bundle is still built, with the
 * gaps listed, so a missing trace is evidence rather than a silent hole.
 *
 * Known gold/label errors are recorded as corrections beside the raw scores — a correction never
 * overwrites a task's scorer output, and the manifest reports raw and corrected aggregates side by side.
 *
 * `buildCampaignBundle` is pure. Sources adapt into `CampaignEntry` (PG rollouts via
 * `campaignEntryFromRollout`, FrontierSWE results.jsonl via `frontier-swe-resume`). Nothing here
 * publishes anywhere; the bundle is local/repo only (D-009 item 5).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { RolloutRecord } from './schema';
import type { FrontierSweResultRecord } from '../frontier-swe-resume';

/** A pointer to the attempt's trajectory/trace. */
export interface CampaignTraceRef {
  /** The graded agent's trace. */
  ref: string;
  kind?: string | null;
  /** Other agent runs in the same attempt (other solvers, a judge, a navigator, the team lead), in order. */
  related?: string[];
}
/** The trace is knowingly absent — the reason is part of the record, so absence is never silent. */
export interface CampaignTraceAbsent {
  absentReason: string;
}

/** Scorer output for one attempt. `status: 'not-graded'` (e.g. a generation failure) needs a reason. */
export interface CampaignScorer {
  status: string;
  score: number | null;
  resolved?: boolean | null;
  /** Structured scorer output (seam grade.detail / rollout graderOutput). */
  detail?: unknown;
  /** The benchmark's own output, verbatim. */
  raw?: string | null;
  reason?: string;
}

export interface CampaignEntry {
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  trace: CampaignTraceRef | CampaignTraceAbsent | null;
  scorer: CampaignScorer | null;
  /** The exact submission graded (a diff, or an env-handle ref). */
  prediction?: string | null;
}

/** A known gold/label error. Omitting arm/seed applies it to every attempt of the task. */
export interface LabelCorrectionInput {
  suite: string;
  taskId: string;
  arm?: string;
  seed?: number;
  correctedScore: number | null;
  reason: string;
  sourceRef: string;
}

/** A correction as applied to one attempt: the raw score is read from the entry, never supplied. */
export interface AppliedLabelCorrection {
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  rawScore: number | null;
  correctedScore: number | null;
  reason: string;
  sourceRef: string;
}

export interface CampaignMissing {
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  lacks: Array<'trace' | 'scorer'>;
}

export interface ArmAggregate {
  attempts: number;
  /** Attempts with a numeric score. */
  scored: number;
  /** Mean over scored attempts; null when none scored. */
  meanScore: number | null;
}

export interface CampaignManifest {
  schemaVersion: 1;
  campaignId: string;
  /** UTC date of completion, YYYY-MM-DD — the bundle root is dated by it. */
  date: string;
  completedAt: string;
  complete: boolean;
  taskCount: number;
  missing: CampaignMissing[];
  labelCorrections: AppliedLabelCorrection[];
  aggregates: { raw: Record<string, ArmAggregate>; corrected: Record<string, ArmAggregate> };
  /** Bundle-relative task file paths, sorted. */
  files: string[];
  meta?: Record<string, unknown>;
}

export interface CampaignBundleInput {
  campaignId: string;
  completedAt: string | Date;
  entries: CampaignEntry[];
  labelCorrections?: LabelCorrectionInput[];
  meta?: Record<string, unknown>;
}

export interface CampaignBundle {
  /** Repo-relative bundle root: benchmarks/campaigns/<date>-<campaignId>. */
  root: string;
  /** Bundle-relative path → JSON body. Includes manifest.json. */
  files: Array<{ rel: string; body: unknown }>;
  manifest: CampaignManifest;
}

/** Path-safe slug (instance ids carry slashes/colons) — the same rule export.ts uses. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function attemptKey(e: { suite: string; taskId: string; arm: string; seed: number }): string {
  return JSON.stringify([e.suite, e.taskId, e.arm, e.seed]);
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

function hasTrace(t: CampaignEntry['trace']): boolean {
  if (t == null) return false;
  if ('ref' in t) return nonEmpty(t.ref);
  return nonEmpty(t.absentReason);
}

function hasScorer(s: CampaignScorer | null): boolean {
  if (s == null || !nonEmpty(s.status)) return false;
  if (s.status === 'not-graded') return nonEmpty(s.reason);
  return true;
}

function aggregate(entries: CampaignEntry[], scoreOf: (e: CampaignEntry) => number | null): Record<string, ArmAggregate> {
  const byArm = new Map<string, { attempts: number; scored: number; sum: number }>();
  for (const e of entries) {
    const a = byArm.get(e.arm) ?? { attempts: 0, scored: 0, sum: 0 };
    a.attempts += 1;
    const s = scoreOf(e);
    if (typeof s === 'number' && Number.isFinite(s)) {
      a.scored += 1;
      a.sum += s;
    }
    byArm.set(e.arm, a);
  }
  const out: Record<string, ArmAggregate> = {};
  for (const arm of [...byArm.keys()].sort()) {
    const a = byArm.get(arm)!;
    out[arm] = { attempts: a.attempts, scored: a.scored, meanScore: a.scored ? a.sum / a.scored : null };
  }
  return out;
}

/** UTC YYYY-MM-DD of a completion instant; refuses an invalid date rather than writing an undated bundle. */
export function campaignDate(completedAt: string | Date): string {
  const d = completedAt instanceof Date ? completedAt : new Date(completedAt);
  if (Number.isNaN(d.getTime())) throw new Error(`campaign completedAt is not a valid date: ${String(completedAt)}`);
  return d.toISOString().slice(0, 10);
}

/** Build a dated campaign bundle. Pure: no I/O. Throws on an ambiguous input instead of guessing. */
export function buildCampaignBundle(input: CampaignBundleInput): CampaignBundle {
  if (!nonEmpty(input.campaignId)) throw new Error('campaignId is required');
  const date = campaignDate(input.completedAt);
  const completedAt = (input.completedAt instanceof Date ? input.completedAt : new Date(input.completedAt)).toISOString();
  const root = path.posix.join('benchmarks', 'campaigns', `${date}-${slug(input.campaignId)}`);

  const seen = new Set<string>();
  const relSeen = new Set<string>();
  const files: Array<{ rel: string; body: unknown }> = [];
  const missing: CampaignMissing[] = [];
  for (const e of input.entries) {
    const key = attemptKey(e);
    if (seen.has(key)) throw new Error(`duplicate campaign entry ${key}`);
    seen.add(key);
    const rel = path.posix.join('tasks', slug(e.arm), `${slug(e.suite)}__${slug(e.taskId)}__seed-${e.seed}.json`);
    if (relSeen.has(rel)) throw new Error(`two campaign entries slug to the same file ${rel}`);
    relSeen.add(rel);
    const lacks: Array<'trace' | 'scorer'> = [];
    if (!hasTrace(e.trace)) lacks.push('trace');
    if (!hasScorer(e.scorer)) lacks.push('scorer');
    if (lacks.length) missing.push({ suite: e.suite, taskId: e.taskId, arm: e.arm, seed: e.seed, lacks });
    files.push({
      rel,
      body: { suite: e.suite, taskId: e.taskId, arm: e.arm, seed: e.seed, trace: e.trace, scorer: e.scorer, prediction: e.prediction ?? null },
    });
  }

  // Label corrections: resolve each to the attempts it names; one that names nothing is an error, not a no-op.
  const applied: AppliedLabelCorrection[] = [];
  const corrected = new Map<string, number | null>();
  for (const c of input.labelCorrections ?? []) {
    if (!nonEmpty(c.reason) || !nonEmpty(c.sourceRef)) throw new Error(`label correction for ${c.suite}/${c.taskId} needs a reason and a sourceRef`);
    const hits = input.entries.filter((e) => e.suite === c.suite && e.taskId === c.taskId
      && (c.arm === undefined || e.arm === c.arm) && (c.seed === undefined || e.seed === c.seed));
    if (!hits.length) throw new Error(`label correction for ${c.suite}/${c.taskId} matches no attempt in the campaign`);
    for (const e of hits) {
      const key = attemptKey(e);
      if (corrected.has(key)) throw new Error(`two label corrections target ${key}`);
      corrected.set(key, c.correctedScore);
      applied.push({ suite: e.suite, taskId: e.taskId, arm: e.arm, seed: e.seed, rawScore: e.scorer?.score ?? null,
        correctedScore: c.correctedScore, reason: c.reason, sourceRef: c.sourceRef });
    }
  }

  const rawScore = (e: CampaignEntry) => e.scorer?.score ?? null;
  const manifest: CampaignManifest = {
    schemaVersion: 1,
    campaignId: input.campaignId,
    date,
    completedAt,
    complete: missing.length === 0,
    taskCount: input.entries.length,
    missing,
    labelCorrections: applied,
    aggregates: {
      raw: aggregate(input.entries, rawScore),
      corrected: aggregate(input.entries, (e) => {
        const k = attemptKey(e);
        return corrected.has(k) ? corrected.get(k)! : rawScore(e);
      }),
    },
    files: files.map((f) => f.rel).sort(),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  return { root, files: [...files, { rel: 'manifest.json', body: manifest }], manifest };
}

/** Write a built bundle under `baseDir` (the repo root in production). Returns repo-relative paths written. */
export function writeCampaignBundle(bundle: CampaignBundle, baseDir: string): string[] {
  const written: string[] = [];
  for (const f of bundle.files) {
    const rel = path.posix.join(bundle.root, f.rel);
    const abs = path.join(baseDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(f.body, null, 2)}\n`, 'utf8');
    written.push(rel);
  }
  return written;
}

/** The fields of a PG run-result row this adapter reads (structural, so it never drifts from store.ts). */
export interface CampaignResultRow {
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  score?: number | null;
  resolved?: boolean | null;
  graderStatus?: string | null;
}

/** Adapt a PG run result + its rollout card into a campaign entry. A missing rollout leaves trace/scorer gaps visible. */
export function campaignEntryFromRollout(result: CampaignResultRow, rollout: RolloutRecord | null): CampaignEntry {
  const trace: CampaignEntry['trace'] = rollout && nonEmpty(rollout.trajectoryRef)
    ? { ref: rollout.trajectoryRef, kind: rollout.trajectoryKind ?? null }
    : null;
  const scorer: CampaignScorer | null = nonEmpty(result.graderStatus)
    ? { status: result.graderStatus, score: result.score ?? null, resolved: result.resolved ?? null,
        detail: rollout?.graderOutput ?? null, raw: rollout?.rawGraderOutput ?? null }
    : null;
  return { suite: result.suite, taskId: result.taskId, arm: result.arm, seed: result.seed, trace, scorer,
    prediction: rollout?.submission ?? null };
}

/** traceRefs (graded agent first) → the entry's trace; no real pointer → null, so the gap is reported. */
function frontierSweTrace(refs: string[] | undefined): CampaignTraceRef | null {
  const real = (refs ?? []).filter(nonEmpty);
  if (real.length === 0) return null;
  return real.length > 1 ? { ref: real[0]!, related: real.slice(1) } : { ref: real[0]! };
}

/**
 * Adapt FrontierSWE results.jsonl records (frontier-swe-resume) into campaign entries. Only the LATEST record per
 * (instance, arm, seed) counts — results.jsonl is append-only and resume re-runs infra failures. A record with no
 * traceRefs maps to trace=null, so the bundle reports the missing trace instead of inventing one. traceRefs[0] is the
 * graded agent's trace; the rest become trace.related.
 */
export function campaignEntriesFromFrontierSweResults(records: FrontierSweResultRecord[], suite: string, defaultArm = 'default'): CampaignEntry[] {
  const latest = new Map<string, FrontierSweResultRecord>();
  for (const r of records) latest.set(JSON.stringify([r.instanceId, r.arm ?? defaultArm, r.seed]), r);
  return [...latest.values()].map((r) => ({
    suite,
    taskId: r.instanceId,
    arm: r.arm ?? defaultArm,
    seed: r.seed,
    trace: frontierSweTrace(r.traceRefs),
    scorer: nonEmpty(r.graderStatus)
      ? { status: r.graderStatus, score: r.score, resolved: r.resolved, ...(r.graderDetail !== undefined ? { detail: r.graderDetail } : {}) }
      : null,
  }));
}
