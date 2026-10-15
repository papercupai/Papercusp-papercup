/**
 * goal-package-bundle-integrity — the guard for WI-41126 (plan
 * work-on-everything-goal-2026-08-23, P-007).
 *
 * The bundled first-party `goal-packages/work-on-everything` package is the
 * BUNDLED FLOOR for the standing stewardship goal: every release ships it
 * (build-desktop-sidecar.sh stages repo-root goal-packages/ → sidecar/goal-packages;
 * Tauri main.rs passes PAPERCUSP_GOAL_PACKAGES_DIR), and a dev checkout resolves
 * it via goal-package-store's in-repo fallback. Nothing else asserts the package
 * stays RESOLVABLE and CORRECT, so this file does — through the REAL store reader
 * (readGoalPackageDir is strict: a malformed field refuses the dir, so "it
 * resolves" doubles as the goal.json parse check — the body is a long JSON string
 * with \n escapes, exactly the shape a hand edit breaks first).
 *
 * WHAT IT PINS:
 *  1. The bundled layer resolves ref `work-on-everything` with the standing-goal
 *     defaults intact (standing:true, a positive trailing budget window — the
 *     P-001/P-004 semantics a silent field drop would erase).
 *  2. The body carries the Blender-steward marker, IMPORTED from
 *     scout/nudge-recipient (the code truth) — never a copyable literal that
 *     could drift from what readBlenderGoalIds actually matches (P-013 seam).
 *  3. requires_rubrics declares `goal-mode-e2e` (the P-007 rubric dependency).
 *  4. Every bundled ref/title is prod-hygiene clean (CUPBOARD_TEST_ROW_PATTERN)
 *     so the package can never become purgeable junk under the cupboard hygiene
 *     sweep.
 *  5. IF a built sidecar mirror exists at papercusp-desktop/src-tauri/sidecar/
 *     goal-packages (A1 stages it at build time; a clean checkout has none), it
 *     is byte-identical to canonical IN BOTH DIRECTIONS — the mirror-drift class
 *     of EI-21124682423594284.
 *
 * Falsifiability: the drift check asserts an EMPTY array, and the resolution
 * check could go vacuous if the reader broke, so both are exercised against
 * deliberately-broken FIXTURES in os.tmpdir() below — never by mutating the
 * shared checkout (git-sync commits the whole tree on a schedule; CLAUDE.md,
 * "Proving a guard is falsifiable").
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLocalGoalPackages, type LocalGoalPackage } from './goal-package-store';
import { CUPBOARD_TEST_ROW_PATTERN } from './prod-hygiene';
import { BLENDER_GOAL_BODY_MARKER } from '../scout/nudge-recipient';
import {
  PLAN_REF_LIST_DATATYPE,
  planRefListPayloadSchema,
} from '../goals/package-property-datatypes';
import { checkAgainstJsonSchema } from '../json-schema-validation';

/** Repo root: walk up from this file until the root package.json (the one with `workspaces`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('goal-package-bundle-integrity: could not locate the monorepo root');
}

const ROOT = repoRoot();
const CANONICAL_DIR = join(ROOT, 'goal-packages');
const SIDECAR_MIRROR_DIR = join(ROOT, 'papercusp-desktop', 'src-tauri', 'sidecar', 'goal-packages');

/** Every file under `dir`, relative to `base`. Skips node_modules and dot-dirs. */
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * Mirror drift between the canonical goal-packages dir and a staged sidecar
 * mirror, IN BOTH DIRECTIONS (a canonical file the mirror never received breaks
 * a user exactly as hard as a mirror file that drifted). Pure so the fixture
 * suite below can prove it fires. An ABSENT mirror is not drift: A1 stages it
 * at build time only, so a clean checkout legitimately has none.
 */
export function findGoalPackageMirrorDrift(canonicalDir: string, mirrorDir: string): string[] {
  const drift: string[] = [];
  if (!existsSync(mirrorDir)) return drift;
  if (!existsSync(canonicalDir)) {
    drift.push(`mirror exists at ${mirrorDir} but the canonical dir ${canonicalDir} is missing`);
    return drift;
  }
  const canonical = filesUnder(canonicalDir);
  const mirrored = filesUnder(mirrorDir);
  for (const rel of mirrored) {
    const c = join(canonicalDir, rel);
    if (!existsSync(c)) {
      drift.push(`${rel} exists in the sidecar mirror but not in canonical goal-packages/`);
      continue;
    }
    if (readFileSync(join(mirrorDir, rel), 'utf8') !== readFileSync(c, 'utf8')) {
      drift.push(`${rel} differs between the sidecar mirror and canonical goal-packages/`);
    }
  }
  for (const rel of canonical) {
    if (!existsSync(join(mirrorDir, rel))) {
      drift.push(`${rel} is in canonical goal-packages/ but missing from the sidecar mirror`);
    }
  }
  return drift;
}

/** The bundled layer as the store resolves it, pinned to the REAL repo dir so the
 *  test is PAPERCUSP_HOME- and env-independent. */
function bundledPackages(): LocalGoalPackage[] {
  return listLocalGoalPackages([{ dir: CANONICAL_DIR, layer: 'bundled' }]);
}

function workOnEverything(): LocalGoalPackage {
  const woe = bundledPackages().find((p) => p.ref === 'work-on-everything');
  expect(
    woe,
    'work-on-everything must resolve from the real bundled layer — a strict-reader ' +
      'refusal (malformed goal.json field, non-string body) lands here as undefined',
  ).toBeDefined();
  return woe!;
}

describe('goal-package bundle integrity — the bundled floor a release ships', () => {
  it('the bundled layer resolves work-on-everything with the standing defaults intact', () => {
    const woe = workOnEverything();
    expect(woe.layer).toBe('bundled');
    expect(woe.title).toBe('Work on everything');
    expect(woe.standing, 'standing:true is the P-001 semantics — a silent default files it as an outcome goal').toBe(true);
    expect(woe.budgetCents ?? 0).toBeGreaterThan(0);
    expect(
      woe.budgetWindowSec ?? 0,
      'a positive trailing window is the P-004 semantics — dropped, the budget becomes a lifetime auto-kill',
    ).toBeGreaterThan(0);
  });

  it('the body carries the Blender-steward marker (imported code truth, never a copied literal)', () => {
    const woe = workOnEverything();
    expect(woe.body ?? '').toContain(BLENDER_GOAL_BODY_MARKER);
  });

  it('requires_rubrics declares goal-mode-e2e', () => {
    const woe = workOnEverything();
    expect(woe.requiresRubrics.some((r) => r.rubricRef === 'goal-mode-e2e')).toBe(true);
  });

  it('ships rubric stewardship with bounded, comparable grading and delegated repair', () => {
    const body = workOnEverything().body ?? '';
    expect(body).toContain('Maintain rubric coverage');
    expect(body).toContain('Improve rubric quality');
    expect(body).toContain('Drive grading through verified improvement');
    expect(body).toContain('Launch bounded GRADE-mode agents through capability:launch-agent');
    expect(body).toContain('exact target, pinned rubric revision, scope, budget, cadence and exit criterion');
    expect(body).toContain('baseline before repair');
    expect(body).toContain('baselineRef pointing to the preserved baseline');
    expect(body).toContain('supersedes only corrects a reading');
    expect(body).toContain('tracked launch, actual claim and progress separately');
    expect(body).toContain('same target under the same rubric revision');
    expect(body).toContain('place every implementation with an implementer');
    expect(body).toContain('independent grader');
    expect(body).toContain('existing audit/strategy-change duty');
  });

  it('declares the worklist typed property (plan-ref-list, default [], editable_by both) — P-025', () => {
    const woe = workOnEverything();
    const decl = (woe.propertySchema ?? {}) as Record<string, Record<string, unknown>>;
    expect(
      decl.worklist,
      'the worklist declaration is the P-025 contract the HUD panel and the goal agent both drive from',
    ).toBeDefined();
    expect(decl.worklist).toMatchObject({ datatype: PLAN_REF_LIST_DATATYPE, editable_by: 'both' });
    expect(decl.worklist.default).toEqual([]);
    // woe-progress-table-2026-10-08 D-002 / R-2(4): the worklist is "only plans
    // I pick". A package that flips this back to true makes every active plan a
    // worklist member by default again (migration 1430 fixed the live row).
    expect(
      (decl.worklist.collection as Record<string, unknown> | undefined)?.defaultSelected,
      'the worklist collection must declare defaultSelected:false — the owner picks plans in (D-002)',
    ).toBe(false);
    // The declared default must satisfy the datatype's own payload schema —
    // the exact check validatePropertySchemaDeclaration runs at seed time.
    expect(checkAgainstJsonSchema(planRefListPayloadSchema(), decl.worklist.default).ok).toBe(true);
  });

  it('the body carries the Worklist duties section the declaration exists to drive', () => {
    const woe = workOnEverything();
    expect(woe.body ?? '').toContain('## Worklist');
    expect(woe.body ?? '').toContain('LIST ORDER IS PRIORITY');
  });

  it('every bundled ref + title is prod-hygiene clean (cannot become purgeable junk)', () => {
    const pkgs = bundledPackages();
    expect(pkgs.length).toBeGreaterThan(0);
    for (const p of pkgs) {
      const hay = `${p.ref} ${p.title}`;
      expect(
        CUPBOARD_TEST_ROW_PATTERN.test(hay),
        `${hay} matches CUPBOARD_TEST_ROW_PATTERN — a rename made the bundled package read as a test row`,
      ).toBe(false);
    }
  });

  it('IF a built sidecar mirror exists, it is byte-identical to canonical (both directions)', () => {
    const drift = findGoalPackageMirrorDrift(CANONICAL_DIR, SIDECAR_MIRROR_DIR);
    expect(drift, drift.join('\n')).toEqual([]);
  });
});

describe('goal-package bundle integrity — the guard itself fails when it should', () => {
  let fixture: string;

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'goal-pkg-guard-'));
  });

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it('the strict reader REFUSES a non-string body (the parse-check leg is not vacuous)', () => {
    const root = join(fixture, 'bad-body');
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'goal.json'), '{"title":"Broken","body":123,"standing":true}');
    const pkgs = listLocalGoalPackages([{ dir: root, layer: 'bundled' }]);
    expect(pkgs.find((p) => p.ref === 'broken')).toBeUndefined();
  });

  it('the strict reader REFUSES a non-boolean standing flag', () => {
    const root = join(fixture, 'bad-standing');
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'goal.json'), '{"title":"Broken","standing":"yes"}');
    const pkgs = listLocalGoalPackages([{ dir: root, layer: 'bundled' }]);
    expect(pkgs.find((p) => p.ref === 'broken')).toBeUndefined();
  });

  it('passes an identical mirror (so a failure below is the fixture, not a false positive)', () => {
    const canonical = join(fixture, 'ok-canonical');
    const mirror = join(fixture, 'ok-mirror');
    for (const base of [canonical, mirror]) {
      mkdirSync(join(base, 'pkg'), { recursive: true });
      writeFileSync(join(base, 'pkg', 'goal.json'), '{"title":"Same"}');
    }
    expect(findGoalPackageMirrorDrift(canonical, mirror)).toEqual([]);
  });

  it('treats an ABSENT mirror as clean (a clean checkout stages nothing)', () => {
    const canonical = join(fixture, 'no-mirror-canonical');
    mkdirSync(canonical, { recursive: true });
    expect(findGoalPackageMirrorDrift(canonical, join(fixture, 'does-not-exist'))).toEqual([]);
  });

  it('FIRES on a mirror file that drifted from canonical', () => {
    const canonical = join(fixture, 'drift-canonical');
    const mirror = join(fixture, 'drift-mirror');
    for (const [base, body] of [
      [canonical, '{"title":"A"}'],
      [mirror, '{"title":"B — DRIFT"}'],
    ] as const) {
      mkdirSync(join(base, 'pkg'), { recursive: true });
      writeFileSync(join(base, 'pkg', 'goal.json'), body);
    }
    const rows = findGoalPackageMirrorDrift(canonical, mirror);
    expect(rows.some((r) => r.includes('differs'))).toBe(true);
  });

  it('FIRES on a canonical file missing from the mirror (direction 2)', () => {
    const canonical = join(fixture, 'missing-canonical');
    const mirror = join(fixture, 'missing-mirror');
    mkdirSync(join(canonical, 'pkg'), { recursive: true });
    mkdirSync(join(mirror, 'pkg'), { recursive: true });
    writeFileSync(join(canonical, 'pkg', 'goal.json'), '{"title":"Same"}');
    writeFileSync(join(mirror, 'pkg', 'goal.json'), '{"title":"Same"}');
    writeFileSync(join(canonical, 'pkg', 'listing.json'), '{"kind":"goal"}');
    const rows = findGoalPackageMirrorDrift(canonical, mirror);
    expect(rows.some((r) => r.includes('missing from the sidecar mirror'))).toBe(true);
  });
});
