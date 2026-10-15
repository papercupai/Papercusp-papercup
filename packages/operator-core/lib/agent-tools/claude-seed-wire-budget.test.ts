/**
 * claude-seed-wire-budget — the AUTOMATIC detector for the regression class behind
 * EI-23319364088969722 (psu Claude first-turn context 151K -> 317K on 2026-09-11).
 *
 * THE CLASS THIS KILLS. A psu Claude session pays, on EVERY turn, the full JSON
 * schema of every tool its MCP seed advertises — because denying ToolSearch (owner
 * directive: one call cost +67,045 tokens bypassing the result door) also removes
 * Claude's native schema DEFERRAL, which is implemented BY that tool. So the
 * advertised surface stopped being a discovery convenience and became a per-turn
 * context bill. Measured 2026-09-15: the 64-name seed cost 432,714 B on the wire,
 * ~157K tokens — essentially the entire reported regression.
 *
 * WHY NOBODY CAUGHT IT FOR FOUR DAYS, and why this file is a TEST rather than an alarm:
 *
 *   1. Every one of those 64 names was added individually, each with real demand
 *      evidence (reaches/callers, reach-per-KB) and each individually defensible.
 *      NOTHING EVER MEASURED THE AGGREGATE. A per-item justification process with no
 *      total is not a budget, and it drifts in one direction only.
 *   2. The repo's existing weight instrument measures the WRONG HALF. `npm run
 *      tool-weight` / `tool-guidance-budget.ts` govern promptWeight — description +
 *      guidance, budget 1,500 chars/tool. But the cost here is dominated by argSchema,
 *      which that budget does not look at: coord:send is ~1.2K of guidance and
 *      39,254 B of schema. A tool can sit comfortably inside the prompt-weight budget
 *      and still cost 30 KB a turn.
 *   3. The obvious runtime signal does NOT work. harness_shared.agent_usage_samples
 *      was the natural place to watch first-turn size, and it CANNOT see this: its
 *      rows are periodic CUMULATIVE snapshots (turn_count is NULL; cache_read_tokens
 *      grows across rows for one session), and the population mixes every anthropic
 *      session in the workspace. Tested against the known 09-11 step: n=1-5 boots/day
 *      with medians swinging 82K / 770K / 104K and no visible step. A threshold alarm
 *      there would have fired all through August and still missed the real event.
 *
 * So the detector is deterministic and lives at the SOURCE: measure what the seed
 * actually costs on the wire, from the same projected catalog the server advertises,
 * and fail the build when it grows. No sampling, no thresholds, no false positives.
 *
 * WHAT IT CATCHES that the ratchet in psu-launcher.test.ts does not: that ratchet
 * bounds the NUMBER of seeded names. This bounds their COST — so it also fires when
 * someone leaves the seed list alone and grows a SEEDED TOOL'S SCHEMA, which is the
 * same regression arriving through a different door and is invisible to a name count.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// Reuse the guidance-budget suite's real catalog registration during collection.
// Cold graph transformation belongs here, outside the timed test setup hook.
import './index';
import { listAllProjectedTools, compactWireBytes, type ProjectedTool } from '@papercusp/tooldef';
import { advertisedWireBytes } from './tool-guidance-budget';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations. Imported directly
// (rather than mirrored into a second list guarded for drift, the way
// OMP_CORE_MCP_TOOL_NAMES mirrors the orchestrator's CORE_MCP_TOOL_NAMES) because the
// launcher is dependency-free by design: importing it makes seed drift STRUCTURALLY
// IMPOSSIBLE instead of merely detected.
import {
  CLAUDE_MINIMAL_SEED_TOOL_NAMES,
  claudeSeedToolNames,
  claudeCompactToolNames,
} from '../../../../apps/operator/scripts/psu-launcher.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated .mjs data module, no type declarations.
import { CLAUDE_TOOL_DELIVERY } from '../../../../apps/operator/scripts/tool-delivery.generated.mjs';

/**
 * Ceiling on the OTHER branch this launcher ships.
 *
 * WHY THIS EXISTS (WI-10002043, 2026-09-20). Every assertion in this file indexes
 * CLAUDE_MINIMAL_SEED_TOOL_NAMES directly, but the launcher does not wire that const —
 * it wires claudeSeedToolNames(env), which BRANCHES:
 *   PAPERCUSP_CLAUDE_FULL_SEED truthy -> [...ompCoreToolNames(env), ...CLAUDE_SEED_EXTRA_TOOL_NAMES]
 *   otherwise                         -> CLAUDE_MINIMAL_SEED_TOOL_NAMES
 * (apps/operator/scripts/psu-launcher.mjs, claudeSeedToolNames). So the guard budgeted ONE
 * of TWO shipping code paths. The full-seed path still advertises the historical wide name
 * set, but now applies the generated compact tier to every matching name. It needs its own
 * budget because the wider set has a different wire cost from the default branch.
 *
 * The historical un-compacted set measured 414,641 B on the live wire. The current compact
 * intersection measured 108,253 B in this in-repo projection and 129,764 B on staging :3170.
 * D-001 caps the live tools/list definitions at 256,000 B; 210,000 B in-repo leaves margin
 * below the paired projection's live ceiling. Raising this is a budget decision, not a chore.
 */
export const CLAUDE_FULL_SEED_WIRE_BYTE_BUDGET = 210_000;

/** Lower plausibility bracket on the compact-tier full-seed measurement — the same
 *  vacuous-green trap as MIN_PLAUSIBLE_SEED_WIRE_BYTES below. Structural assertions also
 *  pin the wide name set and generated compact intersection; this floor catches a zeroed
 *  or otherwise collapsed byte instrument. Current measured projection is 108,253 B. */
const MIN_PLAUSIBLE_FULL_SEED_WIRE_BYTES = 80_000;

/**
 * Ceiling on the advertised Claude seed's tools/list wire payload.
 *
 * MEASURED 2026-09-15 against the live MCP endpoint (:3170, ctx_tier=trimmed), summing
 * Buffer.byteLength(JSON.stringify(tool)) over the advertised entries:
 *   historical 64-name seed ... 432,714 B
 *   current 31-name seed ...... 113,588 B   (-319,126 B, -73.7%, ~-116K tokens/turn)
 *
 * The in-repo projection below is the same catalog the server renders from but skips
 * the server's late entity-enum/sanitize passes (packages/agent-mcp/src/server.ts:758),
 * so it is a faithful REGRESSION signal rather than a byte-exact replica of the wire.
 * ⚠ IT THEREFORE READS LOWER THAN THE WIRE — measured the same day: this projection
 * totals 90,869 B for the same 31 names the live endpoint serves as 113,588 B (~20%).
 * Compare in-repo numbers to in-repo numbers; do not read 90,869 as the context cost.
 * This budget is set just above the in-repo reading, so the ~9 KB of headroom covers
 * ordinary schema drift — it is NOT spare budget to spend.
 *
 * RAISING THIS IS A BUDGET DECISION, NOT A CHORE. Before you raise it, re-measure
 * against a live tools/list, and prefer the alternative that costs 0 B/turn: leave the
 * tool unseeded and let tools:find/tools:invoke reach it in one round-trip. A seeded
 * tool is paid for on every turn of every session, forever.
 */
export const CLAUDE_SEED_WIRE_BYTE_BUDGET = 100_000;

/**
 * Lower plausibility floor on the SAME measurement — the guard's own vacuous-green trap.
 *
 * Every assertion here is an UPPER bound, and an upper bound is satisfied trivially by a
 * broken instrument: if `inputSchema` ever stops being populated on ProjectedTool (a
 * projection change, a renamed field), wireBytes() collapses toward zero, the budget
 * passes with room to spare, and this file reports healthy while measuring nothing. The
 * catalog-size and name-resolution floors above do NOT catch that — they check the
 * catalog and the names, not the bytes. This projection measures 90,869 B today, so a
 * reading below this floor means the instrument broke, not that the seed got cheap.
 */
const MIN_PLAUSIBLE_SEED_WIRE_BYTES = 50_000;

/** Mirrors tool-guidance-budget's MIN_PLAUSIBLE_CATALOG_SIZE. listAllProjectedTools()
 *  returns [] with NO error when the agent-tools barrel has not registered — over an
 *  empty catalog every assertion below would pass while measuring nothing, which is the
 *  exact vacuous green this repo has already been bitten by twice
 *  (EI-19377066316560032). Floor first, so a broken import is LOUD. */
const MIN_PLAUSIBLE_CATALOG_SIZE = 500;

function mcpName(t: ProjectedTool): string | null {
  return (t as { expose?: { mcp?: { name?: string } } }).expose?.mcp?.name ?? null;
}

/** The shape the server advertises per tool. Shared with omp-seed-wire-budget so the two
 *  seed budgets cannot drift onto different measurements. */
function wireBytes(name: string, t: ProjectedTool): number {
  return advertisedWireBytes(name, t as { description?: string; inputSchema?: unknown });
}

/**
 * The seed's cost AT ITS RESOLVED TIER — the only number that describes what now ships.
 *
 * ⚠ Summing `wireBytes` over the advertised names is the natural thing to write here and
 * it is WRONG by ~2x, because more than half the seed ships COMPACT. That reading would
 * fail this budget on a seed that is comfortably inside it, and the failure message would
 * point at tools whose prose is not actually on the wire. A compact name is measured by
 * `compactWireBytes(...).compact` — the same instrument the generator resolved against, so
 * this test and the artifact cannot disagree about what a byte is.
 */
function tieredBytes(
  names: readonly string[],
  compact: ReadonlySet<string>,
  byName: Map<string, ProjectedTool>,
): { total: number; rows: Array<{ name: string; bytes: number; tier: 'full' | 'compact' }> } {
  const rows = names.map((name) => {
    const t = byName.get(name);
    const tier: 'full' | 'compact' = compact.has(name) ? 'compact' : 'full';
    if (!t) return { name, bytes: 0, tier };
    const b = compactWireBytes(name, t as { description?: string; inputSchema?: unknown });
    return { name, bytes: tier === 'compact' ? b.compact : b.full, tier };
  });
  rows.sort((a, b) => b.bytes - a.bytes);
  return { total: rows.reduce((s, r) => s + r.bytes, 0), rows };
}

describe('Claude seed wire budget (EI-23319364088969722)', () => {
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

  it('sees a genuinely-registered catalog (a vacuous green is worse than a red)', () => {
    expect(
      catalogSize,
      `listAllProjectedTools() returned ${catalogSize} tool(s). Below ${MIN_PLAUSIBLE_CATALOG_SIZE} ` +
        `means the agent-tools barrel did not register — every measurement in this file would be ` +
        `vacuously clean.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_CATALOG_SIZE);
    expect(CLAUDE_MINIMAL_SEED_TOOL_NAMES.length).toBeGreaterThan(12);
  });

  it('every seeded name resolves to a real catalog tool', () => {
    // A typo'd seed name is silently DROPPED by the server's ?tools= allowlist: the
    // agent simply never sees that tool, and the byte total goes DOWN — so the budget
    // assertion below would read green for a broken seed. This is what stops that.
    const missing = (claudeSeedToolNames({}) as string[]).filter((n) => !byName.has(n));
    expect(
      missing,
      missing.length
        ? `Seeded name(s) not in the projected catalog: ${missing.join(', ')}. A name that does ` +
          `not resolve is dropped from the advertised surface — the agent never sees the tool.`
        : undefined,
    ).toEqual([]);
  });

  it('the advertised seed stays within its measured wire budget, AT ITS RESOLVED TIER', () => {
    const names = claudeSeedToolNames({}) as string[];
    const compact = new Set(claudeCompactToolNames({}) as string[]);
    const { total, rows } = tieredBytes(names, compact, byName);

    // Floor FIRST: a collapsed measurement must be loud, not silently under budget.
    expect(
      total,
      `measured only ${total.toLocaleString()} B for ${names.length} seeded tools ` +
        `(${names.length - compact.size} full + ${compact.size} compact). Below ` +
        `${MIN_PLAUSIBLE_SEED_WIRE_BYTES.toLocaleString()} B means the projection stopped carrying ` +
        `argSchema — the instrument broke, the seed did not get cheap. Every other assertion here ` +
        `is an upper bound and would pass anyway.`,
    ).toBeGreaterThan(MIN_PLAUSIBLE_SEED_WIRE_BYTES);

    // SECOND floor, and the one a tier bug trips: compaction must actually be doing
    // something. If `?tools_compact=` resolved empty (an assembler bug, a renamed env key)
    // this total collapses onto the FULL reading of all ~90 names — which is over budget,
    // so it fails loudly — but the reverse bug, compacting EVERYTHING, would pass the
    // ceiling while silently stripping prose from tools the policy ranked as worth it.
    expect(
      compact.size,
      'the compact tier resolved to ZERO names — the three-way admission collapsed back to ' +
        'full/deferred, and the budget below is being met by a seed that is not the one resolved.',
    ).toBeGreaterThan(0);
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
    const artifactTiers = (CLAUDE_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers;
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
      total > CLAUDE_SEED_WIRE_BYTE_BUDGET
        ? `\n\nCLAUDE SEED OVER WIRE BUDGET: ${total.toLocaleString()} B > ` +
          `${CLAUDE_SEED_WIRE_BYTE_BUDGET.toLocaleString()} B.\n` +
          `This is context every psu Claude session pays on EVERY turn (ToolSearch is denied, ` +
          `so there is no schema deferral).\n\nHeaviest seeded tools (tier shown):\n` +
          rows
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.tier.padEnd(7)}  ${r.name}`)
            .join('\n') +
          `\n\nFIX, cheapest first — note the seed is DERIVED now, so you do not edit a list:\n` +
          `  (a) RE-RESOLVE: npm run gen:tool-delivery. If a seeded tool's schema grew, the\n` +
          `      policy will drop the lowest-value name(s) to pay for it — that is the budget\n` +
          `      working, and the artifact diff shows exactly who paid.\n` +
          `  (b) SHRINK the argSchema of the offender above (note: npm run tool-weight measures\n` +
          `      description+guidance, NOT argSchema — it will look fine while this fails).\n` +
          `  (c) RAISE the budget — TRIMMED_BUDGET_BYTES in scripts/gen-tool-delivery.ts, only\n` +
          `      with a fresh live tools/list measurement, as a deliberate per-turn cost decision.\n`
        : undefined,
    ).toBeLessThanOrEqual(CLAUDE_SEED_WIRE_BYTE_BUDGET);
  });

  it('CONTROL: the budget assertion actually fires when the seed grows', () => {
    // A budget guard nobody has seen fail is a budget guard nobody has tested. Adding the
    // heaviest non-seeded verbs at FULL tier must blow the ceiling — proved without
    // mutating the tree.
    const names = claudeSeedToolNames({}) as string[];
    const seeded = new Set(names);
    const compact = new Set(claudeCompactToolNames({}) as string[]);
    // ⚠ COMPUTED, not named. A hand-picked control set goes VACUOUS the moment the policy
    // admits one of its members — which is exactly what happened when D-010 made the
    // owner-baseline a floor and pulled coord:send / work_items:complete /
    // work_items:checkpoint into the seed. The control then asserted nothing while still
    // reading as a guard. Taking the heaviest currently-UNSEEDED tools off the live
    // catalog cannot go stale that way.
    const heavies = [...byName.keys()]
      .filter((n) => !seeded.has(n))
      .map((n) => ({ n, b: wireBytes(n, byName.get(n)!) }))
      .sort((a, b) => b.b - a.b)
      .slice(0, 5)
      .map((x) => x.n);
    expect(
      heavies.length,
      'expected UNSEEDED tools to exist in the catalog — with none, this control measures nothing',
    ).toBeGreaterThan(0);

    const seededBytes = tieredBytes(names, compact, byName).total;
    const regrown = tieredBytes([...names, ...heavies], compact, byName).total;
    expect(regrown).toBeGreaterThan(seededBytes);
    expect(regrown).toBeGreaterThan(CLAUDE_SEED_WIRE_BYTE_BUDGET);
  });

  it('FLOOR COVERAGE: every floor tool is advertised at >= COMPACT (P-008)', () => {
    // The budget is allowed to hold a floor at COMPACT (D-004) but is NEVER allowed to
    // DROP one: a floor's absence is the class that does not degrade gracefully — it
    // halts, or strands state, or makes the rest of the catalog unreachable. A byte
    // ceiling with no floor check would happily buy its savings out of exactly these.
    const advertised = new Set(claudeSeedToolNames({}) as string[]);
    const floors = (CLAUDE_TOOL_DELIVERY as { floors?: string[] }).floors ?? [];
    expect(
      floors.length,
      'the generated artifact carries no floor list — this assertion would be vacuous',
    ).toBeGreaterThan(10);
    const dropped = floors.filter((n) => !advertised.has(n));
    expect(
      dropped,
      dropped.length
        ? `floor tool(s) NOT advertised: ${dropped.join(', ')}. A floor may be held at COMPACT ` +
          `when bytes demand it, never dropped — see apps/operator/lib/tool-delivery-floors.ts ` +
          `for what breaks without each one.`
        : undefined,
    ).toEqual([]);
  });

  it('NO REGRESSION: the derived seed still carries every name of the 31-name hand cut', () => {
    // The hand list survives in the launcher as this file's no-regression floor and as the
    // PAPERCUSP_CLAUDE_FULL_SEED history. The derived map is allowed to ADD names — that is
    // the COMPACT tier paying for itself — but a name the 2026-09-15 cut deemed mandatory
    // must not fall out on a value-density ranking. That would be a capability regression
    // wearing a byte saving's clothes.
    const advertised = new Set(claudeSeedToolNames({}) as string[]);
    const lost = (CLAUDE_MINIMAL_SEED_TOOL_NAMES as string[]).filter((n) => !advertised.has(n));
    expect(lost, lost.length ? `dropped from the seed: ${lost.join(', ')}` : undefined).toEqual([]);
    expect(advertised.size).toBeGreaterThan(CLAUDE_MINIMAL_SEED_TOOL_NAMES.length);
  });

  it('the DEFAULT branch the launcher SHIPS is exactly the generated artifact', () => {
    // Everything above measures claudeSeedToolNames(env), but the ARTIFACT is what the
    // generator's --check gate verifies against its inputs. Without this, a change to the
    // ASSEMBLER — a new default, an added filter, a merge — would ship a surface the
    // artifact check has never seen, and both guards would keep reporting green about
    // different things.
    expect(
      claudeSeedToolNames({}) as string[],
      'claudeSeedToolNames({}) no longer returns the generated advertised set verbatim — the ' +
        'default branch has diverged from the artifact gen:tool-delivery:check verifies.',
    ).toEqual([...(CLAUDE_TOOL_DELIVERY as { advertised: string[] }).advertised]);
  });

  it('the FULL-SEED branch (PAPERCUSP_CLAUDE_FULL_SEED=1) has a wire budget of its own', () => {
    const names = claudeSeedToolNames({ PAPERCUSP_CLAUDE_FULL_SEED: '1' }) as string[];
    const compact = new Set(claudeCompactToolNames({ PAPERCUSP_CLAUDE_FULL_SEED: '1' }) as string[]);
    const { total, rows } = tieredBytes(names, compact, byName);
    const artifactTiers = (CLAUDE_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers;
    const expectedCompact = names.filter((n) => artifactTiers[n] === 'compact');
    const missing = names.filter((n) => !byName.has(n));

    expect(missing, missing.length ? 'full-seed names missing from the projected catalog' : undefined).toEqual([]);
    expect([...compact].sort()).toEqual([...expectedCompact].sort());

    // Structural floor first: this branch must actually BE the wide surface. If
    // ompCoreToolNames() returns [] under a synthetic env, the branch collapses toward the
    // extras alone and every ceiling below passes while measuring the wrong thing.
    expect(
      names.length,
      `the full-seed branch advertised ${names.length} name(s), not more than the ${CLAUDE_MINIMAL_SEED_TOOL_NAMES.length} ` +
        `of the minimal branch. It is meant to restore the historical wide seed — this reads as an ` +
        `assembler/env problem, not as the full seed getting cheap.`,
    ).toBeGreaterThan(CLAUDE_MINIMAL_SEED_TOOL_NAMES.length);

    expect(
      total,
      'full-seed tiered measurement fell below its plausibility floor; the seed or instrument may have collapsed',
    ).toBeGreaterThan(MIN_PLAUSIBLE_FULL_SEED_WIRE_BYTES);

    expect(
      total,
      total > CLAUDE_FULL_SEED_WIRE_BYTE_BUDGET
        ? `\n\nCLAUDE FULL SEED OVER WIRE BUDGET: ${total.toLocaleString()} B > ` +
          `${CLAUDE_FULL_SEED_WIRE_BYTE_BUDGET.toLocaleString()} B for ${names.length} names.\n` +
          `This is the PAPERCUSP_CLAUDE_FULL_SEED=1 escape hatch — every session that sets it pays ` +
          `this on EVERY turn (ToolSearch is denied, so there is no schema deferral).\n\n` +
          `Heaviest names on this branch:\n` +
          rows
            .slice(0, 8)
            .map((r) => `  ${String(r.bytes).padStart(7)}  ${r.name}`)
            .join('\n') +
          `\n\nFIX: drop the name from CLAUDE_SEED_EXTRA_TOOL_NAMES / the orchestrator core list in\n` +
          `apps/operator/scripts/psu-launcher.mjs, or shrink the offender's argSchema. Raise this\n` +
          `budget only as a deliberate per-turn cost decision, recorded with a fresh measurement.\n`
        : undefined,
    ).toBeLessThanOrEqual(CLAUDE_FULL_SEED_WIRE_BYTE_BUDGET);

    // The exact historical name set remains guarded by psu-launcher.test.ts. Its cost is
    // no longer required to exceed the compact default by 2x: both branches now use the
    // generated per-name tier map.
    expect(compact.size, 'full-seed branch did not apply its generated compact intersection').toBeGreaterThan(0);
  });
});
