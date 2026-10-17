import { describe, it, expect } from 'vitest';
import { detectBgJobCheckpointClaim } from './checkpoint-bg-job-claim';

describe('detectBgJobCheckpointClaim (EI-18654296679612119 — unverifiable bg-job checkpoint claim)', () => {
  it('flags the live repro shape: "in bg job <id> (log <path>) ... will complete once both are clean"', () => {
    const r = detectBgJobCheckpointClaim(
      'Verifying: (1) apps/operator tsc --noEmit in bg job bieg6308m (log /tmp/wi5778-tsc-operator.log), ' +
        '(2) npm run test:affected in bg job bix2da57w (log /tmp/wi5778-affected.log). Will complete once both are clean.',
    );
    expect(r.detected).toBe(true);
    expect(r.reason).toMatch(/ps -p <pid>/);
    expect(r.reason).toMatch(/EI-16611/);
    expect(r.reason).toMatch(/completion marker/);
  });

  it('flags "background task"/"background verification" phrasing', () => {
    expect(detectBgJobCheckpointClaim('background verification jobs in flight, will complete once clean').detected).toBe(
      true,
    );
    expect(detectBgJobCheckpointClaim('kicked off a background task to run the suite').detected).toBe(true);
  });

  it('does not classify a server-side deferred writer that may continue in the background as a session job', () => {
    expect(
      detectBgJobCheckpointClaim(
        'The applyResultDoorAsync deferred writer may continue in the background after the request times out.',
      ),
    ).toEqual({ detected: false });
  });

  it('flags a literal run_in_background reference', () => {
    expect(
      detectBgJobCheckpointClaim('launched via Bash run_in_background: true, task id bfdsrowp3').detected,
    ).toBe(true);
  });

  it('flags "in-flight job/task" phrasing (hyphenated, spaced, or closed; singular or plural)', () => {
    expect(detectBgJobCheckpointClaim('one inflight task remains').detected).toBe(true);
    expect(detectBgJobCheckpointClaim('one in-flight job remains').detected).toBe(true);
    expect(detectBgJobCheckpointClaim('two in flight jobs remain').detected).toBe(true);
  });

  // WI-38297 — the three checkpoints that ACTUALLY stranded their items. Each was MISSED
  // by the original alternation (it required background to be followed immediately by
  // job/task/process/verification), so every pickup-path warning stayed silent on exactly
  // the notes promising a result that could never arrive. These are verbatim shapes, kept
  // permanently: they are the calibration cases proving the widened regex still earns its
  // keep, and a future narrowing that reintroduces the gap fails HERE with the item id and
  // the days-stranded cost attached.
  describe('the real stranded-checkpoint phrasings (WI-38297)', () => {
    it('flags "<cmd> running in background (bash id <id>)" — WI-5895, sat open 17 days', () => {
      expect(
        detectBgJobCheckpointClaim(
          'Fix implemented + committed. test:affected running in background (bash id bx76day3h) to confirm ' +
            'no other suite depended on the old silent-swallow behavior — will report+complete once it finishes.',
        ).detected,
      ).toBe(true);
    });

    it('flags "running in background to confirm …; awaiting result" — WI-3561, sat open 34 days', () => {
      expect(
        detectBgJobCheckpointClaim(
          'tsc --noEmit running in background to confirm no type errors in touched files; ' +
            'awaiting result before considering this done.',
        ).detected,
      ).toBe(true);
    });

    it('flags a bare "task id <id> output when it lands" job handle — WI-3578, sat open 34 days', () => {
      expect(
        detectBgJobCheckpointClaim('read task id bf5ryqqze output when it lands. If green -> complete.').detected,
      ).toBe(true);
    });

    it('does not flag a historical task id with an exact terminal ledger read and no live process/log', () => {
      const checkpoint = [
        'Task ID 0mv2kuyk2ctvxu6p7qd encodes mint time 2026-10-10T15:57:11.666Z.',
        "Current processes:list exact-task read returned state=stranded, exitReason='unaccounted residue no longer present', livePids=null, logPath=null, launchedBy='unknown', workItemId=null.",
        'There is no live process or recorded log to wait on; there is no background job to await.',
        "Rerunnable re-check: processes:list {taskId:'0mv2kuyk2ctvxu6p7qd', live:true, includeEnded:true}.",
      ].join('\n');

      expect(detectBgJobCheckpointClaim(checkpoint)).toEqual({ detected: false });
    });

    it('does not flag a negated background phrase or a bare historical handle', () => {
      expect(detectBgJobCheckpointClaim('The task is not running in the background.').detected).toBe(false);
      expect(detectBgJobCheckpointClaim('Historical task id 0mv2kuyk2ctvxu6p7qd is retained for audit.').detected).toBe(
        false,
      );
      expect(detectBgJobCheckpointClaim('There is no background job to await.').detected).toBe(false);
    });

    it('does NOT treat an SQL task_id column as a background-job handle', () => {
      expect(
        detectBgJobCheckpointClaim(
          'gcTerminalTasks deleted expired non-release ledger rows with RETURNING task_id only',
        ),
      ).toEqual({ detected: false });
    });

    it('flags the underscored/hyphenated handle spellings', () => {
      expect(detectBgJobCheckpointClaim('see bash_id 29e05531-f6b for the verdict').detected).toBe(true);
      expect(detectBgJobCheckpointClaim('see bash-id 29e05531 for the verdict').detected).toBe(true);
    });

    // The widening must not swallow ordinary prose that merely contains the word.
    it('does NOT flag "task identifier" or a non-job use of the word background', () => {
      expect(detectBgJobCheckpointClaim('the task identifier is stable across respawns').detected).toBe(false);
      expect(detectBgJobCheckpointClaim('background reading: see the design doc before starting').detected).toBe(false);
    });
  });

  it('does NOT flag an ordinary checkpoint with no background-job claim', () => {
    const r = detectBgJobCheckpointClaim(
      'Read the bug body, not yet started. Next: open the two hinted files and find the right seam.',
    );
    expect(r.detected).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('does NOT flag when a job/task is mentioned but not as a background reference', () => {
    // "task" alone (e.g. referring to the work-item itself) must not false-positive.
    expect(detectBgJobCheckpointClaim('this task is about the checkpoint tooling').detected).toBe(false);
    expect(detectBgJobCheckpointClaim('filed a follow-up job in the queue').detected).toBe(false);
  });

  it('is null/blank-safe', () => {
    expect(detectBgJobCheckpointClaim(null)).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim(undefined)).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim('   ')).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim('')).toEqual({ detected: false });
  });
});
