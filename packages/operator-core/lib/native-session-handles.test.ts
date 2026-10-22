import { describe, expect, it } from 'vitest';
import type { AdvSessionRow } from './adv-sessions';
import {
  nativeSessionHandleForAdvSession,
  nativeTranscriptProofFromLaunchReceipt,
  launchTaskForKickoffRecovery,
  nativeSessionHandleForSpawnedAgent,
  claudeHandleAfterRematerializeAttempt,
  type ClaudeNativeSessionHandle,
  type NativeSessionDeps,
} from './native-session-handles';
import type {
  ResolveSessionConfigDirOptions,
  SessionConfigDirResolution,
} from './session-config-dir';

/**
 * WI-38369: the handle no longer COMPUTES a config dir, it asks the resolver to OBSERVE
 * one — so these tests inject the resolver and assert on what the handle asks it for and
 * what it does with the answer. The resolver's own fs behaviour is covered against a real
 * temp tree in session-config-dir.test.ts; duplicating it here would test the wrong seam.
 */
const RESOLVED = '/home/x/.papercusp/session-claude/su-real';

describe('launch task recovery identity', () => {
  const failed = { taskId: 'task-retired', kickoffProof: {
    persisted: false, nativeRef: null, reason: 'kickoff-not-submitted:role-mcp-unavailable',
  } };

  it('retains a conclusive single retired failure outside the opened task list', () => {
    expect(launchTaskForKickoffRecovery({ opened: 0, tasks: [], failures: [failed] })).toBe(failed);
  });

  it('always preserves an opened task over a failure receipt', () => {
    const live = { taskId: 'task-live' };
    expect(launchTaskForKickoffRecovery({ opened: 0, tasks: [live], failures: [failed] })).toBe(live);
  });

  it.each([
    { opened: 0, failures: [failed, failed] },
    { opened: 1, failures: [failed] },
    { failures: [failed] },
    { opened: 0, failures: [{ taskId: 'task-retired' }] },
    { opened: 0, failures: [{ ...failed, kickoffProof: { persisted: false, reason: 'kickoff-proof-timeout' } }] },
    { opened: 0, failures: [{ ...failed, kickoffProof: { persisted: true, reason: failed.kickoffProof.reason } }] },
  ])('refuses ambiguous, unmeasured or uncertain failed receipts: %j', receipt => {
    expect(launchTaskForKickoffRecovery(receipt)).toBeUndefined();
  });
});

describe('native transcript launch receipt proof', () => {
  const task = { ownerId: 'su-exact', kickoffProof: { nativeRef: 'exact.jsonl' }, nativeSession: null };
  const binding = { ownerId: 'su-exact', sessionId: 'exact-rollout' };

  it('reads a legacy Codex receipt only with one exact verifier owner binding', () => {
    expect(nativeTranscriptProofFromLaunchReceipt({ tasks: [task], freshVerdict: { sessions: [binding] } }, 'codex'))
      .toEqual({ nativeTranscriptPath: 'exact.jsonl', nativeSessionId: 'exact-rollout', nativeBackend: 'codex' });
  });

  it.each([[], [{ ...binding, ownerId: 'su-foreign' }], [binding, binding], [{ ...binding, sessionId: '' }]].map(sessions => ({ sessions })))(
    'rejects missing, foreign, ambiguous or unresolved verifier bindings: %j', ({ sessions }) => {
      expect(nativeTranscriptProofFromLaunchReceipt({ tasks: [task], freshVerdict: { sessions } }, 'codex')).toBeUndefined();
    });

  it('rejects a foreign handle and never downgrades it to legacy proof', () => {
    expect(nativeTranscriptProofFromLaunchReceipt({ tasks: [{ ...task,
      nativeSession: { backend: 'codex', ownerId: 'su-foreign', rolloutId: 'foreign' },
    }], freshVerdict: { sessions: [binding] } }, 'codex')).toBeUndefined();
  });

  it('does not infer a backend from a legacy native filename or owner identity', () => {
    expect(nativeTranscriptProofFromLaunchReceipt({ tasks: [task], freshVerdict: { sessions: [binding] } }, 'claude')).toBeUndefined();
    expect(nativeTranscriptProofFromLaunchReceipt({ tasks: [{ ...task, ownerId: undefined }],
      freshVerdict: { sessions: [binding] } }, 'codex')).toBeUndefined();
  });
});
const resolvedTo = (dir: string): SessionConfigDirResolution => ({
  dir,
  source: 'live-process',
  tried: [],
  unresolvedReason: null,
});
const unresolved: SessionConfigDirResolution = {
  dir: null,
  source: null,
  tried: [],
  unresolvedReason: 'no observable config dir — WI-38349',
};

/** Records the options the handle passed, so the wiring itself is asserted. */
function spyResolver(result: SessionConfigDirResolution) {
  const calls: ResolveSessionConfigDirOptions[] = [];
  const deps: NativeSessionDeps = {
    resolveConfigDir: (opts) => {
      calls.push(opts);
      return result;
    },
  };
  return { calls, deps };
}

const adv = (overrides: Partial<AdvSessionRow> = {}): AdvSessionRow => ({
  id: 42,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console',
  terminalBin: null,
  pid: null,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-1',
  sessionId: null,
  display: null,
  launchArgv: null,
  launchedAt: null,
  startedAt: '2026-06-22T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  endedBy: null,
  endedSignal: null,
  ...overrides,
});

describe('nativeSessionHandleForAdvSession', () => {
  it('normalizes a Claude adv_session forced native session id', () => {
    const { deps } = spyResolver(resolvedTo(RESOLVED));
    expect(nativeSessionHandleForAdvSession(adv({ sessionId: 'claude-session' }), deps)).toEqual({
      backend: 'claude',
      source: 'adv_sessions',
      ownerId: 'su-1',
      sessionId: 'claude-session',
      configDir: RESOLVED,
      configDirSource: 'live-process',
      configDirUnresolvedReason: null,
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  // The bug: `configDir: sessionClaudeConfigDir(ownerId)` named a directory that had
  // never existed for 82 of 100 live sessions measured 2026-08-13, and a consumer that
  // trusts it resumes into an empty dir ("No conversation found") — or worse, writes a
  // rematerialized transcript there.
  it('WI-38369: reports UNKNOWN rather than the formula when nothing observes a dir', () => {
    const { deps } = spyResolver(unresolved);
    const handle = nativeSessionHandleForAdvSession(adv({ sessionId: 'claude-session' }), deps);

    expect(handle).toMatchObject({
      configDir: null,
      configDirSource: null,
      configDirUnresolvedReason: 'no observable config dir — WI-38349',
    });
    // The formula's path must not appear anywhere in the handle.
    expect(JSON.stringify(handle)).not.toContain('session-claude/su-1');
  });

  it('WI-38369: asks the resolver by coord owner id + session id, and forwards the pid hint', () => {
    const { calls, deps } = spyResolver(resolvedTo(RESOLVED));
    nativeSessionHandleForAdvSession(adv({ sessionId: 'claude-session' }), { ...deps, pidHint: 4242 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ownerId: 'su-1', sessionId: 'claude-session', pidHint: 4242 });
  });

  it('WI-38369: a missing owner id is UNKNOWN with a reason, not a silent null', () => {
    const { calls, deps } = spyResolver(resolvedTo(RESOLVED));
    const handle = nativeSessionHandleForAdvSession(adv({ coordOwnerId: null, sessionId: 's' }), deps);

    expect(handle).toMatchObject({ configDir: null, configDirSource: null });
    expect((handle as ClaudeNativeSessionHandle).configDirUnresolvedReason).toMatch(/owner id is not recorded/);
    expect(calls, 'no owner id ⇒ nothing to resolve against').toHaveLength(0);
  });

  it('normalizes a Codex adv_session to CODEX_HOME plus latest rollout id', () => {
    expect(
      nativeSessionHandleForAdvSession(
        adv({ agent: 'codex', sessionId: null }),
        {
          codexHomeForSessionKey: (key) => `/codex/session-${key}`,
          findCodexRolloutId: (home) => home === '/codex/session-42' ? 'rollout-42' : null,
        },
      ),
    ).toEqual({
      backend: 'codex',
      source: 'adv_sessions',
      ownerId: 'su-1',
      codexHome: '/codex/session-42',
      rolloutId: 'rollout-42',
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  it('normalizes an unlinked OMP adv_session with an explicit missing reason', () => {
    const seenKeys: Array<string | number> = [];
    expect(
      nativeSessionHandleForAdvSession(
        adv({ agent: 'omp', ompThreadId: null }),
        {
          ompAgentHome: (key) => {
            seenKeys.push(key);
            return `/omp/session-${key}/agent`;
          },
        },
      ),
    ).toEqual({
      backend: 'omp',
      source: 'adv_sessions',
      ownerId: 'su-1',
      ompThreadId: null,
      agentHome: '/omp/session-42/agent',
      exactResumeSupported: false,
      missingReason: 'omp thread id is not linked yet',
    });
    expect(seenKeys).toEqual([42]);
  });

  it('routes a tracked OMP adv_session to its per-row agent home by default', () => {
    expect(
      nativeSessionHandleForAdvSession(
        adv({
          id: 21143,
          agent: 'omp',
          ompThreadId: '01a04feb-217e-77cd-849f-9ea9e4f2d230',
        }),
      ),
    ).toMatchObject({
      backend: 'omp',
      ompThreadId: '01a04feb-217e-77cd-849f-9ea9e4f2d230',
      agentHome: expect.stringMatching(
        /\/\.papercusp\/su-omp-homes\/session-21143\/agent$/,
      ),
    });
  });
});

describe('nativeSessionHandleForSpawnedAgent', () => {
  it('normalizes a spawned Claude session id', () => {
    const { deps } = spyResolver(resolvedTo(RESOLVED));
    expect(
      nativeSessionHandleForSpawnedAgent(
        {
          spawnId: 's-1',
          sessionOwner: 'owner-1',
          backend: 'claude-code',
          sessionId: 'claude-spawn-session',
        },
        deps,
      ),
    ).toEqual({
      backend: 'claude',
      source: 'spawned_agents',
      ownerId: 'owner-1',
      sessionId: 'claude-spawn-session',
      configDir: RESOLVED,
      configDirSource: 'live-process',
      configDirUnresolvedReason: null,
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  // A spawned agent has TWO identities and only one of them names the dir: the
  // orchestrator keys it by the minted spawn id (invoke.ts → sessionClaudeConfigDir(
  // trackedSessionSpawnId)) while `ownerId` is the coord owner. `ownerId` must stay the
  // coord owner so the live-process strategy's PAPERCUSP_SID guard still rejects a
  // recycled pid — so the spawn id rides as an alternate CONVENTIONAL key.
  it('WI-38369: passes the SPAWN id as an alternate conventional key, keeping ownerId the coord owner', () => {
    const { calls, deps } = spyResolver(resolvedTo(RESOLVED));
    nativeSessionHandleForSpawnedAgent(
      { spawnId: 's-1', sessionOwner: 'owner-1', backend: 'claude-code', sessionId: 'sess' },
      deps,
    );

    expect(calls[0]).toMatchObject({ ownerId: 'owner-1', altOwnerIds: ['s-1'], sessionId: 'sess' });
  });

  it('WI-38369: an unresolvable spawned dir is UNKNOWN, not the formula', () => {
    const { deps } = spyResolver(unresolved);
    const handle = nativeSessionHandleForSpawnedAgent(
      { spawnId: 's-1', sessionOwner: 'owner-1', backend: 'claude-code', sessionId: 'sess' },
      deps,
    );

    expect(handle).toMatchObject({ configDir: null, configDirSource: null });
    expect(JSON.stringify(handle)).not.toContain('session-claude/owner-1');
  });

  it('makes missing spawned Codex durable handles explicit', () => {
    expect(
      nativeSessionHandleForSpawnedAgent({
        spawnId: 's-codex',
        backend: 'codex',
      }),
    ).toEqual({
      backend: 'codex',
      source: 'spawned_agents',
      ownerId: 's-codex',
      codexHome: '',
      rolloutId: null,
      exactResumeSupported: false,
      missingReason: 'spawned Codex agent has no durable CODEX_HOME/rollout handle recorded',
    });
  });

  it('normalizes a spawned OMP thread handle', () => {
    expect(
      nativeSessionHandleForSpawnedAgent({
        spawnId: 's-omp',
        backend: 'omp',
        ompThreadId: 'omp-thread',
        agentHome: '/omp/agent',
      }),
    ).toEqual({
      backend: 'omp',
      source: 'spawned_agents',
      ownerId: 's-omp',
      ompThreadId: 'omp-thread',
      agentHome: '/omp/agent',
      exactResumeSupported: true,
      missingReason: null,
    });
  });
});

describe('claudeHandleAfterRematerializeAttempt (WI-5226 / EI-308 gap 2)', () => {
  const handle: ClaudeNativeSessionHandle = {
    backend: 'claude',
    source: 'adv_sessions',
    ownerId: 'su-1',
    sessionId: 'sess-1',
    configDir: '/home/x/.papercusp/session-claude/su-1',
    configDirSource: 'conventional',
    configDirUnresolvedReason: null,
    exactResumeSupported: true,
    missingReason: null,
  };

  it('leaves the handle untouched when the transcript is already present on disk', () => {
    const out = claudeHandleAfterRematerializeAttempt(handle, { presentOnDisk: true, rematerialized: false });
    expect(out).toEqual(handle);
  });

  it('leaves exactResumeSupported true when a rematerialize attempt restored the file', () => {
    const out = claudeHandleAfterRematerializeAttempt(handle, { presentOnDisk: false, rematerialized: true });
    expect(out).toEqual(handle);
  });

  it('downgrades exactResumeSupported with a missingReason when neither present nor restorable', () => {
    const out = claudeHandleAfterRematerializeAttempt(handle, {
      presentOnDisk: false,
      rematerialized: false,
      rematReason: 'not_archived',
    });
    expect(out.exactResumeSupported).toBe(false);
    expect(out.missingReason).toBe('session transcript was cleaned up and could not be restored (not_archived)');
    // the rest of the handle is preserved
    expect(out).toMatchObject({ backend: 'claude', sessionId: 'sess-1', configDir: handle.configDir });
  });

  it('downgrades without a parenthetical when no rematReason is given', () => {
    const out = claudeHandleAfterRematerializeAttempt(handle, { presentOnDisk: false, rematerialized: false });
    expect(out.missingReason).toBe('session transcript was cleaned up and could not be restored');
  });
});
