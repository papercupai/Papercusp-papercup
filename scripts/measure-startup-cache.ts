#!/usr/bin/env tsx
/**
 * measure-startup-cache — the committed startup cache instrument for plan
 * `token-efficiency-prompts-cache-and-behavior-2026-10-11` (P-001).
 *
 * Answers, re-runnably: on a session's FIRST request, how many prompt tokens does the provider
 * WRITE to cache and how many does it READ, per prompt layout, and what share of all journaled
 * cache writes is that startup write? The before/after of the cache-boundary (P-006) and
 * system-tail relocation (P-015) changes is read from this exact command.
 *
 *   npm run measure:startup-cache
 *   npm run measure:startup-cache -- --since "2026-10-11 00:00" --until "2026-10-12 00:00"
 *   npm run measure:startup-cache -- --input /tmp/gateway-journal.txt --json
 *   npm run measure:startup-cache -- --require-samples        # acceptance gate form
 *
 * Source: the gateway's `startup-cache-evidence/v1` journal lines (one per owner's first observed
 * request). All arithmetic, dedupe and the startup definition live in
 * `summarizeStartupCacheEvidence` (packages/operator-core/lib/launch-cost/launch-cost-metrics.ts),
 * which is unit-tested; this file only reads lines and prints.
 *
 * ⚠ READ THE CENSUS LINE. Rows with missing usage counters (429s, cancelled streams) are
 * reported as `unknown usage`, never as zero, and every total/median covers `measured` rows only.
 * A falling write total over a falling measured count is not a saving.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  summarizeStartupCacheEvidence,
  type StartupCacheSummary,
  type StartupCacheTotals,
} from '../packages/operator-core/lib/launch-cost/launch-cost-metrics';
import { STARTUP_CACHE_EVIDENCE_SCHEMA } from '../packages/operator-core/lib/inference-gateway/request-stage-telemetry';

const USAGE = `measure-startup-cache — first-request cache write/read per prompt layout, from the gateway journal

Options:
  --since <time>        journalctl --since value (default "24 hours ago")
  --until <time>        journalctl --until value (default: now)
  --unit <name>         gateway user unit (default papercup-inference-gateway.service)
  --input <file|->      read journal lines from a file or stdin instead of journalctl
  --groups <n>          layout groups to print (default 10)
  --require-samples     exit 1 when no startup request has measured usage
  --json                machine-readable summary
  --help                this text

Exit codes: 0 ok · 1 --require-samples with no measured startups, or the journal read failed · 2 bad usage`;

type Cli = {
  since: string;
  until: string | null;
  unit: string;
  input: string | null;
  groups: number;
  requireSamples: boolean;
  json: boolean;
};

function parseArgs(argv: readonly string[]): Cli | 'help' {
  const cli: Cli = {
    since: '24 hours ago', until: null, unit: 'papercup-inference-gateway.service',
    input: null, groups: 10, requireSamples: false, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--help': case '-h': return 'help';
      case '--since': cli.since = next(); break;
      case '--until': cli.until = next(); break;
      case '--unit': cli.unit = next(); break;
      case '--input': cli.input = next(); break;
      case '--groups': cli.groups = Number(next()); break;
      case '--require-samples': cli.requireSamples = true; break;
      case '--json': cli.json = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (!Number.isInteger(cli.groups) || cli.groups < 0) throw new Error('--groups must be a non-negative integer');
  return cli;
}

/** journalctl exits 1 with no output when --grep matches nothing; that is an empty window, not a failure. */
function readJournal(cli: Cli): string[] {
  const args = ['--user', '--no-pager', '-o', 'cat', '-u', cli.unit, '--since', cli.since,
    ...(cli.until ? ['--until', cli.until] : []), '--grep', STARTUP_CACHE_EVIDENCE_SCHEMA];
  // One awaited, unit-scoped read; reviewed in check-resource-governor-enforcement.mjs (P016_REVIEWED_DISPOSITIONS).
  const run = spawnSync('journalctl', args, { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 120_000 });
  if (run.error) throw run.error;
  const stdout = run.stdout ?? '';
  if (run.status !== 0 && !(run.status === 1 && stdout.trim() === '')) {
    throw new Error(`journalctl exited ${run.status}: ${(run.stderr ?? '').trim().slice(0, 400)}`);
  }
  return stdout.split('\n');
}

function readInput(path: string): string[] {
  return readFileSync(path === '-' ? 0 : path, 'utf8').split('\n');
}

const n = (value: number | null): string => (value === null ? 'n/a' : Math.round(value).toLocaleString('en-US'));
const totals = (t: StartupCacheTotals): string =>
  `measured ${t.measured} · unknown usage ${t.unknownUsage}\n` +
  `    cache write: total ${n(t.cacheWriteTokens)} · median ${n(t.medianCacheWriteTokens)}\n` +
  `    cache read:  total ${n(t.cacheReadTokens)} · median ${n(t.medianCacheReadTokens)}\n` +
  `    uncached:    total ${n(t.uncachedInputTokens)} · median ${n(t.medianUncachedInputTokens)}`;

function render(summary: StartupCacheSummary, cli: Cli, source: string): string {
  const out: string[] = [];
  out.push(`startup-cache-evidence/v1 — ${source}`);
  out.push(`census: evidence lines ${summary.evidenceLines} · malformed ${summary.malformed} · duplicates ${summary.duplicates} · ` +
    `unique requests ${summary.requests} · no layout ${summary.noLayout}`);
  out.push(`startup requests ${summary.startup.requests} (owners ${summary.startup.owners}): ${totals(summary.startup)}`);
  out.push(`all journaled requests ${summary.all.requests}: ${totals(summary.all)}`);
  out.push(`startup share of journaled cache writes: ${summary.startupWriteShare === null ? 'n/a' : `${(summary.startupWriteShare * 100).toFixed(1)}%`}`);
  if (cli.groups > 0 && summary.groups.length > 0) {
    out.push('', 'layout groups (startup requests; medians over measured rows):');
    out.push(['requests', 'owners', 'measured', 'unknown', 'med write', 'med read', 'med uncached', 'med m0b0 bytes', 'layout'].join('\t'));
    for (const g of summary.groups.slice(0, cli.groups)) {
      out.push([g.requests, g.owners, g.measured, g.unknownUsage, n(g.medianCacheWriteTokens), n(g.medianCacheReadTokens),
        n(g.medianUncachedInputTokens), n(g.medianFirstMessageBlock0Bytes), g.key].join('\t'));
    }
    if (summary.groups.length > cli.groups) out.push(`… ${summary.groups.length - cli.groups} more group(s); raise --groups`);
  }
  return out.join('\n');
}

function main(): number {
  let cli: Cli | 'help';
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (cli === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let lines: string[];
  try {
    lines = cli.input ? readInput(cli.input) : readJournal(cli);
  } catch (error) {
    process.stderr.write(`measure-startup-cache: could not read evidence: ${(error as Error).message}\n`);
    return 1;
  }
  const summary = summarizeStartupCacheEvidence(lines);
  const source = cli.input ? `input ${cli.input}` : `${cli.unit} since "${cli.since}"${cli.until ? ` until "${cli.until}"` : ''}`;
  process.stdout.write(cli.json ? `${JSON.stringify({ source, ...summary }, null, 2)}\n` : `${render(summary, cli, source)}\n`);
  if (cli.requireSamples && summary.startup.measured === 0) {
    process.stderr.write('measure-startup-cache: no startup request with measured usage in this window\n');
    return 1;
  }
  return 0;
}

process.exitCode = main();
