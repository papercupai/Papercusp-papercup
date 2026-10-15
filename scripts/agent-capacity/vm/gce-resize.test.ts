import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'gce-resize.sh');

// A stateful fake gcloud. Like real GCE for an e2 VM, set-machine-type is refused while the VM is
// RUNNING and accepted once it is TERMINATED; describe reports the current type and status.
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
echo "gcloud $*" >> "$FAKE/calls.log"
st="$FAKE/status"; mt="$FAKE/machine-type"
case "$*" in
  *"compute ssh"*)
    n=$(cat "$FAKE/ssh.tries" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/ssh.tries"
    [ "$n" -ge "$((FAKE_SSH_FAIL + 0))" ] || exit 255
    [ "$(cat "$st")" = RUNNING ] || exit 255
    case "$*" in *nproc*) echo 4; echo "Mem: 16000 1000 15000" ;; esac
    exit 0 ;;
  *"instances set-machine-type"*)
    if [ "$(cat "$st")" = RUNNING ]; then
      echo "ERROR: (gcloud.compute.instances.set-machine-type) The resource is not ready: instance must be stopped" >&2
      exit 1
    fi
    for a in "$@"; do case "$a" in --machine-type=*) echo "$a" | cut -d= -f2 > "$mt" ;; esac; done
    exit 0 ;;
  *"instances stop"*) echo TERMINATED > "$st"; exit 0 ;;
  *"instances start"*) echo RUNNING > "$st"; : > "$FAKE/ssh.tries"; exit 0 ;;
  *"instances describe"*) echo "$(cat "$mt") $(cat "$st")"; exit 0 ;;
esac
exit 0
`;

// gcp-rails is reached through npx tsx; the fake records the call and "creates" the VM.
const FAKE_NPX = String.raw`#!/usr/bin/env bash
echo "npx $*" >> "$FAKE/calls.log"
case "$*" in
  *" create "*)
    [ "$((FAKE_CREATE_RC + 0))" -eq 0 ] || { echo "quota exceeded"; exit "$FAKE_CREATE_RC"; }
    echo RUNNING > "$FAKE/status"; echo e2-standard-2 > "$FAKE/machine-type"; echo created ;;
  *" teardown "*) echo "deleted 1 instance(s); verified: true" ;;
esac
exit 0
`;

describe('vm/gce-resize.sh (faked gcloud + gcp-rails)', () => {
  let root: string;
  const out = () => path.join(root, 'out');
  const calls = () => readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n');
  const runLog = () => readFileSync(path.join(out(), 'run.log'), 'utf8');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'gce-resize-'));
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [['gcloud', FAKE_GCLOUD], ['npx', FAKE_NPX]] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    writeFileSync(path.join(root, 'status'), 'NONE\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        FAKE: root,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        AGENT_CAPACITY_OUT: out(),
        AGENT_CAPACITY_ROOT: root,
        RESIZE_RUN: 'resizetest',
        GCP_PROJECT: 'proj',
        GCP_ZONE: 'zone-a',
        RESIZE_SSH_SLEEP: '0',
        ...env,
      },
    });

  it('records the live-resize refusal, then measures stop -> set -> start -> ssh, and tears down', () => {
    const r = run({ FAKE_SSH_FAIL: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const log = runLog();
    expect(log).toMatch(/^CREATE_RC=0$/m);
    expect(log).toMatch(/^SSH_OK after [\d.]+ s \(attempt 2\)$/m);
    // The live change is refused on a running e2 VM; that refusal is the first half of the answer.
    expect(log).toMatch(/^LIVE_RESIZE_RC=1 after [\d.]+ s$/m);
    expect(log).toMatch(/^LIVE_RESIZE_OUT .*instance must be stopped/m);
    expect(log).toMatch(/^STOP_RC=0 stop_s=[\d.]+$/m);
    expect(log).toMatch(/^SET_RC=0 set_s=[\d.]+$/m);
    expect(log).toMatch(/^START_RC=0 start_s=[\d.]+$/m);
    expect(log).toMatch(/^OUTAGE_TOTAL_S [\d.]+ \(stop -> ssh reachable\)$/m);
    expect(log).toMatch(/^MACHINE_TYPE_NOW e2-standard-4 RUNNING$/m);
    expect(log).toMatch(/^DONE /m);
    expect(log).toMatch(/^TEARDOWN_RC=0 /m);

    const c = calls();
    const at = (re: RegExp) => c.findIndex((l) => re.test(l));
    const create = at(/^npx tsx scripts\/agent-capacity\/gcp-rails\.ts create --run=resizetest --name=cap-resizetest --machine-type=e2-standard-2 --max-hours=1$/);
    const stop = at(/^gcloud compute instances stop cap-resizetest --project=proj --zone=zone-a/);
    const set = c.findIndex((l, i) => i > stop && /^gcloud compute instances set-machine-type cap-resizetest .*--machine-type=e2-standard-4$/.test(l));
    const start = at(/^gcloud compute instances start cap-resizetest/);
    const teardown = at(/^npx tsx scripts\/agent-capacity\/gcp-rails\.ts teardown --run=resizetest$/);
    expect(create).toBe(0);
    expect(stop).toBeGreaterThan(create);
    expect(set).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(set);
    expect(teardown).toBe(c.length - 1);
  });

  it('a failed create aborts with exit 2 before any gcloud call, and still tears down', () => {
    const r = run({ FAKE_CREATE_RC: '1' });
    expect(r.status).toBe(2);
    const log = runLog();
    expect(log).toMatch(/^CREATE_RC=1$/m);
    expect(log).toMatch(/^ABORT create failed$/m);
    expect(log).toMatch(/^TEARDOWN_RC=0 /m);
    const c = calls();
    expect(c.some((l) => l.startsWith('gcloud '))).toBe(false);
    expect(c[c.length - 1]).toBe('npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run=resizetest');
  });

  it('an ssh that never answers fails with exit 3 instead of resizing an unreachable VM, and tears down', () => {
    const r = run({ FAKE_SSH_FAIL: '99', RESIZE_SSH_TRIES: '3' });
    expect(r.status).toBe(3);
    const log = runLog();
    expect(log).toMatch(/^SSH_TIMEOUT after 3 attempts$/m);
    expect(log).not.toMatch(/^LIVE_RESIZE_RC/m);
    expect(calls().some((l) => l.includes('set-machine-type'))).toBe(false);
    expect(log).toMatch(/^TEARDOWN_RC=0 /m);
  });

  it('writes its evidence under AGENT_CAPACITY_OUT, never the real cache', () => {
    run();
    for (const f of ['run.log', 'create.log', 'live-resize.log', 'stop.log', 'set.log', 'start.log', 'teardown.log']) {
      expect(existsSync(path.join(out(), f)), f).toBe(true);
    }
  });
});
