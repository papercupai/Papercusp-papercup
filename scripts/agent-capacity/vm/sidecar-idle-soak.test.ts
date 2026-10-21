import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT / PROBE_VM_PROBE let scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'sidecar-idle-soak.sh');
const VM_PROBE = process.env.PROBE_VM_PROBE ?? path.join(__dirname, 'sidecar-idle-probe.sh');

// Fake gcloud: records every call and answers the ssh commands the driver parses. FAKE_IDLE=1 makes
// every tenant idle-exited with no sidecar; FAKE_ENVOPS is the host's env-operator listener count.
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
cmd=""; for a in "$@"; do case "$a" in --command=*) cmd=$(printf '%s' "$a" | sed '1s/^--command=//') ;; esac; done
case "$1 $2" in
  "storage ls") echo "storage ls $3" >> "$FAKE/calls.log"; exit 1 ;;
  "storage cp") echo "storage cp $*" >> "$FAKE/calls.log"; exit "$((FAKE_UPLOAD_RC + 0))" ;;
  "compute scp") echo "scp $*" >> "$FAKE/calls.log"; exit 0 ;;
esac
echo "ssh $(printf '%s' "$cmd" | tr '\n' ' ')" >> "$FAKE/calls.log"
case "$cmd" in
  true) [ "$((FAKE_SSH_FAIL + 0))" -eq 0 ] && exit 0 || exit 1 ;;
  *install-server.sh*)
    printf 'SERVER_HEALTH=ok\nSERVER_PORT=4321\nSERVER_CGROUP=/sys/fs/cgroup/fake\nT_BOOT_TO_HEALTH=40\n'
    exit "$((FAKE_INSTALL_RC + 0))" ;;
  *"sidecar-idle-probe.sh census"*)
    for u in pct1 pct2 pct3; do
      if [ "$((FAKE_IDLE + 0))" = 1 ]; then echo "TENANT $u uid=1 sidecarProcs=0 sidecarPids=none idleExits=1 died=0 realEmbeds=4 "
      else echo "TENANT $u uid=1 sidecarProcs=1 sidecarPids=9, idleExits=0 died=0 realEmbeds=4 "; fi
    done ;;
  *"sidecar-idle-probe.sh envops"*) echo "ENV_OPERATORS pct1 uid=1 serverPort=4321 listeners=0 ports=none"; echo "ENV_OPERATORS_TOTAL listeners=$((FAKE_ENVOPS + 0))" ;;
esac
exit 0
`;
const FAKE_NPX = String.raw`#!/usr/bin/env bash
echo "npx $*" >> "$FAKE/calls.log"
case "$*" in *" create "*) [ "$((FAKE_CREATE_RC + 0))" -eq 0 ] || { echo "quota exceeded"; exit "$FAKE_CREATE_RC"; } ;; esac
case "$*" in *" teardown "*) echo "deleted 1 instance(s); verified: true" ;; esac
exit 0
`;

describe('vm/sidecar-idle-soak.sh (faked gcloud + gcp-rails)', () => {
  let root: string;
  const out = () => path.join(root, 'out');
  const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '');
  const ssh = () => calls().split('\n').filter((l) => l.startsWith('ssh '));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sidecar-idle-soak-'));
    mkdirSync(path.join(root, 'scripts/agent-capacity/vm'), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, 'scripts/agent-capacity/vm/sidecar-idle-soak.sh'));
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [['gcloud', FAKE_GCLOUD], ['npx', FAKE_NPX]] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    writeFileSync(path.join(root, 'test artifact.deb'), 'DEB');
    writeFileSync(path.join(root, 'seed.tgz'), 'SEED');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(root, 'scripts/agent-capacity/vm/sidecar-idle-soak.sh')], {
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: root,
        FAKE: root,
        RUN: 'soaktest',
        DEB_LOCAL: path.join(root, 'test artifact.deb'),
        SEED_TGZ: path.join(root, 'seed.tgz'),
        AGENT_CAPACITY_OUT: out(),
        OBSERVE_MIN: '60',
        OBS_INTERVAL_SEC: '0',
        SSH_RETRY_SLEEP: '0',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('uploads per RUN, creates, installs every tenant, records its port, and stops early once all are idle', () => {
    const r = run({ FAKE_IDLE: '1' });
    expect(r.code, r.out).toBe(0);
    expect(calls()).toContain('storage cp');
    expect(calls()).toContain('gs://pc-agent-capacity-0930-artifacts/soaktest/test_artifact.deb');
    expect(ssh().filter((l) => l.includes('install-server.sh'))).toHaveLength(3);
    for (const u of ['pct1', 'pct2', 'pct3']) expect(calls()).toContain(`echo '4321' > /tmp/port-${u}`);
    expect(r.out).toContain('ENV_OPERATORS_VERDICT label=P-0 total=0 verdict=none');
    expect(r.out).toContain('EARLY_STOP all tenants idle-exited and down for 3 censuses');
    expect(r.out).toContain('OBSERVE_END');
    expect(r.out).toContain('SOAK_DONE rc=0');
  });

  it('reports env-switcher operators as PRESENT when any listen (WI-10006420)', () => {
    const r = run({ FAKE_IDLE: '1', FAKE_ENVOPS: '2' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('ENV_OPERATORS_VERDICT label=P-0 total=2 verdict=present');
    expect(r.out).not.toContain('verdict=none');
  });

  it('a sidecar that never goes idle never triggers the early stop', () => {
    const r = run({ FAKE_IDLE: '0', OBSERVE_MIN: '0' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('EARLY_STOP');
    expect(r.out).toContain('OBSERVE_END');
  });

  it('a STOP file ends the observation before the next census, with the normal teardown', () => {
    mkdirSync(out(), { recursive: true });
    writeFileSync(path.join(out(), 'STOP'), 'rig handover');
    const r = run({ FAKE_IDLE: '0' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('EARLY_STOP stop-file reason=[rig handover]');
    expect(ssh().filter((l) => l.includes('sidecar-idle-probe.sh census'))).toHaveLength(1);
    expect(r.out).toContain('TEARDOWN_START');
  });

  it('a failed create exits 3 and STILL runs teardown (a half-created VM bills)', () => {
    const r = run({ FAKE_CREATE_RC: '7' });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('CREATE_FAILED');
    expect(calls()).toContain('teardown --run=soaktest');
    expect(ssh()).toHaveLength(0);
  });

  it('fails closed after SSH readiness never succeeds, before SCP or tenant install', () => {
    const r = run({ FAKE_SSH_FAIL: '1' });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain('SSH_NOT_READY tries=30');
    expect(ssh().filter((l) => l === 'ssh true')).toHaveLength(30);
    expect(calls().split('\n').some((l) => l.startsWith('scp '))).toBe(false);
    expect(ssh().filter((l) => l.includes('install-server.sh'))).toHaveLength(0);
    expect(r.out).toContain('SOAK_DONE rc=0');
  });

  it('a failed tenant install exits 5 after tearing down', () => {
    const r = run({ FAKE_INSTALL_RC: '1' });
    expect(r.code, r.out).toBe(5);
    expect(calls()).toContain('teardown --run=soaktest');
  });

  it('refuses missing inputs (exit 2) before touching GCP', () => {
    expect(run({ DEB_LOCAL: '' }).code).toBe(2);
    expect(run({ SEED_TGZ: path.join(root, 'absent.tgz') }).code).toBe(2);
    expect(calls()).toBe('');
  });
});

describe('vm/sidecar-idle-probe.sh envops (faked sudo, ss, id)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sidecar-idle-probe-'));
    mkdirSync(path.join(root, 'bin'));
    const fakes: Record<string, string> = {
      sudo: '#!/usr/bin/env bash\nexec "$@"\n',
      ss: '#!/usr/bin/env bash\ncat "$FAKE_SS"\n',
      id: '#!/usr/bin/env bash\ncase "$2" in pct1) echo 1001 ;; pct2) echo 1002 ;; *) echo 0 ;; esac\n',
    };
    for (const [name, body] of Object.entries(fakes)) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    writeFileSync(path.join(root, 'port-pct1'), '4321\n');
    writeFileSync(path.join(root, 'port-pct2'), '3170\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const envops = (ss: string[]) => {
    writeFileSync(path.join(root, 'ss.txt'), `${ss.join('\n')}\n`);
    const r = spawnSync('bash', [VM_PROBE, 'envops', 'pct1 pct2'], {
      env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, FAKE_SS: path.join(root, 'ss.txt'), PROBE_STATE_DIR: root },
      encoding: 'utf8',
    });
    return `${r.stdout}${r.stderr}`;
  };
  const listen = (port: number, pid: number, uid: number) =>
    `LISTEN 0      511        127.0.0.1:${port}       0.0.0.0:*    users:(("node",pid=${pid},fd=20)) uid:${uid} ino:${pid} sk:1`;

  it("counts a tenant's env-operator listeners but never its OWN Server port", () => {
    const o = envops([listen(3070, 11, 1001), listen(4321, 12, 1001), listen(3055, 13, 1002), listen(3170, 14, 1002)]);
    expect(o).toContain('ENV_OPERATORS pct1 uid=1001 serverPort=4321 listeners=1 ports=3070,');
    // pct2's Server itself listens on 3170, so only its Vite :3055 counts.
    expect(o).toContain('ENV_OPERATORS pct2 uid=1002 serverPort=3170 listeners=1 ports=3055,');
    expect(o).toContain('ENV_OPERATORS_TOTAL listeners=2');
  });

  it('reads zero when only the tenant Servers listen (the WI-10006420 fix)', () => {
    const o = envops([listen(4321, 12, 1001), listen(3170, 14, 1002), listen(8788, 15, 1001)]);
    expect(o).toContain('ENV_OPERATORS pct1 uid=1001 serverPort=4321 listeners=0 ports=none');
    expect(o).toContain('ENV_OPERATORS pct2 uid=1002 serverPort=3170 listeners=0 ports=none');
    expect(o).toContain('ENV_OPERATORS_TOTAL listeners=0');
  });

  it("counts an operator owned by ANOTHER uid in the total (a tenant adopting a neighbour's operators)", () => {
    const o = envops([listen(3270, 21, 0)]);
    expect(o).toContain('ENV_OPERATORS pct1 uid=1001 serverPort=4321 listeners=0');
    expect(o).toContain('ENV_OPERATORS_TOTAL listeners=1');
  });
});
