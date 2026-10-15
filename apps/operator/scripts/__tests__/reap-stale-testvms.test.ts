/**
 * WI-10006397 — the stale-testvm reaper's /proc censuses must not fork per host process.
 *
 * Measured 2026-10-06: papercup-testvm-reaper.service consumed 36-57 s of CPU on every
 * 15-minute run. Both censuses (any_orchestrator_alive, candidate_vm_pids) did
 * `cmd=$(proc_cmdline "$pid")` for EVERY /proc entry, and each command substitution
 * forks a subshell: 10,127 + 9,817 subshells against 10,049 host processes, 24 s +
 * 33 s of CPU, mostly kernel time. Same class as WI-10006347 (webkit reaper, `cat`).
 *
 * The forks here are Bash SUBSHELLS, not external launches, so PATH shims (the webkit
 * reaper test's instrument) cannot see them. This guard counts subshells directly: the
 * driver sources the real script, enables `set -T` so a DEBUG trap is inherited by
 * every subshell, and records each new $BASHPID. Two calibrations keep it honest:
 *   - the counter must see a known 40-fork control (else a zero means a broken counter);
 *   - candidate_vm_pids must find a fake qemu-shaped testvm process by pid (else a low
 *     count could mean the scan read nothing).
 *
 * Safety: only the two census functions are called; main()/do_reap() never run.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the suite at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../../bin/reap-stale-testvms.sh');

// Sources the script, then runs one function with every subshell's BASHPID logged.
const DRIVER = `
src="$1"; fn="$2"; __log="$3"
source "$src"
set +e +u
__ctl() { local i x; for ((i = 0; i < 40; i++)); do x=$(:); done; }
__last=$BASHPID
set -T
trap '[[ $BASHPID != "$__last" ]] && { __last=$BASHPID; printf "%s\\n" "$BASHPID" >> "$__log"; }' DEBUG
"$fn"
trap - DEBUG
set +T
`;

let roots: string[] = [];
let children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function hostProcessCount(): number {
  return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
}

function countSubshells(fn: string) {
  const root = mkdtempSync(join(tmpdir(), 'testvm-reaper-'));
  roots.push(root);
  const driver = join(root, 'driver.sh');
  const log = join(root, 'subshells.log');
  writeFileSync(driver, DRIVER);
  writeFileSync(log, '');
  const run = spawnSync('bash', [driver, SCRIPT, fn, log], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: '/usr/bin:/bin', HOME: root },
  });
  const subshells = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean)).size;
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', subshells };
}

describe('reap-stale-testvms.sh /proc censuses (WI-10006397)', () => {
  it('calibration: the subshell counter sees a known 40-fork control', () => {
    const r = countSubshells('__ctl');
    expect(r.status, r.stderr).toBe(0);
    expect(r.subshells).toBeGreaterThanOrEqual(40);
  });

  it('calibration: candidate_vm_pids finds a qemu-shaped testvm process by pid', () => {
    const fake = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 120000)', '--', '-name', `papercusp-testvm-reaper-selftest-${process.pid}`],
      { argv0: 'qemu-system-x86_64', stdio: 'ignore' },
    );
    children.push(fake);
    const r = countSubshells('candidate_vm_pids');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')).toContain(String(fake.pid));
  }, 120_000);

  it.each(['candidate_vm_pids', 'any_orchestrator_alive'])(
    '%s forks a bounded number of subshells, not one per host process',
    (fn) => {
      const procs = hostProcessCount();
      // Without this the bound below would be vacuous on a near-empty host.
      expect(procs).toBeGreaterThan(50);
      const r = countSubshells(fn);
      // any_orchestrator_alive exits 1 when no orchestrator is live; both are fine.
      expect([0, 1], r.stderr).toContain(r.status);
      // The self-ancestry walk forks once per ancestor (a handful); a per-entry
      // command substitution forks once per host process.
      expect(r.subshells).toBeLessThan(Math.floor(procs / 4));
    },
    120_000,
  );
});

/**
 * WI-10006611 — the reaper must not shut down a VM whose holder has a live named-resource
 * lease. Measured 2026-10-06 10:30Z: the reaper picked instance `clean` (running 22357s >
 * 21600s) and SIGKILLed it while linux-test-vm:clean was leased; the file keep lease was its
 * only opt-out.
 *
 * main() runs for real with two seams stubbed so nothing on the host can be killed:
 * do_reap only logs, and any_orchestrator_alive says "none" so a live federation run on the
 * box cannot short-circuit the sweep. The lease plane is a stub executable
 * (TESTVM_REAPER_LEASE_CMD) that records the resource it was asked about.
 */
const MAIN_DRIVER = `
src="$1"
source "$src"
set +e +u
any_orchestrator_alive() { return 1; }
do_reap() { log "  DRY-RUN: would reap $2 (pid=$1) via vmctl down"; }
DRY_RUN=1
main
`;

const LEASE_STUB = `#!/bin/bash
printf '%s\\n' "$1" >> "$STUB_LOG"
if [ -n "\${STUB_EXIT:-}" ]; then exit "$STUB_EXIT"; fi
cat "$STUB_JSON"
`;

function spawnFakeVm(name: string): ChildProcess {
  const fake = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 120000)', '--', '-name', `papercusp-testvm-${name}`],
    { argv0: 'qemu-system-x86_64', stdio: 'ignore' },
  );
  children.push(fake);
  return fake;
}

async function waitForCmdline(pid: number, marker: string) {
  for (let i = 0; i < 50; i++) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker)) return;
    } catch {
      /* not visible yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fake VM ${pid} never showed ${marker} in its cmdline`);
}

function runMain(opts: { body?: string; stubExit?: number; env?: Record<string, string>; fakeNode?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'testvm-reaper-lease-'));
  roots.push(root);
  const driver = join(root, 'driver.sh');
  const stub = join(root, 'lease-stub.sh');
  const stubLog = join(root, 'lease-calls.log');
  const stubJson = join(root, 'lease.json');
  writeFileSync(driver, MAIN_DRIVER);
  writeFileSync(stub, LEASE_STUB);
  chmodSync(stub, 0o755);
  writeFileSync(stubLog, '');
  writeFileSync(stubJson, opts.body ?? '');
  mkdirSync(join(root, 'keep'));
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    TESTVM_REAPER_MAX_AGE_SECS: '0',
    TESTVM_REAPER_DRY_RUN: '1',
    TESTVM_REAPER_KEEP_DIR: join(root, 'keep'),
    STUB_LOG: stubLog,
    STUB_JSON: stubJson,
    ...opts.env,
  };
  if (opts.fakeNode) {
    // No LEASE_CMD: the default lookup shells out to `node scripts/mcp-call.mjs`. A fake
    // `node` first on PATH records its argv and answers like the operator would.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_LOG"\ncat "$STUB_JSON"\n`);
    chmodSync(join(bin, 'node'), 0o755);
    env.PATH = `${bin}:/usr/bin:/bin`;
  } else {
    env.TESTVM_REAPER_LEASE_CMD = stub;
  }
  if (opts.stubExit !== undefined) env.STUB_EXIT = String(opts.stubExit);
  const run = spawnSync('bash', [driver, SCRIPT], { encoding: 'utf8', timeout: 120_000, env });
  return {
    status: run.status,
    out: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    calls: existsSync(stubLog) ? readFileSync(stubLog, 'utf8') : '',
  };
}

const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();
const holder = (resource: string, expires_ts: string | null) => ({
  resource,
  owner: 'su-lease-test',
  mode: 'exclusive',
  status: 'held',
  expires_ts,
});
const listBody = (name: string, holders: object[], nested: object[] = holders) =>
  JSON.stringify({
    ok: true,
    resources: [{ resource: `linux-test-vm:${name}`, holders: nested, held: nested.length > 0 }],
    holders,
  });

describe('reap-stale-testvms.sh named-resource leases (WI-10006611)', () => {
  let n = 0;
  const freshName = () => `lease-${process.pid}-${++n}`;

  it.each([
    {
      label: 'a live lease on linux-test-vm:<instance> protects it',
      body: (x: string) => listBody(x, [holder(`linux-test-vm:${x}`, future())]),
      reaped: false,
    },
    {
      label: 'a live lease reported only under resources[] protects it',
      body: (x: string) => listBody(x, [], [holder(`linux-test-vm:${x}`, future())]),
      reaped: false,
    },
    {
      label: 'a holder with no expiry protects it',
      body: (x: string) => listBody(x, [holder(`linux-test-vm:${x}`, null)]),
      reaped: false,
    },
    {
      label: 'an expired lease does not protect it',
      body: (x: string) => listBody(x, [holder(`linux-test-vm:${x}`, past())]),
      reaped: true,
    },
    {
      label: 'a lease on a DIFFERENT instance does not protect it',
      body: (x: string) => listBody(x, [holder('linux-test-vm:some-other-instance', future())]),
      reaped: true,
    },
    {
      label: 'no holder at all: the over-age VM is reaped (control)',
      body: (x: string) => listBody(x, []),
      reaped: true,
    },
  ])('$label', async ({ body, reaped }) => {
    const name = freshName();
    const fake = spawnFakeVm(name);
    await waitForCmdline(fake.pid!, `papercusp-testvm-${name}`);
    const r = runMain({ body: body(name) });
    expect(r.status, r.out).toBe(0);
    // The lookup asked about exactly this instance's resource.
    expect(r.calls.split('\n')).toContain(`linux-test-vm:${name}`);
    const wouldReap = new RegExp(`would reap ${name} \\(pid=${fake.pid}\\)`);
    if (reaped) {
      expect(r.out).toMatch(wouldReap);
    } else {
      expect(r.out).not.toMatch(wouldReap);
      expect(r.out).toMatch(new RegExp(`SKIP ${name} .*named-resource lease linux-test-vm:${name} held by su-lease-test`));
    }
  }, 120_000);

  it.each([
    { label: 'lookup exits non-zero', stubExit: 1, body: '' },
    { label: 'lookup answers non-JSON', body: 'connection refused' },
    { label: 'lookup answers ok:false', body: JSON.stringify({ ok: false, error: 'operator down' }) },
  ])('unreadable lease plane ($label): the VM is deferred, not reaped', async ({ stubExit, body }) => {
    const name = freshName();
    const fake = spawnFakeVm(name);
    await waitForCmdline(fake.pid!, `papercusp-testvm-${name}`);
    const r = runMain({ body, stubExit });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`DEFER ${name} \\(pid=${fake.pid}`));
    expect(r.out).not.toMatch(new RegExp(`would reap ${name} \\(pid=${fake.pid}\\)`));
  }, 120_000);

  it('unreadable lease plane past the age ceiling: the VM is reaped anyway (no permanent leak)', async () => {
    const name = freshName();
    const fake = spawnFakeVm(name);
    await waitForCmdline(fake.pid!, `papercusp-testvm-${name}`);
    const r = runMain({ stubExit: 1, env: { TESTVM_REAPER_LEASE_UNREADABLE_MAX_AGE_SECS: '0' } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`lease linux-test-vm:${name} unreadable, but ${name} has run`));
    expect(r.out).toMatch(new RegExp(`would reap ${name} \\(pid=${fake.pid}\\)`));
  }, 120_000);

  it('the default lookup asks the operator via scripts/mcp-call.mjs locks:list for this resource', async () => {
    const name = freshName();
    const fake = spawnFakeVm(name);
    await waitForCmdline(fake.pid!, `papercusp-testvm-${name}`);
    const r = runMain({ body: listBody(name, [holder(`linux-test-vm:${name}`, future())]), fakeNode: true });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toMatch(
      new RegExp(`scripts/mcp-call\\.mjs locks:list \\{"resource":"linux-test-vm:${name}"\\} --client testvm-reaper`),
    );
    expect(r.out).toMatch(new RegExp(`SKIP ${name} .*held by su-lease-test`));
  }, 120_000);
});

/**
 * 2026-10-06 10:30Z: `vmctl down clean` reported "clean down" after 6s, the reaper checked the
 * pid at once, logged "did not clear within 90s" and SIGKILLed a VM that was already exiting.
 * do_reap now gives the pid a bounded grace after a successful vmctl down. Only a process this
 * test spawned is ever signalled.
 */
// The stand-in VM is a background job of the driver shell, not of this Node process:
// spawnSync blocks Node's event loop, so a Node child would linger as a zombie and
// `kill -0` would keep reporting it alive. Bash reaps its own jobs on SIGCHLD.
const REAP_DRIVER = `
src="$1"; vmctl="$2"; grace="$3"
source "$src"
set +e +u
bash -c 'trap "sleep 2; exit 0" TERM; while :; do sleep 0.2; done' &
export VM_PID=$!
sleep 0.3
DRY_RUN=0
VMCTL="$vmctl"
VMCTL_EXIT_GRACE="$grace"
do_reap "$VM_PID" grace-test
kill -9 "$VM_PID" 2>/dev/null
wait 2>/dev/null
exit 0
`;

describe('reap-stale-testvms.sh do_reap after a successful vmctl down', () => {
  function runReap(grace: number) {
    const root = mkdtempSync(join(tmpdir(), 'testvm-reaper-grace-'));
    roots.push(root);
    // The stand-in exits 2s after SIGTERM, like QEMU finishing its shutdown after vmctl returns.
    const vmctl = join(root, 'vmctl');
    writeFileSync(vmctl, `kill -TERM "$VM_PID"\necho "[testvm] grace-test down"\nexit 0\n`);
    writeFileSync(join(root, 'driver.sh'), REAP_DRIVER);
    const run = spawnSync('bash', [join(root, 'driver.sh'), SCRIPT, vmctl, String(grace)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: '/usr/bin:/bin', HOME: root },
    });
    return `${run.stdout ?? ''}${run.stderr ?? ''}`;
  }

  it('waits for the exiting pid instead of escalating to signals', async () => {
    const out = runReap(10);
    expect(out).toContain('grace-test down cleanly');
    expect(out).not.toMatch(/SIGTERM|SIGKILL|escalating/);
  }, 60_000);

  it('control: with no grace the same shutdown is escalated', async () => {
    const out = runReap(0);
    expect(out).toMatch(/still alive 0s later — escalating directly/);
  }, 60_000);
});
