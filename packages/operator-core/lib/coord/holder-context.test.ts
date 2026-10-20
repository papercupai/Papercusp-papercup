import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoFile, readRepoFile } from '@papercusp/test-config';
import {
  projectHolderContext,
  resolveHolderContext,
  forSubject,
  asGoalRef,
  HOLDER_ASSUMPTION_KEY_CAP,
  INTENT_STALE_SEC,
  type HolderContext,
  type HolderGoalRecord,
} from './holder-context';
import { autoConvertClaimIntent } from '../plan-items/claim-holder';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../cell-registry';
import { AGENT_GOAL_CELL } from '../cell-registrations';
import { AGENT_GOAL_CELL_ID } from '../agent-goal-ref';

/**
 * holder-context.test.ts — P-026's behaviour suite AND its D-047 row 7 PARITY
 * GATE (plan `unified-agent-state-plane-2026-07-27`, ruling D-083).
 *
 * The item's acceptance is "one exported resolver, consumed by at least one live
 * caller, with the D-047 row 7 parity test asserting no caller reaches goal data
 * by any other route". The first half is the behaviour section; the second half
 * is the three parity legs at the bottom.
 *
 * ⚠ WHY THE PARITY LEGS LAND NOW, AT ONE CONSUMER (the P-028 ordering rule, which
 * applies verbatim here). With one consumer the invariant is trivially true and
 * the gate is cheap to write. With the eight consumers D-055 enumerates, each has
 * independently had the chance to bypass it, and the gate must then litigate
 * eight existing call sites instead of preventing them. P-026 exists precisely
 * because "whichever consumer ships first defines the shape" is the failure mode.
 *
 * Legs B and C each carry a DELIBERATE VIOLATION proving the detector fires, and
 * leg C carries a NON-VACUITY assertion (D-076) proving the scan actually scanned.
 */

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const fresh = new Date(NOW - 60_000).toISOString();
const old = new Date(NOW - (INTENT_STALE_SEC + 600) * 1000).toISOString();

const goal = (over: Partial<HolderGoalRecord> = {}): HolderGoalRecord => ({
  itemId: 'P-026',
  intent: 'build the shared HolderContext projection',
  acquiredTs: fresh,
  ...over,
});

/**
 * ⚠ THE GOAL LEG NOW PASSES `getCell(AGENT_GOAL_CELL_ID, reader)`, so this suite
 * must REGISTER the cell or every goal assertion below would pass vacuously
 * against a closed gate — the "green because it stopped looking" failure the
 * non-vacuity assertions guard against at the other end of this file. Registering
 * the REAL spec (not a fixture) also means a change to its `visibility` is felt
 * here rather than only in production.
 */
beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(AGENT_GOAL_CELL);
});

// ─────────────────────────────────────────────────────────────────────────────
// The shape — D-055's five fields, no more
// ─────────────────────────────────────────────────────────────────────────────

describe('the D-055 shape is fixed', () => {
  /**
   * ⚠ THIS IS THE POINT OF THE WHOLE MODULE. D-055 fixed one shape so that eight
   * injection points do not invent eight; a field added for one consumer's
   * convenience is exactly how that erodes, and it erodes silently because the
   * extra field breaks nothing. If a successor genuinely needs a further field,
   * the change is a plan Decision amending D-055 and then this list — not a quiet
   * addition to the interface.
   *
   * AMENDED ONCE, by **D-093**: `agreement` + `competing`. Not a convenience
   * field for one consumer — D-092 had already ruled that a losing leg is
   * "DISCLOSED, never dropped", and this projection was computing both values and
   * discarding them one line later, so that guarantee reached no reader at all.
   * The amendment rule itself is unchanged.
   */
  it('has exactly the seven fields D-055 fixed and D-093 amended', () => {
    const ctx = projectHolderContext(goal(), ['assumption:a'], NOW);
    expect(ctx).not.toBeNull();
    expect(Object.keys(ctx as HolderContext).sort()).toEqual(
      ['agreement', 'assumptions', 'competing', 'declaredAt', 'goalRef', 'goalText', 'stale'].sort(),
    );
    expect(Object.keys((ctx as HolderContext).assumptions).sort()).toEqual(['count', 'keys']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-093 — the disclosure pair actually reaches the reader
// ─────────────────────────────────────────────────────────────────────────────

describe('D-093 — competing claims are disclosed, never dropped', () => {
  it('carries the producer\'s agreement verdict and competing refs through', () => {
    const ctx = projectHolderContext(
      goal({ agreement: 'divergent', competing: ['WI-6410', 'WI-6402'] }),
      [],
      NOW,
    );
    expect(ctx?.agreement).toBe('divergent');
    // Sorted + de-duped, so the value is stable between two readers of the same state.
    expect(ctx?.competing).toEqual(['WI-6402', 'WI-6410']);
  });

  it('de-dupes and drops blanks without failing', () => {
    const ctx = projectHolderContext(
      goal({ agreement: 'divergent', competing: ['WI-1', ' WI-1 ', '', null as unknown as string] }),
      [],
      NOW,
    );
    expect(ctx?.competing).toEqual(['WI-1']);
  });

  it('defaults to (null, []) for a producer that cannot answer', () => {
    const ctx = projectHolderContext(goal(), [], NOW);
    expect(ctx?.agreement).toBeNull();
    expect(ctx?.competing).toEqual([]);
  });

  /**
   * ⚠ THE PAIR IS BOUND TO A RESOLVED GOAL. With no `goalRef` there is nothing for
   * a competing ref to compete WITH, and reporting `divergent` beside an absent
   * goal would be a verdict about a value the reader cannot see — an unreadable
   * signal that looks like information.
   */
  it('collapses when there is no resolvable goal, even if the producer sent some', () => {
    const ctx = projectHolderContext(
      { itemId: '184073', agreement: 'divergent', competing: ['WI-6410'] },
      ['assumption:a'],
      NOW,
    );
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.agreement).toBeNull();
    expect(ctx?.competing).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (c) — goalRef is a ref, never a raw bigint
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (c) — goalRef never carries a raw bigint', () => {
  it('passes through resolvable refs', () => {
    expect(asGoalRef('P-026')).toBe('P-026');
    expect(asGoalRef('WI-6389')).toBe('WI-6389');
    expect(asGoalRef('  EI-18802263047567602  ')).toBe('EI-18802263047567602');
  });

  it('nulls a bare bigint — D-046: a bigint is not a read surface', () => {
    // `agent_facts.id` and friends are bigints; a reader handed `184073` can do
    // nothing with it, so it must read as ABSENT rather than present-and-useless.
    expect(asGoalRef('184073')).toBeNull();
    expect(asGoalRef('')).toBeNull();
    expect(asGoalRef(null)).toBeNull();
  });

  it('keeps goalText when the ref is unusable, rather than dropping both', () => {
    const ctx = projectHolderContext(goal({ itemId: '184073' }), [], NOW);
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.goalText).toBe('build the shared HolderContext projection');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal text — reusing the honest-unknown discipline, not re-deriving it
// ─────────────────────────────────────────────────────────────────────────────

describe('goalText reuses declaredGoalOf rather than echoing the intent', () => {
  it('surfaces a declared goal', () => {
    expect(projectHolderContext(goal(), [], NOW)?.goalText).toBe(
      'build the shared HolderContext projection',
    );
  });

  /**
   * ⚠ THE REGRESSION THIS PINS. `plan_item_claims.intent` is 100% populated, but
   * a third of live claims hold the auto-convert MECHANISM string, which names
   * the tool call that took the claim rather than the work. Echoing it verbatim
   * would report that third as goals — the exact defect `declaredGoalOf` exists
   * to prevent, and re-deriving it here instead of importing it is how a second
   * copy would drift from the write site.
   */
  it('refuses the auto-convert mechanism string — it is not a goal', () => {
    const ctx = projectHolderContext(goal({ intent: autoConvertClaimIntent('P-026') }), [], NOW);
    expect(ctx?.goalText).toBeNull();
    expect(ctx?.goalRef).toBe('P-026'); // the claim is still real and still shown
  });

  it('treats a blank intent as an honest unknown, never an empty goal', () => {
    expect(projectHolderContext(goal({ intent: '   ' }), [], NOW)?.goalText).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (d) — count plus a bounded expansion, never prose
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (d) — assumptions are a count plus a bounded key expansion', () => {
  it('de-duplicates and sorts keys for a stable projection', () => {
    const ctx = projectHolderContext(goal(), ['b', 'a', 'b'], NOW);
    expect(ctx?.assumptions).toEqual({ count: 2, keys: ['a', 'b'] });
  });

  /**
   * ⚠ `count` MUST stay the TRUE total when `keys` is capped. A cap that also
   * truncated the count would silently understate a holder's state — a reader
   * told "3 assumptions" for a holder with 30 makes a worse decision than one
   * told "30, here are the first 12".
   */
  it('caps the key expansion without understating the count', () => {
    const many = Array.from({ length: HOLDER_ASSUMPTION_KEY_CAP + 8 }, (_, i) =>
      `assumption:${String(i).padStart(2, '0')}`,
    );
    const ctx = projectHolderContext(goal(), many, NOW);
    expect(ctx?.assumptions.count).toBe(many.length);
    expect(ctx?.assumptions.keys).toHaveLength(HOLDER_ASSUMPTION_KEY_CAP);
  });

  it('drops malformed keys instead of rendering them', () => {
    const ctx = projectHolderContext(goal(), ['ok', '', '   ', null as unknown as string], NOW);
    expect(ctx?.assumptions).toEqual({ count: 1, keys: ['ok'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (e) — stale is the GOAL's age
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (e) — stale is derived from declaredAt', () => {
  it('a freshly declared goal is not stale', () => {
    expect(projectHolderContext(goal({ acquiredTs: fresh }), [], NOW)?.stale).toBe(false);
  });

  it('a goal declared beyond INTENT_STALE_SEC ago is stale', () => {
    expect(projectHolderContext(goal({ acquiredTs: old }), [], NOW)?.stale).toBe(true);
  });

  /**
   * ⚠ UNKNOWN, NOT FALSE. An undated or unparseable goal must never read as
   * "freshly declared" — that is precisely the "stale value reads as current"
   * defect rule (e) exists to prevent, and `false` is the confident wrong answer.
   */
  it('an undated or unparseable goal yields UNKNOWN staleness, never false', () => {
    expect(projectHolderContext(goal({ acquiredTs: null }), ['a'], NOW)?.stale).toBeNull();
    expect(projectHolderContext(goal({ acquiredTs: 'not-a-date' }), ['a'], NOW)?.stale).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules (b) + (f) — absent-vs-unreadable, and totality
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (b) — nothing disclosable is null, and unreadable looks like absent', () => {
  it('returns null when there is no goal and no visible assumption', () => {
    expect(projectHolderContext(null, [], NOW)).toBeNull();
    expect(projectHolderContext(undefined, [], NOW)).toBeNull();
  });

  it('still projects assumptions for a holder with no claim', () => {
    const ctx = projectHolderContext(null, ['assumption:x'], NOW);
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.assumptions.count).toBe(1);
  });

  /**
   * ⚠ THE INDISTINGUISHABILITY IS THE FEATURE (P-019's rule, applied to facts).
   * A reader who may not see a holder's assumptions gets the SAME answer as one
   * whose holder has none. If a refusal looked different from empty, a reader
   * could probe for the EXISTENCE of state it may not read — which is why the
   * item notes a refusal is not a probe oracle.
   */
  it('a refused assumptions read is indistinguishable from an empty one', async () => {
    const reader = { ownerId: 'su-reader' };
    const refused = await resolveHolderContext('su-holder', reader, {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => {
        throw new Error('audience refused');
      },
    }, { nowMs: NOW });
    const empty = await resolveHolderContext('su-holder', reader, {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => [],
    }, { nowMs: NOW });
    expect(refused).toEqual(empty);
  });
});

describe('rule (f) — total, and fails closed on a missing reader', () => {
  it('never throws on a hostile record', () => {
    expect(() =>
      projectHolderContext({ itemId: undefined as unknown as string, intent: 42 as unknown as string }, [], NOW),
    ).not.toThrow();
  });

  it('a dead goal source degrades ONE field, leaving assumptions intact', async () => {
    const ctx = await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, {
      holderGoal: async () => {
        throw new Error('pg down');
      },
      holderAssumptionKeys: async () => ['assumption:a'],
    }, { nowMs: NOW });
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.assumptions.count).toBe(1);
  });

  /**
   * ⚠ FAILS CLOSED, for the reason `getCell` requires a reader: an optional
   * audience is a defaulted audience, and a defaulted access check fails OPEN.
   * This is what makes it safe for a consumer to thread the reader optionally.
   */
  it('yields NO context when the reader is unidentified', async () => {
    const sources = {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => ['assumption:a'],
    };
    expect(await resolveHolderContext('su-holder', undefined, sources, { nowMs: NOW })).toBeNull();
    expect(await resolveHolderContext('su-holder', { ownerId: '  ' }, sources, { nowMs: NOW })).toBeNull();
    expect(await resolveHolderContext('  ', { ownerId: 'su-reader' }, sources, { nowMs: NOW })).toBeNull();
  });

  it('omitted sources yield nothing rather than an approximation', async () => {
    expect(await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, {}, { nowMs: NOW })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CELL GATE (P-030 acceptance) — the goal leg passes getCell(cell, reader)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P-030's acceptance is that "every read passes `getCell(cell, reader)`… and a
 * deliberate bypass of `getCell(cell, reader)` here turns P-028's suite RED".
 * P-028's three legs gate the REGISTRY (no reader-less accessor, no unchecked
 * call site); this block gates the CONSUMER — that the goal leg actually consults
 * the gate, rather than merely being able to.
 *
 * Both halves are needed, and neither substitutes for the other: a surface can
 * honour P-028 perfectly (never touching `getCellUnchecked`) while simply never
 * asking the registry anything at all.
 */
describe('the goal leg passes the P-019 cell gate', () => {
  const sources = {
    holderGoal: async () => goal(),
    holderAssumptionKeys: async () => ['assumption:a'],
  };

  it('discloses the goal to a reader the cell admits', async () => {
    const ctx = await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, sources, {
      nowMs: NOW,
    });
    expect(ctx?.goalRef).toBe('P-026');
  });

  /**
   * ⚠ AN UNREGISTERED CELL FAILS CLOSED. This is the honest reading of "the goal
   * cell does not exist in this process" — and it is also the case a successor is
   * most likely to hit, since the registry is populated by an import side effect
   * (`agent-tools/cell-registrations-wiring.ts`) that a narrow unit test does not
   * pull in.
   */
  it('discloses NO goal when the cell is not registered', async () => {
    __resetCellRegistryForTests();
    const ctx = await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, sources, {
      nowMs: NOW,
    });
    expect(ctx?.goalRef).toBeNull();
    // …while the assumptions leg, which carries its OWN audience boundary, is
    // untouched. The gate degrades one field, never the whole projection.
    expect(ctx?.assumptions.count).toBe(1);
  });

  /**
   * ⚠ A REFUSAL IS INDISTINGUISHABLE FROM AN ABSENCE (D-056 / rule b). Re-register
   * the cell narrowed to a DIFFERENT owner and a stranger must get byte-identical
   * output to a holder who simply declared no goal — not an error, not a flag, not
   * a differently-shaped result. Anything else is a probe oracle for the existence
   * of state the reader may not read.
   */
  it('a refused goal read is byte-identical to a holder with no goal', async () => {
    __resetCellRegistryForTests();
    registerCell({
      ...AGENT_GOAL_CELL,
      visibility: { kind: 'owner', ref: 'su-somebody-else' },
    } as CellSpec);

    const refused = await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, sources, {
      nowMs: NOW,
    });
    const noGoal = await resolveHolderContext(
      'su-holder',
      { ownerId: 'su-reader' },
      { ...sources, holderGoal: async () => null },
      { nowMs: NOW },
    );
    expect(refused).toEqual(noGoal);
    expect(refused?.goalRef).toBeNull();
  });

  it('the gate keys on the SAME id the registration uses', () => {
    // A hand-typed 'agent.goal' in the gate that drifts from the registration does
    // not throw — getCell just returns undefined and the surface silently discloses
    // nothing, forever. One constant is what makes that unreachable.
    expect(AGENT_GOAL_CELL.cell).toBe(AGENT_GOAL_CELL_ID);
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION (P-030 acceptance). Deleting the `getCell` call is
   * the bypass this whole block exists to catch, and a behavioural test alone
   * cannot see it: a bypassing implementation returns MORE data, and every
   * assertion above that expects a goal still passes. Only asserting the CALL is
   * present catches the removal.
   */
  it('DELIBERATE VIOLATION: removing the getCell call is detectable in the source', () => {
    const src = readRepoFile(__dirname, 'packages/operator-core/lib/coord/holder-context.ts');
    const code = stripComments(src);
    expect(
      code,
      'the goal leg must gate on getCell(AGENT_GOAL_CELL_ID, reader) — without it this ' +
        'surface serves a holder\'s goal with no P-019 audience check at all, and it fails ' +
        'OPEN (more data, no error), so no content assertion can catch it',
    ).toMatch(/getCell\(\s*AGENT_GOAL_CELL_ID\s*,/);

    // …and the detector is not vacuous: the ungated form must NOT match.
    expect(/getCell\(\s*AGENT_GOAL_CELL_ID\s*,/.test('const goal = await sources.holderGoal(h);')).toBe(
      false,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE D-047 ROW 7 PARITY GATE — no caller reaches goal data by another route
// ═════════════════════════════════════════════════════════════════════════════

const LIB_DIR = path.dirname(resolveRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts'));
const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');

/**
 * ⚠ THE SCAN READS CODE, NOT PROSE — and this is a correctness property, not a
 * tidiness one. Each leg below documents the anti-pattern it forbids, which means
 * each leg's own module WRITES that anti-pattern down in a comment. A detector
 * matching raw file text therefore fires on the warning ABOUT the bug as loudly
 * as on the bug — caught here on the first run, where all three legs flagged
 * their own docstrings. The cost of that failure mode is not a red test; it is
 * that the cheapest way to make the gate green becomes DELETING the explanation
 * of why the trap exists. A gate that punishes documenting the trap is worse than
 * no gate.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function scanLib(matches: (code: string) => boolean): string[] {
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
      if (matches(stripComments(readFileSync(full, 'utf8')))) {
        hits.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(LIB_DIR);
  return hits.sort();
}

/**
 * ⚠ THE WALK IS TESTED FOR HAVING RUN, NOT FOR HAVING COVERED — and those are
 * different properties (P-009).
 *
 * Legs A, B and C each open with a non-vacuity assertion, and each one checks that
 * the scan found ONE named anchor file. That catches a walk that returned nothing.
 * It cannot catch a walk that returned almost nothing — because every leg's anchor
 * is the file the leg is ABOUT, which sits in the same directory the leg's own
 * subject lives in, and is therefore the single file most likely to survive any
 * collapse of the corpus. The three anchors have that property in COMMON, which is
 * precisely what makes it the untested axis.
 *
 * Measured, 2026-07-27: the real corpus is 4,149 files over 127 top-level subdirs.
 * If `walk` stopped descending, or SKIP grew, or a readdirSync threw and got
 * swallowed, and the corpus collapsed to `coord/` alone, that is 4,149 -> 5 files
 * (a 99.88% loss) and LEG A's non-vacuity assertion STILL PASSES: its anchor,
 * `coord/holder-context.ts`, is one of the five. Collapsed to
 * `agent-tools/coordination/` it is 4,149 -> 161 and LEG B's anchor likewise
 * survives. Every leg would report GREEN over a corpus that had stopped containing
 * the consumers the legs exist to police.
 *
 * So the corpus itself gets an assertion, once, here — floors plus DISTANT anchors
 * deliberately chosen from subtrees no leg is about, so that surviving this check
 * requires the walk to have actually traversed the tree rather than merely reached
 * its own neighbourhood. Floors are generous (the tree grows); they are set to
 * catch a collapse by an order of magnitude, not to pin a number.
 */
describe('the scan COVERS the tree, not merely reaches its own directory', () => {
  // One walk, reused: the corpus is ~4,149 files, so re-walking per case would read
  // ~25k files to answer six questions about a single traversal.
  let corpus: string[];
  beforeAll(() => {
    corpus = scanLib(() => true);
  });

  it('walks the whole lib corpus, not just the legs own neighbourhoods', () => {
    expect(
      corpus.length,
      `the walk visited ${corpus.length} files; the real corpus is ~4,149. A walk this ` +
        `small has collapsed to a subtree, and EVERY leg's non-vacuity check still ` +
        `passes because each leg's anchor lives in the subtree the leg is about.`,
    ).toBeGreaterThan(2500);

    const subdirs = new Set(
      corpus
        .map((f) => f.replace('packages/operator-core/lib/', '').split('/')[0])
        .filter((d) => d.endsWith('.ts') === false),
    );
    expect(
      subdirs.size,
      `the walk reached ${subdirs.size} top-level subdirectories of lib/; the tree has ~127. ` +
        `A walk that descends into only a handful is not scanning the tree.`,
    ).toBeGreaterThan(80);
  });

  /**
   * The anchors below are chosen for DISTANCE: none is in `coord/` or
   * `agent-tools/coordination/`, so none of them can be found by a walk that only
   * reached a leg's own neighbourhood. A leg's own anchor proves nothing here and
   * is deliberately absent.
   */
  it.each([
    'packages/operator-core/lib/cell-registry.ts',
    'packages/operator-core/lib/sync-resolver/index.ts',
    'packages/operator-core/lib/plan-items/claims.ts',
    'packages/operator-core/lib/task-manager/managed-spawn.ts',
    'packages/operator-core/lib/agent-tools/index.ts',
  ])('reaches the distant file %s', (distant) => {
    expect(
      corpus,
      `${distant} is not in the scanned corpus. It is far from every leg's anchor, so ` +
        `its absence means the walk is not reaching the consumers the legs police — ` +
        `while the legs themselves still report GREEN.`,
    ).toContain(distant);
  });
});

describe('the scan strips comments before matching', () => {
  /**
   * The stripper is load-bearing for all three legs, so it gets its own check: an
   * over-eager stripper that ate CODE would make every leg silently vacuous, which
   * is the same "green because it stopped looking" failure the non-vacuity
   * assertions guard against from the other direction.
   */
  it('removes comment text but preserves code', () => {
    const src = [
      '/* never write kind = \'assumption\' */',
      "const q = `WHERE scope = 'owner'`;",
      "// and never SELECT intent FROM harness_shared.plan_item_claims",
      'const goalRef = resolve();',
    ].join('\n');
    const out = stripComments(src);
    expect(out).not.toMatch(/never write/);
    expect(out).not.toMatch(/plan_item_claims/);
    expect(out).toMatch(/WHERE scope = 'owner'/);
    expect(out).toMatch(/const goalRef = resolve\(\)/);
  });

  it('does not mistake a URL for a line comment', () => {
    expect(stripComments("const u = 'https://example.test/x';")).toMatch(/https:\/\/example/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG A — the resolver is the only DERIVATION: no consumer builds the shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A file assembling a holder context rather than consuming one.
 *
 * ⚠ KEYS ON THE PAIR, NOT ON `goalRef` ALONE — because `goalRef` alone is a
 * FIELD-NAME COLLISION, not the shape. `coordination/message-fields.ts` declares
 * `MessageWhy.goalRef` for P-014's message envelope (D-011: "a goal REF, never
 * prose"), which is a different record that legitimately names the same concept.
 * Flagging it would have taught the reader that this gate cries wolf, and the
 * first fix anyone reached for would be to widen the allowlist — spending the
 * gate's credibility on a file that was never the risk. The shape's actual
 * signature is `goalRef` TOGETHER WITH `assumptions`; nothing else in the tree
 * pairs them.
 */
/**
 * ⚠ AND ON PROXIMITY, NOT ON FILE-LEVEL CO-OCCURRENCE — the same lesson one turn
 * later, and it cost a fleet-wide gate red to learn.
 *
 * Requiring the pair anywhere in the SAME FILE is only the shape's signature in a
 * SMALL file. `work-items.ts` is ~4,600 lines and mentions `assumptions` (a P-008
 * completion ATTESTATION record, ~line 1907) and `goalRef` (read off an
 * `AgentStateStamp`, ~line 4561) — two unrelated records 2,600 lines apart,
 * neither remotely a HolderContext. The gate reported it as a second construction
 * site and held `main` for everyone.
 *
 * A construction site is an OBJECT LITERAL, so the tokens must be close enough to
 * sit in one. The window is deliberately generous — a real literal carrying five
 * fields with comments between them still fits — because the failure to avoid is
 * a FALSE one: a guard that cries wolf gets widened until it is meaningless, which
 * is precisely what the `goalRef`-alone note below already warned about. This is
 * that same warning, applied to the axis it missed.
 */
/**
 * ⚠ AND ON CODE ONLY — comments and string literals are PROSE ABOUT the concept,
 * never a construction of it. This was the third false positive in forty minutes
 * and the one that named the root cause.
 *
 * `agent-tools/sessions/timeline.ts` is P-024's READ tool. It never assembles a
 * HolderContext; it mentions `goalRef` in a JSDoc comment and in its own `description`
 * / `guidance` strings — because it is the tool that reads goals and assumptions, so
 * its documentation necessarily discusses both. Scanning raw file text made writing
 * ACCURATE DOCS about this plan's own concepts a way to red the fleet's gate, which is
 * an actively harmful incentive.
 *
 * Tightening the proximity window again would only have postponed the next instance.
 * Stripping is the fix that ends the class: a construction site is `{ goalRef: x,
 * assumptions: y }` in real code — bare identifiers, which survive stripping — while
 * every prose mention disappears. Deliberately applied to LEG A ALONE: legs B and C
 * hunt SQL that lives INSIDE template literals, so stripping strings there would blind
 * them completely.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments, incl. JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ') // line comments (the [^:] spares `https://`)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, ' `` ') // template literals
    .replace(/'(?:\\.|[^'\\\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' "" ');
}

const SHAPE_PROXIMITY_CHARS = 400;
const CONSTRUCTS_SHAPE = (raw: string): boolean => {
  const code = codeOnly(raw);
  for (const m of code.matchAll(/\bgoalRef\b/g)) {
    const at = m.index ?? 0;
    const window = code.slice(
      Math.max(0, at - SHAPE_PROXIMITY_CHARS),
      at + SHAPE_PROXIMITY_CHARS,
    );
    if (!/\bassumptions\b/.test(window)) continue;
    // CONSUMING the projection is the behaviour this gate wants, so destructuring
    // the resolver's own result must not read as a second construction site —
    // otherwise the gate punishes the exact call it exists to drive traffic to.
    if (/\bresolveHolderContext\s*\(/.test(window)) continue;
    return true;
  }
  return false;
};

const SHAPE_ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/coord/holder-context.ts':
    'defines the projection — the one derivation every consumer reads',
  'packages/operator-core/lib/agent-tools/coordination/holder-advisory.ts':
    'P-027: declares the ONE wire schema (HOLDER_CONTEXT_SCHEMA) every holder-bearing tool ' +
    'imports, and constructs no context — it calls resolveHolderContext. The schema is a ' +
    'genuine second statement of the shape, so holder-advisory.test.ts asserts its key set ' +
    'EQUALS the projection\'s: drift deletes fields from the wire silently (zod strips ' +
    'undeclared keys), and that assertion is the reason one schema module beats a literal ' +
    'inlined at each tool. ⚠ THE ENTRY MOVED HERE FROM work_items/_holder-lens.ts — P-030 ' +
    'declared the schema inside a private WORK-ITEM module, and P-027 renders the same ' +
    'projection at four more surfaces (locks:queue, plan_items:claim, …) which cannot import ' +
    'a work_items-private file to describe their own results. The allowlist follows the ' +
    'schema; it does not grant a directory standing permission to restate the shape',
};

describe('LEG A — only the resolver constructs a HolderContext', () => {
  it('no consumer assembles the shape itself', () => {
    const found = scanLib(CONSTRUCTS_SHAPE);

    // ⚠ NON-VACUITY (D-076). A walk that scanned zero files — a moved directory,
    // a bad anchor, an over-broad skip list — yields an empty `found`, filters to
    // an empty `offenders`, and reports GREEN: a gate that has stopped gating
    // while still looking healthy. The definer must always be found FIRST.
    expect(
      found,
      'the shape scan found nothing at all — it is not scanning the tree, so its GREEN is meaningless',
    ).toContain('packages/operator-core/lib/coord/holder-context.ts');

    const offenders = found.filter((f) => !(f in SHAPE_ALLOWLIST));
    expect(
      offenders,
      `these files construct a HolderContext-shaped object instead of calling ` +
        `resolveHolderContext: ${offenders.join(', ')}. D-055 fixed ONE shape for eight ` +
        `injection points; a second construction site is how eight shapes start.`,
    ).toEqual([]);
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg A — and the proof the PROXIMITY narrowing
   * bit only the false positive. Without this, tightening the predicate to fix a
   * fleet-wide gate red is indistinguishable from quietly disabling the guard.
   */
  it('DELIBERATE VIOLATION: a real second construction site is still detected', () => {
    const violating = `
      const ctx = { goalRef: refOf(claim), goalText: claim.intent,
                    assumptions: { count: keys.length, keys }, declaredAt, stale };
    `;
    expect(CONSTRUCTS_SHAPE(violating)).toBe(true);

    // ...and the false positive that held main: the two tokens present in one
    // file but in unrelated records far apart (work-items.ts had them ~2,600
    // lines apart — a P-008 attestation and an AgentStateStamp read).
    const farApart = `const a = { assumptions: opts.assumptions };${'\n// filler'.repeat(200)}\nif (readAgentStateStamp(o).goalRef === id) reset();`;
    expect(CONSTRUCTS_SHAPE(farApart)).toBe(false);

    // ...and CONSUMING the projection is never a construction site, however many
    // of its field names the consumer names while destructuring it.
    expect(
      CONSTRUCTS_SHAPE(`const { goalRef, assumptions } = await resolveHolderContext(o, r, s);`),
    ).toBe(false);

    // ⚠ PROSE ABOUT THE CONCEPT IS NOT A CONSTRUCTION OF IT — the third false
    // positive (sessions/timeline.ts, P-024's read tool). Documenting this plan's
    // own vocabulary accurately must never red the fleet's gate.
    expect(
      CONSTRUCTS_SHAPE(`/** Present ONLY on a \`goalRef\`-filtered read; counts assumptions. */`),
    ).toBe(false);
    expect(CONSTRUCTS_SHAPE(`// returns the goalRef and its assumptions`)).toBe(false);
    expect(
      CONSTRUCTS_SHAPE(
        `description: "Filter by goalRef; rows carry the goal and assumptions live at call time.",`,
      ),
    ).toBe(false);
    // ...but a construction hiding BELOW a doc comment is still caught.
    expect(
      CONSTRUCTS_SHAPE(
        `/** builds the ctx */\nconst c = { goalRef: r, assumptions: { count, keys } };`,
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG B — the goal PRODUCER is read in one place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `plan_item_claims.intent` is THE goal producer (D-083 §2: 7 of 7 live claims
 * populated). A surface reading it directly to answer "what is this holder
 * doing" bypasses `declaredGoalOf`, and so re-introduces the mechanism-string
 * bug for its own readers — silently, because the column is 100% populated and
 * the wrong answer is a well-formed string.
 */
const READS_CLAIM_INTENT = (code: string): boolean =>
  /SELECT[\s\S]{0,400}?\bintent\b[\s\S]{0,400}?FROM\s+harness_shared\.plan_item_claims/i.test(code);

/**
 * ⚠ THE ALLOWLIST DRAWS THE LINE AT *RENDERING*, NOT AT *TOUCHING*. Reading the
 * column is not the defect — turning it into a goal shown to a reader without
 * `declaredGoalOf` is. So the claim STORE is allowlisted (it hands back the whole
 * row, and every rendering path downstream goes through a projection) while a NEW
 * direct SELECT is not, because that is what a surface inventing its own goal
 * rendering looks like.
 *
 * Note what is deliberately NOT here, having been checked rather than assumed:
 * `presence-tier1.ts` and `plan-item-coverage.ts` both mention the table but
 * select only `owner`/`item_id` — they never read the intent at all.
 */
const CLAIM_INTENT_ALLOWLIST: Record<string, string> = {
  // P-016 MOVED THIS READ. `holder-context-sources.ts` used to hold the SELECT and
  // now delegates to the goal resolver, so the producer's one reader is this file.
  // It still satisfies the rule the allowlist enforces: `fetchHolderGoalRecord`
  // routes the raw intent through `declaredGoalOf` — and does so against the PLAN
  // ITEM id, which is the only id the auto-convert detection is meaningful for
  // once the goal ref itself may be a work-item.
  'packages/operator-core/lib/agent-tools/coordination/agent-goal-sources.ts':
    'P-016 goal source — the one route, projected via declaredGoalOf against the plan-item id',
  'packages/operator-core/lib/plan-items/claims.ts':
    'the claim STORE: returns the raw ClaimDbRow. Goal RENDERING happens downstream ' +
    'in claim-holder.ts (reader-independent) / holder-context.ts (reader-relative), ' +
    'both of which route through declaredGoalOf',
};

describe('LEG B — the goal producer has one reader', () => {
  it('every direct reader of the goal producer is allowlisted', () => {
    const found = scanLib(READS_CLAIM_INTENT);

    expect(
      found,
      'the producer scan found nothing at all — it is not scanning the tree, so its GREEN is meaningless',
    ).toContain('packages/operator-core/lib/agent-tools/coordination/agent-goal-sources.ts');

    const offenders = found.filter((f) => !(f in CLAIM_INTENT_ALLOWLIST));
    expect(
      offenders,
      `these files read plan_item_claims.intent directly: ${offenders.join(', ')}. A raw ` +
        `intent is NOT a goal — a third of live claims hold the auto-convert mechanism ` +
        `string. Route through resolveHolderContext (or declaredGoalOf for the ` +
        `reader-independent projection), or add a reasoned allowlist entry.`,
    ).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg B. */
  it('DELIBERATE VIOLATION: a new surface querying the producer is detected', () => {
    const violating = `
      const rows = await sql\`SELECT owner, intent FROM harness_shared.plan_item_claims WHERE owner = \${o}\`;
    `;
    expect(READS_CLAIM_INTENT(violating)).toBe(true);

    // ...and a compliant consumer, which never names the table, is not tripped.
    const compliant = `const ctx = await resolveHolderContext(owner, reader, holderContextSources());`;
    expect(READS_CLAIM_INTENT(compliant)).toBe(false);

    // ...nor is a WRITE, or a mere mention of the table without reading intent —
    // the gate targets goal RENDERING, not every use of the claim store.
    expect(READS_CLAIM_INTENT(`INSERT INTO harness_shared.plan_item_claims (owner, intent)`)).toBe(false);
    expect(READS_CLAIM_INTENT(`SELECT owner, item_id FROM harness_shared.plan_item_claims`)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG C — the assumptions producer is not read by `kind`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE D-082-CLASS TRAP, GATED. `agent_facts.kind` has a CHECK constraint
 * admitting `'assumption'`, so `kind = 'assumption'` is the reading the schema
 * invites — and `kind` is populated on 13 of 2,076 rows. Such a query typechecks,
 * passes every hand-built fixture, and derives nothing in production. Only a
 * check against the producer catches it, so it is pinned here as a constant.
 *
 * What is gated is a kind-ONLY read. A predicate that also covers the LEGACY
 * assumption form (D-087 R2: `confidence:'suspected'`, which is how every row
 * filed before migration 690 is discriminated) does NOT derive nothing live —
 * the legacy leg is exactly what picks up the 2,063 rows where `kind IS NULL`.
 * Flagging those too made this gate fire on the correct backward-compatible
 * implementation (`isAssumptionFact`, then in `agent-facts/store.ts`) rather than
 * on the defect, which is the one outcome that gets a real guard deleted.
 *
 * ⚠ `listAssumptionFacts` was the other example here and no longer exists: WI-6545
 * / D-103 retired it with P-011's detector. `isAssumptionFact` OUTLIVED that
 * retirement — it moved to `agent-facts/store.ts` and still discriminates the P-009
 * assumption watermark — so this guard's subject is unchanged.
 */
const ASSUMPTION_KIND_FILTER_RE = /kind\s*(?:=|===)\s*['"`]assumption['"`]/;
const LEGACY_ASSUMPTION_FALLBACK_RE = /confidence\s*(?:=|===)\s*['"`]suspected['"`]/;

/**
 * ⚠ A BRANCH ON THE KIND BEING WRITTEN IS NOT A READ FILTER.
 *
 * This gate is about SELECTING ROWS by an almost-empty column. `facts/assert.ts`
 * does `if (args.kind === 'assumption') noteAssumptionAsserted(...)` — branching on
 * the kind the CALLER just passed, on the WRITE path, to decide whether to move the
 * assumption watermark (D-087 R5). There is no query and no population to be wrong
 * about: `args.kind` is 'assumption' exactly when the caller said so. Flagging it
 * held `main` for the whole fleet over correct code.
 *
 * Stripped rather than allowlisted, and per-OCCURRENCE rather than per-file, so a
 * file containing BOTH a write branch and a genuine read filter is still caught on
 * the read filter — an allowlist entry would have excused the whole file.
 */
const WRITE_INPUT_KIND_RE = /\b(?:args|input|opts|params|payload|fact)\.kind\s*===?\s*['"`]assumption['"`]/g;

/**
 * ⚠ A FILE THAT NEVER TOUCHES THE FACTS STORE CANNOT BE SELECTING FACT ROWS.
 *
 * `'assumption'` is also a member of OTHER enums. `agent-tools/plans/product-shaping.ts`
 * filters a plan brief's `context[]` entries (`owner-request | observed-fact |
 * assumption | product-choice`) in memory, never an `agent_facts` row, and flagging it
 * held this guard red at HEAD over correct code (WI-6554700010018168). A real
 * kind-only fact read always lives in a file that names the store — the table, the
 * `agent-facts` module, or one of its read helpers — so the filter only counts there.
 * Measured 2026-10-20: of the six non-test lib files matching the kind regex, only
 * product-shaping.ts carries none of these references.
 */
const FACTS_STORE_REF_RE = /agent_facts|agent-facts|\bfoldFacts\w*\b|\blistFacts\b|\bAgentFact\w*\b/;

const ASSUMPTION_KIND_FILTER = (code: string): boolean => {
  if (!FACTS_STORE_REF_RE.test(code)) return false;
  const reads = code.replace(WRITE_INPUT_KIND_RE, '');
  return ASSUMPTION_KIND_FILTER_RE.test(reads) && !LEGACY_ASSUMPTION_FALLBACK_RE.test(reads);
};

describe('LEG C — assumptions are never keyed off the unpopulated `kind` column', () => {
  it('no file filters facts by kind = assumption', () => {
    const offenders = scanLib(ASSUMPTION_KIND_FILTER);
    expect(
      offenders,
      `these files filter agent_facts by kind='assumption' with NO legacy fallback: ` +
        `${offenders.join(', ')}. That column is populated on 13 of 2,076 rows (D-083 §2), ` +
        `so a kind-only query derives nothing live while passing every fixture. Either read ` +
        `the holder's live owner-scoped facts BY KEY, or cover the legacy form too ` +
        `(confidence='suspected', D-087 R2) the way isAssumptionFact does.`,
    ).toEqual([]);
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg C. Unlike legs A and B there is no
   * non-vacuity anchor available — the correct production state is ZERO hits, so
   * an empty result is the PASS rather than a suspicious one. This violation is
   * therefore the whole proof that the detector fires at all: without it, the
   * assertion above is indistinguishable from a regex that matches nothing.
   */
  it('DELIBERATE VIOLATION: a kind-filtered assumptions query is detected', () => {
    expect(ASSUMPTION_KIND_FILTER_RE.test(`AND kind = 'assumption'`)).toBe(true);
    expect(ASSUMPTION_KIND_FILTER_RE.test(`f.kind === "assumption"`)).toBe(true);

    // The correct production form — fold by scope + key — must NOT trip it.
    expect(
      ASSUMPTION_KIND_FILTER_RE.test(`foldFacts([{ scope: 'owner', scopeRef: owner }])`),
    ).toBe(false);

    // …and the SCANNED predicate (not just the regex) still fires on a kind-ONLY
    // read, which is the defect D-083 §2 is about.
    expect(ASSUMPTION_KIND_FILTER(`SELECT id FROM agent_facts WHERE scope = 'owner' AND kind = 'assumption'`)).toBe(true);
    expect(
      ASSUMPTION_KIND_FILTER(`import { foldFacts } from '../agent-facts/store';\nconst a = rows.filter(f => f.kind === 'assumption');`),
    ).toBe(true);

    // ⚠ THE FACTS-STORE NARROWING, proven in BOTH directions. An in-memory filter over
    // a DIFFERENT enum that also has an 'assumption' member (product-shaping.ts's brief
    // context entries) selects no fact rows and must not trip the gate...
    expect(
      ASSUMPTION_KIND_FILTER(`const assumptions = brief.context.filter(entry => entry.kind === 'assumption' && entry.text);`),
    ).toBe(false);
    // ...while the identical filter in a file that DOES read the facts store still fires.
    expect(
      ASSUMPTION_KIND_FILTER(`const rows = await listFacts(scope);\nconst assumptions = rows.filter(entry => entry.kind === 'assumption');`),
    ).toBe(true);

    // ⚠ THE WRITE-PATH NARROWING, proven in BOTH directions. Branching on the kind
    // the CALLER passed is not a read filter — flagging it held `main` for the
    // whole fleet over correct code (`facts/assert.ts`, D-087 R5)...
    expect(
      ASSUMPTION_KIND_FILTER(`if (args.kind === 'assumption') noteAssumptionAsserted(o, id);`),
    ).toBe(false);
    // ...but the strip is per-OCCURRENCE, not per-file, so a file carrying BOTH a
    // write branch AND a genuine kind-only read filter is still caught on the read.
    expect(
      ASSUMPTION_KIND_FILTER(
        `if (args.kind === 'assumption') note(o);\nconst r = await sql\`SELECT id FROM agent_facts WHERE kind = 'assumption'\`;`,
      ),
    ).toBe(true);
    // ...and the legacy-covering form stays exempt even alongside a write branch.
    expect(
      ASSUMPTION_KIND_FILTER(
        `if (args.kind === 'assumption') note(o);\nWHERE (kind = 'assumption' OR (kind IS NULL AND confidence = 'suspected'))`,
      ),
    ).toBe(false);
  });

  /**
   * The other half of the rule: covering the LEGACY form is the CORRECT fix, so
   * it must not read as the violation. Pinned because flagging it is what made
   * this gate fire on `isAssumptionFact` — a guard that reds on the correct
   * implementation is a guard someone deletes.
   */
  it('a kind filter that ALSO covers the legacy form is not a violation', () => {
    expect(
      ASSUMPTION_KIND_FILTER(
        `AND (kind = 'assumption' OR (kind IS NULL AND confidence = 'suspected'))`,
      ),
    ).toBe(false);
    expect(
      ASSUMPTION_KIND_FILTER(
        `if (f.kind != null) return f.kind === 'assumption';\nreturn f.confidence === 'suspected';`,
      ),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live consumer — acceptance requires at least one
// ─────────────────────────────────────────────────────────────────────────────

describe('the resolver has a live consumer', () => {
  /**
   * ⚠ RE-EXPRESSED BY P-012 (agent-state-plane-verification-2026-07-27), INTENT
   * UNCHANGED. This describe exists to prove `resolveHolderContext` is not dead
   * code — "acceptance requires at least one" live consumer. It used to prove that
   * by asserting `enrich-busy.ts` calls `resolveHolderContext(` and builds
   * `holderContextSources()` ITSELF.
   *
   * That spelling became the thing P-012 forbids. `enrichBusy` was the ONLY
   * surface reaching past the wiring layer to the pure resolver — in the same
   * directory as `locks/queue.ts`, which already went through the shared fan-out —
   * so the tree held two copies of "resolve once per holder", and the local one was
   * missing HOLDER_ADVISORY_DISTINCT_CAP's bound entirely. Pinning the direct call
   * made the divergence a REQUIREMENT.
   *
   * So the consumer assertion now follows the real chain: enrich-busy →
   * `resolveHolderAdvisoryMap` → the wiring layer → `resolveHolderContext`. The
   * resolver has MORE live consumers than before, not fewer; they simply all arrive
   * through one door. `holder-context-parity.test.ts` gates that door.
   */
  it('enrich-busy (D-055 A1) resolves holder context through the shared wiring', () => {
    const src = readRepoFile(__dirname, 'packages/operator-core/lib/agent-tools/locks/enrich-busy.ts');
    expect(src).toMatch(/resolveHolderAdvisoryMap\(/);
    // ...and does NOT keep a second copy of the binding the wiring layer owns.
    expect(src).not.toMatch(/(^|[^.\w])resolveHolderContext\s*\(/m);

    // UNCHANGED RULE, still load-bearing: it must pass the BLOCKED caller through as
    // the reader, not a default one — holder context is reader-relative, and a
    // defaulted audience fails OPEN. Without a reader there is no fan-out at all.
    expect(src).toMatch(/reader\s*\?\s*owners\s*:\s*\[\]/);
  });

  /** The wiring layer is where the pure resolver is actually invoked. */
  it('the wiring layer is the one place the pure resolver is called', () => {
    const wiring = readRepoFile(
      __dirname,
      'packages/operator-core/lib/agent-tools/coordination/holder-advisory.ts',
    );
    expect(wiring).toMatch(/resolveHolderContext\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forSubject — D-094's rule, now shared by P-030's lens and P-027's four sites.
// ─────────────────────────────────────────────────────────────────────────────

describe('forSubject (D-094)', () => {
  const ctx = (competing: string[]): HolderContext => ({
    goalRef: 'EI-18816386093046558',
    goalText: 'ship the thing',
    assumptions: { count: 0, keys: [] },
    declaredAt: null,
    stale: null,
    agreement: 'divergent',
    competing,
  });

  it('never names the SUBJECT among its own competing claims', () => {
    // The live defect verbatim: rendered against WI-6410, the holder-level list
    // told the reader they were "also competing on WI-6410" — the very thing
    // being looked at, named as a rival to itself.
    const out = forSubject(ctx(['WI-6410', 'some-plan#P-007']), 'WI-6410');
    expect(out.competing).toEqual(['some-plan#P-007']);
  });

  it('leaves a genuine rival list untouched when the subject is not in it', () => {
    const input = ctx(['some-plan#P-402']);
    const out = forSubject(input, 'WI-1');
    expect(out.competing).toEqual(['some-plan#P-402']);
    // Returns the SAME object when nothing was filtered, so a caller can detect
    // the no-op without a deep compare.
    expect(out).toBe(input);
  });

  it('subtracts ONLY the subject, never the goal or any other field', () => {
    const out = forSubject(ctx(['WI-6410', 'WI-99']), 'WI-6410');
    expect(out.competing).toEqual(['WI-99']);
    expect(out.goalRef).toBe('EI-18816386093046558');
    expect(out.goalText).toBe('ship the thing');
    expect(out.agreement).toBe('divergent');
  });

  it('is TOTAL — a blank, null or undefined subject returns the context unchanged', () => {
    const input = ctx(['WI-1', 'WI-2']);
    for (const subject of [null, undefined, '', '   ']) {
      expect(forSubject(input, subject)).toBe(input);
    }
  });

  it('trims the subject before comparing', () => {
    expect(forSubject(ctx(['WI-6410']), '  WI-6410  ').competing).toEqual([]);
  });

  it('handles an empty competing list without allocating', () => {
    const input = ctx([]);
    expect(forSubject(input, 'WI-6410')).toBe(input);
  });
});

describe('the subject rule is stated ONCE (D-038 axis 5)', () => {
  it('the work-item lens delegates rather than keeping its own filter', () => {
    const src = readRepoFile(
      __dirname,
      'packages/operator-core/lib/agent-tools/work_items/_holder-lens.ts',
    );
    expect(src).toMatch(/forSubject/);
    // A second copy of the filter is the drift this lift exists to prevent: two
    // implementations that agree today, disagree later, and each look right alone.
    expect(src).not.toMatch(/competing\.filter\(/);
  });
});
