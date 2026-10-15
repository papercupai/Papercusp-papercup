#!/usr/bin/env -S npx tsx
/**
 * gate-liveness-sentinel — the out-of-operator red-gate liveness check
 * (green-main-cycle-time-2026-10-08 P-023, bar R-3). One tick per invocation.
 *
 * Run by the systemd user timer `papercusp-gate-liveness-sentinel.timer`
 * (apps/operator/scripts/systemd/). It deliberately does NOT run inside the operator:
 * it reads Postgres directly and keeps its own alarm channels, so a dead operator or a
 * reboot cannot silence it. The decision and the tick live in operator-core
 * (`lib/release/gate-liveness-sentinel{,-run}.ts`) and are unit-tested there.
 *
 *   npx tsx scripts/gate-liveness-sentinel.mts            # one tick
 *   npx tsx scripts/gate-liveness-sentinel.mts --dry-run  # decide and print; write and notify nothing
 *
 * Env: GATE_LIVENESS_INSTALL_SLUG (papercusp) · PAPERCUSP_WORKSPACE (papercusp-workspace) ·
 *      GATE_LIVENESS_STATE_DIR ($XDG_RUNTIME_DIR/papercusp-gate-liveness-sentinel).
 * Exit: 0 = checked (healthy OR breach — a breach is an alarm, not a unit failure);
 *       1 = the ledger could not be read (systemd marks the unit failed, so it shows).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describePgUrlResolution, resolveScriptPgUrl } from './lib/pg-url.mjs';
import {
  readGateLivenessSnapshot,
  recordGateLivenessAlert,
  runGateLivenessSentinelTick,
  type GateLivenessNotification,
  type GateLivenessSentinelState,
} from '../packages/operator-core/lib/release/gate-liveness-sentinel-run';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const installSlug = process.env.GATE_LIVENESS_INSTALL_SLUG || 'papercusp';
const workspaceId = process.env.PAPERCUSP_WORKSPACE || 'papercusp-workspace';
const stateDir = process.env.GATE_LIVENESS_STATE_DIR
  || join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'papercusp-gate-liveness-sentinel');
const statePath = join(stateDir, `${installSlug}.json`);

function run(file: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    execFile(file, args, { cwd: ROOT, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => done(!err));
  });
}

const pg = resolveScriptPgUrl({ root: ROOT });
const sql = postgres(pg.url, { max: 1, connect_timeout: 10, idle_timeout: 5 });

try {
  const result = await runGateLivenessSentinelTick({
    installSlug,
    nowMs: () => Date.now(),
    readSnapshot: (nowMs) => readGateLivenessSnapshot(sql, { workspaceId, installSlug, nowMs }).catch((err: unknown) => {
      throw new Error(`${err instanceof Error ? err.message : String(err)} [${describePgUrlResolution(pg)}]`);
    }),
    loadState: async () => {
      try { return JSON.parse(await readFile(statePath, 'utf8')) as GateLivenessSentinelState; } catch { return null; }
    },
    saveState: async (state) => {
      if (dryRun) return;
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, statePath);
    },
    recordAlert: async (decision) => {
      if (!dryRun) await recordGateLivenessAlert(sql, { workspaceId, installSlug, decision });
    },
    notifyOwner: async (n: GateLivenessNotification) => {
      if (dryRun) return true;
      const args = JSON.stringify({ dedupeKey: n.dedupeKey, harness: installSlug, title: n.title, body: n.body, importance: 'urgent', sourceRef: 'gate-liveness-sentinel' });
      return run(process.execPath, ['scripts/mcp-call.mjs', 'notifications:send_owner', args, '--client', 'gate-liveness-sentinel', '--harness', installSlug], 90_000);
    },
    notifyDesktop: async (n: GateLivenessNotification) => {
      if (dryRun) return true;
      return run('notify-send', ['--urgency=critical', '--app-name=papercusp', n.title, n.body], 15_000);
    },
    log: (line) => console.log(dryRun ? `[dry-run] ${line}` : line),
  });
  if (dryRun) console.log(JSON.stringify(result.decision, null, 2));
  process.exitCode = result.readError ? 1 : 0;
} finally {
  await sql.end({ timeout: 5 });
}
