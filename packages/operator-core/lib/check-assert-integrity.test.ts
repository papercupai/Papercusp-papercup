/**
 * Tests for the assert-integrity lint (scripts/check-assert-integrity.mjs, WI-5788 / P-411).
 *
 * The lint exists to catch rig/scenario asserts whose FAILURE TO RUN can read as a PASS.
 * The thing that makes it worth testing is not that it fires — it is that it CANNOT BE
 * QUIETED BY LOOSENING IT. Two of its rules carry deliberate exemptions (R4's
 * "failure is propagated via a status variable", and the pragma suppression), and every
 * exemption is a place where a future edit could silently turn the whole lint into a
 * no-op that reports green because it stopped looking.
 *
 * So the load-bearing cases below are the FAIL-CLOSED NEGATIVE CONTROLS: the shapes that
 * look almost exactly like an exempt one but are NOT, and must still be reported. If an
 * edit to the lint ever makes one of those go quiet, that is the regression.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// prettier-ignore
// @ts-ignore -- plain .mjs lint script, no type declarations. MUST immediately precede the import: TypeScript reports TS7016 on the module-specifier line.
import { scan, scriptsInScope, ROOT, orphanedAsserts, discardedReadings } from '../../../scripts/check-assert-integrity.mjs';

type Finding = { file: string; line: number; rule: string; msg: string };

const run = (src: string): Finding[] => scan('t.sh', src) as Finding[];
const rules = (src: string): string[] => run(src).map((f) => f.rule);

describe('check-assert-integrity: R1 permissive coercion', () => {
  it('flags an unmeasured baseline coerced to 0 and then threshold-compared', () => {
    // The exact shape that made b9-attestation.sh LEG3/LEG4 able to falsely pass.
    const src = [
      'rc_before="$(psql -c "select count(*)")"',
      '[ -z "$rc_before" ] && rc_before=0',
      'rc_after="$(psql -c "select count(*)")"',
      '[ "$rc_after" -gt "$rc_before" ] && echo PASS',
    ].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });

  it('flags the ${X:-0} and $(... || echo 0) spellings of the same coercion', () => {
    const braceDefault = ['n="$(probe)"', 'n="${n:-0}"', '[ "$n" -ge 1 ]'].join('\n');
    const echoFallback = ['n=$(probe || echo 0)', '[ "$n" -ge 1 ]'].join('\n');
    expect(rules(braceDefault)).toContain('R1-permissive-coercion');
    expect(rules(echoFallback)).toContain('R1-permissive-coercion');
  });

  it('does NOT flag the fixed shape, where an unmeasured read fails outright', () => {
    // The remediation actually applied to b9-attestation.sh / the from-repo smoke.
    const src = [
      'rc_before="$(psql -c "select count(*)")"',
      '[ -n "$rc_before" ] || { echo "FAIL — baseline UNMEASURED"; return 1; }',
      'rc_after="$(psql -c "select count(*)")"',
      '[ "$rc_after" -gt "$rc_before" ] && echo PASS',
    ].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  it('does NOT flag a coerced value that never reaches a numeric assert', () => {
    // A config default (local-matrix.sh NCPU) is not an assert — nothing is scored off it.
    const src = ['NCPU="$(nproc || echo 8)"', 'echo "cores=$NCPU"'].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });
});

describe('check-assert-integrity: R2/R3/R5', () => {
  it('R2 flags a probe var pre-set to the literal its assert treats as success', () => {
    const src = ['ok=1', 'ok="$(probe)"', '[ "$ok" = 1 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R2-default-to-pass');
  });

  it('R3 flags an unguarded grep -c count fed into a threshold compare', () => {
    // grep -c prints 0 and exits 1 on a MISSING file: "never ran" is indistinguishable from 0.
    const src = ['hits=$(grep -c PATTERN some.log)', '[ "$hits" -ge 1 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R3-grep-c-unguarded');
  });

  it('R5 flags `local X="$(cmd)"` masking the command exit status', () => {
    const src = ['local out="$(probe)"', 'rc=$?', '[ "$rc" = 0 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R5-local-masks-rc');
  });
});

describe('check-assert-integrity: R4 empty-read branch', () => {
  it('flags an empty-read branch that only logs and continues', () => {
    const src = ['v="$(probe)"', 'if [ -z "$v" ]; then', '  echo "no value, skipping"', 'fi', 'echo done'].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('does NOT flag a branch that returns/exits directly', () => {
    const src = ['v="$(probe)"', 'if [ -z "$v" ]; then', '  echo "FAIL"', '  return 1', 'fi'].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  it('does NOT flag a status var that IS returned (rc=1 … return "$rc")', () => {
    // scenario-coord-control-plane.sh CC-4/CC-5 — correct code the rule used to over-fire on.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "CC-4 FAIL — could not resolve"; rc=1',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  it('does NOT flag a status var TESTED to guard a nonzero exit (FAIL=1 … if [ "$FAIL" != 0 ]; exit 1)', () => {
    // mac-vm-fd-limit-verify.sh after it grew a third outcome (verified / regression / partial).
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "no line"',
      '  FAIL=1',
      'fi',
      'if [ "$FAIL" != 0 ]; then',
      '  echo "REGRESSION"',
      '  exit 1',
      'fi',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  // ── FAIL-CLOSED CONTROL ────────────────────────────────────────────────────────────
  it('STILL flags a status var that is set but never returned, tested, or exited', () => {
    // The whole point of requiring PROOF of propagation. `rc=1` that nothing ever reads is
    // precisely the silent-continue this rule exists to catch — if this ever goes quiet,
    // the R4 exemption has been widened into a hole.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "FAIL — unmeasured"; rc=1',
      'fi',
      'echo "carrying on regardless"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('STILL flags when the status var is set to ZERO (not a failure disposition at all)', () => {
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"; rc=0',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('STILL flags when a DIFFERENT variable is the one propagated', () => {
    // Setting `other=1` while the function returns an unrelated `rc` is not propagation.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"; other=1',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  // ── COUNTER / ACCUMULATOR PROPAGATION (the third shape) ────────────────────────────
  // A preflight that wants to report EVERY unmet precondition in one pass counts them
  // instead of dying at the first, so its status var is bumped (`missing=$((missing + 1))`)
  // rather than set to a literal. That is the same failure disposition, reached by a
  // different spelling — recognising only the literal form made R4 fire on
  // papercusp-desktop/bin/local-matrix.sh's CORRECT gh-token preflight.
  it('does NOT flag a COUNTER bumped in the empty branch and guarded by a nonzero return', () => {
    const src = [
      'preflight() {',
      '  local missing=0',
      '  tok="$(gh auth token --user "$u" 2>/dev/null || true)"',
      '  if [ -z "$tok" ]; then',
      '    echo "FATAL: no gh token"',
      '    missing=$((missing + 1))',
      '  fi',
      '  if [ "$missing" != 0 ]; then',
      '    echo "FATAL: $missing precondition(s) unmet"',
      '    return 1',
      '  fi',
      '}',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  it('does NOT flag the `((n++))` spelling of the same guarded counter', () => {
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"',
      '  ((missing++))',
      'fi',
      'if [ "$missing" != 0 ]; then',
      '  echo "unmet"',
      '  return 1',
      'fi',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  // ── FAIL-CLOSED CONTROLS for the counter shape ─────────────────────────────────────
  it('STILL flags a counter that is bumped but never propagated', () => {
    // The counter exemption is worth exactly as much as its propagation proof. A preflight
    // that counts failures and then returns success anyway is the silent-continue wearing
    // an accumulator — if this goes quiet, shape (c) has been widened into a hole.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"',
      '  missing=$((missing + 1))',
      'fi',
      'echo "carrying on regardless"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('STILL flags a bump that is NOT self-referential (`missing=$((other + 1))`)', () => {
    // `X=$((Y + 1))` recomputes X from something else — it does not accumulate X's own
    // failure count, so it is not a status bump and must not inherit the exemption.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"',
      '  missing=$((other + 1))',
      'fi',
      'if [ "$missing" != 0 ]; then',
      '  return 1',
      'fi',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });
});

describe('check-assert-integrity: pragma suppression', () => {
  const offending = ['n="$(probe)"', '[ -z "$n" ] && n=0', '[ "$n" -ge 1 ] && echo PASS'];

  it('suppresses via a pragma on the offending line', () => {
    const src = [offending[0], `${offending[1]} # assert-integrity-ok: config default`, offending[2]].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  it('suppresses via a pragma anywhere in the comment block immediately above', () => {
    // The reason for an exemption is usually several lines; only the first carried the token,
    // which used to mean the suppression silently did nothing.
    const src = [
      offending[0],
      '# assert-integrity-ok: this is a config default, not an assert —',
      '# the fallback is the conservative direction and nothing is scored off it,',
      '# so an unmeasurable probe here cannot make any claim falsely pass.',
      offending[1],
      offending[2],
    ].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  // ── FAIL-CLOSED CONTROL ────────────────────────────────────────────────────────────
  it('does NOT suppress when a blank line detaches the comment block from the line', () => {
    const src = [offending[0], '# assert-integrity-ok: unrelated note', '', offending[1], offending[2]].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });

  it('does NOT suppress when code intervenes between the pragma and the finding', () => {
    const src = [
      offending[0],
      '# assert-integrity-ok: applies to the line below only',
      'echo "something else entirely"',
      offending[1],
      offending[2],
    ].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });
});

/**
 * The lint is wired into .github/workflows/test.yml, but the LIVE gate on this repo is the
 * green-checkpoint suite (`npm run test:affected`) — it runs tests, not lints, and the GitHub
 * Actions workflow has been red/dormant. A guard that only runs somewhere that never runs is
 * not a guard, so the real-tree scan is asserted HERE too, where the live gate will see it.
 */
describe('check-assert-integrity: the real rig scripts stay clean', () => {
  // EI-18826354392040658: this describe block used to hand-roll its OWN directory walker
  // (a plain `.sh` filter, no `.selftest.sh` exclusion) instead of reusing the real lint's
  // `scriptsInScope()`. That duplicate drifted from the canonical walker — which
  // deliberately excludes `*.selftest.sh` because those files assert ON these R1/R2/R3
  // shapes deliberately, as fixtures for testing the checker itself — so this test scanned
  // federation-asserts.selftest.sh, found the R1-shaped example code its heredoc GENERATES
  // as a throwaway fixture, and flagged it as if it were live assertion code. `npm run
  // lint:assert-integrity` (the real, live gate) never had this false positive: it always
  // used the correct exclusion. Importing the real walker instead of re-deriving it means
  // this test's scope can never again drift from the live lint's scope.
  const tracked: string[] = scriptsInScope();

  it('scans a non-trivial number of scripts (an empty scan is NOT a pass)', () => {
    // papercusp-desktop is a submodule: if it is not checked out, this walk finds nothing and
    // a "no findings" result would mean "I never looked" — the exact can-falsely-pass shape.
    expect(tracked.length).toBeGreaterThanOrEqual(10);
  });

  it('reports no can-falsely-pass shapes across papercusp-desktop/bin', () => {
    const findings = tracked.flatMap((f: string) =>
      run(readFileSync(resolve(ROOT, f), 'utf8')).map((x) => ({ ...x, file: f })),
    );
    const rendered = findings.map((f) => `${f.file}:${f.line} [${f.rule}]`).join('\n');
    expect(rendered).toBe('');
  });
});

/**
 * R6 — AN ASSERT NOBODY CALLS IS NOT EVIDENCE (WI-7000).
 *
 * The load-bearing cases here are the ones where a LOOSER implementation reports green.
 * R6's whole value is that it re-derives WI-7000, and the three cheapest ways to write
 * this check all score WI-7000 as fine:
 *   · grep the name          -> the lib's own docblock and the runbook NAME all five orphans
 *   · "called outside its file" -> a sibling helper's call is same-file and real
 *   · one hop, not reachability -> an orphan called only by another orphan looks called
 * Each has a negative control below. If an edit makes one go quiet, that is the regression.
 */
describe('check-assert-integrity: R6 orphaned assert', () => {
  const orphansOf = (files: Record<string, string>): string[] => {
    const { findings } = orphanedAsserts(Object.keys(files), (f: string) => files[f]) as {
      findings: Finding[];
    };
    return findings.map((f) => f.msg.match(/^"([^"]+)"/)?.[1] ?? '').sort();
  };

  it('flags an assert helper that nothing calls', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_wake_bridge() {\n  [ "$n" = 1 ]\n}\n',
        'run.sh': 'echo running\n',
      }),
    ).toEqual(['fed_assert_wake_bridge']);
  });

  it('does NOT flag one reached through a chain of helpers from a script top level', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_thing() {\n  [ "$n" = 1 ]\n}\nleg_two() {\n  fed_assert_thing "$@"\n}\n',
        'run.sh': 'leg_two\n',
      }),
    ).toEqual([]);
  });

  // NEGATIVE CONTROL 1 — a comment is not a call. This is the case that makes or breaks
  // R6: the densest mention of these helpers anywhere in the tree is the prose about them
  // (federation-asserts.sh's own docblock lists all five), so a name-grep is MOST confident
  // exactly where a helper is best documented and least used.
  it('still flags an assert whose only mentions are comments and docblocks', () => {
    expect(
      orphansOf({
        'lib/a.sh': '# fed_assert_wake_bridge proves P-002/P-003.\nfed_assert_wake_bridge() {\n  [ "$n" = 1 ]\n}\n',
        'run.sh': '# TODO: call fed_assert_wake_bridge here once the rig is up\necho running   # not fed_assert_wake_bridge\n',
      }),
    ).toEqual(['fed_assert_wake_bridge']);
  });

  // NEGATIVE CONTROL 2 — transitivity. An orphan called only by another orphan is still
  // unreachable; a single-hop "is it called anywhere" check reports this green.
  it('still flags an assert called only by another unreachable function', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_thing() {\n  [ "$n" = 1 ]\n}\nretired_scenario() {\n  fed_assert_thing\n}\n',
        'run.sh': 'echo running\n',
      }),
    ).toEqual(['fed_assert_thing']);
  });

  // NEGATIVE CONTROL 3 — same-file sibling calls are REAL. "Called outside its own file"
  // would flag this, and flagging correct code is how a guard gets deleted.
  it('does not flag an assert called by a sibling helper in the same lib', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_inner() {\n  [ "$n" = 1 ]\n}\nfed_run_all() {\n  fed_assert_inner\n}\n',
        'run.sh': 'fed_run_all\n',
      }),
    ).toEqual([]);
  });

  it('treats a one-line delegation as a real call', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_impl() {\n  [ "$n" = 1 ]\n}\nfed_assert_api() { fed_assert_impl "$@"; }\n',
        'run.sh': 'fed_assert_api\n',
      }),
    ).toEqual([]);
  });

  it('does not count a longer name that merely contains the assert name', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_wake() {\n  [ "$n" = 1 ]\n}\n',
        'run.sh': 'fed_assert_wake_bridge_v2\n',
      }),
    ).toEqual(['fed_assert_wake']);
  });

  it('honours the pragma on the definition line and in the comment block above it', () => {
    expect(
      orphansOf({
        'lib/a.sh': 'fed_assert_inline() { :; }   # assert-integrity-ok: called by the packaged installer\n',
        'lib/b.sh':
          '# assert-integrity-ok: dispatched dynamically via "$leg_fn",\n# which R6 cannot resolve statically.\nfed_assert_block() {\n  [ "$n" = 1 ]\n}\n',
        'run.sh': 'echo running\n',
      }),
    ).toEqual([]);
  });

  /**
   * THE LIVE RATCHET. This is the assertion that actually holds WI-7000 closed: if
   * bin/vm-rig/parity.sh is deleted, or stops calling the five LIVE-1 parity helpers,
   * this goes red — which is exactly what did NOT happen for the month those helpers
   * spent unreachable after deb-hetzner-federation.sh was retired out from under them.
   */
  it('every assert helper in the real rig tree is reachable from a caller', () => {
    const { findings, assertCount } = orphanedAsserts(scriptsInScope()) as {
      findings: Finding[];
      assertCount: number;
    };
    expect(assertCount).toBeGreaterThanOrEqual(10); // a zero-assert scan is not a pass
    expect(findings.map((f) => `${f.file}:${f.line} ${f.msg.match(/^"([^"]+)"/)?.[1]}`).join('\n')).toBe('');
  });
});

describe('check-assert-integrity: R7 discarded reading', () => {
  const r7 = (body: string): Finding[] =>
    discardedReadings('f.sh', `scn_x() {\n${body}\n}\n`) as Finding[];

  it('fires when a measured diagnostic is only reported past a return', () => {
    // The b9-attestation.sh LEG3 shape: measured, then an UNMEASURED bail returns
    // before the one message that would have printed it.
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT count(*) ...;")"',
        '  [ "$measured" = 1 ] || { echo "FAIL — post-probe UNMEASURED"; return 1; }',
        '  echo "FAIL — probe-on-b=${probe_on_b:-<unmeasured>}"',
      ].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('R7-discarded-reading');
    expect(out[0].msg).toContain('probe_on_b');
  });

  it('fires when the OK path also drops it (discarded on green runs too)', () => {
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT count(*) ...;")"',
        '  if [ "$rc" -gt 0 ]; then echo "OK (no probe-on-b here)"; return 0; fi',
        '  echo "FAIL — probe-on-b=$probe_on_b"',
      ].join('\n'),
    );
    expect(out).toHaveLength(1);
  });

  // ── FAIL-CLOSED NEGATIVE CONTROLS ────────────────────────────────────────
  // Each looks like an exempt shape. If an edit to R7 ever quiets one of the
  // first two, or starts firing on the rest, that is the regression.

  it('FAIL-CLOSED: a report added AFTER the return is not a fix — still fires', () => {
    // The tempting non-fix: "I added a rig_reading, so it's covered." It is not —
    // the reading is still unreachable on the bail path. This is the control that
    // matters most, because the shape looks exactly like the real fix.
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT count(*) ...;")"',
        '  [ "$measured" = 1 ] || { echo "FAIL — UNMEASURED"; return 1; }',
        '  rig_reading "LEG4.probe-on-b" "$probe_on_b"',
        '  echo "FAIL — probe-on-b=$probe_on_b"',
      ].join('\n'),
    );
    expect(out).toHaveLength(1);
  });

  it('stays green when the reading is reported AT the measurement point', () => {
    // The real fix: every exit path inherits it, so no return can discard it.
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT count(*) ...;")"',
        '  rig_reading "LEG4.probe-on-b" "$probe_on_b"',
        '  [ "$measured" = 1 ] || { echo "FAIL — UNMEASURED"; return 1; }',
        '  echo "FAIL — probe-on-b=$probe_on_b"',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('does NOT fire when the value also feeds logic (an intervening return is control flow)', () => {
    // Deliberate narrowing. Without it the rule emits 27 findings across the rig —
    // $ts, $tmp, $tries, $measured — almost all ordinary working variables. That
    // volume of noise trains authors to blanket-suppress, costing more than the class.
    const out = r7(
      [
        '  n="$(drv_psql a "SELECT count(*) ...;")"',
        '  [ -n "$n" ] || return 1',
        '  [ "$n" -gt 0 ] || return 1',
        '  echo "OK n=$n"',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('does NOT mistake inline conditional use for the report later on that line', () => {
    const out = r7([
      '  name="$(basename "$f")"',
      '  [ "$known" = 1 ] && return 0',
      '  if [[ "$name" == *-seed.deb ]]; then echo companion',
      '  elif [[ "$name" == *server* ]]; then echo server',
      '  else echo gui',
      '  fi',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('recognizes logical consumption after a reporting command on the same line', () => {
    const out = r7([
      '  n="$(probe)"',
      '  [ "$known" = 1 ] && return 0',
      '  echo "n=$n"; [ "$n" -gt 0 ] || return 1',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('FAIL-CLOSED: quoted shell separators and parameter defaults remain reports', () => {
    const out = r7([
      '  n="$(probe)"',
      '  [ "$known" = 1 ] && return 0',
      '  printf "n;value=%s\\n" "${n:-unmeasured}"',
    ].join('\n'));
    expect(out).toHaveLength(1);
  });

  it('does NOT fire when the value feeds bare Bash arithmetic logic', () => {
    const out = r7(
      [
        '  now="$(probe)"',
        '  if (( expires <= now )); then return 1; fi',
        '  printf "now=%s\\n" "$now"',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('does NOT classify an arithmetic counter update as a command measurement', () => {
    const out = r7(
      [
        '  processed=$((processed + 1))',
        '  [ "$valid" = 1 ] || return 1',
        '  printf "processed=%s\\n" "$processed"',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('FAIL-CLOSED: a longer arithmetic identifier is not a reference to the measured value', () => {
    const out = r7(
      [
        '  now="$(probe)"',
        '  if (( expires <= nowish )); then return 1; fi',
        '  printf "now=%s\\n" "$now"',
      ].join('\n'),
    );
    expect(out).toHaveLength(1);
  });

  it('does NOT fire when no return can pre-empt the report', () => {
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT count(*) ...;")"',
        '  echo "probe-on-b=$probe_on_b"',
        '  return 0',
      ].join('\n'),
    );
    expect(out).toEqual([]);
  });

  it('does NOT fire on a longer identifier that merely starts with the var name', () => {
    // $probe_on_b_extra must not count as a reference to $probe_on_b, or the rule
    // would read a discarded value as reported and go quietly green.
    const out = r7(
      [
        '  probe_on_b="$(drv_psql b "SELECT 1;")"',
        '  [ "$measured" = 1 ] || return 1',
        '  echo "unrelated=$probe_on_b_extra"',
      ].join('\n'),
    );
    // probe_on_b is never actually referenced → dead assignment, a different defect.
    expect(out).toEqual([]);
  });

  it('the real rig scripts are clean under R7', () => {
    const tracked: string[] = scriptsInScope();
    // An empty scan would report "clean" because it never looked — the exact
    // can-falsely-pass shape this whole lint exists to prevent.
    expect(tracked.length).toBeGreaterThanOrEqual(10);
    const findings = tracked.flatMap((f) =>
      discardedReadings(f, readFileSync(resolve(ROOT, f), 'utf8')),
    ) as Finding[];
    expect(findings.map((f) => `${f.file}:${f.line}`).join('\n')).toBe('');
  });
});

describe('check-assert-integrity: scan contract', () => {
  it('reports 1-indexed line numbers against the given file name', () => {
    const src = ['#!/bin/bash', 'n="$(probe)"', '[ -z "$n" ] && n=0', '[ "$n" -ge 1 ]'].join('\n');
    const [finding] = run(src).filter((f) => f.rule === 'R1-permissive-coercion');
    expect(finding.file).toBe('t.sh');
    expect(finding.line).toBe(3);
  });

  it('returns no findings for a script with no probe-derived asserts', () => {
    expect(run(['#!/bin/bash', 'set -euo pipefail', 'echo hello'].join('\n'))).toEqual([]);
  });
});
