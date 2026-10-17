/**
 * expensive-verification-loops-2026-09-29 R-1 (unit layer): a slow attempt that closes is
 * stamped against its work item with an outcome and, when it failed, a fingerprint the loop
 * detector can compare. The integration layer (attempt-ledger.integration.test.ts) proves the
 * stamp lands in a real task_ledger row; this file pins the recorder's own decisions with the
 * database replaced by a recording fake.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  SLOW_ATTEMPT_MIN_MS,
  attemptOutcome,
  commandFingerprint,
  recordAttemptOnClose,
  type ClosedTaskForAttempt,
  type VerificationAttemptStamp,
} from './attempt-ledger';

interface SqlCall {
  text: string;
  values: unknown[];
}

function fakeSql(opts: { throws?: boolean } = {}): { sql: Sql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return opts.throws ? Promise.reject(new Error('db down')) : Promise.resolve([]);
  };
  return { sql: tag as unknown as Sql, calls };
}

const START = '2026-09-30T06:00:00.000Z';
const NOW = new Date('2026-09-30T06:10:00.000Z');

function closed(over: Partial<ClosedTaskForAttempt> = {}): ClosedTaskForAttempt {
  return {
    taskId: 'task-1',
    workItemId: 'WI-1',
    state: 'exited',
    exitCode: 0,
    exitReason: null,
    logPath: '/logs/task-1.log',
    argv: ['bash', '-c', 'npm run drill -- --dir /tmp/rig-abc'],
    startedAt: START,
    endedAt: new Date(Date.parse(START) + SLOW_ATTEMPT_MIN_MS + 5_000).toISOString(),
    ...over,
  };
}

/** The stamp the recorder wrote, parsed back out of the UPDATE's bound values. */
function writtenStamp(call: SqlCall): VerificationAttemptStamp {
  const json = call.values.find((v) => typeof v === 'string' && v.startsWith('{"schemaVersion"'));
  expect(json, 'the UPDATE must bind the stamp as JSON').toBeTypeOf('string');
  return JSON.parse(json as string) as VerificationAttemptStamp;
}

describe('attemptOutcome', () => {
  it('maps terminal task states to attempt outcomes', () => {
    expect(attemptOutcome('exited', 0)).toBe('pass');
    expect(attemptOutcome('exited', 1)).toBe('fail');
    expect(attemptOutcome('exited', null)).toBe('unknown');
    expect(attemptOutcome('timed_out', null)).toBe('fail');
    expect(attemptOutcome('killed', 143)).toBe('cancelled');
    expect(attemptOutcome('killed', 137)).toBe('cancelled');
    expect(attemptOutcome('killed', null)).toBe('cancelled');
    expect(attemptOutcome('killed', 2)).toBe('fail');
    expect(attemptOutcome('stranded', null)).toBe('unknown');
  });
});

describe('commandFingerprint', () => {
  it('treats reruns of one command with different scratch dirs and hashes as the same command', () => {
    const a = commandFingerprint(['bash', '-c', 'drill --dir /tmp/rig-111 --sha 0123abcd4567']);
    const b = commandFingerprint(['bash', '-c', 'drill  --dir /tmp/rig-999 --sha fedc9876ba10']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('calibration: a different command is a different fingerprint', () => {
    expect(commandFingerprint(['bash', '-c', 'drill --phase A'])).not.toBe(
      commandFingerprint(['bash', '-c', 'drill --phase B']),
    );
  });
});

describe('recordAttemptOnClose', () => {
  it('records nothing for a row with no work item', async () => {
    const { sql, calls } = fakeSql();
    expect(await recordAttemptOnClose(closed({ workItemId: null }), { sql, now: () => NOW })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('records nothing for an attempt shorter than the slow threshold', async () => {
    const { sql, calls } = fakeSql();
    const quick = closed({ endedAt: new Date(Date.parse(START) + SLOW_ATTEMPT_MIN_MS - 1).toISOString() });
    expect(await recordAttemptOnClose(quick, { sql, now: () => NOW })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('stamps a passing slow attempt on its own task row without reading the log', async () => {
    const { sql, calls } = fakeSql();
    let tailReads = 0;
    const stamp = await recordAttemptOnClose(closed(), {
      sql,
      now: () => NOW,
      readTail: async () => {
        tailReads++;
        return 'Error: should not be read';
      },
    });
    expect(tailReads).toBe(0);
    expect(stamp).toMatchObject({
      schemaVersion: 1,
      outcome: 'pass',
      fingerprint: null,
      source: null,
      durationMs: SLOW_ATTEMPT_MIN_MS + 5_000,
      recordedAt: NOW.toISOString(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('UPDATE harness_shared.task_ledger');
    expect(calls[0]!.values).toContain('task-1');
    expect(writtenStamp(calls[0]!)).toEqual(stamp);
  });

  it('does not fingerprint an unobserved exit from error-shaped log text', async () => {
    const { sql } = fakeSql();
    let tailReads = 0;
    const stamp = await recordAttemptOnClose(closed({ exitCode: null }), {
      sql,
      now: () => NOW,
      readTail: async () => {
        tailReads++;
        return 'Permission denied\nJOB END exit=0\n';
      },
    });
    expect(tailReads).toBe(0);
    expect(stamp).toMatchObject({ outcome: 'unknown', fingerprint: null, label: null, source: null });
  });

  it('does not fingerprint a successful exit from error-shaped log text', async () => {
    const { sql } = fakeSql();
    let tailReads = 0;
    const stamp = await recordAttemptOnClose(closed({ exitCode: 0 }), {
      sql,
      now: () => NOW,
      readTail: async () => {
        tailReads++;
        return 'Permission denied\nJOB END exit=0\n';
      },
    });
    expect(tailReads).toBe(0);
    expect(stamp).toMatchObject({ outcome: 'pass', fingerprint: null, label: null, source: null });
  });

  it('fingerprints a failed attempt from its log tail, and two runs of the same failure match', async () => {
    const run = async (logDir: string) => {
      const { sql, calls } = fakeSql();
      const stamp = await recordAttemptOnClose(closed({ exitCode: 1 }), {
        sql,
        now: () => NOW,
        readTail: async (path) => {
          expect(path).toBe('/logs/task-1.log');
          return `phase C starting\nError: peer converge timed out after 90s (evidence ${logDir})\n`;
        },
      });
      return { stamp, calls };
    };
    const first = await run('/tmp/ev-111');
    const second = await run('/tmp/ev-222');
    expect(first.stamp).toMatchObject({ outcome: 'fail', source: 'log' });
    expect(first.stamp!.label).toContain('peer converge timed out');
    expect(first.stamp!.fingerprint).toBeTruthy();
    expect(second.stamp!.fingerprint).toBe(first.stamp!.fingerprint);
    expect(writtenStamp(first.calls[0]!).fingerprint).toBe(first.stamp!.fingerprint);
  });

  it('falls back to the exit fingerprint when a failed attempt has no log', async () => {
    const { sql } = fakeSql();
    const stamp = await recordAttemptOnClose(
      closed({ state: 'timed_out', exitCode: null, exitReason: 'deadline', logPath: null }),
      { sql, now: () => NOW },
    );
    expect(stamp).toMatchObject({ outcome: 'fail', source: 'exit' });
    expect(stamp!.label).toContain('deadline');
  });

  it('never overwrites a structured result a conforming harness already wrote', async () => {
    const { sql, calls } = fakeSql();
    await recordAttemptOnClose(closed({ exitCode: 1 }), { sql, now: () => NOW, readTail: async () => 'Error: x' });
    expect(calls[0]!.text).toMatch(/verificationAttempt,source/);
    expect(calls[0]!.text).toMatch(/'structured'/);
  });

  it('is fail-soft: a database error returns null instead of breaking the close', async () => {
    const { sql } = fakeSql({ throws: true });
    await expect(recordAttemptOnClose(closed(), { sql, now: () => NOW })).resolves.toBeNull();
  });
});
