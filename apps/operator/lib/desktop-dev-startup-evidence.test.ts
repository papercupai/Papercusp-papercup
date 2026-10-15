/**
 * Structured checks for plan desktop-dev-startup-speed-2026-10-06, acceptance
 * bars R-1 and R-5. Both bars were first written as "read the evidence and
 * confirm"; this file makes each drift marker an assertion that goes red.
 *
 * R-1 — "The default dev host follows measured numbers." Drift markers:
 *   (a) a variant has fewer than 3 recorded runs, or a run without its load
 *       average  → `every variant has at least 3 rounds, each with load averages`
 *   (b) the default `npm run dev` host path changed without a measured gain
 *       (decision D-002 kept tsx)  → `the default dev host is still tsx`
 *
 * R-5 — "Verified headless, end to end." Drift markers:
 *   (a) no headless run evidence exists  → `the headless run log exists and passed`
 *   (b) no elapsed time, or no hint with a dead operator  → `the starting page
 *       counted up and showed the crash hint after 3 minutes`
 *   (c) the window stuck on the starting page with a working operator
 *       → `the app loaded before the dead-origin test`
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const EVIDENCE = resolve(REPO_ROOT, 'docs/evidence/desktop-dev-startup-speed-2026-10-06');
// Each subject is overridable so scripts/mutation-probe.sh can run this file against a mutated
// COPY (copy-out mode) instead of mutating the shared tree. Unset = the committed evidence.
const BOOT_TIMES = process.env.DEVSTART_BOOT_TIMES || resolve(EVIDENCE, 'boot-times.tsv');
const HEADLESS_LOG = process.env.DEVSTART_HEADLESS_LOG || resolve(EVIDENCE, 'headless-p004-run.log');
const DEV_HOST_SCRIPT =
  process.env.DEVSTART_DEV_HOST_SCRIPT || resolve(REPO_ROOT, 'papercusp-desktop/bin/dev-operator-ifneeded.sh');

const LOAD_AVG = /^\d+(\.\d+)?\/\d+(\.\d+)?\/\d+(\.\d+)?$/;

interface BootRow {
  round: string;
  variant: string;
  step: string;
  status: string;
  seconds: number;
  loadStart: string;
  loadEnd: string;
}

function readBootTimes(): BootRow[] {
  const [header, ...lines] = readFileSync(BOOT_TIMES, 'utf8').trim().split('\n');
  expect(header.split('\t')).toEqual(
    ['utc', 'round', 'variant', 'step', 'status', 'seconds', 'load_start', 'load_end'],
  );
  return lines.map((line) => {
    const [, round, variant, step, status, seconds, loadStart, loadEnd] = line.split('\t');
    return { round, variant, step, status, seconds: Number(seconds), loadStart, loadEnd };
  });
}

describe('R-1: the default dev host follows measured numbers', () => {
  it('every variant has at least 3 rounds, each with load averages', () => {
    const rows = readBootTimes();
    for (const variant of ['tsx', 'fresh', 'warm']) {
      const health = rows.filter((r) => r.variant === variant && r.step === 'health');
      const rounds = new Set(health.map((r) => r.round));
      expect(rounds.size, `${variant}: distinct measured rounds`).toBeGreaterThanOrEqual(3);
      for (const r of health) {
        expect(r.status, `${variant} round ${r.round} status`).toBe('ok');
        expect(Number.isFinite(r.seconds) && r.seconds > 0, `${variant} round ${r.round} seconds`).toBe(true);
        expect(r.loadStart, `${variant} round ${r.round} load_start`).toMatch(LOAD_AVG);
        expect(r.loadEnd, `${variant} round ${r.round} load_end`).toMatch(LOAD_AVG);
      }
    }
  });

  it('the fresh-bundle variant records its build time, the cost D-002 weighed', () => {
    const builds = readBootTimes().filter((r) => r.variant === 'fresh' && r.step === 'build');
    expect(new Set(builds.map((r) => r.round)).size).toBeGreaterThanOrEqual(3);
    for (const b of builds) expect(b.loadStart).toMatch(LOAD_AVG);
  });

  it('the default dev host is still tsx (decision D-002)', () => {
    const script = readFileSync(DEV_HOST_SCRIPT, 'utf8');
    // The unconditional default…
    expect(script).toMatch(/^DEV_HOST_COMMAND="npx tsx bin\/hono-host\.ts"$/m);
    // …is replaced only inside the explicit PAPERCUSP_DEV_HOST_ENTRY override.
    const defaultAt = script.indexOf('DEV_HOST_COMMAND="npx tsx bin/hono-host.ts"');
    const overrideGuardAt = script.indexOf('if [ -n "$DEV_HOST_ENTRY" ]; then', defaultAt);
    const reassignments = [...script.matchAll(/^\s*DEV_HOST_COMMAND=/gm)].map((m) => m.index ?? -1);
    expect(overrideGuardAt).toBeGreaterThan(defaultAt);
    for (const at of reassignments) {
      if (at === defaultAt) continue;
      expect(at, 'every other DEV_HOST_COMMAND assignment sits inside the override block').toBeGreaterThan(overrideGuardAt);
    }
  });
});

describe('R-5: verified headless, end to end', () => {
  const log = () => readFileSync(HEADLESS_LOG, 'utf8');

  it('the headless run log exists and passed', () => {
    expect(existsSync(HEADLESS_LOG)).toBe(true);
    expect(log()).toMatch(/^P004_RESULT rc=0$/m);
    expect(log()).toMatch(/^verify rc=0$/m);
  });

  it('the app loaded before the dead-origin test', () => {
    const text = log();
    expect(text).toMatch(/app title: Papercusp Operator/);
    const children = /app #root children: (\d+)/.exec(text);
    expect(Number(children?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it('the starting page counted up and showed the crash hint after 3 minutes', () => {
    const text = log();
    const samples = [...text.matchAll(/\+(\d+)s .*?elapsed=\[Waiting ([^\]]+)\]/g)].map((m) => ({
      at: Number(m[1]),
      shown: m[2],
    }));
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(new Set(samples.map((s) => s.shown)).size, 'elapsed text changes between samples').toBe(samples.length);
    expect(text).toMatch(/\+\d+s .*hintHidden=\[true\]/);
    const late = /\+(\d+)s elapsed=\[[^\]]+\] hintHidden=\[false\]/.exec(text);
    expect(Number(late?.[1] ?? 0)).toBeGreaterThanOrEqual(180);
    expect(text).toMatch(/hint text: Still waiting after 3 minutes\..*npm run dev/);
  });
});
