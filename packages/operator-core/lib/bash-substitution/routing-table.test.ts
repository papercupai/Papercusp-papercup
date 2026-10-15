/**
 * The CLAUDE.md routing-table projection (plan `bash-to-tool-substitution-2026-07-26`,
 * P-019).
 *
 * Two failures are worth catching here, and they are different in kind:
 *
 *  1. THE PROJECTION IS WRONG — a row renders unreadably, a pipe breaks the
 *     column, an unproven pair leaks into prose that every agent reads. These are
 *     properties of `renderRoutingBlock`, tested directly.
 *
 *  2. THE COMMITTED FILE HAS DRIFTED — someone hand-edited the table, or changed a
 *     pair and did not regenerate. CI gates this via `gen:tool-routing:check`, but
 *     a red CI run is a slow, remote way to learn it, so the same assertion runs
 *     here against the real CLAUDE.md.
 *
 * The routing display fields also carry a completeness obligation: a pair that
 * reaches `equivalent` but has no readable routing row is enforced by the gate
 * while being invisible in the table, which is exactly the asymmetry P-019 exists
 * to remove. So the fields are asserted present and sane for every pair.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BEGIN_MARKER,
  deriveSubstitutionPrefilterHeads,
  renderShellPrefilterHeads,
  renderTsPrefilterHeads,
  SHELL_PREFILTER_BEGIN_MARKER,
  SHELL_PREFILTER_END_MARKER,
  spliceGeneratedRegion,
  TS_PREFILTER_BEGIN_MARKER,
  TS_PREFILTER_END_MARKER,
  // WI-38337 (D-010): the third routing surface — the hand-written table.
  parseStoragePolicyRoutingTable,
  STORAGE_POLICY_HEADING,
  // WI-1812795: narrows the join to verbs that compete to READ the relation.
  NON_RELATION_READ_VERBS,
  relationRoutingVerbs,
  type HandWrittenRoutingRow,
  END_MARKER,
  renderRoutingBlock,
  routingCell,
  spliceRoutingBlock,
} from './routing-table';
import { loadPairFixtures } from './corpus';
import { ALL_PAIRS, BASH_GATE_PAIRS } from './pairs';
import { isSqlPair } from './types';
import type { BashSubstitutionPair, SampledCommand, SqlSubstitutionPair, SubstitutionPair } from './types';
import { TOOL_ROUTING_BY_TABLE } from '../pg-read-query';

// lib/bash-substitution → lib → operator-core → packages → repo root (four).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

/** A minimal pair stub — only the fields the projection reads. */
const pair = (over: Partial<SubstitutionPair> = {}): SubstitutionPair =>
  ({
    id: 'test.pair',
    intentLabel: 'test-intent',
    bashPattern: /^nope/,
    toolName: 'some:tool',
    advisoryText: 'advisory',
    routing: { want: 'a thing', use: '`some:tool { arg }`', insteadOf: '`nope --flag`' },
    expectedVerdict: 'equivalent',
    cover: () => ({ covered: true }),
    ...over,
  }) as SubstitutionPair;

const sample = (atom: string): SampledCommand => ({
  sid: 'su-test',
  ts: '2026-01-01T00:00:00.000Z',
  atom,
});

describe('substitution prefilter projection', () => {
  it('derives both wrapper and bare heads when one pair accepts both spellings', () => {
    const optionalWrapper = pair({
      id: 'test.optional-wrapper',
      bashPattern: /^(?:npx\s+)?vitest\b/,
    }) as BashSubstitutionPair;

    expect(
      deriveSubstitutionPrefilterHeads([
        { pair: optionalWrapper, fixture: { sample: [sample('npx vitest run one.test.ts')] } },
      ]),
    ).toEqual(['npx', 'vitest']);
  });

  it('keeps phrase-routed npm pairs out of the broad head set', () => {
    const phraseRouted = pair({
      id: 'tests.router-files',
      bashPattern: /^npm\s+run\s+test:file\b/,
    }) as BashSubstitutionPair;

    expect(
      deriveSubstitutionPrefilterHeads([
        { pair: phraseRouted, fixture: { sample: [sample('npm run test:file -- one.test.ts')] } },
      ]),
    ).toEqual([]);
  });

  it('derives the current audited fixtures without broad npm and with bare optional binaries', () => {
    const heads = deriveSubstitutionPrefilterHeads(loadPairFixtures(BASH_GATE_PAIRS));
    expect(heads).toEqual([...heads].sort());
    expect(heads).toEqual(expect.arrayContaining(['npx', 'vitest', 'tsc']));
    expect(heads).not.toContain('npm');
  });

  // ── WI-2145714: gate 1 of the launch-site delivery chain ───────────────────
  // WI-2145718 made a LAUNCH_SITE_ADVISORY_INTENTS row deliverable in the
  // MATCHER. That alone delivered nothing, because this projection runs upstream
  // of it: no head here means the hook's local pre-filter short-circuits and the
  // `locks:check_command` round-trip never happens, so the matcher is never
  // reached. Measured before the fix (tool_invocations, 24h to 2026-09-05,
  // commands whose first atom is ps/pgrep/pidof): 10 reached the gate, all 10
  // only because they also carried an already-present head (grep/head); 0 bare.
  //
  // The member/non-member PAIR is the point. Test 1 alone would pass just as
  // happily if someone deleted the not-a-substitute filter outright — which is
  // exactly what D-069(b) forbids, because it would resurrect the ~5,100
  // Grep/Glob advisories D-007 suppressed. Only the second test can fail on that,
  // so the two must stay together.
  describe('launch-site advisory opt-in (WI-2145714)', () => {
    const launchSite = pair({
      id: 'process.ps-pgrep',
      intentLabel: 'host-job-liveness-query',
      bashPattern: /^(?:ps|pgrep)(?=\s|$)/,
      expectedVerdict: 'not-a-substitute',
    }) as BashSubstitutionPair;

    const plainNegative = pair({
      id: 'test.documented-negative',
      intentLabel: 'not-a-launch-site-intent',
      bashPattern: /^grepish\b/,
      expectedVerdict: 'not-a-substitute',
    }) as BashSubstitutionPair;

    it('derives heads for an opted-in not-a-substitute pair, so the hook actually calls the gate', () => {
      expect(
        deriveSubstitutionPrefilterHeads([
          { pair: launchSite, fixture: { sample: [sample('ps -p 4242'), sample('pgrep -f worker')] } },
        ]),
      ).toEqual(['pgrep', 'ps']);
    });

    it('CONTROL: a not-a-substitute pair that is NOT opted in still yields no heads (D-007 intact)', () => {
      expect(
        deriveSubstitutionPrefilterHeads([
          { pair: plainNegative, fixture: { sample: [sample('grepish --all')] } },
        ]),
      ).toEqual([]);
    });

    it('the real audited pairs put ps and pgrep in the committed head set', () => {
      const heads = deriveSubstitutionPrefilterHeads(loadPairFixtures(BASH_GATE_PAIRS));
      expect(heads).toEqual(expect.arrayContaining(['ps', 'pgrep']));
    });

    it('does NOT leak the launch-site pair into the CLAUDE.md routing table', () => {
      // Delivery and routing are separate questions. A launch-site advisory is
      // not a "use tool X instead of bash Y" row — its verdict is correct and its
      // advice concerns a DIFFERENT command — so renderRoutingBlock must keep
      // excluding it even though the pre-filter now admits it.
      expect(renderRoutingBlock([launchSite])).not.toContain('dev:processes');
      const committed = readFileSync(CLAUDE_MD, 'utf8');
      expect(committed).not.toContain('| `ps -p <pid>` / `pgrep -f <job>`');
    });
  });

  it('throws when an actionable pair has no matching fixture evidence', () => {
    const unmatched = pair({
      id: 'test.unmatched',
      bashPattern: /^never-matches\b/,
    }) as BashSubstitutionPair;

    expect(() =>
      deriveSubstitutionPrefilterHeads([
        { pair: unmatched, fixture: { sample: [sample('git status')] } },
      ]),
    ).toThrow(/produced no prefilter head/);
  });

  it('renders deterministic hook-native blocks', () => {
    expect(renderTsPrefilterHeads(['vitest', 'npx'])).toBe(
      `${TS_PREFILTER_BEGIN_MARKER}\n  'npx',\n  'vitest',\n${TS_PREFILTER_END_MARKER}`,
    );
    expect(renderShellPrefilterHeads(['vitest', 'npx'])).toBe(
      `${SHELL_PREFILTER_BEGIN_MARKER}\n    'npx',\n    'vitest',\n${SHELL_PREFILTER_END_MARKER}`,
    );
  });

  it('splices only a marked hook region and refuses missing or inverted markers', () => {
    const doc = `before\n${TS_PREFILTER_BEGIN_MARKER}\nold\n${TS_PREFILTER_END_MARKER}\nafter`;
    const block = renderTsPrefilterHeads(['git']);
    expect(
      spliceGeneratedRegion(
        doc,
        TS_PREFILTER_BEGIN_MARKER,
        TS_PREFILTER_END_MARKER,
        block,
        'test hook',
      ),
    ).toBe(`before\n${block}\nafter`);
    expect(() =>
      spliceGeneratedRegion('no markers', 'BEGIN', 'END', 'replacement', 'test hook'),
    ).toThrow(/markers not found/);
    expect(() =>
      spliceGeneratedRegion('END\nBEGIN', 'BEGIN', 'END', 'replacement', 'test hook'),
    ).toThrow(/precedes/);
  });
});

describe('routingCell', () => {
  it('escapes a pipe so it cannot break the column', () => {
    expect(routingCell('a `… | head` filter')).toBe('a `… \\| head` filter');
  });

  it('does NOT escape a backslash — markdown ignores escapes inside a code span', () => {
    // The bug this prevents: escaping to `\\d` renders LITERALLY as `\\d` inside a
    // code span, so the psql-describe row would advertise the wrong command.
    expect(routingCell('`psql -c "\\d table"`')).toBe('`psql -c "\\d table"`');
  });

  it('collapses whitespace so a cell can never span lines', () => {
    expect(routingCell('a\n  multi   line\tcell')).toBe('a multi line cell');
  });
});

describe('renderRoutingBlock', () => {
  it('emits one row per pair, in registry order', () => {
    const block = renderRoutingBlock([
      pair({ routing: { want: 'first', use: '`a`', insteadOf: '`x`' } }),
      pair({ routing: { want: 'second', use: '`b`', insteadOf: '`y`' } }),
    ]);
    expect(block.indexOf('first')).toBeLessThan(block.indexOf('second'));
    expect(block).toContain('| first | `a` | `x` |');
  });

  it('is wrapped in the marker pair and carries the do-not-edit warning', () => {
    const block = renderRoutingBlock([pair()]);
    expect(block.startsWith(BEGIN_MARKER)).toBe(true);
    expect(block.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(block).toContain('gen:tool-routing');
  });

  // EI-19463947683316510 — the INVERSE of the D-001 harm described below. That one is
  // advertising a tool that cannot do the job; this one is advertising a tool that CAN,
  // to a reader whose surface cannot LOAD it. An su session's ToolSearch returns nothing
  // for `testing:run` (verified: both the exact `select:` name and a keyword search), so
  // an agent following a row reasonably concludes the guidance is wrong and falls back to
  // the `not` column — the exact bash fallback this table exists to prevent. The tool is
  // in fact fully reachable via `tools:invoke` (verified end-to-end: it ran the suite and
  // returned passed=10). So the table must carry the access path, not just the tool name.
  it('tells a trimmed surface how to reach a tool ToolSearch cannot load', () => {
    const block = renderRoutingBlock([pair()]);
    expect(block).toContain('tools:invoke');
  });

  // D-001, one layer up: a pattern whose replacement is unproven is not enforced,
  // so it must not be ADVERTISED either. Advertising it would send every agent to
  // a tool that cannot do the job — the same harm, delivered by prose.
  it.each(['needs-widening', 'not-a-substitute', 'unaudited'] as const)(
    'OMITS a %s pair — unproven routing never reaches the prose',
    (verdict) => {
      const block = renderRoutingBlock([
        pair({ expectedVerdict: verdict, routing: { want: 'UNPROVEN', use: '`t`', insteadOf: '`b`' } }),
      ]);
      expect(block).not.toContain('UNPROVEN');
    },
  );

  it('keeps an equivalent pair alongside an omitted one', () => {
    const block = renderRoutingBlock([
      pair({ expectedVerdict: 'needs-widening', routing: { want: 'DROPPED', use: '`t`', insteadOf: '`b`' } }),
      pair({ expectedVerdict: 'equivalent', routing: { want: 'KEPT', use: '`t`', insteadOf: '`b`' } }),
    ]);
    expect(block).not.toContain('DROPPED');
    expect(block).toContain('KEPT');
  });

  // WI-10006543: an equivalent pair whose call is not yet served by the deployed
  // operator is withheld; a held-at-observe pair is still routed (git-read).
  it('OMITS an equivalent pair that sets routingWithheld, but not a held one', () => {
    const block = renderRoutingBlock([
      pair({ expectedVerdict: 'equivalent', routingWithheld: 'not deployed', routing: { want: 'WITHHELD', use: '`t`', insteadOf: '`b`' } }),
      pair({ expectedVerdict: 'equivalent', holdAtObserve: 'held', routing: { want: 'HELD', use: '`t`', insteadOf: '`b`' } }),
    ]);
    expect(block).not.toContain('WITHHELD');
    expect(block).toContain('HELD');
  });

  it('renders a table with no row spilling extra columns', () => {
    const block = renderRoutingBlock(ALL_PAIRS);
    const rows = block.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| you want'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 3 columns → exactly 4 unescaped pipes. A raw pipe in a cell would add more.
      const unescaped = (row.match(/(?<!\\)\|/g) ?? []).length;
      expect(unescaped, `row has ${unescaped} unescaped pipes: ${row}`).toBe(4);
    }
  });
});

describe('spliceRoutingBlock', () => {
  it('replaces only the marked region, preserving the surrounding prose', () => {
    const doc = `before\n${BEGIN_MARKER}\nold\n${END_MARKER}\nafter\n`;
    const out = spliceRoutingBlock(doc, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);
    expect(out).toBe(`before\n${BEGIN_MARKER}\nnew\n${END_MARKER}\nafter\n`);
    expect(out).not.toContain('old');
  });

  it('is idempotent — splicing the same block twice changes nothing', () => {
    const block = renderRoutingBlock(ALL_PAIRS);
    const doc = `before\n${BEGIN_MARKER}\n${END_MARKER}\nafter\n`;
    const once = spliceRoutingBlock(doc, block);
    expect(spliceRoutingBlock(once, block)).toBe(once);
  });

  it('throws a directive error when the markers are missing, rather than silently doing nothing', () => {
    expect(() => spliceRoutingBlock('no markers here', 'x')).toThrow(/markers not found/);
  });

  it('throws when the markers are inverted', () => {
    expect(() => spliceRoutingBlock(`${END_MARKER}\n${BEGIN_MARKER}`, 'x')).toThrow(
      /precedes/,
    );
  });
});

describe('every audited pair carries a usable routing row', () => {
  it.each(ALL_PAIRS.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    for (const [field, value] of Object.entries(p.routing)) {
      expect(value.trim(), `${p.id}.routing.${field} is empty`).not.toBe('');
      // A table cell, not a paragraph — the advisoryText is where prose belongs.
      expect(value.length, `${p.id}.routing.${field} is too long for a table cell`).toBeLessThan(300);
      expect(value, `${p.id}.routing.${field} spans lines`).not.toContain('\n');
    }
    // The tool the row points at must be the tool the gate enforces, or the table
    // teaches a different routing than the hook applies.
    expect(p.routing.use).toContain(p.toolName);
  });
});

/**
 * The routing cell must not recommend a WEAKER call than the pair's own evidence
 * proved equivalent.
 *
 * `cover()` earns its `equivalent` verdict by translating each sampled command
 * into a concrete call — arguments included. `routing.use` is prose, written by
 * hand, and nothing tied the two together: a cell could name the right verb (the
 * assertion directly above) while silently dropping an argument every sampled
 * command carried. The verb is then right and the ANSWER is wrong, which is worse
 * than a missing row — an agent follows the table, gets a well-formed result about
 * the wrong subject, and has no reason to doubt it.
 *
 * Measured instance (EI-21154409410297616): every atom in `sql.gate-health`
 * scopes by `install_slug='papercusp'`, and `gateHealthCallFromQuery` faithfully
 * emits `installSlug`. The table cell said `routines:list { name:'green-checkpoint' }`.
 * On this box that returns one row per INSTALL (21), the payload shaper truncates
 * to 12, and row 1 is another pot's gate reading `consecutiveReds: 0` — healthy.
 * An agent triaging a 35-red shared gate read row 1 and reported it green.
 *
 * UNANIMITY is the test, not mere presence: an argument only some atoms carry is a
 * genuinely optional narrowing and belongs in `advisoryText`, not the 300-char
 * cell. One that EVERY covered atom carries is part of what the sample proved, and
 * omitting it makes the recommendation unfaithful to its own evidence.
 */
describe('a routing cell recommends no weaker a call than cover() verified', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

  /** Argument keys in a rendered `verb { a: 1, b: 2 }` expression. */
  const argKeysOf = (expression: string): string[] =>
    [...(/\{([\s\S]*)\}/.exec(expression)?.[1] ?? '').matchAll(/(\w+)\s*:/g)].map((m) => m[1]!);

  /**
   * The whole check, as one pure function, so the control below exercises THIS
   * logic rather than a copy of it that could drift into agreeing with itself.
   */
  const missingUnanimousArgs = (
    pair: Pick<SubstitutionPair, 'cover' | 'routing'>,
    atoms: readonly string[],
  ): string[] => {
    const coveredKeys = atoms
      .map((a) => pair.cover(a))
      .filter((r): r is { covered: true; expression: string } => r.covered && !!r.expression)
      .map((r) => argKeysOf(r.expression));
    if (coveredKeys.length === 0) return [];
    const unanimous = coveredKeys[0]!.filter((k) => coveredKeys.every((keys) => keys.includes(k)));
    return unanimous.filter((k) => !pair.routing.use.includes(k));
  };

  /**
   * FALSIFIABILITY CONTROL — a pair whose cell unanimously omits `installSlug`.
   *
   * Without this, a guard that silently stopped detecting anything (a broken
   * `argKeysOf` regex, a `cover()` shape change) would keep reporting green over
   * the real registry and be indistinguishable from a registry that is simply
   * correct. The calibration case beside it fails the control for the OPPOSITE
   * reason — it proves a passing verdict still means something.
   */
  const CONTROL_ATOMS = [
    "SELECT metadata->'gate_health' FROM harness_shared.routines WHERE install_slug='papercusp'",
    "SELECT metadata->'gate_health' FROM harness_shared.routines WHERE install_slug='oddsmith'",
  ];
  const controlCover = (atom: string) => ({
    covered: true as const,
    expression: `routines:list { name: "green-checkpoint", installSlug: "${/install_slug='([^']+)'/.exec(atom)![1]}" }`,
  });

  it('CONTROL: flags a cell that drops an argument every sampled atom carries', () => {
    expect(
      missingUnanimousArgs(
        { cover: controlCover, routing: { want: '', use: '`routines:list { name: ... }`', insteadOf: '' } },
        CONTROL_ATOMS,
      ),
    ).toEqual(['installSlug']);
  });

  it('CALIBRATION: passes the same cell once it names the argument', () => {
    expect(
      missingUnanimousArgs(
        {
          cover: controlCover,
          routing: { want: '', use: '`routines:list { name: ..., installSlug: ... }`', insteadOf: '' },
        },
        CONTROL_ATOMS,
      ),
    ).toEqual([]);
  });

  const withFixtures = ALL_PAIRS.filter((p) => existsSync(join(FIXTURES, `${p.id}.sample.json`)));

  // A guard over an empty set silently passes; assert the population is real.
  it('has pairs with fixtures to check', () => {
    expect(withFixtures.length).toBeGreaterThan(3);
  });

  it.each(withFixtures.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, `${p.id}.sample.json`), 'utf8'),
    ) as { sample: Array<{ atom: string }> };

    const coveredKeys = fixture.sample
      .map((s) => p.cover(s.atom))
      .filter((r): r is { covered: true; expression: string } => r.covered && !!r.expression)
      .map((r) => argKeysOf(r.expression));

    // Nothing covered ⇒ this pair's faithfulness is another test's job.
    if (coveredKeys.length === 0) return;

    const unanimous = coveredKeys[0]!.filter((k) => coveredKeys.every((keys) => keys.includes(k)));

    for (const key of unanimous) {
      expect(
        p.routing.use,
        `${p.id}.routing.use omits \`${key}\`, which cover() emits for ALL ${coveredKeys.length} covered sample atom(s). ` +
          `The cell would have an agent run a broader call than the one this pair proved equivalent.`,
      ).toContain(key);
    }
  });
});

/**
 * D-006's "the two must never disagree about a relation's verb", as a guard.
 *
 * There are TWO surfaces telling an agent which verb answers a relation, and
 * they are reached at different moments: `TOOL_ROUTING_BY_TABLE` fires live, at
 * the instant a hand-written query is submitted, and the CLAUDE.md routing rows
 * are read ambiently in the prompt. A SQL pair that reaches `equivalent` has
 * EARNED its verb against frozen evidence — so the live advisory must not be
 * silent about that relation, and must not name a different verb.
 *
 * The silent case is the one that actually happened: `schema_migrations` and
 * `test_runs` had audited pairs and CLAUDE.md rows while the live map had no
 * entry at all, so the agent most in need of the nudge — the one mid-query —
 * was the only one who never saw it. `engineer_issues` had the other failure,
 * an entry naming a verb that cannot express the shape being routed.
 *
 * Catalog relations are exempt BY NAME: `information_schema.columns` routes to
 * `dev:pg_query { describe }`, and the map is keyed on the BARE relation, which
 * for those pairs would be `columns`/`tables` — words far too generic to key a
 * live advisory on without colliding with an unrelated papercusp table.
 */
describe('an equivalent SQL pair is not contradicted by the live routing advisory', () => {
  const CATALOG_EXEMPT = new Set(['information_schema.columns', 'information_schema.tables']);
  const auditedSqlPairs = ALL_PAIRS.filter(
    (p) => isSqlPair(p) && p.expectedVerdict === 'equivalent' && !CATALOG_EXEMPT.has(p.relation),
  ) as SqlSubstitutionPair[];

  it('covers at least the audited relations (a silent map is the failure being guarded)', () => {
    // `routines` joined the tranche-2 three with the gate-health pair
    // (EI-20285616516435031); `work_items` joined TWICE with
    // EI-20285223214931386, because one relation split into two intents — a
    // by-id read served by `work_items:get` and a typed slice served by
    // `work_items:list`. Listing them EXACTLY, rather than asserting a
    // minimum, is the point: a new equivalent SQL pair must not slip in without
    // someone confirming the live in-query advisory speaks about its relation
    // too. That confirmation is the per-pair check immediately below; this
    // assertion is what forces a human past it.
    expect(auditedSqlPairs.map((p) => p.relation).sort()).toEqual([
      'engineer_issues',
      'routines',
      'schema_migrations',
      'test_runs',
      'work_items',
      'work_items',
    ]);
  });

  /**
   * The check itself, as a function, so it can be run against a DELIBERATELY
   * BROKEN map below. A guard that has only ever been run against a passing
   * input has not been shown to be capable of failing — and the repo's
   * falsifiability discipline forbids proving that by mutating the real map,
   * since git-sync would happily commit the mutant mid-probe.
   */
  const disagreement = (p: SqlSubstitutionPair, map: Record<string, { tool: string }>): string | null => {
    const route = map[p.relation];
    if (!route) return `no row for ${p.relation}`;
    if (!route.tool.includes(p.toolName)) return `${p.relation} names "${route.tool}", not ${p.toolName}`;
    return null;
  };

  it.each(auditedSqlPairs.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    expect(
      disagreement(p, TOOL_ROUTING_BY_TABLE),
      `the live advisory contradicts (or is silent about) an audited pair — CLAUDE.md and the in-query nudge would teach different verbs for ${p.relation}`,
    ).toBeNull();
  });

  it('CONTROL: the same check FAILS on a map that is silent about the relation', () => {
    const pair = auditedSqlPairs[0]!;
    expect(disagreement(pair, {})).toMatch(/no row for/);
  });

  it('CONTROL: the same check FAILS on a map naming a different verb', () => {
    const pair = auditedSqlPairs[0]!;
    expect(disagreement(pair, { [pair.relation]: { tool: 'some:other-verb' } })).toMatch(/not /);
  });
});

/**
 * WI-38337 / D-010 — the SAME agreement rule, applied to the third surface.
 *
 * The sibling block above guards the LIVE in-query advisory. This one guards
 * CLAUDE.md's HAND-WRITTEN storage-policy table, which until now no test read at
 * all: a row could route `work_items` to some other verb while an audited pair
 * routes it to `work_items:list`, and the suite would stay green.
 *
 * THE RULE IS CONDITIONAL, and that is D-010's whole point. Coverage may differ
 * freely — a hand-written row naming a relation NO pair covers is honest
 * intent-level guidance (`harness_plans` → `plans:list`), and a pair with no row
 * is fine too. A CONTRADICTION is narrower: the row names a relation an audited
 * pair DOES cover, names a verb, and that verb is none of the pair's.
 */
describe('the hand-written storage-policy table is not contradicted by an audited pair', () => {
  const sqlPairs = ALL_PAIRS.filter(
    (p) => isSqlPair(p) && p.expectedVerdict === 'equivalent',
  ) as SqlSubstitutionPair[];
  const byRelation = new Map<string, SqlSubstitutionPair[]>();
  for (const p of sqlPairs) byRelation.set(p.relation, [...(byRelation.get(p.relation) ?? []), p]);
  const relations = [...byRelation.keys()];
  const rows = (): HandWrittenRoutingRow[] =>
    parseStoragePolicyRoutingTable(readFileSync(CLAUDE_MD, 'utf8'), relations);

  /**
   * The check as a function, so the CONTROLs below can run it against a
   * deliberately-wrong row — the same falsifiability discipline as the live-map
   * guard, and for the same reason: mutating the real CLAUDE.md to prove a guard
   * can fail is unsafe here, because git-sync sweeps the tree mid-probe.
   */
  const contradiction = (row: HandWrittenRoutingRow): string | null => {
    // WI-1812795: score only the verbs that COMPETE to read the relation. A row
    // recommending `state:read` answers from the registered-cell plane and is not
    // offering a rival way to read the table — see NON_RELATION_READ_VERBS for
    // why that is a narrowing of the join and not a hole in it.
    const verbs = relationRoutingVerbs(row);
    if (verbs.length === 0) return null; // routes nothing that reads this relation
    for (const rel of row.relations) {
      const pairs = byRelation.get(rel);
      if (!pairs) continue; // coverage may differ — only disagreement is a defect
      const expected = pairs.map((p) => p.toolName);
      if (!verbs.some((v) => expected.includes(v))) {
        return `"${row.want}" routes ${rel} to ${verbs.join(' / ')}, but the audited pair(s) say ${expected.join(' / ')}`;
      }
    }
    return null;
  };

  it('parses the real table', () => {
    expect(rows().length).toBeGreaterThan(3);
  });

  /**
   * CALIBRATION, and the assertion most likely to save this guard from itself.
   * Every agreement check below is vacuous unless at least one row actually JOINS
   * a pair-covered relation — and a row can stop joining silently, by a reworded
   * `not` cell that no longer names the relation. If this fails because the table
   * legitimately dropped its `work_items` row, that is a one-line fix; a guard
   * that quietly stopped checking anything is not.
   */
  it('CALIBRATION: at least one row actually joins a pair-covered relation', () => {
    const joined = rows().filter((r) => r.relations.some((rel) => byRelation.has(rel)));
    expect(joined.length, 'no hand-written row names a relation any audited pair covers').toBeGreaterThan(0);
  });

  it('no row contradicts an audited pair', () => {
    for (const row of rows()) {
      expect(contradiction(row), 'CLAUDE.md would teach a different verb than the enforced pair').toBeNull();
    }
  });

  it('CONTROL: the same check FAILS on a row routing a covered relation elsewhere', () => {
    const pair = sqlPairs.find((p) => p.relation === 'work_items')!;
    expect(
      contradiction({
        want: 'a filtered slice',
        use: '`issues:list`',
        not: `a hand-written \`harness_shared.${pair.relation}\` query`,
        verbs: ['issues:list'],
        relations: [pair.relation],
      }),
    ).toMatch(/but the audited pair\(s\) say/);
  });

  /**
   * WI-1812795 — the state-plane exemption must NARROW the join, not open a hole.
   *
   * These three run together on purpose. The first is the real-world shape the
   * exemption exists for (a lone state:read row); the second proves the exemption
   * does not travel — the moment a row ALSO names a verb that genuinely competes
   * to read the relation, it contradicts exactly as before; the third pins the
   * list itself small, so "add your verb here" can never become the way a failing
   * row gets quietly excused.
   */
  it('a row answering from the state plane alone does NOT contradict a relation pair', () => {
    const pair = sqlPairs.find((p) => p.relation === 'work_items')!;
    expect(
      contradiction({
        want: 'a live value, not a table read',
        use: "`state:read { cell:'some.registered.cell' }`",
        not: `ANY hand-written \`${pair.relation}\` query`,
        verbs: ['state:read'],
        relations: [pair.relation],
      }),
    ).toBeNull();
  });

  it('CONTROL: the exemption does NOT travel — a state:read row that also names a competing verb still contradicts', () => {
    const pair = sqlPairs.find((p) => p.relation === 'work_items')!;
    expect(
      contradiction({
        want: 'a live value, and also a rival way to read the table',
        use: "`state:read { cell:'some.registered.cell' }` or `issues:list`",
        not: `ANY hand-written \`${pair.relation}\` query`,
        verbs: ['state:read', 'issues:list'],
        relations: [pair.relation],
      }),
    ).toMatch(/but the audited pair\(s\) say/);
  });

  it('the state-plane exemption stays tiny, and never swallows a pair tool', () => {
    expect(NON_RELATION_READ_VERBS.length).toBeLessThanOrEqual(2);
    // Exempting a verb an audited pair actually routes TO would silence the guard
    // for that pair entirely — the one way this list could become a hole.
    const pairTools = new Set(sqlPairs.map((p) => p.toolName));
    for (const verb of NON_RELATION_READ_VERBS) {
      expect(pairTools.has(verb), `${verb} is an audited pair's own tool — exempting it would silence the guard`).toBe(false);
    }
    // And the helper must actually filter, or every assertion above is vacuous.
    expect(relationRoutingVerbs({
      want: '', use: '', not: '', verbs: ['state:read', 'issues:list'], relations: [],
    })).toEqual(['issues:list']);
  });

  it('CONTROL: a relation NO pair covers is not a contradiction (coverage may differ)', () => {
    expect(
      contradiction({
        want: 'what plans exist',
        use: '`plans:list`',
        not: 'a hand-written `harness_shared.harness_plans` query',
        verbs: ['plans:list'],
        relations: [],
      }),
    ).toBeNull();
  });

  // Both failure modes THROW rather than returning [], because an empty parse
  // makes every assertion above pass while checking nothing — the exact shape of
  // the defect this guard was filed for.
  it('CONTROL: the parser THROWS rather than silently finding nothing', () => {
    expect(() => parseStoragePolicyRoutingTable('# a doc with no such heading\n', relations)).toThrow(
      /not found in CLAUDE\.md/,
    );
    expect(() => parseStoragePolicyRoutingTable(`${STORAGE_POLICY_HEADING}\n\nprose only.\n`, relations)).toThrow(
      /no table rows under it/,
    );
  });

  /**
   * END-TO-END falsifier. The CONTROLs above hand-build their row, which proves
   * `contradiction()` can fail but bypasses the PARSER — so a parser that never
   * extracted a verb or a relation would still let them pass. This one feeds real
   * markdown through the real parser and requires the contradiction to surface.
   */
  it('CONTROL: a contradicting row written as MARKDOWN is caught end-to-end', () => {
    const doc = `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n| a filtered slice | \`issues:list\` | a hand-written \`harness_shared.work_items\` query |\n`;
    const [row] = parseStoragePolicyRoutingTable(doc, relations);
    expect(row!.relations).toContain('work_items');
    expect(row!.verbs).toContain('issues:list');
    expect(contradiction(row!)).toMatch(/but the audited pair\(s\) say/);
  });

  /**
   * A KNOWN IMPRECISION, pinned rather than papered over: verb extraction is a
   * best-effort read of the `use` cell, so a cell that MENTIONS a colon-form
   * token in explanatory text (rather than as a routing target) yields that
   * token as a verb. It is inert — `contradiction()` only consults `verbs` for a
   * row that names a pair-covered relation, and such a row need not name one.
   * The residual risk is one-directional and narrow: since a row passes when ANY
   * named verb matches (correct — a cell may legitimately name two, as the
   * prose/full-text row does), a spurious verb can only ever MASK a
   * contradiction, never invent one.
   *
   * Driven through a FIXTURE, deliberately — this is a property of the PARSER.
   * It was previously pinned to the live gitnexus row, whose explanatory text
   * happened to contain the literal `server:verb`, and was found by matching the
   * prose `want` cell for "code graph". D-042 later reworded that row to
   * "(dot, not colon)", which REMOVED the imprecision entirely; the `find()`
   * then returned undefined and the non-null assertion crashed with a TypeError,
   * holding the green-checkpoint gate red (WI-40232). A parser property must not
   * depend on doc prose the doc is free to improve.
   */
  it('a spurious verb extracted from explanatory prose is inert', () => {
    const doc =
      `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n` +
      '| topology | `gitnexus.context` — not the usual `server:verb` form | `gitnexus.query` |\n';
    const [row] = parseStoragePolicyRoutingTable(doc, relations);
    expect(row!.verbs, 'the parser reads a colon-form token out of explanatory prose').toContain(
      'server:verb',
    );
    expect(row!.relations, 'this row names no pair-covered relation').toEqual([]);
    expect(
      contradiction(row!),
      'a spurious verb on a row naming no covered relation cannot invent a contradiction',
    ).toBeNull();
  });

  /**
   * The LIVE gitnexus row, addressed by a STABLE identity — the `use` cell names
   * `gitnexus.context` — rather than by prose in the `want` cell, which is what
   * broke before. D-042 routes topology questions to `gitnexus.context`/`.impact`
   * and warns OFF the raw `gitnexus.query` backend. Because those are dot-form,
   * the cell yields no colon-form verb at all, so the row routes nothing and
   * cannot contradict a pair. Asserting `verbs` is empty is what would notice if
   * the imprecision ever came BACK into this row.
   */
  it('the live gitnexus row routes nothing extractable and contradicts nothing', () => {
    const gitnexus = rows().find((r) => r.use.includes('gitnexus.context'));
    expect(gitnexus, 'CLAUDE.md no longer has a storage-policy row naming gitnexus.context').toBeDefined();
    expect(gitnexus!.verbs, 'dot-form tool names must not parse as colon-form verbs').toEqual([]);
    expect(gitnexus!.relations).toEqual([]);
    expect(contradiction(gitnexus!)).toBeNull();
  });

  // The view `work_items_claimable` is NOT the relation `work_items`. A substring
  // match would read the claimable row as routing `work_items` to
  // `work_items:claimable` and report a false contradiction against the pairs.
  it('does not read `work_items_claimable` as the `work_items` relation', () => {
    const parsed = parseStoragePolicyRoutingTable(
      `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n| claimable | \`work_items:claimable\` | the \`work_items_claimable\` view |\n`,
      relations,
    );
    expect(parsed[0]!.relations).toEqual([]);
    expect(contradiction(parsed[0]!)).toBeNull();
  });
});

describe('the committed CLAUDE.md table matches the pairs', () => {
  // Same assertion as `npm run gen:tool-routing:check`, run locally so a stale
  // table is caught by the ordinary test run instead of only by remote CI.
  it('is in sync — run `npm run gen:tool-routing` if this fails', () => {
    const current = readFileSync(CLAUDE_MD, 'utf8');
    expect(current).toContain(BEGIN_MARKER);
    expect(spliceRoutingBlock(current, renderRoutingBlock(ALL_PAIRS))).toBe(current);
  });

  it('advertises every equivalent pair by tool name', () => {
    const current = readFileSync(CLAUDE_MD, 'utf8');
    for (const p of ALL_PAIRS.filter((x) => x.expectedVerdict === 'equivalent')) {
      expect(current, `CLAUDE.md does not mention ${p.toolName}`).toContain(p.toolName);
    }
  });
});

describe('the committed prefilter head sets match the pairs', () => {
  // EI-18704153588567089: adding a pair used to need three hand-edits, and a missed
  // one froze the green gate (2026-07-26, candidate 45a059cd). `gen:tool-routing`
  // now projects both zero-import hook copies, but unlike the CLAUDE.md table above
  // they had no assertion in the ordinary test run -- drift was caught only by
  // remote CI. These run the generator's own staleness predicate
  // (scripts/gen-tool-routing.ts:152 `current !== expected`) locally, using the
  // same imported functions rather than a copy that could drift into agreeing
  // with itself.
  const heads = deriveSubstitutionPrefilterHeads(loadPairFixtures(BASH_GATE_PAIRS));

  const projections = () => [
    {
      label: 'Claude shell substitution prefilter',
      path: join(REPO_ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh'),
      begin: SHELL_PREFILTER_BEGIN_MARKER,
      end: SHELL_PREFILTER_END_MARKER,
      block: renderShellPrefilterHeads(heads),
    },
    {
      label: 'OMP TypeScript substitution prefilter',
      path: join(REPO_ROOT, 'apps/operator/scripts/hooks/omp/coord-hook.ts'),
      begin: TS_PREFILTER_BEGIN_MARKER,
      end: TS_PREFILTER_END_MARKER,
      block: renderTsPrefilterHeads(heads),
    },
  ];

  const isStale = (current: string, p: ReturnType<typeof projections>[number]): boolean =>
    current !== spliceGeneratedRegion(current, p.begin, p.end, p.block, p.label);

  for (const p of projections()) {
    it(`${p.label} is in sync — run \`npm run gen:tool-routing\` if this fails`, () => {
      const current = readFileSync(p.path, 'utf8');
      expect(current, `${p.path} is missing the generated markers`).toContain(p.begin);
      expect(isStale(current, p)).toBe(false);
    });

    // The control that makes the assertion above falsifiable: a guard that has
    // never failed is a guard nobody has tested. Removing one generated head MUST
    // read as stale -- otherwise the parity check passes vacuously and the gate
    // freeze this item was filed for could recur unobserved.
    it(`${p.label} reports drift when a generated head is removed`, () => {
      const current = readFileSync(p.path, 'utf8');
      const si = current.indexOf(p.begin);
      const ei = current.indexOf(p.end, si);
      const lines = current.slice(si + p.begin.length, ei).split('\n');
      const victim = lines.findIndex((l) => /^\s*'[^']+',\s*$/.test(l));
      expect(victim, 'no generated head line inside the marked region').toBeGreaterThanOrEqual(0);

      const mutant =
        current.slice(0, si + p.begin.length) +
        [...lines.slice(0, victim), ...lines.slice(victim + 1)].join('\n') +
        current.slice(ei);

      // A no-op mutation would make the guard look strong for free.
      expect(mutant, 'mutation changed nothing — verdict void').not.toBe(current);
      expect(isStale(mutant, p)).toBe(true);
    });
  }
});

describe('the projected routing block is identical on every surface it lands in', () => {
  // EI-20429916097018614: gen:tool-routing writes CLAUDE.md directly while AGENTS.md is
  // emitted by the doc-parts projector from the corpus copy of the same block. The two
  // drifted apart for 9 days (codex agents read a routing table missing rows claude
  // agents had) and nothing observed it. Neither copy may drift from the other.
  const extractBlock = (path: string): string => {
    const text = readFileSync(path, 'utf8');
    const si = text.indexOf(BEGIN_MARKER);
    expect(si, `${path} is missing the BEGIN marker`).toBeGreaterThanOrEqual(0);
    const ei = text.indexOf(END_MARKER, si);
    expect(ei, `${path} is missing the END marker`).toBeGreaterThan(si);
    return text.slice(si, ei + END_MARKER.length);
  };

  it('AGENTS.md carries the same generated block as CLAUDE.md, byte for byte', () => {
    expect(extractBlock(join(REPO_ROOT, 'AGENTS.md'))).toBe(extractBlock(CLAUDE_MD));
  });
});
