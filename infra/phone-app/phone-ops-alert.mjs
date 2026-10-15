#!/usr/bin/env node
/**
 * Source-side Phone operations alert check. A user timer invokes this once per
 * interval; notifications:send_owner is the existing durable inbox + mobile/
 * desktop delivery rail. No check output, paths, account IDs or credentials
 * are ever copied into an alert.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

let execFileMemo;
function execFile(...args) {
  return (execFileMemo ??= promisify(execFileCallback))(...args);
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const permitted = {
  readiness: new Set(['media', 'sip', 'worker', 'sidecar', 'media-http', 'sidecar-http', 'worker-ingest',
    'turn-certificate']),
  usage: new Set(['usage-telemetry-unavailable', 'usage-account-missing', 'missingPolicy', 'suspended',
    'expired', 'exhausted', 'malformed']),
  backup: new Set(['backup-stale', 'backup-integrity-unavailable']),
};
const instructions = {
  readiness: 'Inspect the Phone media, SIP, worker, sidecar and hosted TURN readiness checks.',
  usage: 'Inspect the stored Phone usage approval, period and hard-cap policy; reconcile provider charges separately.',
  backup: 'Inspect the private Phone backup archive and receipt, then run an isolated restore drill.',
};

async function execute(command, args, env) {
  try {
    const { stdout } = await execFile(command, args, { env, timeout: 10_000, maxBuffer: 16_384 });
    return { code: 0, stdout };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? '' };
  }
}

export async function deliverPhoneOpsNotice(input, invoke = execFile) {
  // The fixed operational identity cannot inherit an agent session's identity.
  // This call uses the sanctioned MCP CLI and the already-existing owner rail.
  await invoke(process.execPath, [
    join(repo, 'scripts/mcp-call.mjs'), 'notifications:send_owner',
    JSON.stringify(input), '--client', 'phone-ops-alert', '--workspace',
    'papercusp-workspace', '--harness', 'papercusp',
  ], { timeout: 15_000, maxBuffer: 16_384 });
}

function readState(path) {
  if (!existsSync(path)) return { version: 1, active: {} };
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('private alert state unavailable');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state?.version !== 1 || !state.active || Array.isArray(state.active) ||
      typeof state.active !== 'object') throw new Error('invalid alert state');
  for (const [key, value] of Object.entries(state.active)) {
    if (!/^(readiness|usage|backup):[A-Za-z0-9-]+$/.test(key) ||
        typeof value?.since !== 'string' || typeof value?.lastSentDate !== 'string') {
      throw new Error('invalid alert state');
    }
  }
  return state;
}

function saveState(path, state) {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function conditions(name, result) {
  let data;
  try { data = JSON.parse(result.stdout); } catch { return [`${name}:check-unavailable`]; }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean' ||
      !Array.isArray(data.alerts)) return [`${name}:check-unavailable`];
  const alerts = data.alerts.map(alert => {
    const condition = name === 'readiness' ? alert?.component : alert?.condition;
    return permitted[name].has(condition) ? `${name}:${condition}` : `${name}:check-unavailable`;
  });
  if (result.code !== 0 || !data.ok || alerts.length) return [...new Set(alerts.length ? alerts : [`${name}:check-unavailable`])];
  return [];
}

/** Inject runner/notifier for conventional isolated integration tests. */
export async function runPhoneOpsAlert({
  env = process.env, now = new Date(), run = execute, notify = deliverPhoneOpsNotice,
  statePath = join(env.PHONE_CONFIG_DIR || join(homedir(), '.config/papercusp-phone'), 'ops-alert-state.json'),
} = {}) {
  const configDir = dirname(statePath);
  const configStat = lstatSync(configDir);
  if (!configStat.isDirectory() || (configStat.mode & 0o077) !== 0) {
    throw new Error('private Phone configuration directory required');
  }
  const state = readState(statePath);
  const date = now.toISOString().slice(0, 10);
  const checks = [
    ['readiness', 'bash', [join(here, 'deploy.sh'), '--status']],
    ['usage', process.execPath, [join(here, 'phone-db-backup.mjs'), 'usage-status']],
  ];
  const archive = env.PHONE_BACKUP_ARCHIVE;
  const maxAge = env.PHONE_BACKUP_MAX_AGE_HOURS;
  if (archive && isAbsolute(archive) && Number.isFinite(Number(maxAge)) &&
      Number(maxAge) > 0 && Number(maxAge) <= 168) {
    checks.push(['backup', process.execPath, [join(here, 'phone-db-backup.mjs'),
      'backup-status', '--archive', archive, '--max-age-hours', String(maxAge)]]);
  }
  const failures = new Set(archive && checks.length === 3 ? [] : ['backup:config-missing']);
  for (const [name, command, args] of checks) {
    try {
      for (const key of conditions(name, await run(command, args, env))) failures.add(key);
    } catch { failures.add(`${name}:check-unavailable`); }
  }
  const next = { version: 1, active: { ...state.active } };
  let notificationsSent = 0;
  for (const key of failures) {
    const [group, condition] = key.split(':');
    const prior = state.active[key];
    if (prior?.lastSentDate !== date) {
      await notify({
        dedupeKey: `phone-ops:${key}:${date}`, harness: 'papercusp',
        title: `Phone operations: ${group} ${condition}`,
        body: `${instructions[group]} Condition: ${condition}. Public calling and provider spend are not verified by this check.`,
        importance: 'high', sourceRef: 'phone-ops-alert',
      });
      notificationsSent++;
    }
    next.active[key] = { since: prior?.since ?? now.toISOString(), lastSentDate: date };
  }
  for (const [key, prior] of Object.entries(state.active)) {
    if (failures.has(key)) continue;
    await notify({
      dedupeKey: `phone-ops:recovered:${key}:${prior.since}`, harness: 'papercusp',
      title: `Phone operations: ${key} recovered`,
      body: 'The local Phone operations check no longer reports this fault. Confirm service and public readiness independently.',
      importance: 'normal', sourceRef: 'phone-ops-alert',
    });
    notificationsSent++;
    delete next.active[key];
  }
  saveState(statePath, next);
  return { ok: failures.size === 0, conditions: [...failures].sort(), notificationsSent,
    scope: 'local-source-operations-only', publicPhoneVerified: false, liveProviderSpendVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhoneOpsAlert().then(result => {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    // The delivery channel failing is not a healthy check. Never print a raw
    // subprocess/MCP error: it can contain environment values or archive paths.
    console.error('Phone operations alert check or delivery failed');
    process.exitCode = 1;
  });
}
