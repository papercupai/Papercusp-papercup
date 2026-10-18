/**
 * identity-surface-lint (identity-system-everything-migration-2026-10-18 P-005, bar R-16).
 * The live tree must add no policed surface beyond the checked-in baseline, the baseline
 * must sit exactly at its shrink-only ceiling, and a seeded new flat role prompt,
 * prompt constant, context hook or kernel splice must fail the check with a non-zero
 * exit — the same `runIdentitySurfaceCheck` the CLI (`npm run lint:identity-surfaces`)
 * exits with.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  classifyHookSource,
  defaultCensusRoot,
  deriveIdentitySurfaceCensus,
  detectPromptConstants,
  readCheckedInIdentitySurfaceCensus,
  type IdentitySurfaceCensus,
  type IdentitySurfaceEntry,
} from './identity-surface-census';
import {
  IDENTITY_SURFACE_HIGH_WATER,
  isPolicedIdentitySurface,
  lintIdentitySurfaces,
  planIdentitySurfaceInventoryWrite,
  policedIdentitySurfaceCounts,
  runIdentitySurfaceCheck,
} from './identity-surface-lint';

const root = defaultCensusRoot();
const derived = deriveIdentitySurfaceCensus(root);
const checkedIn = readCheckedInIdentitySurfaceCensus(root);

const withEntries = (base: IdentitySurfaceCensus, entries: IdentitySurfaceEntry[]): IdentitySurfaceCensus => ({
  ...base,
  entries: [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
});
const plus = (base: IdentitySurfaceCensus, ...extra: IdentitySurfaceEntry[]) => withEntries(base, [...base.entries, ...extra]);

const hookEntry = (fileName: string, source: string): IdentitySurfaceEntry => {
  const path = `apps/operator/scripts/hooks/cc/${fileName}`;
  const kind = classifyHookSource(fileName, source);
  return { class: 'injection-hook', id: `injection-hook:${path}`, path, kind, ...(kind === 'identity-dispatch' ? { inside: true as const } : {}) };
};

describe('identity-surface lint — the live tree', () => {
  it('adds no policed surface outside the identity system and breaches no ceiling', () => {
    const lint = lintIdentitySurfaces(checkedIn, derived);
    expect(lint.violations.map((e) => e.id), 'new surface(s) outside the identity system (R-16)').toEqual([]);
    expect(lint.overCeiling).toEqual([]);
  });

  it('the checked-in baseline sits exactly at the shrink-only ceiling (lower the ceiling when a migration retires surfaces)', () => {
    expect(policedIdentitySurfaceCounts(checkedIn.entries), 'lower IDENTITY_SURFACE_HIGH_WATER to these counts').toEqual(IDENTITY_SURFACE_HIGH_WATER);
  });

  // A broken discoverer returning [] would read as a pure shrink and green the
  // lint; the derived census must be the checked-in inventory, exactly (R-16).
  it('the derived census is the checked-in inventory exactly, and is not empty', () => {
    const ids = (c: IdentitySurfaceCensus) => c.entries.map((e) => e.id).sort();
    expect(derived.entries.length).toBeGreaterThan(0);
    expect(ids(derived)).toEqual(ids(checkedIn));
  });

  it('the in-process check passes on the current tree', () => {
    expect(runIdentitySurfaceCheck(checkedIn, derived).exitCode).toBe(0);
  });

  // Runs the REAL guard over the real tree, by its npm script name. This is the
  // execution `lint:guard-reachability` credits as the `test` tier: an in-process call
  // to the helpers proves the detector works but enforces nothing (its `logic-test`
  // tier), so without this the guard would be reachable from no blocking path.
  it('`npm run lint:identity-surfaces` exits 0 on the current tree', () => {
    // Script name directly after `run` (flags after it): the reachability census reads
    // argv[1] of `npm run` as the script, so a leading `-s` would hide this execution.
    const run = spawnSync('npm', ['run', 'lint:identity-surfaces', '--silent'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(run.error, 'the guard process could not be started').toBeUndefined();
    expect(run.status, `lint:identity-surfaces failed:\n${run.stdout}\n${run.stderr}`).toBe(0);
  }, 330_000);
});

describe('identity-surface lint — a seeded new surface fails with a non-zero exit', () => {
  const longYou = `You must always do this. ${'Your work matters here. '.repeat(20)}`;
  const seededConstant = detectPromptConstants('packages/x/new-behavior.ts', `export const NEW_BEHAVIOR_NOTE = ${JSON.stringify(longYou)};\n`);
  const path = 'apps/operator/prompts/new-role.persona.md';
  const seeded: Record<string, IdentitySurfaceEntry> = {
    'flat-role-prompt': { class: 'flat-role-prompt', id: `flat-role-prompt:${path}`, path, kind: 'operator-prompt' },
    'prompt-constant': seededConstant[0]!,
    'injection-hook': hookEntry('posttooluse-new-reminder.mjs', 'print({ additionalContext: msg })'),
    'kernel-splice': { class: 'kernel-splice', id: `kernel-splice:${path}#NEW-SPLICE`, path, name: 'NEW-SPLICE', kind: 'splice-marker' },
  };

  it('the seeded constant is a real detector hit', () => {
    expect(seededConstant).toHaveLength(1);
  });

  it.each(Object.keys(seeded))('%s', (cls) => {
    const entry = seeded[cls]!;
    const current = plus(checkedIn, entry);
    const lint = lintIdentitySurfaces(checkedIn, current);
    expect(lint.violations.map((e) => e.id)).toEqual([entry.id]);
    const outcome = runIdentitySurfaceCheck(checkedIn, current);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join('\n')).toContain(`NEW ${cls} outside the identity system: ${entry.id}`);
    // ...and the inventory's only writer refuses to record it.
    expect(planIdentitySurfaceInventoryWrite(checkedIn, current)).toMatchObject({ ok: false });
  });

  it('a hook whose kind changes into context is a new context-injection surface', () => {
    const plumbing = hookEntry('stop-seeded-report.sh', 'curl -s "$URL" >/dev/null');
    const nowContext = hookEntry('stop-seeded-report.sh', 'echo "{\\"additionalContext\\": \\"$MSG\\"}"');
    expect([plumbing.kind, nowContext.kind]).toEqual(['plumbing', 'context']);
    expect(lintIdentitySurfaces(plus(checkedIn, plumbing), plus(checkedIn, nowContext)).violations.map((e) => e.id)).toEqual([nowContext.id]);
  });
});

describe('identity-surface lint — what is not policed', () => {
  it.each([
    ['identity-dispatch', 'sessionstart-new-identity.sh', 'node "$HOOKS/inject/index.mjs" session-start'],
    ['guard', 'pretooluse-new-guard.mjs', 'out({ hookSpecificOutput: { permissionDecision: "deny" } })'],
    ['plumbing', 'stop-new-ledger.sh', 'curl -s "$URL" >/dev/null'],
  ])('a new %s hook', (kind, fileName, source) => {
    const entry = hookEntry(fileName, source);
    expect(entry.kind).toBe(kind);
    expect(isPolicedIdentitySurface(entry)).toBe(false);
    expect(lintIdentitySurfaces(checkedIn, plus(checkedIn, entry)).violations).toEqual([]);
  });
});

describe('identity-surface lint — shrink, move and ceiling', () => {
  const constant = (path: string, name: string): IdentitySurfaceEntry => ({ class: 'prompt-constant', id: `prompt-constant:${path}#${name}`, path, name, kind: 'second-person' });
  const a = constant('packages/x/old.ts', 'LEGACY_NOTE');
  const b = constant('packages/x/other.ts', 'OTHER_NOTE');
  const baseline = withEntries(checkedIn, [a, b]);
  const ceiling = { 'flat-role-prompt': 0, 'prompt-constant': 2, 'injection-hook': 0, 'kernel-splice': 0 } as const;

  it('a retired surface is a shrink, not a violation; the stale inventory still asks for regeneration', () => {
    const current = withEntries(checkedIn, [b]);
    const lint = lintIdentitySurfaces(baseline, current, ceiling);
    expect(lint.violations).toEqual([]);
    expect(lint.retired.map((e) => e.id)).toEqual([a.id]);
    const outcome = runIdentitySurfaceCheck(baseline, current, ceiling);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toContain('IDENTITY_SURFACE_CENSUS drift');
    expect(planIdentitySurfaceInventoryWrite(baseline, current, ceiling)).toEqual({ ok: true, moved: 0, retired: 1 });
  });

  it('a constant that moves files under the same name is a move, not growth', () => {
    const moved = constant('packages/y/new-home.ts', 'LEGACY_NOTE');
    const lint = lintIdentitySurfaces(baseline, withEntries(checkedIn, [moved, b]), ceiling);
    expect(lint.violations).toEqual([]);
    expect(lint.moved.map((m) => [m.from.id, m.to.id])).toEqual([[a.id, moved.id]]);
    expect(planIdentitySurfaceInventoryWrite(baseline, withEntries(checkedIn, [moved, b]), ceiling)).toEqual({ ok: true, moved: 1, retired: 0 });
  });

  it('a move pairs one-to-one: a second same-named copy is still a violation', () => {
    const moved = constant('packages/y/new-home.ts', 'LEGACY_NOTE');
    const copy = constant('packages/z/copy.ts', 'LEGACY_NOTE');
    expect(lintIdentitySurfaces(baseline, withEntries(checkedIn, [moved, copy, b]), ceiling).violations).toHaveLength(1);
  });

  it('a baseline that grew past the ceiling fails, even with no new surface in the tree', () => {
    const grown = withEntries(checkedIn, [a, b, constant('packages/x/third.ts', 'THIRD_NOTE')]);
    const lint = lintIdentitySurfaces(grown, grown, ceiling);
    expect(lint.violations).toEqual([]);
    expect(lint.overCeiling).toEqual([{ class: 'prompt-constant', count: 3, highWater: 2 }]);
    expect(runIdentitySurfaceCheck(grown, grown, ceiling).exitCode).toBe(1);
    // A deleted-and-rebuilt baseline is judged against the ceiling alone.
    expect(planIdentitySurfaceInventoryWrite(null, grown, ceiling)).toMatchObject({ ok: false });
    expect(planIdentitySurfaceInventoryWrite(null, baseline, ceiling)).toEqual({ ok: true, moved: 0, retired: 0 });
  });
});
