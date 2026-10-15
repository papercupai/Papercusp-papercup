#!/usr/bin/env node
// R-7 run 4 launcher (WI-10004760, voice-final-public-release-2026-10-01 P-004).
// Reads the HOSTED processes' own environment from /proc and hands the secret
// values to the boundaries spec as PORTAL_VOICE_BOUNDARIES_SECRET__<NAME>, so
// the spec's exact-value compare bites against the values the hosted servers
// actually hold. VALUES ARE NEVER PRINTED: the log records names + source unit only.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import hostedLauncher from './portal-hosted-launcher.ts';
const { hostedServiceProcessIds } = hostedLauncher;

const PORTAL = process.env.PAPERCUSP_PORTAL_ROOT ?? join(homedir(), '.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal');
const S = process.env.R7_EVIDENCE_DIR ?? fileURLToPath(new URL('../../../../.papercusp/scratch', import.meta.url));
const RUN = process.env.R7_RUN ?? `run-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
const LOG = `${S}/r7-boundaries-${RUN}.log`;
const RECEIPT = `${S}/r7-boundaries-${RUN}-receipt.json`;
const UNITS = ['papercusp-cloud-portal.service', 'papercusp-phone-sidecar.service'];
const NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/;
const SKIP_RE = /_REF$|_FILE$|PUBLIC|PUBLISHABLE|_ID$/;

const log = (line) => appendFileSync(LOG, `${line}\n`);
const mainPid = (unit) => execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8' }).trim();
const environ = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    });
  } catch { return []; }
};

writeFileSync(LOG, `STARTED=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
log(`PORTAL_HEAD=${execFileSync('git', ['-C', PORTAL, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`);
for (const l of execFileSync('git', ['-C', PORTAL, 'status', '--porcelain', '--', 'e2e/portal-voice-hosted-boundaries.spec.ts', 'playwright.config.ts', 'apps/host/src/api.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean)) log(`PORTAL_DIRTY=${l}`);

// name -> [{ unit, value }]; a name whose value differs across units gets a __<UNIT> suffix.
const found = new Map();
const pidsBefore = {};
for (const unit of UNITS) {
  const pid = mainPid(unit);
  pidsBefore[unit] = pid;
  const pids = hostedServiceProcessIds(Number(pid)).map(String);
  for (const p of pids) for (const [name, value] of environ(p)) {
    if (!NAME_RE.test(name) || SKIP_RE.test(name) || (value?.trim().length ?? 0) < 12) continue;
    const list = found.get(name) ?? [];
    if (!list.some((e) => e.value === value)) list.push({ unit, value });
    found.set(name, list);
  }
  log(`HOSTED_UNIT=${unit} MAIN_PID=${pid} PIDS=${pids.join(',')}`);
}
const secretEnv = {};
const names = [];
for (const [name, list] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  list.forEach((e, i) => {
    const key = i === 0 ? name : `${name}__${e.unit.replace(/\.service$/, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    secretEnv[`PORTAL_VOICE_BOUNDARIES_SECRET__${key}`] = e.value.trim();
    names.push(key);
    log(`SECRET_NAME=${key} SOURCE=${e.unit}`);
  });
}
log(`SECRET_NAME_COUNT=${names.length}`);
if (names.length === 0) { log('RUN_EXIT=2'); log('ABORT=no hosted secret names resolved'); process.exit(2); }

const child = spawn('npx', ['playwright', 'test', 'e2e/portal-voice-hosted-boundaries.spec.ts', '--reporter=list'], {
  cwd: PORTAL,
  env: {
    ...process.env,
    ...secretEnv,
    PORTAL_VOICE_BOUNDARIES_E2E: '1',
    PORTAL_VOICE_BOUNDARIES_EVIDENCE_OUT: RECEIPT,
    PORTAL_VOICE_BOUNDARIES_SECRET_ENV: names.join(','),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => appendFileSync(LOG, d));
child.stderr.on('data', (d) => appendFileSync(LOG, d));
child.on('close', (code) => {
  log(`RUN_EXIT=${code}`);
  for (const unit of UNITS) {
    const after = mainPid(unit);
    log(`HOSTED_UNIT_STABLE=${unit} ${after === pidsBefore[unit] ? 'yes' : `NO before=${pidsBefore[unit]} after=${after}`}`);
  }
  log(`FINISHED=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
  process.exit(code ?? 1);
});
