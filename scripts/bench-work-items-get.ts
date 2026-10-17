/**
 * Live small-summary cohort for BYOC R-003. Uses the maintained, attributed MCP
 * recovery client; each sample includes process startup and complete response parsing.
 * This measures summary reads only, not stalled-write isolation or deployed acceptance.
 *
 * PAPERCUSP_SID and PAPERCUSP_WORKSPACE must identify the calling session.
 * Usage: npx tsx scripts/bench-work-items-get.ts --port=3170 --ids=WI-1,WI-2
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const SOURCE_PATHS = [
  'packages/operator-core/lib/agent-tools/work_items/get.ts',
  'packages/operator-core/lib/agent-tools/work_items/get-shape.ts',
  'scripts/mcp-call.mjs',
  'scripts/bench-work-items-get.ts',
] as const;
const PICK = ['ok', 'results[].id', 'results[].availability', 'results[].ok',
  'results[].workItem.id', 'results[].workItem.state', 'counts', 'read'];

export interface Sample {
  size: number;
  repeat: number;
  wallMs: number;
  valid: boolean;
  failures: string[];
  read: unknown;
}

export function validateSummary(result: any, ids: string[]): string[] {
  const failures: string[] = [];
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (result?.ok !== true || result?.counts?.ok !== ids.length || result?.counts?.failed !== 0) {
    failures.push('successful authoritative counts missing');
  }
  if (rows.length !== ids.length || new Set(rows.map((row: any) => row.id)).size !== ids.length) {
    failures.push('requested row census differs');
  }
  for (const id of ids) {
    const row = rows.find((entry: any) => entry.id === id);
    if (row?.ok !== true || row?.availability !== 'available' || row?.workItem?.id !== id ||
        typeof row?.workItem?.state !== 'string' || !row.workItem.state) {
      failures.push(`missing or unavailable identity/state: ${id}`);
    }
  }
  const read = result?.read;
  if (read?.schemaVersion !== 'work-items-get-read-v1' || read?.mode !== 'projected' ||
      read?.requested !== ids.length || read?.available !== ids.length || read?.absent !== 0 ||
      read?.unavailable !== 0 || typeof read?.elapsedMs !== 'number' ||
      !Number.isFinite(read.elapsedMs) || read.elapsedMs < 0 || !read?.outerStageAttribution) {
    failures.push('top-level availability/timing disclosure missing');
  }
  return failures;
}

export function judgeSamples(samples: Sample[], sizes: number, repeats: number, limitMs = 2_000) {
  const complete = samples.length === sizes * repeats && Array.from({ length: sizes }, (_, i) => i + 1)
    .every(size => Array.from({ length: repeats }, (_, repeat) => repeat + 1)
      .every(repeat => samples.filter(sample => sample.size === size && sample.repeat === repeat).length === 1));
  const timings = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
  const timingValid = timings.every(value => Number.isFinite(value) && value >= 0);
  const p95Ms = timings.length && timingValid ? timings[Math.ceil(timings.length * .95) - 1]! : null;
  return { complete, p95Ms, limitMs, passed: complete && timingValid && p95Ms !== null &&
    p95Ms <= limitMs && samples.every(sample => sample.valid && sample.failures.length === 0) };
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_PATHS.map(path =>
    [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]));
}

export async function runSummaryCohort(input: {
  ids: string[];
  repeats: number;
  call: (ids: string[]) => Promise<unknown>;
  now?: () => number;
}) {
  if (!input.ids.length || input.ids.length > 10 || new Set(input.ids).size !== input.ids.length ||
      !Number.isInteger(input.repeats) || input.repeats < 1 || input.repeats > 10) {
    throw new Error('Use 1–10 distinct item ids and 1–10 repeats');
  }
  const now = input.now ?? (() => performance.now());
  const samples: Sample[] = [];
  for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
    for (let size = 1; size <= input.ids.length; size += 1) {
      const ids = input.ids.slice(0, size);
      const start = now();
      let result: any;
      let failures: string[];
      try {
        result = await input.call(ids);
        failures = validateSummary(result, ids);
      } catch {
        // Child errors can contain token paths or payloads: preserve the failed
        // sample without copying opaque transport diagnostics into the artifact.
        failures = ['MCP client failed; no successful authoritative response'];
      }
      samples.push({ size, repeat, wallMs: now() - start, valid: failures.length === 0,
        failures, read: result?.read ?? null });
    }
  }
  return { samples, verdict: judgeSamples(samples, input.ids.length, input.repeats) };
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(ids|port|repeats)=(.+)$/.exec(arg);
    if (!match) throw new Error('Accepted flags: --ids=... --port=3170 --repeats=4');
    return [match[1], match[2]];
  }));
  const client = process.env.PAPERCUSP_SID;
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  if (!client || !workspace) throw new Error('Verified session identity and workspace are required');
  const ids = (flags.ids ?? '').split(',').filter(Boolean);
  const port = flags.port ?? '3170';
  if (port !== '3170') throw new Error('This pre-release probe is pinned to the staging operator on 3170');
  const repeats = Number(flags.repeats ?? 4);
  const startedAt = new Date().toISOString();
  const before = sourceHashes();
  const result = await runSummaryCohort({ ids, repeats, call: async requested => {
    const args = { ids: requested, harness: 'papercusp', detail: false, threadLimit: 0,
      projection: { pick: PICK } };
    const child = await exec(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), 'work_items:get',
      JSON.stringify(args), '--client', client, '--workspace', workspace, '--harness', 'papercusp',
      '--port', port], { cwd: ROOT, timeout: 35_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(child.stdout);
  } });
  const after = sourceHashes();
  const sourceStable = JSON.stringify(before) === JSON.stringify(after);
  const report = { schemaVersion: 1, kind: 'operational-test-evidence',
    name: 'BYOC P009 R003 current-build summary cohort', startedAt, finishedAt: new Date().toISOString(),
    endpoint: 'http://127.0.0.1:3170/api/mcp', client, workspace, ids, repeats,
    method: 'maintained mcp-call subprocess wall clock, including startup and response parsing; unique output group per call',
    sourceHashes: before, sourceStable, ...result,
    passed: sourceStable && result.verdict.passed,
    notExercised: ['stalled unrelated checkpoint/claim write', 'same-item ordering/conflict',
      'cancellation/drain', 'forwarding outcome ambiguity', 'deployed R006 acceptance'] };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) void main().catch(() => {
  console.error('Summary probe failed before a complete report; inspect the maintained command inputs');
  process.exitCode = 1;
});
