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
    [ "$FAKE_FAIL_PHASE" != set ] || exit 19
    for a in "$@"; do case "$a" in --machine-type=*) echo "$a" | cut -d= -f2 > "$mt" ;; esac; done
    exit 0 ;;
  *"instances stop"*) [ "$FAKE_FAIL_PHASE" != stop ] || exit 17; echo TERMINATED > "$st"; exit 0 ;;
  *"instances start"*) [ "$FAKE_FAIL_PHASE" != start ] || exit 23; echo RUNNING > "$st"; touch "$FAKE/started"; : > "$FAKE/ssh.tries"; exit 0 ;;
  *"instances set-scheduling"*)
    [ "$FAKE_FAIL_PHASE" != schedule ] || exit 29
    [ "$(cat "$st")" = TERMINATED ] || exit 30
    case "$*" in *--clear-max-run-duration*) ;; *) exit 31 ;; esac
    node - "$@" <<'NODE'
const fs = require('node:fs');
const file = process.env.FAKE + '/schedule.json';
const vm = JSON.parse(fs.readFileSync(file, 'utf8'));
const flag = name => process.argv.slice(2).find(a => a.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
if (process.env.FAKE_SCHEDULE_MODE !== 'unchanged') {
  delete vm.scheduling.maxRunDuration;
  vm.scheduling.terminationTime = flag('termination-time');
  vm.scheduling.instanceTerminationAction = flag('instance-termination-action');
  if (process.env.FAKE_SCHEDULE_MODE === 'extended') vm.scheduling.terminationTime = new Date(Date.parse(vm.scheduling.terminationTime) + 3600000).toISOString();
  if (process.env.FAKE_SCHEDULE_MODE === 'expired') vm.scheduling.terminationTime = '2000-01-01T00:00:00Z';
  if (process.env.FAKE_SCHEDULE_MODE === 'stop') vm.scheduling.instanceTerminationAction = 'STOP';
}
fs.writeFileSync(file, JSON.stringify(vm));
NODE
    exit $? ;;
  *"instances describe"*)
    [ "$FAKE_FAIL_PHASE" != describe ] || exit 33
    [ "$FAKE_INVALID_JSON" != 1 ] || { echo invalid; exit 0; }
    node <<'NODE'
const fs = require('node:fs');
const root = process.env.FAKE;
const vm = JSON.parse(fs.readFileSync(root + '/schedule.json', 'utf8'));
vm.status = fs.readFileSync(root + '/status', 'utf8').trim();
vm.machineType = fs.readFileSync(root + '/machine-type', 'utf8').trim();
if (fs.existsSync(root + '/started') && process.env.FAKE_AFTER_START_DRIFT === '1') vm.scheduling.terminationTime = new Date(Date.parse(vm.scheduling.terminationTime) + 3600000).toISOString();
console.log(JSON.stringify(vm));
NODE
    exit $? ;;
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
  *" teardown "*) [ "$FAKE_TEARDOWN_RC" != 4 ] || { echo 'verified: false'; exit 4; }; echo "deleted 1 instance(s); verified: true" ;;
esac
exit 0
`;

describe('vm/gce-resize.sh (faked gcloud + gcp-rails)', () => {
  let root: string;
  const out = () => path.join(root, 'out');
  const calls = () => readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n');
  const runLog = () => readFileSync(path.join(out(), 'run.log'), 'utf8');
  const initial = () => ({
    creationTimestamp: new Date(Date.now() - 60_000).toISOString(),
    scheduling: { instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: '3600' } },
  });
  const schedule = (value: unknown) => writeFileSync(path.join(root, 'schedule.json'), JSON.stringify(value));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'gce-resize-'));
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [['gcloud', FAKE_GCLOUD], ['npx', FAKE_NPX]] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    writeFileSync(path.join(root, 'status'), 'NONE\n');
    schedule(initial());
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

  it.each(['stop', 'set', 'schedule', 'start'])('refuses to report success after a failed %s', (phase) => {
    const r = run({ FAKE_FAIL_PHASE: phase });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(runLog()).not.toMatch(/^DONE /m);
    const c = calls();
    const stopped = c.findIndex(line => line.includes('instances stop'));
    const failed = phase === 'set'
      ? c.findIndex((line, index) => index > stopped && line.includes('set-machine-type'))
      : c.findIndex(line => line.includes(`instances ${phase === 'schedule' ? 'set-scheduling' : phase}`));
    expect(failed).toBeGreaterThan(-1);
    expect(c.slice(failed + 1).every(line => line.includes(' teardown '))).toBe(true);
    expect(c.at(-1)).toContain(' teardown ');
  });

  it.each(['relative', 'absolute'])('conserves the original %s DELETE deadline across restart', (kind) => {
    const vm = initial();
    const deadline = new Date(Date.parse(vm.creationTimestamp) + 3_600_000).toISOString();
    schedule(kind === 'relative' ? vm : { scheduling: { instanceTerminationAction: 'DELETE', terminationTime: deadline } });
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const c = calls();
    const pin = c.findIndex(line => line.includes('set-scheduling'));
    const start = c.findIndex(line => line.includes('instances start'));
    expect(c[pin]).toContain(`--clear-max-run-duration --termination-time=${deadline} --instance-termination-action=DELETE`);
    expect(pin).toBeLessThan(start);
    expect(c[pin + 1]).toContain('instances describe');
    expect(c[start + 1]).toContain('instances describe');
    const saved = JSON.parse(readFileSync(path.join(out(), 'after-start.json'), 'utf8'));
    expect(saved.scheduling).toEqual({ instanceTerminationAction: 'DELETE', terminationTime: deadline });
    expect(runLog().match(/^DELETE_DEADLINE=/gm)).toHaveLength(3);
    expect(runLog().indexOf('DONE ')).toBeGreaterThan(runLog().indexOf('TEARDOWN_RC=0'));
  });

  it.each([
    ['missing', {}],
    ['expired', { instanceTerminationAction: 'DELETE', terminationTime: '2000-01-01T00:00:00Z' }],
    ['non-DELETE', { instanceTerminationAction: 'STOP', maxRunDuration: { seconds: '3600' } }],
    ['invalid-duration', { instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: 'no' } }],
  ])('rejects an initially %s schedule before SSH or resize', (_kind, scheduling) => {
    schedule({ ...initial(), scheduling });
    const r = run();
    expect(r.status).toBe(5);
    expect(calls().filter(line => line.startsWith('gcloud '))).toHaveLength(1);
    expect(runLog()).toContain('ABORT unsafe schedule (initial)');
    expect(calls().at(-1)).toContain(' teardown ');
  });

  it.each(['unchanged', 'extended', 'expired', 'stop'])('rejects a successful schedule update with %s lifetime before starting', mode => {
    const r = run({ FAKE_SCHEDULE_MODE: mode });
    expect(r.status).toBe(5);
    expect(calls().some(line => line.includes('instances start'))).toBe(false);
    expect(runLog()).toContain('ABORT unsafe schedule (before-start)');
    expect(runLog()).not.toMatch(/^DONE /m);
  });

  it('rejects schedule drift after start before further SSH or success', () => {
    const r = run({ FAKE_AFTER_START_DRIFT: '1' });
    expect(r.status).toBe(5);
    const c = calls();
    const start = c.findIndex(line => line.includes('instances start'));
    expect(c.slice(start + 1).some(line => line.includes('compute ssh'))).toBe(false);
    expect(runLog()).toContain('ABORT unsafe schedule (after-start)');
    expect(runLog()).not.toMatch(/^DONE /m);
  });

  it.each(['describe-failure', 'invalid-json'])('fails closed on unreadable provider scheduling: %s', kind => {
    const r = run(kind === 'describe-failure' ? { FAKE_FAIL_PHASE: 'describe' } : { FAKE_INVALID_JSON: '1' });
    expect(r.status).toBe(5);
    expect(calls().some(line => line.includes('instances stop'))).toBe(false);
    expect(calls().at(-1)).toContain(' teardown ');
  });

  it('does not report success when resource teardown is unverified', () => {
    const r = run({ FAKE_TEARDOWN_RC: '4' });
    expect(r.status).toBe(4);
    expect(runLog()).toContain('TEARDOWN_RC=4');
    expect(runLog()).not.toMatch(/^DONE /m);
  });

  it('retains the primary lifecycle failure when teardown also fails', () => {
    const r = run({ FAKE_FAIL_PHASE: 'stop', FAKE_TEARDOWN_RC: '4' });
    expect(r.status).toBe(17);
    expect(runLog()).toContain('TEARDOWN_RC=4');
    expect(runLog()).not.toMatch(/^DONE /m);
  });
});
