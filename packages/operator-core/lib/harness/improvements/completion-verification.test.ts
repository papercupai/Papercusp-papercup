/**
 * P-007 Phase C (unified-bug-pipeline-and-honest-queue-2026-10-05, D-028): the pure
 * completion-verification policy — spawn/reuse/gating, the verdict door, verdict
 * application, settlement auto-accept, and the policy-sealed acceptance that admits ONLY a
 * completion verification task for its own subject.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_VERIFICATION_POLICY,
  evaluateImplementationAcceptance,
  sealImplementationAcceptance,
} from './agent-review-policy';
import {
  acceptCompletionOnSettlement,
  applyCompletionVerdict,
  buildCompletionTaskPayload,
  completionVerdictRefusal,
  readCompletionRecord,
  spawnCompletionVerification,
  type CompletionSubject,
  type CompletionVerificationDeps,
} from './completion-verification';

const SUBJECT: CompletionSubject = { id: 'WI-1', title: 'Ship the thing', kind: 'feature', closer: 'su-closer' };
const NOW = new Date('2026-10-06T04:00:00.000Z');
/** The row's own source: the seal binds the title/summary the task row is created with. */
const sourceOf = (built: { title: string; body: string }) => ({ kind: 'task', title: built.title, summary: built.body }) as never;

function deps(over: Partial<CompletionVerificationDeps> = {}): CompletionVerificationDeps & {
  created: Array<Record<string, unknown>>;
  edges: Array<[string, string]>;
} {
  const created: Array<Record<string, unknown>> = [];
  const edges: Array<[string, string]> = [];
  return {
    created,
    edges,
    liveDependents: async () => [
      { kind: 'feature', ref: 'WI-2' },
      { kind: 'feature', ref: 'WI-3' },
    ],
    findOpenTask: async () => null,
    createTask: async (input) => {
      created.push(input as Record<string, unknown>);
      return { id: 'WI-TASK' };
    },
    addBlockingEdge: async (taskId, dependent) => {
      edges.push([taskId, dependent.ref]);
    },
    now: () => NOW,
    ...over,
  };
}

describe('spawnCompletionVerification', () => {
  it('creates no task when the subject blocks no live work', async () => {
    const d = deps({ liveDependents: async () => [] });
    expect(await spawnCompletionVerification(SUBJECT, d)).toEqual({ outcome: 'no-dependents' });
    expect(d.created).toHaveLength(0);
  });

  it('refuses when the close recorded no closer to exclude', async () => {
    const d = deps();
    const result = await spawnCompletionVerification({ ...SUBJECT, closer: ' ' }, d);
    expect(result.outcome).toBe('refused');
    expect(d.created).toHaveLength(0);
  });

  it('creates one task and gates every live dependent through a blocks edge', async () => {
    const d = deps();
    const result = await spawnCompletionVerification(SUBJECT, d);
    expect(result).toEqual({ outcome: 'created', taskId: 'WI-TASK', gated: ['WI-2', 'WI-3'], notGated: [] });
    expect(d.edges).toEqual([
      ['WI-TASK', 'WI-2'],
      ['WI-TASK', 'WI-3'],
    ]);
    const payload = d.created[0]!.payload as Record<string, unknown>;
    expect(payload.verification).toMatchObject({ check: 'completion', subject: 'WI-1', implementers: ['su-closer'] });
    expect(readCompletionRecord(payload)).toMatchObject({ subject: 'WI-1', closer: 'su-closer', proposedAt: NOW.toISOString() });
  });

  it('reuses the open task for the same subject instead of creating a second one', async () => {
    const d = deps({ findOpenTask: async () => ({ id: 'WI-OLD' }) });
    const result = await spawnCompletionVerification(SUBJECT, d);
    expect(result).toMatchObject({ outcome: 'reused', taskId: 'WI-OLD', gated: ['WI-2', 'WI-3'] });
    expect(d.created).toHaveLength(0);
  });

  it('records a dependent the graph refuses instead of failing the whole spawn', async () => {
    const d = deps({
      addBlockingEdge: async (_taskId, dependent) => {
        if (dependent.ref === 'WI-3') throw new Error('cannot add unresolved blocker behind active dependant');
      },
    });
    const result = await spawnCompletionVerification(SUBJECT, d);
    expect(result).toMatchObject({
      outcome: 'created',
      gated: ['WI-2'],
      notGated: [{ ref: 'WI-3', reason: expect.stringContaining('active dependant') }],
    });
  });

  it('never gates the subject on itself', async () => {
    const d = deps({ liveDependents: async () => [{ kind: 'feature', ref: 'WI-1' }] });
    expect(await spawnCompletionVerification(SUBJECT, d)).toEqual({ outcome: 'no-dependents' });
  });
});

describe('completion-verification acceptance policy', () => {
  it('admits the policy-sealed contract on the completion task it was sealed for', () => {
    const built = buildCompletionTaskPayload(SUBJECT, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const verdict = evaluateImplementationAcceptance(built.payload, sourceOf(built));
    expect(verdict.state).not.toBe('incomplete');
    expect(verdict.state).not.toBe('absent');
  });

  it('does not admit the same contract on a row without a completion verification block', () => {
    const built = buildCompletionTaskPayload(SUBJECT, NOW);
    if (!built.ok) throw new Error('seal refused');
    const admitted = evaluateImplementationAcceptance(built.payload, sourceOf(built)).state;
    const { verification: _dropped, ...rest } = built.payload as Record<string, unknown>;
    expect(evaluateImplementationAcceptance(rest, sourceOf(built)).state).not.toBe(admitted);
  });

  it('refuses to seal with the completion policy on a row that is not a completion task', () => {
    const sealed = sealImplementationAcceptance({
      proposal: {
        problem: 'p',
        evidence: ['e'],
        outcome: 'o',
        scope: 's',
        completionCheck: 'c',
      },
      authority: { kind: 'policy', policy: COMPLETION_VERIFICATION_POLICY, actor: 'system:completion-verification' },
      reason: 'completion-verification',
      source: { kind: 'task', title: 't', summary: 's' },
      acceptedAt: NOW.toISOString(),
      rowPayload: {},
    } as never);
    expect(sealed.ok).toBe(false);
  });

  it('does not admit the contract when the row verifies a different subject', () => {
    const built = buildCompletionTaskPayload(SUBJECT, NOW);
    if (!built.ok) throw new Error('seal refused');
    const other = buildCompletionTaskPayload({ ...SUBJECT, id: 'WI-99' }, NOW);
    if (!other.ok) throw new Error('seal refused');
    const admitted = evaluateImplementationAcceptance(built.payload, sourceOf(built)).state;
    const swapped = { ...(built.payload as Record<string, unknown>), verification: (other.payload as Record<string, unknown>).verification };
    expect(evaluateImplementationAcceptance(swapped, sourceOf(built)).state).not.toBe(admitted);
  });
});

describe('completionVerdictRefusal (the verdict door)', () => {
  const taskPayload = () => {
    const built = buildCompletionTaskPayload(SUBJECT, NOW);
    if (!built.ok) throw new Error('seal refused');
    return built.payload;
  };

  it('refuses a terminal close of a completion task without a verdict', () => {
    expect(completionVerdictRefusal({ payload: taskPayload(), completion: { summary: 'x' }, terminal: true })).toMatch(
      /requires completion\.verificationVerdict/,
    );
  });

  it('refuses a reject without a reason', () => {
    expect(
      completionVerdictRefusal({ payload: taskPayload(), completion: { verificationVerdict: { verdict: 'reject' } }, terminal: true }),
    ).toMatch(/requires completion\.verificationVerdict\.reason/);
  });

  it('admits accept, and reject with a reason', () => {
    const payload = taskPayload();
    expect(completionVerdictRefusal({ payload, completion: { verificationVerdict: { verdict: 'accept' } }, terminal: true })).toBeNull();
    expect(
      completionVerdictRefusal({ payload, completion: { verificationVerdict: { verdict: 'reject', reason: 'tests absent' } }, terminal: true }),
    ).toBeNull();
  });

  it('never affects a non-terminal write or a row that is not a completion task', () => {
    expect(completionVerdictRefusal({ payload: taskPayload(), completion: {}, terminal: false })).toBeNull();
    expect(completionVerdictRefusal({ payload: { title: 'ordinary' }, completion: {}, terminal: true })).toBeNull();
  });
});

describe('applyCompletionVerdict', () => {
  const taskPayload = () => {
    const built = buildCompletionTaskPayload(SUBJECT, NOW);
    if (!built.ok) throw new Error('seal refused');
    return built.payload;
  };

  it('accept writes nothing: the task being done satisfies its edges', async () => {
    const reopenSubject = vi.fn();
    const comment = vi.fn();
    const result = await applyCompletionVerdict(
      { taskPayload: taskPayload(), completion: { verificationVerdict: { verdict: 'accept' } }, verifier: 'su-verifier' },
      { reopenSubject, comment },
    );
    expect(result).toEqual({ applied: 'accept', subject: 'WI-1' });
    expect(reopenSubject).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it('reject reopens the subject to its closer and records the reason on it', async () => {
    const reopenSubject = vi.fn(async () => {});
    const comment = vi.fn(async () => {});
    const result = await applyCompletionVerdict(
      {
        taskPayload: taskPayload(),
        completion: { verificationVerdict: { verdict: 'reject', reason: 'no test covers R-2' } },
        verifier: 'su-verifier',
      },
      { reopenSubject, comment },
    );
    expect(result).toEqual({ applied: 'reject', subject: 'WI-1' });
    expect(reopenSubject).toHaveBeenCalledWith('WI-1', 'su-closer', 'su-verifier');
    expect(comment).toHaveBeenCalledWith('WI-1', expect.stringContaining('no test covers R-2'), 'su-verifier');
  });

  it('ignores rows that are not completion tasks', async () => {
    const reopenSubject = vi.fn();
    expect(
      await applyCompletionVerdict(
        { taskPayload: {}, completion: { verificationVerdict: { verdict: 'reject', reason: 'x' } }, verifier: 'v' },
        { reopenSubject, comment: vi.fn() },
      ),
    ).toBeNull();
    expect(reopenSubject).not.toHaveBeenCalled();
  });
});

describe('acceptCompletionOnSettlement', () => {
  it('accepts the open task when settlement upgrades the subject', async () => {
    const closeAccepted = vi.fn(async () => {});
    const result = await acceptCompletionOnSettlement(
      { subjectId: 'WI-1', authority: 'committed' },
      { findOpenTask: async () => ({ id: 'WI-TASK' }), closeAccepted },
    );
    expect(result).toEqual({ accepted: 'WI-TASK' });
    expect(closeAccepted).toHaveBeenCalledWith('WI-TASK', 'WI-1', 'committed');
  });

  it('does nothing while the subject is still proposed, or when no task is open', async () => {
    const closeAccepted = vi.fn();
    expect(
      await acceptCompletionOnSettlement({ subjectId: 'WI-1', authority: 'proposed' }, { findOpenTask: async () => ({ id: 'T' }), closeAccepted }),
    ).toBeNull();
    expect(
      await acceptCompletionOnSettlement({ subjectId: 'WI-1', authority: 'committed' }, { findOpenTask: async () => null, closeAccepted }),
    ).toBeNull();
    expect(closeAccepted).not.toHaveBeenCalled();
  });
});
