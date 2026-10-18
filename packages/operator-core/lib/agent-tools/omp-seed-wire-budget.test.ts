/**
 * omp-seed-wire-budget — the same detector as claude-seed-wire-budget, pointed at the
 * OTHER seed: the core MCP spine handed to OMP/codex sessions and to operator-core role
 * launches. It is the sibling half of EI-23345472964244980 (catalog-wide argSchema wire
 * budget), and it exists because of a finding recorded in the canonical list itself.
 *
 * WHAT IS ACTUALLY WRONG HERE — and it is NOT the same shape as the Claude seed.
 *
 * The Claude seed was a REGRESSION: it doubled, nobody noticed, and shrinking it to 31
 * names recovered ~116K tokens/turn. This spine is not that. It is a DECLARED CEILING
 * WITH NO ENFORCEMENT. D-001 set a 256 KB wire ceiling and said crossing it "requires an
 * explicit owner decision". The canonical list's own comment records the measurement
 * (2026-09-05, real tools/list): the 47-entry spine was already 345,140 B — 32% OVER —
 * and states plainly why nobody was told:
 *
 *     "crossed silently, because the only guard that runs in CI is this count"
 *
 * There are two guards on that array today and BOTH count names: invoke.test.ts's ratchet
 * (<=48) and core-spine-inverses.test.ts's bloat ceiling (<=48). A name count cannot see
 * the cost — since D-001 measured 190,885 B on 2026-08-09 the seed has more than DOUBLED
 * in bytes while the ratchet moved 43->47, +9%. The bytes were never in the list; they
 * are in the schemas of tools already on it. So every addition was reviewed against an
 * instrument that was structurally blind to the thing the ceiling was about, and the
 * owner decision D-001 required was never triggered because nothing measured the trigger.
 *
 * WHAT THIS FILE MEASURED ON ITS FIRST RUN (2026-09-16): 353,380 B, in-repo, for the
 * 48-name spine — 34.8% over D-001's 262,144 B ceiling. Because this projection reads
 * BELOW the live wire (see the constant's docstring), that is a LOWER BOUND on the breach.
 * The eight heaviest are not close to marginal:
 *
 *     43,709  work_items:complete      20,722  loop:checkpoint
 *     38,747  coord:send               19,396  improvements:capture
 *     24,012  work_items:checkpoint    15,156  facts:assert
 *     22,378  fleet:launch-on-plan     11,332  work_items:create
 *
 * Those eight are 195,452 B — 55% of the spine across 8 of 48 names. The concentration is
 * the actionable part: this is not 48 tools each a little too fat, it is a handful of
 * whales, and the top three alone (106,468 B) exceed 40% of D-001's entire ceiling.
 *
 * THIS FILE IS THAT MEASUREMENT. It is deliberately a RATCHET pinned at the current size,
 * not an attempt to enforce 256 KB today: the spine is mirrored from a canonical list
 * under a lockstep guard, and bringing it under D-001's ceiling is schema-slimming work on
 * the whales (coord:send alone is ~39 KB; work_items:complete and work_items:checkpoint
 * each inline their full nested payload schema TWICE, for the single shorthand and the
 * items[] batch).
 *
 * ⚠ THAT LAST OBSERVATION IS TRUE BUT IT IS NOT THE LEVER — it reads like one, and the
 * first draft of this file's FIX list said so. Measured 2026-09-16: ALL removable
 * duplication across the 48 names is 38,016 B (11.7% of the spine's 324,384 B of
 * argSchema) and the batch-mirror shape is 21,508 B (6.6%), against a ~91 KB gap to
 * D-001. Half that subset is coord:send, where send-arg-shape.test.ts REQUIRES both
 * copies. The spine's actual mass is prose: 217,082 B, 66.9%. The FIX list below is
 * ordered by that measurement, not by the shape that is easiest to notice.
 *
 * What the ratchet changes is the direction of travel: growth now has to
 * argue with a number instead of slipping past a name count, and the debt is stated in a
 * failing-message the next editor reads rather than in a comment they do not.
 *
 * WHY THE CANONICAL LIST AND NOT THE LAUNCHER MIRROR. CORE_MCP_TOOL_NAMES is what D-001
 * ruled on and what `role-launch-spec.ts` hands to operator-core ROLE launches. That is
 * still a real shipping surface and this ratchet still guards it.
 *
 * ⚠ IT NO LONGER COVERS psu OMP/codex SESSIONS — corrected 2026-09-21, D-005. Until then
 * this header claimed that measuring the canonical list "covers every consumer", because
 * psu-launcher.mjs mirrored it into OMP_CORE_MCP_TOOL_NAMES. Since D-005 a psu OMP/codex
 * session is advertised the DERIVED delivery map (`ompCoreToolNames()`), so the two
 * populations have deliberately diverged and the old "identical, therefore equivalent"
 * assertion would now be asserting a falsehood about what ships. The derived seed has its
 * own budget assertions below — measured at its RESOLVED TIER, which is the only reading
 * that describes it, since more than half of it ships COMPACT.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// Reuse the guidance-budget suite's real catalog registration during collection.
// Cold graph transformation belongs here, outside the timed test setup hook.
import './index';
import { listAllProjectedTools, compactWireBytes, type ProjectedTool } from '@papercusp/tooldef';
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
import { advertisedWireBytes, MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
import {
  OMP_CORE_MCP_TOOL_NAMES,
  ompCoreToolNames,
  ompCompactToolNames,
} from '../../../../apps/operator/scripts/psu-launcher.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated .mjs data module, no type declarations.
import { OMP_TOOL_DELIVERY } from '../../../../apps/operator/scripts/tool-delivery.generated.mjs';

/** The unified trimmed budget (D-009) the DERIVED OMP seed is resolved against. Stated
 *  here rather than imported so this guard fails when the artifact drifts past it, instead
 *  of silently re-reading whatever the artifact happens to claim its own budget is. */
const OMP_DERIVED_SEED_WIRE_BYTE_BUDGET = 100_000;

/**
 * Ratchet on the core spine's advertised tools/list wire payload, pinned to its CURRENT
 * measured size. Shrink-only.
 *
 * MEASURED 2026-09-16 by this file: 353,380 B for the 48-name spine.
 *
 * ⚠ THIS IS A RATCHET, NOT D-001's CEILING, AND THE GAP IS THE POINT. D-001's ceiling is
 * 256 KB (262,144 B). The reading above is 34.8% over it — and that comparison needs no
 * extrapolation, which is what makes it worth stating: this projection UNDER-reads the
 * wire (see below), so 353,380 B is a LOWER BOUND on the breach, not an estimate of it.
 * This constant is therefore a RECORD OF A DEBT, not an allowance: it stops the debt
 * growing while the schema-slimming that would discharge it is done on the whale tools.
 *
 * ⚠ IN-REPO READING, NOT A WIRE READING. advertisedWireBytes() measures the same catalog
 * the server renders from but skips its late entity-enum/sanitize passes, so it reads
 * BELOW the live endpoint (measured the same week: 90,869 B in-repo for names the live
 * endpoint served as 113,588 B — a ratio of 0.80). Never re-seed this constant from a
 * live tools/list: that would silently hand the spine ~20% of free growth. Re-seed it
 * only from a fresh run of THIS file.
 *
 * ⚠ AND DO NOT RUN THAT RATIO BACKWARDS TO QUOTE A WIRE NUMBER HERE. It was measured on a
 * different tool set (the Claude seed), so applying it to this one yields an estimate,
 * not a measurement — and an estimate written into a constant's docstring is read as a
 * measurement by the next person. If a wire figure is needed, measure the wire.
 *
 * LOWERING IT IS ALWAYS CORRECT AND NEEDS NO CEREMONY. Raising it is an owner decision
 * under D-001, which this spine is already in breach of.
 */
export const CORE_SPINE_WIRE_BYTE_RATCHET = 360_000;

/** D-001's stated ceiling, for the failure message to quote. Not asserted — the spine is
 *  already over it, so asserting it would red the gate on a pre-existing, tracked debt
 *  instead of on the new growth this file exists to catch. */
const D001_WIRE_CEILING_BYTES = 256 * 1024;

/**
 * Lower plausibility floor on the SAME measurement — this guard's own vacuous-green trap.
 *
 * Every assertion here is an UPPER bound, and an upper bound is satisfied trivially by a
 * broken instrument: if `inputSchema` stops being populated on ProjectedTool (a projection
 * change, a renamed field), advertisedWireBytes() collapses toward zero, the ratchet
 * passes with room to spare, and this file reports healthy while measuring nothing. The
 * catalog-size and name-resolution floors do NOT catch that — they check the catalog and
 * the names, not the bytes. A reading below this floor means the instrument broke, not
 * that the spine got cheap.
 */
const MIN_PLAUSIBLE_SPINE_WIRE_BYTES = 140_000;

function mcpName(t: ProjectedTool): string | null {
  return (t as { expose?: { mcp?: { name?: string } } }).expose?.mcp?.name ?? null;
}

describe('core MCP spine wire budget (EI-23345472964244980 / D-001)', () => {
  let byName: Map<string, ProjectedTool>;
  let catalogSize = 0;

  beforeAll(() => {
    const all = listAllProjectedTools();
    catalogSize = all.length;
    byName = new Map();
    for (const t of all) {
      const n = mcpName(t);
      if (n) byName.set(n, t);
    }
  });

  const rows = () =>
    (CORE_MCP_TOOL_NAMES as readonly string[])
      .map((n) => ({ name: n, bytes: byName.has(n) ? advertisedWireBytes(n, byName.get(n)!) : 0 }))
      .sort((a, b) => b.bytes - a.bytes);

  it('sees a genuinely-registered catalog (a vacuous green is worse than a red)', () => {
    expect(
      catalogSize,
      `listAllProjectedTools() returned ${catalogSize} tool(s). Below ${MIN_PLAUSIBLE_CATALOG_SIZE} ` +
        `means the agent-tools barrel did not register — every measurement in this file would be ` +
        `vacuously clean.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_CATALOG_SIZE);
    expect(CORE_MCP_TOOL_NAMES.length).toBeGreaterThan(12);
  });

  it('every spine name resolves to a real catalog tool', () => {
    // A typo'd name is silently DROPPED by the server's ?tools= allowlist: the agent never
    // sees that tool, and the byte total goes DOWN — so the ratchet below would read green
    // for a broken spine. This is what stops that.
    const missing = (CORE_MCP_TOOL_NAMES as readonly string[]).filter((n) => !byName.has(n));
    expect(
      missing,
      missing.length
        ? `Spine name(s) not in the projected catalog: ${missing.join(', ')}. A name that does ` +
          `not resolve is dropped from the advertised surface — the agent never sees the tool.`
        : undefined,
    ).toEqual([]);
  });

  it('the launcher literal still mirrors the canonical list (the FULL-SEED revert target)', () => {
    // psu-launcher.test.ts holds the canonical lockstep drift guard; this is not a
    // duplicate of it. What it no longer entitles is the claim that measuring
    // CORE_MCP_TOOL_NAMES states a cost for psu OMP sessions — since D-005 those are served
    // the DERIVED map, asserted separately below. The literal survives as the
    // PAPERCUSP_CLAUDE_FULL_SEED revert target, and the revert has to restore the
    // historical surface byte-for-byte or it is not a revert.
    expect([...(OMP_CORE_MCP_TOOL_NAMES as string[])]).toEqual([...CORE_MCP_TOOL_NAMES]);
  });

  it('the DERIVED psu OMP seed is what a psu OMP session is actually advertised (D-005)', () => {
    // The population this file's header used to claim to cover. Asserting it here is what
    // keeps that correction honest: if ompCoreToolNames() ever collapses back onto the
    // literal, this fails rather than the header quietly becoming true again by accident.
    const derived = ompCoreToolNames({}) as string[];
    expect(derived).toEqual([...(OMP_TOOL_DELIVERY as { advertised: readonly string[] }).advertised]);
    expect(derived).not.toEqual([...(OMP_CORE_MCP_TOOL_NAMES as string[])]);
  });

  it('the DERIVED psu OMP seed stays within its unified budget, AT ITS RESOLVED TIER', () => {
    const names = ompCoreToolNames({}) as string[];
    const compact = new Set(ompCompactToolNames({}) as string[]);
    // ⚠ Summing advertisedWireBytes over these names is the natural thing to write and is
    // wrong by ~2x: more than half ship COMPACT. Measure each at the tier it resolved to.
    const rowsTiered = names
      .map((n) => {
        const t = byName.get(n);
        const tier = compact.has(n) ? 'compact' : 'full';
        if (!t) return { name: n, bytes: 0, tier };
        const b = compactWireBytes(n, t as { description?: string; inputSchema?: unknown });
        return { name: n, bytes: tier === 'compact' ? b.compact : b.full, tier };
      })
      .sort((a, b) => b.bytes - a.bytes);
    const total = rowsTiered.reduce((s, r) => s + r.bytes, 0);

    // Floors first, both directions — an upper bound alone is satisfied by a broken
    // instrument, and a compact tier that resolved empty would silently be measured as full.
    expect(total, `measured only ${total.toLocaleString()} B — the instrument broke`).toBeGreaterThan(
      40_000,
    );
    expect(compact.size, 'the compact tier resolved to ZERO names').toBeGreaterThan(0);
    // ⚠ NOT `compact.size < names.length` (WI-10002322, 2026-09-22). That encoded a PRE-D-002
    // premise — that some advertised tool always stays FULL — which the ratified delivery policy
    // falsified: deterministic-tool-definition-delivery-2026-09-21 D-004 holds a floor at the
    // CHEAPER tier rather than dropping it, and D-010 measures that floor at 93,769 B of D-009's
    // 100,000 B budget ("restoring the same 20 names at FULL would have cost 163,601 B and been
    // genuinely unaffordable"). So a `counts.full: 0` map is the policy's CORRECT output, and the
    // old assertion reds the gate on a fully compliant seed.
    //
    // The INTENT survives, because it is the only detector for it: catch the compact tier
    // OVER-MATCHING and silently stripping prose the policy ranked as worth keeping. Cross-check
    // the resolver against the generated artifact's own tier map instead of assuming an
    // affordable FULL tier — derived truth, so this cannot drift from the generator that decides
    // it, and it still fails loudly in BOTH directions.
    const artifactTiers = (OMP_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers;
    const overCompacted = names.filter((n) => compact.has(n) && artifactTiers[n] !== 'compact');
    expect(
      overCompacted,
      overCompacted.length
        ? `resolver compacted name(s) the artifact does NOT mark compact: ${overCompacted.join(', ')}. ` +
          `The compact tier is over-matching and is stripping prose the delivery policy ranked FULL.`
        : undefined,
    ).toEqual([]);
    const underCompacted = names.filter((n) => !compact.has(n) && artifactTiers[n] === 'compact');
    expect(
      underCompacted,
      underCompacted.length
        ? `artifact marks these compact but the resolver did not: ${underCompacted.join(', ')}`
        : undefined,
    ).toEqual([]);
    expect(
      names.length - compact.size,
      'FULL-tier count among advertised names disagrees with the generated artifact',
    ).toBe(names.filter((n) => artifactTiers[n] === 'full').length);

    expect(
      total,
      total > OMP_DERIVED_SEED_WIRE_BYTE_BUDGET
        ? `\n\nDERIVED OMP SEED OVER ITS UNIFIED BUDGET: ${total.toLocaleString()} B > ` +
          `${OMP_DERIVED_SEED_WIRE_BYTE_BUDGET.toLocaleString()} B (D-009).\n` +
          `Heaviest (tier shown):\n` +
          rowsTiered
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.tier.padEnd(7)}  ${r.name}`)
            .join('\n') +
          `\n\nThis seed is DERIVED — you do not edit a list. Run npm run gen:tool-delivery;\n` +
          `the policy drops the lowest-value name(s) to pay for whatever grew, and the\n` +
          `artifact diff names who paid.\n`
        : undefined,
    ).toBeLessThanOrEqual(OMP_DERIVED_SEED_WIRE_BYTE_BUDGET);
  });

  it('FLOOR COVERAGE: every floor tool is advertised to psu OMP at >= COMPACT (P-008)', () => {
    const advertised = new Set(ompCoreToolNames({}) as string[]);
    const floors = (OMP_TOOL_DELIVERY as { floors?: readonly string[] }).floors ?? [];
    expect(
      floors.length,
      'the generated artifact carries no floor list — this assertion would be vacuous',
    ).toBeGreaterThan(10);
    const dropped = floors.filter((n) => !advertised.has(n));
    expect(
      dropped,
      dropped.length ? `floor tool(s) NOT advertised to psu OMP: ${dropped.join(', ')}` : undefined,
    ).toEqual([]);
  });

  it('the advertised spine stays within its measured wire ratchet', () => {
    const all = rows();
    const total = all.reduce((s, r) => s + r.bytes, 0);

    // Floor FIRST: a collapsed measurement must be loud, not silently under budget.
    expect(
      total,
      `measured only ${total.toLocaleString()} B for ${CORE_MCP_TOOL_NAMES.length} spine tools. ` +
        `Below ${MIN_PLAUSIBLE_SPINE_WIRE_BYTES.toLocaleString()} B means the projection stopped ` +
        `carrying argSchema — the instrument broke, the spine did not get cheap. Every other ` +
        `assertion here is an upper bound and would pass anyway.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_SPINE_WIRE_BYTES);

    expect(
      total,
      total > CORE_SPINE_WIRE_BYTE_RATCHET
        ? `\n\nCORE MCP SPINE OVER ITS WIRE RATCHET: ${total.toLocaleString()} B > ` +
          `${CORE_SPINE_WIRE_BYTE_RATCHET.toLocaleString()} B.\n` +
          `This spine is advertised to every OMP/codex psu session and every operator-core role ` +
          `launch, and its cost is paid on EVERY turn.\n\n` +
          `⚠ IT IS ALREADY OVER D-001's ${D001_WIRE_CEILING_BYTES.toLocaleString()} B CEILING ` +
          `(measured 345,140 B on a real tools/list, 2026-09-05). The ratchet above is a record ` +
          `of that debt, not an allowance — so this red means the debt GREW.\n\n` +
          `Heaviest spine tools:\n` +
          all
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.name}`)
            .join('\n') +
          `\n\nFIX, cheapest first:\n` +
          `  (a) SHRINK an offender above — the material is PROSE, not duplication: 240,567 B\n` +
          `      of the spine's 350,656 B is .description text (68.6%, measured 2026-09-16).\n` +
          `      ⚠ THAT IS IN THIS FILE'S OWN advertisedWireBytes UNIT, which is what the\n` +
          `      total above is. An argSchema-only reading of the same spine is ~29 KB\n` +
          `      smaller (it drops the tool-level description and the name) — real, but NOT\n` +
          `      comparable to the number this test judges. Quote one unit or the other;\n` +
          `      mixing them silently moves the gap by 29 KB.\n` +
          `      Cut text redundant WITH THE SCHEMA ITSELF (a description restating its own\n` +
          `      enum/type), never text a reader needs.\n` +
          `      ⚠ (a) CANNOT CLOSE THIS GAP ALONE — measured, not assumed. 60.2% of that\n` +
          `      prose (144,852 B) is PINNED: a doc-claim test asserts a phrase into it so\n` +
          `      the description cannot drift from the behaviour, and cutting it reds a guard\n` +
          `      that exists on purpose. The UNPINNED pool is 95,715 B against the ~88.5 KB\n` +
          `      this spine must shed, so trimming to D-001 means deleting ~92% of EVERY\n` +
          `      unpinned description across all 48 names. Treat (b) as structurally\n` +
          `      required and (a) as what buys headroom — not as the whole route.\n` +
          `      ⚠ RANK BY REMOVABILITY, NOT BY SIZE. Neither prose-share nor\n` +
          `      duplication=0 says how much of a tool's prose may actually be cut, and\n` +
          `      picking targets by either is how this lane keeps choosing badly. Measured\n` +
          `      UNPINNED bytes: fleet:launch-on-plan 11,242 · loop:checkpoint 10,275 ·\n` +
          `      work_items:checkpoint 8,923 · coord:send 6,364 · plans:set-status 5,452.\n` +
          `      facts:assert reads like a whale and is NOT one — 75.2% pinned, only 3,037 B\n` +
          `      removable. To re-measure: for each spine tool, harvest the toMatch/toContain\n` +
          `      patterns from the *.test.ts files in ITS OWN directory PLUS the cross-cutting\n` +
          `      ones (lib/doc-claims/, lib/agent-tools/ root), drop patterns under ~8 literal\n` +
          `      chars, and classify each description pinned/unpinned. CALIBRATE IT IN BOTH\n` +
          `      DIRECTIONS before believing a digit — facts:assert.key must come back\n` +
          `      UNPINNED and facts:assert.ttlSec PINNED. An uncalibrated version of exactly\n` +
          `      this probe read 99.9% pinned, because the bare regex /n/ harvested from an\n` +
          `      unrelated test matched 856 of 895 descriptions.\n` +
          `      ⚠ DO NOT lead with the single/batch duplication collapse — it was measured\n` +
          `      and it is neither the largest win nor fully available. Across all 48 names\n` +
          `      ALL removable duplication is 38,016 B (10.8% of the spine) and the\n` +
          `      batch-mirror shape is 21,508 B (6.1%) — under a quarter of the ~88.5 KB this\n` +
          `      spine must shed to reach D-001. Over half of that subset is coord:send\n` +
          `      (11,017 B), which send-arg-shape.test.ts BLOCKS outright: its test\n` +
          `      "documents basedOn as output-only in description, guidance, and both\n` +
          `      schemas" requires the top-level AND items[] copies to each carry\n` +
          `      OUTPUT-ONLY/auto-derived/omit. The duplication is a TESTED documentation\n` +
          `      requirement there, not an accident. And it recovers exactly 0 B on\n` +
          `      fleet:launch-on-plan, facts:assert and loop:checkpoint — three of the eight\n` +
          `      whales listed above. See fact dead-end:argschema-batch-mirror-prose-dedup.\n` +
          `      ⚠ npm run tool-weight's PROMPT budget will look fine while this fails — it\n` +
          `      measures description+guidance. Read the argSchema half of its report instead.\n` +
          `  (b) UNSEED a name — but do it in BOTH lists in the same change:\n` +
          `      libs/papercusp/packages/orchestrator/src/invoke.ts (canonical) AND\n` +
          `      apps/operator/scripts/psu-launcher.mjs (OMP mirror). psu-launcher.test.ts\n` +
          `      compares them EXACTLY, so editing one alone trades this red for that one.\n` +
          `      An unseeded tool stays reachable via tools:find / tools:invoke, both of which\n` +
          `      are themselves on the spine.\n` +
          `  (c) RAISE the ratchet — an owner decision under D-001, which this spine is\n` +
          `      already in breach of. Re-seed it from a fresh run of THIS file, never from a\n` +
          `      live tools/list (that reads ~20% higher and would gift the spine the gap).\n`
        : undefined,
    ).toBeLessThanOrEqual(CORE_SPINE_WIRE_BYTE_RATCHET);
  });

  it('CONTROL: the ratchet actually fires when the spine grows', () => {
    // A budget guard nobody has seen fail is a budget guard nobody has tested. Adding the
    // heaviest NON-spine verbs must blow the ceiling — proved without mutating the tree.
    const offSpine = [...byName.keys()]
      .filter((n) => !(CORE_MCP_TOOL_NAMES as readonly string[]).includes(n))
      .map((n) => ({ name: n, bytes: advertisedWireBytes(n, byName.get(n)!) }))
      .sort((a, b) => b.bytes - a.bytes);
    expect(offSpine.length, 'expected off-spine tools to exist in the catalog').toBeGreaterThan(0);

    const base = rows().reduce((s, r) => s + r.bytes, 0);
    const regrown = offSpine.slice(0, 5).reduce((s, r) => s + r.bytes, base);
    expect(regrown).toBeGreaterThan(CORE_SPINE_WIRE_BYTE_RATCHET);
  });

  it('the ratchet is pinned near the measurement, not parked far above it', () => {
    // The failure mode a ratchet has that a budget does not: re-seeded generously once, it
    // stops being a ratchet and becomes headroom, silently, while still reading as a guard.
    //
    // ⚠ THIS ASSERTION FIRES ON SUCCESS, BY DESIGN — read its message before "fixing" it.
    // Slimming a whale's schema is exactly what the ratchet above asks for, and it makes
    // the slack GROW. That red is the ratchet tightening, not a regression: a ratchet that
    // never re-pins after a win is just a ceiling with extra steps. The remedy is a
    // one-line DOWNWARD re-pin, which needs no ceremony and no owner decision.
    const total = rows().reduce((s, r) => s + r.bytes, 0);
    const slack = CORE_SPINE_WIRE_BYTE_RATCHET - total;
    expect(
      slack,
      `the ratchet is pinned ${slack.toLocaleString()} B above the current ` +
        `${total.toLocaleString()} B measurement — more slack than ordinary schema churn needs, ` +
        `so it has stopped being a ratchet and become unreviewed headroom.\n\n` +
        `If you just SHRANK a schema: that is the win this file exists to ask for. Re-pin ` +
        `CORE_SPINE_WIRE_BYTE_RATCHET down to just above ${total.toLocaleString()} B and bank it ` +
        `— lowering is always correct and needs no owner decision.\n` +
        `If you did NOT: someone re-seeded the ratchet generously instead of tightly. Same fix.`,
    ).toBeLessThan(30_000);
  });
});
