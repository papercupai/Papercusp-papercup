import { describe, expect, it } from 'vitest';
import {
  completeGithubBridgeState,
  completeOwnHeadPublishState,
  completeRefAnnounceState,
  type GithubBridgeRoutineState,
  type GitSyncRoutineMetadataPatch,
  type OwnHeadPublishRoutineState,
  type RefAnnounceRoutineState,
} from './routine-metadata-state';

const githubBridgeState: GithubBridgeRoutineState = {
  at: 1,
  ran: true,
  skipped: null,
  egress_target: 'skipped',
  ingressed: { updated: 0, upToDate: 0, nonFF: 0, absent: 0 },
  egress: null,
  last_admitted: null,
  divergence: 'clear',
  needs_owner: false,
  agent_actionable: false,
  agent_remedies: [],
  egress_head: null,
  egress_scan_progress: null,
  errors: [],
};

const ownHeadPublishState: OwnHeadPublishRoutineState = {
  at: 1,
  changed: false,
  branch: null,
  sha: null,
  publishedSha: null,
  backlogRemains: false,
  blockedAtCommit: null,
  oversizedCommit: null,
  refused: null,
  exemptedFindingsCount: 0,
};

const refAnnounceState: RefAnnounceRoutineState = {
  lastEventId: 0,
  budgetStates: {},
  publishVersion: 0,
  publishGeneration: null,
  replayFloors: {},
  parked: {},
  at: 1,
};

// The persistence boundary must reject a convention-bypassing inline object.
// If this stops producing a type error, a future writer can silently re-open
// the omission hazard even while every runtime unit test remains green.
// @ts-expect-error github_bridge must come from completeGithubBridgeState
const conventionBypassMustNotCompile: GitSyncRoutineMetadataPatch = { github_bridge: githubBridgeState };
void conventionBypassMustNotCompile;

describe('complete git-sync routine metadata states (WI-7063)', () => {
  it.each([
    ['github_bridge', completeGithubBridgeState, githubBridgeState],
    ['own_head_publish', completeOwnHeadPublishState, ownHeadPublishState],
    ['ref_announce', completeRefAnnounceState, refAnnounceState],
  ] as const)('%s accepts and preserves its complete replacement shape', (_key, complete, state) => {
    expect(complete(state as never)).toBe(state);
  });

  it.each([
    ['github_bridge', completeGithubBridgeState, githubBridgeState, 'egress_scan_progress'],
    ['own_head_publish', completeOwnHeadPublishState, ownHeadPublishState, 'publishedSha'],
    ['ref_announce', completeRefAnnounceState, refAnnounceState, 'budgetStates'],
  ] as const)('%s rejects an undefined field before JSON serialization can erase it', (key, complete, state, field) => {
    expect(() => complete({ ...state, [field]: undefined } as never)).toThrow(
      `metadata.${key} is incomplete; missing/undefined: ${field}`,
    );
  });

  it('preserves a pending egress scan cursor in the complete bridge replacement', () => {
    const cursor = {
      version: 1 as const,
      policyFingerprint: 'a'.repeat(64),
      baseSha: 'b'.repeat(40),
      targetSha: 'c'.repeat(40),
      lastScannedCommitSha: 'd'.repeat(40),
    };

    expect(completeGithubBridgeState({ ...githubBridgeState, egress_scan_progress: cursor }).egress_scan_progress)
      .toEqual(cursor);
  });
});
