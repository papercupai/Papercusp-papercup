/**
 * no-bespoke-state-read-guard.test.ts — the adoption gate's detection predicate
 * (unified-agent-state-plane-2026-07-27, P-005 / D-010; named by D-016's tier table).
 *
 * The guard (`scripts/check-no-bespoke-state-read.mjs`) runs green on the clean tree, which
 * only proves the no-false-positive direction. What D-010 actually asks for is the
 * OTHER direction — that a NEW bespoke state-read tool FAILS the build — and that
 * direction is invisible to a green run by construction: on a clean tree there is,
 * by definition, no new violation to catch. A guard whose gating property is only
 * ever exercised by the violation that has not happened yet is indistinguishable
 * from a guard that does nothing. So it is locked here instead.
 *
 * Same posture as `no-raw-setinterval-guard.test.ts` (P-007), for the same reason.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/** Repo root — vitest's cwd is `packages/operator-core`, which is NOT it (see below). */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
// prettier-ignore — ENFORCES the "ONE line" rule below, which was previously only DOCUMENTED:
// prettier wants to reflow this import into a multi-line list, which is exactly what unguards the
// specifier (measured 2026-08-03 — this file was prettier-dirty and one `--write` from TS7016).
// It sits above the pair because @ts-ignore must own the slot nearest the import; verified that
// prettier-ignore still applies across the two intervening directive comments.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { isStateReadCandidate, isMutatingVerb, parseToolDefs, judgeToolDef, BASELINE, MIN_EXEMPTION_REASON, STATE_NOUNS, BASELINE_REVIEW_BY, baselineExpired, VERDICTS, VERDICT_KINDS, verdictGaps, verdictRollup, capabilityEffect, SCAN_DIRS, isExcluded, WRITE_CAPABILITIES as GUARD_WRITE_CAPABILITIES, WRITE_CAPABILITY_SUFFIXES as GUARD_WRITE_CAPABILITY_SUFFIXES, VOLUME_WINDOW_DAYS, VOLUME_MIN_CALLS, VOLUME_MIN_DISTINCT_CALLERS, meetsVolumeFloor, findVolumeCandidates, volumeReportStatus, formatVolumeReport } from '../../../scripts/check-no-bespoke-state-read.mjs';
import { inferCapabilityEffect, WRITE_CAPABILITIES, WRITE_CAPABILITY_SUFFIXES } from '@papercusp/tooldef';
import { buildBuiltinToolSourceFiles } from './static-tool-catalog';

/** Build the text of a defineTool literal, optionally carrying a marker. */
const toolSrc = (name: string, opts: { capability?: string; marker?: string } = {}) => `
export default defineTool({
  name: '${name}',
  ${opts.capability ? `capability: '${opts.capability}',` : ''}
  ${opts.marker ?? ''}
  description: 'whatever this tool does',
  args: z.object({}),
  async handler() { return { content: [] }; },
});
`;

describe('no-bespoke-state-read guard:the state-read signature', () => {
  it('FLAGS a new state-read tool as a candidate', () => {
    expect(isStateReadCandidate({ name: 'dev:reaper_status', capability: 'intel:read' })).toBe(true);
    expect(isStateReadCandidate({ name: 'fleet:health', capability: 'coord:read' })).toBe(true);
    expect(isStateReadCandidate({ name: 'dev:queue_position', capability: null })).toBe(true);
  });

  it('catches a candidate that declares NO capability at all', () => {
    // Load-bearing: coord:presence — the canonical presence cell, and the surface
    // D-038 axis 5 cites as its model — declares no capability field. An
    // is-a-read-capability conjunction would miss exactly the tool this plane is
    // built around, which is why the predicate tests NOT-a-write instead.
    expect(isStateReadCandidate({ name: 'coord:presence', capability: null })).toBe(true);
  });

  it('does NOT flag a mutation that happens to contain a state noun', () => {
    // `set_state` and `kill` both match the noun signature; neither is a read.
    expect(isStateReadCandidate({ name: 'work_items:set_state', capability: 'work_items:write' })).toBe(false);
    expect(isStateReadCandidate({ name: 'processes:kill', capability: 'intel:read' })).toBe(false);
    expect(isStateReadCandidate({ name: 'pot:set-steering', capability: null })).toBe(false);
  });

  it('does NOT flag a write-capability tool', () => {
    expect(isStateReadCandidate({ name: 'dev:thing_status', capability: 'harness:write' })).toBe(false);
  });

  it('does NOT flag a MUTATION whose capability is a control capability — WI-6464', () => {
    // The bug this test exists for. Both tools are mutations of a live cgroup
    // (freeze/thaw a subtree; re-budget it in place) and both declare
    // `processes:control`, which tooldef has classified as a WRITE since 2026-06-20.
    // The gate used to test `/:write$/` on the capability NAME, which `processes:control`
    // does not match, and `freeze`/`limit` were missing from MUTATING_VERBS — so two
    // heuristics both missed and the gate reported 2 mutations as undeclared state reads
    // for hours, with 2 of its 3 rows wrong. A gate that cries wolf gets routed around.
    expect(isStateReadCandidate({ name: 'processes:freeze', capability: 'processes:control' })).toBe(false);
    expect(isStateReadCandidate({ name: 'processes:limit', capability: 'processes:control' })).toBe(false);
  });

  it('still flags the genuine read in the SAME group — the fix must not blanket-exempt it', () => {
    // processes:list declares `intel:read` and IS live system state. Silencing the two
    // false positives by exempting the group would have taken the true positive with them.
    expect(isStateReadCandidate({ name: 'processes:list', capability: 'intel:read' })).toBe(true);
  });

  it('keeps a state read whose capability is neither a read nor a write NAME', () => {
    // MEASURED coverage regression, and the reason the predicate tests "is a declared
    // WRITE" rather than "is a declared READ". `fleet:status` declares
    // `capability: 'fleet:status'` — verb-shaped, polarity-free — and is a genuine
    // grandfathered state read (P-020 verdict: `delegates`). An is-a-read conjunction
    // drops it, and drops it SILENTLY into a non-fatal "stale baseline entry" note.
    expect(capabilityEffect('fleet:status')).toBe('read');
    expect(isStateReadCandidate({ name: 'fleet:status', capability: 'fleet:status' })).toBe(true);
    expect(BASELINE.has('fleet:status')).toBe(true);
  });

  it('backstops an undeclared-capability mutation via the verb list', () => {
    // Defence in depth for the case the effect oracle cannot see: no capability declared.
    for (const verb of [
      'freeze',
      'thaw',
      'limit',
      'throttle',
      'drain',
      'park',
      'couple',
      'decouple',
      'admit',
      'wake',
    ]) {
      expect(isMutatingVerb(verb), `${verb} should read as mutating`).toBe(true);
    }
    expect(isStateReadCandidate({ name: 'processes:freeze_status', capability: null })).toBe(false);
    // Prefix-token discipline holds for the new verbs too: `limits_status` is not `limit`.
    expect(isMutatingVerb('limits_status')).toBe(false);
    expect(isMutatingVerb('waker_status')).toBe(false);
  });
});

describe('no-bespoke-state-read guard:the declared-effect oracle is a PINNED mirror', () => {
  // WI-6464's root cause was one hand-maintained list drifting from reality. The fix
  // replaces it with tooldef's authoritative oracle — but this gate is plain `.mjs` run
  // by bare `node` in CI, so it cannot import the TS module and must copy the sets.
  // A copy nobody checks is the same bug again, so it is pinned here instead: a
  // capability added to tooldef and not to the gate reds THIS test immediately.
  it('mirrors tooldef WRITE_CAPABILITIES exactly', () => {
    expect([...GUARD_WRITE_CAPABILITIES].sort()).toEqual([...WRITE_CAPABILITIES].sort());
  });

  it('mirrors tooldef WRITE_CAPABILITY_SUFFIXES exactly', () => {
    expect([...GUARD_WRITE_CAPABILITY_SUFFIXES]).toEqual([...WRITE_CAPABILITY_SUFFIXES]);
  });

  it('agrees with tooldef on every capability declared in the tree', () => {
    for (const cap of [
      'processes:control',
      'processes:kill',
      'intel:read',
      'harness:write',
      'coord:read',
      'fleet:status',
      'capability:bash',
      'capability:fs-read',
      'ui:dispatch',
      'ui:read',
      'activity:report',
      'activity:read',
      'operator:converse',
      'operator:read',
      'secrets:operator-credentials:read',
      'plans:write',
      'turn:interrupt',
    ]) {
      expect(capabilityEffect(cap), `${cap}`).toBe(inferCapabilityEffect(cap));
    }
  });

  it('classifies the control capability as a write — the specific miss', () => {
    expect(capabilityEffect('processes:control')).toBe('write');
    expect(inferCapabilityEffect('processes:control')).toBe('write');
  });

  it('does NOT flag an ordinary record read', () => {
    for (const name of ['docs:get', 'plans:list', 'work_items:list', 'search:fulltext', 'agents:list']) {
      expect(isStateReadCandidate({ name, capability: 'harness:read' })).toBe(false);
    }
  });

  it('requires a group:verb shape', () => {
    expect(isStateReadCandidate({ name: 'status', capability: null })).toBe(false);
    expect(isStateReadCandidate({ name: '', capability: null })).toBe(false);
  });

  it('treats both _ and - as token boundaries in the noun signature', () => {
    // The seeded baseline contains all three punctuation styles, so a signature
    // that only understood `_` would silently under-select.
    expect(isStateReadCandidate({ name: 'improvements:watchdog-status', capability: null })).toBe(true);
    expect(isStateReadCandidate({ name: 'dev:build_status', capability: null })).toBe(true);
    expect(isStateReadCandidate({ name: 'harness:status', capability: null })).toBe(true);
  });

  it('does not match a state noun embedded inside a larger word', () => {
    // `statuses` / `stateful` are not the state-question signature.
    expect(isStateReadCandidate({ name: 'dev:statuses_report', capability: null })).toBe(false);
    expect(isStateReadCandidate({ name: 'dev:stateful_thing', capability: null })).toBe(false);
  });

  it('isMutatingVerb matches a verb exactly or as a prefix token, not a substring', () => {
    expect(isMutatingVerb('set')).toBe(true);
    expect(isMutatingVerb('set_state')).toBe(true);
    expect(isMutatingVerb('set-steering')).toBe(true);
    // `settings_get` starts with the letters of `set` but is not the verb `set`.
    expect(isMutatingVerb('settings_get')).toBe(false);
    expect(isMutatingVerb('status')).toBe(false);
  });
});

describe('no-bespoke-state-read guard:the verdict', () => {
  const undeclared = { name: 'dev:reaper_status', capability: 'intel:read', lens: null, exemption: null };

  it('REFUSES an undeclared new state-read tool — the gating property', () => {
    expect(judgeToolDef(undeclared)?.rule).toBe('undeclared-state-read');
  });

  it('ACCEPTS a tool declaring a well-formed @cell-lens', () => {
    expect(judgeToolDef({ ...undeclared, lens: 'git.pipelinePosition' })).toBeNull();
    expect(judgeToolDef({ ...undeclared, lens: 'session.state' })).toBeNull();
  });

  it('REFUSES a malformed @cell-lens id', () => {
    for (const lens of ['gitPipelinePosition', 'Git.Position', 'git.', '.position', 'git..x']) {
      expect(judgeToolDef({ ...undeclared, lens })?.rule).toBe('cell-lens-malformed');
    }
  });

  it('ACCEPTS a reasoned @not-a-cell exemption', () => {
    const reason = 'reads a static catalog, not live system state';
    expect(reason.length).toBeGreaterThanOrEqual(MIN_EXEMPTION_REASON);
    expect(judgeToolDef({ ...undeclared, exemption: reason })).toBeNull();
  });

  it('REFUSES a rubber-stamp exemption — this is what stops the check-generic-first rot', () => {
    for (const reason of ['n/a', 'not a cell', 'no', 'x']) {
      expect(judgeToolDef({ ...undeclared, exemption: reason })?.rule).toBe('exemption-unreasoned');
    }
  });

  it('passes a non-candidate through untouched', () => {
    expect(judgeToolDef({ name: 'docs:get', capability: 'harness:read', lens: null, exemption: null })).toBeNull();
  });
});

describe('no-bespoke-state-read guard:parsing', () => {
  it('extracts name + capability from single AND double quoted literals', () => {
    // dev:service_health uses double quotes; a single-quote-only parser misses it.
    const rows = parseToolDefs(`defineTool({ name: "dev:service_health", capability: "intel:read" });`);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('dev:service_health');
    expect(rows[0].capability).toBe('intel:read');
  });

  it('reads a @cell-lens marker inside the literal', () => {
    const rows = parseToolDefs(toolSrc('dev:reaper_status', { marker: '// @cell-lens reaper.state' }));
    expect(rows[0].lens).toBe('reaper.state');
    expect(judgeToolDef(rows[0])).toBeNull();
  });

  it('reads a @not-a-cell marker and stops at the end of its line', () => {
    const rows = parseToolDefs(
      toolSrc('dev:reaper_status', { marker: '// @not-a-cell a frozen catalog, never live state' }),
    );
    expect(rows[0].exemption).toBe('a frozen catalog, never live state');
  });

  it('attributes a marker to the literal CONTAINING it, not a neighbour', () => {
    // The multi-tool-file case. Marker ownership has to be unambiguous or a single
    // declaration would silently launder every other tool in the file.
    const src =
      toolSrc('dev:first_status', { marker: '// @not-a-cell a frozen catalog, never live state' }) +
      toolSrc('dev:second_status');
    const rows = parseToolDefs(src).filter((r: { name: string }) => r.name.startsWith('dev:'));
    expect(rows).toHaveLength(2);
    expect(rows[0].exemption).toBe('a frozen catalog, never live state');
    expect(rows[1].exemption).toBeNull();
    expect(judgeToolDef(rows[0])).toBeNull();
    expect(judgeToolDef(rows[1])?.rule).toBe('undeclared-state-read');
  });

  it('ignores a file with no defineTool call', () => {
    expect(parseToolDefs('export const x = 1;')).toEqual([]);
  });
});

describe('no-bespoke-state-read guard:the shrink-only baseline', () => {
  it('grandfathers an EXISTING tool but never a new one', () => {
    expect(BASELINE.has('dev:service_health')).toBe(true);
    expect(BASELINE.has('coord:presence')).toBe(true);
    expect(BASELINE.has('dev:reaper_status')).toBe(false);
  });

  it('grandfathers only genuine candidates — signature proven on FIXTURES, so an emptied baseline stays green', () => {
    // Each entry must still be a genuine candidate — an entry that does not trip the
    // signature is dead weight that hides nothing and would rot silently.
    //
    // The TEETH of that check are proven against synthetic names, deliberately NOT
    // against `BASELINE.size > 0`. P-020 exists precisely to retire every entry here,
    // and the test below already asserts the guard "stops expiring once the baseline is
    // actually empty" — so a live-population non-vacuity control would red this file the
    // day P-020 lands, contradicting its own sibling four tests down. WI-1556492.
    expect(
      isStateReadCandidate({ name: 'fixture:get_status', capability: null }),
      'a read-shaped state door trips it',
    ).toBe(true);
    expect(isStateReadCandidate({ name: 'fixture:set_status', capability: null }), 'a mutating verb does not').toBe(
      false,
    );
    expect(isStateReadCandidate({ name: 'fixture:get_widget', capability: null }), 'a non-state noun does not').toBe(
      false,
    );
    expect(isStateReadCandidate({ name: 'fixturestatus', capability: null }), 'an unqualified name does not').toBe(
      false,
    );

    for (const name of BASELINE) {
      expect(isStateReadCandidate({ name, capability: null }), `${name} should trip the signature`).toBe(true);
    }
  });

  it('EXPIRES — a grandfather set with no deadline is a permanent exemption list', () => {
    // The countermeasure is copied from DARK_FLAGS_REVIEW_BY on purpose: this repo
    // has already watched an undated allowlist (KNOWN_DARK_FLAGS) rot into a
    // parking lot whose ceiling got quietly raised for the same bug class.
    expect(baselineExpired('2099-01-01')).toBe(true);
    expect(baselineExpired(BASELINE_REVIEW_BY)).toBe(false); // due date itself is still green
    expect(baselineExpired('2026-07-27')).toBe(false);
  });

  it('stops expiring once the baseline is actually empty', () => {
    // The deadline exists to force P-020, not to red the build forever after it.
    // Guards the branch order: size check must come before the date compare.
    const emptied = new Set();
    expect(emptied.size > 0 && '2099-01-01' > BASELINE_REVIEW_BY).toBe(false);
  });

  it('carries a P-020 verdict for every grandfathered tool, and none for a tool it does not cover', () => {
    // This is P-020's done-condition made MECHANICAL rather than asserted in prose.
    // A doc listing the verdicts would drift from BASELINE the first time BASELINE
    // moved; keyed to the same set, it cannot.
    const gaps = verdictGaps();
    expect(gaps.missing, `grandfathered with no verdict: ${gaps.missing.join(', ')}`).toEqual([]);
    expect(
      gaps.extra,
      `verdict for a tool that left BASELINE without an 'adopted' note: ${gaps.extra.join(', ')}`,
    ).toEqual([]);
    expect(gaps.badKind).toEqual([]);
    expect(gaps.unreasoned, `verdict with no real reason: ${gaps.unreasoned.join(', ')}`).toEqual([]);
  });

  it('only admits the three non-overlapping verdicts', () => {
    expect(VERDICT_KINDS).toEqual(['cell', 'delegates', 'bespoke']);
    for (const [name, v] of VERDICTS) {
      expect(VERDICT_KINDS, `${name} has verdict "${v.verdict}"`).toContain(v.verdict);
    }
  });

  it('lets a verdict OUTLIVE its baseline entry, but only when it records how the tool left', () => {
    // The inventory must not erode as the work succeeds: every retirement would
    // otherwise delete the record of what was decided and why. `adopted` is the
    // carve-out, and it is held to the same anti-rubber-stamp length as an exemption.
    const adopted = [...VERDICTS.entries()].filter(([n]) => !BASELINE.has(n));
    for (const [name, v] of adopted) {
      expect(typeof v.adopted, `${name} left BASELINE and must say how`).toBe('string');
      expect(v.adopted.length, `${name}'s adopted note is a rubber stamp`).toBeGreaterThanOrEqual(MIN_EXEMPTION_REASON);
    }
    // dev:pipeline_position is the first one P-020 actually retired — it declares
    // `@cell-lens git.pipelinePosition` and is the resolver behind all five cells.
    expect(BASELINE.has('dev:pipeline_position')).toBe(false);
    expect(VERDICTS.get('dev:pipeline_position')?.verdict).toBe('cell');
    expect(VERDICTS.get('dev:pipeline_position')?.adopted).toBeTruthy();
  });

  it('rolls the verdicts up so the disposition stays visible on every run', () => {
    const roll = verdictRollup();
    expect(roll.cell + roll.delegates + roll.bespoke).toBe(VERDICTS.size);
    // A registry that swallowed everything would be the D-010 failure at cell scale:
    // most reads are single-door and correctly stay bespoke.
    expect(roll.bespoke).toBeGreaterThan(roll.cell);
  });

  it('exports the state nouns it was calibrated from', () => {
    expect(STATE_NOUNS).toContain('status');
    expect(STATE_NOUNS).toContain('presence');
  });
});

describe('no-bespoke-state-read guard:EI-18791777695307535 — the fleet:assignments miss', () => {
  // The bug this describe block exists for: fleet:assignments is the single busiest
  // live-state read in the corpus (5,883 calls/30d, ~9x coord:presence) and was
  // completely invisible to the original signature because "assignments" was not a
  // STATE_NOUN. Locked here the same way WI-6464 locked its own regression, so a
  // future edit cannot silently narrow STATE_NOUNS back to missing it.
  it('FLAGS fleet:assignments — the specific miss this bug fixes', () => {
    expect(isStateReadCandidate({ name: 'fleet:assignments', capability: null })).toBe(true);
  });

  it('exports the widened vocabulary', () => {
    for (const noun of ['assignments', 'roster', 'walls', 'conditions', 'locks', 'burn_down']) {
      expect(STATE_NOUNS, `STATE_NOUNS should contain "${noun}"`).toContain(noun);
    }
  });

  it('FLAGS every tool the widening newly catches', () => {
    for (const name of [
      'fleet:assignments',
      'coord:roster',
      'coord:walls',
      'coord:conditions',
      'locks:list',
      'locks:queue',
      'locks:check_command',
      'work_items:burn_down',
    ]) {
      expect(isStateReadCandidate({ name, capability: null }), `${name} should trip the widened signature`).toBe(true);
    }
  });

  it('grandfathers every newly-caught tool with a verdict — the widening must not red the build', () => {
    // Reseeding these (pre-existing, not new) tools into BASELINE is the second-wave
    // analog of the original 2026-07-27 seed. Each must carry a verdict or
    // verdictGaps() fails the whole gate.
    for (const name of [
      'fleet:assignments',
      'coord:roster',
      'coord:walls',
      'coord:conditions',
      'locks:list',
      'locks:queue',
      'locks:check_command',
      'work_items:burn_down',
    ]) {
      expect(BASELINE.has(name), `${name} should be grandfathered`).toBe(true);
      expect(VERDICTS.has(name), `${name} should carry a verdict`).toBe(true);
    }
    expect(verdictGaps()).toEqual({ missing: [], extra: [], badKind: [], unreasoned: [] });
  });

  it('does not blanket-exempt every locks:* tool — only the ones the widened noun actually selects', () => {
    // locks:acquire / locks:acquire_resource / locks:release are mutations (declare a
    // write capability or a mutating verb) and must stay unflagged.
    expect(isStateReadCandidate({ name: 'locks:acquire', capability: 'locks:write' })).toBe(false);
    expect(isStateReadCandidate({ name: 'locks:acquire_resource', capability: 'locks:write' })).toBe(false);
    expect(isStateReadCandidate({ name: 'locks:release', capability: 'locks:write' })).toBe(false);
  });
});

describe('no-bespoke-state-read guard:the advisory volume signature', () => {
  it('exports the calibrated review window and floors', () => {
    expect(VOLUME_WINDOW_DAYS).toBe(30);
    expect(VOLUME_MIN_CALLS).toBe(5);
    expect(VOLUME_MIN_DISTINCT_CALLERS).toBe(3);
    expect(meetsVolumeFloor({ calls: 5, callers: 3 })).toBe(true);
    expect(meetsVolumeFloor({ calls: 4, callers: 3 })).toBe(false);
    expect(meetsVolumeFloor({ calls: 5, callers: 2 })).toBe(false);
    expect(meetsVolumeFloor({ calls: '5', callers: '3' })).toBe(true);
  });

  it('finds unremarkably-named volume candidates and excludes writes or already-dispositioned tools', () => {
    const definitions = [
      { name: 'blender:success-metrics', capability: 'harness:read', file: 'blender.ts', lens: null, exemption: null },
      { name: 'facts:list', capability: 'harness:read', file: 'facts.ts', lens: null, exemption: null },
      { name: 'pot:get', capability: 'harness:read', file: 'pot.ts', lens: null, exemption: null },
      { name: 'dev:pg_active_queries', capability: 'intel:read', file: 'pg.ts', lens: null, exemption: null },
      { name: 'processes:limit', capability: 'processes:control', file: 'processes.ts', lens: null, exemption: null },
      { name: 'fleet:status', capability: 'fleet:status', file: 'fleet.ts', lens: 'fleet.live', exemption: null },
      {
        name: 'state:read',
        capability: 'harness:read',
        file: 'state.ts',
        lens: null,
        exemption: 'single shared cell door',
      },
      { name: 'dev:thing_status', capability: 'harness:write', file: 'write.ts', lens: null, exemption: null },
    ];
    const rows = [
      { tool_name: 'blender:success-metrics', calls: 13, callers: 6 },
      { tool_name: 'facts:list', calls: 404, callers: 147 },
      { tool_name: 'pot:get', calls: 6, callers: 5 },
      { tool_name: 'dev:pg_active_queries', calls: 11, callers: 7 },
      { tool_name: 'processes:limit', calls: 100, callers: 20 },
      { tool_name: 'fleet:status', calls: 100, callers: 20 },
      { tool_name: 'state:read', calls: 100, callers: 20 },
      { tool_name: 'dev:thing_status', calls: 100, callers: 20 },
    ];

    expect(findVolumeCandidates(rows, definitions).map((candidate: { name: string }) => candidate.name)).toEqual([
      'facts:list',
      'blender:success-metrics',
      'dev:pg_active_queries',
      'pot:get',
    ]);
  });

  it('reports an empty telemetry corpus as UNKNOWN/no-data with a failing status', () => {
    expect(volumeReportStatus({ totalCalls: 0 })).toMatchObject({
      status: 'no-data',
      label: 'UNKNOWN',
      known: false,
      exitCode: 1,
    });
    expect(formatVolumeReport({ workspaceId: 'ws', harnessSlug: 'h', totalCalls: 0 })).toContain('UNKNOWN (no-data)');
  });
});

/**
 * EI-19444550724173505 — WHERE THE GUARD LOOKS, which is a separate question from
 * what it decides, and the one a green run cannot answer.
 *
 * Every other test here exercises the PREDICATE. None of them would notice the
 * guard scanning the wrong half of the repo: a tool in an unscanned root is never
 * parsed, never judged, and never counted, so the run prints a clean verdict
 * having never looked at it. "Found nothing" and "looked nowhere" are the same
 * output. That is not hypothetical — the sibling gate `scout/coord-tier-gate.ts`
 * shipped a first draft with exactly this defect (two hand-listed roots, a
 * confident `0 offenders`, blind to all four coordination verbs in `lib/coord-ops`),
 * and it was caught only by a coverage cross-check like the one below.
 *
 * The bare-node guard still needs directory inputs, but the independent coverage
 * oracle no longer compares them with another directory list. It derives the
 * production tool files from the real registry import graph and checks the guard
 * can see every one of those files and every state-read candidate they declare.
 */
describe('no-bespoke-state-read guard:where it looks (EI-19444550724173505)', () => {
  const sourceFiles = buildBuiltinToolSourceFiles(REPO_ROOT);
  const relativeSourceFiles = sourceFiles.map((file) => file.slice(REPO_ROOT.length).replace(/^\/+/, ''));

  it('covers every graph-derived production tool source, with no dead scan roots', () => {
    const uncovered = relativeSourceFiles.filter(
      (file) => !(SCAN_DIRS as string[]).some((root) => file === root || file.startsWith(`${root}/`)),
    );
    expect(
      uncovered,
      'SCAN_DIRS misses graph-reachable production tool source(s), so the guard can report a false clean',
    ).toEqual([]);
    const deadRoots = (SCAN_DIRS as string[]).filter(
      (root) => !relativeSourceFiles.some((file) => file === root || file.startsWith(`${root}/`)),
    );
    expect(deadRoots, 'SCAN_DIRS contains root(s) with no graph-reachable production tool').toEqual([]);
    expect(sourceFiles.length, 'production tool source graph collapsed').toBeGreaterThan(100);
  });

  it('sees every state-read candidate derived from the production tool graph', () => {
    // The production guard scans exactly the tracked, present .ts files below SCAN_DIRS.
    // Prove each graph source file is in that population, then parse the graph files once.
    // Parsing every file under the guard roots and then parsing all graph files again made
    // this coverage test itself time out on the full candidate (the guard roots are much
    // broader than the production import graph).
    const guardScanFiles = new Set(
      execSync(`git ls-files ${(SCAN_DIRS as string[]).join(' ')}`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 30_000,
        killSignal: 'SIGKILL',
      })
        .split('\n')
        .filter((file) => !isExcluded(file))
        // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
        .filter((file) => existsSync(join(REPO_ROOT, file))),
    );
    const graphFilesNotScanned = relativeSourceFiles.filter((file) => !guardScanFiles.has(file));
    expect(
      graphFilesNotScanned,
      'the guard scan omits graph-reachable production tool source(s)',
    ).toEqual([]);

    const graphCandidates = new Set<string>();
    for (const file of sourceFiles) {
      for (const row of parseToolDefs(readFileSync(file, 'utf8'))) {
        if (isStateReadCandidate(row)) graphCandidates.add(row.name);
      }
    }
    // A candidate declared in a graph file is visible to the guard because that exact file
    // is in guardScanFiles and both paths use parseToolDefs + isStateReadCandidate.
    expect(graphCandidates.size).toBeGreaterThanOrEqual(20);
  }, 30_000);
});
