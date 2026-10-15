/**
 * agent-launch-verification.test.ts — plan
 * agent-launch-verification-and-spawn-env-2026-08-11, P-003 + P-004.
 *
 * P-003 kills the false "Launched": a clean terminal spawn is not proof an agent
 * is running. This is the 4th recurrence of that class (EI-11543, WI-4752,
 * EI-18696184925888288), and the ACCEPTANCE CASE is a real measured session —
 * adv_session 14842, which registered a row, fired its two launch statusline calls
 * at +3.6s/+3.7s, and then did nothing for the hour until the reaper closed it,
 * while the tool had already reported success.
 *
 * The suite is shaped around the finding that made the plan's original design
 * unusable (D-004): a 20s BOOLEAN would be wrong for most HEALTHY launches, since
 * the first real tool call is p50 ~31s / p90 ~417s. So the third state is not
 * hedging — it is the only honest verdict inside a bounded window, and half these
 * cases exist to stop a future edit collapsing it back to a boolean.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-launch-verification.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  FRESH_VERIFY_SILENCE_MS,
  LAUNCH_STATUSLINE_TOOLS,
  classifyAgentLaunchCommand,
  deriveFreshLaunchEvidenceSummary,
  deriveFreshLaunchWorkerAttestation,
  formatFreshLaunchEvidenceSummary,
  launchAttestationFromLedger,
  normalizeLaunchAttestationModelSpec,
  verifyFreshLaunchStarted,
  type FreshLaunchSessionProbe,
} from './agent-launch-core';

const ARGS = { workspaceId: 'ws', launcherOwnerId: 'su-caller', since: 1_000, expected: 1 };
/** No real sleeping: every case here is about the VERDICT, not about waiting. */
const FAST = { pollMs: 1, timeoutMs: 20, sleep: async () => {} };

/** A probe that returns a fixed set of sessions on every poll. */
function fixedProbe(sessions: FreshLaunchSessionProbe[]) {
  return async () => sessions;
}

const session = (over: Partial<FreshLaunchSessionProbe> = {}): FreshLaunchSessionProbe => {
  const ownerId = over.ownerId === undefined ? 'su-launched' : over.ownerId;
  const successfulCalls = over.successfulCalls ?? 0;
  return {
    advSessionId: 14842,
    sessionId: null,
    ownerId,
    successfulCalls,
    msSinceLastSignal: null,
    hasPresence: false,
    quotaBlocked: null,
    quotaBlockedSinceMs: null,
    attestationDiffs: [],
    workerAttestation: over.workerAttestation ?? deriveFreshLaunchWorkerAttestation({
      ownerId,
      successfulCalls,
      wakeSource: null,
      schedulerCalls: 0,
      successfulSchedulerCalls: 0,
      schedulerDisposition: null,
      claimedWorkItemId: null,
    }),
    ...over,
  };
};

describe('verifyFreshLaunchStarted — the ACCEPTANCE CASE (adv_session 14842)', () => {
  it('returns agentStarted:FALSE for a session that booted, beat twice, then went silent', async () => {
    // 14842's exact shape: a row exists, an owner id exists, only the two
    // statusline calls were ever made (so realCalls === 0), no presence row, and
    // the last signal is long past.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ successfulCalls: 0, hasPresence: false, msSinceLastSignal: 60_000 })]),
    });

    expect(
      verdict.agentStarted,
      'a session that registered, emitted only the launch statusline calls and then went ' +
        'silent is the "reports Launched, never actually starts" failure — it must be reported ' +
        'as a failure, not as success and not as unverified.',
    ).toBe(false);
    expect(verdict.workerReady).toBe(false);
    expect(verdict.note).toMatch(/DID NOT START/);
    expect(verdict.note).toContain('14842');
  });

  it('reports UNCONFIRMED (null) when nothing registered at all — absence is not observed death (EI-20437060078324174)', async () => {
    // The measured false-negative: a member registered 5.5s past the window and
    // went straight on to claim work while this branch asserted "psu died" with
    // three invented causes. Zero sessions at expiry is the ABSENCE of an
    // observation; per the FreshLaunchVerdict contract, `false` is reserved for
    // OBSERVED silence (the 14842 shape below), and an expired window is `null`.
    const verdict = await verifyFreshLaunchStarted(ARGS, { ...FAST, probe: fixedProbe([]) });
    expect(verdict.agentStarted).toBe(null);
    expect(verdict.note).toMatch(/no session registered/);
    expect(verdict.note).toMatch(/UNCONFIRMED/);
    expect(verdict.note).toMatch(/Do NOT relaunch/);
    // The confidently-wrong diagnosis must be gone: the note may not assert death.
    expect(verdict.note).not.toMatch(/DID NOT START/);
  });
});

describe('verifyFreshLaunchStarted — must NOT cry wolf on a healthy launch (D-004)', () => {
  it('canonicalizes Claude and Codex model presentation forms for attestation', () => {
    expect(normalizeLaunchAttestationModelSpec('claude-sonnet-5:xhigh', 'claude')).toBe(
      'claude-sonnet-5[1m]:xhigh',
    );
    expect(normalizeLaunchAttestationModelSpec('claude-sonnet-5[1m]:xhigh', 'claude')).toBe(
      'claude-sonnet-5[1m]:xhigh',
    );
    expect(normalizeLaunchAttestationModelSpec('claude-sonnet-4-6:xhigh', 'claude')).toBe(
      'claude-sonnet-4-6:xhigh',
    );
    expect(normalizeLaunchAttestationModelSpec('sol:xhigh', 'codex')).toBe(
      'gpt-5.6-sol:xhigh',
    );
    expect(normalizeLaunchAttestationModelSpec('gpt-5.6-sol:xhigh', 'codex')).toBe(
      'gpt-5.6-sol:xhigh',
    );
    expect(normalizeLaunchAttestationModelSpec('opus', 'omp')).toBe('opus');
    expect(normalizeLaunchAttestationModelSpec(null, 'claude')).toBeNull();
  });

  it('derives effort/account/carry/visibility from the durable launch argv', () => {
    expect(launchAttestationFromLedger(
      {
        agent: 'codex', workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'p', model: 'gpt-5.5:high',
        fleet: { slug: 'f', role: 'member' },
      },
      ['psu', '--model=gpt-5.5:high', '--account=auto', '--carry=cold', '--headless'],
    )).toMatchObject({
      effort: 'high', account: 'auto', carry: 'cold', visibility: 'headless',
    });
  });

  it('returns agentStarted:TRUE as soon as a real (non-statusline) call lands', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ successfulCalls: 5, msSinceLastSignal: 500 })]),
    });
    expect(verdict.agentStarted).toBe(true);
  });

  it('does not count a live presence row as readiness without a successful agent-chosen call (D-001)', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ successfulCalls: 0, hasPresence: true, msSinceLastSignal: 500 })]),
    });
    expect(verdict.agentStarted).toBeNull();
    expect(verdict.workerReady).toBe(false);
    expect(verdict.note).toMatch(/UNVERIFIED/);
  });

  it('reports a present zero-call session as failed when its PsuPtyHost observes quota blocking', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([
        session({
          successfulCalls: 0,
          hasPresence: true,
          msSinceLastSignal: 500,
          quotaBlocked: true,
          quotaBlockedSinceMs: Date.parse('2026-09-06T20:11:00.000Z'),
        }),
      ]),
    });

    expect(verdict.agentStarted).toBe(false);
    expect(verdict.workerReady).toBe(false);
    expect(verdict.note).toMatch(/QUOTA BLOCKED/);
    expect(verdict.note).toContain('su-launched since 2026-09-06T20:11:00.000Z');
    expect(verdict.note).toMatch(/presence is not productive liveness/);
  });

  it('does not reclassify a session that already took a real turn when quota blocks later', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([
        session({
          successfulCalls: 2,
          hasPresence: true,
          quotaBlocked: true,
          quotaBlockedSinceMs: Date.parse('2026-09-06T20:11:00.000Z'),
        }),
      ]),
    });

    expect(verdict.agentStarted).toBe(true);
    expect(verdict.note).toMatch(/verified running/);
    expect(verdict.note).not.toMatch(/QUOTA BLOCKED/);
  });

  it('fails closed when the exact pinned owner reports a requested-vs-actual attestation mismatch', async () => {
    const verdict = await verifyFreshLaunchStarted(
      { ...ARGS, expectedOwnerIds: ['su-launched'] },
      {
        ...FAST,
        probe: fixedProbe([
          session({
            successfulCalls: 1,
            attestationDiffs: [{ field: 'model', requested: 'gpt-5.5:high', actual: 'gpt-5.4:low' }],
          }),
        ]),
      },
    );
    expect(verdict.agentStarted).toBe(false);
    expect(verdict.note).toMatch(/ATTESTATION MISMATCH/);
  });

  it('requires every exact pinned owner — an unrelated fresh session cannot satisfy the cohort', async () => {
    const verdict = await verifyFreshLaunchStarted(
      { ...ARGS, expectedOwnerIds: ['su-wanted'] },
      { ...FAST, probe: fixedProbe([session({ ownerId: 'su-other', successfulCalls: 1 })]) },
    );
    expect(verdict.agentStarted).not.toBe(true);
  });

  it('returns NULL (unverified) for a slow starter still signalling — NOT false', async () => {
    // THE CASE THAT KILLED THE ORIGINAL DESIGN. First real tool call is p50 ~31s,
    // so at any bounded timeout the majority of HEALTHY launches look like this.
    // Reporting false here would make the check a false-alarm generator — the same
    // defect it exists to prevent, with the sign flipped.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ successfulCalls: 0, hasPresence: false, msSinceLastSignal: 800 })]),
    });
    expect(verdict.agentStarted).toBeNull();
    expect(verdict.note).toMatch(/UNVERIFIED/);
    expect(verdict.note, 'an unverified verdict must say the wait is normal, not imply failure').toMatch(
      /NORMAL|not a failure/i,
    );
  });

  it('the silence threshold is what separates the two — either side of it flips the verdict', async () => {
    const stillBeating = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS - 1 })]),
    });
    const goneSilent = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS + 1 })]),
    });
    expect(stillBeating.agentStarted).toBeNull();
    expect(goneSilent.agentStarted).toBe(false);
  });

  it('does not condemn a slow headless first turn while its live process is still growing the log (EI-20823593041668393)', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS + 1 })]),
      probeProcessEvidence: () => [{ pidAlive: true, logGrowing: true }],
    });
    expect(verdict.agentStarted).toBeNull();
    expect(verdict.note).toMatch(/growing log/);
    expect(verdict.note).toMatch(/Do NOT relaunch/);
    expect(verdict.note).not.toMatch(/DID NOT START/);
  });

  it('still condemns a silent session when a surviving shell has stopped writing', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS + 1 })]),
      probeProcessEvidence: () => [{ pidAlive: true, logGrowing: false }],
    });
    expect(verdict.agentStarted).toBe(false);
    expect(verdict.note).toMatch(/DID NOT START/);
  });

  it('a session that never signalled at all is UNVERIFIED, not failed', async () => {
    // msSinceLastSignal === null means we have no observation, which is not the
    // same as an observation of silence. Treating "no data" as "dead" is how a
    // slow-to-report launch gets falsely condemned.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: null })]),
    });
    expect(verdict.agentStarted).toBeNull();
  });

  it('does NOT condemn the batch when only SOME members are silent', async () => {
    const verdict = await verifyFreshLaunchStarted(
      { ...ARGS, expected: 2 },
      {
        ...FAST,
        probe: fixedProbe([
          session({ advSessionId: 1, msSinceLastSignal: 60_000 }),
          session({ advSessionId: 2, msSinceLastSignal: 500 }),
        ]),
      },
    );
    expect(verdict.agentStarted).toBeNull();
  });

  it('a probe fault THROWS rather than reading as "nothing registered"', async () => {
    // Returning [] from a broken probe would render a healthy launch as
    // agentStarted:false on the strength of an error in our own instrument.
    await expect(
      verifyFreshLaunchStarted(ARGS, {
        ...FAST,
        probe: async () => {
          throw new Error('pg down');
        },
      }),
    ).rejects.toThrow(/pg down/);
  });
});

describe('fresh-launch worker attestation — productive capacity is four distinct facts', () => {
  const evidence = (over: Partial<Parameters<typeof deriveFreshLaunchWorkerAttestation>[0]> = {}) => ({
    ownerId: 'su-worker',
    successfulCalls: 2,
    wakeSource: 'loop',
    schedulerCalls: 1,
    successfulSchedulerCalls: 1,
    schedulerDisposition: { kind: 'claimed', workItemId: 'WI-metadata-only' },
    claimedWorkItemId: 'WI-42407',
    ...over,
  });

  type EvidenceOverride = Partial<Parameters<typeof deriveFreshLaunchWorkerAttestation>[0]>;
  const contracts: Array<{
    scenario: string; repaired: EvidenceOverride; contaminated: EvidenceOverride;
    expected: Record<string, unknown>;
  }> = [
    { scenario: 'claimed', repaired: {}, contaminated: { claimedWorkItemId: null, schedulerDisposition: null },
      expected: { ready: true, stages: { disposition: { status: 'satisfied', kind: 'claimed', workItemId: 'WI-42407' } } } },
    { scenario: 'healthy-no-claim',
      repaired: { claimedWorkItemId: null, schedulerDisposition: { kind: 'no-claim', reason: 'fleet_lane_drained' } },
      contaminated: { claimedWorkItemId: null, schedulerDisposition: null },
      expected: { ready: true, stages: { disposition: { status: 'satisfied', kind: 'no-claim', reason: 'fleet_lane_drained' } } } },
    { scenario: 'missing-custody', repaired: { claimedWorkItemId: null, schedulerDisposition: null }, contaminated: {},
      expected: { ready: false, stages: { disposition: { status: 'missing', kind: 'missing' } } } },
    { scenario: 'presence-only', repaired: { successfulCalls: 0 }, contaminated: {},
      expected: { ready: false, stages: { agentCall: { status: 'missing' } } } },
    { scenario: 'real-agent-call', repaired: {}, contaminated: { successfulCalls: 0 },
      expected: { ready: true, stages: { agentCall: { status: 'satisfied' } } } },
    { scenario: 'scheduler-not-called', repaired: { schedulerCalls: 0, successfulSchedulerCalls: 0 }, contaminated: {},
      expected: { ready: false, stages: { schedulerPull: { status: 'missing' } } } },
    { scenario: 'scheduler-refused', repaired: { successfulSchedulerCalls: 0 }, contaminated: {},
      expected: { ready: false, stages: { schedulerPull: { status: 'failed' } } } },
    { scenario: 'durable-wake', repaired: {}, contaminated: { wakeSource: 'owner' },
      expected: { ready: true, stages: { durableWake: { status: 'satisfied' } } } },
    { scenario: 'missing-wake', repaired: { wakeSource: 'owner' }, contaminated: {},
      expected: { ready: false, stages: { durableWake: { status: 'missing' } } } },
  ];
  for (const contract of contracts) {
    it.each(['repaired', 'outer control'])(`worker evidence causal contract: ${contract.scenario}: %s`, mode => {
      // A wrong probe adapter removes real custody or fabricates a missing
      // call/pull/wake. The actual public classifier must produce a result that
      // fails the same literal oracle used for the correctly sourced evidence.
      const input = mode === 'outer control' ? contract.contaminated : contract.repaired;
      const result = deriveFreshLaunchWorkerAttestation(evidence(input));
      const assertContract = () => expect(result).toMatchObject(contract.expected);
      if (mode === 'outer control') expect(assertContract).toThrow();
      else assertContract();
    });
  }

  for (const scenario of ['slow-signalling', 'observed-silence']) {
    it.each(['repaired', 'outer control'])(`launch clock causal contract: ${scenario}: %s`, async mode => {
      const silent = scenario === 'observed-silence';
      const observedSilent = mode === 'outer control' ? !silent : silent;
      const result = await verifyFreshLaunchStarted(ARGS, {
        ...FAST,
        probe: fixedProbe([session({ msSinceLastSignal: observedSilent ? 60_000 : 0 })]),
      });
      const assertContract = () => expect(result.agentStarted).toBe(silent ? false : null);
      if (mode === 'outer control') expect(assertContract).toThrow();
      else assertContract();
    });
  }

  it('is ready when a real call, durable wake, scheduler pull, and canonical claim all exist', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence());
    expect(attestation.ready).toBe(true);
    expect(attestation.failures).toEqual([]);
    expect(attestation.stages.disposition).toEqual({
      status: 'satisfied',
      kind: 'claimed',
      workItemId: 'WI-42407',
    });
  });

  it('accepts a structured healthy no-claim diagnosis as an accountable disposition', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence({
      wakeSource: 'event',
      schedulerDisposition: { kind: 'no-claim', reason: 'fleet_lane_drained' },
      claimedWorkItemId: null,
    }));
    expect(attestation.ready).toBe(true);
    expect(attestation.stages.durableWake).toMatchObject({ status: 'satisfied', wakeSource: 'event' });
    expect(attestation.stages.disposition).toEqual({
      status: 'satisfied',
      kind: 'no-claim',
      reason: 'fleet_lane_drained',
    });
  });

  it('keeps missing custody unready when the call, scheduler, and wake all succeed', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence({
      schedulerDisposition: null,
      claimedWorkItemId: null,
    }));
    expect(attestation.stages.agentCall.status).toBe('satisfied');
    expect(attestation.stages.schedulerPull.status).toBe('satisfied');
    expect(attestation.stages.durableWake.status).toBe('satisfied');
    expect(attestation.stages.disposition).toEqual({ status: 'missing', kind: 'missing' });
    expect(attestation.ready).toBe(false);
    expect(attestation.failures.map((failure) => failure.code)).toEqual(['disposition-missing']);
  });

  it('reports a tool-dark boot without letting presence or configuration substitute for work', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence({
      successfulCalls: 0,
      schedulerCalls: 0,
      successfulSchedulerCalls: 0,
      schedulerDisposition: null,
      claimedWorkItemId: null,
    }));
    expect(attestation.ready).toBe(false);
    expect(attestation.failures.map((failure) => failure.code)).toEqual([
      'agent-call-missing',
      'scheduler-pull-missing',
      'disposition-missing',
    ]);
  });

  it('keeps a no-wake worker unready even when every other stage is satisfied', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence({ wakeSource: 'owner' }));
    expect(attestation.ready).toBe(false);
    expect(attestation.failures).toEqual([
      expect.objectContaining({ stage: 'durableWake', code: 'durable-wake-missing' }),
    ]);
  });

  it('distinguishes a scheduler refusal from a scheduler that was never called', () => {
    const attestation = deriveFreshLaunchWorkerAttestation(evidence({
      schedulerCalls: 1,
      successfulSchedulerCalls: 0,
      schedulerDisposition: null,
      claimedWorkItemId: null,
    }));
    expect(attestation.stages.schedulerPull.status).toBe('failed');
    expect(attestation.failures.map((failure) => failure.code)).toContain('scheduler-pull-failed');
    expect(attestation.failures.map((failure) => failure.code)).toContain('disposition-missing');
  });

  it('surfaces a fully-ready session without redefining agentStarted', async () => {
    const workerAttestation = deriveFreshLaunchWorkerAttestation(evidence());
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ successfulCalls: 2, workerAttestation })]),
    });
    expect(verdict).toMatchObject({ agentStarted: true, workerReady: true });
  });

  it('keeps a spawn-only result unknown instead of reporting a registered or working agent', () => {
    const summary = deriveFreshLaunchEvidenceSummary({
      opened: 1,
      firstTurn: null,
      workerAttestations: [],
    });

    expect(summary).toEqual({
      version: 1,
      processOpened: 1,
      sessionRegistered: null,
      firstTurn: null,
      taskDisposition: { claimed: 0, noClaim: 0, unknown: 1 },
    });
    expect(formatFreshLaunchEvidenceSummary(summary)).toContain(
      'Process open alone is not proof that an agent is working.',
    );
  });

  it('names an aggregate disposition only when every opened process has the same satisfied evidence', () => {
    const claimed = deriveFreshLaunchWorkerAttestation(evidence());
    const noClaim = deriveFreshLaunchWorkerAttestation(evidence({
      ownerId: 'su-no-claim',
      schedulerDisposition: { kind: 'no-claim', reason: 'fleet_lane_drained' },
      claimedWorkItemId: null,
    }));

    expect(deriveFreshLaunchEvidenceSummary({
      opened: 1,
      firstTurn: true,
      workerAttestations: [claimed],
    })).toMatchObject({
      sessionRegistered: 1,
      firstTurn: true,
      taskDisposition: { claimed: 1, noClaim: 0, unknown: 0 },
    });
    expect(deriveFreshLaunchEvidenceSummary({
      opened: 2,
      firstTurn: true,
      workerAttestations: [claimed, noClaim],
    })).toMatchObject({
      sessionRegistered: 2,
      firstTurn: true,
      taskDisposition: { claimed: 1, noClaim: 1, unknown: 0 },
    });
  });
});

describe('LAUNCH_STATUSLINE_TOOLS — the names that are NOT the agent taking a turn', () => {
  it('lists the two statusline calls a DEAD launch also emits', () => {
    // Measured: 14842 (dead) fired exactly these two and nothing else. If a future
    // edit drops one, a dead session's remaining beat counts as "real work" and
    // every dud silently reports as started.
    expect(LAUNCH_STATUSLINE_TOOLS).toContain('activity:report');
    expect(LAUNCH_STATUSLINE_TOOLS).toContain('coord:glance');
  });
});

// ── P-004: the wrong-door guard ─────────────────────────────────────────────
describe('classifyAgentLaunchCommand (P-004)', () => {
  it.each([
    ['psu --no-picker --agent=omp --harness=papercusp', 'fresh'],
    ['psu --agent=claude', 'fresh'],
    ['cd /repo && psu --agent=codex --no-plan', 'fresh'],
    ['psu --resume=abc-123', 'resume'],
    ['psu --fork=abc-123', 'resume'],
  ])('%s ⇒ an agent launch (%s)', (command, mode) => {
    const cls = classifyAgentLaunchCommand(command);
    expect(cls.isAgentLaunch).toBe(true);
    expect(cls.mode).toBe(mode);
  });

  it.each([
    // A guard that over-refuses teaches agents to route around it, which is worse
    // than no guard — so every one of these must keep working.
    ['npm run dev'],
    ['psu --help'],
    ['psu --version'],
    ['psu-sentinel --check'],
    ['echo psuedo'],
    ['./scripts/psustats.sh'],
    ['git log --oneline -5'],
  ])('%s ⇒ NOT an agent launch', (command) => {
    expect(classifyAgentLaunchCommand(command).isAgentLaunch).toBe(false);
  });

  it('tolerates an empty/absent command', () => {
    expect(classifyAgentLaunchCommand('').isAgentLaunch).toBe(false);
  });
});
