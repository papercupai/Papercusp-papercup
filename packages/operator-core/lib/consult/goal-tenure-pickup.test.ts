import { describe, expect, it } from 'vitest';
import { goalTenureGradingWakeCopy, type GoalTenureGradingCascadeMeta } from './grading-cascade';
import { assertGoalTenurePickup } from './goal-tenure-pickup.test-helper';

function fixture() {
  const meta: GoalTenureGradingCascadeMeta = { flavor: 'goal-tenure-grading', workspaceId: 'workspace',
    goalId: 'goal', holderOwnerIds: ['holder'] };
  return { workspaceId: meta.workspaceId, goalId: meta.goalId, conversationId: 'conversation', cursor: 0,
    routing: { cascade: meta, selection: { selected: [{ ownerId: 'expert', answeringOwnerId: 'grader' }] } },
    native: { ownerId: 'grader', nativeSession: 'native-session', sha256: 'a'.repeat(64), hasResponse: true,
      text: goalTenureGradingWakeCopy(meta, 'conversation').body },
    partyKeys: new Map([['expert', 'expert-party'], ['grader', 'grader-party'], ['holder', 'holder-party']]) };
}

describe('residual-grader native pickup evidence', () => {
  it('joins the persisted answering identity, exact native assignment and independent lineage', () => {
    expect(assertGoalTenurePickup(fixture())).toMatchObject({ answeringOwner: 'grader',
      scope: 'actual-residual-grader-pickup-only' });
  });
  it('rejects queued delivery without a responding native turn', () => {
    const input = fixture(); input.native.hasResponse = false;
    expect(() => assertGoalTenurePickup(input)).toThrow('native responding turn required');
  });
  it('rejects the archived source transcript in place of the answering session', () => {
    const input = fixture(); input.native.ownerId = 'expert';
    expect(() => assertGoalTenurePickup(input)).toThrow('native answering identity mismatch');
  });
  it('rejects a generic consult or grading-integrity brief', () => {
    const input = fixture(); input.native.text = 'Answer FROM your transcript; audit this provisional card.';
    expect(() => assertGoalTenurePickup(input)).toThrow('exact residual-grading assignment');
  });
  it('rejects an assignment for a different conversation', () => {
    const input = fixture(); input.conversationId = 'other-conversation';
    expect(() => assertGoalTenurePickup(input)).toThrow('exact residual-grading assignment');
  });
  it('rejects a request from another goal or workspace', () => {
    const input = fixture(); input.goalId = 'other-goal';
    expect(() => assertGoalTenurePickup(input)).toThrow('request goal mismatch');
    input.goalId = 'goal'; input.workspaceId = 'other-workspace';
    expect(() => assertGoalTenurePickup(input)).toThrow('request workspace mismatch');
  });
  it('rejects an answering identity without complete lineage evidence', () => {
    const input = fixture(); input.partyKeys.delete('grader');
    expect(() => assertGoalTenurePickup(input)).toThrow('complete holder and grader lineage');
  });
  it.each(['expert', 'grader'])('rejects holder lineage shared by %s', owner => {
    const input = fixture(); input.partyKeys.set(owner, 'holder-party');
    expect(() => assertGoalTenurePickup(input)).toThrow('shares holder lineage');
  });
  it('rejects a missing answering identity or an invalid cursor', () => {
    const input = fixture(); input.routing.selection.selected[0]!.answeringOwnerId = '';
    expect(() => assertGoalTenurePickup(input)).toThrow('persisted answering identity');
    input.cursor = -1;
    expect(() => assertGoalTenurePickup(input)).toThrow('persisted cascade cursor');
  });
  it('rejects missing native snapshot custody', () => {
    const input = fixture(); input.native.sha256 = '';
    expect(() => assertGoalTenurePickup(input)).toThrow('native session and snapshot hash');
  });
});
