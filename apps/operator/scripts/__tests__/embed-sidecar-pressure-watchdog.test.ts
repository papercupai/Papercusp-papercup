import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SYSTEMD_DIR = resolve(__dirname, '..', 'systemd');
const SIDECAR_UNIT = resolve(SYSTEMD_DIR, 'papercup-embed-sidecar.service');
const WATCHDOG_UNIT = resolve(SYSTEMD_DIR, 'papercup-embed-sidecar-watchdog.service');
// Overridable so a mutation probe can point the suite at a mutated copy.
const WATCHDOG_SCRIPT =
  process.env.EMBED_WATCHDOG_SCRIPT_UNDER_TEST ?? resolve(SYSTEMD_DIR, 'papercup-embed-sidecar-watchdog.sh');

const NOW = 1_800_000_000;

const GOOD_EMBED = JSON.stringify({ vectors: [[0.1, 0.2]], cache: { hits: 0, coalesced: 0, inferred: 1 } });
const SATURATED_HEALTHZ = JSON.stringify({
  ok: true,
  pid: 123,
  uptimeMs: 3600000,
  workers: { embedder: { alive: true } },
  queue: { saturated: true, depth: 4 },
  inferenceProgress: { 'gemma:query': { completed: 10, lastCompletedAtMs: NOW * 1000 } },
});
const IDLE_HEALTHZ = JSON.stringify({ ok: true, workers: { embedder: { alive: true } }, queue: { saturated: false, depth: 0 } });

// systemctl stub: answers is-active / show from env and records every call.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in
  *is-active*) exit "\${FAKE_ACTIVE_EXIT:-0}" ;;
  *ActiveEnterTimestamp*) printf '%s\\n' "\${FAKE_ENTERED:-}" ;;
  *restart*) exit 0 ;;
esac
`;

// curl stub: /embed and /healthz behaviour come from env; the request body is
// written to FAKE_BODY so the test can parse exactly what bash sent.
const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--data-binary" ]]; then printf '%s' "$arg" > "$FAKE_BODY"; fi
  prev="$arg"
done
echo "curl $url" >> "$FAKE_LOG"
case "$url" in
  */embed)
    case "\${FAKE_EMBED:-ok}" in
      ok) printf '%s' "$FAKE_GOOD_EMBED" ;;
      refused) echo "curl: (7) Failed to connect" >&2; exit 7 ;;
      bad-accounting) printf '%s' '{"vectors":[[0.1]],"cache":{"hits":1,"coalesced":0,"inferred":0}}' ;;
    esac ;;
  */healthz)
    case "\${FAKE_HEALTHZ:-down}" in
      saturated) printf '%s' "$FAKE_SATURATED_HEALTHZ" ;;
      idle) printf '%s' "$FAKE_IDLE_HEALTHZ" ;;
      down) exit 7 ;;
    esac ;;
esac
`;

let dir: string;

function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

interface RunOpts {
  active?: boolean;
  enteredAgoSec?: number | null;
  embed?: 'ok' | 'refused' | 'bad-accounting';
  healthz?: 'saturated' | 'idle' | 'down';
  saturatedHealth?: Record<string, unknown>;
}

function runWatchdog(opts: RunOpts = {}) {
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    EMBED_WATCHDOG_SYSTEMCTL: join(dir, 'systemctl'),
    EMBED_WATCHDOG_CURL: join(dir, 'curl'),
    EMBED_WATCHDOG_STATE_FILE: join(dir, 'failures'),
    EMBED_WATCHDOG_NOW_EPOCH: String(NOW),
    FAKE_LOG: log,
    FAKE_BODY: join(dir, 'body.json'),
    FAKE_ACTIVE_EXIT: opts.active === false ? '3' : '0',
    FAKE_ENTERED: opts.enteredAgoSec === null ? '' : `@${NOW - (opts.enteredAgoSec ?? 3600)}`,
    FAKE_EMBED: opts.embed ?? 'ok',
    FAKE_HEALTHZ: opts.healthz ?? 'down',
    FAKE_GOOD_EMBED: GOOD_EMBED,
    FAKE_SATURATED_HEALTHZ: opts.saturatedHealth ? JSON.stringify(opts.saturatedHealth) : SATURATED_HEALTHZ,
    FAKE_IDLE_HEALTHZ: IDLE_HEALTHZ,
  };
  const res = spawnSync('bash', [WATCHDOG_SCRIPT], { env, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    status: res.status,
    stdout: res.stdout,
    calls,
    restarts: calls.filter((c) => c.includes(' restart')),
    probed: calls.some((c) => c.endsWith('/embed')),
  };
}

function failureCount(): string | null {
  const path = join(dir, 'failures');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'embed-watchdog-'));
  stub('systemctl', FAKE_SYSTEMCTL);
  stub('curl', FAKE_CURL);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('embed sidecar pressure supervision contract', () => {
  it('starts the last-known-good bundle after a transient shared-tree build failure', () => {
    const unit = readFileSync(SIDECAR_UNIT, 'utf8');
    const environment = unit.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('Environment='));

    expect(unit).toMatch(/^ExecStartPre=.*papercusp-script-snapshot\.sh .*bin\/bundle-host\.sh/m);
    expect(environment).toContain('Environment=PAPERCUSP_BUNDLE_ALLOW_STALE_START=1');
    expect(unit).toContain('Restart=always');
  });

  it('bounds sidecar memory and turns an OOM into a restartable unit failure', () => {
    const unit = readFileSync(SIDECAR_UNIT, 'utf8');

    expect(unit).toContain('MemoryAccounting=yes');
    expect(unit).toContain('MemoryHigh=10G');
    expect(unit).toContain('MemoryMax=12G');
    expect(unit).toContain('MemorySwapMax=0');
    expect(unit).toContain('OOMPolicy=kill');
    expect(unit).toContain('Restart=always');
  });

  it('provides the CUDA provider loader path and documents its distro dependencies', () => {
    const unit = readFileSync(SIDECAR_UNIT, 'utf8');
    const setup = readFileSync(resolve(SYSTEMD_DIR, 'README.md'), 'utf8');

    expect(unit).toContain('Environment=LD_LIBRARY_PATH=/usr/local/lib/ollama/cuda_v12');
    expect(setup).toContain('sudo apt-get install libcurand10 libcufft11');
  });

  it('runs the tracked watchdog script through the snapshot launcher', () => {
    const unit = readFileSync(WATCHDOG_UNIT, 'utf8');
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));

    expect(execStart).toBe(
      'ExecStart=%h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-script-snapshot.sh ' +
        '%h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercup-embed-sidecar-watchdog.sh',
    );
    expect(statSync(resolve(SYSTEMD_DIR, 'papercup-embed-sidecar-watchdog.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('papercup-embed-sidecar-watchdog.sh', () => {
  it('sends a well-formed cache-bypassing gemma query to /embed', () => {
    const run = runWatchdog();

    expect(run.status).toBe(0);
    const body = JSON.parse(readFileSync(join(dir, 'body.json'), 'utf8'));
    expect(body).toEqual({
      model: 'gemma',
      kind: 'query',
      texts: ['papercup-embed-sidecar-watchdog'],
      bypassCache: true,
    });
  });

  it('leaves a healthy worker alone and clears any earlier failure count', () => {
    writeFileSync(join(dir, 'failures'), '1');
    const run = runWatchdog({ embed: 'ok' });

    expect(run.probed).toBe(true);
    expect(run.restarts).toEqual([]);
    expect(failureCount()).toBe('0');
  });

  it('does not probe a unit that is not active (stopped or still in ExecStartPre)', () => {
    const run = runWatchdog({ active: false, embed: 'refused' });

    expect(run.status).toBe(0);
    expect(run.probed).toBe(false);
    expect(run.restarts).toEqual([]);
  });

  // EI-25222670171204378: the unit turns active before it listens, so a probe
  // right after activation gets "connection refused" from a healthy start.
  it('skips the probe inside the startup grace even when the port refuses', () => {
    writeFileSync(join(dir, 'failures'), '1');
    const run = runWatchdog({ enteredAgoSec: 5, embed: 'refused' });

    expect(run.status).toBe(0);
    expect(run.probed).toBe(false);
    expect(run.restarts).toEqual([]);
    expect(run.stdout).toContain('startup grace');
    expect(failureCount()).toBe('0');
  });

  it('probes once the grace has elapsed', () => {
    const run = runWatchdog({ enteredAgoSec: 181, embed: 'ok' });

    expect(run.probed).toBe(true);
  });

  it('probes when systemd has no activation timestamp rather than skipping forever', () => {
    const run = runWatchdog({ enteredAgoSec: null, embed: 'ok' });

    expect(run.probed).toBe(true);
  });

  it('does not restart on a single failed probe', () => {
    const run = runWatchdog({ embed: 'refused' });

    expect(run.status).toBe(0);
    expect(run.restarts).toEqual([]);
    expect(failureCount()).toBe('1');
    expect(run.stdout).toContain('1/2 consecutive');
  });

  it('restarts without blocking on the start job after two consecutive failures', () => {
    runWatchdog({ embed: 'refused' });
    const second = runWatchdog({ embed: 'bad-accounting' });

    expect(second.restarts).toEqual([
      'systemctl --user restart --no-block papercup-embed-sidecar.service',
    ]);
    expect(second.stdout).toContain('restarting papercup-embed-sidecar');
    expect(failureCount()).toBe('0');
  });

  it('a passing probe between failures resets the count', () => {
    runWatchdog({ embed: 'refused' });
    runWatchdog({ embed: 'ok' });
    const third = runWatchdog({ embed: 'refused' });

    expect(third.restarts).toEqual([]);
    expect(failureCount()).toBe('1');
  });

  it('defers only when successful inference advances and resets previous failures', () => {
    runWatchdog({ embed: 'refused', healthz: 'saturated' });
    const health = JSON.parse(SATURATED_HEALTHZ);
    health.inferenceProgress['gemma:query'].completed++;
    const run = runWatchdog({ embed: 'refused', healthz: 'saturated', saturatedHealth: health });
    expect(run.restarts).toEqual([]);
    expect(run.stdout).toContain('deferring restart');
    expect(failureCount()).toBe('0');
  });

  it('recovers a saturated live worker that makes no successful inference progress', () => {
    const first = runWatchdog({ embed: 'refused', healthz: 'saturated' });
    expect(first.restarts).toEqual([]);
    const second = runWatchdog({ embed: 'refused', healthz: 'saturated' });
    expect(second.restarts).toHaveLength(1);
    expect(second.stdout).not.toContain('deferring restart');
  });

  it.each(['missing progress', 'different pid', 'reset uptime', 'decreased count', 'invalid count'])(
    'does not interpret %s as successful progress', (mode) => {
      runWatchdog({ embed: 'refused', healthz: 'saturated' });
      const health = JSON.parse(SATURATED_HEALTHZ);
      health.inferenceProgress['gemma:query'].completed++;
      if (mode === 'missing progress') delete health.inferenceProgress;
      if (mode === 'different pid') health.pid++;
      if (mode === 'reset uptime') health.uptimeMs = 1;
      if (mode === 'decreased count') health.inferenceProgress['gemma:query'].completed = 1;
      if (mode === 'invalid count') health.inferenceProgress['gemma:query'].completed = 'eleven';
      const run = runWatchdog({ embed: 'refused', healthz: 'saturated', saturatedHealth: health });
      expect(run.restarts).toHaveLength(1);
    },
  );

  it('does not carry a failure streak through an advancing saturated interval', () => {
    runWatchdog({ embed: 'refused', healthz: 'saturated' });
    const health = JSON.parse(SATURATED_HEALTHZ);
    health.inferenceProgress['gemma:query'].completed++;
    runWatchdog({ embed: 'refused', healthz: 'saturated', saturatedHealth: health });
    expect(runWatchdog({ embed: 'refused', healthz: 'saturated', saturatedHealth: health }).restarts).toEqual([]);
    expect(failureCount()).toBe('1');
    expect(runWatchdog({ embed: 'refused', healthz: 'saturated', saturatedHealth: health }).restarts).toHaveLength(1);
  });

  it('does not treat an idle (unsaturated) healthz as a reason to defer', () => {
    runWatchdog({ embed: 'refused', healthz: 'idle' });
    const run = runWatchdog({ embed: 'refused', healthz: 'idle' });

    expect(run.restarts).toHaveLength(1);
  });
});
