/**
 * P-014 (work-item-dependency-edges-2026-08-02) — the recurrence guard for D-007.
 *
 * WHAT WENT WRONG, so the assertions below read as consequences rather than trivia.
 * The dependency-blocking floor was written inline at each claim door instead of being
 * called from one place. Over time one copy — `ok_no_blocker` in scheduler/get-next.ts —
 * drifted: it kept the `bi.workspace_id = 'default'` hardcode that migration 719 removed
 * from every other reader, and it left the feature leg unscoped entirely. It was the ONLY
 * floor in that subquery not calling a shared helper, which is precisely why it drifted
 * invisibly while its ten siblings stayed correct.
 *
 * The cost was not theoretical. That subquery backs `work_items:claimable`, so measured on
 * live data across the 10 open issue-family papercusp-workspace items carrying an edge, the
 * preview reported 0 blocked against the real claim path's 5. The queue advertised five
 * items the claim door refuses: an agent claims, is rejected, and burns the wake.
 *
 * The P-012 audit that caught it is a point-in-time snapshot and will rot. These tests are
 * the part that does not rot.
 *
 * SCOPE — deliberately SELF-SELECT ONLY (D-008). Readiness floors (terminal-state, cooldown,
 * claim-hold, needs-human, dependency-blocking) gate opportunistic self-selection; the
 * by-id claim (claimWorkItem / claimIssue) is the deliberate operator override, because
 * taking a blocked or finished item by name is how you reopen it, inherit ownership, or
 * attach follow-up work (tested escape hatch, EI-8972). Security/admission floors
 * (autoPickableWhereSql) are the ones that hold at every door. So this file must NOT assert
 * a blocking floor on the by-id path — doing so would encode the wrong invariant and fail
 * correct code.
 *
 * These are source-level assertions on purpose: they need no database, they run in
 * milliseconds, and — unlike a behavioural test — they fail on a NEW door that inlines its
 * own copy, which is the actual failure mode observed here.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const LIB_ROOT = resolve(__dirname, '..');

/**
 * The ONLY modules permitted to write a `dep_type = 'blocks'` SQL predicate.
 *
 * Adding a file here is a deliberate act: it means you have introduced a second definition
 * of the blocking floor, and you own keeping it in agreement with the others. Prefer
 * calling `depsBlockedExclusionSql` (issue family) or `claimFloorsWhereSql` (feature
 * family) instead — that is the whole point of the extraction this test guards.
 */
const BLOCKING_PREDICATE_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'work-items.ts',
    'Holds BOTH canonical definitions: claimFloorsWhereSql (FEATURE family — harness-qualified ' +
      'blocked_ref, or the maintained work_item_blocked sidecar) and depsBlockedExclusionSql ' +
      '(ISSUE family — bare blocked_ref). The two families genuinely differ; see D-007.',
  ],
  [
    'dbos/work-item-deps-store.ts',
    'The edge STORE — writes and lists edges (setFeatureBlockedBy et al). Not a claim floor: ' +
      'it never decides claimability, so it cannot drift away from one.',
  ],
  [
    'scheduler/work-item-deps-integrity.ts',
    'The endpoint-integrity DETECTOR (D-017 step 2) — enumerates EVERY blocks edge, both ' +
      'sides, to find kind/form/resolution defects. Not a claim floor: it reports edges, ' +
      'never decides claimability, so it cannot drift away from one. Its predicate is an ' +
      'enumeration filter; the shared floor helpers are exclusion fragments and cannot ' +
      'express it.',
  ],
  [
    'sync-resolver/dependency-graph-edges.ts',
    'The dependency-GRAPH read (sync resolver) — enumerates blocks edges with BOTH endpoints ' +
      'resolved so the graph/integrity view can render them. Same rationale as ' +
      'scheduler/work-item-deps-integrity.ts above: it reports edges and never decides ' +
      'claimability, so it cannot drift away from a claim floor. It structurally CANNOT call ' +
      'the shared helpers — those are exclusion fragments (they remove blocked rows from a ' +
      'claim query), whereas this needs the edge rows themselves, and deliberately LEFT JOINs ' +
      'the blocker so a dangling edge is rendered as a finding rather than dropped. Its ' +
      'blocker leg is parameterised (bk.workspace_id = opts.workspaceId), so the migration-719 ' +
      'hardcode defect this file also guards against does not apply.',
  ],
  [
    'deferral-interest/store.ts',
    'The deferral-interest edge read — samples canonical blocks edges for pricing-model training ' +
      'and never decides claimability. It cannot call the shared exclusion helpers because it ' +
      'needs timestamped edge rows rather than a claim-query predicate.',
  ],
  [
    'agent-tools/plans/with-plan-lock.ts',
    'The plan-dependency edge RECONCILER — reads the existing blocks edges whose blocked endpoint ' +
      'is one of the plan\'s items, to diff them against the plan-declared blockedBy and emit edge ' +
      'mutations inside the plan lock. An edge enumeration keyed by endpoint, never a claim floor.',
  ],
  [
    'issue-blocks-merge.ts',
    'The plan/feature issue-block overlay read — reports open issue blocks to plan readers and ' +
      'never decides work-item claimability. Its join is intentionally an edge enumeration, ' +
      'not a self-select exclusion floor.',
  ],
  [
    'pot/placement-watchdog.ts',
    'The retired-pot placement watchdog read — counts downstream feature edges for placement ' +
      'reconciliation and wake decisions, not scheduler self-selection. It needs edge rows and ' +
      'therefore cannot use the shared exclusion fragment.',
  ],
  [
    'pilot-materialization-core.ts',
    'The directed-pair cohort transaction validates an exact frozen set across BOTH issue- and ' +
      'feature-family ref shapes immediately before an all-or-nothing write. The shared claim ' +
      'helpers are family-specific exclusion fragments over a scheduler alias and cannot return ' +
      'the blocker ids this cross-family CAS precondition must name; behavioural tests pin the ' +
      'same blocker vocabulary on preview and confirm.',
  ],
  [
    'dependency-traversal.ts',
    'The cross-store dependency graph read — enumerates blocks edges for traversal and rendering, '
      + 'never decides claimability. It needs the edge rows themselves, so the shared exclusion '
      + 'fragment is not an equivalent query.',
  ],
]);

/** Files whose `lane`/DDL text mentions the table but which are fixtures, not live readers. */
const SCAN_SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SCAN_SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.integration.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip lines that are purely commentary — SQL (`--`), line (`//`) and block (`*`) comments.
 *
 * This matters more than it looks. Both canonical helpers DOCUMENT the old hardcode in prose
 * ("it kept bi.workspace_id = 'default' ..."), so a naive scan flags the very comments that
 * explain the bug — a guard that punishes documenting the defect it guards against would get
 * deleted rather than obeyed.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('--') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function relLib(file: string): string {
  return relative(LIB_ROOT, file).split(sep).join('/');
}

const SOURCE_FILES = collectSourceFiles(LIB_ROOT);

// @covers INV-11
// STATIC: no live reader hardcodes a blocker-leg workspace (the migration-719 defect).
// The behavioural tenancy sweep is P-006, over a non-'default' tenant.
describe('dependency-blocking floor has ONE definition per family (P-014 / D-007 guard)', () => {
  it('scans a non-trivial number of source files (guards against a broken walker silently passing)', () => {
    // A guard whose scan set is empty passes every assertion below while checking nothing —
    // the same "well-formed, plausible, wrong" shape that produced D-007's bad measurement.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('no module outside the allowlist writes a dep_type=blocks predicate', () => {
    const offenders: string[] = [];

    for (const file of SOURCE_FILES) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      if (!/dep_type\s*=\s*'blocks'/.test(code)) continue;
      const rel = relLib(file);
      if (!BLOCKING_PREDICATE_ALLOWLIST.has(rel)) offenders.push(rel);
    }

    expect(
      offenders,
      'These modules write their own work_item_deps blocking predicate instead of calling the ' +
        'shared helper. That is exactly how scheduler/get-next.ts drifted for months (D-007): ' +
        'a second copy kept a stale workspace hardcode and the claimability PREVIEW silently ' +
        'stopped agreeing with the real claim. Call depsBlockedExclusionSql (issue family) or ' +
        'claimFloorsWhereSql (feature family) instead. If a genuinely new definition is ' +
        'unavoidable, add it to BLOCKING_PREDICATE_ALLOWLIST with a reason.',
    ).toEqual([]);
  });

  it('no live reader hardcodes a BLOCKER-leg workspace (the exact migration-719 defect)', () => {
    // The blocker legs must resolve in the BLOCKED row's own workspace (wi.workspace_id).
    // Pinning them to a literal is what made every issue-family blocking edge inert: the
    // blocker was never found, "an absent blocker never blocks" applied, and the floor
    // passed everything. Note this is the BLOCKER alias only (bf./bi.) — `d.workspace_id`
    // is legitimately pinned to the coordination workspace the edge table is keyed in, and
    // scoping THAT to the item's workspace would match zero edges and disable blocking.
    const offenders: string[] = [];

    for (const file of SOURCE_FILES) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      const hit = code.match(/\bb[fi]\.workspace_id\s*=\s*'[^']*'/);
      if (hit) offenders.push(`${relLib(file)}: ${hit[0]}`);
    }

    expect(
      offenders,
      'A blocker-leg workspace is pinned to a literal. Both legs must scope to the blocked ' +
        "row's own workspace (bf.workspace_id = wi.workspace_id). The hardcoded form is the " +
        'migration-719 bug: it silently reports "not blocked" rather than erroring, so it ' +
        'reads as healthy while the scheduler hands out blocked work.',
    ).toEqual([]);
  });
});

// @covers INV-06
// A STATIC proof: it shows every self-select door CALLS the one floor helper. The
// behavioural half of INV-06 lives in claim-respects-blocking.integration.test.ts.
describe('every SELF-SELECT claim door routes through the shared floor (P-014 / D-008)', () => {
  const getNext = readFileSync(join(LIB_ROOT, 'scheduler', 'get-next.ts'), 'utf8');
  const workItems = readFileSync(join(LIB_ROOT, 'work-items.ts'), 'utf8');

  it("get-next.ts's issue candidate subquery calls depsBlockedExclusionSql", () => {
    // This subquery is the shared FROM-source behind work_items:claimable and
    // excludedBreakdown — the surface that TELLS agents what they may claim. When it
    // disagreed with the claim door, agents were handed items the door then refused.
    expect(
      getNext.includes('depsBlockedExclusionSql'),
      'scheduler/get-next.ts no longer routes its ok_no_blocker floor through the shared ' +
        'helper. Every sibling floor in that subquery is a helper call; this one drifted ' +
        'precisely because it was not (D-007).',
    ).toBe(true);
  });

  it('the ok_no_blocker floor is a helper call, not an inline NOT EXISTS', () => {
    const okNoBlocker = getNext.match(/\(\$\{[^}]*\}\)\s*AS ok_no_blocker/);
    expect(
      okNoBlocker,
      'ok_no_blocker is no longer a single interpolated fragment. If it has been expanded ' +
        'back into inline SQL, the drift D-007 documents can recur silently.',
    ).not.toBeNull();
  });

  it('work-items.ts exports the issue-family floor for other doors to reuse', () => {
    expect(workItems).toMatch(/export function depsBlockedExclusionSql\s*\(/);
  });

  it('both issue-family self-select paths (the claim AND the READY diagnosis) call it', () => {
    // The READY diagnosis must apply exactly what the claim enforces, otherwise the miss
    // diagnosis disagrees with what claim_next actually serves — the same class of
    // split-brain, just pointed the other way.
    const calls = workItems.match(/\$\{depsBlockedExclusionSql\((?:sql|tx)\)\}/g) ?? [];
    expect(
      calls.length,
      'Expected the issue-family CLAIM path and the READY diagnosis to both call ' +
        'depsBlockedExclusionSql. If one stopped, the claimability diagnosis and the claim ' +
        'itself can once again disagree.',
    ).toBeGreaterThanOrEqual(2);
  });

  it('does NOT require the floor on the by-id claim path (D-008 — readiness gates self-select only)', () => {
    // Documents the boundary as an executable assertion so a future agent does not "fix"
    // the by-id path into enforcing blocking. claimWorkItem deliberately applies only the
    // SECURITY/admission floor; taking a blocked item by name is how an operator takes
    // ownership in order to unblock it.
    const claimById = workItems.slice(workItems.indexOf('export async function claimWorkItem('));
    const body = claimById.slice(0, claimById.indexOf('\nexport '));
    expect(
      body.includes('autoPickableWhereSql'),
      'claimWorkItem must keep enforcing the G2 admission/trust floor — security floors hold ' +
        'at EVERY door, unlike readiness floors.',
    ).toBe(true);
    expect(
      /dep_type\s*=\s*'blocks'/.test(withoutComments(body)),
      'claimWorkItem must NOT enforce dependency-blocking. Readiness floors gate self-select ' +
        'only; the by-id claim is the deliberate operator override (EI-8972). Adding the floor ' +
        'here would break reopen/inherit/attach-follow-up.',
    ).toBe(false);
  });
});
