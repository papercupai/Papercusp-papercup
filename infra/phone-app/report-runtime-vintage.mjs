#!/usr/bin/env node
// report-runtime-vintage.mjs — a Phone unit's boot self-report into the runtime-vintage
// ledger (plan phone-public-telephone-service-2026-10-01, WI-10006790).
//
// WHY. The Phone plan's live acceptance BARs must declare WHICH runtime their evidence is
// measured on (`evidenceRuntime`). For an app outside the operator that is
// `runtime-vintage:<workspace>/<unit>@<host>`, and the rubric contract requires it to name an
// EXISTING row in harness_shared.runtime_vintage. The Phone sidecar and worker run from
// their own git checkout via `node --import tsx`, so they cannot import the operator's
// runtime-vintage module. This script is the same dependency-free seam the inference-gateway
// and bg-host watchdogs use: a plain loopback POST to /api/internal/runtime-vintage.
//
// HOW IT RUNS. Each Phone unit template carries
//   ExecStartPost=-${PHONE_NODE_BIN} ${PHONE_VINTAGE_SCRIPT} --unit <unit>
// systemd runs it once per (re)start with $MAINPID set and the unit's WorkingDirectory as
// cwd, so the row records the code the NEW process actually loaded (tsx reads the source at
// start). The leading `-` and this script's own contract mean it can never fail or delay the
// unit for long: every error is reported on stdout and the exit code is always 0.
//
// Usage: report-runtime-vintage.mjs --unit <name> [--dir <checkout>] [--pid <n>]
//          [--origin <url> ...] [--workspace <id>] [--timeout-ms <n>]
//          [--executable | --node-entry]
// --executable measures the kernel-loaded native executable now, with no Git
// attribution. Use it for a compiled native shell with no baked revision, not
// to identify JavaScript/Python or other code loaded by an interpreter. A new
// report cannot supply execution-time witnesses for a historical test run.
// --node-entry identifies a direct Node .js/.mjs/.cjs entry by content, not
// today's source checkout. The receiver independently requires that entry to
// predate the process start; arbitrary interpreter arguments are unproven.
// Env:   PHONE_VINTAGE_ORIGINS (comma list, default http://127.0.0.1:3070,http://127.0.0.1:3170)
//        PAPERCUSP_WORKSPACE_ID (default papercusp-workspace)
import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync, readlinkSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ORIGINS = ['http://127.0.0.1:3070', 'http://127.0.0.1:3170'];
export const DEFAULT_WORKSPACE = 'papercusp-workspace';
export const DEFAULT_TIMEOUT_MS = 3000;
const SINK_PATH = '/api/internal/runtime-vintage';

export function parseArgs(argv, env = process.env) {
  const out = {
    unit: null,
    dir: process.cwd(),
    pid: null,
    origins: [],
    workspace: env.PAPERCUSP_WORKSPACE_ID || DEFAULT_WORKSPACE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--unit') { out.unit = value; i += 1; }
    else if (flag === '--dir') { out.dir = value; i += 1; }
    else if (flag === '--pid') { out.pid = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--origin') { out.origins.push(value); i += 1; }
    else if (flag === '--workspace') { out.workspace = value; i += 1; }
    else if (flag === '--timeout-ms') { out.timeoutMs = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--executable') out.executable = true;
    else if (flag === '--node-entry') out.nodeEntry = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!out.unit) throw new Error('--unit is required');
  if (out.pid === null && env.MAINPID) out.pid = Number.parseInt(env.MAINPID, 10);
  if (!Number.isInteger(out.pid) || out.pid <= 0) out.pid = null;
  if (out.executable && !out.pid) throw new Error('--executable requires a positive --pid or MAINPID');
  if (out.nodeEntry && !out.pid) throw new Error('--node-entry requires a positive --pid or MAINPID');
  if (out.executable && out.nodeEntry) throw new Error('Choose --executable or --node-entry');
  if (out.origins.length === 0) {
    out.origins = (env.PHONE_VINTAGE_ORIGINS || DEFAULT_ORIGINS.join(','))
      .split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs <= 0) out.timeoutMs = DEFAULT_TIMEOUT_MS;
  return out;
}

/** git HEAD + uncommitted-path count of `dir`; nulls (never a throw) when it is not a checkout. */
export function readCheckout(dir, run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })) {
  let treeSha = null;
  let dirty = null;
  try { treeSha = run(['rev-parse', 'HEAD']).trim() || null; } catch { treeSha = null; }
  if (treeSha) {
    try { dirty = run(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).length; }
    catch { dirty = null; }
  }
  return { treeSha, dirty };
}

/** The exact body the loopback sink accepts (bodySchema in runtime-vintage-report.ts). */
export function buildVintageReport({ unit, workspace, pid, dir, treeSha, dirty, executableDigest, nodeEntryDigest, now = new Date() }) {
  return {
    unit,
    workspaceId: workspace,
    treeSha: executableDigest || nodeEntryDigest ? null : treeSha,
    buildTime: now.toISOString(),
    bundleVersion: executableDigest ? `executable-sha256:${executableDigest}`
      : nodeEntryDigest ? `node-entry-sha256:${nodeEntryDigest}` : null,
    pid,
    extra: {
      reporter: 'infra/phone-app/report-runtime-vintage.mjs',
      checkout: dir,
      // A dirty checkout means the process may be running edits the sha does not name.
      uncommittedTrackedPaths: dirty,
      ...(executableDigest ? { identitySource: 'kernel-loaded-executable' } : {}),
      ...(nodeEntryDigest ? { identitySource: 'kernel-selected-node-entry' } : {}),
    },
  };
}

/** POST to each origin in order until one accepts. Never throws. */
export async function postVintage(report, origins, timeoutMs, fetchImpl = fetch) {
  const attempts = [];
  for (const origin of origins) {
    const url = `${origin.replace(/\/+$/, '')}${SINK_PATH}`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      // The sink answers 200 + {ok:false} on a store failure; only ok:true is a recorded row.
      if (res.ok && body && body.ok === true) {
        attempts.push({ origin, ok: true });
        return { ok: true, origin, attempts };
      }
      attempts.push({ origin, ok: false, status: res.status, error: body?.error ?? null });
    } catch (error) {
      attempts.push({ origin, ok: false, error: String(error?.message ?? error) });
    }
  }
  return { ok: false, origin: null, attempts };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    return 0;
  }
  // Native artifacts without baked source metadata must never inherit the
  // reporting checkout's current HEAD. Read the process's loaded inode instead.
  let executableDigest;
  if (args.executable) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(`/proc/${args.pid}/exe`)) hash.update(chunk);
    executableDigest = hash.digest('hex');
  }
  let nodeEntryDigest;
  if (args.nodeEntry) {
    const argv = readFileSync(`/proc/${args.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (argv.length !== 2 || !/\.(?:c|m)?js$/.test(argv[1])) throw new Error('direct_node_entry_required');
    const entry = realpathSync(resolve(readlinkSync(`/proc/${args.pid}/cwd`), argv[1]));
    nodeEntryDigest = createHash('sha256').update(readFileSync(entry)).digest('hex');
  }
  const { treeSha, dirty } = args.executable || args.nodeEntry ? { treeSha: null, dirty: null } : readCheckout(args.dir);
  const report = buildVintageReport({ unit: args.unit, workspace: args.workspace, pid: args.pid,
    dir: args.dir, treeSha, dirty, executableDigest, nodeEntryDigest });
  const result = await postVintage(report, args.origins, args.timeoutMs);
  process.stdout.write(`${JSON.stringify({ ...result, unit: args.unit, treeSha, pid: args.pid })}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    process.exitCode = 0;
  });
}
