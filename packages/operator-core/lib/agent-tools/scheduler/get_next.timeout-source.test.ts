/**
 * EI-21831306274538775 — a synthesized `57014` must not claim PostgreSQL stalled.
 *
 * The scheduler's claim ladder deliberately raises `OrgTxnTimeoutError('57014')` when its
 * OWN wall-clock budget expires, so an abandoned claim can never be misread as "nothing
 * matched". That part is correct and stays. The error text must distinguish that caller
 * budget from a PostgreSQL timeout, and a fresh-connection blocker snapshot must never be
 * presented as the cause of the timed-out operation.
 *
 * Both cases remain retryable and keep the same code; their messages identify the
 * measured timeout source without claiming query cost, lock wait, or a particular blocker.
 */
import { describe, expect, it } from 'vitest';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { getNextContentionResult } from './get_next';

describe('OrgTxnTimeoutError timeoutSource (EI-21831306274538775)', () => {
  it('defaults to pg, so every pre-existing raise site keeps its meaning', () => {
    const err = new OrgTxnTimeoutError('57014', new Error('boom'));
    expect(err.timeoutSource).toBe('pg');
    expect(err.message).toContain('statement_timeout');
    expect(err.message).not.toContain('the database stalled');
  });

  it('a caller-budget timeout does NOT claim the database stalled', () => {
    const err = new OrgTxnTimeoutError(
      '57014',
      new Error('claim ladder budget exhausted'),
      'the scheduler claim ladder ran out of its own wall-clock budget',
      'caller-budget',
    );
    expect(err.timeoutSource).toBe('caller-budget');
    expect(err.message).not.toContain('the database stalled');
    expect(err.message).toContain('PostgreSQL itself did not time out');
    // The code is deliberately retained — the point is to distinguish the CAUSE, not to
    // change the retry contract that keeps an expired budget from reading as "no work".
    expect(err.pgCode).toBe('57014');
    expect(err.message).toContain('the scheduler claim ladder ran out of its own wall-clock budget');
  });

  it('still distinguishes a genuine lock timeout from a statement timeout', () => {
    expect(new OrgTxnTimeoutError('55P03', new Error('x')).message).toContain('lock_timeout');
  });
});

describe('getNextContentionResult surfaces the cause (EI-21831306274538775)', () => {
  it('reports a PostgreSQL timeout without copying a global blocker snapshot to the caller', () => {
    const error = new OrgTxnTimeoutError(
      '57014',
      new Error('canceling statement due to statement timeout'),
      'observed head blocker pid 42 with query SELECT sensitive_value FROM private_table',
    );
    error.candidateWaitSnapshot = {
      status: 'sampled',
      targetPid: 42,
      waitEventType: 'Lock',
      waitEvent: 'transactionid',
      blockingPids: [7],
      statementCapMs: 5_000,
      sampleAfterMs: 4_000,
    };
    const out = getNextContentionResult(error);
    expect(out.timeoutSource).toBe('pg');
    expect(out.retryable).toBe(true);
    expect(out.message).toContain('PostgreSQL timeout (57014)');
    expect(out.message).not.toContain('contention');
    expect(out.message).not.toContain('database stalled');
    expect(out.message).not.toContain('likely blocked by pid');
    expect(out.message).toContain('statement_timeout');
    expect(out.message).not.toContain('separate-connection blocker snapshot');
    expect(out.message).not.toContain('observed head blocker pid 42');
    expect(out.message).not.toContain('sensitive_value');
    expect(out.candidateWaitSnapshot).toEqual(error.candidateWaitSnapshot);
  });

  it('reports a ladder-budget timeout WITHOUT blaming PG, and says where to look instead', () => {
    const out = getNextContentionResult(
      new OrgTxnTimeoutError('57014', new Error('claim ladder budget exhausted'), undefined, 'caller-budget'),
    );
    expect(out.timeoutSource).toBe('caller-budget');
    expect(out.retryable).toBe(true);
    expect(out.pgCode).toBe('57014');
    expect(out.message).not.toContain('transient PostgreSQL contention');
    expect(out.message).toContain('PostgreSQL did not time out');
    expect(out.message).toContain('does not identify a phase or prove PG pool saturation');
  });

  it('identifies setup-acquisition as before the claim ladder without guessing at connect latency', () => {
    const out = getNextContentionResult(
      new OrgTxnTimeoutError(
        '57014',
        new Error('setup acquisition expired'),
        'dedicated scheduler-claim setup budget expired',
        'caller-budget',
      ),
      'claim-setup-acquisition',
    );
    expect(out.message).toContain('before the claim ladder');
    expect(out.message).toContain('no claim was attempted');
    expect(out.message).toContain('does not isolate connection-establishment latency');
    expect(out.message).toContain('or prove pool saturation');
    expect(out.message).not.toContain('claim-ladder cost or backlog shape');
  });
});
