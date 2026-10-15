/**
 * Guard: every hand-rolled `postgres(...)` pool must DECLARE its idle policy.
 *
 * Why this exists (2026-07-26, P-009 of shared-hive-cross-machine-scale-10k):
 * postgres-js defaults `idle_timeout` to **0 = never close**. `buildClient()` has
 * always set 30s, so pools built through it self-drain — but the ~13 pools that
 * bypass `buildClient` and only spread `longLivedPoolConnectionOptions()` /
 * `suPoolConnectionOptions()` silently inherited that 0 and held their backends open
 * FOREVER. Measured live: 294 idle vs 3 active connections, 343/512 `max_connections`,
 * with `su-lock-tx` alone parking 34 idle backends.
 *
 * The failure mode is a SILENT OMISSION — nobody wrote "never close", they just didn't
 * write anything — so the fix is to make the choice impossible to leave implicit.
 * Both answers are legitimate and the test accepts either:
 *   - transactional pool → `idle_timeout: poolIdleTimeoutSec()` (drain idle backends)
 *   - LISTEN pool        → `idle_timeout: 0` (idle BY DESIGN; reaping it would silently
 *                          drop the subscription and break notification delivery)
 *
 * That second case is why this is a "declare it" guard rather than a lint banning 0, and
 * why the shared helper deliberately does NOT supply a nonzero default: 5 LISTEN buses
 * spread the same helper, and a default would have broken every one of them.
 *
 * ── application_name (WI-6062, 2026-07-26) ──────────────────────────────────
 * A SEPARATE class of the same "silent omission" bug: a hand-rolled `postgres(...)`
 * MODULE-LEVEL SINGLETON pool (`let pool: ...|null = null; ... pool = postgres(...)`)
 * that skips `longLivedPoolConnectionOptions()`/`suPoolConnectionOptions()` entirely
 * ALSO inherits postgres-js's other silent default: `application_name: 'postgres.js'`
 * (its own literal fallback string, not blank — see `node_modules/postgres/src/index.js`).
 * Found live: 10 `llm-testing/*` singleton pools (ledger/telemetry/storage/promotion/
 * replay + 4 admin routes) all built their own bare `postgres(getHarnessAdminUrl(), {
 * max, prepare: false })` — no helper, no tag — so any connection they opened was
 * PERMANENTLY UNATTRIBUTABLE in `pg_stat_activity` (indistinguishable from any other
 * untagged pool) AND missed the helper's WI-3816 dead-client zombie-detection GUCs,
 * which is exactly why 2 of them sat open, idle, unexplained, for 6.65 days (WI-6062).
 * The second describe block below extends the SAME guard shape to this class: find
 * every module-level singleton pg-client declaration, then require its `postgres(...)`
 * assignment to declare an application_name (via one of the two shared helpers, or an
 * inline `application_name:` for a bespoke case like the watchdog tick-lock). Scoped to
 * the SINGLETON shape deliberately — a function-scoped, always-`.end()`-ed client (a
 * script, a gym cycle, a test fixture) isn't the "opened once, held forever" leak shape
 * this guards against, so those are correctly out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['packages', 'libs', 'apps'];
const SKIP_DIRS = new Set(['node_modules', '_retired', 'dist', 'build', '.git', '.next', 'target']);

/** The option-builder helpers whose call sites must declare an idle policy. */
const HELPERS = ['longLivedPoolConnectionOptions', 'suPoolConnectionOptions'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink / race with a concurrent agent's edit
    }
    if (st.isDirectory()) walk(full, out);
    // Tests are excluded deliberately: they contain fixture pool literals (including
    // this file's own deliberately-omitted one, which the guard correctly flagged when
    // they were in scope) that are not real connection pools.
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.integration.test.ts')
    )
      out.push(full);
  }
  return out;
}

/** A spread of a helper into an object literal, ignoring doc-comment examples. */
function findPoolSites(source: string): { line: number; helper: string }[] {
  const lines = source.split('\n');
  const sites: { line: number; helper: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Skip comments — connection.ts documents the exact spread in a usage example.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const helper of HELPERS) {
      if (lines[i].includes(`...${helper}(`)) sites.push({ line: i, helper });
    }
  }
  return sites;
}

/**
 * Does the object literal containing this spread declare `idle_timeout`?
 * Scans forward to the end of the enclosing `postgres({...})` call — detected by the
 * first line whose trimmed form starts with `})`, which closes the options object.
 */
function declaresIdleTimeout(source: string, startLine: number): boolean {
  const lines = source.split('\n');
  for (let i = startLine; i < Math.min(lines.length, startLine + 25); i++) {
    const trimmed = lines[i].trim();
    if (i > startLine && (trimmed.startsWith('})') || trimmed.startsWith('});'))) return false;
    if (/\bidle_timeout\s*:/.test(lines[i])) return true;
  }
  return false;
}

/**
 * WI-6062: find MODULE-LEVEL singleton pg-client declarations — the
 * `let name: <type> | null = null;` (or `undefined`) shape at column 0 — then the
 * `name = postgres(...)` assignment that later fills them in, anywhere in the same
 * file. This is deliberately narrower than "every `postgres(...)` call": a
 * function-scoped client that is always `.end()`-ed on every path (a script, a gym
 * cycle, a test fixture) is a different, lower-risk shape — it gets reaped every time
 * it's used, so it can't accumulate into the "opened once, held forever" leak this
 * guards against. Only a column-0 `let ... = null` singleton, reassigned once and then
 * reused indefinitely, has that shape.
 */
function findSingletonPoolSites(source: string): { line: number; name: string }[] {
  const lines = source.split('\n');
  const declRe = /^let\s+(\w+)\s*:[^=]*=\s*(?:null|undefined);/;
  const names = new Set<string>();
  for (const line of lines) {
    const m = declRe.exec(line);
    if (m) names.add(m[1]);
  }
  if (names.size === 0) return [];
  const sites: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const name of names) {
      if (new RegExp(`\\b${name}\\s*=\\s*postgres\\(`).test(lines[i])) sites.push({ line: i, name });
    }
  }
  return sites;
}

/**
 * Does the `postgres(...)` call starting at this line declare an application_name —
 * either directly (a bespoke inline tag, e.g. the watchdog tick-lock) or via one of
 * the shared `longLivedPoolConnectionOptions()` / `suPoolConnectionOptions()` helpers
 * (which always set it — see connection.ts's `pgAppName`)? Same forward-scan-to-
 * closing-brace shape as {@link declaresIdleTimeout}.
 */
function declaresApplicationName(source: string, startLine: number): boolean {
  const lines = source.split('\n');
  for (let i = startLine; i < Math.min(lines.length, startLine + 25); i++) {
    const trimmed = lines[i].trim();
    if (i > startLine && (trimmed.startsWith('})') || trimmed.startsWith('});'))) return false;
    if (/\bapplication_name\s*:/.test(lines[i])) return true;
    if (HELPERS.some((h) => lines[i].includes(`...${h}(`))) return true;
  }
  return false;
}

describe('the guard itself detects an undeclared idle policy (non-vacuity)', () => {
  // Proven against fixtures rather than by temporarily breaking a real pool: this tree
  // is shared and auto-committed every few minutes, so a deliberately-wrong file
  // becomes a real commit other agents pull.
  const OMITTED = `
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-new-pool'),
      max: 4,
      prepare: false,
    });`;
  const TRANSACTIONAL = `
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-new-pool'),
      max: 4,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });`;
  const LISTENER = `
    listenerSql = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions("some-bus"),
      max: 1,
      idle_timeout: 0,
    });`;
  const DOC_COMMENT_ONLY = `
     * Usage: \`postgres(url, { ...longLivedPoolConnectionOptions('x'), max: 1 })\`
     * — spread FIRST so a call site's own overrides still win.`;
  // The bug's real shape: a NEXT pool declared after one that did it right. A naive
  // forward scan would run past the first pool's closing brace and find its
  // idle_timeout, exonerating the offender.
  const OMITTED_AFTER_A_GOOD_ONE = `${TRANSACTIONAL}\n${OMITTED}`;

  it('flags a pool that omits idle_timeout', () => {
    const sites = findPoolSites(OMITTED);
    expect(sites).toHaveLength(1);
    expect(declaresIdleTimeout(OMITTED, sites[0].line)).toBe(false);
  });

  it('accepts both legitimate declarations', () => {
    for (const src of [TRANSACTIONAL, LISTENER]) {
      const sites = findPoolSites(src);
      expect(sites).toHaveLength(1);
      expect(declaresIdleTimeout(src, sites[0].line)).toBe(true);
    }
  });

  it('does not scan past the enclosing object into a neighbouring pool', () => {
    const sites = findPoolSites(OMITTED_AFTER_A_GOOD_ONE);
    expect(sites).toHaveLength(2);
    expect(declaresIdleTimeout(OMITTED_AFTER_A_GOOD_ONE, sites[0].line)).toBe(true);
    expect(declaresIdleTimeout(OMITTED_AFTER_A_GOOD_ONE, sites[1].line)).toBe(false);
  });

  it('ignores the usage example in a doc comment', () => {
    expect(findPoolSites(DOC_COMMENT_ONLY)).toEqual([]);
  });
});

describe('pool idle policy is always declared (P-009 connection saturation)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('the tree scan is wired correctly (test is not vacuously green)', () => {
    // Anchored to the SCAN, never to the SIZE of the guarded population — see the note on
    // the identical assertion in the WI-6062 describe below for why a `>= N` floor here is
    // a landmine rather than a safety net.
    expect(files.length).toBeGreaterThan(100);
  });

  it('every pool spreading a shared connection-options helper declares idle_timeout', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of findPoolSites(source)) {
        if (!declaresIdleTimeout(source, site.line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${site.line + 1} (${site.helper})`);
        }
      }
    }
    expect(
      offenders,
      `These pools leave idle_timeout implicit, so postgres-js's 0 default applies and ` +
        `their backends are held open FOREVER. Declare the intent explicitly:\n` +
        `  transactional → idle_timeout: poolIdleTimeoutSec()\n` +
        `  LISTEN        → idle_timeout: 0  // idle by design; reaping drops the subscription\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });
});

describe('the singleton-pool guard itself detects an undeclared application_name (non-vacuity)', () => {
  const UNTAGGED = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 2, prepare: false });
  return pool;
}`;
  const TAGGED_VIA_HELPER = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-pool'),
      max: 2,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });
  }
  return pool;
}`;
  const TAGGED_INLINE = `
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), {
      max: 1,
      idle_timeout: 0,
      connection: { application_name: \`pcusp:watchdog-ticklock:p\${process.pid}\` },
    });
  }
  return _tickLockSql;
}`;
  // The bug's real shape: a function-scoped client (always .end()-ed) must NOT be
  // flagged — only the module-level singleton is the "held forever" leak shape.
  const FUNCTION_SCOPED_NOT_A_SINGLETON = `
async function run() {
  let gymSql: postgres.Sql | undefined;
  try {
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });
  } finally {
    if (gymSql) await gymSql.end({ timeout: 5 });
  }
}`;

  it('flags a singleton pool that omits application_name', () => {
    const sites = findSingletonPoolSites(UNTAGGED);
    expect(sites).toHaveLength(1);
    expect(declaresApplicationName(UNTAGGED, sites[0].line)).toBe(false);
  });

  it('accepts both legitimate declarations (shared helper, or inline tag)', () => {
    for (const src of [TAGGED_VIA_HELPER, TAGGED_INLINE]) {
      const sites = findSingletonPoolSites(src);
      expect(sites).toHaveLength(1);
      expect(declaresApplicationName(src, sites[0].line)).toBe(true);
    }
  });

  it('ignores a function-scoped (always-.end()-ed) client — not the singleton shape', () => {
    expect(findSingletonPoolSites(FUNCTION_SCOPED_NOT_A_SINGLETON)).toEqual([]);
  });
});

describe('singleton pg-client pools always declare an application_name (WI-6062)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('the tree scan is wired correctly (test is not vacuously green)', () => {
    // Non-vacuity is anchored to the SCAN (did walk() find real source files?), NEVER to
    // the size of the population being guarded.
    //
    // Every population counted in this file SHRINKS as pools migrate to
    // getLongLivedAdminPool — at the end state findSingletonPoolSites goes to zero by
    // design. A `>= N` floor therefore reds the gate for whoever finishes the migration:
    // the guard punishing its own success. This was not hypothetical — the floor here
    // read `>= 10` with a comment recording ~14 sites measured 2026-07-26, and by
    // 2026-08-02 the real count was exactly 10, one migration from a spurious red.
    //
    // Detector correctness — the thing a count was standing in for — is proven directly
    // by the fixture describe above, which runs these same functions over known-good and
    // known-bad strings. That is where it belongs: a fixture cannot drift with the tree.
    expect(files.length).toBeGreaterThan(100);
  });

  it('every module-level singleton pg-client pool declares an application_name', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of findSingletonPoolSites(source)) {
        if (!declaresApplicationName(source, site.line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${site.line + 1} (${site.name})`);
        }
      }
    }
    expect(
      offenders,
      `These singleton pools leave application_name undeclared, so postgres-js's own ` +
        `'postgres.js' default applies and any connection they open is PERMANENTLY ` +
        `UNATTRIBUTABLE in pg_stat_activity (WI-6062: this is exactly how 2 llm-testing ` +
        `pools sat idle, unexplained, for 6.65 days). Route the pool through the shared ` +
        `helper (spread FIRST so a call site's own overrides still win):\n` +
        `  ...longLivedPoolConnectionOptions('<label>')  // also declare idle_timeout\n` +
        `or, for a bespoke case, tag it inline: connection: { application_name: '<label>' }\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * ── URL tracking (EI-19306394439939264, 2026-08-02) ─────────────────────────
 * The THIRD member of the same "silent omission" family, on the same singleton shape.
 *
 * A pool must never outlive the URL that justified it. `connection.ts` learned this
 * (EI-19285027465993737) and fixed it for the MANAGED admin clients by remembering the URL
 * each pool was ACTUALLY BUILT WITH and rebinding through `endStalePool`. The decisive
 * insight: every earlier guard asked *"what SHOULD we connect to?"*, and none asked *"what
 * is the live pool actually bound to?"* — so URL resolution kept returning the right
 * address the whole time the pool served a dead one.
 *
 * A module-level singleton built directly from `postgres(getHarnessAdminUrl(), …)` caches
 * the pool but not the URL, so it can never notice the endpoint moved. That is a live
 * failure mode here: on 2026-08-01 a dead embedded-pg port produced 20,144 ×
 * `ECONNREFUSED 127.0.0.1:20216` over ~2h40m (WI-6739). ⚠ Those particular failures came
 * from the MANAGED `getOrgPg()` path, which is already fixed — the pools guarded here are
 * the half of the class still unguarded, not the proven cause of that outage.
 *
 * The fix for a transactional pool is `getLongLivedAdminPool(label, extra?)`, which
 * re-resolves and rebinds on every use. A compliant file therefore has NO site here at all.
 *
 * ALLOWLIST IS SHRINK-ONLY, and split by WHY — deliberately, so a permanent design
 * exemption is not rationed against a temporary one (the same reasoning as `DarkCase` for
 * dark flags). `listen` entries are permanent; `pending-migration` entries must go to zero.
 * A third test asserts every entry still matches a real site, so migrating a file FAILS
 * until its now-stale entry is deleted — the allowlist cannot quietly outlive its reason.
 */
const LISTEN_EXEMPT: Record<string, string> = {
  // A LISTEN connection carries subscription state a silent rebuild would drop: the caller
  // keeps a live handle that no longer receives notifications — a worse, SILENT failure
  // than the one being fixed. Rebinding these must also re-issue the LISTEN, which belongs
  // with the code owning the subscription.
  'packages/operator-core/lib/agent-activity-bus.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/pg-listen-hub.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/fleet-assignment-bus.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/coord-inbox-bus.ts': 'LISTEN — rebind must re-issue subscription',
  // NOTE: pg-notify-bus.ts and sync-sse.ts also open LISTEN clients from
  // getHarnessAdminUrl(), but neither is in the module-level `let x: T | null = null`
  // singleton shape this guard scans, so neither is a site and neither may be listed here
  // (the shrink-only test rejects an entry matching nothing). If either is ever refactored
  // into that shape, the guard will flag it and it can be added then — which is the
  // self-correcting behaviour we want, not an omission.
};

/** Transactional pools not yet migrated. This map must only ever SHRINK. */
// EMPTY — the transactional migration is complete FOR THE MODULE-LEVEL SINGLETON SHAPE
// THIS MAP IS CHECKED AGAINST (2026-08-02). That qualifier is load-bearing and was added
// by EI-19386584249133403: read as an unqualified "COMPLETE", this comment actively
// discouraged looking for the population it does not cover. It never meant "no unmigrated
// admin pool exists" — only "none in the shape scanned here". The CAPTURED shape is
// scanned separately at the bottom of this file, and its pending bucket is NOT empty.
// All 13 sites in THIS shape now use
// getLongLivedAdminPool: the 4 endpoint-route/routes/admin/llm-tests-*.ts routes, the 4
// llm-testing/{telemetry,ledger,replay,storage}.ts, then dock-layouts.ts,
// llm-testing/promotion/{promote,candidates}.ts, system-health/desktop-perf-runs.ts and
// sync/hyperbee/pg-merge-cursor-store.ts.
//
// Keep this map (do not delete the symbol): it is where a genuinely-not-yet-migrated
// transactional site goes if one is ever introduced. Deleting an entry on migration is
// REQUIRED, not tidiness — the shrink-only test below fails while an entry matches
// nothing, which is what stops an exemption outliving its reason.
const PENDING_MIGRATION: Record<string, string> = {};

const URL_TRACKING_ALLOWLIST = { ...LISTEN_EXEMPT, ...PENDING_MIGRATION };

/**
 * Module-level singleton pools built DIRECTLY from `getHarnessAdminUrl()` — the shape that
 * cannot notice the endpoint moved. Narrower than {@link findSingletonPoolSites} by the
 * URL source: a pool built from a bespoke URL (the watchdog tick-lock) is not admin-pool
 * discovery and is out of scope.
 */
function findUntrackedAdminPoolSites(source: string): { line: number; name: string }[] {
  const lines = source.split('\n');
  return findSingletonPoolSites(source).filter((site) => {
    for (let i = site.line; i < Math.min(lines.length, site.line + 3); i++) {
      if (lines[i].includes('getHarnessAdminUrl(')) return true;
    }
    return false;
  });
}

describe('the URL-tracking guard itself detects an untracked admin pool (non-vacuity)', () => {
  const UNTRACKED = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-pool'),
      max: 4,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });
  }
  return pool;
}`;
  // The migrated shape: no postgres(...) call survives, so there is no site to flag.
  const MIGRATED = `
const db = () => getLongLivedAdminPool('some-pool', { max: 4, prepare: false });`;
  // A singleton built from a BESPOKE url is out of scope — it is not admin discovery.
  const BESPOKE_URL = `
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), { max: 1, idle_timeout: 0 });
  }
  return _tickLockSql;
}`;

  it('flags a singleton admin pool that tracks no URL', () => {
    expect(findUntrackedAdminPoolSites(UNTRACKED)).toHaveLength(1);
  });

  it('finds nothing in a migrated file', () => {
    expect(findUntrackedAdminPoolSites(MIGRATED)).toEqual([]);
  });

  it('ignores a singleton built from a bespoke (non-discovery) URL', () => {
    expect(findUntrackedAdminPoolSites(BESPOKE_URL)).toEqual([]);
  });
});

describe('admin pools track the URL they were built with (EI-19306394439939264)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('the tree scan is wired correctly (test is not vacuously green)', () => {
    // Anchored to the scan finding files at all — NOT to any pool count. An earlier
    // version of this assertion also required `singletons >= 10`, reasoning that the
    // singleton population was "stable" while only the untracked count was being driven
    // to zero. That was wrong: migrating a pool removes its module-level singleton too,
    // so both populations shrink together. Completing the migration on 2026-08-02 landed
    // that count on exactly 10 — the guard was one migration from punishing its own
    // success, the very failure the old comment claimed to have avoided.
    // (The fixture describe above is what proves the detector still fires.)
    expect(files.length).toBeGreaterThan(100);
  });

  it('no NEW singleton admin pool bypasses getLongLivedAdminPool', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (URL_TRACKING_ALLOWLIST[rel]) continue;
      const source = readFileSync(file, 'utf8');
      for (const site of findUntrackedAdminPoolSites(source)) {
        offenders.push(`${rel}:${site.line + 1} (${site.name})`);
      }
    }
    expect(
      offenders,
      `These singleton pools are built directly from getHarnessAdminUrl() and remember no ` +
        `URL, so they can never notice the endpoint moved and will serve a DEAD address ` +
        `until the process restarts (WI-6739: 20,144 ECONNREFUSED over ~2h40m).\n` +
        `  transactional → const db = () => getLongLivedAdminPool('<label>', { max, prepare })\n` +
        `  LISTEN        → add to LISTEN_EXEMPT; a silent rebuild would drop the subscription\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry still matches a real site (allowlist is shrink-only)', () => {
    const stale: string[] = [];
    for (const rel of Object.keys(URL_TRACKING_ALLOWLIST)) {
      const full = join(REPO_ROOT, rel);
      let source: string;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (findUntrackedAdminPoolSites(source).length === 0) stale.push(`${rel} (no untracked pool left)`);
    }
    expect(
      stale,
      `These allowlist entries no longer describe anything — the pool was migrated or the ` +
        `file moved. Delete them; an exemption that outlives its reason silently re-permits ` +
        `the bug it was granted for:\n` + stale.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * WI-37473: no singleton pool is built by a CHECK-THEN-ACT async memo
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Does this file memoize an in-flight build as a PROMISE? That is the canonical fix
 * for the race below (`let x: Promise<T> | null = null`, assigned synchronously), and
 * it is what makes a surviving guard inside the private builder harmless.
 *
 * Why this exemption has to exist: the fix deliberately leaves the cheap
 * `if (memo) return memo;` short-circuit in place inside the builder, so the builder
 * still LOOKS like check-then-act. It is safe because the only caller assigns the
 * promise synchronously and therefore never enters it twice. Without this check the
 * ratchet would red exactly the people who applied the fix correctly — measured on
 * `sync/hyperbee/swarm.ts`, whose post-fix `buildSharedSwarm()` retains that shape.
 */
function memoizesAnInFlightPromise(source: string): boolean {
  return /^let\s+\w+\s*:\s*Promise<[^>]*>\s*\|\s*null\s*=\s*null\s*;/m.test(source);
}

/**
 * WI-37473: find a module-scoped pool memo GUARDED and then ASSIGNED with an `await`
 * in between — the check-then-act race.
 *
 * ```ts
 * let _pgClient: any = null;
 * async function pg() {
 *   if (_pgClient) return _pgClient;          // ← guard
 *   const postgres = (await import('postgres')).default;   // ← await: the window
 *   _pgClient = postgres(url, { ... });       // ← assignment
 * }
 * ```
 *
 * Every caller entering during the await passes the guard and constructs its OWN pool.
 * Only the last assignment is retained, so each loser's pool is unreferenced and never
 * `.end()`-ed, holding its connections until process exit.
 *
 * SCOPE, stated deliberately: this keys on the guard, the await and the assignment
 * sitting in ONE function. It does NOT reason about whether that function can actually
 * be entered concurrently — that needs call-graph analysis. The narrow population here
 * (module-scoped `postgres(...)` memos, 22 sites measured 2026-08-09) is what makes the
 * approximation safe: every member's accessor is called directly from many call sites,
 * so concurrent entry is the default rather than something to prove. Do NOT lift this
 * to a general "any awaited memo" lint on that basis — measured against the whole tree
 * the same shape returns 88 sites, overwhelmingly teardown clears (`x = null`) and
 * already-correct promise memos.
 */
function findRacedPoolMemoSites(source: string): { line: number; name: string }[] {
  if (memoizesAnInFlightPromise(source)) return [];
  const lines = source.split('\n');
  return findSingletonPoolSites(source).filter((site) => {
    // Walk back to the start of the enclosing function.
    let start = 0;
    for (let j = site.line - 1; j >= 0; j--) {
      if (/^(export\s+)?(async\s+)?(function|const|let)\b/.test(lines[j]) || /^\}/.test(lines[j])) {
        start = j;
        break;
      }
    }
    let guard = -1;
    let awaited = -1;
    for (let j = start; j < site.line; j++) {
      if (guard < 0 && new RegExp(`\\bif\\s*\\(\\s*!?\\s*${site.name}\\b`).test(lines[j])) guard = j;
      if (/\bawait\b/.test(lines[j])) awaited = j;
    }
    return guard >= 0 && awaited > guard;
  });
}

describe('the race guard itself detects a check-then-act pool memo (non-vacuity)', () => {
  // Fixtures, never a temporary mutation of a real file: this tree is shared and
  // auto-committed every few minutes (CLAUDE.md, "proving a guard is falsifiable").
  // VERBATIM the real pre-fix accessor from libs/papercusp/plugins/jira-sync/index.ts
  // at be301cf9^ (the last commit before the WI-37473 fix), not a reconstruction — so
  // this control provably reproduces the bug that shipped, and stays a permanent
  // regression witness after the real file is fixed. (The jira-sync plugin itself
  // was later deleted — linear-asana-task-sync-2026-10-05 P-009 — so the commit
  // above is the only place that source survives.)
  const RACED = `
let _pgClient: any = null;
async function pg() {
  if (_pgClient) return _pgClient;
  const postgres = (await import('postgres')).default;
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL ||
    process.env.HARNESS_DATABASE_URL ||
    readDiscoveryUrl('app') ||
    'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
  _pgClient = postgres(url, {
    onnotice: () => {},
    max: 2,
    idle_timeout: 30,
    connection: { application_name: \`pcusp:jira-sync:p\${process.pid}\`.slice(0, 63) },
  });
  return _pgClient;
}`;
  // The WI-37473 fix: the guard-bearing accessor is SYNC and memoizes the promise; the
  // builder holds the await but no guard.
  const FIXED = `
let _pgClient: any = null;
let _pgClientPromise: Promise<any> | null = null;
async function buildPgClient(): Promise<any> {
  const postgres = (await import('postgres')).default;
  _pgClient = postgres(url, { idle_timeout: 30 });
  return _pgClient;
}
function pg(): Promise<any> {
  if (_pgClient) return Promise.resolve(_pgClient);
  if (_pgClientPromise) return _pgClientPromise;
  _pgClientPromise = buildPgClient().catch((err: unknown) => {
    _pgClientPromise = null;
    throw err;
  });
  return _pgClientPromise;
}`;
  // No await between guard and assignment — the classic sync singleton is not this bug.
  const SYNC_SINGLETON = `
let pool: Sql | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { idle_timeout: 30 });
  return pool;
}`;

  it('flags the check-then-act shape', () => {
    const sites = findRacedPoolMemoSites(RACED);
    expect(sites).toHaveLength(1);
    expect(sites[0].name).toBe('_pgClient');
  });

  it('does NOT flag the promise-memo fix (the guard must not punish its own remedy)', () => {
    expect(findRacedPoolMemoSites(FIXED)).toEqual([]);
  });

  it('does NOT flag a synchronous singleton (no await between check and act)', () => {
    expect(findRacedPoolMemoSites(SYNC_SINGLETON)).toEqual([]);
  });
});

describe('no singleton pool is built by a check-then-act async memo (WI-37473)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('the tree scan is wired correctly (test is not vacuously green)', () => {
    // Anchored to the scan, never to a population floor — same reasoning as the two
    // describes above: this population is meant to reach zero and stay there.
    expect(files.length).toBeGreaterThan(100);
  });

  it('no module-scoped pool memo is assigned across an await from its own guard', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of findRacedPoolMemoSites(source)) {
        offenders.push(`${relative(REPO_ROOT, file)}:${site.line + 1} (${site.name})`);
      }
    }
    expect(
      offenders,
      `These pools are built by a check-then-act async memo: an \`await\` sits between the ` +
        `guard that reads the memo and the assignment that fills it, so N concurrent callers ` +
        `construct N pools. Only the last is retained — every loser's pool is unreferenced, ` +
        `never .end()-ed, and holds its connections against Postgres until process exit ` +
        `(WI-37473; jira-sync + linear-sync each had ~20 call sites into one such accessor).\n` +
        `Fix: memoize the PROMISE and assign it SYNCHRONOUSLY, so no await sits between ` +
        `check and set —\n` +
        `  let _xPromise: Promise<T> | null = null;\n` +
        `  function x(): Promise<T> {\n` +
        `    if (_x) return Promise.resolve(_x);\n` +
        `    if (_xPromise) return _xPromise;\n` +
        `    _xPromise = buildX().catch((e) => { _xPromise = null; throw e; });  // sync assign\n` +
        `    return _xPromise;\n` +
        `  }\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * EI-19386584249133403: the CAPTURED shape — the same never-rebinds defect in a pool that
 * is NOT a module-level singleton, and which the scan above cannot see.
 *
 * {@link findSingletonPoolSites} deliberately matches only the column-0
 * `let x: T | null = null` shape, reasoning that a function-scoped client "is always
 * `.end()`-ed on every path ... so it can't accumulate". That reasoning is SOUND for a
 * client that is actually ended — `FUNCTION_SCOPED_NOT_A_SINGLETON` above pins exactly
 * that case and still passes, unchanged, alongside this. It does not hold for a
 * function-scoped pool that is CAPTURED and never ended:
 *
 *     async function buildDeps(slug) {
 *       const sql = postgres(getHarnessAdminUrl(), { max: 2, idle_timeout: 30 });
 *       return { store: createPgReferenceStore({ sql }) };  // captured, never .end()-ed
 *     }
 *
 * Both shapes bind the admin URL ONCE and never re-ask. When embedded-pg dies and
 * `~/.papercusp/embedded-pg.json` goes stale — or is DELETED, which correctly restores the
 * healthy native :5432 — both keep dialling a dead port for the whole process lifetime and
 * only a restart clears it. That is the EI-19383722505382723 incident: deleting the
 * discovery file left the ECONNREFUSED rate completely unchanged, because nothing
 * re-resolved. `sync-resolver/append-heavy-invalidator.ts` was this exact shape, and this
 * file never flagged it while `PENDING_MIGRATION` read `{}` — "the transactional migration
 * is COMPLETE" — which reads as full coverage when it only ever meant "complete for the
 * shape we scan". A blind spot, not a residue.
 *
 * MEASURED before building, not assumed (2026-08-30, whole tree under SCAN_ROOTS): 58
 * function-scoped `postgres(...)` bindings exist; 55 are `.end()`-ed somewhere and are the
 * benign shape the docstring above correctly describes. Only 2 survive this filter. That
 * narrowness is what makes the widening adoptable — a ratchet that flags 58 sites at once
 * is one nobody can land, which is why this was filed rather than done inline.
 *
 * KNOWN LIMIT, stated so it is never mistaken for coverage: the admin-URL test is the same
 * forward-scan-3-lines for `getHarnessAdminUrl(` that {@link findUntrackedAdminPoolSites}
 * uses, so a site that hoists the URL into a local first (`const u = getHarnessAdminUrl();
 * const sql = postgres(u, …)`) is NOT seen. `long-lived-admin-pool.ts` is that shape —
 * correctly out of scope, since it IS the sanctioned accessor and re-resolves on every call.
 */
function findCapturedAdminPoolSites(source: string): { line: number; name: string }[] {
  const lines = source.split('\n');
  // Names the module-level scan already owns — a site must never be reported twice.
  const singletons = new Set<string>();
  for (const line of lines) {
    const m = /^let\s+(\w+)\s*:[^=]*=\s*(?:null|undefined);/.exec(line);
    if (m) singletons.add(m[1]);
  }
  const capturedRe = /^\s+(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:await\s+)?postgres\(/;
  const sites: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    const m = capturedRe.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    if (singletons.has(name)) continue;
    let fromAdminUrl = false;
    for (let j = i; j < Math.min(lines.length, i + 3); j++) {
      if (lines[j].includes('getHarnessAdminUrl(')) fromAdminUrl = true;
    }
    if (!fromAdminUrl) continue;
    // Conservative by construction: ANY `.end()` on this name anywhere in the file clears
    // the site. A file that ends one pool and leaks another is a false NEGATIVE — the
    // acceptable side. A ratchet's false POSITIVES are what red a shared gate and stop it
    // landing at all, so they are the error worth spending precision to avoid.
    if (new RegExp(`\\b${name}\\s*\\.end\\(`).test(source)) continue;
    sites.push({ line: i, name });
  }
  return sites;
}

/**
 * Captured admin pools whose shape is PERMANENTLY fine — same split-by-WHY discipline as
 * {@link LISTEN_EXEMPT}: a permanent design exemption must not be rationed against a
 * temporary one, so it does not share a map with the pending bucket below.
 */
const SHORT_LIVED_EXEMPT: Record<string, string> = {
  // A CLI batch process: the pool dies with the command, so "the endpoint moved while I
  // held it" has no window to occur in. The file already documents the deliberate
  // direct-connect (a multi-minute snapshot should not occupy a pooler slot the live
  // operator needs), which is a different and still-valid reason to bypass the accessor.
  'packages/operator-core/lib/memory/bench/prose-corpus-snapshot.ts':
    'short-lived CLI batch — pool dies with the process, no rebind window',
};

/**
 * Captured transactional pools not yet migrated. This map must only ever SHRINK.
 *
 * Deliberately SEPARATE from {@link PENDING_MIGRATION}: that map is checked against
 * module-level singleton sites, so an entry naming a captured site would match nothing
 * there and trip its own shrink-only test.
 */
// EMPTY, and that is the point: every captured transactional pool has been migrated.
// design-compare/host-install.ts was the last entry and was migrated by WI-1202547 —
// `PgReferenceStoreOptions` now takes `getSql: () => SqlTag` and buildDeps passes
// `() => getLongLivedAdminPool('design-compare', { max: 2 })`, so no `postgres(...)`
// call survives there for the scan to flag.
//
// The exemption was removed rather than kept green, which is the contract this map
// declares: shrink-only, and it cannot outlive its reason.
const CAPTURED_PENDING_MIGRATION: Record<string, string> = {};

const CAPTURED_ALLOWLIST = { ...SHORT_LIVED_EXEMPT, ...CAPTURED_PENDING_MIGRATION };

describe('the captured-pool guard itself detects the shape (non-vacuity)', () => {
  // Fixtures, never a temporary mutation of a real file: this tree is shared and
  // auto-committed every few minutes (CLAUDE.md, "proving a guard is falsifiable").
  // VERBATIM the real pre-fix shape from design-compare/host-install.ts.
  const CAPTURED_LEAK = `
async function buildDeps(harnessSlug: string): Promise<VerbDeps> {
  const postgres = (await import('postgres')).default;
  const sql = postgres(getHarnessAdminUrl(), { max: 2, idle_timeout: 30 });
  return {
    store: createPgReferenceStore({ sql: sql as unknown as SqlTag }),
  };
}`;
  // The benign shape the module-level scan's docstring describes: ended on every path.
  const ENDED_IN_SCOPE = `
async function run() {
  const sql = postgres(getHarnessAdminUrl(), { max: 4 });
  try {
    await sql\`SELECT 1\`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}`;
  // The migrated shape: no postgres(...) call survives, so there is no site to flag.
  const MIGRATED_CAPTURED = `
async function buildDeps(harnessSlug: string): Promise<VerbDeps> {
  const db = () => getLongLivedAdminPool('design-compare', { max: 2 });
  return { store: createPgReferenceStore({ getSql: db }) };
}`;
  // Not admin-pool discovery — a bespoke URL is out of scope, same as the scan above.
  const BESPOKE_URL = `
async function run() {
  const sql = postgres(someOtherUrl, { max: 1 });
  return sql;
}`;

  it('flags a captured pool that is never .end()-ed', () => {
    const sites = findCapturedAdminPoolSites(CAPTURED_LEAK);
    expect(sites).toHaveLength(1);
    expect(sites[0].name).toBe('sql');
  });

  it('ignores a function-scoped client that IS .end()-ed — the benign shape', () => {
    expect(findCapturedAdminPoolSites(ENDED_IN_SCOPE)).toEqual([]);
  });

  it('ignores the migrated shape (no postgres(...) call survives)', () => {
    expect(findCapturedAdminPoolSites(MIGRATED_CAPTURED)).toEqual([]);
  });

  it('ignores a pool built from a bespoke URL — not admin-pool discovery', () => {
    expect(findCapturedAdminPoolSites(BESPOKE_URL)).toEqual([]);
  });

  it('does not double-report a module-level singleton the other scan already owns', () => {
    // `pool` is declared column-0, so findSingletonPoolSites owns it; the indented
    // assignment inside the accessor must not also surface here.
    const SINGLETON = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), { max: 4 });
  }
  return pool;
}`;
    expect(findCapturedAdminPoolSites(SINGLETON)).toEqual([]);
  });
});

describe('captured admin pools are allowlisted with a reason (EI-19386584249133403)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('the tree scan is wired correctly (test is not vacuously green)', () => {
    // Anchored to the SCAN, never to the size of the guarded population — that population
    // shrinks to zero as sites migrate, so a `>= N` floor would red the gate for whoever
    // finishes the job. Detector correctness is proven by the fixtures above instead.
    expect(files.length).toBeGreaterThan(100);
  });

  it('every captured admin-pool site is allowlisted', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (rel in CAPTURED_ALLOWLIST) continue;
      const source = readFileSync(file, 'utf8');
      for (const site of findCapturedAdminPoolSites(source)) {
        offenders.push(`${rel}:${site.line + 1} (${site.name})`);
      }
    }
    expect(
      offenders,
      `These pools bind getHarnessAdminUrl() ONCE inside a function and are never ` +
        `.end()-ed, so the handle is captured for the process lifetime and CANNOT notice ` +
        `the endpoint moved. When embedded-pg dies and its discovery file goes stale — or ` +
        `is deleted, correctly restoring the native :5432 — they keep dialling a dead port ` +
        `until the service restarts (EI-19383722505382723, measured twice).\n` +
        `  LONG-LIVED    → route through getLongLivedAdminPool, which re-resolves per call\n` +
        `  SHORT-LIVED   → add to SHORT_LIVED_EXEMPT; a process-lifetime pool has no window\n` +
        `  NOT YET       → add to CAPTURED_PENDING_MIGRATION (shrink-only) with the reason\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('every captured-allowlist entry still matches a real site (shrink-only)', () => {
    // The entry cannot outlive its reason: migrating a file FAILS here until its now-stale
    // entry is deleted. Same discipline as the module-level allowlist above.
    const stale: string[] = [];
    for (const rel of Object.keys(CAPTURED_ALLOWLIST)) {
      const abs = join(REPO_ROOT, rel);
      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (findCapturedAdminPoolSites(source).length === 0) {
        stale.push(`${rel} (no captured admin-pool site remains)`);
      }
    }
    expect(
      stale,
      `These captured-pool allowlist entries no longer match a real site. An exemption ` +
        `must not outlive its reason — delete the entry:\n` +
        stale.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([]);
  });
});
