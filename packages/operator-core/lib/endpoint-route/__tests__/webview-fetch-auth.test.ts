/**
 * Recurrence guard for the "silently 403-blanked pane" class (WI-6475 / EI-338).
 *
 * THE BUG THIS CATCHES
 * --------------------
 * A UI component reads an API route with a bare `fetch`. In a browser that is fine.
 * In the DESKTOP webview — the only shipping target — a native fetch does not ride
 * the sys:http IPC bridge that injects the loopback-superuser bearer, so the request
 * resolves `unverified-loopback`. A route gated VT (`{trust:['verified','trusted']}`)
 * then refuses it with 403 and the pane renders empty or "Load failed: HTTP 403".
 *
 * This is invisible to every other check we run: vitest never renders against a real
 * auth stack, tsc cannot see it, and the component looks correct in review. It is
 * only ever found by a human opening the pane — which is how it was found this time
 * (the owner reported it on the new Tasks pane), and how the four panes listed in
 * BASELINE below stayed broken without anyone noticing.
 *
 * `auth-posture.test.ts` documents the mechanism (lines 23-35) but pins only the
 * ROUTE side of it. Nothing connected the route's tier to the CALLERS that depend on
 * it. That gap is what this file closes.
 *
 * THE TWO CORRECT FIXES
 * ---------------------
 *  (a) Read through the sync layer (`useSyncQuery`). Its transport
 *      (`/zero-harness/rest-query`) is `auth:'loopback'`, so it is admitted — and it
 *      is what CLAUDE.md mandates for query data anyway ("never hand-roll fetch +
 *      setInterval"). Preferred for anything that is a data read.
 *  (b) Widen the route to VTL (`+ 'unverified-loopback'`) where the read is genuinely
 *      public-to-the-box, the precedent the deploy-accounts family already sets,
 *      backstopped by the CSRF origin guard on mutating handlers.
 *
 * BASELINE IS SHRINK-ONLY. Fix a pane, delete its line. Never append.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALL_ROUTES } from '../routes';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';

/** UI trees whose components run inside the desktop webview. */
const UI_ROOTS = ['apps/operator/app', 'apps/operator-vite/src'];

/**
 * Known-broken call sites, as `<repo-relative file> :: <api path>`.
 *
 * Each of these was MEASURED returning 403 in the owner's live Tauri shell on
 * 2026-07-27 (EI-18834967602055309). They are grandfathered so this guard can land
 * without a same-change sweep of four unrelated panes — but the set may only shrink.
 */
const BASELINE: ReadonlySet<string> = new Set([
  // ── Admin panes. Sampled live: all 403. ──
  // Fixed 2026-08-01 (EI-18834967602055309): commands.ts, tables.ts, tables-by-name.ts,
  // dev/table-schema.ts, dbos-status.ts, schedules-inventory.ts widened to admit
  // 'unverified-loopback' (+ CSRF guard on the mutating tables-by-name verbs).
  // plans-api.ts :: /api/admin/inbox/triage — fixed 2026-10-13 (WI-6554700010009809):
  // admin/inbox.ts widened to admit 'unverified-loopback' + requireAllowedOriginOr403,
  // which also fixed settings/autonomy/page.tsx's automation-policy POST.
  // The two /api/admin/coordination entries were removed 2026-07-27 (WI-6501): the
  // shrink-only check flagged them stale because WI-6486 had already widened that
  // proxy to VTL for the HUD conversation pane. Fixing the route fixed its callers.

  // ── The whole admin TESTING pane. /api/admin/testing/memory/health measured 403. ──
  'apps/operator/app/admin/testing/_components/DesktopPerfTrendPanel.tsx :: /api/admin/testing/desktop-perf-trend',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/memory/checks',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/memory/health',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/memory/preflight',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/memory/probe',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/test-runs',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/test-runs/:param',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx :: /api/admin/testing/test-runs/:param/cancel',
  // PackagedBuildTab.tsx :: /api/admin/commands — fixed alongside AdminOps.tsx's
  // identical route above (commands.ts widened 2026-08-01, EI-18834967602055309).
  'apps/operator/app/admin/testing/_components/TestRunsTab.tsx :: /api/admin/testing/test-runs',
  'apps/operator/app/admin/testing/_components/TestRunsTab.tsx :: /api/admin/testing/test-runs/:param',
  'apps/operator/app/admin/testing/_components/TestRunsTab.tsx :: /api/admin/testing/test-runs/:param/cancel',

  // ── The /dev tools tabs. /api/dev/tables + /api/dev/route-invocations measured 403. ──
  'apps/operator/app/dev/_components/ProcessesTab.tsx :: /api/dev/processes/kill',
  'apps/operator/app/dev/_components/RoutesTab.tsx :: /api/dev/route-invocations',
  'apps/operator/app/dev/_components/SqlTab.tsx :: /api/dev/sql',
  'apps/operator/app/dev/_components/StudioTab.tsx :: /api/dev/drizzle-studio',
  'apps/operator/app/dev/_components/TablesTab.tsx :: /api/dev/tables',
  // TablesTab.tsx :: /api/dev/tables/:param — fixed alongside TableAdmin.tsx's
  // identical route above (dev/table-schema.ts widened 2026-08-01, EI-18834967602055309).
  'apps/operator/app/dev/_components/TablesTab.tsx :: /api/dev/tables/:param/rows',

  // ── First-run / onboarding surfaces. /api/provision/state measured 403. These are the
  //    most costly of the set: they are what a NEW user meets first. ──
  'apps/operator/app/_components/HostCheckBanner.tsx :: /api/provision/host-check',
  'apps/operator/app/settings/plugins/ProvisionPanel.tsx :: /api/provision/run',
  'apps/operator/app/settings/plugins/ProvisionPanel.tsx :: /api/provision/state',
  'apps/operator/app/settings/plugins/page.tsx :: /api/oauth/verify-paste',
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '_retired' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

/**
 * Literal `fetch('/api/...')` call sites, normalised to a comparable path.
 *
 * The two interpolation shapes mean DIFFERENT things and must not be conflated:
 *   `/api/admin/tables/${name}`      — its own path SEGMENT  -> `/api/admin/tables/:param`
 *   `/api/admin/schedules/inventory${qs}` — a glued QUERY suffix -> path is unchanged
 * Treating the second as a segment (the first cut of this file did) invents a path
 * that matches no route, so a real violation silently reads as "no route found" and
 * is skipped. Anything after a literal `?` is likewise query, not path.
 */
function normalisePath(raw: string): string {
  return (
    raw
      // A trailing interpolation NOT preceded by `/` is a query-string suffix.
      .replace(/(?<!\/)\$\{[^}]*\}$/, '')
      .split('?')[0]
      // What remains is a genuine dynamic path segment.
      .replace(/\$\{[^}]*\}/g, ':param')
      .replace(/\/$/, '')
  );
}

/**
 * Module-level `const NAME = '/api/...'` base constants, so a fetch built from one
 * is still attributable to a route.
 *
 * WI-6501 — this is the hole the first cut of this guard left open, and it cost the
 * owner a dead plans sidebar. `plans-api.ts` does NOT contain a literal
 * `fetch('/api/admin/plans/...')`; it declares `const BASE = '/api/admin/plans'` and
 * every one of its ~30 verbs goes through two helpers that fetch `${BASE}/${verb}`.
 * The literal-only regex saw none of it, so the file's only flagged entries were the
 * two unrelated literal fetches that happen to live in it — the guard reported on the
 * file while missing its entire primary surface. A guard with a hole shaped like the
 * most common way to write an API client is worse than none: the baseline LOOKED like
 * a complete inventory of the 403 class.
 */
function findBaseConsts(src: string): Map<string, string> {
  const bases = new Map<string, string>();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[`'"](\/api\/[^`'"$]*)[`'"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) bases.set(m[1], m[2].replace(/\/$/, ''));
  return bases;
}

/** Literal `fetch('/api/...')` call sites, plus base-const-built ones. */
function findFetchPaths(src: string): string[] {
  const found: string[] = [];

  const re = /fetch\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) found.push(normalisePath(m[1]));

  // `fetch(`${BASE}/${verb}`)` and the `new URL(`${BASE}/${verb}`, …)` +
  // `fetch(url.toString())` shape — both resolve to `<base>/:param`.
  const bases = findBaseConsts(src);
  for (const [name, base] of bases) {
    const built = new RegExp(String.raw`[\`'"]?\$\{${name}\}([^\`'"]*)`, 'g');
    let b: RegExpExecArray | null;
    while ((b = built.exec(src))) found.push(normalisePath(base + b[1]));
  }

  return found;
}

/** Does this route's auth admit a cookie-less, bearer-less webview fetch? */
function admitsUnverifiedLoopback(auth: unknown): boolean {
  if (auth === 'public' || auth === 'loopback') return true;
  if (!auth || typeof auth !== 'object') return true; // `auth: {}` — any caller
  const trust = (auth as { trust?: readonly string[] }).trust;
  if (!trust || trust.length === 0) return true;
  return trust.includes('unverified-loopback');
}

/** Match a fetched path against a declared route path (`:id` segments are wild). */
function routeMatches(routePath: string, fetched: string): boolean {
  const r = routePath.split('/').filter(Boolean);
  const f = fetched.replace(/^\/api/, '').split('/').filter(Boolean);
  if (r.length !== f.length) return false;
  return r.every((seg, i) => seg.startsWith(':') || f[i] === ':param' || seg === f[i]);
}

describe('desktop webview fetches must target routes that admit unverified-loopback', () => {
  it('no UI component bare-fetches a VT-gated route', () => {
    const violations: string[] = [];

    for (const root of UI_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        const src = readFileSync(file, 'utf8');
        for (const fetched of findFetchPaths(src)) {
          const route = ALL_ROUTES.find((r) => routeMatches(r.path, fetched));
          // An unmatched path is not this guard's business — it may be a Vite proxy,
          // a sidecar route, or a genuine 404 that other tests own.
          if (!route) continue;
          if (admitsUnverifiedLoopback(route.auth)) continue;
          const key = `${rel} :: ${fetched}`;
          if (!BASELINE.has(key)) violations.push(key);
        }
      }
    }

    expect(
      violations,
      violations.length
        ? `\nThese UI call sites will 403 in the desktop webview (the only shipping target).\n` +
            `A native fetch resolves 'unverified-loopback' and a VT-gated route refuses it.\n` +
            `Fix by reading through useSyncQuery (preferred), or widen the route to VTL.\n` +
            `See this file's header for the full rationale.\n\n  ` +
            violations.join('\n  ') +
            '\n'
        : '',
    ).toEqual([]);
  });

  it('the baseline only shrinks — every grandfathered entry is still a real violation', () => {
    // A stale baseline entry means someone fixed a pane without deleting its line,
    // which would silently re-admit the next regression at that path.
    const stale: string[] = [];
    for (const key of BASELINE) {
      const [rel, fetched] = key.split(' :: ');
      let src: string;
      try {
        src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        stale.push(`${key}  (file no longer exists)`);
        continue;
      }
      const stillFetches = findFetchPaths(src).includes(fetched);
      const route = ALL_ROUTES.find((r) => routeMatches(r.path, fetched));
      const stillGated = route ? !admitsUnverifiedLoopback(route.auth) : false;
      if (!stillFetches || !stillGated) stale.push(`${key}  (fixed — delete this line)`);
    }
    expect(stale, `Stale BASELINE entries in ${__filename}:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
