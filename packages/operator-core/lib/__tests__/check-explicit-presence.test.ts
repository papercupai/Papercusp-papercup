/**
 * check-explicit-presence.test.ts — the WI-6004 zero-value-defaulting-at-a-
 * parse/deserialize-boundary detector (the "mechanical" half of WI-5977,
 * "Adopt explicit-presence as an enforced convention...").
 *
 * The incident class: a layer that cannot tell "absent" from "measured zero"
 * silently picks the type's zero value instead of erroring — udxRelayed absent
 * read as `relayed:false`, bytesReceived absent read as `0`. This locks the
 * analyzer's precision (mirrors check-declared-deps-extracted.test.ts's shape:
 * import the pure function from the .mjs script directly rather than
 * duplicating its logic here):
 *   1. it FLAGS the exact incident shapes (a direct JSON.parse(...).field
 *      chain; a tracked JSON.parse'd / sql-row variable's field, within the
 *      lookback window; an IPC/event payload field) defaulted via `??`/`||`
 *      to a zero-ish value;
 *   2. it does NOT false-positive on a bare untracked local var default, a
 *      non-zero sentinel default, an already-correct explicit-presence check,
 *      test files, or comments;
 *   3. a tracked boundary variable's scope decays outside the lookback
 *      window — the whole-FILE gate this replaced measured 1264 hits on the
 *      real tree (mostly unrelated reads far from the nearest JSON.parse
 *      call); this locks that the locality narrowing actually holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  analyzeForExplicitPresence,
  applyAllowlist,
  decideRatchet,
  readBaseline,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — pure JS guard script, no .d.ts; imported for its analyzer only.
} from '../../../../scripts/check-explicit-presence.mjs';
import {
  ACKNOWLEDGED_UNREACHABLE,
  parseRepoWideRegistrationPairs,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — pure JS meta-guard, no .d.ts; imported for its registration parser + allowlist.
  // The directive sits immediately above the `} from` line, NOT above the `import` keyword:
  // @ts-ignore suppresses only the line that FOLLOWS it, and tsc lands TS7016 on the module
  // specifier line. Placing it above `import {` leaves a multi-line specifier unguarded.
} from '../../../../scripts/check-lint-guard-reachability.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('analyzeForExplicitPresence (WI-6004)', () => {
  it('flags a direct JSON.parse(...).field chain defaulted to a zero value — the udxRelayed shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/a.ts',
      text: 'const relayed = JSON.parse(raw).udxRelayed ?? false;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].reason).toMatch(/udxRelayed\/bytesReceived incident shape/);
  });

  it('flags `?? 0` off a direct JSON.parse chain — the bytesReceived shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/b.ts',
      text: 'const bytesReceived = JSON.parse(logLine).bytesReceived ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
  });

  it('flags a field read on a variable this file assigned from JSON.parse, within the lookback window', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/c.ts',
      text: 'const parsed = JSON.parse(raw);\nconst count = parsed.count ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/assigned from JSON\.parse at line 1/);
  });

  it('flags a field read on a sql-tagged query result — a NULL DB column read as zero', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/d.ts',
      text: 'const rows = await sql`select active from t`;\nconst active = rows[0].active ?? false;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/DB row/);
  });

  it('distinguishes postgres.js affected-row metadata from nullable count columns', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/result-count.ts',
      text: 'const result = await sql`UPDATE t SET active = true`;\n'
        + 'const affected = result.count ?? 0;\n'
        + 'const column = result[0].count ?? 0;\n'
        + 'const namedColumn = result["0"].count || 0;\n'
        + 'const other = result.active ?? false;\n',
    });
    expect(hits.map((hit: { line: number }) => hit.line)).toEqual([3, 4, 5]);
  });

  it('still flags absent JSON counts even when the same identifier was a SQL result', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/parsed-count.ts',
      text: 'const result = await sql`DELETE FROM t`;\n'
        + 'const result = JSON.parse(raw);\nconst affected = result.count ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/JSON.parse/);
  });

  it('flags an IPC/event-payload field defaulted with `||`', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/e.ts',
      text: "ipcRenderer.on('reply', (event, payload) => {\n  const n = payload.count || 0;\n});\n",
    });
    expect(hits).toHaveLength(1);
  });

  it('does NOT flag a bare untracked local variable default — far too generic to be a boundary read', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/f.ts',
      text: 'const debugEnabled = config.debug ?? false;\n',
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a non-zero sentinel default even off a direct JSON.parse chain', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/g.ts',
      text: "const name = JSON.parse(raw).name ?? 'unknown';\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag an already-correct explicit-presence check (an `in` guard, no risky default)', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/h.ts',
      text: "const p = JSON.parse(raw);\nconst relayed = 'udxRelayed' in p ? p.udxRelayed : ABSENT;\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a test file, regardless of content', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/i.test.ts',
      text: 'const relayed = JSON.parse(raw).udxRelayed ?? false;\n',
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a commented-out example of the risky shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/j.ts',
      text: 'const rows = await sql`select 1`;\n// const active = rows[0].active ?? false; (old approach)\n',
    });
    expect(hits).toHaveLength(0);
  });

  it('a tracked boundary variable decays OUTSIDE the lookback window (the locality narrowing that replaced the 1264-hit whole-file gate)', () => {
    const near = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/k-near.ts',
      text:
        'const row = await sql`select status from t`;\n' +
        '// pad\n'.repeat(10) +
        'const status = row.status ?? false;\n',
    });
    expect(near).toHaveLength(1);

    const far = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/k-far.ts',
      text:
        'const row = await sql`select status from t`;\n' +
        '// pad\n'.repeat(60) +
        'const status = row.status ?? false;\n',
    });
    expect(far).toHaveLength(0);
  });

  it('the reported hit carries a stable shape (line, snippet, reason) for the CLI reporter', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/l.ts',
      text: 'const parsed = JSON.parse(raw);\nconst tokens = parsed.tokens ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2 });
    expect(typeof hits[0].snippet).toBe('string');
    expect(typeof hits[0].reason).toBe('string');
  });
});

/**
 * WI-5977, 2026-08-13 — the ENFORCEMENT half. The block above proves the DETECTOR is
 * precise; none of it could tell you the guard ran on any blocking path, and for two weeks
 * it did not: `lint:explicit-presence` sat in ACKNOWLEDGED_UNREACHABLE as "logic-test only"
 * while WI-5977's own thesis is that an unenforced convention decays into advice.
 *
 * So these assertions are about the WIRING, and each one pins a link that has silently
 * broken here before:
 *   - a REPO_WIDE_INVARIANT_GUARDS registration whose workspace does not declare the script
 *     is skipped by `if (!ws?.scripts?.[guard.script]) continue;` — no error, no output, and
 *     the probe most agents reach for cannot see it (WI-37593);
 *   - the graduation itself is reversible by a peer re-adding the allowlist row, which would
 *     restore the exact rot without failing anything;
 *   - and the analyzer's `--self-test` is the POSITIVE CONTROL WI-5977 §4 asks for — an
 *     empty finding list is only evidence when you have shown the detector can find things.
 */
describe('explicit-presence is ENFORCED, not merely available (WI-5977)', () => {
  it('runs the analyzer for real: --self-test exits 0 and reports its fixtures green', () => {
    // The positive control, executed rather than assumed. A guard whose detector has silently
    // stopped matching reports a clean tree, which is the defect class this whole file guards.
    const out = execFileSync('node', [join(REPO_ROOT, 'scripts/check-explicit-presence.mjs'), '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    expect(out).toMatch(/self-test: analyzer correct on all fixtures/);
  }, 60_000);

  it('runs an end-to-end positive control that forces the real ratchet red even when the corpus has zero candidates', () => {
    const run = spawnSync(
      'node',
      // WI-10006055: a whole-tree ratchet scan (~15s CPU idle). Under green-checkpoint
      // lane-stateful load it overran a 60s kill and returned status null, not a verdict.
      [join(REPO_ROOT, 'scripts/check-explicit-presence.mjs'), '--ratchet', '--positive-control'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL' },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(1);
    expect(output).toMatch(/POSITIVE CONTROL: evaluating \d+ analyzer-produced known violation/);
    expect(output).toMatch(/count ROSE above baseline/);
    expect(output).toMatch(/\(\+1\)/);
    // The parent budget must OUTLIVE the child's 180s kill, or Vitest times the test out first
    // and the child's own SIGKILL verdict is unreachable (lint:test-timing-budgets).
  }, 200_000);

  it('refuses to combine the synthetic positive control with --update', () => {
    const run = spawnSync(
      'node',
      [join(REPO_ROOT, 'scripts/check-explicit-presence.mjs'), '--ratchet', '--positive-control', '--update'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/synthetic violation must never rewrite the baseline/);
  }, 60_000);

  it('operator-core DECLARES lint:explicit-presence, and it runs the whole-tree ratchet', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'));
    const script = pkg.scripts?.['lint:explicit-presence'];
    // Undeclared ⇒ the registration below is INERT and skipped in silence (WI-37593).
    expect(script, 'operator-core must declare lint:explicit-presence or its registration is inert').toBeTruthy();
    expect(script).toContain('check-explicit-presence.mjs');
    // NOT the diff-scoped default mode: with no diff base that prints "nothing new to check"
    // and exits 0 having scanned nothing — a verifier reporting success without measuring.
    expect(script, 'the wired mode must be --ratchet (whole tree), never the diff-scoped default').toContain(
      '--ratchet',
    );
  });

  it('is REGISTERED in REPO_WIDE_INVARIANT_GUARDS under that same workspace', () => {
    const pairs = parseRepoWideRegistrationPairs(readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8'));
    expect(pairs).toContainEqual({ workspace: '@papercusp/operator-core', script: 'lint:explicit-presence' });
  });

  it('has GRADUATED out of the acknowledged-unreachable allowlist and must not return to it', () => {
    expect(ACKNOWLEDGED_UNREACHABLE.has('lint:explicit-presence')).toBe(false);
  });

  it('ships a numeric baseline the ratchet can read', () => {
    expect(typeof readBaseline()).toBe('number');
  });

  it('REFUSES to guess a baseline it cannot read — absent is not zero, and not Infinity either', () => {
    // The convention applied to the guard itself. `?? 0` here would fail every run for a
    // reason unrelated to the tree; `?? Infinity` would pass every run and guard nothing.
    const dir = mkdtempSync(join(tmpdir(), 'explicit-presence-baseline-'));
    const corrupt = join(dir, 'baseline.json');
    writeFileSync(corrupt, JSON.stringify({ _comment: 'no count field' }));
    expect(() => readBaseline(corrupt)).toThrow(/no non-negative integer `count`/);
    expect(() => readBaseline(join(dir, 'does-not-exist.json'))).toThrow();
  });

  it('gates only on the count RISING, and never silently locks in a transient drop', () => {
    expect(decideRatchet({ count: 56, baselineCount: 55 })).toMatchObject({ verdict: 'fail-exceeds', by: 1 });
    expect(decideRatchet({ count: 55, baselineCount: 55 })).toMatchObject({ verdict: 'ok-at' });
    // A dip passes but does NOT rewrite the baseline: a scan root temporarily unreadable would
    // otherwise ratchet down to a number the tree cannot hold, reddening every later run.
    expect(decideRatchet({ count: 40, baselineCount: 55 })).toMatchObject({ verdict: 'ok-below', belowBy: 15 });
    expect(decideRatchet({ count: 40, baselineCount: 55, updateFlag: true })).toMatchObject({
      verdict: 'ok-ratchet',
      newBaseline: 40,
    });
  });
});

/**
 * EI-20609643000161171. The ALLOW set used to be keyed on `path:line` alone, and the two legs
 * of this script contradicted each other about what drift meant. The stale-entry detector was
 * advisory and said so in a comment ("a drifted entry must not red the gate leg, because the
 * correct response is re-triaging the moved line") — but drift does not merely orphan an entry,
 * it UN-SUPPRESSES the violation the entry was hiding, which raised `candidates.length`, which
 * is exactly what the ratchet compares against the baseline. So the one condition the author
 * said must stay advisory was the one that reliably went red, fleet-wide (the guard is in
 * REPO_WIDE_INVARIANT_GUARDS, so it attaches to every affected-tests run), and it landed on
 * whoever ran the gate next rather than on the editor who moved the line. Observed twice in one
 * morning on the same entry: coord-invariant-actions.ts 1410 → 1470 → 1527.
 *
 * The fix keys suppression on CONTENT. These lock both halves of it: that drift no longer moves
 * the count, and — the control that matters — that content-keying did not open the
 * over-suppression hole it obviously could have, where an unremarkable line like `del.count ?? 0`
 * silently absorbs a genuinely NEW violation elsewhere in the same file.
 */
describe('applyAllowlist: drift is advisory, and content-keying does not over-suppress', () => {
  const FILE = 'packages/operator-core/lib/a.ts';
  const OTHER = 'packages/operator-core/lib/b.ts';
  const DEL = 'const n = del.count ?? 0;';
  const hit = (line: number, snippet: string) => ({ line, snippet, reason: 'boundary read' });

  it('CALIBRATION: an un-allowed candidate is counted (so the suppressions below are load-bearing)', () => {
    const r = applyAllowlist({ allow: [], hitsByFile: new Map([[FILE, [hit(10, DEL)]]]) });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ f: FILE, line: 10 });
  });

  it('suppresses on an exact line match — the unchanged common case', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:10`, code: DEL }],
      hitsByFile: new Map([[FILE, [hit(10, DEL)]]]),
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.drifted).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });

  it('THE REGRESSION: an edit above an entry moves the line, and the candidate count does NOT change', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:1470`, code: DEL }],
      hitsByFile: new Map([[FILE, [hit(1527, DEL)]]]),
    });
    expect(r.candidates).toHaveLength(0); // ← was 1 before the fix, which is what reddened the gate
    expect(r.unmatched).toHaveLength(0); // ← and it is not reported as dead, because it is not
    expect(r.drifted).toEqual([{ at: `${FILE}:1470`, resolvedLine: 1527, code: DEL }]);

    // FALSIFIABILITY CONTROL, on the shipped code rather than a mutant of it: an entry carrying
    // no content key is exactly the old `path:line`-only entry, and the SAME fixture then
    // reproduces the defect — 1 candidate, count risen, ratchet red. So the assertions above
    // are load-bearing on the content key specifically, not on some incidental leniency.
    const preFix = applyAllowlist({
      allow: [{ at: `${FILE}:1470`, code: '' }],
      hitsByFile: new Map([[FILE, [hit(1527, DEL)]]]),
    });
    expect(preFix.candidates).toHaveLength(1);
    expect(preFix.unmatched).toEqual([`${FILE}:1470`]);
  });

  it('CONTROL: one entry can never suppress two identical lines — a newly-added duplicate still counts', () => {
    // The precise hazard content-keying introduces. `del.count ?? 0` is not distinctive, so a
    // second one in the same file is plausible; if the entry absorbed both, this guard would be
    // hiding a real new boundary read, which is its own subject one level up.
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:1470`, code: DEL }],
      hitsByFile: new Map([[FILE, [hit(200, DEL), hit(1527, DEL)]]]),
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.drifted).toHaveLength(1);
  });

  it('the suppressed TOTAL is min(entries, matches), so which duplicate is picked cannot change the verdict', () => {
    const twoHits = () => new Map([[FILE, [hit(200, DEL), hit(1527, DEL)]]]);
    expect(
      applyAllowlist({ allow: [{ at: `${FILE}:1470`, code: DEL }], hitsByFile: twoHits() }).candidates,
    ).toHaveLength(1);
    expect(
      applyAllowlist({
        allow: [
          { at: `${FILE}:1470`, code: DEL },
          { at: `${FILE}:190`, code: DEL },
        ],
        hitsByFile: twoHits(),
      }).candidates,
    ).toHaveLength(0);
  });

  it('resolves a drifted entry to the NEAREST matching line, so the reported re-point is the plausible one', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:1470`, code: DEL }],
      hitsByFile: new Map([[FILE, [hit(12, DEL), hit(1527, DEL)]]]),
    });
    expect(r.drifted[0].resolvedLine).toBe(1527);
  });

  it('does NOT reach across files — an identical line in another file is not consumed', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:10`, code: DEL }],
      hitsByFile: new Map([
        [FILE, []],
        [OTHER, [hit(10, DEL)]],
      ]),
    });
    expect(r.candidates).toEqual([expect.objectContaining({ f: OTHER, line: 10 })]);
    expect(r.unmatched).toEqual([`${FILE}:10`]);
  });

  it('reports an entry whose code is gone as unmatched, and it suppresses nothing else in the file', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:10`, code: DEL }],
      hitsByFile: new Map([[FILE, [hit(44, 'const other = row.thing ?? 0;')]]]),
    });
    expect(r.unmatched).toEqual([`${FILE}:10`]);
    expect(r.candidates).toHaveLength(1);
  });

  it('is whitespace-insensitive: a re-indent under a new enclosing block is not a false un-suppression', () => {
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:10`, code: 'const n = del.count ?? 0;' }],
      hitsByFile: new Map([[FILE, [hit(12, 'const   n =  del.count ?? 0;')]]]),
    });
    expect(r.candidates).toHaveLength(0);
  });

  it('an entry naming a file this run never scanned is inert, not a suppression and not a candidate', () => {
    // The diff-scoped mode legitimately opens almost none of the allowlisted files; only `--all`
    // reports these, which is why the report leg is gated on `all` in main().
    const r = applyAllowlist({
      allow: [{ at: `${FILE}:10`, code: DEL }],
      hitsByFile: new Map([[OTHER, []]]),
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.unmatched).toEqual([`${FILE}:10`]);
  });

  it('every shipped ALLOW entry carries both halves — an entry with no `code` cannot survive drift', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts/check-explicit-presence.mjs'), 'utf8');
    const block = src.slice(src.indexOf('const ALLOW = ['), src.indexOf('\n];', src.indexOf('const ALLOW = [')));
    const entries = [
      ...block.matchAll(
        /\{\s*at:\s*(["'])((?:\\[\s\S]|(?!\1)[\s\S])*)\1,\s*code:\s*(["'])((?:\\[\s\S]|(?!\3)[\s\S])*)\3,?\s*\}/g,
      ),
    ];
    expect(entries.length).toBeGreaterThanOrEqual(20);
    // Count the `at:` keys independently: a hand-added entry that omits `code` (or spells it
    // differently) is invisible to the pair regex above, and this is what catches that.
    expect(entries.length).toBe([...block.matchAll(/\bat:\s*["']/g)].length);
    for (const [, , at, , code] of entries) {
      expect(at).toMatch(/^[\w./-]+\.ts:\d+$/);
      expect(code.trim().length).toBeGreaterThan(0);
    }
  });
});
