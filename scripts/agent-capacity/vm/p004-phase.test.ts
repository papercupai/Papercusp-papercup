import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the test at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'p004-phase.sh');

describe('vm/p004-phase.sh (faked systemd-run/systemctl/python3/npx)', () => {
  let home: string;
  const bin = () => path.join(home, 'bin');
  const log = (name: string) => readFileSync(path.join(home, name), 'utf8');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p004-phase-'));
    mkdirSync(bin());
    mkdirSync(path.join(home, 'capacity'));
    stub('systemd-run', `echo "$@" >> "${home}/systemd-run.log"`);
    stub('systemctl', `echo "$@" >> "${home}/systemctl.log"`);
    // The sampler runs for hours on the VM; a stub that outlives the test catches a phase that
    // waits on it instead of on the recorders (the n4/n8 hang seen live on 2026-10-01).
    stub('python3', `echo "$@" >> "${home}/sampler.log"; exec sleep 120`);
    // npx tsx <script> <args>: log the call; a record-session call writes one meta.json per task.
    stub(
      'npx',
      `echo "$@" >> "${home}/npx.log"
case "$2" in *record-session.ts) ;; *) exit 0 ;; esac
cli=""; tasks=""; out=""
while [ $# -gt 0 ]; do case "$1" in --cli) cli=$2; shift;; --tasks) tasks=$2; shift;; --out) out=$2; shift;; esac; shift; done
for t in $(echo "$tasks" | tr , ' '); do
  d="$out/$cli-$t-20261001T000000"; mkdir -p "$d"
  printf '{"sessionId":"%s","exitCode":0,"timedOut":false,"cpuUsec":1234,"memPeakBytes":5678,"wallMs":9}' "$cli-$t-20261001T000000" > "$d/meta.json"
done`,
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, HOME: home, PATH: `${bin()}:${process.env.PATH}` },
    });

  it('n4 records the protocol sessions concurrently, then replays exactly those sessions 4 at a time', () => {
    const r = run('n4');
    expect(r.status, r.stderr).toBe(0);
    const rec = path.join(home, 'capacity/rec/n4');
    const calls = log('npx.log').trim().split('\n');
    const recCalls = calls.filter((c) => c.includes('record-session.ts')).sort();
    expect(recCalls).toEqual([
      `tsx scripts/agent-capacity/record-session.ts --cli claude --tasks exc-typical-2,mea-typical-1 --parallel 2 --out ${rec} --upstream http://127.0.0.1:8788 --isolation systemd`,
      `tsx scripts/agent-capacity/record-session.ts --cli codex --tasks exc-light-3,mea-light-3 --parallel 2 --out ${rec} --upstream http://127.0.0.1:8788 --isolation systemd`,
    ]);
    const replay = calls.find((c) => c.includes('load-driver.ts'));
    expect(replay).toBe(
      `tsx scripts/agent-capacity/load-driver.ts --sweep --agents 4 --corpus ${rec} ` +
        '--sessions claude-exc-typical-2-20261001T000000,claude-mea-typical-1-20261001T000000,' +
        'codex-exc-light-3-20261001T000000,codex-mea-light-3-20261001T000000 ' +
        `--out ${path.join(home, 'capacity/runs/replay-n4')} --isolation systemd --path recorded`,
    );
    // Real sessions run in caprec.slice, replays in capdrv.slice, each sampled from a held slice.
    expect(log('systemd-run.log')).toMatch(/--slice=caprec\.slice --unit=hold-caprec-n4 /);
    expect(log('systemd-run.log')).toMatch(/--slice=capdrv\.slice --unit=hold-capdrv-n4 /);
    expect(log('sampler.log')).toMatch(/caprec\.slice --interval 5 .* --label real-n4/);
    expect(log('sampler.log')).toMatch(/capdrv\.slice --interval 5 .* --label replay-n4/);
    expect(log('systemctl.log')).toContain('--user stop hold-caprec-n4');
    expect(r.stdout).toMatch(/^REAL claude-exc-typical-2-20261001T000000 exit=0 timedOut=false cpuUsec=1234 memPeakBytes=5678 wallMs=9$/m);
    expect(r.stdout).toMatch(/^PHASE_DONE n4 both /m);
  });

  it('n1 runs its two sessions one after the other with --parallel 1', () => {
    expect(run('n1', 'real').status).toBe(0);
    const recCalls = log('npx.log').trim().split('\n');
    expect(recCalls.map((c) => c.match(/--cli (\S+) --tasks (\S+) --parallel (\d)/)!.slice(1).join(' '))).toEqual([
      'claude exc-heavy-1 1',
      'codex exc-typical-1 1',
    ]);
  });

  it('n8 assigns four sessions to each CLI at --parallel 4', () => {
    expect(run('n8', 'real').status).toBe(0);
    const tasks = log('npx.log')
      .trim()
      .split('\n')
      .map((c) => c.match(/--cli (\S+) --tasks (\S+) --parallel (\d)/)!.slice(1).join(' '))
      .sort();
    expect(tasks).toEqual([
      'claude exc-typical-1,exc-typical-4,mea-light-2,mea-typical-4 4',
      'codex exc-typical-2,exc-light-1,mea-light-4,mea-typical-1 4',
    ]);
  });

  // Plan D-012 / WI-10004619: the Codex half of the first calibration was vacuous, so it is re-run alone.
  const runWith = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, HOME: home, PATH: `${bin()}:${process.env.PATH}`, ...env },
    });

  it('P004_CLIS=codex records and replays only the Codex sessions', () => {
    const r = runWith({ P004_CLIS: 'codex' }, 'n4');
    expect(r.status, r.stderr).toBe(0);
    const calls = log('npx.log').trim().split('\n');
    expect(calls.filter((c) => c.includes('record-session.ts')).map((c) => c.match(/--cli (\S+) --tasks (\S+)/)!.slice(1).join(' '))).toEqual([
      'codex exc-light-3,mea-light-3',
    ]);
    expect(r.stdout).toMatch(/^PHASE_REC_SKIPPED claude exc-typical-2,mea-typical-1$/m);
    expect(calls.find((c) => c.includes('load-driver.ts'))).toContain(
      '--sessions codex-exc-light-3-20261001T000000,codex-mea-light-3-20261001T000000 ',
    );
  });

  it('refuses a P004_CLIS naming an unknown or no CLI before recording anything', () => {
    for (const bad of ['gemini', 'codex,clade', ',']) {
      const r = runWith({ P004_CLIS: bad }, 'n1', 'real');
      expect(r.status, bad).toBe(2);
      expect(r.stdout).toContain('PHASE_BAD_CLIS');
    }
    expect(() => log('npx.log')).toThrow();
  });

  it('refuses an unknown phase and a replay with nothing recorded', () => {
    const bad = run('n2');
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain('PHASE_BAD n2');
    const empty = run('n1', 'replay');
    expect(empty.status).toBe(3);
    expect(empty.stdout).toContain('PHASE_REPLAY_NOTHING n1');
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });
});
