import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../work-items';
import {
  BLUEPRINT_PROGRAM_COMPLETION_OWNER,
  blueprintProgramCompletionRef,
  projectBlueprintOperationStatus,
  terminalOperationWorkerProof,
  assertBusinessReviewer,
  type BlueprintOperationHandle,
} from './operation-service';
import { selectOperationSpecificationRevision } from './operation-admission';

const revision = 'a'.repeat(64);
const direct: BlueprintOperationHandle = {
  workspaceId: 'consumer-one', harnessSlug: 'neutral-a', receiptId: 12,
  operationId: 'summarize', specificationRevision: revision,
  target: { kind: 'work-item', id: 'WI-12' },
};
const plan: BlueprintOperationHandle = {
  ...direct, receiptId: 13,
  target: { kind: 'plan', runId: 25, instanceSlug: 'template@run-25' },
};

describe('distinct authenticated business reviewer', () => {
  const policy = { reviewerPrincipals: ['reviewer', 'submitter', 'worker'] };
  it('allows only a named principal distinct from submitter and worker', () => {
    expect(() => assertBusinessReviewer('reviewer', 'submitter/client', policy, 'worker/session')).not.toThrow();
    for (const principal of ['submitter', 'worker', 'intruder', 'reviewer/forged-client']) {
      expect(() => assertBusinessReviewer(principal, 'submitter/client', policy, 'worker/session')).toThrow(/distinct/);
    }
  });
});

describe('terminalOperationWorkerProof', () => {
  const worker = { terminalOwner: 'reviewer', terminalCompletionRef: 'completion:12',
    completionAuthority: 'validated', payload: { blueprintOperation: { input: { reviewContext: { gradedWorkItemRef: 'WI-42' } } } } } as WorkItem;
  it('attributes the completed worker and preserves the accepted input', () => {
    expect(terminalOperationWorkerProof(worker)).toEqual({ ownerId: 'reviewer', completionRef: 'completion:12',
      input: { reviewContext: { gradedWorkItemRef: 'WI-42' } } });
  });
  it.each([{ terminalOwner: null }, { terminalCompletionRef: null }, { completionAuthority: null }, { payload: null }])
    ('refuses incomplete worker proof %j', (patch) => {
      expect(() => terminalOperationWorkerProof({ ...worker, ...patch } as WorkItem)).toThrow();
    });
});

function item(id: string, state: string, assignee: string | null = null): WorkItem {
  return { id, state, assignee, family: 'feature', kind: 'feature',
    completionAuthority: state === 'passed' ? 'validated' : null } as WorkItem;
}

describe('projectBlueprintOperationStatus', () => {
  it('keeps accepted, dispatched, waiting, and terminal states distinct', () => {
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'open')])).toMatchObject({
      phase: 'accepted', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'open', 'worker-a')])).toMatchObject({
      phase: 'dispatched', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'blocked', 'worker-a')])).toMatchObject({
      phase: 'waiting', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'passed')])).toMatchObject({
      phase: 'terminal', outcome: 'succeeded',
    });
    expect(projectBlueprintOperationStatus(direct, [{ ...item('WI-12', 'done'), completionAuthority: 'committed' }]))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(projectBlueprintOperationStatus(direct, [{ ...item('WI-12', 'passed'), completionAuthority: null }]))
      .toMatchObject({ phase: 'terminal', outcome: 'unverified' });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'deprecated')])).toMatchObject({
      phase: 'terminal', outcome: 'dropped',
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'dropped')])).toMatchObject({
      phase: 'terminal', outcome: 'dropped',
    });
  });

  it('derives a failed program outcome from the canonical root close only', () => {
    const failedRoot = { ...item('WI-12', 'dropped'),
      terminalOwner: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      terminalCompletionRef: blueprintProgramCompletionRef(direct, 'failed') };
    expect(projectBlueprintOperationStatus(direct, [failedRoot]))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    expect(projectBlueprintOperationStatus({ ...direct, receiptId: 99 }, [failedRoot]))
      .toMatchObject({ phase: 'terminal', outcome: 'dropped' });
    expect(projectBlueprintOperationStatus(direct, [failedRoot], null,
      { cancellationRequested: true, wait: null }))
      .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
  });

  it('does not present a partially settled plan as a completed result', () => {
    const status = projectBlueprintOperationStatus(
      plan, [item('WI-a', 'passed'), item('WI-b', 'blocked')],
      { status: 'running', outcome: null },
    );
    expect(status).toMatchObject({ phase: 'waiting', outcome: null });
    expect(status.items.map((entry) => entry.id)).toEqual(['WI-a', 'WI-b']);
  });

  it('does not treat a plan acceptance with no promoted items as success', () => {
    expect(projectBlueprintOperationStatus(plan, [], { status: 'running', outcome: null })).toMatchObject({
      phase: 'accepted', outcome: null,
    });
    expect(projectBlueprintOperationStatus(plan, [], { status: 'failed', outcome: 'failed' })).toMatchObject({
      phase: 'terminal', outcome: 'failed',
    });
    expect(projectBlueprintOperationStatus(plan, [], { status: 'done', outcome: 'success' })).toMatchObject({
      phase: 'terminal', outcome: 'succeeded',
    });
    expect(projectBlueprintOperationStatus(plan, [item('WI-pending', 'open')], { status: 'done', outcome: 'success' }))
      .toMatchObject({ phase: 'accepted', outcome: null });
  });

  it('requires the plan run to settle successfully even after every child passes', () => {
    const children = [item('WI-a', 'passed'), item('WI-b', 'passed')];
    expect(projectBlueprintOperationStatus(plan, children, { status: 'running', outcome: null }))
      .toMatchObject({ outcome: null });
    expect(projectBlueprintOperationStatus(plan, children, { status: 'done', outcome: 'partial' }))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    expect(projectBlueprintOperationStatus(plan, children, { status: 'done', outcome: 'success' }))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
  });
});

describe('program child specification pin', () => {
  it('keeps the parent revision across pointer drift and response replay', () => {
    const parent = 'a'.repeat(64);
    const newer = 'b'.repeat(64);
    expect(selectOperationSpecificationRevision(parent, undefined, newer)).toBe(parent);
    expect(selectOperationSpecificationRevision(parent, parent, newer)).toBe(parent);
    expect(() => selectOperationSpecificationRevision(parent, newer, newer))
      .toThrow('receipt differs from the expected specification revision');
    expect(() => selectOperationSpecificationRevision('invalid', undefined, newer))
      .toThrow('specification revision is invalid');
  });
});
