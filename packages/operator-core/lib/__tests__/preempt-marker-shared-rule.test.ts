/**
 * Regression guards for the SHARED pc-heavy marker rule (EI-21884510946030513).
 *
 * `scripts/affected-tests.mjs` carried a second, independent copy of the marker
 * publication logic with no liveness check at all: any EEXIST called
 * `process.exit(75)`. EI-21882371330313535 had already fixed exactly that
 * failure mode in `scripts/test-files.mjs`, but its scope was the `test:file`
 * path, so the fix landed there and there only — leaving the strictly worse
 * consequence on the runner with the weaker code, because `test:affected` is
 * what the green-checkpoint gate invokes and an abort there means ZERO files
 * were measured, so infra debris reads as a genuine red.
 *
 * The divergence between the two copies WAS the bug, so these guards pin two
 * different things:
 *   1. the BEHAVIOUR of the now-shared rule (`createPreemptMarkerExclusive`);
 *   2. that `affected-tests.mjs` actually routes through it, rather than
 *      re-growing a third copy of the fatal version.
 *
 * (2) has to be a source-text assertion: `affected-tests.mjs` publishes its
 * marker at module scope, so importing it would RUN the whole test runner — the
 * same reason `affected-tests-preempt-ready.test.ts` reads the source too.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  consumePreemptMarkerEnv,
  createPreemptMarkerExclusive,
  // @ts-expect-error — plain-Node .mjs CLI helper, no declaration file (same convention as test-file-router.test.ts).
} from '../../../../scripts/lib/preempt-markers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

let dir: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'preempt-shared-'));
  marker = join(dir, 'ready.SHARED');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly not running: 2^22 is above the default Linux pid_max. */
function deadPid(): number {
  const candidate = 4_194_303;
  try {
    process.kill(candidate, 0);
    throw new Error('precondition failed: chosen dead pid is actually alive');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    throw error;
  }
}

/** Backdate a path so age-based rules see it as old. */
function ageBy(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

describe('createPreemptMarkerExclusive — publishes and records the owner', () => {
  it('creates the marker and writes this process pid', () => {
    expect(createPreemptMarkerExclusive(marker)).toBe('created');
    expect(readFileSync(marker, 'utf8').trim()).toBe(String(process.pid));
  });
});

describe('createPreemptMarkerExclusive — reclaims debris instead of aborting', () => {
  it('reclaims a marker whose recorded owner is dead', () => {
    writeFileSync(marker, `${deadPid()}\n`);
    expect(createPreemptMarkerExclusive(marker)).toBe('reclaimed');
    expect(readFileSync(marker, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a zero-length marker that has sat past the debris bound', () => {
    writeFileSync(marker, '');
    ageBy(marker, 60_000);
    expect(createPreemptMarkerExclusive(marker)).toBe('reclaimed');
  });

  it('reclaims a marker whose contents are not a pid at all', () => {
    writeFileSync(marker, 'not-a-pid\n');
    ageBy(marker, 60_000);
    expect(createPreemptMarkerExclusive(marker)).toBe('reclaimed');
  });
});

describe('createPreemptMarkerExclusive — never steals a live barrier', () => {
  it('refuses when the recorded owner is alive', () => {
    writeFileSync(marker, `${process.pid}\n`);
    expect(() => createPreemptMarkerExclusive(marker)).toThrow(/EEXIST/);
    // The live owner's marker is left exactly as it was.
    expect(readFileSync(marker, 'utf8').trim()).toBe(String(process.pid));
  });

  it('refuses a zero-length marker that is still inside the publish window', () => {
    // A peer caught between open(O_CREAT|O_EXCL) and the write of its pid.
    writeFileSync(marker, '');
    expect(() => createPreemptMarkerExclusive(marker)).toThrow(/EEXIST/);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('consumePreemptMarkerEnv — the marker addresses stop at the runner they were sent to (EI-25671809770924720)', () => {
  it('returns both paths and leaves no copy in the env a child would inherit', () => {
    const env: NodeJS.ProcessEnv = {
      PC_HEAVY_PREEMPT_READY_FILE: ' /tmp/pc-heavy-ready/ready.AbC123 ',
      PC_HEAVY_PSI_FINALIZATION_FILE: '/tmp/pc-heavy-ready/finalization.XyZ789',
      PC_HEAVY_ADMISSION_ID: 'pc-heavy-1-2',
    };
    expect(consumePreemptMarkerEnv(env)).toEqual({
      readyFile: '/tmp/pc-heavy-ready/ready.AbC123',
      finalizationFile: '/tmp/pc-heavy-ready/finalization.XyZ789',
    });
    expect(env).not.toHaveProperty('PC_HEAVY_PREEMPT_READY_FILE');
    expect(env).not.toHaveProperty('PC_HEAVY_PSI_FINALIZATION_FILE');
    // Only the two barrier addresses are consumed; the rest of pc-heavy's env is untouched.
    expect(env.PC_HEAVY_ADMISSION_ID).toBe('pc-heavy-1-2');
  });

  it('reports absent or blank addresses as null, never as a path', () => {
    expect(consumePreemptMarkerEnv({ PC_HEAVY_PREEMPT_READY_FILE: '   ' })).toEqual({
      readyFile: null,
      finalizationFile: null,
    });
  });
});

describe('scripts/affected-tests.mjs routes through the shared rule', () => {
  // Overridable so `scripts/mutation-probe.sh` can point these assertions at a
  // COPY (or a historical snapshot) and prove they actually fail on the
  // pre-fix source — without ever mutating this shared, continuously-swept tree.
  const subjectPath =
    process.env.PROBE_AFFECTED_TESTS?.trim() || join(REPO_ROOT, 'scripts/affected-tests.mjs');
  const source = readFileSync(subjectPath, 'utf8');

  it('imports the rule from lib/, not from test-files.mjs', () => {
    expect(source).toContain('./lib/preempt-markers.mjs');
    // Importing test-files.mjs would drag its top-level side effects
    // (ensurePapercuspTmpdir, applyWorkerCapEnv) onto the gate's runner.
    //
    // This targets an IMPORT specifically: the file legitimately NAMES
    // test-files.mjs in comments and in a path comparison, so a bare
    // `not.toContain` would fail on prose that is not the hazard.
    expect(source).not.toMatch(/from\s*["'][^"']*test-files\.mjs["']/);
  });

  it('publishes both markers through createPreemptMarkerExclusive', () => {
    for (const fn of ['publishPreemptReadyMarker', 'publishPreemptFinalizationMarker']) {
      const start = source.indexOf(`function ${fn}()`);
      expect(start, `${fn} should still be declared`).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n}', start));
      expect(body, `${fn} must use the shared rule`).toContain(
        'createPreemptMarkerExclusive',
      );
    }
  });

  it('no longer writes either marker with a bare fatal exclusive create', () => {
    // The exact shape that made an EEXIST fatal on the gate's runner.
    for (const file of ['preemptReadyFile', 'preemptFinalizationFile']) {
      expect(source).not.toMatch(
        new RegExp(`writeFileSync\\(\\s*${file}[^)]*flag:\\s*"wx"`, 's'),
      );
    }
  });
});
