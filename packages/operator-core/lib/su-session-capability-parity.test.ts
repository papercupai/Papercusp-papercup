/**
 * P-006 — cross-engine capability parity pin.
 *
 * Plan: pui-first-party-public-release-2026-09-07, item P-006:
 *   "Complete Claude/Codex/OMP parity behind the same host and PUI commands …
 *    unsupported capabilities produce an accurate in-PUI explanation."
 *
 * WHAT IS ALREADY PINNED WITHOUT THIS FILE, so nobody re-derives it:
 *   `SuSessionCapabilities` types both halves as a TOTAL record —
 *   `Readonly<Record<SuSessionCommandType, …>>` / `Readonly<Record<SuSessionFeature, …>>`
 *   over const-array-derived unions (libs/generic/chat-protocol/src/su-session.ts).
 *   A missing key is therefore a COMPILE error, and key-set parity across the three
 *   engines is enforced structurally. This file does not re-litigate that.
 *
 * WHAT THIS FILE PINS, which nothing else did:
 *   (a) `SuSessionCapabilitySupport` types `reason` as a bare `string`, so `""` — or a
 *       reason that merely restates the state — typechecks fine. P-006's "accurate
 *       in-PUI explanation" was therefore unenforced: an engine could declare a
 *       capability unsupported and hand the PUI nothing to show the owner.
 *   (b) the protocol's deliberate no-`simulated` doctrine (su-session.ts): unsupported
 *       backend behaviour must stay VISIBLE rather than be silently imitated.
 *
 * FALSIFIABILITY: `explanationDefect` is the subject under test, so this file keeps
 * deliberately-WRONG capability tables as permanent controls (`BROKEN_TABLES`) that the
 * guard must catch, plus a calibration case asserting the guard stays silent on a
 * well-formed entry. Without both, a guard that had degenerated into `return null`
 * would still show three green checkmarks against the real tables.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import {
  SU_EXEC_COMBINATIONS, SU_EXEC_INVENTORY, SU_EXEC_PTY_CONTROLS,
  SU_EXEC_CODEX_REQUESTS, SU_EXEC_CLAUDE_QUERY_METHODS, SU_EXEC_SCENARIOS,
  SU_EXEC_CLAUDE_REQUESTS, SU_EXEC_NATIVE_REQUESTS, SU_EXEC_REQUEST_SCENARIOS,
  SU_EXEC_CLAUDE_CONTROLS, SU_EXEC_CONTROL_SCENARIOS,
  suExecQualificationPopulation, suExecQualificationDefects,
} from './__fixtures__/su-execution-parity';

import {
  SU_SESSION_COMMAND_TYPES,
  SU_SESSION_FEATURES,
  type SuSessionCapabilities,
  type SuSessionCapabilitySupport,
} from '@papercusp/chat-protocol';

import { claudeCapabilities } from './su-session-claude-adapter';
import { codexCapabilities } from './su-session-codex-adapter';
import { ompCapabilities } from './su-session-omp-adapter';

const ENGINES: ReadonlyArray<readonly [string, SuSessionCapabilities]> = [
  ['claude', claudeCapabilities()],
  ['codex', codexCapabilities()],
  ['omp', ompCapabilities()],
];

describe('SU execution inventory (P-001; qualification is still unknown)', () => {
  it('SU-EXEC R-1 acceptance contract', () => {
    const ptySource = readFileSync(new URL('../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url), 'utf8');
    const decoder = ptySource.slice(ptySource.indexOf('export function decodeControl('));
    const decodedModes = [...new Set([...decoder.matchAll(/o\.mode === '([^']+)'/g)].map(match => match[1]))];
    expect(SU_EXEC_PTY_CONTROLS.map(control => control.mode).sort()).toEqual(decodedModes.sort());
    expect(SU_EXEC_COMBINATIONS.map(c => `${c.provider}/${c.execution}`).sort()).toEqual([
      'claude/programmatic', 'claude/pty', 'codex/programmatic', 'codex/pty',
    ]);
    expect(SU_EXEC_SCENARIOS.map(s => s.requirement)).toEqual(Array.from({ length: 19 }, (_, i) => `R-${i + 1}`));
    expect(SU_EXEC_CODEX_REQUESTS).toContain('item/permissions/requestApproval');
    expect(SU_EXEC_CODEX_REQUESTS).toContain('mcpServer/elicitation/request');
    expect(SU_EXEC_CLAUDE_QUERY_METHODS).toContain('reconnectMcpServer');
    expect(SU_EXEC_CLAUDE_QUERY_METHODS).toContain('backgroundTasks');
    for (const [provider, methods] of [['codex', SU_EXEC_CODEX_REQUESTS], ['claude', SU_EXEC_CLAUDE_REQUESTS]] as const) {
      expect(SU_EXEC_NATIVE_REQUESTS.filter(request => request.provider === provider).map(request => request.method).sort())
        .toEqual([...methods].sort());
    }
    expect(SU_EXEC_CLAUDE_CONTROLS.map(control => control.method)).toEqual([...SU_EXEC_CLAUDE_QUERY_METHODS]);
    for (const combination of SU_EXEC_COMBINATIONS) {
      const controls = SU_EXEC_CONTROL_SCENARIOS.filter(row => row.provider === combination.provider
        && row.execution === combination.execution);
      expect(controls.map(row => row.mode).sort()).toEqual(decodedModes.sort());
      for (const control of controls) {
        expect(control.boundary.length).toBeGreaterThan(20);
        expect(control.disposition).toBe(control.mode === 'compact' ? 'explicit-refusal'
          : ['raw', 'osc'].includes(control.mode)
            ? combination.execution === 'pty' ? 'terminal-presentation' : 'explicit-refusal'
            : 'semantic-equivalent');
        for (const target of [...control.testTargets, control.liveTestTarget]) {
          expect(readFileSync(new URL(`../../../${target}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
        }
      }
    }
    for (const scenario of [...SU_EXEC_SCENARIOS, ...SU_EXEC_REQUEST_SCENARIOS, ...SU_EXEC_CONTROL_SCENARIOS]) {
      expect(scenario.sources.length).toBeGreaterThan(0);
      expect(scenario.action.length).toBeGreaterThan(20);
      expect(scenario.falsifier.length).toBeGreaterThan(20);
      for (const source of scenario.sources) {
        expect(readFileSync(new URL(`../../../${source}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
      }
    }
    const population = suExecQualificationPopulation();
    expect(new Set(population.map(row => row.id)).size).toBe(population.length);
    expect(population.every(row => row.state === 'unknown' && row.evidenceRefs.length === 0)).toBe(true);
    expect(suExecQualificationDefects(population).length).toBeGreaterThan(0);
  });

  it('SU-EXEC R-18 inventory preflight', () => {
    expect(SU_EXEC_INVENTORY.replicationDoc).toBe('agent-insights/su-execution-backend-acceptance');
    expect(SU_EXEC_INVENTORY.evidencePolicy.mandatoryGapMayBeDeferred).toBe(false);
    const document = readFileSync(new URL('../../../apps/operator-docs/src/content/docs/agent-insights/su-execution-backend-acceptance.mdx', import.meta.url), 'utf8');
    for (const term of ['REPLICATION DRILL', 'Sensitive input handling', 'native-only', 'rollback', 'owner-required',
      'never persist plaintext secrets', 'explicit refusal', 'fixture revision']) {
      expect(document.toLowerCase()).toContain(term.toLowerCase());
    }
    expect(SU_EXEC_PTY_CONTROLS.filter(c => c.classification !== 'required')
      .every(c => 'boundary' in c && c.boundary.length > 20)).toBe(true);
    const files = ['packages/operator-core/lib/su-session-capability-parity.test.ts',
      'packages/operator-core/lib/su-session-attached-live.integration.test.ts'];
    const expectedSelectors = {
      selectionSource: 'criterion.check.cases',
      preflight: { files, cases: ['SU-EXEC R-1 acceptance contract', 'SU-EXEC R-18 inventory preflight'] },
      final: { files, cases: ['SU-EXEC R-18 final qualification'],
        requires: 'measured-population-and-receipt-validation' },
      accounting: { file: files[0], cases: ['rejects missing rows, false passes, changed scope and hidden PTY fallback'],
        scope: 'accounting-only' },
    };
    const selectorContractMatches = (text: string): boolean => {
      const block = text.match(/\{\/\* su-exec-selectors:begin \*\/\}\s*```json\s*([\s\S]*?)```\s*\{\/\* su-exec-selectors:end \*\/\}/);
      if (!block || text.includes('SU-EXEC R-18 acceptance contract')
        || text.includes('Each check uses the exact case title')) return false;
      try {
        return isDeepStrictEqual(JSON.parse(block[1]), expectedSelectors);
      } catch {
        return false;
      }
    };
    expect(selectorContractMatches(document), 'documented selectors must match the preflight/final contract').toBe(true);
    // These broken document controls reproduce the stale instruction and prove
    // that a missing accounting check or preflight masquerading as final fails.
    expect(selectorContractMatches(document.replaceAll('SU-EXEC R-18 inventory preflight',
      'SU-EXEC R-18 acceptance contract'))).toBe(false);
    expect(selectorContractMatches(document.replace('"scope": "accounting-only"', '"scope": "runtime-parity"'))).toBe(false);
    expect(selectorContractMatches(document.replace('"SU-EXEC R-18 final qualification"',
      '"SU-EXEC R-18 inventory preflight"'))).toBe(false);
  });

  it('rejects missing rows, false passes, changed scope and hidden PTY fallback', () => {
    // Synthetic receipts calibrate this structural guard; they are not runtime evidence.
    const complete = suExecQualificationPopulation().map(row => ({ ...row, state: 'passed' as const,
      actualExecution: row.execution, evidenceRefs: ['synthetic:positive-control'],
      negativeControlRefs: ['synthetic:negative-control'] }));
    expect(suExecQualificationDefects(complete)).toEqual([]);
    expect(suExecQualificationDefects(complete.slice(1))).toContainEqual(expect.stringContaining('missing'));
    const missingProof = complete.map((row, i) => i === 0 ? { ...row, evidenceRefs: [] } : row);
    expect(suExecQualificationDefects(missingProof)).toContainEqual(expect.stringContaining('proof incomplete'));
    const fallback = complete.map(row => row.execution === 'programmatic' ? { ...row, actualExecution: 'pty' as const } : row);
    expect(suExecQualificationDefects(fallback)).toContainEqual(expect.stringContaining('fallback'));
    const wrongVersion = complete.map((row, i) => i === 0 ? { ...row, nativeVersion: 'unqualified' } : row);
    expect(suExecQualificationDefects(wrongVersion)).toContainEqual(expect.stringContaining('nativeVersion changed'));
    const wrongSdk = complete.map(row => row.sdkVersion ? { ...row, sdkVersion: 'unqualified' } : row);
    expect(suExecQualificationDefects(wrongSdk)).toContainEqual(expect.stringContaining('sdkVersion changed'));
    const missingFamily = complete.filter(row => !row.scenario.endsWith('item/permissions/requestApproval'));
    expect(suExecQualificationDefects(missingFamily)).toContainEqual(expect.stringContaining('missing'));
    const missingControl = complete.filter(row => row.id !== 'codex/programmatic/pty-control:delivery-cancel');
    expect(suExecQualificationDefects(missingControl))
      .toContain('codex/programmatic/pty-control:delivery-cancel: missing or duplicate row');
    const unprovedRefusal = complete.map(row => row.id === 'claude/programmatic/pty-control:raw'
      ? { ...row, negativeControlRefs: [] } : row);
    expect(suExecQualificationDefects(unprovedRefusal))
      .toContain('claude/programmatic/pty-control:raw: proof incomplete');
    expect(suExecQualificationDefects([...complete, complete[0]]))
      .toContainEqual(expect.stringContaining('duplicate'));
  });
});

/**
 * Reasons that parse as prose but explain nothing to an owner staring at the PUI.
 * Matched after trimming, lowercasing and dropping one trailing `.`/`!`.
 */
const VACUOUS_REASONS = new Set([
  '',
  'n/a',
  'na',
  'none',
  'no',
  'todo',
  'tbd',
  'fixme',
  'unknown',
  'unsupported',
  'not supported',
  'unavailable',
  'not available',
  'not implemented',
  'see above',
]);

/** Shortest reason that could plausibly tell an owner WHY, rather than just THAT. */
const MIN_REASON_CHARS = 20;

/**
 * Returns a human-readable defect string when `entry` would leave the PUI unable to
 * explain itself, or `null` when the entry is well-formed. Pure, so the controls below
 * can exercise it without constructing an adapter.
 */
export function explanationDefect(entry: SuSessionCapabilitySupport): string | null {
  if (entry.state === 'supported') {
    // A supported capability needs no prose, but it must say who provides it, and the
    // protocol deliberately offers no "simulated" implementation.
    if (entry.implementation !== 'native' && entry.implementation !== 'host') {
      return `supported entry has implementation ${JSON.stringify(entry.implementation)}; expected native|host`;
    }
    return null;
  }

  const reason: unknown = (entry as { reason?: unknown }).reason;
  if (typeof reason !== 'string') return `state "${entry.state}" carries no reason string`;

  const trimmed = reason.trim();
  const normalized = trimmed.toLowerCase().replace(/[.!]$/, '');
  if (VACUOUS_REASONS.has(normalized)) {
    return `state "${entry.state}" has a vacuous reason ${JSON.stringify(trimmed)} — it restates the state instead of explaining it`;
  }
  if (trimmed.length < MIN_REASON_CHARS) {
    return `state "${entry.state}" reason is ${trimmed.length} chars (< ${MIN_REASON_CHARS}), too short to explain anything: ${JSON.stringify(trimmed)}`;
  }
  return null;
}

function entriesOf(table: SuSessionCapabilities): Array<[string, SuSessionCapabilitySupport]> {
  return [
    ...Object.entries(table.commands).map(
      ([k, v]) => [`commands.${k}`, v] as [string, SuSessionCapabilitySupport],
    ),
    ...Object.entries(table.features).map(
      ([k, v]) => [`features.${k}`, v] as [string, SuSessionCapabilitySupport],
    ),
  ];
}

describe('P-006 su-session capability parity', () => {
  it.each(ENGINES.map(([name]) => name))(
    '%s declares exactly the canonical command and feature key sets',
    (name) => {
      const table = ENGINES.find(([n]) => n === name)![1];
      // Structurally guaranteed by the total Record, but asserted at runtime so a
      // future `as unknown as SuSessionCapabilities` cast cannot quietly drop a key.
      expect(Object.keys(table.commands).sort()).toEqual([...SU_SESSION_COMMAND_TYPES].sort());
      expect(Object.keys(table.features).sort()).toEqual([...SU_SESSION_FEATURES].sort());
    },
  );

  it('all three engines agree on the key sets they publish', () => {
    const [first, ...rest] = ENGINES.map(([, table]) => entriesOf(table).map(([k]) => k).sort());
    for (const other of rest) expect(other).toEqual(first);
  });

  it.each(ENGINES.map(([name]) => name))(
    '%s gives the PUI a usable explanation for every non-supported capability',
    (name) => {
      const table = ENGINES.find(([n]) => n === name)![1];
      const defects = entriesOf(table)
        .map(([key, entry]) => {
          const defect = explanationDefect(entry);
          return defect ? `${name}.${key}: ${defect}` : null;
        })
        .filter((d): d is string => d !== null);
      expect(defects).toEqual([]);
    },
  );

  it('never declares a capability as simulated — unsupported behaviour stays visible', () => {
    for (const [name, table] of ENGINES) {
      for (const [key, entry] of entriesOf(table)) {
        const implementation = (entry as { implementation?: unknown }).implementation;
        expect(
          implementation === undefined || implementation === 'native' || implementation === 'host',
          `${name}.${key} declared implementation ${JSON.stringify(implementation)}`,
        ).toBe(true);
        // An unsupported capability must not claim an implementation at all.
        if (entry.state === 'unsupported') {
          expect(implementation, `${name}.${key} is unsupported but names an implementation`).toBe(
            undefined,
          );
        }
      }
    }
  });
});

/**
 * PERMANENT CONTROLS — deliberately-wrong entries that `explanationDefect` MUST catch.
 * If this block ever goes green-by-vacuity (e.g. the guard degenerates to `return null`)
 * these fail, which is the whole point: the assertions above would keep passing.
 */
const BROKEN_ENTRIES: ReadonlyArray<readonly [string, SuSessionCapabilitySupport]> = [
  ['empty reason', { state: 'unsupported', reason: '' } as SuSessionCapabilitySupport],
  ['whitespace-only reason', { state: 'unsupported', reason: '   ' } as SuSessionCapabilitySupport],
  [
    'reason restating the state',
    { state: 'unsupported', reason: 'Unsupported.' } as SuSessionCapabilitySupport,
  ],
  ['placeholder reason', { state: 'unsupported', reason: 'TODO' } as SuSessionCapabilitySupport],
  [
    'too-short reason',
    { state: 'conditional', implementation: 'native', reason: 'no fork' } as SuSessionCapabilitySupport,
  ],
  [
    'missing reason entirely',
    { state: 'conditional', implementation: 'native' } as unknown as SuSessionCapabilitySupport,
  ],
];

describe('P-006 capability-explanation guard is falsifiable', () => {
  it.each(BROKEN_ENTRIES.map(([label]) => label))('catches a %s', (label) => {
    const entry = BROKEN_ENTRIES.find(([l]) => l === label)![1];
    expect(explanationDefect(entry)).not.toBeNull();
  });

  // CALIBRATION: without this, every control above would also pass if the guard had
  // degenerated into "always report a defect", which is equally broken.
  it('stays silent on a well-formed conditional entry', () => {
    expect(
      explanationDefect({
        state: 'conditional',
        implementation: 'native',
        reason: 'requires the tracked session id and a live or reconciled managed runtime',
      }),
    ).toBeNull();
  });

  it('stays silent on a well-formed supported entry', () => {
    expect(explanationDefect({ state: 'supported', implementation: 'native' })).toBeNull();
  });
});
