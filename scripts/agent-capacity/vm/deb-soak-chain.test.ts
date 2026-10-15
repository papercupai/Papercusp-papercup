import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'deb-soak-chain.sh');
const BUILD_TEST_DEB = path.join(__dirname, 'build-test-deb.sh');

// Fakes on PATH: systemctl reports the build unit active for FAKE_ACTIVE_POLLS polls; gcloud records the
// upload, crashing the way a concurrent gcloud did on its first FAKE_UPLOAD_FAILS calls (WI-10006787), then
// exiting FAKE_UPLOAD_RC; node stands in for mcp-call (FAKE_RIG_BUSY_TRIES refusals before a lock_id).
// The soak itself is a fake p2p-join-soak.sh that records the environment it was given and whether it
// inherited the chain's rig flock descriptor (fd 9).
const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/calls.log"
n=$(cat "$FAKE/polls" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/polls"
[ "$n" -lt "$((FAKE_ACTIVE_POLLS + 0))" ]
`;
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
echo "gcloud $*" >> "$FAKE/calls.log"
n=$(cat "$FAKE/gcloud-tries" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/gcloud-tries"
if [ "$n" -lt "$((FAKE_UPLOAD_FAILS + 0))" ]; then
  echo 'ERROR: gcloud crashed (OperationalError): database is locked' >&2; exit 1
fi
exit "$((FAKE_UPLOAD_RC + 0))"
`;
const FAKE_NODE = String.raw`#!/usr/bin/env bash
echo "node $*" >> "$FAKE/calls.log"
n=$(cat "$FAKE/rig-tries" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/rig-tries"
if [ "$n" -lt "$((FAKE_RIG_BUSY_TRIES + 0))" ]; then echo '{"ok": false, "status": "held"}'; else echo '{"ok": true, "lock_id": "lk-123"}'; fi
`;
const FAKE_SOAK = String.raw`#!/usr/bin/env bash
env | grep -E '^(RUN|DEB|SHA|RIG_LOCK|SU|AGENT_CAPACITY_OUT|CONFLICT_AT_OBS|REVOKE)=' | sort > "$FAKE/soak-env"
if [ -e "/proc/$$/fd/9" ]; then echo open; else echo closed; fi > "$FAKE/soak-fd9"
echo "fake soak ran"
exit "$((FAKE_SOAK_RC + 0))"
`;

describe('vm/deb-soak-chain.sh (faked systemctl, gcloud, mcp-call, soak)', () => {
  let root: string;
  const out = () => path.join(root, 'out');
  const chain = () => (existsSync(path.join(out(), 'chain.log')) ? readFileSync(path.join(out(), 'chain.log'), 'utf8') : '');
  const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '');
  const soakEnv = () => (existsSync(path.join(root, 'soak-env')) ? readFileSync(path.join(root, 'soak-env'), 'utf8') : '');
  const deb = () => path.join(root, 'artifacts', 'TEST-ARTIFACT-Papercusp Server_0.0.26_amd64.deb');
  // The tail of a real build-test-deb.sh log (c1007, 2026-10-06), with the artifact path pointed at the fixture.
  const goodLog = () => [
    'BUILD_START 2026-10-06T10:30:13Z tree=1189a79350 dirty=47',
    'MARKER d055s2-mark=2',
    'MARKER d055acc-bundle=1',
    'MARKERS_CHECKED phase=sidecar count=10 missing=0 2026-10-06T11:33:30Z',
    'SIDECAR_RC=0 2026-10-06T11:33:29Z',
    `TEST_ARTIFACT_DEB=${deb()}`,
    'DEB_RC=0 2026-10-06T12:47:27Z',
    '',
  ].join('\n');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'deb-soak-chain-'));
    mkdirSync(path.join(root, 'scripts/agent-capacity/vm'), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, 'scripts/agent-capacity/vm/deb-soak-chain.sh'));
    writeFileSync(path.join(root, 'scripts/agent-capacity/vm/p2p-join-soak.sh'), FAKE_SOAK);
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [['systemctl', FAKE_SYSTEMCTL], ['gcloud', FAKE_GCLOUD], ['node', FAKE_NODE]] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    mkdirSync(path.join(root, 'artifacts'));
    writeFileSync(deb(), 'fake deb bytes\n');
    writeFileSync(path.join(root, 'deb.log'), goodLog());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(root, 'scripts/agent-capacity/vm/deb-soak-chain.sh')], {
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: root,
        FAKE: root,
        RUN: 'c9999k',
        BUILD_LOG: path.join(root, 'deb.log'),
        SU: 'su-test',
        OUT: out(),
        GCS_PREFIX: 'gs://fake-bucket',
        RIG_SLEEP_SEC: '0',
        WAIT_POLL_SEC: '0',
        GCS_RETRY_SEC: '0',
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('waits for the build unit, uploads the archived deb, takes the rig lock and runs the soak with its inputs', () => {
    const r = run({ BUILD_UNIT: 'c9999-deb', FAKE_ACTIVE_POLLS: '2', REQUIRE_MARKERS: 'd055acc-bundle d055s2-mark', CONFLICT_AT_OBS: '2' });
    expect(r.code).toBe(0);
    const sha = createHash('sha256').update('fake deb bytes\n').digest('hex');
    // Polled until the unit stopped: two active answers, then inactive.
    expect(calls().split('\n').filter((l) => l.startsWith('systemctl --user is-active -q c9999-deb'))).toHaveLength(3);
    expect(chain()).toMatch(/CHAIN_BUILD deb_rc=0 sidecar_rc=0 deb=.*TEST-ARTIFACT-Papercusp Server_0\.0\.26_amd64\.deb /);
    expect(chain()).toMatch(/CHAIN_MARKERS ok=d055acc-bundle d055s2-mark /);
    expect(chain()).toContain(`DEB_SHA256 ${sha} `);
    expect(calls()).toContain(`gcloud storage cp ${deb()} gs://fake-bucket/c9999k/c9999k.deb --no-user-output-enabled`);
    expect(chain()).toMatch(/RIG_FLOCK_HELD .*\/\.cache\/agent-capacity\/rig\.flock /);
    expect(chain()).toMatch(/RIG_LOCK lk-123 /);
    expect(chain()).toMatch(/CHAIN_SOAK_EXIT=0 /);
    // The soak must not hold the flock: anything it leaves running would otherwise pin the rig.
    expect(readFileSync(path.join(root, 'soak-fd9'), 'utf8')).toBe('closed\n');
    expect(soakEnv()).toBe([
      `AGENT_CAPACITY_OUT=${out()}`,
      'CONFLICT_AT_OBS=2',
      'DEB=gs://fake-bucket/c9999k/c9999k.deb',
      'RIG_LOCK=lk-123',
      'RUN=c9999k',
      `SHA=${sha}`,
      'SU=su-test',
      '',
    ].join('\n'));
    expect(readFileSync(path.join(out(), 'run.log'), 'utf8')).toBe('fake soak ran\n');
  });

  it('parses the result key build-test-deb.sh actually prints (the c1007k BUILD_EXIT= regression)', () => {
    // The contract is pinned against the real producer, not restated: if build-test-deb.sh renames its
    // DEB_RC/SIDECAR_RC lines, this fails instead of every chain aborting on a good build.
    const producer = readFileSync(BUILD_TEST_DEB, 'utf8');
    expect(producer).toMatch(/^echo "DEB_RC=\$rc \$\(ts\)"$/m);
    expect(producer).toMatch(/^echo "SIDECAR_RC=\$rc \$\(ts\)"$/m);
    expect(goodLog()).not.toContain('BUILD_EXIT=');
    expect(run().code).toBe(0);
    expect(chain()).not.toContain('CHAIN_ABORT');
  });

  it('a failed deb step aborts before anything is uploaded or locked', () => {
    writeFileSync(path.join(root, 'deb.log'), goodLog().replace('DEB_RC=0 ', 'DEB_RC=101 '));
    const r = run();
    expect(r.code).toBe(3);
    expect(chain()).toMatch(/CHAIN_ABORT build not usable: DEB_RC=101 /);
    expect(calls()).not.toMatch(/gcloud|node/);
    expect(soakEnv()).toBe('');
  });

  it('a build log with no DEB_RC line (sidecar failed) aborts', () => {
    writeFileSync(path.join(root, 'deb.log'), 'SIDECAR_RC=2 2026-10-06T11:00:00Z\n');
    expect(run().code).toBe(3);
    expect(chain()).toMatch(/CHAIN_BUILD deb_rc=absent sidecar_rc=2 deb=absent /);
    expect(chain()).toMatch(/CHAIN_ABORT build not usable: DEB_RC=absent /);
  });

  it('the LAST DEB_RC wins when a resumed build appended to the same log', () => {
    writeFileSync(path.join(root, 'deb.log'), `DEB_RC=1 2026-10-06T09:00:00Z\n${goodLog()}`);
    expect(run().code).toBe(0);
  });

  it('a TEST_ARTIFACT_DEB that is not a file aborts', () => {
    rmSync(deb());
    expect(run().code).toBe(3);
    expect(chain()).toMatch(/CHAIN_ABORT build not usable: TEST_ARTIFACT_DEB=.* is not a file /);
  });

  it('a required marker that is absent or zero aborts', () => {
    expect(run({ REQUIRE_MARKERS: 'd055acc-bundle wi6624-bundle' }).code).toBe(3);
    expect(chain()).toMatch(/CHAIN_ABORT build not usable: MARKER wi6624-bundle=absent /);
    writeFileSync(path.join(root, 'deb.log'), `${goodLog()}MARKER wi6624-bundle=0\n`);
    rmSync(path.join(out(), 'chain.log'));
    expect(run({ REQUIRE_MARKERS: 'wi6624-bundle' }).code).toBe(3);
    expect(chain()).toMatch(/CHAIN_ABORT build not usable: MARKER wi6624-bundle=0 /);
    expect(soakEnv()).toBe('');
  });

  it('a failed upload aborts before the rig lock, after GCS_TRIES attempts', () => {
    expect(run({ FAKE_UPLOAD_RC: '1', GCS_TRIES: '3' }).code).toBe(4);
    expect(calls().split('\n').filter((l) => l.startsWith('gcloud storage cp '))).toHaveLength(3);
    expect(chain()).toMatch(/CHAIN_ABORT upload to gs:\/\/fake-bucket\/c9999k\/c9999k\.deb failed after 3 tries /);
    expect(calls()).not.toMatch(/^node /m);
    expect(soakEnv()).toBe('');
  });

  it('retries an upload that a concurrent gcloud crashed (the c1010k abort, WI-10006787)', () => {
    expect(run({ FAKE_UPLOAD_FAILS: '2' }).code).toBe(0);
    expect(calls().split('\n').filter((l) => l.startsWith('gcloud storage cp '))).toHaveLength(3);
    expect(chain().match(/CHAIN_UPLOAD_RETRY try=\d\/4 ERROR: gcloud crashed \(OperationalError\): database is locked /g)).toHaveLength(2);
    expect(chain()).toMatch(/DEB_UPLOADED gs:\/\/fake-bucket\/c9999k\/c9999k\.deb /);
    expect(chain()).toMatch(/CHAIN_SOAK_EXIT=0 /);
  });

  it('a second chain as the same SU waits on the host rig flock, which the named lock alone never did (WI-10006817)', async () => {
    const flock = path.join(root, 'rig.flock');
    // Stand in for a chain whose soak is still running: hold the flock the way the chain does (fd 9).
    const holder = spawn('bash', ['-c', 'exec 9>>"$1" && flock 9 && echo held && exec sleep 60', '_', flock], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.on('data', (d) => { if (String(d).includes('held')) resolve(); });
        void exited.then(() => reject(new Error('flock holder exited before it held the lock')));
      });
      // The fake mcp-call grants the named lock at once, exactly as the real one re-grants it to its holder.
      expect(run({ RIG_FLOCK: flock, RIG_TRIES: '1', RIG_SLEEP_SEC: '1' }).code).toBe(5);
      expect(chain()).toMatch(/CHAIN_ABORT rig flock .*rig\.flock still held by another chain after 1s /);
      expect(calls()).not.toMatch(/^node /m);
      expect(soakEnv()).toBe('');
    } finally {
      holder.kill('SIGKILL');
    }
    await exited;
    // Control: once the holder is gone the same chain takes the rig and runs the soak.
    expect(run({ RIG_FLOCK: flock, RIG_TRIES: '1', RIG_SLEEP_SEC: '1' }).code).toBe(0);
    expect(chain()).toMatch(/RIG_FLOCK_HELD .*rig\.flock /);
    expect(soakEnv()).toContain('RIG_LOCK=lk-123');
  });

  it('retries a held rig lock, and gives up after RIG_TRIES without running the soak', () => {
    expect(run({ FAKE_RIG_BUSY_TRIES: '2', RIG_TRIES: '5' }).code).toBe(0);
    expect(calls().split('\n').filter((l) => l.includes('locks:acquire_resource'))).toHaveLength(3);
    rmSync(path.join(root, 'rig-tries'));
    rmSync(path.join(root, 'soak-env'));
    expect(run({ FAKE_RIG_BUSY_TRIES: '99', RIG_TRIES: '3' }).code).toBe(5);
    expect(chain()).toMatch(/CHAIN_ABORT rig lock not acquired after 3 tries /);
    expect(soakEnv()).toBe('');
  });

  it("exits with the soak's own exit code", () => {
    expect(run({ FAKE_SOAK_RC: '6' }).code).toBe(6);
    expect(chain()).toMatch(/CHAIN_SOAK_EXIT=6 /);
  });

  it('refuses to start without RUN, BUILD_LOG or SU', () => {
    for (const missing of ['RUN', 'BUILD_LOG', 'SU']) {
      const r = run({ [missing]: '' });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/USAGE: RUN=<name> BUILD_LOG=/);
    }
  });
});
