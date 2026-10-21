import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'tenant-density.sh');

// Fakes on PATH. gcloud records every call (ssh --command flattened to one line) and answers the few the
// driver parses: install-server.sh (FAKE_FAIL_TENANT makes one tenant's install fail) and the MemAvailable
// read (FAKE_AVAIL GiB). npx stands in for gcp-rails (FAKE_CREATE_RC). sleep is a no-op so the census
// cadence costs nothing. Nothing reaches GCP or the network.
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
cmd=""; for a in "$@"; do case "$a" in --command=*) cmd=$(printf '%s' "$a" | sed '1s/^--command=//') ;; esac; done
case "$1 $2" in
  "storage ls") echo "gcloud storage ls" >> "$FAKE/calls.log"; exit 1 ;;
  "storage cp") echo "gcloud storage cp" >> "$FAKE/calls.log"; exit 0 ;;
  "compute scp") echo "scp $*" >> "$FAKE/calls.log"; exit 0 ;;
esac
echo "ssh $(printf '%s' "$cmd" | tr '\n' ' ')" >> "$FAKE/calls.log"
case "$cmd" in
  true) [ "$((FAKE_SSH_FAIL + 0))" -eq 0 ] && exit 0 || exit 1 ;;
  *install-server.sh*)
    u=$(printf '%s' "$cmd" | sed -n 's/^SVC_USER=\([a-z0-9]*\) .*/\1/p')
    [ "$u" = "$FAKE_FAIL_TENANT" ] && { echo "E: install failed for $u"; exit 1; }
    printf 'SERVER_HEALTH=ok\nSERVER_PORT=43%s\nSERVER_CGROUP=/sys/fs/cgroup/fake-%s\nT_BOOT_TO_HEALTH=12\n' "$(printf '%s' "$u" | sed 's/^pct//')" "$u" ;;
  *MemAvailable*) if [ -n "$FAKE_AVAIL" ]; then echo "$FAKE_AVAIL"; else echo 50; fi ;;
esac
exit 0
`;
const FAKE_NPX = String.raw`#!/usr/bin/env bash
echo "npx $*" >> "$FAKE/calls.log"
case "$*" in *" create "*) exit "$((FAKE_CREATE_RC + 0))" ;; esac
exit 0
`;

describe('vm/tenant-density.sh (faked gcloud, gcp-rails)', () => {
  let root: string;
  const out = () => path.join(root, 'out');
  const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '');
  const lines = () => calls().split('\n');
  // Only the ssh runs of the installer (the scp that stages install-server.sh also names it).
  const installs = () => lines().filter((l) => l.startsWith('ssh ') && l.includes('bash /tmp/install-server.sh'));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tenant-density-'));
    mkdirSync(path.join(root, 'scripts/agent-capacity/vm'), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, 'scripts/agent-capacity/vm/tenant-density.sh'));
    for (const f of ['install-server.sh', 'sample-footprint.py', 'host-sampler.sh']) {
      writeFileSync(path.join(root, 'scripts/agent-capacity/vm', f), '# stub\n');
    }
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [['gcloud', FAKE_GCLOUD], ['npx', FAKE_NPX], ['sleep', '#!/usr/bin/env bash\nexit 0\n']] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    writeFileSync(path.join(root, 'server.deb'), 'deb');
    writeFileSync(path.join(root, 'seed.tgz'), 'seed');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(root, 'scripts/agent-capacity/vm/tenant-density.sh')], {
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: root,
        FAKE: root,
        DEB_LOCAL: path.join(root, 'server.deb'),
        SEED_TGZ: path.join(root, 'seed.tgz'),
        AGENT_CAPACITY_OUT: out(),
        RUN: 'dens-test',
        STEPS: '2 4',
        STEP_MIN: '1',
        CENSUS_SEC: '30',
        SSH_RETRY_SLEEP: '0',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('adds tenants step by step, applies shared and per-tenant env, censuses each step, then tears down', () => {
    const r = run({ TENANT_ENV: 'A=1', TENANT_ENV_pct2: 'PAPERCUSP_EMBED_WORKER_IDLE_MS=0' });
    expect(r.code).toBe(0);
    // Teardown is armed before the VM exists, and runs last.
    const createAt = lines().findIndex((l) => l.includes('gcp-rails.ts create --run=dens-test --name=cap-dens-test --machine-type=e2-standard-16'));
    const teardownAt = lines().findIndex((l) => l.includes('gcp-rails.ts teardown --run=dens-test'));
    expect(createAt).toBeGreaterThan(-1);
    expect(teardownAt).toBeGreaterThan(createAt);
    expect(r.out).toMatch(/DENSITY_DONE rc=0 /);
    // pct1..pct4 in order; the shared env on every tenant, the per-tenant env only on pct2.
    expect(installs().map((l) => l.match(/SVC_USER=(pct\d+)/)?.[1])).toEqual(['pct1', 'pct2', 'pct3', 'pct4']);
    for (const l of installs()) expect(l).toMatch(/PAPERCUSP_DOC_VECTOR_SEED_DIR=\/opt\/agent-capacity\/seed A=1/);
    expect(installs()[1]).toContain('A=1 PAPERCUSP_EMBED_WORKER_IDLE_MS=0');
    expect(installs().filter((l) => l.includes('IDLE_MS'))).toHaveLength(1);
    expect(r.out).toMatch(/TENANT_RESULT pct3 rc=0 port=433 cg=\/sys\/fs\/cgroup\/fake-pct3 T_BOOT_TO_HEALTH=12 /);
    // Two steps, each opened by a census and followed by STEP_MIN*60/CENSUS_SEC more.
    expect(r.out.match(/^#### CENSUS /gm)).toHaveLength(6);
    expect(r.out).toMatch(/#### CENSUS K2-0 tenants=2 /);
    expect(r.out).toMatch(/#### CENSUS K4-1m tenants=4 /);
    expect(r.out).toMatch(/STEP_END K=2 memAvailableGiB=50 /);
    expect(r.out).toMatch(/STEP_END K=4 memAvailableGiB=50 /);
    // Every tenant with a cgroup gets a footprint sampler.
    expect(lines().filter((l) => l.includes('sample-footprint.py --cgroup'))).toHaveLength(4);
  });

  it('stops adding tenants when MemAvailable falls below MIN_AVAIL_GIB after a step', () => {
    const r = run({ FAKE_AVAIL: '3', MIN_AVAIL_GIB: '6' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/STOP_LOW_MEM avail=3GiB at K=2/);
    expect(installs()).toHaveLength(2);
    expect(r.out).not.toMatch(/STEP_START K=4/);
    expect(r.out).toMatch(/DENSITY_DONE /);
  });

  it('records a failed tenant install and keeps going (where installs fail is itself a result)', () => {
    const r = run({ FAKE_FAIL_TENANT: 'pct2' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/TENANT_RESULT pct2 rc=1 port=none cg=none /);
    expect(r.out).toMatch(/\[pct2\] E: install failed for pct2/);
    expect(installs()).toHaveLength(4);
    expect(lines().filter((l) => l.includes('sample-footprint.py --cgroup'))).toHaveLength(3);
  });

  it('a failed VM create still runs the armed teardown', () => {
    const r = run({ FAKE_CREATE_RC: '1' });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/CREATE_FAILED/);
    expect(r.out).toMatch(/TEARDOWN_START /);
    expect(installs()).toHaveLength(0);
  });

  it('fails closed after SSH readiness never succeeds, before staging files with SCP', () => {
    const r = run({ FAKE_SSH_FAIL: '1' });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/SSH_NOT_READY tries=30 /);
    expect(lines().filter((l) => l === 'ssh true')).toHaveLength(30);
    expect(lines().some((l) => l.startsWith('scp '))).toBe(false);
    expect(installs()).toHaveLength(0);
    expect(r.out).toMatch(/DENSITY_DONE rc=0 /);
  });

  it('refuses STEPS that are not increasing tenant counts before touching GCP', () => {
    // (An empty STEPS means the default "4 8 12 16", like every other knob.)
    for (const steps of ['4 2', '2 2', '2 x', '0 2']) {
      const r = run({ STEPS: steps });
      expect(r.code, `STEPS='${steps}'`).toBe(2);
    }
    expect(calls()).toBe('');
  });

  it('refuses to start without the .deb or the seed', () => {
    expect(run({ DEB_LOCAL: '' }).code).toBe(2);
    expect(run({ DEB_LOCAL: path.join(root, 'missing.deb') }).out).toMatch(/NO_DEB /);
    expect(run({ SEED_TGZ: path.join(root, 'missing.tgz') }).out).toMatch(/NO_SEED /);
    expect(calls()).toBe('');
  });
});
