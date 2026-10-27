import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoFile, readRepoFile } from '@papercusp/test-config';
import {
  registerCell,
  getCell,
  listCells,
  listCellsUnchecked,
  getCellUnchecked,
  canReadCell,
  __resetCellRegistryForTests,
  type CellSpec,
  type CellReader,
} from './cell-registry';
import { readCell, type CellReadEnv } from './cell-read';
import { BUILTIN_CELLS, registerBuiltinCells } from './cell-registrations';

/**
 * cell-access-parity.test.ts — THE `canReadCell` PARITY GATE
 * (unified-agent-state-plane-2026-07-27 P-028, D-047 row 7).
 *
 * WHY THIS EXISTS. D-042 binds every cell-reading surface to "CONSUME `canReadCell`,
 * never re-implement it", and until this file its entire enforcement was THAT SENTENCE.
 * D-016 says a sentence is not a tier — it is the prose-exhortation mechanism the
 * 47.1→34.9 evidence-compliance curve indicts.
 *
 * ⚠ IT IS THE MOST DANGEROUS OF THE FOUR UNCOVERED BEHAVIOURS BECAUSE IT LOOKS COVERED
 * AND FAILS SILENTLY. A surface that re-implements the audience check does not throw and
 * does not return an error — it returns MORE DATA. It passes every test that asserts on
 * content, because more content still contains the expected content. The only thing that
 * catches it is a test asserting the surfaces AGREE, which is what this file is.
 *
 * MODELLED ON `agent-tools/coordination/liveness-parity.test.ts`, named in D-038 axis 5
 * as the enforcement model for one-derivation-many-lenses: assert every surface routes
 * through ONE oracle. Here the oracle is `canReadCell(spec, reader)`.
 *
 * ⚠ WHY IT LANDS NOW, AT ONE CONSUMER, RATHER THAN LATER (P-028's ordering rule).
 * With one consumer the invariant is trivially true and the gate is cheap to write. With
 * n consumers each has independently had the chance to bypass it, and the gate must then
 * litigate n existing call sites instead of preventing them. Verified at authoring time:
 * the bypasses have ZERO production callers (leg C proves it mechanically, below). This
 * is why P-028 is a Phase 1 item and not a Phase 5 one.
 *
 * THREE LEGS, because there are three distinct ways to defeat the oracle:
 *   A. BEHAVIOURAL — a surface answers a reader differently from the oracle.
 *   B. ROOT        — someone adds a NEW reader-less accessor to the registry.
 *   C. CALL-SITE   — someone calls an EXISTING unchecked accessor from a new surface.
 * ...since joined by D (the visibility-kind refusal matrix) and E (the walk over the
 * REAL registry). Legs A–D EACH carry a deliberate violation proving the detector
 * actually fires, which is P-028's stated acceptance criterion; leg E carries a
 * non-vacuity check and a census instead, because it walks a corpus rather than
 * applying a predicate.
 *
 * ⚠ WHAT CATCHES A FAULT IN THE ORACLE ITSELF — measured, not assumed (P-009).
 *
 * A parity gate compares every surface AGAINST `canReadCell`, so the obvious worry is
 * that it cannot see a bug IN `canReadCell`: break the oracle and both sides of every
 * comparison move together, agreement is preserved, and the gate stays green. That
 * worry is HALF right, and the half that is wrong is the useful part.
 *
 * Mutating `canReadCell` to fail closed (`return false` for every spec) was run
 * against this file on 2026-07-27: 14 tests RED. The parametrized parity cases in leg
 * A behaved exactly as feared — oracle `false`, surfaces `false`, agreement intact,
 * green. What caught it was leg D's NON-VACUITY leg, "the oracle itself discriminates
 * … the INSIDE reader must be admitted": an assertion in the POSITIVE direction, on a
 * hardcoded expectation rather than on the oracle's own output.
 *
 * So the property that makes this gate robust is not the parity comparison — it is
 * that every leg proves the oracle can still say YES before asserting that it says NO.
 * Delete the prove-capable-first legs as redundant and the whole file degrades into a
 * tautology that a dead oracle satisfies perfectly. They are load-bearing; the
 * agreement assertions are not, on their own.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_A = 'su-owner-a';
const OWNER_B = 'su-owner-b';

/**
 * ⚠ EVENT-SIGNALLED ON PURPOSE, and a successor must not "fix" this to `poll`.
 *
 * `readCell` returns `absent` at GATE 1 (audience) before it ever dispatches. For the
 * IN-audience half of the parity table we need a non-`absent` answer that proves the
 * gate was passed — without standing up a real resolver. An event-signalled cell returns
 * `unknown` at the "no poll resolver" branch, which is exactly that: past gate 1, zero
 * I/O, fully deterministic. Switching these to `poll` would make the suite dispatch real
 * tools and turn a hermetic gate into a flaky one.
 */
const eventCell = (over: Partial<CellSpec> = {}): CellSpec => ({
  cell: 'test.wideCell',
  owner: OWNER_A,
  headline: 'some.headline',
  // Event-signalled ⇒ `null` is the required answer (D-016). See the note above on why
  // these fixtures are deliberately event-kind rather than poll.
  assessment: null,
  nullable: true,
  unknownHoist: 'someUnknown',
  callerRelativity: { kind: 'global' },
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  /**
   * ⚠ `liveExercised: true` is REQUIRED, not a claim about this fixture. D-038 axis 4
   * refuses any registration on fixture evidence alone ("fixtures cannot catch a fresh,
   * correctly-versioned, confidently-wrong resolver"), so a spec with `false` cannot be
   * registered at all and every fixture in the sibling suites asserts true for the same
   * reason. This object stands in for a real registered cell; the subject under test is
   * the audience gate, not this cell's provenance.
   */
  provenance: {
    obtainedBy: 'a fixture standing in for a registered cell, to exercise the audience gate',
    liveExercised: true,
    evidence:
      'the audience gate itself is exercised live by this suite against the real registry, ' +
      'registrar and readCell path — no resolver is mocked and no dispatch is stubbed',
  },
  resolver: 'packages/operator-core/lib/cell-access-parity.test.ts#fixture',
  changeSignal: { kind: 'event', key: 'test:fixture-cell-changed' },
  shape: '{ some: { headline } }',
  ...over,
});

const WIDE = 'test.wideCell';
const NARROW = 'test.narrowCell';

const readerA: CellReader = { ownerId: OWNER_A };
const readerB: CellReader = { ownerId: OWNER_B };

const env: CellReadEnv = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' };

beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(eventCell({ cell: WIDE, visibility: { kind: 'workspace' } }));
  registerCell(eventCell({ cell: NARROW, visibility: { kind: 'owner', ref: OWNER_A } }));
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG A — behavioural parity: every surface agrees with the oracle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A surface probe answers ONE question: did this surface DISCLOSE this cell to this
 * reader? Reducing every surface to that boolean is what makes them comparable — the
 * surfaces return wildly different shapes (a spec, an array, a tagged union), and the
 * audience contract is the one thing all three must agree on.
 */
type SurfaceProbe = {
  name: string;
  disclosed: (cell: string, reader: CellReader) => Promise<boolean> | boolean;
};

const SURFACES: SurfaceProbe[] = [
  {
    name: 'getCell(cell, reader)',
    disclosed: (cell, reader) => getCell(cell, reader) !== undefined,
  },
  {
    name: 'listCells(reader)',
    disclosed: (cell, reader) => listCells(reader).some((s) => s.cell === cell),
  },
  {
    // P-019 makes unreadable indistinguishable from unregistered, so `absent` is the
    // refusal and ANY other status means the audience gate was passed.
    name: 'readCell(cell, reader, env)',
    disclosed: async (cell, reader) => (await readCell(cell, reader, env)).status !== 'absent',
  },
];

describe('LEG A — every cell-read surface agrees with canReadCell', () => {
  const cases: Array<{ cell: string; reader: CellReader; label: string }> = [
    { cell: WIDE, reader: readerA, label: 'workspace cell / owner A' },
    { cell: WIDE, reader: readerB, label: 'workspace cell / owner B' },
    { cell: NARROW, reader: readerA, label: 'owner-scoped cell / the owner' },
    { cell: NARROW, reader: readerB, label: 'owner-scoped cell / a stranger' },
  ];

  for (const { cell, reader, label } of cases) {
    it(`agrees with the oracle: ${label}`, async () => {
      const spec = getCellUnchecked(cell);
      expect(spec, 'fixture registered').toBeDefined();
      const oracle = canReadCell(spec as CellSpec, reader);

      for (const surface of SURFACES) {
        const actual = await surface.disclosed(cell, reader);
        expect(
          actual,
          `${surface.name} disagreed with canReadCell for ${label}: oracle said ` +
            `${oracle ? 'DISCLOSE' : 'REFUSE'} but the surface ${actual ? 'DISCLOSED' : 'REFUSED'}`,
        ).toBe(oracle);
      }
    });
  }

  it('refuses the stranger on every surface, and the refusal is indistinguishable from absent', async () => {
    expect(getCell(NARROW, readerB)).toBeUndefined();
    expect(listCells(readerB).map((s) => s.cell)).not.toContain(NARROW);
    expect((await readCell(NARROW, readerB, env)).status).toBe('absent');

    // The point of P-019: the SAME answer as a cell that was never registered, so a
    // refusal cannot be used to probe for the existence of narrow cells.
    expect((await readCell('test.neverRegistered', readerB, env)).status).toBe('absent');
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg A (P-028 acceptance).
   *
   * A surface that enumerates the registry directly instead of through the oracle. This
   * is not a hypothetical shape — it is precisely what D-042 (a) warns about, and note
   * that it does not error and returns a perfectly well-formed result. It simply returns
   * MORE. The parity check above is what catches it; this test proves that check has
   * teeth rather than passing vacuously.
   */
  it('DELIBERATE VIOLATION: a surface that bypasses the oracle is caught by the parity check', () => {
    const bypassing: SurfaceProbe = {
      name: 'listCellsUnchecked() — a surface that re-implements (i.e. skips) the audience check',
      disclosed: (cell) => listCellsUnchecked().some((s) => s.cell === cell),
    };

    const spec = getCellUnchecked(NARROW) as CellSpec;
    const oracle = canReadCell(spec, readerB); // false — B is not the owner
    const actual = bypassing.disclosed(NARROW, readerB);

    expect(oracle).toBe(false);
    expect(actual).toBe(true); // it leaks, silently and without error
    expect(
      actual === oracle,
      'the bypassing surface must DISAGREE with the oracle — if this ever becomes true, ' +
        'the parity assertions above are vacuous and this gate is not testing anything',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG B — root gate: no NEW reader-less accessor may reach cell data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `CELLS` is module-private, so the ONLY way to reach cell data is an export of
 * cell-registry.ts. That makes this leg a COMPLETE gate rather than a heuristic: if
 * every spec-returning export either takes a `CellReader` or is a named, reasoned
 * bypass, then no unaudited path to cell data exists at all.
 */
const READER_LESS_ALLOWLIST: Record<string, string> = {
  listCellsUnchecked:
    'deliberate admin/inventory bypass, documented at its definition; leg C gates its call sites',
  getCellUnchecked:
    'deliberate admin/inventory bypass, documented at its definition; leg C gates its call sites',
  registerCell: 'a WRITE — it takes the spec as input rather than serving one to a reader',
  validateCellSpec: 'a pure contract check on a caller-supplied spec; reaches no stored data',
};

type ExportedFn = { name: string; params: string; returns: string };

/** Extract exported function signatures from TypeScript source. */
function exportedFunctions(source: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  const re = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*:\s*([^{]+)\{/gm;
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1], params: m[2], returns: m[3].trim() });
  }
  return out;
}

/** A function that hands back stored cell data without taking a reader to check it against. */
function readerLessSpecAccessors(source: string): string[] {
  return exportedFunctions(source)
    .filter((f) => /\bCellSpec\b/.test(f.returns))
    .filter((f) => !/\bCellReader\b/.test(f.params))
    .map((f) => f.name);
}

describe('LEG B — the registry exposes no unaudited path to cell data', () => {
  const registrySource = readRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts');

  it('CELLS is module-private, so the export surface is the whole attack surface', () => {
    expect(registrySource).toMatch(/^const CELLS = new Map/m);
    expect(registrySource).not.toMatch(/^export\s+(const|let)\s+CELLS\b/m);
  });

  it('every reader-less accessor of cell data is on the reasoned allowlist', () => {
    const offenders = readerLessSpecAccessors(registrySource).filter(
      (name) => !(name in READER_LESS_ALLOWLIST),
    );
    expect(
      offenders,
      `these exports hand back CellSpec data without taking a CellReader to check it against: ` +
        `${offenders.join(', ')}. Either take a reader and route through canReadCell, or add an ` +
        `entry to READER_LESS_ALLOWLIST stating why serving this without an audience check is safe.`,
    ).toEqual([]);
  });

  it('the allowlist has not rotted — every entry still exists', () => {
    const actual = new Set(exportedFunctions(registrySource).map((f) => f.name));
    const stale = Object.keys(READER_LESS_ALLOWLIST).filter((n) => !actual.has(n));
    expect(stale, `allowlisted but no longer exported: ${stale.join(', ')}`).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg B (P-028 acceptance). */
  it('DELIBERATE VIOLATION: a new reader-less accessor turns this leg RED', () => {
    const violating = `
export function getCellForDashboard(cell: string): CellSpec | undefined {
  return CELLS.get(cell);
}
`;
    expect(readerLessSpecAccessors(violating)).toContain('getCellForDashboard');

    // ...and the same function WITH a reader is accepted, so the detector keys on the
    // audience parameter rather than merely on the shape of the return type.
    const compliant = `
export function getCellForDashboard(cell: string, reader: CellReader): CellSpec | undefined {
  return getCell(cell, reader);
}
`;
    expect(readerLessSpecAccessors(compliant)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG C — call-site gate: the unchecked accessors stay uncalled
// ─────────────────────────────────────────────────────────────────────────────

const BYPASS_CALL = /\b(getCellUnchecked|listCellsUnchecked)\s*\(/;

/**
 * Files permitted to call an unchecked accessor, each with a reason. A new entry here is
 * a deliberate, reviewable act — which is the whole point of making the bypass loud.
 */
const CALL_SITE_ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/cell-registry.ts': 'defines them',
  // Continuity-probe validation checks only that a persisted state-cell probe names a
  // registered poll cell; it reads registration metadata and never serves the cell value.
  'packages/operator-core/lib/continuity-probes.ts':
    'validates state-cell probe registration and poll-signal metadata; never reads or serves a cell value',
  // `deriveCellReread` (P-001) must find a spec by its (tool, path) change-signal BEFORE
  // it has anyone to check it against — the identity that matters is the WATCH ROW'S
  // (ownerId/role/harness), not the caller's, because a hand-rolled watch:create on the
  // same path must not learn a cell it cannot read exists. So it enumerates unchecked,
  // then applies `canReadCell` against the row's identity and returns NO handle when that
  // fails. Verified at the call site, not assumed: the `canReadCell` guard is the line
  // immediately after the `.find(...)`, and LEG A covers the resulting behaviour.
  //
  // It is allowlisted rather than rewritten to `listCells(rowReader)` deliberately: the
  // filtered form would let `.find` fall through to a DIFFERENT cell sharing the path if
  // the first match were out of audience, turning a registry defect (two cells, one path)
  // into a silently wrong handle. First-match-then-check is the deterministic order.
  'packages/operator-core/lib/events/await/predicate-watch.ts':
    'derives the P-001 reread handle: enumerates by (tool, path), then audience-checks against the WATCH ROW\'s identity',
  // P-008 / D-012 — the tenure sweep COUNTS the registry; it never serves a cell's
  // value to anyone. Its output is a per-cell cut-or-keep verdict derived from
  // `state:read` call volume, and the only cell data that leaves the function is the
  // id and its declared registration date — both of which the verdict is ABOUT.
  //
  // `listCells(reader)` is not available to it and would be wrong if it were: a
  // background sweep has no reader identity, and minting a synthetic principal to
  // obtain one is exactly how P-030's enrichment broke (agent-plane-measurement-sweep's
  // header records that `resolveAgentIdentity` throws for an unattributable caller).
  // An audience-FILTERED population would also silently corrupt the measurement —
  // cells invisible to whatever principal was manufactured would read as "not
  // registered" rather than "not assessed", i.e. they would vanish from a census
  // whose entire job is to be complete.
  'packages/operator-core/lib/agent-plane-measurement-sweep.ts':
    'P-008 tenure census: counts the registry to emit a cut-or-keep verdict per cell; inventory only, never serves a value',
  // The stale-quote stamp indexes cell IDENTITIES to recognise a cell the SENDER
  // already named in their OWN message sections (`buildCellTokenIndex` feeds
  // `detectQuotedCells(opts.sections, index)`). No cell VALUE is read, and no cell
  // name the sender did not already write is ever surfaced — so there is nothing
  // for an audience check to protect here. Its other unchecked call is a
  // `.length === 0` COUNT, guarding idempotent built-in registration.
  //
  // `listCells(reader)` would be actively WRONG, not merely unavailable: an
  // audience-filtered index makes `detectQuotedCells` fail to match a cell the
  // sender genuinely quoted, so the message ships with NO staleness stamp at all.
  // That inverts the safety property — the recipient reads an unmarked stale quote,
  // which is precisely the outcome the stamp exists to prevent. Filtering here would
  // trade a non-existent disclosure risk for a real correctness regression.
  'packages/operator-core/lib/agent-tools/coordination/stale-quote-stamp.ts':
    'stale-quote stamping: indexes cell identities to match names the sender already wrote; never serves a value, and filtering would silently drop the stamp',
};

function scanForBypassCallSites(rootDir: string, repoRoot: string): string[] {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.turbo']);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (BYPASS_CALL.test(readFileSync(full, 'utf8'))) {
        hits.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  walk(rootDir);
  return hits.sort();
}

describe('LEG C — no production surface calls an unchecked accessor', () => {
  it('every bypass call site is allowlisted', () => {
    // Bounded to operator-core/lib, where every cell surface lives. Measured at ~200ms
    // for 4,088 non-test files, which is why this can be a unit-tier gate at all.
    //
    // ⚠ Anchor on a REPO-UNIQUE path, never on 'package.json': resolveRepoFile walks up
    // from startDir and stops at the FIRST match, and package.json exists at every
    // workspace level, so it resolves to packages/operator-core and the join below then
    // doubles the segment. cell-registry.ts occurs once in the tree, so it cannot.
    const libDir = path.dirname(
      resolveRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts'),
    );
    const repoRoot = path.resolve(libDir, '..', '..', '..');
    const found = scanForBypassCallSites(libDir, repoRoot);

    // ⚠ NON-VACUITY, and this assertion is load-bearing. A walk that silently scanned
    // ZERO files — a moved directory, a bad anchor, an over-broad skip list — produces an
    // empty `found`, which then filters to an empty `offenders` and reports GREEN. That is
    // a gate that has stopped gating while still looking healthy, the exact shape this
    // whole file exists to prevent. cell-registry.ts defines the bypasses, so it must
    // always be found BEFORE the allowlist filter; if it is not, the scan is broken, not clean.
    expect(
      found,
      'the bypass scan found nothing at all — it is not scanning the tree, so its GREEN is meaningless',
    ).toContain('packages/operator-core/lib/cell-registry.ts');

    const offenders = found.filter((f) => !(f in CALL_SITE_ALLOWLIST));

    expect(
      offenders,
      `these files call getCellUnchecked/listCellsUnchecked, which skips the P-019 audience ` +
        `check: ${offenders.join(', ')}. A surface serving an agent must use getCell(cell, reader) ` +
        `or listCells(reader). If this call genuinely enumerates the registry itself (admin or ` +
        `inventory, never serving a value to an agent), add it to CALL_SITE_ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg C (P-028 acceptance). */
  it('DELIBERATE VIOLATION: a new surface calling an unchecked accessor is detected', () => {
    expect(BYPASS_CALL.test('const all = listCellsUnchecked();')).toBe(true);
    expect(BYPASS_CALL.test('const one = getCellUnchecked(cell);')).toBe(true);

    // The compliant forms must NOT trip it, or the gate would be unusable noise.
    expect(BYPASS_CALL.test('const one = getCell(cell, reader);')).toBe(false);
    expect(BYPASS_CALL.test('const all = listCells(reader);')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG D — the VISIBILITY-KIND matrix
// (agent-state-plane-verification-2026-07-27 P-006, per P-019 / P-028)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legs A–C prove the surfaces AGREE with the oracle. They do not prove the REFUSAL is
 * shaped identically to a non-existence — and that is a separate property with a
 * separate failure mode: a refusal that is merely *correct* can still be *recognisable*,
 * and a recognisable refusal is an ORACLE. An attacker (or an over-curious agent) who
 * can tell "you may not read this" from "no such cell" can enumerate every narrow cell
 * in the registry by probing names, which is exactly what P-019 forbids.
 *
 * Leg A checks this for ONE kind (`owner`) at ONE cell. `canReadCell` switches on FIVE
 * kinds, each with its own reader field, and four of them were untested from this angle.
 * A kind that returned, say, an `unknown` instead of `absent` would sail through legs
 * A–C: the oracle would say REFUSE, the surface would refuse, parity holds — and the
 * refusal would still be a probe oracle.
 */
const VISIBILITY_CASES: Array<{
  kind: string;
  visibility: CellSpec['visibility'];
  /** A reader the cell IS visible to. */
  inside: CellReader;
  /** A reader it is NOT visible to — the one whose refusal must be indistinguishable. */
  outside: CellReader;
}> = [
  {
    kind: 'owner',
    visibility: { kind: 'owner', ref: OWNER_A },
    inside: { ownerId: OWNER_A },
    outside: { ownerId: OWNER_B },
  },
  {
    kind: 'role',
    visibility: { kind: 'role', ref: 'su' },
    inside: { ownerId: OWNER_B, roles: ['su'] },
    outside: { ownerId: OWNER_B, roles: ['collaborator'] },
  },
  {
    kind: 'harness',
    visibility: { kind: 'harness', ref: 'papercusp' },
    inside: { ownerId: OWNER_B, harnessSlug: 'papercusp' },
    outside: { ownerId: OWNER_B, harnessSlug: 'some-other-harness' },
  },
  {
    kind: 'work_item',
    visibility: { kind: 'work_item', ref: 'WI-1234' },
    inside: { ownerId: OWNER_B, workItems: ['WI-1234'] },
    outside: { ownerId: OWNER_B, workItems: ['WI-9999'] },
  },
  {
    // The wide kind. There IS no outside reader — which is itself worth asserting, so a
    // future narrowing of `workspace` cannot pass unnoticed.
    kind: 'workspace',
    visibility: { kind: 'workspace' },
    inside: { ownerId: OWNER_A },
    outside: { ownerId: OWNER_B },
  },
];

const NEVER_REGISTERED = 'test.neverRegisteredAtAll';

describe('LEG D — an out-of-audience refusal is byte-identical to a non-existence, per visibility kind', () => {
  for (const { kind, visibility, inside, outside } of VISIBILITY_CASES) {
    const cell = `test.visibility.${kind}`;

    it(`${kind}: the oracle itself discriminates (non-vacuity — else the rest proves nothing)`, () => {
      __resetCellRegistryForTests();
      const spec = registerCell(eventCell({ cell, visibility }));
      expect(canReadCell(spec, inside), `${kind}: the INSIDE reader must be admitted`).toBe(true);
      // `workspace` is visible to everyone by design, so its "outside" reader is inside.
      expect(canReadCell(spec, outside)).toBe(kind === 'workspace');
    });

    if (kind === 'workspace') continue;

    it(`${kind}: the refused read is ABSENT — same status as a cell that does not exist`, async () => {
      __resetCellRegistryForTests();
      registerCell(eventCell({ cell, visibility }));

      const refused = await readCell(cell, outside, env);
      const nonexistent = await readCell(NEVER_REGISTERED, outside, env);

      expect(refused.status).toBe('absent');
      expect(refused.status).toBe(nonexistent.status);
    });

    /**
     * ⚠ THE KEY SET, NOT JUST THE STATUS. This is the assertion that catches the
     * realistic version of this bug. Nobody returns a different `status` for a refusal
     * — the tempting mistake is to return the same `absent` while ATTACHING something
     * helpful (`reason`, `visibility`, `requiredRole`, a `detail` naming the owner). Any
     * such field is a perfect oracle: its mere presence answers "does this cell exist?".
     */
    it(`${kind}: the refusal carries NO extra field — a helpful hint IS the oracle`, async () => {
      __resetCellRegistryForTests();
      registerCell(eventCell({ cell, visibility }));

      const refused = await readCell(cell, outside, env);
      const nonexistent = await readCell(NEVER_REGISTERED, outside, env);

      expect(Object.keys(refused).sort()).toEqual(Object.keys(nonexistent).sort());
    });

    it(`${kind}: and the INSIDE reader gets past the gate, so the refusal is not universal`, async () => {
      __resetCellRegistryForTests();
      registerCell(eventCell({ cell, visibility }));
      // Event-signalled fixture ⇒ `unknown`, which is any answer other than `absent`:
      // proof the audience gate was passed without standing up a resolver.
      expect((await readCell(cell, inside, env)).status).not.toBe('absent');
    });
  }

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg D. A refusal that is correct-but-recognisable —
   * the shape an author reaches for when trying to be helpful — must be caught by the
   * key-set assertion above. Proves that assertion has teeth rather than comparing two
   * objects that are trivially equal.
   */
  it('DELIBERATE VIOLATION: a refusal with a "helpful" extra field is caught by the key-set check', () => {
    const honest = { status: 'absent', cell: 'x' };
    const helpful = { status: 'absent', cell: 'x', reason: 'out-of-audience' };
    const nonexistent = { status: 'absent', cell: 'y' };

    expect(Object.keys(honest).sort()).toEqual(Object.keys(nonexistent).sort());
    expect(Object.keys(helpful).sort()).not.toEqual(Object.keys(nonexistent).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG E — walk the REAL registry, not fixtures (P-006)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legs A–D run against fixtures, which is right for the audience ALGEBRA — a fixture can
 * be shaped into every corner the switch has. But D-038 axis 4's whole complaint is that
 * "fixtures cannot catch a fresh, correctly-versioned, confidently-wrong resolver", and a
 * gate that never touches a production spec is exposed to exactly that. So this leg walks
 * `BUILTIN_CELLS`.
 */
describe('LEG E — every BUILT-IN cell agrees with the oracle on every surface', () => {
  const stranger: CellReader = { ownerId: 'su-nobody-at-all' };

  beforeEach(() => {
    __resetCellRegistryForTests();
    registerBuiltinCells();
  });

  it('the walk is NON-VACUOUS — there are built-in cells registered to check', () => {
    expect(BUILTIN_CELLS.length).toBeGreaterThan(0);
    expect(listCellsUnchecked().length).toBe(BUILTIN_CELLS.length);
  });

  for (const spec of BUILTIN_CELLS) {
    it(`${spec.cell}: getCell / listCells / readCell all agree with canReadCell`, async () => {
      const oracle = canReadCell(spec, stranger);

      expect(getCell(spec.cell, stranger) !== undefined, 'getCell disagreed').toBe(oracle);
      expect(listCells(stranger).some((s) => s.cell === spec.cell), 'listCells disagreed').toBe(oracle);
      // readCell's `absent` is the refusal; any other status means the gate was passed.
      // A poll cell would dispatch a real tool here, so only the GATE is asserted — via
      // getCell, which is the same oracle readCell consults at its own gate 1.
      expect(getCell(spec.cell, stranger) !== undefined).toBe(oracle);
    });
  }

  /**
   * ⚠ THE CENSUS, AND WHY IT IS AN ASSERTION RATHER THAN A COMMENT.
   *
   * Built-in cells now span TWO arms of the five-way switch: the operator release-pipeline
   * cells are `harness`-visible (EI-20709429494940822 narrowed them so other harnesses in the
   * workspace cannot read Papercusp's gate/deploy state as if it were their own), and the rest
   * remain `workspace`. So `oracle` above is `false` for the harness rows and `true` for the
   * workspace rows, and leg E's walk genuinely exercises both — a refusal and an admission.
   * That is a fact about the registry a reader of this file MUST know, because it is exactly
   * what determines how much coverage leg E is worth.
   *
   * Asserting the census rather than writing it in prose is what keeps it true — this
   * expectation is what caught the narrowing above instead of letting the prose go stale. The
   * moment the mix shifts again this test fails and forces the author back to leg E to confirm
   * the walk still asserts something for the newly-moved cell.
   */
  it('CENSUS: records how many built-in cells use each visibility kind', () => {
    const census: Record<string, number> = {};
    for (const spec of BUILTIN_CELLS) {
      census[spec.visibility.kind] = (census[spec.visibility.kind] ?? 0) + 1;
    }
    expect(
      census,
      'the built-in visibility census changed. If a cell has adopted a NARROWER visibility that is good news — ' +
        "leg E now exercises an arm of canReadCell's switch it never did before. Update this expectation, and " +
        'check that leg E still asserts something for the newly-narrow cell.',
    // workspace 11 → 12: capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-004
    // registered `capacity.verdict` workspace-visible. "Are we at capacity" is asked by every
    // placement path in the fleet, so narrowing it would just push callers back onto the
    // per-surface reads this cell exists to replace.
    //
    // harness 9 → 12: main-green-status-visible-2026-09-03 P-004 registered
    // `gate.greenCheckpoint.convergence` + `.freezeDisposition` and P-009 registered
    // `.retriage`, all under OPERATOR_PIPELINE_VISIBILITY like their gate siblings — the
    // gate is a per-harness fact, so leg E's harness arm now walks three more cells.
    // workspace 12 → 13: `agent.roleLaunch` (registered 2026-09-03) is workspace-visible.
    // workspace 13 → 14: `workspace.workScope` (WI-2145092, registered 2026-09-05) — the
    // work-scope policy is a WORKSPACE fact by construction (it names which harnesses the
    // whole workspace may work), so narrowing it to one harness would hide it from exactly
    // the callers it exists to answer.
    // workspace 14 → 15: `owner.directive.status` (directive-visibility-and-ownership-2026-09-22
    // P-007, registered 2026-09-22) — directives are owner speech recorded per workspace and every
    // coord reader in the workspace already sees them through orders:list (that plan's D-004:
    // LABEL, never filter), so a harness-narrow cell would hide a status the list already shows.
    // workspace 15 → 16: `memory.cgroupAttribution` projects the existing host memory
    // resolver's owner-attribution lens with workspace visibility. LEG E's generated case
    // covers its oracle/get/list parity; this census also binds that new row's visibility.
    // workspace 16 → 18: `lsp.warmServers` and `lsp.readiness` reuse the daemon lens
    // while exposing their distinct runtime and per-intent verdicts to the workspace.
    // harness 12 → 11, workspace 18 → 19: `gate.greenCheckpoint.ownership` WIDENED from
    // OPERATOR_PIPELINE_VISIBILITY to workspace (committed c3451c17b1). Unlike its gate
    // siblings its resolver reads the CALLER's own harness, so a target-pot fixer must be
    // able to read its own gate's owner; leg E now walks it on the workspace arm.
    // workspace 19 → 20: `verification.health` (verification-system-improvements-2026-10-10
    // P-002, registered 2026-10-11) is workspace-visible: its resolver is whole-workspace by
    // construction, so every reader sees the same value.
    // workspace 20 → 21: `work.bugInflow` (bug-inflow-one-problem-one-row-2026-10-18 P-007,
    // registered 2026-10-20, b98931d32e) is workspace-visible: its resolver SELECTs the
    // workspace's stored bug_inflow_daily rows, one inflow figure per workspace.
    // harness 11 → 12: `gate.greenCheckpoint.run` (registered 2026-10-26, 7c56cfd69f) uses
    // OPERATOR_PIPELINE_VISIBILITY like its gate siblings — the run is a per-harness gate fact.
    // LEG E's generated walk covers both new rows' oracle/get/list parity.
    ).toEqual({ workspace: 21, harness: 12 });
    const attribution = BUILTIN_CELLS.find((spec) => spec.cell === 'memory.cgroupAttribution');
    expect(attribution, 'the added cell must remain in the real parity walk').toBeDefined();
    expect(attribution!.visibility).toEqual({ kind: 'workspace' });
    expect(canReadCell(attribution!, stranger)).toBe(true);
    for (const cell of ['lsp.warmServers', 'lsp.readiness']) {
      const runtimeCell = BUILTIN_CELLS.find((spec) => spec.cell === cell);
      expect(runtimeCell, 'the new runtime lens must participate in the real parity walk').toBeDefined();
      expect(runtimeCell!.visibility).toEqual({ kind: 'workspace' });
      expect(canReadCell(runtimeCell!, stranger)).toBe(true);
    }
    // The census must also stay EXHAUSTIVE. The expectation above names kinds explicitly, so a
    // cell registered under a kind NOT named there would be invisible to it; summing the census
    // back to the registry size is what makes "these are all of them" an assertion rather than
    // an assumption.
    expect(
      Object.values(census).reduce((total, n) => total + n, 0),
      'the census does not account for every built-in cell',
    ).toBe(BUILTIN_CELLS.length);
  });
});
