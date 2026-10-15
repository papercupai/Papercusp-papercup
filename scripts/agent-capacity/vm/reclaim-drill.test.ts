import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT / PROBE_HOOKS let scripts/mutation-probe.sh point the tests at a mutated copy.
const DRILL = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'reclaim-drill.sh');
const HOOKS = process.env.PROBE_HOOKS ?? path.join(__dirname, 'reclaim-vm-hooks.sh');

// A stateful fake gcloud: `instances describe --format=value(status)` pops the next status from a
// queue file (the last one sticks), simulate-maintenance-event and start load the queue the way GCP
// moves a spot VM with terminationAction=STOP, and ssh answers the drill's three remote probes.
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE/gcloud.log"
q="$FAKE/status.queue"
case "$*" in
  *"simulate-maintenance-event"*)
    [ -n "$FAKE_NO_TERMINATE" ] || printf 'RUNNING\nSTOPPING\nTERMINATED\n' > "$q"; exit 0 ;;
  *"instances start"*) printf 'STAGING\nRUNNING\n' > "$q"; exit 0 ;;
  *"value(status)"*)
    head -1 "$q"; [ "$(wc -l < "$q")" -gt 1 ] && sed -i 1d "$q"; exit 0 ;;
  *"lastStopTimestamp"*) echo "2026-10-02T02:00:00.000-07:00 STOP"; exit 0 ;;
  *"operations list"*) echo "2026-10-02T02:00:00Z 2026-10-02T02:00:01Z compute.instances.preempted DONE"; exit 0 ;;
  *"compute scp"*) exit 0 ;;
  *"compute ssh"*)
    case "$*" in
      *healthz*) [ -n "$FAKE_GW_DOWN" ] && echo 000 || echo 200 ;;
      *"--command true"*)
        n=$(cat "$FAKE/ssh.tries" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/ssh.tries"
        [ "$n" -ge "$((FAKE_SSH_FAIL + 0))" ] || exit 255 ;;
      *"bash ~/reclaim-drill/reclaim-claude-run.sh resume"*) echo "RESUME_RC=0"; echo notes_after=21 ;;
      *session_id*) echo "sess-1234" ;;
      *) echo "remote ok" ;;
    esac
    exit 0 ;;
esac
exit 0
`;

describe('vm/reclaim-drill.sh (faked gcloud)', () => {
  let root: string;
  const gcloudCalls = () => readFileSync(path.join(root, 'gcloud.log'), 'utf8').trim().split('\n');
  const out = () => path.join(root, 'out');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'reclaim-drill-'));
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin', 'gcloud'), FAKE_GCLOUD);
    chmodSync(path.join(root, 'bin', 'gcloud'), 0o755);
    writeFileSync(path.join(root, 'status.queue'), 'RUNNING\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [DRILL, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        FAKE: root,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        RECLAIM_OUT: out(),
        RECLAIM_POLL_SEC: '0',
        RECLAIM_SSH_SEC: '0',
        RECLAIM_SETTLE_SEC: '0',
        ...env,
      },
    });
  const lines = (s: string) => s.split('\n').map((l) => l.replace(/ \d{4}-\d\d-\d\dT[\d:.]+Z$/, ''));

  it('reclaim: fires the preemption, waits for TERMINATED, restarts, waits for RUNNING and ssh, in that order', () => {
    const r = run(['reclaim', 'cap-x', 'proj', 'zone-a'], { FAKE_SSH_FAIL: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const marks = lines(r.stdout).filter((l) => /^(RECLAIM_|STATUS |START_|SSH_READY)/.test(l));
    expect(marks).toEqual([
      'RECLAIM_FIRE',
      'RECLAIM_FIRED',
      'STATUS RUNNING',
      'STATUS STOPPING',
      'STATUS TERMINATED',
      'START_FIRE',
      'STATUS STAGING',
      'STATUS RUNNING',
      'SSH_READY try=2',
      'RECLAIM_DONE',
    ]);
    const calls = gcloudCalls();
    const sim = calls.findIndex((c) => c === 'compute instances simulate-maintenance-event cap-x --project=proj --zone=zone-a --async');
    const start = calls.findIndex((c) => c === 'compute instances start cap-x --project=proj --zone=zone-a --async');
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(sim);
    // Every phase keeps its own timestamped log, so a re-run never overwrites earlier evidence.
    const logs = readdirSync(out());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^reclaim-\d{8}T\d{6}Z\.log$/);
    expect(readFileSync(path.join(out(), logs[0]), 'utf8')).toContain('DESCRIBE 2026-10-02T02:00:00.000-07:00 STOP');
  });

  it('reclaim: a VM that never reaches TERMINATED fails with exit 7 and is never restarted', () => {
    const r = run(['reclaim', 'cap-x', 'proj', 'zone-a'], { FAKE_NO_TERMINATE: '1', RECLAIM_POLL_MAX: '3' });
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/^STATUS_TIMEOUT want=TERMINATED last=RUNNING /m);
    expect(r.stdout).toMatch(/^RECLAIM_NOT_TERMINATED /m);
    expect(gcloudCalls().some((c) => c.startsWith('compute instances start'))).toBe(false);
  });

  it('reclaim: an ssh that never comes back fails with exit 10 instead of reading a dead VM', () => {
    const r = run(['reclaim', 'cap-x', 'proj', 'zone-a'], { FAKE_SSH_FAIL: '99', RECLAIM_SSH_TRIES: '3' });
    expect(r.status).toBe(10);
    expect(r.stdout).toMatch(/^SSH_NOT_READY tries=3 /m);
    expect(r.stdout).not.toMatch(/RECLAIM_DONE/);
  });

  it('resume: refuses without the gateway tunnel, then resumes the recorded session id and pulls both transcripts', () => {
    let r = run(['resume', 'cap-x', 'proj', 'zone-a'], { FAKE_GW_DOWN: '1' });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/^RESUME_FAILED gateway not reachable \(start: reclaim-drill\.sh tunnel cap-x proj zone-a\)/m);
    expect(gcloudCalls().some((c) => c.includes('reclaim-claude-run.sh resume'))).toBe(false);

    r = run(['resume', 'cap-x', 'proj', 'zone-a']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^RESUME_SID sess-1234 /m);
    expect(r.stdout).toMatch(/^RESUME_RC=0$/m);
    expect(gcloudCalls()).toContain(
      `compute scp --project=proj --zone=zone-a --quiet cap-x:reclaim-drill/claude-task.tsv cap-x:reclaim-drill/claude-resume.tsv ${out()}/`,
    );
  });

  it('refuses an unknown phase or missing arguments before touching gcloud', () => {
    let r = run(['bogus', 'cap-x', 'proj', 'zone-a']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown phase bogus; usage: reclaim-drill\.sh/);
    r = run(['reclaim', 'cap-x']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage: reclaim-drill\.sh/);
    expect(existsSync(path.join(root, 'gcloud.log'))).toBe(false);
  });
});

describe('vm/reclaim-vm-hooks.sh (HOOK_ROOT, faked systemctl)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'reclaim-hooks-'));
    mkdirSync(path.join(root, 'fakebin'));
    writeFileSync(path.join(root, 'fakebin', 'systemctl'), `#!/bin/sh\necho "$*" >> "${root}/systemctl.log"\n[ "$1" = is-active ] && echo active\nexit 0\n`);
    chmodSync(path.join(root, 'fakebin', 'systemctl'), 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs the three units and an fsyncing logger, enables them, and reports HOOKS_OK', () => {
    const hookRoot = path.join(root, 'r');
    const r = spawnSync('bash', [HOOKS], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOOK_ROOT: hookRoot, HOOK_SETTLE_SEC: '0', PATH: `${path.join(root, 'fakebin')}:${process.env.PATH}` },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^HOOKS_OK$/m);
    expect(r.stdout).toMatch(/^JOURNAL_(PERSISTENT|VOLATILE)$/m);
    const sd = path.join(hookRoot, 'etc/systemd/system');
    for (const u of ['reclaim-preempt-watch', 'reclaim-heartbeat', 'reclaim-mark']) {
      expect(existsSync(path.join(sd, `${u}.service`)), u).toBe(true);
    }
    // The units point at the runtime paths, not the install prefix.
    const mark = readFileSync(path.join(sd, 'reclaim-mark.service'), 'utf8');
    expect(mark).toContain('ExecStop=/usr/local/bin/reclaim-log SHUTDOWN_STOP');
    expect(mark).not.toContain(hookRoot);
    expect(readFileSync(path.join(hookRoot, 'usr/local/bin/reclaim-preempt-watch'), 'utf8')).toContain(
      'computeMetadata/v1/instance/preempted?wait_for_change=true',
    );
    expect(readFileSync(path.join(root, 'systemctl.log'), 'utf8')).toContain(
      'enable --now reclaim-preempt-watch.service reclaim-heartbeat.service reclaim-mark.service',
    );

    // The logger appends "<tag> <utc ms>" to the file it is given.
    const f = path.join(root, 'events.log');
    const l = spawnSync(path.join(hookRoot, 'usr/local/bin/reclaim-log'), ['BOOT', f], { encoding: 'utf8' });
    expect(l.status, l.stderr).toBe(0);
    expect(readFileSync(f, 'utf8')).toMatch(/^BOOT \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/);
  });
});
