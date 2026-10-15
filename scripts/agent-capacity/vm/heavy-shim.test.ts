import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const INSTALL = path.join(__dirname, 'install-heavy-shim.sh');
const PC_HEAVY = path.resolve(__dirname, '../../pc-heavy.sh');

/** The caller's env minus every PC_HEAVY_* var: under `npm run test:file` this process already
 *  carries PC_HEAVY_BYPASS=1, which would make every shim call skip admission. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PC_HEAVY_')) out[k] = v;
  return { ...out, ...extra };
}

describe('vm/install-heavy-shim.sh + heavy-shim.sh (P-529 heavy-job admission)', () => {
  let dir: string;
  let bin: string;
  const runlog = () => path.join(dir, 'run.log');
  const shimlog = () => path.join(dir, 'shim.jsonl');
  const install = (...args: string[]) => execFileSync('bash', [INSTALL, path.join(dir, 'repo'), ...args], { encoding: 'utf8' });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'heavy-shim-'));
    const root = path.join(dir, 'repo');
    bin = path.join(root, 'node_modules', '.bin');
    mkdirSync(path.join(root, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(bin);
    // Stand-in for vitest.mjs: logs "<tag>|<start>|<bypass>" and "end|<tag>|<end>", holds for $HOLD s.
    const real = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    writeFileSync(
      real,
      [
        '#!/usr/bin/env bash',
        'printf \'%s|%s|%s\\n\' "$2" "$(date +%s.%N)" "${PC_HEAVY_BYPASS:-}" >> "$RUNLOG"',
        'sleep "${HOLD:-0}"',
        'printf \'end|%s|%s\\n\' "$2" "$(date +%s.%N)" >> "$RUNLOG"',
        'echo "ran $*"',
      ].join('\n') + '\n',
    );
    chmodSync(real, 0o755);
    symlinkSync('../vitest/vitest.mjs', path.join(bin, 'vitest'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install moves the real bin aside, is idempotent, and uninstall restores the original symlink', () => {
    const first = install();
    expect(first).toMatch(/^HEAVY_SHIM_INSTALLED name=vitest real=\.\.\/vitest\/vitest\.mjs$/m);
    expect(first).toMatch(/^HEAVY_SHIM_SKIPPED name=tsc reason=absent$/m);
    expect(install()).toMatch(/^HEAVY_SHIM_INSTALLED name=vitest /m);
    expect(lstatSync(path.join(bin, 'vitest')).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(bin, 'vitest'), 'utf8')).toContain('PC_HEAVY_SHIM_V1');
    expect(readlinkSync(path.join(bin, '.vitest.heavy-real'))).toBe('../vitest/vitest.mjs');

    expect(install('--uninstall')).toMatch(/^HEAVY_SHIM_REMOVED name=vitest$/m);
    expect(readlinkSync(path.join(bin, 'vitest'))).toBe('../vitest/vitest.mjs');
    expect(existsSync(path.join(bin, '.vitest.heavy-real'))).toBe(false);
    expect(install('--uninstall')).toMatch(/^HEAVY_SHIM_SKIPPED name=vitest reason=not-installed$/m);
  });

  it('routes an un-admitted call through pc-heavy with its arguments unchanged and logs request + admit', async () => {
    install();
    const fake = path.join(dir, 'fake-pc-heavy.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\necho "pch $*" >> "$PCHLOG"\n[ "$1" = -- ] && shift\nPC_HEAVY_BYPASS=1 exec "$@"\n');
    const { stdout } = await run(path.join(bin, 'vitest'), ['run', 'a b', '--x'], {
      env: env({ PC_HEAVY_SHIM_SCRIPT: fake, PC_HEAVY_SHIM_LOG: shimlog(), RUNLOG: runlog(), PCHLOG: path.join(dir, 'pch.log') }),
    });
    expect(stdout.trim()).toBe('ran run a b --x');
    expect(readFileSync(path.join(dir, 'pch.log'), 'utf8').trim()).toBe(`pch -- ${path.join(bin, 'vitest')} run a b --x`);
    const evs = readFileSync(shimlog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; bin: string; id: string; waitSec?: number });
    expect(evs.map((e) => e.ev)).toEqual(['request', 'admit']);
    expect(evs[1].id).toBe(evs[0].id);
    expect(evs[1].bin).toBe('vitest');
    expect(evs[1].waitSec).toBeGreaterThanOrEqual(0);
  });

  it('runs the real bin directly, without pc-heavy, when the caller already holds a slot', async () => {
    install();
    const fake = path.join(dir, 'fake-pc-heavy.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\necho called >> "$PCHLOG"\nexit 99\n');
    const { stdout } = await run(path.join(bin, 'vitest'), ['run', 'inner'], {
      env: env({ PC_HEAVY_BYPASS: '1', PC_HEAVY_SHIM_SCRIPT: fake, PC_HEAVY_SHIM_LOG: shimlog(), RUNLOG: runlog(), PCHLOG: path.join(dir, 'pch.log') }),
    });
    expect(stdout.trim()).toBe('ran run inner');
    expect(existsSync(path.join(dir, 'pch.log'))).toBe(false);
    expect(existsSync(shimlog())).toBe(false);
    expect(readFileSync(runlog(), 'utf8')).toMatch(/^inner\|[\d.]+\|1$/m);
  });

  // The property P-529 relies on, through the repo's REAL pc-heavy: K slots bound concurrency.
  // K=2 is the positive control: the same measurement must SEE overlap when admission allows it.
  async function concurrentPair(slots: number) {
    install();
    const e = env({
      PC_HEAVY_SLOTS: String(slots),
      PC_HEAVY_DIR: path.join(dir, 'slots'),
      PC_HEAVY_MEM_CLAMP: '0',
      PC_HEAVY_PSI_ADMISSION: '0',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '120',
      PAPERCUSP_CHECKPOINT_LOG_DIR: path.join(dir, 'checkpoint-logs'),
      PC_HEAVY_SHIM_SCRIPT: PC_HEAVY,
      PC_HEAVY_SHIM_LOG: shimlog(),
      RUNLOG: runlog(),
      HOLD: '1.5',
    });
    await Promise.all(['A', 'B'].map((tag) => run(path.join(bin, 'vitest'), ['run', tag], { env: e })));
    const lines = readFileSync(runlog(), 'utf8').trim().split('\n');
    const at = (tag: string, kind: 'start' | 'end') => {
      const l = kind === 'start' ? lines.find((x) => x.startsWith(`${tag}|`)) : lines.find((x) => x.startsWith(`end|${tag}|`));
      if (!l) throw new Error(`no ${kind} for ${tag} in ${lines.join(' / ')}`);
      return Number(l.split('|')[kind === 'start' ? 1 : 2]);
    };
    const overlap = Math.min(at('A', 'end'), at('B', 'end')) - Math.max(at('A', 'start'), at('B', 'start'));
    const waits = readFileSync(shimlog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; waitSec?: number })
      .filter((x) => x.ev === 'admit').map((x) => x.waitSec ?? 0);
    return { overlap, waits, bypassSeen: lines.filter((l) => /^[AB]\|/.test(l)).every((l) => l.endsWith('|1')) };
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
});
