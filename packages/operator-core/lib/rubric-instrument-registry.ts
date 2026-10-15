/**
 * Rubric instrument registry (test-rubric-unification-2026-10-12 P-005 / R-5, plan D-006).
 *
 * A rubric criterion that binds an instrument (`check: { kind:'instrument', instrumentKey }`
 * or the legacy criterion-level `instrumentKey` / trailing `[instrumentKey: …]` model token)
 * claims that SOMETHING measures it. Before this registry that claim was free text: a live
 * census (2026-10-13, D-006) found ~60 distinct keys across stored rubrics with no evaluator
 * behind them, so a grader read the key, found nothing to run, and rated by hand.
 *
 * This module is the single answer to "is this key measurable, and how":
 *
 *   - COMMAND instruments run an argv (no shell) on the host and parse one number out of
 *     stdout, optionally as the rate between two samples. Seeded with the performance
 *     audit's host instruments, whose names (`host:psi-cpu-some-avg10-pct`, …) are reused
 *     VERBATIM from docs/audits/application-performance-reliability-audit-2026-10-01-evidence.json
 *     so a rubric can bind the same key the audit recorded.
 *   - PLATFORM instruments are the keys scorecards.ts already resolves in-process into
 *     platform-computed instrument snapshots (goal-mode, holder-behavior, gate-reuse audit).
 *     They are registered here so authoring accepts them; scorecards.ts derives its resolver
 *     set from {@link platformComputedInstrumentKeys} instead of a second hand-kept list.
 *   - `none` is the explicit MANUAL contract and is never looked up.
 *
 * Authoring (rubrics:propose / rubrics:amend) refuses a NEW or CHANGED binding to a key
 * that is not registered; a key carried unchanged from the stored revision of the same
 * criterion is grandfathered and reported, so the ~60 legacy rubrics stay amendable.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveCriterionInstrumentKey } from './rubrics';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import { HOLDER_BEHAVIOR_INSTRUMENT_KEYS } from './goal-holder-behavior-metrics';
import { GOAL_MODE_INSTRUMENT_KEYS } from './goal-mode-computed-instruments';
import { GATE_REUSE_AUDIT_INSTRUMENT_KEY } from './release/gate-fire-ledger';
import { DISK_HEADROOM_SOAK_INSTRUMENT_KEY } from './storage/retention-interval-evidence';
import { PG_TABLE_GROWTH_INSTRUMENT_KEY } from './storage/pg-table-growth';
import {
  NATIVE_ADOPTION_INSTRUMENT_KEYS, measureNativeAdoptionWindow,
  nativeAdoptionCriterionForInstrument, rateNativeAdoption,
} from './code-intelligence/native-adoption';

/** The explicit manual binding: the criterion is deliberately graded by a person. */
export const MANUAL_INSTRUMENT_KEY = 'none';

/** The unchanged R-1 bakeoff artifact also supplies the approved R-2/R-3 outcomes. */
export const BM25_LATENCY_ARTIFACT_PATH = 'docs/evidence/bm25-bakeoff-work-items-2026-10-11.json';
export const BM25_LATENCY_INSTRUMENT_KEY = `${BM25_LATENCY_ARTIFACT_PATH}:summaries[method=pgts].p95Ms|p50Ms,n,corpus.rows,corpus.source,generatedAt,commit,serverVersion,versions.bake_pgts,loadavg`;
export const BM25_LATENCY_ARTIFACT_IDENTITY = Object.freeze({
  generatedAt: '2026-10-11T11:27:55.979Z',
  commit: 'c20d6c21f9bc37ff4c2cf1b3ad9b65346b2d6572',
  sha256: 'f605e046cefdad7d84e1010cf37b3cf8301b60e638b76cb4417f4bce381bc651',
});

/** Validate original artifact fields, never the baseline rows or top-level queries count. */
export function parseBm25LatencyArtifact(artifact: unknown): {
  verdict: 'pass' | 'fail' | 'unknown';
  reason?: string;
  criteria?: Record<'r-2' | 'r-3', { verdict: 'pass' | 'fail'; valueMs: number; limitMs: number }>;
  corpus?: Record<string, unknown>;
  forms?: Record<string, unknown>[];
  serverVersion?: string;
  versions?: Record<string, unknown>;
  loadavg?: Record<string, unknown>;
} {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const positiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const unknown = (reason: string) => ({ verdict: 'unknown' as const, reason });
  if (!object(artifact) || artifact.kind !== 'bm25-bakeoff' ||
      artifact.plan !== 'bm25-lexical-search-evoke-adoption-2026-10-10' ||
      artifact.generatedAt !== BM25_LATENCY_ARTIFACT_IDENTITY.generatedAt ||
      artifact.commit !== BM25_LATENCY_ARTIFACT_IDENTITY.commit) {
    return unknown('The artifact must have the original R-1 run identity.');
  }
  if (!object(artifact.corpus) || artifact.corpus.key !== 'work-items' ||
      artifact.corpus.source !== 'operator-db-copy' || !positiveInteger(artifact.corpus.rows) ||
      !text(artifact.serverVersion) || !object(artifact.versions) || !text(artifact.versions.bake_pgts)) {
    return unknown('The live corpus row count, source and server/pgts versions are required.');
  }
  const load = artifact.loadavg;
  if (!object(load) || !positiveInteger(load.cores) ||
      ![load.start, load.end].every(v => Array.isArray(v) && v.length === 3 && v.every(nonnegative))) {
    return unknown('Original load context is required; it never changes the latency limits.');
  }
  if (!Array.isArray(artifact.summaries)) return unknown('Timed pgts summaries are missing.');
  const selected = artifact.summaries.filter(row => object(row) && row.method === 'pgts');
  const forms: Record<string, unknown>[] = [];
  for (const variant of ['short', 'title']) {
    const rows = selected.filter(row => row.variant === variant);
    if (rows.length !== 1) return unknown(`Exactly one pgts ${variant} summary is required.`);
    const row = rows[0];
    if (!positiveInteger(row.n) || row.n < 1000 || !nonnegative(row.p50Ms) ||
        !nonnegative(row.p95Ms) || row.p50Ms > row.p95Ms ||
        !Number.isSafeInteger(row.errors) || (row.errors as number) < 0) {
      return unknown(`The pgts ${variant} timed sample is incomplete or malformed.`);
    }
    forms.push({ method: 'pgts', variant, n: row.n, p50Ms: row.p50Ms, p95Ms: row.p95Ms, errors: row.errors });
  }
  if (selected.length !== 2) return unknown('Unexpected pgts query form in the original artifact.');
  const p95 = Math.max(...forms.map(row => row.p95Ms as number));
  const p50 = Math.max(...forms.map(row => row.p50Ms as number));
  const hasErrors = forms.some(row => (row.errors as number) > 0);
  const criteria = {
    'r-2': { verdict: !hasErrors && p95 <= 50 ? 'pass' as const : 'fail' as const, valueMs: p95, limitMs: 50 },
    'r-3': { verdict: !hasErrors && p50 <= 10 ? 'pass' as const : 'fail' as const, valueMs: p50, limitMs: 10 },
  };
  return { verdict: Object.values(criteria).every(c => c.verdict === 'pass') ? 'pass' : 'fail',
    criteria, corpus: { ...artifact.corpus }, forms, serverVersion: artifact.serverVersion,
    versions: { bake_pgts: artifact.versions.bake_pgts }, loadavg: { ...load } };
}

export type InstrumentUnit = '%' | 'cores' | 's' | 'ms' | 'count';

export interface InstrumentParseContext {
  /** Epoch ms at which the sample was taken (for age-style instruments). */
  now: number;
}

export interface CommandInstrument {
  key: string;
  evaluator: 'command';
  description: string;
  unit: InstrumentUnit;
  /** Executable + arguments, run WITHOUT a shell. */
  argv: readonly [string, ...string[]];
  /**
   * Keep stdout when the command exits non-zero: for a command that reports every sub-result on
   * stdout and folds failures into its exit code (multi-URL curl), so the parser judges them.
   * A command killed by its timeout still fails.
   */
  acceptNonZeroExit?: boolean;
  timeoutMs: number;
  /** One number from stdout, or null when stdout does not carry the expected shape. */
  parse(stdout: string, ctx: InstrumentParseContext): number | null;
  /**
   * Two-sample instruments (a cumulative counter): the argv runs twice `intervalMs` apart
   * and the reading is `combine(first, second, elapsedMs)`.
   */
  sample?: { intervalMs: number; combine(first: number, second: number, elapsedMs: number): number };
  /**
   * Two-sample instruments that need BOTH raw outputs (a rate read beside an instantaneous
   * value, e.g. swap-in pages plus memory PSI from one `cat`). The argv runs twice
   * `intervalMs` apart and the reading is `combine(firstStdout, secondStdout, elapsedMs)`;
   * `parse` still runs on the first sample so a shape change fails before the wait.
   */
  sampleStdout?: {
    intervalMs: number;
    combine(first: string, second: string, elapsedMs: number, ctx: InstrumentParseContext): number | null;
  };
}

export interface PlatformInstrument {
  key: string;
  evaluator: 'platform';
  description: string;
  /** The subject-window resolver; scheduled measurement is separately opt-in below. */
  resolvedBy: 'scorecards:instrument-snapshots';
  /** Opt-in scheduled measurement; subject-only instruments remain scorecard-owned. */
  rescore?: {
    windowMs: number;
    unit: InstrumentUnit;
    resolve(window: { workspaceId: string; windowStart: string; windowEnd: string }): Promise<{
      verdict: 'pass' | 'fail' | 'unknown';
      detail: string;
    }>;
  };
}

/** Validates retained evidence; it does not execute or independently remeasure a benchmark. */
export interface ArtifactInstrument {
  key: string;
  evaluator: 'artifact';
  description: string;
  resolvedBy: 'scorecards:instrument-snapshots';
}

export type RegisteredInstrument = CommandInstrument | PlatformInstrument | ArtifactInstrument;

export type PsiWindow = 'avg10' | 'avg60' | 'avg300';

/**
 * Every `some`/`full` line of one or more concatenated pressure files (`/proc/pressure/<r>` or a
 * cgroup `<r>.pressure`) → the chosen window's percentage, in file order. A matching line without
 * the window field yields NaN so a format change cannot pass as a low reading.
 */
function psiValues(stdout: string, line: 'some' | 'full', window: PsiWindow): number[] {
  const values: number[] = [];
  const field = new RegExp(`(?:^|\\s)${window}=(\\d+(?:\\.\\d+)?)(?:\\s|$)`);
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(`${line} `)) continue;
    const match = field.exec(trimmed);
    values.push(match ? Number(match[1]) : Number.NaN);
  }
  return values;
}

/** One pressure file → the `window` percentage of its `some` or `full` line. */
export function parsePsiAvg(stdout: string, line: 'some' | 'full', window: PsiWindow): number | null {
  const [first] = psiValues(stdout, line, window);
  return first === undefined || Number.isNaN(first) ? null : first;
}

/** `/proc/pressure/<resource>` → the avg10 percentage of the `some` or `full` line. */
export function parsePsiAvg10(stdout: string, line: 'some' | 'full'): number | null {
  return parsePsiAvg(stdout, line, 'avg10');
}

/**
 * `cat a.pressure b.pressure …` → the WORST (max) `window` percentage across the files, or null
 * unless exactly `expectedFiles` lines parsed (a missing or reshaped file is never a low reading).
 */
export function parseMaxPsiAvg(
  stdout: string,
  line: 'some' | 'full',
  window: PsiWindow,
  expectedFiles: number,
): number | null {
  const values = psiValues(stdout, line, window);
  if (values.length !== expectedFiles || values.some((v) => Number.isNaN(v))) return null;
  return Math.max(...values);
}

/** `df --output=pcent …` over several filesystems → the highest used percentage. */
export function parseDfMaxPercent(stdout: string): number | null {
  const values = stdout
    .split('\n')
    .map((l) => /^\s*(\d+)%/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * `curl -w '%{http_code} %{time_total}\n'` lines (one per request) → nearest-rank p95 in ms.
 * A request that did not answer 2xx (000 = refused or timed out, or an HTTP error) counts as a
 * `capSeconds` sample, so a failing endpoint reads as slow instead of unmeasured
 * (WI-6554700010009926). Null when any line is malformed or there is no line at all.
 */
export function parseHttpTimesP95Ms(stdout: string, capSeconds = 5): number | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const seconds: number[] = [];
  for (const line of lines) {
    const m = /^(\d{3}) (\d+(?:\.\d+)?)$/.exec(line);
    if (!m) return null;
    const code = Number(m[1]);
    seconds.push(code >= 200 && code < 300 ? Number(m[2]) : Math.max(capSeconds, Number(m[2])));
  }
  const sorted = seconds.sort((a, b) => a - b);
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
  return Math.round(p95 * 1000 * 10) / 10;
}

/** Worst-of-budgets utilisation: max(value_i / budget_i) as a percent, one decimal. */
export function budgetUtilisationPct(parts: ReadonlyArray<{ value: number; budget: number }>): number | null {
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p.value) || !(p.budget > 0))) return null;
  return Math.round(Math.max(...parts.map((p) => p.value / p.budget)) * 1000) / 10;
}

const LOOP_PROFILE_NAME = /^loop-saturation-(\d{13})-pid\d+-p95_(\d+)ms\.cpuprofile$/;

/**
 * `ls -1 ~/.papercusp/loop-profiles` → event-loop saturation budget use over the trailing 24 h:
 * max(profiles / maxPerDay, worst p95 lag / maxP95Ms) as a percent. Names that are not
 * saturation profiles (e.g. the `stalls` directory) are ignored; no profile in 24 h reads 0.
 */
export function parseLoopProfileBudgetPct(
  stdout: string,
  ctx: InstrumentParseContext,
  budget: { maxPerDay: number; maxP95Ms: number },
): number | null {
  let count = 0;
  let worst = 0;
  for (const name of stdout.split('\n').map((l) => l.trim())) {
    const match = LOOP_PROFILE_NAME.exec(name);
    if (!match) continue;
    if (ctx.now - Number(match[1]) > 24 * 3600 * 1000) continue;
    count += 1;
    worst = Math.max(worst, Number(match[2]));
  }
  return budgetUtilisationPct([
    { value: count, budget: budget.maxPerDay },
    { value: worst, budget: budget.maxP95Ms },
  ]);
}

/**
 * `cat <cg1>/memory.stat <cg2>/memory.stat …` → the anonymous-memory budget use of the WORST
 * service (`anon` bytes / budget bytes, percent). `memory.current` is deliberately not used: it
 * includes page cache. Null unless exactly one `anon` line per budget parsed, in argv order.
 */
export function parseAnonBudgetPct(stdout: string, budgetsBytes: readonly number[]): number | null {
  const anon = [...stdout.matchAll(/^anon\s+(\d+)\s*$/gm)].map((m) => Number(m[1]));
  if (anon.length !== budgetsBytes.length) return null;
  return budgetUtilisationPct(anon.map((value, i) => ({ value, budget: budgetsBytes[i]! })));
}

/**
 * `cat /proc/pressure/memory /proc/vmstat`, sampled twice → memory-paging budget use: the worse of
 * memory PSI `some` avg60 against `maxPsiPct` and the swap-in rate (pswpin pages × 4 KiB over the
 * interval, MB/s) against `maxSwapInMBps`.
 */
export function memoryPagingBudgetPct(
  first: string,
  second: string,
  elapsedMs: number,
  budget: { maxPsiPct: number; maxSwapInMBps: number },
): number | null {
  const pswpin = (s: string) => {
    const match = /^pswpin\s+(\d+)\s*$/m.exec(s);
    return match ? Number(match[1]) : null;
  };
  const psi = parsePsiAvg(second, 'some', 'avg60');
  const a = pswpin(first);
  const b = pswpin(second);
  if (psi === null || a === null || b === null || !(elapsedMs > 0)) return null;
  const swapInMBps = ((b - a) * 4096) / 1e6 / (elapsedMs / 1000);
  return budgetUtilisationPct([
    { value: psi, budget: budget.maxPsiPct },
    { value: Math.max(0, swapInMBps), budget: budget.maxSwapInMBps },
  ]);
}

/**
 * Output of SPA_INITIAL_JS_SCRIPT (`{"files":N,"gzipBytes":N,"rawBytes":N}`) → first-screen JS
 * budget use: the worse of gzip KB (1 KB = 1000 B, as Vite reports) and referenced file count.
 */
export function parseSpaInitialJsBudgetPct(
  stdout: string,
  budget: { maxGzipKB: number; maxFiles: number },
): number | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { files?: unknown; gzipBytes?: unknown };
    if (typeof parsed.files !== 'number' || typeof parsed.gzipBytes !== 'number') return null;
    return budgetUtilisationPct([
      { value: parsed.gzipBytes / 1000, budget: budget.maxGzipKB },
      { value: parsed.files, budget: budget.maxFiles },
    ]);
  } catch {
    return null;
  }
}

/** cgroup v2 `cpu.stat` → cumulative `usage_usec`. */
export function parseCgroupUsageUsec(stdout: string): number | null {
  const match = /^usage_usec\s+(\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/** `df --output=pcent <path>` → the used percentage on the data line. */
export function parseDfPercent(stdout: string): number | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const data = lines.find((l) => /^\d+%$/.test(l));
  return data ? Number(data.slice(0, -1)) : null;
}

/** `/proc/loadavg` → the 1-minute load average (the first field). */
export function parseLoadavg1(stdout: string): number | null {
  const first = stdout.trim().split(/\s+/)[0];
  return first && /^\d+(?:\.\d+)?$/.test(first) ? Number(first) : null;
}

/**
 * `docker ps --format '{{.CreatedAt}}'` lines (`2026-10-12 21:03:11 -0400 EDT`) → the age in
 * seconds of the OLDEST container at `now`; 0 when no container matched; null when any line
 * fails to parse (a format change must not read as "no stale containers").
 */
export function parseOldestDockerAgeSec(stdout: string, ctx: InstrumentParseContext): number | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\b/.exec(line);
    if (!match) return null;
    const created = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
    if (Number.isNaN(created)) return null;
    oldest = Math.min(oldest, created);
  }
  return Math.max(0, Math.round((ctx.now - oldest) / 1000));
}

function psi(resource: 'cpu' | 'io' | 'memory', line: 'some' | 'full', window: PsiWindow = 'avg10'): CommandInstrument {
  const seconds = window.slice(3);
  return {
    key: `host:psi-${resource}-${line}-${window}-pct`,
    evaluator: 'command',
    description:
      `Linux pressure-stall ${resource} '${line}' ${window}: percent of the last ${seconds}s in which ` +
      `${line === 'some' ? 'at least one task' : 'all non-idle tasks'} stalled on ${resource}.`,
    unit: '%',
    argv: ['cat', `/proc/pressure/${resource}`],
    timeoutMs: 5_000,
    parse: (stdout) => parsePsiAvg(stdout, line, window),
  };
}

// ── papercusp-app-performance instruments (P-010 / R-10, plan D-009) ─────────
// Paths are resolved once at load. Services run as the operator's own user, so their cgroups sit
// under that user's systemd manager; PostgreSQL is a system service.
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const userServiceCgroup = (unit: string) =>
  `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${unit}`;
const SERVING_CPU_PRESSURE_FILES = [
  `${userServiceCgroup('papercusp-dev-api.service')}/cpu.pressure`,
  `${userServiceCgroup('papercusp-bg-host.service')}/cpu.pressure`,
  '/sys/fs/cgroup/system.slice/system-postgresql.slice/cpu.pressure',
] as const;
/** papercusp-dev-api anon ≤ 6 GB, papercusp-bg-host anon ≤ 4 GB (rubric model; 1 GB = 1e9 B). */
const SERVING_ANON_BUDGETS = [
  { file: `${userServiceCgroup('papercusp-dev-api.service')}/memory.stat`, bytes: 6e9 },
  { file: `${userServiceCgroup('papercusp-bg-host.service')}/memory.stat`, bytes: 4e9 },
] as const;
const HEALTH_URLS = ['9071', '3070', '3170'].map((port) => `http://127.0.0.1:${port}/api/health`);
const HEALTH_SAMPLES_PER_PORT = 5;
const HEALTH_TIMEOUT_S = 5;
const RELEASE_ROOT = process.env.PAPERCUSP_RELEASE_ROOT || join(homedir(), 'papercupai-workspace', 'papercup-release');
const SPA_INDEX_HTML = join(RELEASE_ROOT, 'apps', 'operator-vite', 'dist', 'index.html');
/**
 * Run as `node -e SCRIPT <index.html>`: every `.js` the first screen references (script src +
 * modulepreload href), resolved against the dist root, gzip-compressed at zlib's default level.
 */
const SPA_INITIAL_JS_SCRIPT = [
  "const fs=require('fs'),path=require('path'),zlib=require('zlib');",
  'const index=process.argv[1];const root=path.dirname(index);const html=fs.readFileSync(index,"utf8");',
  'const refs=new Set();',
  'for(const m of html.matchAll(/<script\\b[^>]*\\bsrc="([^"]+\\.js)"/g))refs.add(m[1]);',
  'for(const m of html.matchAll(/<link\\b[^>]*\\brel="modulepreload"[^>]*\\bhref="([^"]+\\.js)"/g))refs.add(m[1]);',
  'for(const m of html.matchAll(/<link\\b[^>]*\\bhref="([^"]+\\.js)"[^>]*\\brel="modulepreload"/g))refs.add(m[1]);',
  'let raw=0,gz=0;for(const ref of refs){const buf=fs.readFileSync(path.join(root,ref.replace(/^\\//,"")));raw+=buf.length;gz+=zlib.gzipSync(buf).length;}',
  'process.stdout.write(JSON.stringify({files:refs.size,rawBytes:raw,gzipBytes:gz}));',
].join('');

const APP_PERFORMANCE_INSTRUMENTS: readonly CommandInstrument[] = [
  psi('cpu', 'some', 'avg300'),
  psi('io', 'some', 'avg60'),
  {
    key: 'host:cgroup-serving-cpu-pressure-some-avg60-max-pct',
    evaluator: 'command',
    description:
      'Worst cgroup cpu.pressure some avg60 (percent) across the serving path: papercusp-dev-api ' +
      '(:3070), papercusp-bg-host and the PostgreSQL slice. A stopped service is an error, not 0.',
    unit: '%',
    argv: ['cat', ...SERVING_CPU_PRESSURE_FILES],
    timeoutMs: 5_000,
    parse: (stdout) => parseMaxPsiAvg(stdout, 'some', 'avg60', SERVING_CPU_PRESSURE_FILES.length),
  },
  {
    key: 'host:memory-paging-budget-pct',
    evaluator: 'command',
    description:
      'Memory-paging budget use, percent: the worse of memory PSI some avg60 against 5% and the ' +
      'swap-in rate (pswpin delta over 5s, MB/s) against 1 MB/s. 100 = at the budget.',
    unit: '%',
    argv: ['cat', '/proc/pressure/memory', '/proc/vmstat'],
    timeoutMs: 5_000,
    parse: (stdout) => (parsePsiAvg(stdout, 'some', 'avg60') !== null && /^pswpin\s+\d+/m.test(stdout) ? 0 : null),
    sampleStdout: {
      intervalMs: 5_000,
      combine: (first, second, elapsedMs) =>
        memoryPagingBudgetPct(first, second, elapsedMs, { maxPsiPct: 5, maxSwapInMBps: 1 }),
    },
  },
  {
    key: 'host:df-max-used-pct',
    evaluator: 'command',
    description:
      'Highest used percentage across every real filesystem (df, excluding tmpfs/devtmpfs/' +
      'squashfs/overlay/efivarfs) — on this host /, /mnt/data and /mnt/backup.',
    unit: '%',
    argv: ['df', '--output=pcent', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay', '-x', 'efivarfs'],
    timeoutMs: 10_000,
    parse: (stdout) => parseDfMaxPercent(stdout),
  },
  {
    key: 'host:http-health-p95-ms',
    evaluator: 'command',
    description:
      `Nearest-rank p95 of /api/health time_total in ms over ${HEALTH_SAMPLES_PER_PORT} requests ` +
      'each to :9071, :3070 and :3170. A request that does not answer 2xx within the ' +
      `${HEALTH_TIMEOUT_S} s cap (refused, timed out, HTTP error) counts as a ${HEALTH_TIMEOUT_S * 1000} ms sample.`,
    unit: 'ms',
    acceptNonZeroExit: true,
    argv: [
      'curl', '-sS', '-m', String(HEALTH_TIMEOUT_S), '-w', '%{http_code} %{time_total}\n',
      ...HEALTH_URLS.flatMap((url) => Array.from({ length: HEALTH_SAMPLES_PER_PORT }, () => ['-o', '/dev/null', url]).flat()),
    ],
    timeoutMs: 90_000,
    parse: (stdout) => parseHttpTimesP95Ms(stdout, HEALTH_TIMEOUT_S),
  },
  {
    key: 'host:loop-profile-budget-pct',
    evaluator: 'command',
    description:
      'Event-loop saturation budget use over the trailing 24 h, percent: the worse of the count of ' +
      '~/.papercusp/loop-profiles saturation profiles against 5 and the worst profile p95 lag ' +
      'against 500 ms.',
    unit: '%',
    argv: ['ls', '-1', join(homedir(), '.papercusp', 'loop-profiles')],
    timeoutMs: 10_000,
    parse: (stdout, ctx) => parseLoopProfileBudgetPct(stdout, ctx, { maxPerDay: 5, maxP95Ms: 500 }),
  },
  {
    key: 'host:serving-anon-budget-pct',
    evaluator: 'command',
    description:
      'Anonymous-memory budget use of the worst long-running service, percent: memory.stat anon ' +
      'of papercusp-dev-api against 6 GB and papercusp-bg-host against 4 GB.',
    unit: '%',
    argv: ['cat', ...SERVING_ANON_BUDGETS.map((b) => b.file)],
    timeoutMs: 5_000,
    parse: (stdout) => parseAnonBudgetPct(stdout, SERVING_ANON_BUDGETS.map((b) => b.bytes)),
  },
  {
    key: 'static:spa-initial-js-budget-pct',
    evaluator: 'command',
    description:
      'First-screen JS budget use of the deployed SPA (release tree apps/operator-vite/dist/' +
      'index.html script + modulepreload), percent: the worse of gzip size against 500 KB and the ' +
      'referenced file count against 60.',
    unit: '%',
    argv: [process.execPath, '-e', SPA_INITIAL_JS_SCRIPT, SPA_INDEX_HTML],
    timeoutMs: 60_000,
    parse: (stdout) => parseSpaInitialJsBudgetPct(stdout, { maxGzipKB: 500, maxFiles: 60 }),
  },
];

export const GATE_SENTINEL_HEALTH_INSTRUMENT_KEY = 'host:gate-liveness-sentinel-health';

// Extend the existing command-instrument executor instead of granting the judge
// dev-tool access. Select no Environment fields: unit credentials are not evidence.
export const GATE_SENTINEL_HEALTH_COMMAND = [
  "const {execFileSync}=require('node:child_process');",
  "const show=(unit,props)=>execFileSync('systemctl',['--user','show',unit,...props.flatMap(p=>['-p',p])],{encoding:'utf8',timeout:2000}).trim().split('\\n').filter(Boolean).reduce((out,l)=>{const i=l.indexOf('='),k=l.slice(0,i),v=l.slice(i+1);out[k]=out[k]?out[k]+' '+v:v;return out;},{});",
  "const timer=show('papercusp-gate-liveness-sentinel.timer',['Id','LoadState','ActiveState','UnitFileState','Triggers','WantedBy','TimersMonotonic','LastTriggerUSecMonotonic','NextElapseUSecMonotonic']);",
  "const service=show('papercusp-gate-liveness-sentinel.service',['Id','LoadState','ActiveState','Result','ExecMainStatus','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','ExecStart','Requires','Wants','BindsTo','PartOf']);",
  "const linger=execFileSync('loginctl',['show-user',String(require('node:os').userInfo().uid),'-p','Linger','--value'],{encoding:'utf8',timeout:2000}).trim();",
  "process.stdout.write(JSON.stringify({schemaVersion:1,timer,service,linger,monotonicUs:Number(process.hrtime.bigint()/1000n)}));",
].join('\n');

/** 1 = measured healthy, 0 = measured broken, null = unavailable/incomplete. */
export function parseGateSentinelHealth(stdout: string): number | null {
  let input: { schemaVersion?: unknown; timer?: Record<string, unknown>; service?: Record<string, unknown>; linger?: unknown; monotonicUs?: unknown };
  try { input = JSON.parse(stdout); } catch { return null; }
  if (!input || input.schemaVersion !== 1 || !input.timer || !input.service) return null;
  const { timer, service } = input;
  const fields = (row: Record<string, unknown>, keys: string[]) => keys.every(key => typeof row[key] === 'string' && row[key] !== '');
  if (!fields(timer, ['Id', 'LoadState']) || !fields(service, ['Id', 'LoadState'])) return null;
  if (timer.Id !== 'papercusp-gate-liveness-sentinel.timer' || service.Id !== 'papercusp-gate-liveness-sentinel.service' ||
      timer.LoadState !== 'loaded' || service.LoadState !== 'loaded') return 0;
  if (!fields(timer, ['ActiveState', 'UnitFileState', 'Triggers', 'WantedBy', 'TimersMonotonic']) ||
      !fields(service, ['ActiveState', 'Result', 'ExecMainStatus', 'ExecStart']) || typeof input.linger !== 'string') return null;
  if (timer.ActiveState !== 'active' || timer.UnitFileState !== 'enabled' || input.linger !== 'yes' ||
      !String(timer.Triggers).split(/\s+/).includes(String(service.Id)) ||
      !String(timer.WantedBy).split(/\s+/).includes('timers.target') ||
      !String(timer.TimersMonotonic).includes('OnStartupUSec=') ||
      !String(timer.TimersMonotonic).includes('OnUnitActiveUSec=') ||
      !String(service.ExecStart).includes('scripts/gate-liveness-sentinel.mts') ||
      service.ActiveState === 'failed' || service.Result !== 'success' || service.ExecMainStatus !== '0') return 0;
  for (const key of ['Requires', 'Wants', 'BindsTo', 'PartOf']) {
    if (typeof service[key] !== 'string') return null;
    if (/papercu(?:p|sp)-(?:dev-api|staging-api|operator)(?:\.|\s|$)/.test(String(service[key]))) return 0;
  }
  const stamp = (value: unknown): number | null => {
    if (typeof value !== 'string') return null;
    if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : null;
    // systemctl formats timer monotonic properties as spans but service stamps
    // as integer microseconds. Reject unknown units or partially parsed spans.
    const scales: Record<string, number> = { w: 604_800_000_000, d: 86_400_000_000, h: 3_600_000_000, min: 60_000_000, s: 1_000_000, ms: 1000, us: 1, 'µs': 1 };
    const tokens = value.trim().split(/\s+/); let total = 0;
    for (const token of tokens) {
      const match = /^(\d+(?:\.\d+)?)(w|d|h|min|s|ms|us|µs)$/.exec(token);
      if (!match) return null;
      total += Number(match[1]) * scales[match[2]];
    }
    return Number.isSafeInteger(Math.round(total)) ? Math.round(total) : null;
  };
  const now = input.monotonicUs;
  const last = stamp(timer.LastTriggerUSecMonotonic), next = stamp(timer.NextElapseUSecMonotonic);
  const start = stamp(service.ExecMainStartTimestampMonotonic), end = stamp(service.ExecMainExitTimestampMonotonic);
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0 || last === null || next === null || start === null || end === null) return null;
  // A oneshot may be inactive between successful ticks. A tick in progress has
  // no completed receipt yet: unknown, never a false healthy or a false outage.
  if (last <= 0 || start <= 0 || end < start || last > now || start > now || end > now) return null;
  const maxAgeUs = (600 + 180 + 30) * 1_000_000; // cadence + service timeout + timer accuracy
  if (now - last > maxAgeUs || now - end > maxAgeUs) return 0;
  if (next === 0 && ['active', 'activating'].includes(String(service.ActiveState))) return null;
  return next > now && next - now <= maxAgeUs ? 1 : 0;
}

const COMMAND_INSTRUMENTS: readonly CommandInstrument[] = Object.freeze([
  {
    key: GATE_SENTINEL_HEALTH_INSTRUMENT_KEY,
    evaluator: 'command',
    description: 'Live out-of-operator sentinel deployment: exact loaded identities, enabled active reboot-starting timer, lingering user manager, recent successful oneshot and next trigger; 1 healthy, 0 broken, unreadable/incomplete unknown.',
    unit: 'count',
    argv: [process.execPath, '-e', GATE_SENTINEL_HEALTH_COMMAND],
    timeoutMs: 8_000,
    parse: parseGateSentinelHealth,
  },
  psi('cpu', 'some'),
  psi('cpu', 'full'),
  psi('io', 'some'),
  psi('io', 'full'),
  psi('memory', 'some'),
  psi('memory', 'full'),
  {
    key: 'host:cgroup-cpu-delta-cores',
    evaluator: 'command',
    description:
      'Host-wide CPU actually consumed, in cores: the delta of the root cgroup v2 cpu.stat ' +
      'usage_usec over a 2s window (two samples, never a lifetime average).',
    unit: 'cores',
    argv: ['cat', '/sys/fs/cgroup/cpu.stat'],
    timeoutMs: 5_000,
    parse: (stdout) => parseCgroupUsageUsec(stdout),
    sample: {
      intervalMs: 2_000,
      combine: (first, second, elapsedMs) =>
        elapsedMs > 0 ? Math.round(((second - first) / (elapsedMs * 1000)) * 1000) / 1000 : 0,
    },
  },
  {
    key: 'host:df-root-used-pct',
    evaluator: 'command',
    description: 'Used space on the root filesystem, percent (df --output=pcent /).',
    unit: '%',
    argv: ['df', '--output=pcent', '/'],
    timeoutMs: 10_000,
    parse: (stdout) => parseDfPercent(stdout),
  },
  {
    key: 'host:docker-test-container-max-age-s',
    evaluator: 'command',
    description:
      'Age in seconds of the oldest running Testcontainers container (label ' +
      'org.testcontainers=true); 0 when none is running. A large value is a leaked test container.',
    unit: 's',
    argv: ['docker', 'ps', '--filter', 'label=org.testcontainers=true', '--format', '{{.CreatedAt}}'],
    timeoutMs: 15_000,
    parse: (stdout, ctx) => parseOldestDockerAgeSec(stdout, ctx),
  },
  {
    key: 'host:loadavg1-not-authoritative',
    evaluator: 'command',
    description:
      '1-minute load average, recorded by the performance audit as CONTEXT ONLY: load counts ' +
      'idle and uninterruptible waiters, so it is never by itself evidence of a bottleneck.',
    unit: 'count',
    argv: ['cat', '/proc/loadavg'],
    timeoutMs: 5_000,
    parse: (stdout) => parseLoadavg1(stdout),
  },
  ...APP_PERFORMANCE_INSTRUMENTS,
]);

/**
 * Every key scorecards.ts resolves in-process into a platform-computed instrument snapshot.
 * A function (not a module constant) so an import cycle through scorecards/rubrics can never
 * observe a half-initialised value.
 */
export function platformComputedInstrumentKeys(): string[] {
  return [
    'woe.goal-mode-base-scorecard',
    GATE_REUSE_AUDIT_INSTRUMENT_KEY,
    DISK_HEADROOM_SOAK_INSTRUMENT_KEY,
    PG_TABLE_GROWTH_INSTRUMENT_KEY,
    ...Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS),
    ...Object.values(GOAL_MODE_INSTRUMENT_KEYS),
    // native-code-intelligence-ecosystem-and-dream-2026-10-09 P-033 (R-30/R-31).
    ...Object.values(NATIVE_ADOPTION_INSTRUMENT_KEYS),
  ];
}

/** The full registry, keyed by instrumentKey. */
export function instrumentRegistry(): ReadonlyMap<string, RegisteredInstrument> {
  const registry = new Map<string, RegisteredInstrument>();
  for (const instrument of COMMAND_INSTRUMENTS) registry.set(instrument.key, instrument);
  registry.set(BM25_LATENCY_INSTRUMENT_KEY, {
    key: BM25_LATENCY_INSTRUMENT_KEY, evaluator: 'artifact',
    description: 'Validate the original R-1 operational bakeoff bytes and derive separate R-2 p95 / R-3 p50 outcomes. Retained artifact provenance stays self-reported.',
    resolvedBy: 'scorecards:instrument-snapshots',
  });
  for (const key of platformComputedInstrumentKeys()) {
    if (registry.has(key)) continue;
    const adoptionCriterion = nativeAdoptionCriterionForInstrument(key);
    registry.set(key, {
      key,
      evaluator: 'platform',
      description: 'Resolved in-process by scorecards:emit / scorecards:evaluate as a platform-computed snapshot.',
      resolvedBy: 'scorecards:instrument-snapshots',
      ...(adoptionCriterion ? { rescore: {
        windowMs: 72 * 60 * 60_000,
        unit: 'count' as const,
        resolve: async (window: { workspaceId: string; windowStart: string; windowEnd: string }) => {
          const metrics = await measureNativeAdoptionWindow(window);
          const rating = rateNativeAdoption(metrics)[adoptionCriterion];
          return { verdict: rating.verdict,
            detail: `${window.windowStart}..${window.windowEnd}: ${rating.reason}` };
        },
      } } : {}),
    });
  }
  return registry;
}

export function isManualInstrumentKey(key: string | null | undefined): boolean {
  return (key ?? '').trim().toLowerCase() === MANUAL_INSTRUMENT_KEY;
}

export function getRegisteredInstrument(key: string): RegisteredInstrument | null {
  return instrumentRegistry().get(key.trim()) ?? null;
}

export function registeredInstrumentKeys(): string[] {
  return [...instrumentRegistry().keys()].sort();
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface InstrumentReading {
  key: string;
  unit: InstrumentUnit;
  /** null when the command failed or its output did not parse — never a silent 0. */
  value: number | null;
  measuredAt: string;
  argv: readonly string[];
  error?: string;
}

export interface InstrumentRunDeps {
  /** Runs argv without a shell; resolves stdout. Defaults to child_process.execFile. */
  exec?: (
    argv: readonly [string, ...string[]],
    timeoutMs: number,
    opts?: { acceptNonZeroExit?: boolean },
  ) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function defaultExec(
  argv: readonly [string, ...string[]],
  timeoutMs: number,
  opts: { acceptNonZeroExit?: boolean } = {},
): Promise<string> {
  const [file, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false }, (error, stdout) => {
      // A numeric code is a normal non-zero exit; a timeout kill carries a signal and still fails.
      const exitedNonZero = typeof (error as { code?: unknown } | null)?.code === 'number';
      if (error && !(opts.acceptNonZeroExit && exitedNonZero && String(stdout).length > 0)) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Measure one registered COMMAND instrument. Platform instruments and unknown keys throw:
 * the caller asked to run something this module does not execute.
 */
export async function runInstrument(key: string, deps: InstrumentRunDeps = {}): Promise<InstrumentReading> {
  const instrument = getRegisteredInstrument(key);
  if (!instrument) {
    throw new Error(`unregistered instrument '${key}' — registered: ${registeredInstrumentKeys().join(', ')}`);
  }
  if (instrument.evaluator !== 'command') {
    const source = instrument.evaluator === 'artifact' ? 'retained artifact evidence' : 'platform-computed';
    throw new Error(`instrument '${key}' is ${source} (${instrument.resolvedBy}); it is not run as a command`);
  }
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = { key: instrument.key, unit: instrument.unit, argv: instrument.argv };
  const sampleOnce = async (): Promise<{ value: number | null; at: number; stdout: string }> => {
    const stdout = instrument.acceptNonZeroExit
      ? await exec(instrument.argv, instrument.timeoutMs, { acceptNonZeroExit: true })
      : await exec(instrument.argv, instrument.timeoutMs);
    const at = now();
    return { value: instrument.parse(stdout, { now: at }), at, stdout };
  };
  try {
    const first = await sampleOnce();
    if (first.value === null) {
      return { ...base, value: null, measuredAt: new Date(first.at).toISOString(), error: 'output did not parse' };
    }
    if (instrument.sampleStdout) {
      await sleep(instrument.sampleStdout.intervalMs);
      const second = await sampleOnce();
      const value = instrument.sampleStdout.combine(first.stdout, second.stdout, second.at - first.at, { now: second.at });
      return value === null
        ? { ...base, value: null, measuredAt: new Date(second.at).toISOString(), error: 'second sample did not parse' }
        : { ...base, value, measuredAt: new Date(second.at).toISOString() };
    }
    if (!instrument.sample) {
      return { ...base, value: first.value, measuredAt: new Date(first.at).toISOString() };
    }
    await sleep(instrument.sample.intervalMs);
    const second = await sampleOnce();
    if (second.value === null) {
      return { ...base, value: null, measuredAt: new Date(second.at).toISOString(), error: 'second sample did not parse' };
    }
    return {
      ...base,
      value: instrument.sample.combine(first.value, second.value, second.at - first.at),
      measuredAt: new Date(second.at).toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      value: null,
      measuredAt: new Date(now()).toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Authoring guard ──────────────────────────────────────────────────────────

export interface InstrumentBindingCriterion {
  key: string;
  model?: string;
  instrumentKey?: string;
  check?: RubricCriterionCheck;
}

export interface InstrumentBindingAudit {
  /** New or changed bindings to unregistered keys — the authoring call is refused. */
  refused: Array<{ criterion: string; instrumentKey: string; priorInstrumentKey: string | null }>;
  /** Unregistered keys carried unchanged from the stored revision — accepted and reported. */
  grandfathered: Array<{ criterion: string; instrumentKey: string }>;
}

/**
 * PURE: classify every instrument binding in `next` against the registry and the stored
 * revision `prior` (empty for a brand-new rubric). Manual (`none`) and registered keys pass.
 */
export function auditInstrumentBindings(input: {
  prior: readonly InstrumentBindingCriterion[];
  next: readonly InstrumentBindingCriterion[];
}): InstrumentBindingAudit {
  const registry = instrumentRegistry();
  const priorByKey = new Map(input.prior.map((c) => [c.key, effectiveCriterionInstrumentKey(c)]));
  const audit: InstrumentBindingAudit = { refused: [], grandfathered: [] };
  for (const criterion of input.next) {
    const bound = effectiveCriterionInstrumentKey(criterion);
    if (!bound || isManualInstrumentKey(bound) || registry.has(bound)) continue;
    const prior = priorByKey.get(criterion.key) ?? null;
    if (prior === bound) audit.grandfathered.push({ criterion: criterion.key, instrumentKey: bound });
    else audit.refused.push({ criterion: criterion.key, instrumentKey: bound, priorInstrumentKey: prior });
  }
  return audit;
}

// A type alias, not an interface: tool handlers return it as `Record<string, unknown>`, and an
// interface has no implicit index signature (TS2322 in rubrics:amend's executeAmend).
export type UnregisteredInstrumentRefusal = {
  ok: false;
  code: 'unregistered_instrument';
  error: string;
  refused: InstrumentBindingAudit['refused'];
  registeredKeys: string[];
  next: string;
};

/** The authoring refusal for an audit with refused bindings, or null when there are none. */
export function unregisteredInstrumentRefusal(audit: InstrumentBindingAudit): UnregisteredInstrumentRefusal | null {
  if (audit.refused.length === 0) return null;
  const named = audit.refused
    .map((r) => `${r.criterion} → '${r.instrumentKey}'${r.priorInstrumentKey ? ` (was '${r.priorInstrumentKey}')` : ''}`)
    .join('; ');
  return {
    ok: false,
    code: 'unregistered_instrument',
    error:
      `instrument binding refused: ${named}. An instrumentKey must name a registered instrument ` +
      `(something that can actually measure the criterion) or be '${MANUAL_INSTRUMENT_KEY}' for a deliberately manual check.`,
    refused: audit.refused,
    registeredKeys: registeredInstrumentKeys(),
    next:
      `Bind one of registeredKeys, use a structured check (kind:'tests'|'sql'|…) instead, or set ` +
      `instrumentKey:'${MANUAL_INSTRUMENT_KEY}'. A new measurable instrument is added to ` +
      `packages/operator-core/lib/rubric-instrument-registry.ts first.`,
  };
}
