import { describe, expect, it } from 'vitest';
import { describeUnreadRun, type UnreadRunAdvisory } from './carry-note-unread-run';

/**
 * EI-19455262557905604 — coverage for the launched-but-unread advisory.
 *
 * FALSIFIABILITY (repo convention, "a MODERN module you import" tier): a guard that
 * has never failed is a guard nobody has tested, and the shared tree must never be
 * mutated to prove one CAN fail. So this file keeps a deliberately-wrong
 * implementation as a PERMANENT control, plus a calibration case the REAL subject
 * must pass. If the assertions below would pass against `naiveUnreadRun`, they are
 * not testing the discrimination this module exists for.
 */

/**
 * The wrong implementation this module deliberately is not: fire on the in-flight
 * vocabulary alone. Measured on the live corpus that is 447 of 10,475 notes (4.3%)
 * against the real subject's 132 (1.26%) — noisy enough to be the D-004 failure the
 * advisory is trying to avoid rather than repeat.
 */
function naiveUnreadRun(body: string | null | undefined, storedChecks: number): UnreadRunAdvisory | null {
  if (storedChecks > 0) return null;
  const text = (body ?? '').trim();
  if (!/\b(?:launched|in[-\s]flight|still running|not yet diagnosed)\b/i.test(text)) return null;
  return { flagged: true, note: 'naive', signals: { inFlight: ['x'], runRefs: [] } };
}

const LAUNCHED_UNREAD = [
  '## Did',
  'Kicked off the full affected suite for the auth-rate-limit change.',
  '## Left',
  'RESOLVED (6). REMAINING (5) — NOT yet diagnosed.',
  'Run is still running; output at /tmp/affected-9182.log.',
].join('\n');

const COMPLETED_TYPECHECK_PENDING_REVIEW = [
  'Typecheck completed exit0; LINT_TSC_RESULT status=clean at 2026-10-21T12:18:12.187Z.',
  'Log read: /tmp/su6c30-p006-tsc-final-1221.log.',
  'Keep CAS35 while reviewer is in flight.',
].join('\n');

describe('describeUnreadRun', () => {
  it('fires on a body with BOTH an in-flight admission and a run artifact, when no checks were stored', () => {
    const advisory = describeUnreadRun(LAUNCHED_UNREAD, 0);
    expect(advisory).not.toBeNull();
    expect(advisory?.flagged).toBe(true);
    expect(advisory?.signals.inFlight).toEqual(
      expect.arrayContaining(['not yet diagnosed', 'still running']),
    );
    expect(advisory?.signals.runRefs).toEqual(expect.arrayContaining(['/tmp/affected-9182.log']));
  });

  it('names the PREDICTED form, since pointing at `checks` without saying to omit `verified` is the miss', () => {
    const note = describeUnreadRun(LAUNCHED_UNREAD, 0)?.note ?? '';
    expect(note).toContain('checks:[{ claim, recheck }]');
    expect(note).toMatch(/omit `verified`/i);
    expect(note).toMatch(/PREDICTED/);
    // D-098's constraint: advisory, never a rejection.
    expect(note).toMatch(/advisory only; the write was kept/i);
  });

  it('is SILENT once any check row was stored — the writer has already found the affordance', () => {
    expect(describeUnreadRun(LAUNCHED_UNREAD, 1)).toBeNull();
    // Calibration: the naive control agrees here, so this case alone proves nothing
    // about discrimination. It is the structural half, and it must hold for both.
    expect(naiveUnreadRun(LAUNCHED_UNREAD, 1)).toBeNull();
  });

  it('is SILENT on in-flight prose with no run artifact — and this is where the naive control fires', () => {
    const body = 'Handed the lane to a peer; their work is still running on their side. Nothing of mine is open.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    // The control fires — proving the run-artifact requirement is load-bearing and
    // that the assertion above is not vacuously true of any implementation.
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('is SILENT on a run artifact with no in-flight admission — a note that REPORTS its result', () => {
    const body = 'Suite green: 812 passed, 0 failed. Full output kept at /tmp/affected-9182.log for the record.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    // The control is also silent here, so this case is calibration rather than
    // discrimination — it pins that a reported result cannot trip either half.
    expect(naiveUnreadRun(body, 0)).toBeNull();
  });

  it('does not treat an explicitly historical quotation as a current unread run (EI-25557979904670574)', () => {
    for (const quote of ["'still running'", '"still running"', '`still running`', '“still running”', '‘still running’']) {
      const body = `Recovered October 7 transcript parts86/88/91/93 quote the peer restart as ${quote}.\n` +
        'Current commands completed, and their evidence was read from /tmp/restart-proof.log.';
      expect(describeUnreadRun(body, 0), quote).toBeNull();
      // This control still sees both signals, so silence requires temporal discrimination.
      expect(naiveUnreadRun(body, 0), quote).not.toBeNull();
    }
  });

  it('does not treat a superseded in-flight compiler note as the current run result', () => {
    const body = [
      'FINAL18:38Z supersedes immediately preceding in-flight compiler note: native30019 COMPLETED exit0.',
      'LINT_TSC_RESULT scopefiles exit0 statusclean.',
      'Read /tmp/ei262382-loop-types-final-20261017.log immediately before saving this checkpoint.',
    ].join('\n');

    expect(describeUnreadRun(body, 0)).toBeNull();
    // The regression is specifically that a broad in-flight matcher would warn here.
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('preserves a current unread run alongside the historical quotation', () => {
    const body = 'The historical transcript said "still running".\n' +
      'The new run has results pending; output at /tmp/current.log.';
    expect(describeUnreadRun(body, 0)?.signals.inFlight).toEqual(['results pending']);
  });

  it('does not attach a pending amendment review to a completed typecheck log (EI-26592020421986807)', () => {
    expect(describeUnreadRun(COMPLETED_TYPECHECK_PENDING_REVIEW, 0)).toBeNull();
    // The broad historical matcher combines the review status with the completed log.
    expect(naiveUnreadRun(COMPLETED_TYPECHECK_PENDING_REVIEW, 0)).not.toBeNull();
  });

  it('keeps a separate unread typecheck actionable beside the completed log and pending review', () => {
    const body = COMPLETED_TYPECHECK_PENDING_REVIEW +
      '\nThe new typecheck run is still in-flight; output: /tmp/new-typecheck.log.';
    const advisory = describeUnreadRun(body, 0);

    expect(advisory?.signals.inFlight).toEqual(['in-flight']);
    expect(advisory?.signals.runRefs).toContain('/tmp/new-typecheck.log');
  });

  it('does not attribute completed test logs to a separate pending typecheck clause', () => {
    const body = 'Read /tmp/unit.log: 47 tests passed exit0; ' +
      'read /tmp/integration.log: 126 tests passed exit0; separate typecheck is still running.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('attributes only the pending typecheck log when completed logs share its sentence', () => {
    const body = 'Read /tmp/unit.log: 47 tests passed exit0; ' +
      'read /tmp/integration.log: 126 tests passed exit0; ' +
      'separate typecheck is still running at /tmp/types.log.';
    expect(describeUnreadRun(body, 0)?.signals.runRefs).toEqual(['/tmp/types.log']);
  });

  it('does not borrow a completed log from a later clause for an unreferenced pending run', () => {
    const body = 'The typecheck is still running; tests completed exit0 at /tmp/unit.log.';
    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it('does not pair completed test logs with a separate launched publisher command (EI-26820577365848014)', () => {
    const body = 'Read /tmp/unit.log (73 passed), /tmp/integration.log (52 passed), and ' +
      '/tmp/tsc.log (exit0), and a separate publisher command was launched.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('does not borrow a completed classifier log across an although clause to a pending git-sync command', () => {
    const body = 'Read the classifier test result at /tmp/assume94-classifier-red.log ' +
      '(2 failed/3 passed and exit1), although the separate canonical git-sync command was launched.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('keeps a separately launched publisher command tied to its own output', () => {
    const body = 'Read /tmp/unit.log (73 passed), and a separate publisher command was ' +
      'launched at /tmp/publish.log.';
    expect(describeUnreadRun(body, 0)?.signals.runRefs).toEqual(['/tmp/publish.log']);
  });

  it('ignores a launch explicitly attributed to a peer', () => {
    const body = 'The diagnostic test run was launched by peer su-b6e19/thread-post1211309; ' +
      'output at /tmp/peer-probe.log.';
    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it('ignores a completed run whose referenced log was read before checkpointing', () => {
    const body = 'The verification test run was launched; output at /tmp/verification.log. ' +
      'The run completed exit0 and I read the log with tail -n28 before writing this checkpoint.';
    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it.each(['output at', 'output:', 'log:', 'Handle:'])(
    'preserves an explicitly attached unread output clause introduced by %s', (label) => {
      const body = `The typecheck is still running; ${label} /tmp/types.log.`;
      expect(describeUnreadRun(body, 0)?.signals.runRefs).toEqual(['/tmp/types.log']);
    },
  );

  it('ignores an unread-run advisory quoted from a checkpoint receipt being reconciled', () => {
    const body = [
      'Reconciled the work_items:checkpoint receipt for contentHash d6260111f61c that warns',
      "'run you launched but have not read (in-flight — /tmp/machine-first-commit-hop-0132.json)'.",
      'That peer-authored receipt was already read through the managed task; no unread local run exists.',
    ].join(' ');

    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it('does not treat a negated long-subject launch as an unread run with a retained log', () => {
    const body = 'No parallel implementation repair run was launched; output at /tmp/no-repair.log.';
    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it('does not turn an explicitly negated run status into an unread-run admission (EI-25989239695201915)', () => {
    for (const status of [
      'not still running',
      'not currently still running',
      "isn't still running",
      'isn’t still running',
      'no longer in-flight',
      'never launched',
      'not "still running"',
    ]) {
      const body = `Recovery GET completed exit1; it is ${status}.\n` +
        'Read final.log: 117 PG and 24 unit tests passed; that is historical local proof.';
      expect(describeUnreadRun(body, 0), status).toBeNull();
      expect(naiveUnreadRun(body, 0), status).not.toBeNull();
    }
  });

  it('keeps a separate current admission when another status is negated', () => {
    const body = 'The completed GET is not still running; final.log was read.\n' +
      'The new suite is still running; output at /tmp/current.log.';
    expect(describeUnreadRun(body, 0)?.signals.inFlight).toEqual(['still running']);
  });

  it.each([
    'No agent was launched',
    'No agents launched',
    'No fleet launched',
    'Zero fleets were launched',
    'No agents or fleets launched',
    'No jobs launched',
  ])('does not attribute retained worker evidence to a negated launch: %s (EI-26741883152223587)', (status) => {
    const body = `${status} this unit. ` +
      'Read the worker-owned qualification receipt at /tmp/worker/qualification.json; its result is retained.';
    expect(describeUnreadRun(body, 0)).toBeNull();
  });

  it.each([
    'No agents launched this unit; launched a separate suite',
    'No fleets launched this unit. Launched a separate suite',
    'No agents launched, but launched a separate suite',
  ])('keeps an affirmative unread run after a negated agent launch: %s', (status) => {
    const body = `${status}; output at /tmp/current.log is not yet read.`;
    expect(describeUnreadRun(body, 0)?.signals.inFlight).toEqual(['launched', 'not yet read']);
  });

  it.each([
    'No agent is still running',
    'No agents still running',
    'No fleet is still running',
    'Zero fleets were still running',
    'No agents or fleets still running',
    'No jobs still running',
  ])('does not infer an unread run from a negated status beside a retained receipt: %s', (status) => {
    expect(describeUnreadRun(`${status}; receipt /tmp/read.log is retained.`, 0)).toBeNull();
  });

  it.each([
    'No agents still running; a separate suite is still running',
    'No fleets are still running, but a separate suite is still running',
  ])('preserves a separate affirmative status after a negated subject: %s', (status) => {
    expect(describeUnreadRun(`${status}; output at /tmp/current.log.`, 0)?.signals.inFlight)
      .toEqual(['still running']);
  });

  it('does not infer an active run from a negated inventory and a proposed scenario (EI-26699409305176974)', () => {
    const body = '## Did\nNo product code or runtime launched this unit.\n' +
      'Read-only inventory at /tmp/papercusp-focus-449b1-current.\n' +
      '## Next\nProposed scenario: test run in flight while content reloads.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('does not infer a launched run from a conditional future step', () => {
    const body = '## Next\nLaunch a test run; if the suite is still running, read /tmp/future.log.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('does not pair a quoted negative repair launch with an already-read ship-readiness JSON artifact (EI-26686643671455366)', () => {
    const body = [
      'Both Python reads parsed the full ship-readiness result from /tmp/su394-ship-after-review49.json.',
      "The checkpoint wording included 'no parallel repair launched'.",
      'The result was read before this checkpoint was written.',
    ].join('\n');

    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('ignores a negated start request while preserving an affirmative request in flight', () => {
    const negated = 'No existing start request in flight and no shell sessions/locks; ' +
      'artifacts /tmp/security-lane3-corpus-executed.json and /tmp/security-lane3-audit-repair.json.';
    expect(describeUnreadRun(negated, 0)).toBeNull();

    const affirmative = 'A separate test request is in flight; output at /tmp/current-start-request.log.';
    expect(describeUnreadRun(affirmative, 0)?.signals.inFlight).toEqual(['in flight']);
    expect(describeUnreadRun(affirmative, 0)?.signals.runRefs).toContain('/tmp/current-start-request.log');
  });

  it('does not pair completed SQLite-home binding evidence with a separate pending custody job', () => {
    const body = 'Read the completed setup bash output /tmp/pcv/papercusp-capability/scratch/bash-e500f6fb-1f8.log and restored SQLite bindings at /tmp/papercusp-codex-sqlite-homes/session-54397/config.toml and /tmp/papercusp-codex-sqlite-homes/session-54391/config.toml and /tmp/papercusp-codex-sqlite-homes/session-54708/config.toml and /tmp/pcv/papercusp-codex-sqlite-homes/session-sameADV/config.toml and the separate native-custody verification job was launched and is still running, marked pending.';

    expect(describeUnreadRun(body, 0)).toBeNull();

    const withCurrentOutput = body.replace(
      'is still running, marked pending.',
      'is still running at /tmp/native-custody.log.',
    );
    expect(describeUnreadRun(withCurrentOutput, 0)).toMatchObject({
      flagged: true,
      signals: {
        inFlight: expect.arrayContaining(['still running']),
        runRefs: ['/tmp/native-custody.log'],
      },
    });
  });

  it('keeps actual unread admissions in Next and after hypothetical or negated clauses', () => {
    for (const body of [
      '## Next\nRead /tmp/active.log: the current suite is still running.',
      'No product code or runtime launched this unit; a separate suite is still running at /tmp/active.log.',
      'Proposed scenario: test run in flight; the current suite is still running at /tmp/active.log.',
      'Proposed scenario: test run in flight but the current build is still running at /tmp/active.log.',
      '## Did\nLaunched suite; output at /tmp/active.log.\n## Next\nRead its result.',
    ]) expect(describeUnreadRun(body, 0), body).not.toBeNull();
  });

  it('keeps affirmative unread admissions and negation of a different predicate actionable', () => {
    for (const status of [
      'not yet read',
      'not yet diagnosed',
      'not just still running',
      'not complete, still running',
    ]) {
      expect(describeUnreadRun(`The suite is ${status}; output at /tmp/current.log.`, 0), status).not.toBeNull();
    }
  });

  it('keeps quoted current admissions and ambiguous prior-run prose actionable', () => {
    for (const body of [
      'The current runner says "still running"; output at /tmp/current.log.',
      'The prior run is still running; output at /tmp/prior.log.',
      'The historical transcript was read, but the current runner says "still running" at /tmp/current.log.',
      'The historical transcript was read. The runner says "still running" at /tmp/current.log.',
    ]) {
      expect(describeUnreadRun(body, 0), body).not.toBeNull();
    }
  });

  it('does not fire on `launched` alone, the word that made the naive trigger unusable', () => {
    const body = 'Launched the drain fleet; four members joined and are claiming from the spec.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('treats an empty or absent body as nothing to say', () => {
    expect(describeUnreadRun('', 0)).toBeNull();
    expect(describeUnreadRun(null, 0)).toBeNull();
    expect(describeUnreadRun(undefined, 0)).toBeNull();
  });

  it('recognises the other unread-run artifacts an agent actually writes', () => {
    for (const ref of [
      'bash_id abc123',
      'run_in_background:true; bash_id:abc123',
      'capability:bash_output { task_id: "task0mvljxl3t1qday5smb1" }',
      'build.log',
    ]) {
      const body = `Kicked it off, results pending. Handle: ${ref}.`;
      expect(describeUnreadRun(body, 0), ref).not.toBeNull();
    }
  });

  it('ignores JSON source manifests and bare bash_output mentions as run references', () => {
    const manifest = JSON.stringify({
      source: '45c9ca0be6f3e570',
      files: ['packages/operator-core/lib/agent-tools/work_items/checkpoint.test.ts'],
      jobs: [
        { task_id: 'task0mvljxl3t1qday5smb1', log: '/tmp/source-manifest.log', status: 'read' },
        { task_id: 'task0mvlk0kvd1c5otvs1j0', status: 'read' },
      ],
    });
    const body = [
      'The current verification suite is still running; both managed job statuses were read via capability:bash_output.',
      `JSON source manifest: ${manifest}`,
    ].join('\n');

    expect(describeUnreadRun(body, 0)).toBeNull();
    // A genuine output path outside the manifest still supplies the run reference.
    expect(describeUnreadRun(`${body}\nThe current suite is still running; output at /tmp/current.log.`, 0)
      ?.signals.runRefs).toEqual(['/tmp/current.log']);
    // The tool name by itself is not a run/task identifier.
    expect(describeUnreadRun(
      'The current suite is still running; the prior status read used capability:bash_output.',
      0,
    )).toBeNull();
  });

  it('caps the echoed signals so the advisory stays one readable line', () => {
    const body =
      'launched, in flight, still running, not yet diagnosed, results pending — ' +
      '/tmp/a.log /tmp/b.log /tmp/c.log /tmp/d.log bash_id run_in_background';
    const advisory = describeUnreadRun(body, 0);
    expect(advisory?.signals.inFlight.length).toBeLessThanOrEqual(3);
    expect(advisory?.signals.runRefs.length).toBeLessThanOrEqual(3);
  });

  it('does not leak regex lastIndex between calls (the /g reuse bug)', () => {
    const first = describeUnreadRun(LAUNCHED_UNREAD, 0);
    const second = describeUnreadRun(LAUNCHED_UNREAD, 0);
    expect(second).toEqual(first);
    expect(second).not.toBeNull();
  });
});
