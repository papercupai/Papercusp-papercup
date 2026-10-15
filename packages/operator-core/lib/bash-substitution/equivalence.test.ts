/**
 * The committed equivalence harness test (plan
 * `bash-to-tool-substitution-2026-07-26`, P-004/P-005).
 *
 * This is the anti-rot latch the plan asks for. Each pair declares the verdict
 * it is RECORDED as carrying; the harness recomputes that verdict from frozen
 * samples of real commands. If someone changes a tool's capability (or the
 * envelope that models it) without re-recording the verdict, this test fails —
 * so a registry row can never quietly claim an equivalence the tool no longer
 * provides, which is the whole basis of D-001's enforcement gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { atomize, atomHead, normalizeAtom } from './atomize';
import {
  auditPair,
  deriveVerdict,
  matchingAtoms,
  maxTierFor,
  meetsAuditFloor,
  MIN_POPULATION_ATOMS,
  MIN_POPULATION_SESSIONS,
  MIN_SAMPLE_SIZE,
} from './equivalence';
import { ALL_PAIRS } from './pairs';
import { unsafeDependencyInstall } from './pairs/dependency-install';
import { assertPolicyTier, POLICY_INTENT_PREFIX } from './types';
import { catFileRead, headFileRead, sedRangeRead, tailFileRead, FILE_READ_PAIRS } from './pairs/file-read';
import { psqlDescribe, psqlSelectRead } from './pairs/postgres';
import { psProcessQuery } from './pairs/process';
import {
  buildProbedPortCurlPattern,
  curlHealthProbe,
  listeningPorts,
  PROBED_PORTS,
  systemctlIsActive,
} from './pairs/service';
import { gitReadPassthrough, shellArgv } from './pairs/git-read';
import type { CorpusFixture } from './corpus';
import type { SampledCommand } from './types';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(pairId: string): CorpusFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${pairId}.sample.json`), 'utf8')) as CorpusFixture;
}

describe('atomize', () => {
  it('splits compound commands on every shell separator', () => {
    expect(atomize("cd /repo && sed -n '1,40p' a.ts | head -5")).toEqual([
      'cd /repo',
      "sed -n '1,40p' a.ts",
      'head -5',
    ]);
    expect(atomize('a; b || c')).toEqual(['a', 'b', 'c']);
  });

  it('strips runner wrappers and env assignments so the verb is at position 0', () => {
    expect(normalizeAtom('sudo -n journalctl -u x')).toBe('journalctl -u x');
    expect(normalizeAtom('PGPASSWORD=x timeout 30 psql -c "select 1"')).toBe('psql -c "select 1"');
    expect(normalizeAtom('nohup npm run build')).toBe('npm run build');
  });

  it('reduces a verb to its bare name', () => {
    expect(atomHead('/usr/bin/psql -c x')).toBe('psql');
    expect(atomHead('   ')).toBeNull();
  });
});

describe('verdict derivation (D-008 — total coverage or it is not equivalent)', () => {
  it('requires every sampled command to be covered', () => {
    expect(deriveVerdict(20, 20)).toBe('equivalent');
    // The near-miss is deliberately NOT equivalent: the pattern is the unit of
    // enforcement, so one uncovered command means one agent nudged toward a
    // tool that cannot do the job.
    expect(deriveVerdict(19, 20)).toBe('needs-widening');
    expect(deriveVerdict(0, 20)).toBe('not-a-substitute');
    expect(deriveVerdict(0, 0)).toBe('unaudited');
  });

  it('only an equivalent verdict may be promoted past observe', () => {
    expect(maxTierFor('equivalent')).toBe('advise');
    expect(maxTierFor('needs-widening')).toBe('observe');
    expect(maxTierFor('not-a-substitute')).toBe('observe');
    expect(maxTierFor('unaudited')).toBe('observe');
  });

  it('refuses to produce a verdict from an under-sized sample', () => {
    const thin: SampledCommand[] = [{ sid: 'su-x', ts: '2026-07-26T00:00:00Z', atom: 'cat /tmp/a.log' }];
    expect(() => auditPair(catFileRead, thin)).toThrow(/need >= 20/);
  });

  // ── the CENSUS escape hatch (P-026/P-027) ────────────────────────────────
  // Fixtures dedupe, so `sample.length` counts distinct SPELLINGS. Without this,
  // an intent everyone types identically (`nproc`, `uptime`) is rejected as "too
  // rare to enforce" despite being the strongest kind of evidence there is.
  const thinSample: SampledCommand[] = [{ sid: 'su-x', ts: '2026-07-26T00:00:00Z', atom: 'cat /tmp/a.log' }];

  it('admits a small sample that is a CENSUS of a large, fleet-wide population', () => {
    const audit = auditPair(catFileRead, thinSample, { totalAtoms: 116, totalSessions: 36 });
    expect(audit.sampleSize).toBe(1);
  });

  it('still refuses when the population is large but concentrated in few sessions', () => {
    // 400 commands from 2 sessions is one agent's habit, not fleet-wide evidence.
    expect(() => auditPair(catFileRead, thinSample, { totalAtoms: 400, totalSessions: 2 })).toThrow(
      /need >= 20/,
    );
  });

  it('still refuses when the population is genuinely rare', () => {
    expect(() => auditPair(catFileRead, thinSample, { totalAtoms: 3, totalSessions: 3 })).toThrow(
      /need >= 20/,
    );
  });

  it('names the population in the refusal so the reason is actionable', () => {
    expect(() => auditPair(catFileRead, thinSample, { totalAtoms: 400, totalSessions: 2 })).toThrow(
      /400 atoms across 2 sessions/,
    );
  });
});

describe.each(ALL_PAIRS)('pair $id', (pair) => {
  const fixture = loadFixture(pair.id);

  // A pair whose population fell BELOW the audit floor is pinned in that state
  // rather than skipped. Skipping would let a future change quietly restore a
  // confident-looking verdict without restoring the evidence under it — which is
  // the precise failure this whole harness exists to prevent, so it would be an
  // odd thing to leave a hole for. (`deps.unsafe-install` landed here at P-002:
  // the D-047 atomizer fix removed ten `npm install` lines that only ever existed
  // inside heredoc bodies, taking its population from 28 atoms to 18.)
  if (!meetsAuditFloor(fixture.sample.length, fixture)) {
    it('is recorded as unaudited, and the harness refuses to derive a verdict', () => {
      expect(pair.expectedVerdict).toBe('unaudited');
      expect(() => auditPair(pair, fixture.sample, fixture)).toThrow(/too rare to enforce/);
    });

    it('still carries real corpus commands, however few', () => {
      expect(fixture.sample.length).toBeGreaterThan(0);
      for (const entry of fixture.sample) {
        // `s-<epoch>-<hex>` joins `su-…` and the bare uuid as a THIRD real shape:
      // the SQL corpus reads its sid from `tool_invocations.coord_owner_id`,
      // which carries that form for a non-psu principal. Widened rather than
      // dropping the sample — the assertion is "a real corpus id, not a
      // hand-written example", and this is a real corpus id.
      expect(entry.sid).toMatch(/^su?-|^[0-9a-f-]{8,}/);
      }
    });

    it('is enforced only if some authority OTHER than this audit grants it', () => {
      // The one legitimate reason to gate a pattern with no verdict: D-003's
      // pre-existing-rule carve-out. Anything else reaching `deny`/`advise` here
      // would be enforcement resting on nothing at all.
      if (pair.policyTier) expect(pair.policyTier).toBe('deny');
    });
    return;
  }

  it(`carries at least ${MIN_SAMPLE_SIZE} real commands, by sample or by census`, () => {
    // Two admissible shapes (see auditPair's census note): a normal pair carries
    // >= MIN_SAMPLE_SIZE distinct spellings, while a HOMOGENEOUS pair carries
    // every spelling that exists, drawn from a large fleet-wide population. What
    // is never admissible is thin evidence — which both branches still forbid.
    if (fixture.sample.length < MIN_SAMPLE_SIZE) {
      expect(fixture.totalAtoms).toBeGreaterThanOrEqual(MIN_POPULATION_ATOMS);
      expect(fixture.totalSessions).toBeGreaterThanOrEqual(MIN_POPULATION_SESSIONS);
    } else {
      expect(fixture.sample.length).toBeGreaterThanOrEqual(MIN_SAMPLE_SIZE);
    }
    // Every sampled command must be a real one drawn from the corpus, not a
    // hand-written example that happens to pass.
    for (const entry of fixture.sample) {
      // `s-<epoch>-<hex>` joins `su-…` and the bare uuid as a THIRD real shape:
      // the SQL corpus reads its sid from `tool_invocations.coord_owner_id`,
      // which carries that form for a non-psu principal. Widened rather than
      // dropping the sample — the assertion is "a real corpus id, not a
      // hand-written example", and this is a real corpus id.
      expect(entry.sid).toMatch(/^su?-|^[0-9a-f-]{8,}/);
    }
  });

  it('records the verdict the harness actually computes', () => {
    const audit = auditPair(pair, fixture.sample, fixture);
    expect(audit.verdict).toBe(pair.expectedVerdict);
    expect(audit.sampleSize).toBe(fixture.sample.length);
  });

  it('explains every failure it reports', () => {
    const audit = auditPair(pair, fixture.sample, fixture);
    for (const failure of audit.failingCases) {
      expect(failure.reason.length).toBeGreaterThan(10);
      expect(failure.atom).toBeTruthy();
    }
    // An `equivalent` verdict must have nothing left to explain.
    if (audit.verdict === 'equivalent') expect(audit.failingCases).toHaveLength(0);
  });

  it('produces a concrete tool expression for every covered command', () => {
    for (const entry of fixture.sample) {
      const result = pair.cover(entry.atom);
      if (result.covered) {
        expect(result.expression).toContain(pair.toolName);
      } else {
        expect(result.reason).toBeTruthy();
      }
    }
  });
});

/**
 * Regression guards for the mis-scorings the harness caught on its first real
 * run. Each of these was a live bug in the envelope, and each would have
 * produced a WRONG verdict — two of them optimistic.
 */
describe('file-read pattern boundaries', () => {
  const claims = (pair: (typeof FILE_READ_PAIRS)[number], atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  /**
   * THE BLAST-RADIUS GUARD (D-044). Everything else in this block predates
   * enforcement and asserts that an excluded form draws no ADVISORY. Since these
   * four rows moved to `deny`, the same exclusions carry a far heavier
   * consequence: a form that leaks into a pattern is no longer a bad suggestion,
   * it is a command the agent CANNOT RUN — fleet-wide, on a family that fires
   * ~690 times in 12h here, and with no degraded mode.
   *
   * So this asserts the property against the WHOLE deny set at once rather than
   * pair-by-pair. A widening usually lands on one pair, and the author is looking
   * at that pair's own tests; this one fails wherever it lands, and says why.
   *
   * Each case is a form `capability:read` genuinely cannot express — verified
   * against the tool's envelope, not assumed — so bash remains the correct answer
   * and blocking it would be the D-001 harm the registry exists to prevent.
   */
  it('never claims a form that has no tool expression', () => {
    const enforced = FILE_READ_PAIRS;
    expect(enforced.length).toBe(4);

    const unexpressible: Array<[string, string]> = [
      ['tail -f /tmp/run.log', 'streaming follow — capability:read has no streaming form'],
      ['tail --follow=name /tmp/run.log', 'streaming follow, long form'],
      ['head -c 2000 /tmp/run.log', 'raw-byte window — byte mode returns structured base64'],
      ['tail -c 2000 /tmp/run.log', 'raw-byte window, and no EOF-relative byte offset exists'],
      ['cat -A /tmp/x.raw', 'renders non-printing characters; the tool returns text only'],
      ['cat -v /tmp/x.raw', 'renders non-printing characters'],
      ['cat -', 'reads stdin, not a file'],
      ['sed -n "1,200p"', 'stdin pipe filter — no file operand to hand the tool'],
      ['head -20', 'stdin pipe filter'],
      ['tail -16', 'stdin pipe filter'],
      ["cat > /tmp/x.ts << 'EOF'", 'heredoc — a WRITE, the opposite of a read'],
      ['cat /tmp/a.log > /tmp/b.log', 'stdout redirect — a write'],
      ['cat $TRIAGE/scn.log', 'shell expansion — no literal path to pass'],
      ['cat /tmp/a.log /tmp/b.log', 'two files in one call; capability:read takes one file_path'],
      ['head -1 serve-a-*.log', 'glob — no literal path to pass'],
    ];

    for (const [atom, why] of unexpressible) {
      for (const pair of enforced) {
        expect(claims(pair, atom), `${pair.id} would BLOCK \`${atom}\` — ${why}`).toBe(false);
      }
    }
  });

  /**
   * The PATTERN still claims a piped stage, and that is correct — the pattern
   * sees one atom and cannot see the pipe. Suppression happens a layer up, in
   * the advisory path, which is the only layer that has the whole command.
   *
   * Kept as a pair with the advisory-path test in `match.test.ts`: together they
   * say "the pattern matches, and the advice is withheld anyway". Asserting only
   * the second would leave it ambiguous whether the rule works or the pattern
   * merely stopped matching.
   */
  it('leaves the piped stage to the advisory layer, not the pattern', () => {
    expect(claims(catFileRead, 'cat package.json')).toBe(true);
    expect(claims(headFileRead, 'head -n 5 package.json')).toBe(true);
  });

  /**
   * The positive control for the guard above. A test that only proves things do
   * NOT match still passes if the patterns stop matching anything at all — at
   * which point enforcement is silently dead and the suite is green. These are
   * the forms the deny set is SUPPOSED to claim.
   */
  it('still claims the forms the mandate is actually about', () => {
    expect(claims(sedRangeRead, "sed -n '1,80p' packages/operator-core/lib/x.ts")).toBe(true);
    expect(claims(catFileRead, 'cat packages/operator-core/lib/x.ts')).toBe(true);
    expect(claims(catFileRead, 'cat -n packages/operator-core/lib/x.ts')).toBe(true);
    expect(claims(headFileRead, 'head -n 40 packages/operator-core/lib/x.ts')).toBe(true);
    expect(claims(tailFileRead, 'tail -n 60 /tmp/gate.log')).toBe(true);
  });

  it('excludes pipe filters, which are stream shaping and not file reads', () => {
    // `head`/`tail` are dominated by this form (11,381 head atoms, only 408
    // distinct) — claiming them would swamp the registry with false advisories.
    expect(claims(headFileRead, 'head -20')).toBe(false);
    expect(claims(tailFileRead, 'tail -16')).toBe(false);
    expect(claims(sedRangeRead, 'sed -n "1,200p"')).toBe(false);
  });

  it('excludes heredocs and stdout redirects, which are writes', () => {
    expect(claims(catFileRead, "cat > /tmp/x.ts << 'EOF'")).toBe(false);
    expect(claims(catFileRead, 'cat /tmp/a.log > /tmp/b.log')).toBe(false);
  });

  it('treats a stderr redirect as noise, not as a write', () => {
    // `2>/dev/null` rides on a large share of real reads; scoring it as a write
    // mis-failed a third of the cat sample.
    expect(claims(catFileRead, 'cat /tmp/a.log 2>/dev/null')).toBe(true);
    expect(catFileRead.cover('cat /tmp/a.log 2>/dev/null').covered).toBe(true);
  });

  it('does not mistake a flag argument for a second file', () => {
    // `tail -n 40 FILE` parses as flag(-n) arg(40) operand(FILE) — reading `40`
    // as a filename made every -n form look like a two-file read.
    const result = tailFileRead.cover('tail -n 40 /tmp/run.log');
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('tail: 40');
  });

  it('excludes shell expansion, which has no literal path to pass', () => {
    expect(claims(catFileRead, 'cat $TRIAGE/scn.log')).toBe(false);
    expect(claims(catFileRead, 'cat "$B/build-provenance.json"')).toBe(false);
  });

  it('claims ~/ paths now that capability:read expands them', () => {
    expect(claims(catFileRead, 'cat ~/.papercusp/live-fed-gate/last-downgrade')).toBe(true);
    expect(catFileRead.cover('cat ~/.papercusp/state').covered).toBe(true);
  });

  it('excludes follow mode and raw-byte windows as different answer shapes', () => {
    expect(claims(tailFileRead, 'tail -f /tmp/run.log')).toBe(false);
    expect(claims(headFileRead, 'head -c 2000 /tmp/run.log')).toBe(false);
    expect(claims(tailFileRead, 'tail -c 2000 /tmp/run.log')).toBe(false);

    // The byte-page tool surface is real, but it returns JSON/base64 rather than
    // the raw stdout these commands emit. Keep the ENVELOPE loud too, so a later
    // pattern regression cannot silently promote a false equivalence.
    expect(headFileRead.cover('head -c 2000 /tmp/run.log')).toMatchObject({
      covered: false,
      reason: expect.stringContaining('structured base64'),
    });
    expect(tailFileRead.cover('tail -c 2000 /tmp/run.log')).toMatchObject({
      covered: false,
      reason: expect.stringContaining('structured base64'),
    });
  });

  it('maps a sed range onto offset+limit exactly', () => {
    const result = sedRangeRead.cover("sed -n '110,200p' packages/operator-core/lib/x.ts");
    expect(result.covered).toBe(true);
    expect(result.expression).toContain('offset: 110');
    expect(result.expression).toContain('limit: 91');
  });

  /**
   * EI-18799531134810488. `head`/`tail` used to require a SLASH in the operand,
   * so a bare filename in the cwd was silently unclaimed while the sibling
   * `sed`/`cat` rows claimed the same file — measured live as the single miss in
   * a 17-case probe battery against the registry.
   */
  it('claims a bare filename, not only a path-qualified one', () => {
    expect(claims(headFileRead, 'head -n 20 foo.ts')).toBe(true);
    expect(claims(tailFileRead, 'tail -n 50 build.log')).toBe(true);
    expect(claims(headFileRead, 'head -40 README.md 2>/dev/null')).toBe(true);
    expect(claims(tailFileRead, 'tail -100 local-matrix.out 2>&1')).toBe(true);
    // …and still claims the path-qualified form it always did.
    expect(claims(tailFileRead, 'tail -n 40 /tmp/run.log')).toBe(true);
  });

  /**
   * The slash had been MASKING these: a real path almost always contains one, a
   * fragment almost never does. Dropping it without replacing the operand shape
   * would have re-admitted all three classes as live advisories.
   */
  it('excludes globs, which have no literal path to hand the tool', () => {
    expect(claims(headFileRead, 'head -1 serve-a-*.log')).toBe(false);
    expect(claims(tailFileRead, 'tail -20 ~/.papercusp/logs/operator*.log 2>/dev/null')).toBe(false);
    expect(claims(catFileRead, 'cat /tmp/live-fed-gate/last-* 2>/dev/null')).toBe(false);
    expect(claims(sedRangeRead, "sed -n '1,80p' libs/db/sql/630-*.sql 2>/dev/null")).toBe(false);
  });

  it('excludes process substitution, which is a stream and not a path', () => {
    expect(claims(headFileRead, 'head -n 5 <(cat a.ts)')).toBe(false);
    expect(claims(tailFileRead, 'tail -n 5 <(cat a.ts)')).toBe(false);
  });

  /**
   * `atomize` is not a shell parser (by design), so an inlined script payload
   * splits into pseudo-atoms headed by a real verb — the EI-18733363666718163
   * class that already bit the `ps` pair. Each of these is a real corpus atom.
   */
  it('excludes atomize fragments of inlined script payloads', () => {
    expect(claims(headFileRead, 'head ==="')).toBe(false);
    expect(claims(headFileRead, "head -5 a.ts'],")).toBe(false);
    expect(claims(tailFileRead, 'tail -150 &')).toBe(false);
    expect(claims(tailFileRead, 'tail = data[idx+len(needle):idx+len(needle)+120]')).toBe(false);
    // An unbalanced trailing quote is a fragment, not a path — `cover()` would
    // otherwise hand the tool `~/mac-flip-e2e.log'` and it would not resolve.
    expect(claims(tailFileRead, "tail -30 ~/mac-flip-e2e.log' 2>/dev/null")).toBe(false);
  });

  /**
   * A multi-file read has no `capability:read` expression (one `file_path` per
   * call), so per D-008 it belongs outside the pattern rather than being claimed
   * and then failed by the envelope. It WAS being claimed, on all four rows —
   * the frozen 24-atom samples just happened to miss it.
   */
  it('excludes multi-file reads, which take one file_path per call', () => {
    expect(claims(headFileRead, 'head -20 a.ts b.ts')).toBe(false);
    expect(claims(catFileRead, 'cat a.ts b.ts')).toBe(false);
    expect(claims(tailFileRead, 'tail -5 pkg/a/boot.ts pkg/b/boot.ts 2>/dev/null')).toBe(false);
  });

  it('claims quoted paths and paths carrying a colon, which are real here', () => {
    // Scratch dirs on this box are named after tool verbs (`…/coord:inbox/…`).
    expect(claims(tailFileRead, 'tail -60 /home/dev/.papercusp/scratch/ws/coord:inbox/abc.md')).toBe(true);
    expect(claims(tailFileRead, 'tail -30 "/tmp/claude-1000/-home-dev-papercusp/f261/tasks/b9j.output"')).toBe(true);
  });

  /**
   * `capability:read` returns the file WITH line numbers, so `cat -n` is a
   * faithful substitution. `cat -A`/`-v` render non-printing characters — a
   * different intent with no tool form, and 32 real atoms wide.
   */
  it('claims cat -n but not the non-printing-character flags', () => {
    expect(claims(catFileRead, 'cat -n packages/operator-core/lib/x.ts')).toBe(true);
    expect(claims(catFileRead, 'cat -A /tmp/su-repro/nc-fetch.raw 2>/dev/null')).toBe(false);
    expect(claims(catFileRead, 'cat -v /tmp/x.bin')).toBe(false);
  });

  /**
   * The tripwire for the assertion above, mirroring the `ps` pair's. The `-A`
   * exclusion must live in the PATTERN — but the ENVELOPE has to reject it too,
   * or a pattern regression would leak a `-A` atom that still scores COVERED,
   * leaving the verdict green while a wrong advisory ships.
   */
  it('scores cat -A as unexpressible, so a broken pattern exclusion is loud', () => {
    const result = catFileRead.cover('cat -A /tmp/x.raw');
    expect(result.covered).toBe(false);
    expect(result.reason).toContain('non-printing');
  });
});

describe('postgres pattern boundaries', () => {
  const claims = (pair: (typeof ALL_PAIRS)[number], atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  const OPERATOR = 'psql "postgresql://harness_admin:pwd@localhost:5432/papercusp"';

  it('claims a SELECT against the operator database', () => {
    expect(claims(psqlSelectRead, `${OPERATOR} -c "SELECT count(*) FROM harness_shared.work_items"`)).toBe(true);
  });

  /**
   * The most important guard in this file. `dev:pg_query` has NO database
   * selector, so nudging a non-operator psql call toward it would silently
   * query the WRONG DATABASE and return plausible rows instead of an error —
   * strictly worse than the raw psql it replaced.
   */
  it('never claims a query against another database', () => {
    expect(claims(psqlSelectRead, 'psql "$ODDS_DB" -c "SELECT 1"')).toBe(false);
    expect(claims(psqlSelectRead, 'psql "$PGURL/oddsmith_028_rehearsal" -c "SELECT 1"')).toBe(false);
    expect(claims(psqlSelectRead, 'psql -h localhost -U harness_admin -d wi5635_scratch -c "SELECT 1"')).toBe(false);
  });

  it('never claims a write, a heredoc, or a -f script', () => {
    expect(claims(psqlSelectRead, `${OPERATOR} -c "INSERT INTO t VALUES (1)"`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} -c "CREATE TABLE t (id int)"`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} <<'SQL'`)).toBe(false);
    expect(claims(psqlSelectRead, `${OPERATOR} -1 -f packages/db/sql/028.sql`)).toBe(false);
  });

  it('claims the relation-describing meta-commands', () => {
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\d harness_shared.agent_facts"`).expression).toContain(
      'describe: "harness_shared.agent_facts"',
    );
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\dt harness_shared.*"`).covered).toBe(true);
    expect(psqlDescribe.cover(`${OPERATOR} -c "\\d+ work_items"`).covered).toBe(true);
  });

  it('excludes non-relation object classes, which describe does not cover', () => {
    // `\df` lists FUNCTIONS — a different object class, not a missing corner of
    // relation description. Claiming it would promise something describe cannot do.
    expect(claims(psqlDescribe, `${OPERATOR} -c "\\df+ harness_shared.some_fn"`)).toBe(false);
    expect(claims(psqlDescribe, `${OPERATOR} -c "\\du"`)).toBe(false);
  });
});

/**
 * P-008. The plan's first NEGATIVE verdict, so these guards protect a
 * conclusion rather than a substitution: they must fail if anyone starts
 * routing `ps`/`pgrep` at `dev:processes`.
 */
describe('process pattern boundaries (a not-a-substitute verdict)', () => {
  const claims = (atom: string) =>
    matchingAtoms(psProcessQuery, [{ sid: 's', ts: 't', atom }]).length === 1;

  it('claims the job-liveness questions the family is actually made of', () => {
    expect(claims('ps -p 636440 -o pid,etime,cmd')).toBe(true);
    expect(claims('pgrep -f "tsc --noEmit"')).toBe(true);
    expect(claims('ps aux')).toBe(true);
    expect(claims('ps --ppid 3823918 -o pid,cmd')).toBe(true);
  });

  it('covers none of them — dev:processes has no pid, name or parent selector', () => {
    for (const atom of [
      'ps -p 636440 -o pid,etime,cmd',
      'pgrep -f "tsc --noEmit"',
      'ps aux',
      'ps --ppid 3823918 -o pid,cmd',
    ]) {
      const result = psProcessQuery.cover(atom);
      expect(result.covered, `${atom} should have no dev:processes expression`).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  /**
   * The D-008 boundary. Searching for an agent kind IS `dev:processes`' question
   * and it answers it exactly, so that intent is excluded from this pattern
   * rather than dragging a genuinely-covered case into a negative verdict.
   */
  it('excludes searches for an agent kind, which are a different intent', () => {
    expect(claims('pgrep -fc "claude"')).toBe(false);
    expect(claims('pgrep -af omp')).toBe(false);
    expect(claims('pgrep -f next-server')).toBe(false);
  });

  /**
   * The tripwire. The exclusion above must live in the PATTERN; if it instead
   * lived in a rigged `cover()` that returned false for everything, this
   * assertion would fail — and if the lookahead ever breaks, the excluded atom
   * reaches `cover()`, scores COVERED, and flips the recorded verdict.
   */
  it('still scores an agent-kind search as covered, so a broken exclusion is loud', () => {
    const result = psProcessQuery.cover('pgrep -fc "claude"');
    expect(result.covered).toBe(true);
    expect(result.expression).toContain("kinds: ['claude']");
  });

  it('does not reach across to psql, which is a different family', () => {
    expect(claims('psql -d papercusp -c "SELECT 1"')).toBe(false);
  });

  it('is never promotable past observe', () => {
    expect(psProcessQuery.expectedVerdict).toBe('not-a-substitute');
    expect(maxTierFor(psProcessQuery.expectedVerdict)).toBe('observe');
  });

  /**
   * EI-18733363666718163. `atomize` is not a shell parser, so an inlined
   * script payload (`python3 -c "..."`) splits into pseudo-verb atoms headed
   * by short identifiers — including one that happens to start with `ps`.
   * A bare `\b` anchor sits between `ps` and `=` (both are non-word-adjacent),
   * so it used to claim a python assignment as a process-liveness query. The
   * anchor now requires a shell-argument boundary (whitespace or end of atom).
   */
  it('does not false-positive on a python assignment that starts with ps/pgrep', () => {
    expect(claims("ps=json.load(sys.stdin)['status']")).toBe(false);
    expect(claims('pgrep=some_other_value')).toBe(false);
    expect(claims('pshell --foo')).toBe(false);
  });
});

/**
 * The SERVICE family (P-009). Three pairs, drawn on intent boundaries, and the
 * boundaries are the whole finding: `dev:service_health` takes no arguments, so
 * what it can answer is fixed by which services something PROBES — not by which
 * units are in the supervision registry, and not by which port you care about.
 */
describe('service pattern boundaries', () => {
  const claims = (pair: typeof systemctlIsActive, atom: string) =>
    matchingAtoms(pair, [{ sid: 's', ts: 't', atom }]).length === 1;

  describe('systemctl unit liveness (equivalent since P-014)', () => {
    it('claims the boolean-liveness verbs', () => {
      expect(claims(systemctlIsActive, 'systemctl --user is-active papercup-bg-host.service')).toBe(true);
      expect(claims(systemctlIsActive, 'systemctl --user is-failed papercusp-db-backup.service 2>&1')).toBe(true);
      expect(claims(systemctlIsActive, 'systemctl is-active auditd 2>&1')).toBe(true);
    });

    /**
     * `status` is EXCLUDED deliberately: it returns the unit's journal tail as
     * well as its state (21 distinct corpus shapes pass `-n <N>` asking for
     * exactly those lines), and `dev:service_health` returns no journal at all.
     * `show`/`cat`/`list-timers` ask about CONFIG and SCHEDULE, which it also
     * cannot produce. Enforcing a liveness advisory over any of them would
     * answer a question the agent did not ask.
     */
    it('excludes status, show, cat and the list verbs — different questions', () => {
      expect(claims(systemctlIsActive, 'systemctl --user status papercup-bg-host.service --no-pager -n 20')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user show papercup-bg-host.service -p NRestarts')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user cat papercup-dev-api.service')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user list-timers papercup-live-federation-gate.timer')).toBe(false);
      expect(claims(systemctlIsActive, 'systemctl --user restart papercup-bg-host.service')).toBe(false);
    });

    /** The genuine overlap, and the tripwire: these three units ARE probed, so a
     *  rigged envelope that covered nothing would fail here. */
    it('covers exactly the units something probes', () => {
      for (const [unit, probe] of [
        ['papercusp-dev-api.service', 'operator'],
        ['papercup-dev-api.service', 'operator'],
        ['papercusp-bg-host.service', 'bg-host-ticker'],
        ['papercup-bg-host.service', 'bg-host-ticker'],
        ['papercup-embed-sidecar.service', 'embed-sidecar'],
      ] as const) {
        const result = systemctlIsActive.cover(`systemctl --user is-active ${unit}`);
        expect(result.covered, `${unit} should be answerable`).toBe(true);
        expect(result.expression).toContain(probe);
      }
    });

    /**
     * ⚠ INVERTED DELIBERATELY by WI-6149 (D-010 item 4) — read this before
     * "fixing" it back.
     *
     * What stood here asserted that a supervised-but-unprobed unit is NOT
     * covered, "because a supervision row carries flap/restart counters and no
     * up-or-down field, and a stopped unit is indistinguishable from a failed
     * probe". That sentence described the tool as it was BEFORE D-010 item 2:
     * `activeState` (systemd verbatim) + `healthy` (the reconciler's own oracle)
     * are now on every systemd-user supervision row, and a probe failure is
     * distinguishable — it omits the fields entirely.
     *
     * `systemctl is-active <unit>` asks systemd for `ActiveState`. The tool
     * returns that same string. That is a faithful answer, so it counts. The
     * REMAINING gap for these units — nothing confirms they are actually
     * SERVING — is a different question, owned by `curlHealthProbe`, and folding
     * it in here would enforce an advisory against a question the agent did not
     * ask (the same reasoning that keeps `systemctl status` out of this pair).
     *
     * This is the second time this pair carried a failure reason that had gone
     * stale under it; `pairs/service-model-drift.test.ts` is the guard for that
     * class.
     */
    it('DOES cover a supervised-but-unprobed unit via supervision[].activeState', () => {
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-inference-gateway.service');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('inference-gateway');
      expect(result.expression).toContain('activeState');
    });

    /**
     * WI-6149: the episodic case, asserted separately because it is the one where
     * `is-active`'s own answer MISLEADS and the tool's is better. The federation
     * gate is a timer-driven oneshot: `systemctl is-active` prints "inactive"
     * (exit 3) for a perfectly healthy gate, while the supervision row says
     * `activeState:'inactive'` AND `healthy:true` AND `episodic:true`.
     */
    it('covers the episodic federation gate, including its .timer', () => {
      for (const unit of ['papercup-live-federation-gate.service', 'papercup-live-federation-gate.timer']) {
        const result = systemctlIsActive.cover(`systemctl --user is-active ${unit}`);
        expect(result.covered, `${unit} should be answerable`).toBe(true);
        expect(result.expression).toContain('healthy');
      }
      // The `.timer` must resolve to its OWN row, not the service's.
      expect(
        systemctlIsActive.cover('systemctl --user is-active papercup-live-federation-gate.timer').expression,
      ).toContain('live-federation-gate-timer');
    });

    /**
     * WI-6146 / WI-6153. This assertion is the INVERSE of what stood here
     * before: `papercup-staging-api` was the headline supervised-but-unprobed
     * unit (34 is-active/status reads in the 7d corpus, more than any other),
     * and P-013 item 1 gave it a probe. Kept as a regression guard so the
     * coverage cannot silently disappear again if the endpoint is removed —
     * pairs/service-model-drift.test.ts guards the same fact from the model side.
     */
    it('DOES cover staging-api now that :3170 is probed (was the headline gap)', () => {
      for (const unit of ['papercusp-staging-api.service', 'papercup-staging-api.service']) {
        const result = systemctlIsActive.cover(`systemctl --user is-active ${unit}`);
        expect(result.covered).toBe(true);
        expect(result.expression).toContain('staging-api');
      }
    });

    /**
     * ⚠ ALSO INVERTED by WI-6149 (D-010 item 4). `papercup-oddsmith-sidecar` was
     * this pair's headline uncovered unit — 73 `is-active` atoms, more than any
     * other, plus 28 of the 32 raw `restart` atoms. Item 4 measured it
     * (persistent `Type=simple`, `Restart=always`, fixed `ODDSMITH_HONO_PORT=46229`,
     * ~22 restarts/day with a ≤2s window) and gave it a damped probe. Kept as a
     * regression guard, since the verdict now rests on this coverage.
     */
    it('DOES cover oddsmith-sidecar now that :46229 is probed (was the headline gap)', () => {
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-oddsmith-sidecar.service');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('oddsmith-sidecar');
    });

    /**
     * WI-6149: the exclusions are the OTHER half of item 4's answer, and each
     * reports WHY it can never be registered rather than a bare "not registered"
     * — an unexplained exclusion reads as an oversight and invites the next agent
     * to add a probe that would alarm constantly.
     */
    /**
     * ⚠ INVERTED AGAIN by P-014 (WI-6244) — the THIRD time an assertion in this
     * describe has been flipped by a real widening, and the reason is different
     * from the previous two. WI-6146/WI-6149 flipped units by REGISTERING them.
     * This flip registers nothing: `dev:service_health { units:[…], scope }`
     * reaches a unit WITHOUT registering it, so a deliberately-unregistered unit
     * is now answerable while still being deliberately unregistered.
     *
     * Both halves are asserted, because losing either would be a real
     * regression: the atom is COVERED (the state question is answered) AND the
     * structural reason still rides along in the expression (so nobody reads the
     * new coverage as "it should be registered after all").
     */
    it('covers a deliberately-excluded unit via `units`, still carrying its structural reason', () => {
      for (const [atom, needle] of [
        ['systemctl --user is-active papercusp-db-backup.service', 'ONESHOT'],
        ['systemctl --user is-active papercup-green-checkpoint-manual-1fxzuva.service', 'TRANSIENT'],
        ['systemctl is-active auditd', 'SYSTEM-scope'],
        ['systemctl is-active fail2ban', 'NOT INSTALLED'],
      ] as const) {
        const result = systemctlIsActive.cover(atom);
        expect(result.covered, atom).toBe(true);
        expect(result.expression, atom).toContain('units:');
        expect(result.expression, atom).toContain(needle);
      }
    });

    /**
     * P-014: scope is derived from the atom, and `systemctl` with NEITHER flag
     * defaults to `--system`. Getting this wrong would emit an expression that
     * queries a manager which cannot hold the answer — the `logs:read`
     * `system: boolean` defect, in a different tool.
     */
    it('derives the systemd manager from the atom, defaulting a bare systemctl to system', () => {
      expect(systemctlIsActive.cover('systemctl is-active auditd').expression).toContain("scope: 'system'");
      expect(
        systemctlIsActive.cover('systemctl --user is-active papercusp-db-backup.service').expression,
      ).toContain("scope: 'user'");
    });

    /**
     * WI-6149 asserted this was UNCOVERABLE; P-014 makes it expressible, because
     * `units` is an array and one `systemctl show` serves the whole list. Note
     * the observed corpus atom `is-active papercup-dev-api papercup-staging-api`
     * was ALREADY answerable before the widening — both units are probed — so
     * the old blanket refusal was scoring a wrong miss even on its own terms.
     */
    it('covers a multi-unit call in one `units` array, naming every unit', () => {
      const result = systemctlIsActive.cover('systemctl is-active fail2ban crowdsec 2>/dev/null');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain("'fail2ban'");
      expect(result.expression).toContain("'crowdsec'");
      expect(result.expression).toContain('unitsUnknown');
    });

    /**
     * THE POINT OF THE WHOLE WIDENING, asserted as a boundary: an unknown unit is
     * not merely covered — it is answered BETTER than by the command it replaces.
     * `systemctl is-active <nonexistent>` prints `inactive`, byte-identical to a
     * stopped service; three units in the 7d corpus (papercup-auto-deploy,
     * papercup-green-checkpoint, papercup-pgbouncer) are exactly that case.
     */
    it('covers a genuinely unknown unit — and routes it at loadState, not activeState', () => {
      const result = systemctlIsActive.cover('systemctl --user is-active papercup-not-a-real-unit.service');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('loadState');
    });

    /** A glob or `$(…)` names nothing `units` can carry — the one shape left in bash. */
    it('still refuses a glob or shell substitution — `units` takes literal names', () => {
      const result = systemctlIsActive.cover("systemctl --user is-active 'papercup-*'");
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('literal unit names');
    });
  });

  describe('curl health probe (equivalent since P-014)', () => {
    /**
     * ⚠ NARROWED by P-014 (WI-6244). The pattern used to claim EVERY loopback
     * health/version curl and then fail most of them in `cover()` — 96 of 138
     * corpus atoms — which scored the pair `needs-widening` for behaving exactly
     * as its own advisory documented. Both residues are shapes the tool
     * DELIBERATELY declines, so they belong outside the claim:
     *   • no `-o /dev/null` ⇒ the BODY is wanted (79 atoms, the majority intent
     *     — see HEALTH_PAYLOAD_FINDING);
     *   • an unprobed port ⇒ the fixed probe set cannot reach it.
     */
    it('claims a liveness-only probe of a PROBED port', () => {
      expect(claims(curlHealthProbe, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3070/api/health')).toBe(true);
      expect(claims(curlHealthProbe, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3170/api/health 2>&1')).toBe(true);
    });

    it('does NOT claim a body read or an unprobed port — different questions, not gaps', () => {
      // The majority intent: read the payload. dev:service_health never carries it.
      expect(claims(curlHealthProbe, 'curl -s http://127.0.0.1:3070/api/health')).toBe(false);
      // :8788 is the inference gateway — deliberately unprobed (its /health needs
      // an auth header, so an unauthenticated probe would manufacture a phantom DOWN).
      expect(claims(curlHealthProbe, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/health')).toBe(false);
    });

    /**
     * The pattern is BUILT from PROBED_PORTS, so adding a probe automatically
     * widens the claim rather than leaving a hand-written list behind. Asserted
     * directly because a drifted second model is the exact staleness class D-016
     * exists to catch.
     */
    it('derives its port list from PROBED_PORTS rather than a hand-written copy', () => {
      for (const port of Object.keys(PROBED_PORTS)) {
        expect(
          claims(curlHealthProbe, `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/api/health`),
          `:${port} is probed, so the pattern must claim it`,
        ).toBe(true);
      }
      expect(buildProbedPortCurlPattern(['9999']).source).toContain('9999');
    });

    it('excludes remote hosts and non-health routes', () => {
      expect(claims(curlHealthProbe, 'curl -s https://papercusp.com/api/health')).toBe(false);
      expect(claims(curlHealthProbe, 'curl -s http://127.0.0.1:3070/api/mcp')).toBe(false);
    });

    /** The tripwire: a probed port, body discarded, is genuinely answered. */
    it('covers a liveness-only probe of a port it actually probes', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3070/api/health',
      );
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('operator');
    });

    /**
     * WAS the sharpest single finding in this family, and is now CLOSED —
     * this assertion has been inverted deliberately (WI-6146 / WI-6153).
     *
     * `CLAUDE.md` tells every agent to verify a staging edit by restarting
     * `:3170` and probing it. `:3170` was not in `HEALTH_ENDPOINTS`, so the
     * documented workflow had no tool form and 80 curl atoms went to bash
     * because there was nowhere else to go. P-013 item 1 added the probe.
     *
     * Kept (inverted) rather than deleted: the coverage is exactly what the
     * pair's verdict and advisoryText now rest on, so it needs a guard.
     */
    it('DOES answer for :3170 now that the staging operator is probed', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3170/api/health',
      );
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('staging-api');
    });

    /**
     * The port-gap failure mode has NOT gone away — it moved. :8788 (inference
     * gateway) is the live example, and it is why this pair does not simply
     * become `equivalent` on the strength of :3170.
     */
    it('still cannot answer for a port it does not probe (:8788 gateway) [envelope backstop]', () => {
      const result = curlHealthProbe.cover(
        'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8788/health',
      );
      expect(result.covered).toBe(false);
      expect(result.reason).toContain(':8788');
    });

    /**
     * P-014: these two `cover()` refusals are now BACKSTOPS, not the live path —
     * the pattern no longer claims either shape. They are kept deliberately (the
     * D-008 anti-rot rule): if the pattern is ever loosened, the envelope fails
     * loudly instead of the pair silently claiming a question it answers wrong.
     */
    it('cannot answer when the response BODY is what is wanted [envelope backstop]', () => {
      const result = curlHealthProbe.cover('curl -s http://127.0.0.1:3070/api/health');
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('BODY');
    });
  });

  describe('listening sockets (equivalent since P-014)', () => {
    it('claims the LISTEN-query shapes', () => {
      expect(claims(listeningPorts, 'ss -ltnp 2>/dev/null')).toBe(true);
      expect(claims(listeningPorts, 'netstat -tlnp 2>/dev/null')).toBe(true);
      expect(claims(listeningPorts, 'lsof -nP -iTCP:3070 -sTCP:LISTEN')).toBe(true);
    });

    /**
     * ⚠ NARROWED by P-014 (WI-6244): LISTEN-ness is part of the CLAIM now, not
     * something `cover()` rejects afterwards. All 49 corpus misses were this one
     * axis — an established-connection census is a different question from "what
     * is listening", which is this pair's whole intentLabel, so the pattern was
     * over-claiming. See SOCKET_STATE_FINDING for what the narrowing drops.
     */
    it('does NOT claim an all-states / UDP query — a different question, not a gap', () => {
      for (const atom of [
        'ss -tn 2>/dev/null',
        'ss -tnp state established \'( dport = :5432 )\'',
        'ss -tinp 2>/dev/null',
        'netstat -an -p tcp 2>/dev/null',
        'lsof -nP -iTCP:8044 2>&1',
        'ss -lunp 2>/dev/null', // has -l, but UDP
      ]) {
        expect(claims(listeningPorts, atom), `${atom} must fall outside the claim`).toBe(false);
      }
    });

    /**
     * A real regression, caught by the harness the first time this pattern ran:
     * `^ss\b` claimed JavaScript heredocs (`ss._blocked = true`,
     * `ss = makeStore()`) as if they were socket queries. A pattern that claims
     * a language's variable names is not claiming an intent.
     */
    it('does not claim JavaScript that merely starts with the letters ss', () => {
      expect(claims(listeningPorts, 'ss._blocked = true')).toBe(false);
      expect(claims(listeningPorts, 'ss = makeStore()')).toBe(false);
    });

    it('does not claim lsof against a FILE, which is a lock query', () => {
      expect(claims(listeningPorts, 'lsof src-tauri/sidecar.lock 2>/dev/null')).toBe(false);
    });

    /**
     * The tripwire the old comment promised has been cashed in: D-017 built
     * `dev:listening_ports`, so the LISTEN-query shapes that used to have no
     * tool form now have one. These four were the exact atoms asserted as
     * UNCOVERABLE before the re-derivation — keeping them, inverted, is what
     * makes the move visible rather than a silently rewritten expectation.
     */
    it('covers the real LISTEN-query shapes now that dev:listening_ports exists', () => {
      for (const atom of ['ss -ltnp 2>/dev/null', 'ss -ltn', 'lsof -nP -iTCP:3070 -sTCP:LISTEN', 'netstat -tlnp']) {
        const result = listeningPorts.cover(atom);
        expect(result.covered, `${atom} should have a dev:listening_ports expression`).toBe(true);
        expect(result.expression).toContain('dev:listening_ports');
      }
    });

    it('resolves the owner question that was the whole basis of the old refusal', () => {
      const result = listeningPorts.cover('lsof -nP -iTCP:3070 -sTCP:LISTEN');
      expect(result.covered).toBe(true);
      // The refusal used to read "returns no pid or command for any service".
      expect(result.expression).toContain('pid');
      expect(result.expression).toContain('port: 3070');
    });

    it('serves the reverse lookup (which ports does this pid hold) via `pid`', () => {
      const result = listeningPorts.cover('lsof -nP -p "$APPID" -a -iTCP -sTCP:LISTEN');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('pid');
    });

    /**
     * P-014: a BACKSTOP now, not the live path — the pattern no longer claims
     * these. Kept per the D-008 anti-rot rule so a loosened pattern fails loudly
     * here rather than silently answering a connection census with the bind table.
     */
    it('refuses non-LISTEN queries [envelope backstop]', () => {
      for (const atom of ['ss -tn 2>/dev/null', 'ss -tinp 2>/dev/null', 'netstat -an -p tcp']) {
        const result = listeningPorts.cover(atom);
        expect(result.covered, `${atom} asks about established connections`).toBe(false);
        expect(result.reason).toContain('LISTEN sockets only');
      }
      // lsof signals state differently — via -sTCP:LISTEN, not -l.
      const lsofAllStates = listeningPorts.cover('lsof -nP -iTCP:8044');
      expect(lsofAllStates.covered).toBe(false);
      expect(lsofAllStates.reason).toContain('ESTABLISHED');
    });

    /**
     * Exercised DIRECTLY because the frozen sample cannot reach it: both
     * multi-port atoms in the corpus also omit `-sTCP:LISTEN`, so the state
     * check rejects them first. A branch whose correctness is masked by a
     * second defect is untested, not proven — and the masking will disappear
     * the moment the tool grows a state filter.
     */
    it('refuses a multi-port lsof — `port` is a scalar (masked in the sample, tested here)', () => {
      const result = listeningPorts.cover('lsof -nP -iTCP:3070 -iTCP:19045 -iTCP:3170 -sTCP:LISTEN');
      expect(result.covered).toBe(false);
      expect(result.reason).toContain('single scalar');
    });

    it('a port selector carrying a shell variable is still a PORT query, not a table read', () => {
      // Regression: this first emitted the whole-table expression because the
      // operand was not numeric — a wrong expression on a correct `covered`.
      const result = listeningPorts.cover('lsof -nP -iTCP:$p -sTCP:LISTEN');
      expect(result.covered).toBe(true);
      expect(result.expression).toContain('port:');
      expect(result.expression).not.toContain('whole LISTEN table');
    });

    /**
     * P-014 closed the last `needs-widening` verdicts in the plan. `maxTierFor`
     * states what the verdict PERMITS — promotion to `advise` is still P-020's
     * staged decision after a real observation window, never automatic.
     */
    it('all three service pairs now permit `advise` (P-014 closed the family)', () => {
      for (const pair of [systemctlIsActive, curlHealthProbe, listeningPorts]) {
        expect(pair.expectedVerdict, pair.id).toBe('equivalent');
        expect(maxTierFor(pair.expectedVerdict), pair.id).toBe('advise');
      }
    });
  });

  it('the three pairs do not reach across into each other', () => {
    expect(claims(systemctlIsActive, 'curl -s http://127.0.0.1:3070/api/health')).toBe(false);
    expect(claims(curlHealthProbe, 'systemctl --user is-active papercup-bg-host.service')).toBe(false);
    expect(claims(listeningPorts, 'systemctl --user is-active papercup-bg-host.service')).toBe(false);
  });
});

/**
 * The GIT-READ family (P-010). `capability:git` is an argv PASS-THROUGH
 * (`{ args: string[], cwd? }`, spawned with no shell), so unlike every other
 * family the boundary is not "which reads is the tool shaped for" — it is
 * "which argv the SHELL produces rather than the agent".
 */
describe('git-read pattern boundaries', () => {
  const claims = (atom: string) =>
    matchingAtoms(gitReadPassthrough, [{ sid: 's', ts: 't', atom }]).length === 1;

  /**
   * The argv splitter is the load-bearing part of this pair's evidence: a naive
   * whitespace split turns `--format='%H %cI'` into two arguments and `-S "a b
   * c"` into four, so `cover()` would emit an `expression` that does not
   * reproduce the command — false evidence behind a true verdict.
   */
  describe('shellArgv', () => {
    it('keeps a quoted value with spaces as ONE argument', () => {
      expect(shellArgv(`git log --format='%H %cI' -S "reclaimed dead holder"`)).toEqual([
        'git',
        'log',
        '--format=%H %cI',
        '-S',
        'reclaimed dead holder',
      ]);
    });

    it('closes an unterminated quote instead of dropping the fragment', () => {
      // A real corpus atom: `atomize` split inside the quoted regex at its `|`.
      expect(shellArgv('git grep -nEi "select .*from +(harness_shared')).toEqual([
        'git',
        'grep',
        '-nEi',
        'select .*from +(harness_shared',
      ]);
    });
  });

  it('claims the read subcommands, including behind -C and --git-dir', () => {
    expect(claims('git status --short')).toBe(true);
    expect(claims('git log --oneline -5 -- packages/operator-core')).toBe(true);
    expect(claims('git -C libs/papercusp status --porcelain')).toBe(true);
    expect(claims('git --git-dir=/home/x/.git for-each-ref')).toBe(true);
    expect(claims('git merge-base --is-ancestor ff1e25c5 a5ba5521 2>/dev/null')).toBe(true);
  });

  /**
   * The D-008 boundary, and the ONLY one this tool has: `args` is a literal
   * `string[]` and expands nothing, so a command whose argv the shell produces
   * has no tool form. 99 of 2,500 corpus reads (4.0%) are this residue.
   */
  it('excludes commands whose argv comes from the shell', () => {
    expect(claims('git -C "$DESK" rev-parse HEAD 2>/dev/null')).toBe(false);
    expect(claims('git log -1 --format=%H -- $(find . -name x.ts)')).toBe(false);
    expect(claims('git -C $R for-each-ref `cat /tmp/refs`')).toBe(false);
  });

  /** The tripwire: the exclusion must live in the PATTERN, so a substituted
   *  atom that reaches `cover()` scores NOT covered and drops the verdict. */
  it('still scores a substituted atom as uncovered, so a broken exclusion is loud', () => {
    const result = gitReadPassthrough.cover('git -C "$DESK" rev-parse HEAD');
    expect(result.covered).toBe(false);
    expect(result.reason).toContain('LITERAL string[]');
  });

  it('does not claim git writes — git-sync owns commit and push', () => {
    expect(claims('git commit -m "wip"')).toBe(false);
    expect(claims('git push origin staging')).toBe(false);
    expect(claims('git add -A')).toBe(false);
    expect(claims('git reset --hard HEAD')).toBe(false);
  });

  it('renders a faithful tool call, quoted arguments intact', () => {
    const result = gitReadPassthrough.cover(`git log --format='%H %cI' -3 -- bin/lib/x.sh`);
    expect(result.covered).toBe(true);
    expect(result.expression).toBe(
      'capability:git { args: ["log", "--format=%H %cI", "-3", "--", "bin/lib/x.sh"] }',
    );
  });

  it('maps a repo-selecting global flag onto cwd, not onto argv', () => {
    const result = gitReadPassthrough.cover('git -C /home/x/papercup-release rev-parse HEAD 2>/dev/null');
    expect(result.covered).toBe(true);
    expect(result.expression).toBe(
      'capability:git { args: ["rev-parse", "HEAD"], cwd: "/home/x/papercup-release" }',
    );
  });

  it('does not reach across into the other families', () => {
    expect(claims('psql -d papercusp -c "SELECT 1"')).toBe(false);
    expect(claims('ps aux')).toBe(false);
    expect(claims('systemctl --user is-active papercup-bg-host.service')).toBe(false);
  });
});

/**
 * P-028 — the registry's first and only `deny`. Its false-positive budget is
 * ~0, because a wrongly-blocked agent's remaining moves are to route around the
 * guard (which the playbook forbids) or to stall. Every boundary below was
 * measured against the 7d corpus before the row shipped; they are committed
 * here rather than left in a probe script because THIS is the row where a
 * silent widening does real damage.
 */
describe('dependency-install deny boundaries (P-028)', () => {
  const claims = (atom: string) =>
    matchingAtoms(unsafeDependencyInstall, [{ sid: 's', ts: 't', atom }]).length === 1;

  it('claims the whole-tree reify, which is the shape that corrupts a shared tree', () => {
    expect(claims('npm install')).toBe(true);
    expect(claims('npm ci')).toBe(true);
    expect(claims('npm i')).toBe(true);
    expect(claims('npm install --legacy-peer-deps 2>&1')).toBe(true);
    expect(claims('npm install --legacy-peer-deps > /tmp/install.log 2>&1 &')).toBe(true);
  });

  it('claims named-package installs in the current shared tree (EI-20412068513394843)', () => {
    expect(claims('npm install --no-save --package-lock=false verdict-cli')).toBe(true);
    expect(claims('npm install apache-arrow@21 --silent 2>&1')).toBe(true);
    expect(claims('npm install @apache-arrow/adbc-driver-manager apache-arrow postgres')).toBe(true);
  });

  it('never claims the SAFE form it is telling agents to use', () => {
    // The one false positive that would make the rule unsatisfiable.
    expect(claims('npm run install:safe')).toBe(false);
    expect(claims('npm run install:safe -- ci')).toBe(false);
    expect(claims('npm run install:safe -- install --legacy-peer-deps')).toBe(false);
  });

  it('never claims an unrelated npm script', () => {
    expect(claims('npm run lint:tsc')).toBe(false);
    expect(claims('npm run test:affected')).toBe(false);
    expect(claims('npm run build')).toBe(false);
  });

  /**
   * D-038. 24 of the 60 install-shaped atoms in the corpus are the right-hand
   * FRAGMENT of a `grep -E "npm install|npm ci" <file>` split on the `|` inside
   * the quoted pattern. Denying those blocks the mid-install diagnostic this
   * repo's own guidance prescribes — strictly worse than the incident it guards.
   */
  it('never claims the atomizer fragments a grep-for-install produces', () => {
    expect(claims('npm install\\')).toBe(false);
    expect(claims('npm ci\\')).toBe(false);
    expect(claims('npm ci"')).toBe(false);
    expect(claims('npm ci" bin/mac-vm-build.sh')).toBe(false);
    expect(claims('npm i "')).toBe(false);
    expect(claims("npm install' 2>&1")).toBe(false);
  });

  it('never claims an explicit --prefix scratch-tree install', () => {
    expect(claims('npm install --prefix /tmp/other-tree')).toBe(false);
    expect(claims('npm install --prefix /tmp/other-tree verdict-cli')).toBe(false);
  });

  it('never claims a command that changes nothing', () => {
    expect(claims('npm install --dry-run --no-audit --no-fund 2>&1')).toBe(false);
  });

  it('does not claim a different verb that merely starts with the same letters', () => {
    expect(claims('npm-check-updates')).toBe(false);
    expect(claims('npm installer-thing')).toBe(false);
    expect(claims('npm init -y')).toBe(false);
  });

  it('renders a pass-through invocation, flags intact and redirects dropped', () => {
    expect(unsafeDependencyInstall.cover('npm install --legacy-peer-deps 2>&1').expression).toBe(
      'npm run install:safe -- install --legacy-peer-deps',
    );
    expect(unsafeDependencyInstall.cover('npm install --no-save verdict-cli').expression).toBe(
      'npm run install:safe -- install --no-save verdict-cli',
    );
    expect(unsafeDependencyInstall.cover('npm ci').expression).toBe('npm run install:safe -- ci');
    expect(unsafeDependencyInstall.cover('npm install').expression).toBe('npm run install:safe');
  });
});

/**
 * The guard on the ONE documented way past the observe-first staging (D-003).
 * Without it, `policyTier` would be a field any pair could set to reach `deny`
 * on its author's say-so — precisely the "the gate invents policy" failure the
 * tier system exists to prevent.
 */
describe('policy tier authorization', () => {
  it('defaults every ordinary pair to observe, whatever its verdict', () => {
    const ordinary = ALL_PAIRS.filter((p) => p.policyTier === undefined);
    expect(ordinary.length).toBeGreaterThan(0);
    for (const pair of ordinary) expect(assertPolicyTier(pair)).toBe('observe');
  });

  it('honours a policy tier on a policy-violation intent', () => {
    expect(unsafeDependencyInstall.intentLabel.startsWith(POLICY_INTENT_PREFIX)).toBe(true);
    expect(assertPolicyTier(unsafeDependencyInstall)).toBe('deny');
  });

  it('refuses a tier escalation on an ordinary cost-argument intent', () => {
    expect(() => assertPolicyTier({ ...sedRangeRead, policyTier: 'deny' })).toThrow(
      /not a 'policy-violation:/,
    );
    expect(() => assertPolicyTier({ ...sedRangeRead, policyTier: 'advise' })).toThrow(
      /never asserted/,
    );
  });

  it('keeps the file-read family OUT of any enforcing tier (D-045)', () => {
    // The owner withdrew the block after the pipeline rollback. This is the
    // mechanical form of that ruling: these four teach, and a future edit that
    // quietly re-promotes them fails here rather than fleet-wide.
    for (const pair of FILE_READ_PAIRS) {
      expect(pair.policyTier, `${pair.id} must not declare an enforcing tier`).toBeUndefined();
      expect(assertPolicyTier(pair)).toBe('observe');
    }
  });

  it('leaves the policy hatch reachable ONLY by the policy-violation prefix', () => {
    // The citation route was removed with its last caller (D-045), so the prefix
    // is once again the single way past `observe`. Pinned because "the guard has
    // exactly one route" is the property that makes it auditable.
    const policyPairs = ALL_PAIRS.filter((p) => p.policyTier !== undefined);
    expect(policyPairs.length).toBeGreaterThan(0);
    for (const pair of policyPairs) {
      expect(
        pair.intentLabel.startsWith(POLICY_INTENT_PREFIX),
        `${pair.id} reached ${pair.policyTier} without a policy-violation intent`,
      ).toBe(true);
      expect(assertPolicyTier(pair)).toBe(pair.policyTier);
    }
  });

  it('keeps deny out of what an equivalence score alone can unlock', () => {
    // maxTierFor is the score-driven ceiling; it must never reach `deny`, so the
    // policy hatch stays the only route to it and stays auditable.
    expect(maxTierFor('equivalent')).toBe('advise');
    expect(maxTierFor('needs-widening')).toBe('observe');
  });
});

// The code-search family's boundaries live in `pairs/code-search.test.ts`
// (P-002 / D-010 retarget to lsp:query), beside the project-root pin.
