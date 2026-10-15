// WI-10005296 (D-031 ruling 2a): scripts/heavy-admission.cjs, the node --require preload that routes
// heavy entrypoints (vitest, tsc, tsgo) through pc-heavy on hosted workspace hosts.
//
// Every case runs a REAL node process with the preload activated the way production activates it
// (NODE_OPTIONS=--require=<preload>), against fixture packages laid out like a real checkout. The
// preload is never imported into this process: vitest's own argv[1] is a heavy entrypoint.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated COPY (copy-out mode).
const PRELOAD = process.env.HEAVY_ADMISSION_PRELOAD || path.join(__dirname, 'heavy-admission.cjs');
const PC_HEAVY = path.join(__dirname, 'pc-heavy.sh');

// One fixture body for every heavy entrypoint. process.getBuiltinModule keeps it valid as both CJS
// (extensionless tsc) and ESM (vitest.mjs). Logs one JSON start/end line; HOLD, EXIT and
// SELF_SIGNAL shape the outcome.
const FIXTURE = `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs');
const tag = process.argv[3] || '';
const log = (o) => fs.appendFileSync(process.env.RUNLOG, JSON.stringify(o) + '\\n');
log({ ev: 'start', tag, args: process.argv.slice(2), bypass: process.env.PC_HEAVY_BYPASS || '', execArgv: process.execArgv, t: Date.now() / 1000 });
setTimeout(() => {
  log({ ev: 'end', tag, t: Date.now() / 1000 });
  if (process.env.SELF_SIGNAL) { process.kill(process.pid, process.env.SELF_SIGNAL); setTimeout(() => process.exit(99), 5000); return; }
  process.exit(Number(process.env.EXIT || 0));
}, Number(process.env.HOLD || 0) * 1000);
`;

type RunRec = { ev: 'start' | 'end'; tag: string; args?: string[]; bypass?: string; execArgv?: string[]; t: number };
type ShimRec = { ev: 'request' | 'admit'; bin: string; id: string; t: number; waitSec?: number };

describe('scripts/heavy-admission.cjs (hosted heavy-job admission preload)', () => {
  let dir: string;
  let bin: string;
  let fakePch: string;
  const runlog = () => path.join(dir, 'run.jsonl');
  const shimlog = () => path.join(dir, 'shim.jsonl');
  const pchlog = () => path.join(dir, 'pch.log');
  const runRecs = (): RunRec[] => (existsSync(runlog()) ? readFileSync(runlog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRec) : []);
  const shimRecs = (): ShimRec[] => (existsSync(shimlog()) ? readFileSync(shimlog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ShimRec) : []);
  const pchCalls = () => (existsSync(pchlog()) ? readFileSync(pchlog(), 'utf8').trim().split('\n') : []);

  /** Caller env minus PC_HEAVY_* and NODE_OPTIONS (this runner carries PC_HEAVY_BYPASS=1 under
   *  `npm run test:file`, which would make every call skip admission), plus the preload. */
  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PC_HEAVY_') && k !== 'NODE_OPTIONS') out[k] = v;
    return { ...out, NODE_OPTIONS: `--require=${PRELOAD}`, RUNLOG: runlog(), PCHLOG: pchlog(), PC_HEAVY_ADMISSION_SCRIPT: fakePch, PC_HEAVY_SHIM_LOG: shimlog(), ...extra };
  }

  function fixture(rel: string) {
    const p = path.join(dir, 'repo', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, FIXTURE);
    chmodSync(p, 0o755);
    return p;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'heavy-admission-'));
    bin = path.join(dir, 'repo', 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    fixture('node_modules/vitest/vitest.mjs');
    fixture('node_modules/@typescript/native/bin/tsc');
    fixture('node_modules/typescript/bin/tsc6');
    fixture('node_modules/@typescript/native-preview/bin/tsgo.js');
    symlinkSync('../vitest/vitest.mjs', path.join(bin, 'vitest'));
    symlinkSync('../@typescript/native/bin/tsc', path.join(bin, 'tsc'));
    symlinkSync('../@typescript/native-preview/bin/tsgo.js', path.join(bin, 'tsgo'));
    // Stand-in pc-heavy: records its argv, then runs the command as an admitted child would.
    fakePch = path.join(dir, 'fake-pc-heavy.sh');
    writeFileSync(fakePch, '#!/usr/bin/env bash\necho "pch $*" >> "$PCHLOG"\n[ "$1" = -- ] && shift\nPC_HEAVY_BYPASS=1 exec "$@"\n');
    chmodSync(fakePch, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('routes `.bin/vitest` through pc-heavy with node, entrypoint and arguments unchanged, and logs request + admit', async () => {
    const { stdout } = await run(path.join(bin, 'vitest'), ['run', 't1', '--reporter=dot'], { env: env() });
    expect(stdout).toBe('');
    const calls = pchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`^pch -- \\S*node\\S* ${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/vitest run t1 --reporter=dot$`));
    const starts = runRecs().filter((r) => r.ev === 'start');
    expect(starts).toEqual([expect.objectContaining({ tag: 't1', args: ['run', 't1', '--reporter=dot'], bypass: '1' })]);
    const evs = shimRecs();
    expect(evs.map((e) => [e.ev, e.bin])).toEqual([['request', 'vitest'], ['admit', 'vitest']]);
    expect(evs[1].id).toBe(evs[0].id);
    expect(evs[1].waitSec).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['TypeScript 7 native launcher (.bin/tsc)', 'node_modules/.bin/tsc', 'tsc'],
    ['typescript/bin/tsc6', 'node_modules/typescript/bin/tsc6', 'tsc'],
    ['tsgo (.bin/tsgo)', 'node_modules/.bin/tsgo', 'tsgo'],
  ])('routes %s through pc-heavy', async (_label, rel, name) => {
    await run(path.join(dir, 'repo', rel), ['--noEmit', 'x'], { env: env() });
    expect(pchCalls()).toHaveLength(1);
    expect(runRecs().find((r) => r.ev === 'start')).toMatchObject({ bypass: '1', args: ['--noEmit', 'x'] });
    expect(shimRecs().map((e) => e.bin)).toEqual([name, name]);
  });

  it('leaves every other node process alone: a same-named script outside a heavy package, and node -e', async () => {
    const lookalike = fixture('scripts/tsc');
    await run(lookalike, ['--noEmit', 'y'], { env: env() });
    await run(process.execPath, ['-e', 'process.exit(0)'], { env: env() });
    expect(pchCalls()).toEqual([]);
    expect(runRecs().find((r) => r.ev === 'start')).toMatchObject({ bypass: '' });
    expect(shimRecs()).toEqual([]);
  });

  it('runs the entrypoint directly, without pc-heavy, when the caller already holds a slot (PC_HEAVY_BYPASS=1)', async () => {
    await run(path.join(bin, 'vitest'), ['run', 't2'], { env: env({ PC_HEAVY_BYPASS: '1' }) });
    expect(pchCalls()).toEqual([]);
    expect(runRecs().filter((r) => r.ev === 'start')).toHaveLength(1);
    expect(shimRecs()).toEqual([]);
  });

  it.each([
    ['vitest', ['--version']],
    ['vitest', ['-h']],
    ['tsc', ['--init']],
    ['tsc', ['-p', '.', '--watch']],
    ['vitest', ['watch', 'z']],
    ['vitest', ['dev']],
  ])('does not admit `%s %s` (informational or explicit watch: must not queue or pin a slot)', async (name, args) => {
    await run(path.join(bin, name), args, { env: env() });
    expect(pchCalls()).toEqual([]);
    expect(runRecs().filter((r) => r.ev === 'start')).toHaveLength(1);
  });

  it('passes the admitted job’s exit status and terminating signal through unchanged', () => {
    const exited = spawnSync(path.join(bin, 'vitest'), ['run', 'e'], { env: env({ EXIT: '3' }) });
    expect(exited.status).toBe(3);
    const killed = spawnSync(path.join(bin, 'vitest'), ['run', 's'], { env: env({ SELF_SIGNAL: 'SIGTERM' }) });
    expect(killed.signal).toBe('SIGTERM');
    expect(pchCalls()).toHaveLength(2);
  });

  it('keeps node flags given on the command line (process.execArgv) for the admitted run', async () => {
    await run(process.execPath, ['--max-old-space-size=321', path.join(bin, 'vitest'), 'run', 'f'], { env: env() });
    expect(pchCalls()).toHaveLength(1);
    expect(runRecs().find((r) => r.ev === 'start')?.execArgv).toContain('--max-old-space-size=321');
  });

  it('without process.execve (node < 22.15) runs pc-heavy as a child and mirrors its exit status and signal', () => {
    const noExecve = path.join(dir, 'no-execve.cjs');
    writeFileSync(noExecve, 'delete process.execve;\n');
    const opts = (extra: Record<string, string>) => ({ env: env({ NODE_OPTIONS: `--require=${noExecve} --require=${PRELOAD}`, ...extra }) });
    const exited = spawnSync(path.join(bin, 'vitest'), ['run', 'e2'], opts({ EXIT: '4' }));
    expect(exited.status).toBe(4);
    const killed = spawnSync(path.join(bin, 'vitest'), ['run', 's2'], opts({ SELF_SIGNAL: 'SIGTERM' }));
    expect(killed.signal).toBe('SIGTERM');
    expect(pchCalls()).toHaveLength(2);
    expect(runRecs().filter((r) => r.ev === 'start').every((r) => r.bypass === '1')).toBe(true);
  });

  it('runs the job unadmitted with one warning when pc-heavy is missing', () => {
    const r = spawnSync(path.join(bin, 'vitest'), ['run', 'm'], { env: env({ PC_HEAVY_ADMISSION_SCRIPT: path.join(dir, 'absent.sh') }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^heavy-admission: no pc-heavy at .*absent\.sh; running vitest unadmitted$/m);
    expect(runRecs().find((x) => x.ev === 'start')).toMatchObject({ bypass: '' });
  });

  // The property D-031 relies on, through the repo's REAL pc-heavy: K slots bound concurrency.
  // K=2 is the positive control: the same measurement must SEE overlap when admission allows it.
  async function concurrentPair(slots: number) {
    const e = env({
      PC_HEAVY_ADMISSION_SCRIPT: PC_HEAVY,
      PC_HEAVY_SLOTS: String(slots),
      PC_HEAVY_DIR: path.join(dir, 'slots'),
      PC_HEAVY_MEM_CLAMP: '0',
      PC_HEAVY_PSI_ADMISSION: '0',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '120',
      PAPERCUSP_CHECKPOINT_LOG_DIR: path.join(dir, 'checkpoint-logs'),
      HOLD: '1.5',
    });
    await Promise.all(['A', 'B'].map((tag) => run(path.join(bin, 'vitest'), ['run', tag], { env: e })));
    const recs = runRecs();
    const at = (tag: string, ev: 'start' | 'end') => {
      const r = recs.find((x) => x.tag === tag && x.ev === ev);
      if (!r) throw new Error(`no ${ev} for ${tag} in ${JSON.stringify(recs)}`);
      return r.t;
    };
    const overlap = Math.min(at('A', 'end'), at('B', 'end')) - Math.max(at('A', 'start'), at('B', 'start'));
    const waits = shimRecs().filter((x) => x.ev === 'admit').map((x) => x.waitSec ?? 0);
    return { overlap, waits, bypassSeen: recs.filter((r) => r.ev === 'start').every((r) => r.bypass === '1') };
  }

  it('with the real pc-heavy and PC_HEAVY_SLOTS=1, two concurrent calls never overlap and one waits', async () => {
    const { overlap, waits, bypassSeen } = await concurrentPair(1);
    expect(bypassSeen).toBe(true);
    expect(overlap).toBeLessThanOrEqual(0);
    expect(waits).toHaveLength(2);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(1.2);
  }, 60_000);

  it('positive control: with PC_HEAVY_SLOTS=2 the same pair does overlap', async () => {
    const { overlap, waits } = await concurrentPair(2);
    expect(overlap).toBeGreaterThan(0.5);
    expect(Math.max(...waits)).toBeLessThan(1.2);
  }, 60_000);

  it('preload file loads cleanly under `node --check` and exports its matchers', () => {
    execFileSync(process.execPath, ['--check', PRELOAD]);
    const out = execFileSync(process.execPath, ['-e', `const m = require(${JSON.stringify(PRELOAD)}); console.log(typeof m.heavyName, typeof m.exemptReason)`], { encoding: 'utf8' });
    expect(out.trim()).toBe('function function');
  });
});
