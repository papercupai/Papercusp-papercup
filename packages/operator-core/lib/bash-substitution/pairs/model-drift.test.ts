/**
 * model-drift.test.ts — the D-015 guard for the four remaining pair families
 * (WI-6157). Sibling of `service-model-drift.test.ts`, which does the same job
 * for the service family.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Every pair file HAND-MODELS the tool it audits: `file-read.ts` copies
 * `capability:read`'s default page size, `postgres.ts` encodes which statements
 * `dev:pg_query` accepts, `process.ts` copies `dev:processes`' six kinds,
 * `git-read.ts` lists the git subcommands `capability:git` will run.
 *
 * That duplication is DELIBERATE and stays — an audit that imports its subject
 * proves nothing about it, because both sides would move together and the
 * verdict would track a shared constant instead of a real comparison.
 *
 * But WI-6153 showed the duplication had no guard, and that the `expectedVerdict`
 * latch structurally cannot be one: the latch recomputes a verdict from
 * `cover()`, and `cover()` reads the MODEL, never the real tool. So it catches
 * "model changed, verdict didn't" and is blind to "TOOL changed, model didn't" —
 * which is the common direction, because widening a tool is normal work done by
 * someone who never opens the audit. It happened exactly that way: `dev:service_health`
 * gained a :3170 probe, `pairs/service.ts` kept saying :3170 was unprobed, and both
 * user-facing `advisoryText` strings kept telling agents to shell out to curl for a
 * thing that now had a tool form. The whole suite stayed green.
 *
 * ── Both directions are load-bearing, and they fail differently ──────────────
 * The failure mode is NOT symmetric, and the diagnostics below say which one
 * fired:
 *
 *   TOOL WIDENS, model stale  → the pair UNDER-claims coverage. The recorded
 *     verdict stays `needs-widening`/`not-a-substitute` when the tool now works,
 *     and `advisoryText` actively advises AGAINST a tool that would serve the
 *     intent. This is the WI-6146 shape. `process.ts` is the sharpest case in
 *     the registry: its advisory literally says "no tool form; keep using bash".
 *
 *   TOOL NARROWS, model stale → the pair OVER-claims coverage. The verdict says
 *     `equivalent` on the strength of a capability that no longer exists, and
 *     once P-020 promotes that row past `tier:'observe'` the registry starts
 *     ENFORCING a substitution that returns an error.
 *
 * ── What is asserted ─────────────────────────────────────────────────────────
 * 1. The model constants equal their real counterparts (exact, both directions).
 * 2. The tool's PARAMETER SURFACE is pinned. Any added or removed arg reds here,
 *    because an arg is how a tool's capability envelope actually changes — and
 *    the envelope is what every verdict in this registry rests on.
 * 3. `cover()`'s emitted expressions only name parameters the tool really has,
 *    so the audit cannot promise an expression an agent is unable to evaluate.
 * 4. `advisoryText` prose that quotes a tool constant still quotes it correctly.
 *
 * A pin is a "come look at this once" ratchet, not a prohibition. When a new arg
 * genuinely does not change coverage, add it to the expected set WITH a one-line
 * reason — the same convention as `NON_ENDPOINT_PROBES` in the service guard.
 * Every silent exemption is a hole in the guard.
 */
import { describe, it, expect } from 'vitest';

// The real subjects. Imported HERE (in the guard) and never in the models.
import devProcesses, { KIND_ENUM } from '../../agent-tools/dev/processes';
import devPgQuery from '../../agent-tools/dev/pg_query';
import capabilityRead, { DEFAULT_LIMIT } from '../../agent-tools/capability/read';
import capabilityGit, { REFUSED_SUBCOMMANDS } from '../../agent-tools/capability/git';
import testingRun from '../../agent-tools/testing/run';
import logsRead from '../../agent-tools/logs/read';
import buildTypecheck from '../../agent-tools/build/typecheck';
import { NO_INPUT_CODES } from '../../tsc-diagnostics';
import { JOURNAL_LEVELS, JOURNAL_SCOPES } from '../../journal-read';
import { assertSingleReadStatement } from '../../pg-read-query';

// The models under audit.
import { psProcessQuery, DEV_PROCESSES_KINDS } from './process';
import { psqlSelectRead, psqlDescribe } from './postgres';
import { sedRangeRead, catFileRead, headFileRead, tailFileRead, READ_DEFAULT_LIMIT } from './file-read';
import { gitReadPassthrough, READ_SUBCOMMANDS } from './git-read';
import {
  routerTestFiles,
  rawVitestFiles,
  affectedTests,
  TESTING_RUN_MAX_FILES,
  TESTING_RUN_MAX_PATTERN,
} from './tests';
import {
  unitJournalRead,
  LOGS_READ_MAX_GREP,
  LOGS_READ_MAX_LIMIT,
  LOGS_READ_MAX_UNITS,
  LOGS_READ_MAX_WINDOW,
} from './logs';
import {
  tscProjectTypecheck,
  BUILD_TYPECHECK_MAX_FILES,
  BUILD_TYPECHECK_MAX_PROJECT,
  EXPRESSIBLE_FLAGS,
  NO_OP_TYPECHECK_FINDING,
} from './typecheck';

// The shared D-016 assertions. Extracted so the service family's guard
// (service-model-drift.test.ts, dev:listening_ports) asserts through the SAME
// code rather than a second copy of it.
import { argKeys, expectArgSurface, expectExpressionUsesRealArgs } from './model-drift-helpers';

// ── dev:processes ↔ pairs/process.ts ────────────────────────────────────────

describe('process.ts model tracks the real dev:processes (D-015)', () => {
  it('DEV_PROCESSES_KINDS is exactly the tool\'s KIND_ENUM', () => {
    expect(
      [...DEV_PROCESSES_KINDS],
      `pairs/process.ts's copy of the six agent kinds has drifted from dev:processes' real KIND_ENUM. ` +
        `cover() uses this list to decide whether a pgrep maps onto { kinds: [...] }, so a stale copy either ` +
        `invents a kind the tool will reject, or misses one the tool now serves.`,
    ).toEqual([...KIND_ENUM]);
  });

  it('cover() actually routes each real kind through that list', () => {
    // Pins the CONSUMER, not just the constant: a refactor that stops consulting
    // DEV_PROCESSES_KINDS would leave the equality check above passing vacuously.
    for (const kind of KIND_ENUM) {
      const result = psProcessQuery.cover(`pgrep -f ${kind}`);
      expect(result.covered, `pgrep for the real agent kind '${kind}' is no longer covered`).toBe(true);
      expect(result.expression).toContain(`kinds: ['${kind}']`);
    }
  });

  it('dev:processes still has NO pid or name selector — the whole basis of the not-a-substitute verdict', () => {
    expectArgSurface(
      devProcesses,
      'dev:processes',
      ['kinds'],
      'the `not-a-substitute` verdict (0/24) rests on this tool having ONLY a kinds filter. A pid selector or a ' +
        'name/pattern filter would make 46.3% of the ps/pgrep family ("is MY job running") suddenly expressible, ' +
        'and this pair\'s advisoryText — which tells agents "no tool form; keep using bash" — would be actively wrong.',
    );
  });

  it('the verdict and advisory still say what the argument surface implies', () => {
    // A named, non-generic pin on the specific claim the advisory makes, so it
    // cannot be quietly loosened while the generic surface check is exempted.
    expect(psProcessQuery.expectedVerdict).toBe('not-a-substitute');
    expect(psProcessQuery.advisoryText).toContain('no pid or name selector');
    expect(argKeys(devProcesses)).not.toContain('pid');
    expect(argKeys(devProcesses)).not.toContain('pattern');
    expect(argKeys(devProcesses)).not.toContain('name');
  });

  /**
   * P-022 / D-025. This pair's verdict is negative, so ALL of its value to an
   * agent is the advisory prose — which makes that prose the thing most likely
   * to rot back to a dead end ("no tool form; keep using bash"), the WI-6146
   * shape. 99.7% of the 2,315 ps/pgrep atoms in the corpus land on this one
   * pattern, so this string is the single highest-traffic piece of routing
   * advice in the registry. Both halves are pinned:
   *
   *   the REDIRECT — naming both tools, because a launch-site fix is useless if
   *     the advisory only says which tool does not work;
   *   the CAVEAT — because the tempting simplification ("use capability:bash,
   *     it survives compaction") is FALSE. That tool's in-memory job registry is
   *     wiped on any operator restart, cross-agent on this box (EI-8855). Losing
   *     the caveat would make this advisory promise immunity the platform does
   *     not provide, which is worse than the dead end it replaced.
   */
  it('the advisory still redirects to the launch-site workflow, and still hedges it (D-025)', () => {
    for (const token of ['capability:bash', 'capability:bash_output']) {
      expect(
        psProcessQuery.advisoryText,
        `the ps/pgrep advisory no longer names ${token}. This pair is not-a-substitute, so the redirect IS its ` +
          `entire value — without it the advisory is a dead end for the 99.7% of ps/pgrep commands that match here.`,
      ).toContain(token);
    }
    expect(
      psProcessQuery.advisoryText,
      'the ps/pgrep advisory no longer carries the EI-8855 stranding caveat. Do not recommend capability:bash as ' +
        'restart-proof: its job registry is wiped whenever ANY agent restarts the operator. The honest claim is ' +
        'RECOVERABILITY (deterministic log path + a confirmed stranded cause), never immunity.',
    ).toContain('EI-8855');
  });
});

// ── dev:pg_query ↔ pairs/postgres.ts ────────────────────────────────────────

/**
 * Statements where the MODEL is knowingly stricter than the tool, with the
 * reason. Only ever model-rejects/tool-accepts: the opposite direction (the
 * model claiming something the tool refuses) is never exempt, because that is
 * the direction that ships a broken substitution.
 */
const MODEL_MORE_CONSERVATIVE: Record<string, string> = {
  // The model's MUTATING regex does not strip string literals, so a keyword
  // inside a quoted value reads as a mutation. The tool strips literals before
  // checking. Under-claiming is the safe direction, and stripping SQL literals
  // in the model would mean writing a second SQL lexer to audit the first.
  "select * from t where note = 'update the row'":
    'model does not strip string literals before the MUTATING check; tool does',
};

describe('postgres.ts model tracks the real dev:pg_query (D-015)', () => {
  it('dev:pg_query still has NO database/connection selector', () => {
    expectArgSurface(
      devPgQuery,
      'dev:pg_query',
      [
        // Policy opt-in for a deliberate cross-tenant read of the same operator
        // database; it is not a database/connection selector and therefore does
        // not widen this pair to the excluded $PGURL/scratch-database atoms.
        'allowUnscoped',
        // Policy opt-in (2026-09-04, 37f4f48cfd) that lets an unbounded JSON-path
        // search run against the same operator database instead of being refused;
        // like allowUnscoped it selects no database or connection, so it does not
        // make the excluded $ODDS_DB/$PGURL/scratch atoms claimable.
        'allowUnboundedJsonSearch',
        'describe',
        'maxRows',
        // A SECOND SQL string run through the SAME connection and scope, to prove
        // an absence claim's instrument can find a known-positive row. It selects
        // no database or connection, so it does not make the excluded
        // $ODDS_DB/$PGURL/scratch atoms claimable and the pattern stays narrowed.
        'positiveControlSql',
        'sql',
        'timeoutMs',
      ],
      'psqlSelectRead is deliberately NARROWED to a literal operator-Postgres connection because this tool has no ' +
        'database selector — 289 corpus atoms target $ODDS_DB/$PGURL/scratch databases and are excluded so agents ' +
        'are never nudged into silently querying the WRONG DATABASE. A connection/database arg would make those ' +
        'atoms claimable and the pattern must then be widened to match.',
    );
  });

  it('the `describe` mode psqlDescribe depends on still exists', () => {
    // psqlDescribe's `equivalent` verdict is ENTIRELY this arg: `\d` is a psql
    // client meta-command with no SQL form, so without `describe` those 88 atoms
    // have no tool expression at all and the verdict is wrong.
    expect(argKeys(devPgQuery)).toContain('describe');
    expect(psqlDescribe.expectedVerdict).toBe('equivalent');
  });

  it('the model and the tool agree on which statements are accepted', () => {
    const probes = [
      'select 1',
      'select * from harness_shared.work_items limit 5',
      'with x as (select 1) select * from x',
      "select * from t where note = 'update the row'",
      'show all',
      'explain select 1',
      'insert into t values (1)',
      'update t set a = 1',
      'delete from t',
      'vacuum analyze',
      'select 1; drop table t',
    ];

    const overclaims: string[] = [];
    const unexplainedGaps: string[] = [];

    for (const sql of probes) {
      const modelCovers = psqlSelectRead.cover(`psql -d papercusp -c "${sql}"`).covered;
      let toolAccepts = true;
      try {
        assertSingleReadStatement(sql);
      } catch {
        toolAccepts = false;
      }

      if (modelCovers && !toolAccepts) {
        // NEVER exempt: the audit would be advising a call the tool rejects.
        overclaims.push(`"${sql}" — model covers it, dev:pg_query REFUSES it`);
      } else if (!modelCovers && toolAccepts && !(sql in MODEL_MORE_CONSERVATIVE)) {
        unexplainedGaps.push(`"${sql}" — dev:pg_query accepts it, the model does not claim it`);
      }
    }

    expect(
      overclaims,
      `pairs/postgres.ts claims statements dev:pg_query will reject. This is the OVER-claim direction: the pair ` +
        `scores as \`equivalent\` on coverage the tool does not have, and enforcement would route agents into an ` +
        `error:\n  - ${overclaims.join('\n  - ')}`,
    ).toEqual([]);

    expect(
      unexplainedGaps,
      `dev:pg_query accepts statements the model does not claim — the tool was WIDENED and the model did not ` +
        `follow, so the pair under-reports coverage and its routing advice may be stale:\n  - ${unexplainedGaps.join(
          '\n  - ',
        )}\nIf a gap is deliberate, add it to MODEL_MORE_CONSERVATIVE with the reason.`,
    ).toEqual([]);
  });

  it('cover() emits expressions built only from real dev:pg_query args', () => {
    expectExpressionUsesRealArgs(psqlSelectRead, 'psql -d papercusp -c "select 1"', devPgQuery, ['sql']);
    expectExpressionUsesRealArgs(
      psqlDescribe,
      'psql -d papercusp -c "\\d harness_shared.work_items"',
      devPgQuery,
      ['describe'],
    );
  });
});

// ── capability:read ↔ pairs/file-read.ts ────────────────────────────────────

describe('file-read.ts model tracks the real capability:read (D-015)', () => {
  it('READ_DEFAULT_LIMIT is the tool\'s real DEFAULT_LIMIT', () => {
    expect(
      READ_DEFAULT_LIMIT,
      `pairs/file-read.ts mirrors capability:read's default page size to build \`head\`/\`cat\` expressions. If the ` +
        `tool's default changed and this copy did not, the audit emits an expression that reads a DIFFERENT number ` +
        `of lines than the bash command it claims to replace — a substitution that silently returns less than asked.`,
    ).toBe(DEFAULT_LIMIT);
  });

  it('capability:read still offers the exact windowing surface the family maps onto', () => {
    expectArgSurface(
      capabilityRead,
      'capability:read',
      [
        // These two do NOT widen this answer-equivalent text family: byte mode
        // returns structured base64 pages, while head/tail -c emit raw bytes;
        // tail bytes additionally require an EOF-relative start the tool lacks.
        'byte_limit',
        'byte_offset',
        // Stable result-door content selection is a different mode from file
        // line windows; account for the real tool surface without widening
        // this answer-equivalent text family.
        'content_indexes',
        // Evidence-class selection is another stable scratch-reference mode.
        // It is mutually exclusive with line/byte windows and does not widen
        // the answer-equivalent file-read family.
        'evidence_class',
        'file_path',
        'limit',
        'offset',
        // query (+ its three modifiers) searches ONE saved result or file for
        // lines holding EVERY term: case-insensitive, literal, AND, over a
        // searched view that re-renders JSON pretty-printed. That is neither a
        // line window nor `grep -n` (regex, case-sensitive, physical lines), so
        // no pair here changes and none models a single-file grep it now serves.
        'query',
        'query_context',
        'query_from_line',
        'query_max_matches',
        // raw:true is an explicit exact-text mode for callers that will pass a
        // read result to a write; it does not change the existing framed
        // inspection expressions in this answer-equivalent family.
        'raw',
        'tail',
        'uri',
        // view_lines windows that searched view (JSON re-rendered, long lines
        // clipped, alone only): a weaker line window than offset/limit, which
        // these pairs already map onto.
        'view_lines',
      ],
      'the four text-output pairs map directly onto file_path/offset/limit/tail. `uri` is the result-door ' +
        '`papercusp://scratch` alias for file_path and does not widen that text operation family. ' +
        '`content_indexes` and `evidence_class` select structured values from a stable scratch reference and are ' +
        'mutually exclusive with the text windows, so neither changes this family. `raw` is an explicit exact-text ' +
        'mode for safe read-to-write handoffs; the existing framed expressions remain inspection-oriented. `tail` in particular was ADDED ' +
        'to close the family\'s real gap (1,752 `tail -n N FILE` atoms across 63 sessions had no tool form); losing ' +
        'it would silently restore that gap while the pair still records `equivalent`. The byte args are accounted ' +
        'for but deliberately remain outside this family because their structured base64 answer is not raw-byte ' +
        'stdout. `query` (+ query_context/query_from_line/query_max_matches) is a case-insensitive literal all-terms ' +
        'search over a searched view, and `view_lines` windows that view; neither is a file line window nor ' +
        'answer-equivalent to `grep -n`, so neither changes this family. ' +
        'A multi-file arg or a raw/EOF-relative byte mode would require re-deriving coverage.',
    );
  });

  it('cover() emits expressions built only from real capability:read args', () => {
    expectExpressionUsesRealArgs(sedRangeRead, "sed -n '10,20p' /tmp/a.log", capabilityRead, [
      'file_path',
      'offset',
      'limit',
    ]);
    expectExpressionUsesRealArgs(headFileRead, 'head -n 40 /tmp/a.log', capabilityRead, ['file_path', 'limit']);
    expectExpressionUsesRealArgs(tailFileRead, 'tail -n 40 /tmp/a.log', capabilityRead, ['file_path', 'tail']);
    expectExpressionUsesRealArgs(catFileRead, 'cat /tmp/a.log', capabilityRead, ['file_path']);
  });

  it('advisoryText prose still quotes the real page size', () => {
    // catFileRead's advisory states the paging number in PROSE. That string is
    // what an agent reads, so it drifts exactly like the model constants do —
    // and unlike them, nothing else would ever recompute it.
    const quoted = /paged at (\d+) lines/.exec(catFileRead.advisoryText);
    expect(quoted, `catFileRead.advisoryText no longer states its paging size: ${catFileRead.advisoryText}`).not.toBeNull();
    expect(
      Number(quoted?.[1]),
      `catFileRead's advisoryText tells agents the read is "paged at ${quoted?.[1]} lines", but capability:read ` +
        `actually pages at ${DEFAULT_LIMIT}. The advisory is user-facing guidance and is now wrong.`,
    ).toBe(DEFAULT_LIMIT);
  });

  it('sed range guidance prevents inclusive endpoint overlap false alarms', () => {
    expect(sedRangeRead.advisoryText).toContain('Line ranges are inclusive');
    expect(sedRangeRead.advisoryText).toContain('previous end + 1');
    expect(sedRangeRead.advisoryText).toContain('overlapping endpoints repeat a source line');
  });
});

// ── capability:git ↔ pairs/git-read.ts ──────────────────────────────────────

describe('git-read.ts model tracks the real capability:git (D-015)', () => {
  it('no subcommand the model claims is refused by the tool', () => {
    const refused = READ_SUBCOMMANDS.filter((sub) => REFUSED_SUBCOMMANDS.has(sub));
    expect(
      refused,
      `pairs/git-read.ts claims these subcommands are substitutable, but capability:git REFUSES them — the ` +
        `registry would advise a call that returns { ok: false, reason: 'refused' }:\n  - ${refused.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('nothing the tool refuses has crept into the read list', () => {
    // The other direction: a newly-refused subcommand must be removed from the
    // model, not merely absent from the corpus.
    const leaked = [...REFUSED_SUBCOMMANDS].filter((sub) => (READ_SUBCOMMANDS as readonly string[]).includes(sub));
    expect(
      leaked,
      `capability:git refuses these, yet they are listed as read-substitutable:\n  - ${leaked.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('capability:git still takes argv + cwd — the surface the passthrough maps onto', () => {
    expectArgSurface(
      capabilityGit,
      'capability:git',
      ['args', 'cwd', 'scratchClone'],
      'gitReadPassthrough rewrites the whole command as literal argv, and maps `git -C <dir>` / `--git-dir` / ' +
        '`--work-tree` onto `cwd` (140 corpus atoms point at a sibling worktree). Losing `cwd` would make every ' +
        'one of those expressions run in the WRONG REPOSITORY while still reporting success. scratchClone is a ' +
        'guarded construction mode for a different intent and does not broaden the read-passthrough pair.',
    );
  });

  it('cover() emits expressions built only from real capability:git args', () => {
    expectExpressionUsesRealArgs(
      gitReadPassthrough,
      'git -C /tmp/repo log --oneline -5',
      capabilityGit,
      ['args', 'cwd'],
    );
  });
});

// ── testing:run ↔ pairs/tests.ts ────────────────────────────────────────────

/** Parse an args payload through the tool's REAL zod schema. */
function accepts(args: Record<string, unknown>): boolean {
  return (testingRun as unknown as { args: { safeParse: (a: unknown) => { success: boolean } } })
    .args.safeParse(args).success;
}

const ONE_FILE = ['packages/operator-core/lib/a.test.ts'];
const nFiles = (n: number) => Array.from({ length: n }, (_, i) => `packages/p/lib/a${i}.test.ts`);

describe('tests.ts model tracks the real testing:run (D-015)', () => {
  /**
   * The bounds are asserted BEHAVIOURALLY — by parsing through the tool's own
   * schema — rather than by reaching into zod's `_def`. A private-field probe
   * would pin the shape of the validation library instead of the capability,
   * and would go quietly green (or red) on a zod upgrade that changed neither.
   */
  it('TESTING_RUN_MAX_FILES is the real `files` bound', () => {
    expect(accepts({ files: nFiles(TESTING_RUN_MAX_FILES) }), 'the tool rejects a list at the modelled maximum').toBe(true);
    expect(
      accepts({ files: nFiles(TESTING_RUN_MAX_FILES + 1) }),
      `pairs/tests.ts models testing:run as taking at most ${TESTING_RUN_MAX_FILES} files and cover() refuses a ` +
        `longer command on that basis. The tool now accepts more, so the model UNDER-claims: real multi-file ` +
        `commands are being scored uncoverable when the tool would serve them.`,
    ).toBe(false);
    // The lower bound is what makes "no test file operand" a real refusal.
    expect(accepts({ files: [] }), 'testing:run now accepts an EMPTY file list; cover() refuses those commands').toBe(false);
  });

  it('TESTING_RUN_MAX_PATTERN is the real `testNamePattern` bound', () => {
    expect(accepts({ files: ONE_FILE, testNamePattern: 'x'.repeat(TESTING_RUN_MAX_PATTERN) })).toBe(true);
    expect(
      accepts({ files: ONE_FILE, testNamePattern: 'x'.repeat(TESTING_RUN_MAX_PATTERN + 1) }),
      `cover() rejects a \`-t\` longer than ${TESTING_RUN_MAX_PATTERN} chars on the strength of this bound.`,
    ).toBe(false);
    // `-t ""` appears in the corpus; the empty-pattern refusal rests on this.
    expect(accepts({ files: ONE_FILE, testNamePattern: '' }), 'an empty -t is now accepted; the refusal is stale').toBe(false);
  });

  it('testing:run may DERIVE a plan, but still RUNS only an explicit file list', () => {
    expectArgSurface(
      testingRun,
      'testing:run',
      // `changedPaths` was ADDED after this pin was written, and the re-derivation it
      // forced is recorded here rather than in a commit message. It derives the
      // test:affected plan from edited SOURCE files — so the old rationale below
      // ("there is no arg that derives a file list") is dead, and any advisory still
      // saying the tool "cannot compute one" is now the WI-6146 regression itself.
      // The VERDICT nevertheless survives: `run.ts` answers a changedPaths call with
      // the plan and RUNS NOTHING, while `npm run test:affected` runs what it selects.
      // Planning is not running, which is why `tests.affected` stays not-a-substitute.
      // Evidence/harness bind the selected run to its ledger; recheckReason
      // explains a repeat. recoverEvidence only reads an existing bundle.
      // `remeasureEvidence` is the ONE arg that does derive a file list and RUN it:
      // run.ts derives both the files and the evidence mapping from a work-item's
      // persisted stale bindings, then goes through the ordinary evidence path. It
      // still disturbs NEITHER verdict, which is why it is pinned here rather than
      // forcing a re-derivation. (1) It selects from `{workItemId, planSlug, specIds}`
      // and never from changed/edited paths, so it cannot express a test:affected-
      // shaped corpus command and `tests.affected` stays not-a-substitute. (2) Routing
      // through the ordinary evidence path keeps the reporter fixed at json and the
      // config derived per owning workspace, so the reporter/config/root exclusions
      // below stay accurate. Nothing else here executes a derived selection.
      // `work_item_id` only attributes the run (task ledger + slow-attempt gate) to a
      // held work-item; it selects nothing and fixes neither reporter nor config, so
      // it disturbs neither verdict either.
      // `rootHarnessSlug` selects a registered checkout for explicit files. It does
      // not execute changedPaths or accept an arbitrary Vitest --root/config, so
      // the existing default-root substitutions and exclusions remain valid.
      // `nativeConsult` runs one attributed consult through the consult lifecycle.
      // run.ts refuses it beside every Vitest/evidence selector, so it runs no test
      // file, derives no selection and fixes no reporter/config: neither verdict moves.
      // `taskDeadlineAtMs` / `cleanupReserveMs` only BOUND the run: an absolute cutoff for
      // the caller's task budget and the slice of it held back for owned-resource cleanup
      // (run.ts turns them into the child cutoff env). They select no file, derive no list
      // and fix no reporter/config, so neither verdict moves (EI-26491186938728719).
      ['changedPaths', 'cleanupReserveMs', 'evidence', 'files', 'harness', 'maxFailures', 'nativeConsult', 'recheckReason', 'recoverEvidence', 'remeasureEvidence', 'rootHarnessSlug', 'taskDeadlineAtMs', 'testNamePattern', 'timeoutMs', 'work_item_id'],
      'two verdicts rest on this surface. (1) `tests.affected` is recorded `not-a-substitute` because no arg makes ' +
        'the tool RUN a list it derived — `changedPaths` returns the plan and executes nothing. An arg that ' +
        'EXECUTED a derived selection would make 206 corpus atoms across 48 sessions suddenly expressible, and ' +
        'this pair would be actively telling agents to keep shelling out. (2) Both equivalent patterns EXCLUDE ' +
        'commands passing `--reporter`/`--config`/`--root` because the tool fixes the reporter at json and derives ' +
        "the config from each file's owning workspace; a reporter or config arg would make those exclusions stale.",
    );
  });

  it('cover() emits expressions built only from real testing:run args', () => {
    expect(accepts({ files: ONE_FILE, rootHarnessSlug: 'papercusp' })).toBe(true);
    expectExpressionUsesRealArgs(
      routerTestFiles,
      'npm run test:file -- packages/operator-core/lib/a.test.ts 2>&1',
      testingRun,
      ['files'],
    );
    expectExpressionUsesRealArgs(
      rawVitestFiles,
      'npx vitest run packages/operator-core/lib/a.test.ts -t "some case" 2>&1',
      testingRun,
      ['files', 'testNamePattern'],
    );
  });

  it('the affected verdict and advisory still say what the argument surface implies', () => {
    expect(affectedTests.expectedVerdict).toBe('not-a-substitute');
    expect(affectedTests.advisoryText).toContain('No substitute');
    for (const derived of ['affected', 'changed', 'since', 'diff', 'base']) {
      expect(argKeys(testingRun), `testing:run gained a '${derived}' arg — re-audit tests.affected`).not.toContain(derived);
    }
  });
});

// ── logs:read ↔ pairs/logs.ts ───────────────────────────────────────────────

/** Parse an args payload through `logs:read`'s REAL zod schema. */
function logsAccepts(args: Record<string, unknown>): boolean {
  return (logsRead as unknown as { args: { safeParse: (a: unknown) => { success: boolean } } })
    .args.safeParse(args).success;
}

describe('logs.ts model tracks the real logs:read (D-015)', () => {
  it('LOGS_READ_MAX_UNITS is the real `unit` array bound', () => {
    const units = (n: number) => Array.from({ length: n }, (_, i) => `u${i}.service`);
    expect(logsAccepts({ unit: units(LOGS_READ_MAX_UNITS) })).toBe(true);
    expect(
      logsAccepts({ unit: units(LOGS_READ_MAX_UNITS + 1) }),
      `pairs/logs.ts refuses a command naming more than ${LOGS_READ_MAX_UNITS} units on the strength of this bound. ` +
        'The tool now accepts more, so the model UNDER-claims.',
    ).toBe(false);
    // A single string is the dominant shape; the union must keep accepting it.
    expect(logsAccepts({ unit: 'papercup-bg-host' })).toBe(true);
  });

  it('LOGS_READ_MAX_LIMIT / MAX_GREP / MAX_WINDOW are the real bounds', () => {
    expect(logsAccepts({ unit: 'a', limit: LOGS_READ_MAX_LIMIT })).toBe(true);
    expect(logsAccepts({ unit: 'a', limit: LOGS_READ_MAX_LIMIT + 1 })).toBe(false);
    expect(logsAccepts({ unit: 'a', grep: 'x'.repeat(LOGS_READ_MAX_GREP) })).toBe(true);
    expect(logsAccepts({ unit: 'a', grep: 'x'.repeat(LOGS_READ_MAX_GREP + 1) })).toBe(false);
    expect(logsAccepts({ unit: 'a', since: 'x'.repeat(LOGS_READ_MAX_WINDOW) })).toBe(true);
    expect(logsAccepts({ unit: 'a', since: 'x'.repeat(LOGS_READ_MAX_WINDOW + 1) })).toBe(false);
  });

  it("every level name cover() accepts is one the tool's enum accepts", () => {
    for (const level of JOURNAL_LEVELS) {
      expect(logsAccepts({ unit: 'a', level }), `cover() maps \`-p ${level}\` straight through`).toBe(true);
    }
    // The refusal of a NUMERIC/ranged priority (`-p 0..3`) rests on this.
    expect(logsAccepts({ unit: 'a', level: '3' })).toBe(false);
    expect(logsAccepts({ unit: 'a', level: '0..3' })).toBe(false);
  });

  it('scope is three-valued — collapsing it back to a boolean silently re-routes system reads', () => {
    for (const scope of JOURNAL_SCOPES) expect(logsAccepts({ unit: 'a', scope })).toBe(true);
    expect(
      logsAccepts({ unit: 'a', scope: true }),
      'logs:read took a boolean scope again. 18 corpus reads pass NEITHER --user nor --system and every one ' +
        'targets a system unit, so a two-valued scope expresses them as a read of a journal that cannot hold the answer.',
    ).toBe(false);
  });

  it('logs:read still takes NO follow/stream argument — the pattern excludes `-f` on that basis', () => {
    expectArgSurface(
      logsRead,
      'logs:read',
      ['unit', 'identifier', 'since', 'until', 'grep', 'level', 'limit', 'scope'],
      'pairs/logs.ts excludes `-f`/`--follow`, boot/cursor selection and field projection BY PATTERN, on the ' +
        'basis that the tool has no argument for them. A new arg may mean the pattern is now wrongly narrow.',
    );
    for (const streaming of ['follow', 'stream', 'tail', 'watch']) {
      expect(argKeys(logsRead), `logs:read gained a '${streaming}' arg — re-audit the -f exclusion`).not.toContain(streaming);
    }
  });

  it('cover() emits expressions built only from real logs:read args', () => {
    expectExpressionUsesRealArgs(
      unitJournalRead,
      `journalctl --user -u papercup-bg-host.service --since '-30 min' --grep 'oom' --no-pager 2>/dev/null`,
      logsRead,
      ['unit', 'since', 'grep'],
    );
  });

  it('the advisory still promises exactly what the tool does', () => {
    // The push-down IS the substitution's value; an advisory that stops saying so
    // is advertising a tool that merely runs the same command for you.
    expect(unitJournalRead.advisoryText).toContain('--grep');
    expect(unitJournalRead.routing.use).toContain('grep');
    expect(unitJournalRead.expectedVerdict).toBe('equivalent');
  });
});

// ── build:typecheck ↔ pairs/typecheck.ts ────────────────────────────────────

/** Parse an args payload through `build:typecheck`'s REAL zod schema. */
function typecheckAccepts(args: Record<string, unknown>): boolean {
  return (buildTypecheck as unknown as { args: { safeParse: (a: unknown) => { success: boolean } } })
    .args.safeParse(args).success;
}

describe('typecheck.ts model tracks the real build:typecheck (D-015)', () => {
  it('BUILD_TYPECHECK_MAX_PROJECT is the real `project` length bound', () => {
    expect(typecheckAccepts({ project: 'a'.repeat(BUILD_TYPECHECK_MAX_PROJECT) })).toBe(true);
    expect(
      typecheckAccepts({ project: 'a'.repeat(BUILD_TYPECHECK_MAX_PROJECT + 1) }),
      `pairs/typecheck.ts refuses a project path longer than ${BUILD_TYPECHECK_MAX_PROJECT}; the tool must agree`,
    ).toBe(false);
  });

  it('BUILD_TYPECHECK_MAX_FILES is the real `files` array bound', () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => `lib/f${i}.ts`);
    expect(typecheckAccepts({ project: 'packages/operator-core', files: files(BUILD_TYPECHECK_MAX_FILES) })).toBe(true);
    expect(typecheckAccepts({ project: 'packages/operator-core', files: files(BUILD_TYPECHECK_MAX_FILES + 1) })).toBe(false);
  });

  it('`project` is still REQUIRED — an optional one would reintroduce the no-op this pair exists to refuse', () => {
    // The whole correctness argument (NO_OP_TYPECHECK_FINDING) is that a
    // defaulted project is exactly the silent zero-file check. If someone ever
    // makes it optional, the model's cwd-relative exclusion stops making sense
    // and this must be re-audited rather than quietly inherited.
    expect(typecheckAccepts({}), 'build:typecheck accepted a call with NO project').toBe(false);
    expect(typecheckAccepts({ project: '' })).toBe(false);
  });

  it('build:typecheck still takes no output-file / reporter argument — the pattern excludes redirects on that basis', () => {
    expectArgSurface(
      buildTypecheck,
      'build:typecheck',
      // `scopeToFiles` (EI-19297428004790873) does NOT widen this family's coverage, which is
      // why it is accepted here rather than treated as an under-claim. It compiles `files` +
      // their import graph under a config that EXTENDS the project's, and plain tsc has no
      // command shape for that: `tsc -p X a.ts` is refused by tsc itself ("Cannot use --project
      // with source files"), and `tsc a.ts` IGNORES tsconfig entirely, so it runs under default
      // compilerOptions — a materially different check that stays correctly uncovered below.
      // `dirs` (build/typecheck.ts): a DIRECTORY filter over the reported errors, the sibling of
      // the `files` filter — it narrows what is REPORTED, never what is compiled, so it does not
      // touch the redirect-exclusion or project-operand reasoning in pairs/typecheck.ts.
      ['project', 'files', 'dirs', 'maxErrors', 'timeoutMs', 'incremental', 'scopeToFiles'],
      'pairs/typecheck.ts excludes an stdout redirect BY PATTERN because the tool produces no artifact, and treats ' +
        'every compiler option except --incremental as unexpressible. A new arg may mean the pattern is wrongly narrow.',
    );
    for (const artifact of ['outputFile', 'outFile', 'reporter', 'format', 'json']) {
      expect(argKeys(buildTypecheck), `build:typecheck gained a '${artifact}' arg — re-audit the redirect exclusion`).not.toContain(artifact);
    }
  });

  it('every flag cover() treats as expressible maps to a real arg or is a no-op flag', () => {
    // `--noEmit` and `--pretty` are unconditional tool behaviour (no arg);
    // `-p`/`--project` and `--incremental` must be REAL args, or cover() is
    // promising an expression an agent cannot evaluate.
    const real = argKeys(buildTypecheck);
    expect(real).toContain('project');
    expect(real).toContain('incremental');
    expect([...EXPRESSIBLE_FLAGS].sort()).toEqual(['--incremental', '--noEmit', '--pretty', '-p', '--project'].sort());
  });

  it('cover() emits expressions built only from real build:typecheck args', () => {
    expectExpressionUsesRealArgs(
      tscProjectTypecheck,
      'npx tsc --noEmit -p packages/operator-core/tsconfig.json 2>&1',
      buildTypecheck,
      ['project'],
    );
  });

  it('the no-op codes the tool refuses on are still the ones the finding is about', () => {
    // If TS5057/TS5058 stop being treated as "checked nothing", the tool starts
    // reporting a clean zero for the corpus's single most common shape and the
    // pair's whole correctness argument evaporates silently.
    for (const code of ['TS5057', 'TS5058', 'TS18003']) {
      expect(NO_INPUT_CODES.has(code), `${code} is no longer treated as a zero-file check`).toBe(true);
    }
    expect(tscProjectTypecheck.advisoryText).toContain('TS5057');
    expect(tscProjectTypecheck.expectedVerdict).toBe('equivalent');
  });

  it('the pattern still REQUIRES --noEmit (a command without it emits — a different request)', () => {
    expect(tscProjectTypecheck.bashPattern.test('npx tsc --noEmit -p packages/engine/tsconfig.json')).toBe(true);
    expect(
      tscProjectTypecheck.bashPattern.test('npx tsc -p packages/engine/tsconfig.build.json 2>&1'),
      'the pattern claimed an EMITTING tsc run — this exact atom took the first draft to needs-widening',
    ).toBe(false);
  });

  it('the pattern still refuses a cwd-relative project — the largest deliberate exclusion', () => {
    for (const atom of ['npx tsc --noEmit -p . 2>&1', 'npx tsc --noEmit -p tsconfig.json 2>&1', 'npx tsc --noEmit 2>&1']) {
      expect(tscProjectTypecheck.bashPattern.test(atom), `pattern claimed "${atom}", whose cwd the atom no longer carries`).toBe(false);
    }
    expect(NO_OP_TYPECHECK_FINDING.droppedAtoms).toBeGreaterThan(0);
  });
});
