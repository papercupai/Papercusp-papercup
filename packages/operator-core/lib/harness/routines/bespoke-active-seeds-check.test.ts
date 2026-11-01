/**
 * bespoke-active-seeds-check — EI-18746253391734322's recurrence guard. Fake tagged-
 * template sql (mirrors seed-hive-release-routines.test.ts); no PG.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALWAYS_ON_SYSTEM_ROUTINE_NAMES,
  BESPOKE_ACTIVE_SEEDS,
  checkBespokeActiveSeeds,
  formatBespokeActiveSeedWarning,
  isAlwaysOnSystemRoutine,
  isReaffirmed,
  type BespokeActiveSeed,
} from './bespoke-active-seeds-check';

const ENTRIES: BespokeActiveSeed[] = [
  { name: 'foo-routine', seedScript: 'seed-foo-routine.ts' },
  { name: 'bar-routine', seedScript: 'seed-bar-routine.ts' },
  { name: 'baz-routine', seedScript: 'seed-baz-routine.ts' },
];

type FakeRow = { name: string; active: boolean; metadata?: { pause?: Record<string, unknown> } | null };

function fakeSql(rows: FakeRow[]) {
  return (async () => rows) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'];
}

function routedFakeSql(rowsByInstallSlug: Record<string, FakeRow[]>, calls: Array<{ installSlug: string; names: string[] }>) {
  return (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ installSlug: String(values[0]), names: (values[2] as string[]) ?? [] });
    return rowsByInstallSlug[String(values[0])] ?? [];
  }) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'];
}

const NOW = Date.parse('2026-08-08T20:00:00Z');
const paused = (name: string, pause: Record<string, unknown> | null): FakeRow => ({
  name,
  active: false,
  metadata: pause ? { pause } : null,
});

const ROUTINES_DIR = dirname(fileURLToPath(import.meta.url));
const ACTIVE_BY_DEFAULT = /(?:const\s+active\s*=\s*!process\.argv\.includes\(['"]--inactive['"]\);|routineSeedJanitorArguments\s*\()/;
const INACTIVE_BY_DEFAULT = /const\s+active\s*=\s*process\.argv\.includes\(['"]--active['"]\);/;
const ACTIVE_BY_DEFAULT_EXCEPTIONS: Record<string, string> = {
  'seed-plan-anchor-freshness-routine.ts':
    'its initial INSERT explicitly creates an active row and its ON CONFLICT update preserves the existing active state',
};

// EI-22136759189899545: the enumerator used to be `-routine\.ts` (singular) only, which
// silently exempted every plural `-routines.ts` writer from every assertion in this file —
// a seed script got full exemption from the silence guard by being named with an "s". Widened
// to cover both spellings; the files below still can't be swept into the automated
// ACTIVE_BY_DEFAULT/INACTIVE_BY_DEFAULT idiom check because each has its own reason its
// executable doesn't (or shouldn't) express a single `const active = ...` line, so they are
// EXEMPT — but the completeness test below still requires every seed-*.ts file to be either
// pattern-matched-and-non-exempt or explicitly listed here, so a future exemption can't be
// silent either.
const EXEMPT_SEED_SCRIPTS: Record<string, string> = {
  'seed-hive-canary-routine.ts':
    'permanently retired with the autonomous cup loop; its seed is a historical inactive-row ' +
    'normalizer and is intentionally excluded from BESPOKE_ACTIVE_SEEDS',
  'seed-hive-canary-sla-routine.ts':
    'permanently retired with the autonomous cup loop; its seed is a historical inactive-row ' +
    'normalizer and is intentionally excluded from BESPOKE_ACTIVE_SEEDS',
  'seed-hive-release-routines.ts':
    'covered by its own dedicated seed-hive-release-routines.test.ts (see the mirrors-comment ' +
    'at the top of this file) — not this guard’s single-line active/inactive idiom',
  'seed-in-process-sweep-routines.ts':
    'writes state-mirror in-process rows that are "fired by nobody" (its own header comment); ' +
    'active is hardcoded TRUE with no --inactive flag at all, and startInProcessSweepArmReconciler ' +
    're-arms every row unconditionally on every host boot — self-arming, not the "manual seed ' +
    'script nobody ran" bug class this guard exists to catch',
  'seed-routine-announce.ts':
    'a shared print helper for other seed scripts, not itself a seed writer — no main(), no ' +
    'INSERT into harness_shared.routines',
  'seed-routine-main.ts':
    'shared seed execution and janitor-argument helpers; it has no fixed routine identity of its own',
};

function seedSources(): Array<{ file: string; source: string }> {
  return readdirSync(ROUTINES_DIR)
    .filter((file) => /^seed-.*-routines?\.ts$/.test(file) && !(file in EXEMPT_SEED_SCRIPTS))
    .sort()
    .map((file) => ({ file, source: readFileSync(resolve(ROUTINES_DIR, file), 'utf8') }));
}

/** The FULL population this guard is responsible for accounting for — every seed-*.ts
 *  (non-test) file in the directory, regardless of naming convention. */
function allSeedScripts(): string[] {
  return readdirSync(ROUTINES_DIR)
    .filter((file) => /^seed-.*\.ts$/.test(file) && !file.endsWith('.test.ts'))
    .sort();
}

describe('checkBespokeActiveSeeds', () => {
  it('all present + active → ok, nothing missing or inactive', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        { name: 'baz-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.inactive).toEqual([]);
  });

  it('a routine with no row at all is reported MISSING (the EI-18746253391734322 case)', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        // baz-routine: no row — never seeded.
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.missing.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive).toEqual([]);
  });

  it('a routine seeded but active=false is reported INACTIVE, not missing', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: false },
        { name: 'baz-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual([]);
    expect(res.inactive.map((e) => e.name)).toEqual(['bar-routine']);
  });

  it('reports BOTH missing and inactive together when the DB has a mix', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([{ name: 'foo-routine', active: false }]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.inactive.map((e) => e.name)).toEqual(['foo-routine']);
    expect(res.missing.map((e) => e.name).sort()).toEqual(['bar-routine', 'baz-routine']);
  });

  it('defaults to the real BESPOKE_ACTIVE_SEEDS registry when entries is omitted', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([]), // nothing seeded
      installSlug: 'papercusp',
      workspaceId: 'ws',
    });
    // Every real registered routine name should show up as missing against an empty DB.
    expect(res.missing.length).toBeGreaterThanOrEqual(6);
    expect(res.missing.map((e) => e.name)).toContain('supervision-reconcile');
  });

  it('queries each seed in the install scope its writer actually targets', async () => {
    const calls: Array<{ installSlug: string; names: string[] }> = [];
    const projectHistoryEntry = BESPOKE_ACTIVE_SEEDS.find((seed) => seed.name === 'project-history-refresh');
    if (!projectHistoryEntry) throw new Error('project-history-refresh must be in BESPOKE_ACTIVE_SEEDS');
    expect(projectHistoryEntry).toMatchObject({
      seedScript: 'seed-project-history-refresh-routine.ts',
      scope: 'sidestage',
    });
    const res = await checkBespokeActiveSeeds({
      sql: routedFakeSql(
        {
          papercusp: [{ name: 'home-routine', active: true }],
          'hive-canary': [
            { name: 'hive-canary', active: true },
            { name: 'hive-canary-sla', active: true },
          ],
          sidestage: [{ name: 'project-history-refresh', active: true }],
        },
        calls,
      ),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: [
        { name: 'home-routine', seedScript: 'seed-home-routine.ts' },
        { name: 'hive-canary', seedScript: 'seed-hive-canary-routine.ts', scope: 'hive-canary' },
        { name: 'hive-canary-sla', seedScript: 'seed-hive-canary-sla-routine.ts', scope: 'hive-canary' },
        projectHistoryEntry,
      ],
    });

    expect(calls).toEqual([
      { installSlug: 'papercusp', names: ['home-routine'] },
      { installSlug: 'hive-canary', names: ['hive-canary', 'hive-canary-sla'] },
      { installSlug: 'sidestage', names: ['project-history-refresh'] },
    ]);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.inactive).toEqual([]);
  });
});

describe('formatBespokeActiveSeedWarning', () => {
  it('puts each routine scope, name, and missing/inactive/dark state in the boot alert', () => {
    const warning = formatBespokeActiveSeedWarning([
      { name: 'missing-rescue', seedScript: 'seed-missing-rescue.ts', installSlug: 'hive-canary' },
      {
        name: 'paused-rescue', seedScript: 'seed-paused-rescue.ts', installSlug: 'papercusp',
        pauseReason: 'migration hold', reviewBy: null, pausedAtMs: NOW,
      },
      {
        name: 'dark-rescue', seedScript: 'seed-dark-rescue.ts', installSlug: 'sidestage',
        lastFiredAtMs: null, createdAtMs: NOW - 3_600_000, intervalSec: 900, neverFired: true, ageSec: 3_600,
      },
    ]);

    expect(warning.summary).toContain('hive-canary/missing-rescue [MISSING]');
    expect(warning.summary).toContain('papercusp/paused-rescue [INACTIVE]');
    expect(warning.summary).toContain('sidestage/dark-rescue [DARK]');
    expect(warning.body).toContain('hive-canary/missing-rescue — MISSING:');
    expect(warning.body).toContain('papercusp/paused-rescue — INACTIVE: active=false; pause reason: migration hold');
    expect(warning.body).toContain('sidestage/dark-rescue — DARK: active=true; never fired since creation (60m ago)');
  });
});

/**
 * D-007 (silent-halt-detection-and-owner-rails-2026-08-08): `escalatable` is the owner-rail
 * question, split from `ok` so a deliberate, DATED pause can be held without silencing a
 * forgotten one. The measured failure these pin: `unguarded-halt-rescue` paused 2026-07-27,
 * dark 11.9 days, no notice — because every age-based mechanism downstream eventually
 * reclassified it as decommissioned rather than asking whether it was SUPPOSED to be running.
 */
describe('escalatable — which pauses actually warrant waking a human', () => {
  it('a pause with a FUTURE reviewBy is re-affirmed: still inactive, but does NOT escalate', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', { reason: 'deliberate hold for migration 812', reviewBy: '2026-09-01T00:00:00Z' }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.ok).toBe(false); // the strict steady-state assertion still fails — the CLI wants that
    expect(res.inactive.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive[0]?.reviewBy).toBe('2026-09-01T00:00:00Z');
    expect(res.escalatable).toEqual([]); // …but nobody gets paged
  });

  it('a pause whose reviewBy has EXPIRED escalates again — the re-affirmation is dated, not permanent', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', { reason: 'hold', reviewBy: '2026-08-01T00:00:00Z' }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });

  it('a pause with a reason but NO reviewBy escalates — this is the unguarded-halt-rescue shape', async () => {
    // The real row: reason "Paused via the Agents pane", no reviewBy. A populated-but-content-free
    // reason reads as more deliberate than an empty one (D-006), so presence of a reason must not
    // buy silence — only a dated re-affirmation does.
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', {
          reason: 'Paused via the Agents pane',
          pausedBy: 'loopback',
          pausedAtMs: 1785191563941,
        }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive[0]?.pauseReason).toBe('Paused via the Agents pane');
    expect(res.inactive[0]?.pausedAtMs).toBe(1785191563941);
  });

  it('a pause with NO metadata at all reports pauseReason null — the unaudited-path fingerprint', async () => {
    // EI-18137248342636257 found active=false written with no audit_log row anywhere near it.
    // routines:set REQUIRES a reason, so a null here proves the flip bypassed the tool entirely.
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', null),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.inactive[0]?.pauseReason).toBeNull();
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });

  it('a MISSING row always escalates — there is no row to carry a reviewBy on', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });
});

describe('isReaffirmed — fails CLOSED, so an unreadable field can never buy silence', () => {
  it('only a parseable FUTURE date re-affirms', () => {
    expect(isReaffirmed('2026-09-01T00:00:00Z', NOW)).toBe(true);
    expect(isReaffirmed('2026-08-01T00:00:00Z', NOW)).toBe(false); // past
    expect(isReaffirmed(null, NOW)).toBe(false); // absent
    expect(isReaffirmed('', NOW)).toBe(false); // empty
    expect(isReaffirmed('whenever we get to it', NOW)).toBe(false); // unparseable
    expect(isReaffirmed('not-a-date', NOW)).toBe(false);
  });

  it('CONTROL: a naive truthiness check would pass the cases above that matter', () => {
    // Calibration for the test above — if isReaffirmed were rewritten as `!!reviewBy` (the
    // obvious shortcut), the two most dangerous inputs would silently start buying silence.
    // This asserts the naive rule really is wrong on them, so the assertions above are load-
    // bearing rather than vacuously true.
    const naive = (v: string | null) => !!v;
    expect(naive('whenever we get to it')).toBe(true); // naive: silenced …
    expect(isReaffirmed('whenever we get to it', NOW)).toBe(false); // … real: escalates ✓
    expect(naive('2026-08-01T00:00:00Z')).toBe(true); // naive: silenced forever …
    expect(isReaffirmed('2026-08-01T00:00:00Z', NOW)).toBe(false); // … real: expired ✓
  });
});

describe('ALWAYS_ON_SYSTEM_ROUTINE_NAMES — derived from the registry, never hand-copied', () => {
  it('contains gc-dead-loops — the registered-without-a-row failure that motivated EI-18752496371939475', () => {
    expect(isAlwaysOnSystemRoutine('gc-dead-loops')).toBe(true);
  });

  it('contains unguarded-halt-rescue — the routine whose 11.9-day silence motivated D-007', () => {
    expect(isAlwaysOnSystemRoutine('unguarded-halt-rescue')).toBe(true);
  });

  it('stays in lockstep with BESPOKE_ACTIVE_SEEDS', () => {
    // The regression this pins is the one D-007 names: RELEASE_CRITICAL_ROUTINE_NAMES (2 names)
    // and ALWAYS_ON_LEARNING_LOOPS (3 names) are both hand-written sets, and a routine whose job
    // is noticing silence was in neither. Deriving the set means adding a seed script to the
    // registry cannot forget to also add it here.
    expect([...ALWAYS_ON_SYSTEM_ROUTINE_NAMES].sort()).toEqual(BESPOKE_ACTIVE_SEEDS.map((s) => s.name).sort());
    expect(ALWAYS_ON_SYSTEM_ROUTINE_NAMES.size).toBe(BESPOKE_ACTIVE_SEEDS.length);
  });

  it('registers every seed script whose executable writer defaults active', () => {
    const sources = seedSources();
    const activeSeedScripts = sources
      .filter(({ file, source }) => ACTIVE_BY_DEFAULT.test(source) || file in ACTIVE_BY_DEFAULT_EXCEPTIONS)
      .map(({ file }) => file);
    // Deduped: EI-22136759189899545 — a script may legitimately upsert several named
    // routines in one run (seed-coord-invariant-routines.ts seeds 5, seed-oddsmith-cron-
    // routines.ts seeds 3), so it appears once per NAME in BESPOKE_ACTIVE_SEEDS but only
    // once per FILE in `sources` (readdirSync never lists a filename twice). Comparing the
    // raw per-name array against the per-file array would never match for a multi-row script.
    const registeredSeedScripts = [...new Set(BESPOKE_ACTIVE_SEEDS.map(({ seedScript }) => seedScript))].sort();

    expect(
      registeredSeedScripts,
      'Every seed script whose writer defaults active must be covered by the live missing/inactive-row guard. ' +
        'Add the script and its routine row name(s) to BESPOKE_ACTIVE_SEEDS in bespoke-active-seeds-check.ts.',
    ).toEqual(activeSeedScripts);
  });

  it('makes every bespoke seed writer declare active or inactive as its executable default', () => {
    const unclassified = seedSources()
      .filter(({ file, source }) =>
        !ACTIVE_BY_DEFAULT.test(source) && !INACTIVE_BY_DEFAULT.test(source) && !(file in ACTIVE_BY_DEFAULT_EXCEPTIONS))
      .map(({ file }) => file);

    expect(
      unclassified,
      "A bespoke seed must use one explicit default: `!process.argv.includes('--inactive')` for always-on, " +
        "or `process.argv.includes('--active')` for human-gated. This is the source of truth for the live guard.",
    ).toEqual([]);
  });

  it('pins the shared janitor default and the explicit active SQL seed exception', () => {
    const sharedHelper = readFileSync(resolve(ROUTINES_DIR, 'seed-routine-main.ts'), 'utf8');
    expect(sharedHelper).toMatch(
      /export function routineSeedJanitorArguments[\s\S]*?const active\s*=\s*!process\.argv\.includes\(['"]--inactive['"]\);/,
    );

    expect(ACTIVE_BY_DEFAULT_EXCEPTIONS['seed-plan-anchor-freshness-routine.ts']).toBeTruthy();
    const explicitSeed = readFileSync(resolve(ROUTINES_DIR, 'seed-plan-anchor-freshness-routine.ts'), 'utf8');
    expect(explicitSeed).toContain('Seed ACTIVE by default');
    expect(explicitSeed).toMatch(/'skip','skip-old',true,now\(\)/);
  });

  it('EI-22136759189899545: every seed-*.ts file is accounted for — idiom-checked or explicitly exempt', () => {
    // The bug this pins: seedSources() previously matched `-routine.ts` (singular) only, so
    // a `-routines.ts` writer never appeared in ANY assertion above and nothing failed —
    // "a file the filter never saw" was silent. This scans the population seedSources()
    // itself CANNOT see (readdirSync over `seed-*.ts`, no naming assumption at all) and
    // requires every file to be either swept up by the pattern-matching seedSources() or
    // named in EXEMPT_SEED_SCRIPTS with a reason. A differently-named seed writer added
    // later — or one whose idiom seedSources() can't parse — fails HERE instead of
    // vanishing.
    const idiomChecked = new Set(seedSources().map((s) => s.file));
    const unaccounted = allSeedScripts().filter(
      (file) => !idiomChecked.has(file) && !(file in EXEMPT_SEED_SCRIPTS),
    );
    expect(
      unaccounted,
      'A seed-*.ts file that seedSources() does not see and EXEMPT_SEED_SCRIPTS does not explain. ' +
        'Either widen the seedSources() filename pattern to match it, or add it to ' +
        'EXEMPT_SEED_SCRIPTS (bespoke-active-seeds-check.test.ts) with a reason.',
    ).toEqual([]);
  });

  it('does not claim a routine that is NOT always-on', () => {
    expect(isAlwaysOnSystemRoutine('green-checkpoint')).toBe(false);
    expect(isAlwaysOnSystemRoutine('some-human-gated-bringup')).toBe(false);
  });
});

/**
 * The liveness level: a row that is PRESENT and ACTIVE but not executing.
 *
 * Regression cover for the ephemeral executor's boot-only rescan — `armEphemeralExecutor`
 * reads `harness_shared.routines` exactly once at host boot, so a row seeded afterwards by a
 * standalone `tsx` seed script (a different process from the bg-host holding the
 * module-singleton arm-set) never receives a timer. `frozen-candidate-drift-sweep` sat
 * active=true / last_fired_at=NULL that way, passing every existence check in the system.
 */
describe('checkBespokeActiveSeeds — dark (active but not executing)', () => {
  const T = Date.parse('2026-08-30T23:50:00Z');
  type LiveRow = {
    name: string;
    active: boolean;
    metadata: { pause?: Record<string, unknown> } | null;
    last_fired_at: string | Date | null;
    created_at: string | Date | null;
    trigger_config: { interval_sec?: unknown } | null;
  };
  const live = (over: Partial<LiveRow> & { name: string }): LiveRow => ({
    active: true,
    metadata: null,
    last_fired_at: null,
    created_at: null,
    trigger_config: null,
    ...over,
  });
  const check = (rows: LiveRow[]) =>
    checkBespokeActiveSeeds({
      sql: (async () => rows) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'],
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: [{ name: 'foo-routine', seedScript: 'seed-foo-routine.ts' }],
      now: T,
    });

  it('flags the real frozen-candidate-drift-sweep shape: active, 900s, seeded 77m ago, never fired', async () => {
    const res = await check([
      live({
        name: 'foo-routine',
        created_at: '2026-08-30T22:33:05.794Z',
        trigger_config: { interval_sec: 900 },
      }),
    ]);
    expect(res.dark).toHaveLength(1);
    expect(res.dark[0]!.neverFired).toBe(true);
    expect(res.dark[0]!.intervalSec).toBe(900);
    expect(res.dark[0]!.lastFiredAtMs).toBeNull();
    // It is neither missing nor paused — which is exactly why nothing caught it before.
    expect(res.missing).toEqual([]);
    expect(res.inactive).toEqual([]);
    expect(res.escalatable.map((e) => e.name)).toEqual(['foo-routine']);
    expect(res.ok).toBe(false);
  });

  it('does NOT flag a freshly seeded row that has not reached its first tick', async () => {
    const res = await check([
      live({
        name: 'foo-routine',
        created_at: new Date(T - 60_000).toISOString(), // 1m old, 900s cadence
        trigger_config: { interval_sec: 900 },
      }),
    ]);
    expect(res.dark).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('does NOT flag a routine firing inside its declared cadence', async () => {
    const res = await check([
      live({
        name: 'foo-routine',
        created_at: '2026-08-18T04:44:04Z',
        last_fired_at: new Date(T - 221_000).toISOString(), // coverage-census, live-measured
        trigger_config: { interval_sec: 900 },
      }),
    ]);
    expect(res.dark).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('flags a routine whose last fire is far past its own cadence (the corpus-term-df shape)', async () => {
    const res = await check([
      live({
        name: 'foo-routine',
        created_at: '2026-08-03T17:12:20Z',
        last_fired_at: new Date(T - 127_324_000).toISOString(), // 35h ago, 6h cadence => 5.9x
        trigger_config: { interval_sec: 21_600 },
      }),
    ]);
    expect(res.dark).toHaveLength(1);
    expect(res.dark[0]!.neverFired).toBe(false);
    expect(res.ok).toBe(false);
  });

  it('holds the 4x boundary: 3.9x is healthy, 4.1x is dark', async () => {
    const at = async (mult: number) =>
      (
        await check([
          live({
            name: 'foo-routine',
            created_at: '2026-08-03T17:12:20Z',
            last_fired_at: new Date(T - mult * 900 * 1000).toISOString(),
            trigger_config: { interval_sec: 900 },
          }),
        ])
      ).dark.length;
    expect(await at(3.9)).toBe(0);
    expect(await at(4.1)).toBe(1);
  });

  it('does not judge lateness for a cron row with no declared interval_sec', async () => {
    const res = await check([
      live({
        name: 'foo-routine',
        created_at: '2026-07-17T13:36:34Z',
        last_fired_at: new Date(T - 69_877_000).toISOString(), // 19h since last fire, cron
        trigger_config: null,
      }),
    ]);
    expect(res.dark).toEqual([]);
  });

  it('still flags a NEVER-fired cron row once a full day has passed', async () => {
    const day = 86_400_000;
    const res = await check([
      live({ name: 'foo-routine', created_at: new Date(T - day - 1000).toISOString() }),
    ]);
    expect(res.dark).toHaveLength(1);
    expect(res.dark[0]!.neverFired).toBe(true);
    expect(res.dark[0]!.intervalSec).toBeNull();
    const fresh = await check([
      live({ name: 'foo-routine', created_at: new Date(T - day + 60_000).toISOString() }),
    ]);
    expect(fresh.dark).toEqual([]);
  });

  it('fails OPEN on an unreadable created_at rather than accusing a routine', async () => {
    const res = await check([
      live({ name: 'foo-routine', created_at: 'not-a-timestamp', trigger_config: { interval_sec: 900 } }),
    ]);
    expect(res.dark).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('reports a paused row as inactive, never as dark (the repair differs)', async () => {
    const res = await check([
      live({ name: 'foo-routine', active: false, created_at: '2026-06-11T22:38:01Z' }),
    ]);
    expect(res.dark).toEqual([]);
    expect(res.inactive).toHaveLength(1);
  });
});
