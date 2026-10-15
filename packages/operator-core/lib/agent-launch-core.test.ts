import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchCoreSql = vi.hoisted(() =>
  vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]),
);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: launchCoreSql }),
}));

import {
  AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS,
  AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS,
  MEMBER_BASELINE_RULES,
  buildAgentLaunchCommand,
  claimAgentLaunch,
  recordAgentLaunchResult,
  composeMemberLaunchContext,
  composeModelSpec,
  defaultLaunchAccountFor,
  foldMemberSpec,
  injectAccountArg,
  injectKickoffAfterResume,
  memberLaunchCommand,
  normalizeLaunchMode,
  nativeSessionIdFromHost,
  probeFreshLaunchSessions,
  resolvedNativeSessionId,
  isStaleHeadlessAgentHost,
  restoreVisibleMayShutdown,
  resolveResumeTarget,
  verifyResumeStarted,
  waitForPtyHostGone,
  type FleetMemberDefaults,
} from './agent-launch-core';
import { CODEX_SAFE_DEFAULT_MODEL } from './model-context-budget.mjs';
import type { AdvSessionRow } from './adv-sessions';
import type { SessionPortRow } from './session-port/store';
import type { PsuPtyHost } from './events/await/psu-pty-discovery';

const OWNER = 'su-b0fbfa98-0594-4a46-909f-3ca16622101d';

function ptyHostFixture(over: Partial<PsuPtyHost> = {}): PsuPtyHost {
  return { ownerId: OWNER, advSessionId: null, pid: 42, ptyPid: 43,
    sock: `/run/psu-pty/${OWNER}.sock`, command: 'codex', startedAt: 0, ...over };
}

describe('typed verifier launch modes', () => {
  it('accepts GRADE and TEST while refusing an unregistered mode', () => {
    expect(normalizeLaunchMode({ mode: 'grade' })?.mode).toBe('grade');
    expect(normalizeLaunchMode({ mode: 'test' })?.mode).toBe('test');
    expect(normalizeLaunchMode({ mode: 'goal' })).toBeNull();
  });
});

describe('GOAL allocation in every member brief (P-020)', () => {
  it('carries the holder width after a custom brief without replacing the fleet target', () => {
    const context = composeMemberLaunchContext({
      fleetSlug: 'alpha-fleet', plan: 'alpha', count: 3,
      customBriefText: 'Work P-001. The ceiling is 12.',
      goalAllocation: { goalId: 'goal-1', intendedParallelPlanFleets: 2 },
    });
    expect(context).toContain('one of 3 parallel worker agents');
    expect(context).toContain('intended concurrent plan fleets = 2; this fleet member target = 3');
    expect(context.indexOf('GOAL parallel allocation')).toBeGreaterThan(context.indexOf('Work P-001'));
    expect(context).toContain('ceilings, not targets to fill');
  });
});

// parked-agent-census-resumption-and-root-cause-2026-10-09 P-008: this rule used to say
// "loop:end … only when no claimable work remains or you are blocked", teaching a claim
// holder to stop on a blocker. A blocked holder records it and keeps a bounded wake instead.
describe('member baseline stay-alive rule (P-008)', () => {
  it('never teaches loop:end while blocked on a held item', () => {
    const rule = MEMBER_BASELINE_RULES.find((r) => r.head.startsWith('STAY ALIVE across turns'));
    expect(rule?.body).toBeDefined();
    expect(rule?.body).not.toContain('or you are blocked');
    expect(rule?.body).toContain('you hold no claims');
    expect(rule?.body).toContain('Blocked? `work_items:set_blocker` + bounded `events:await`, end the turn.');
    // The stop line comes AFTER the blocked recipe, and is scoped to a claimless session.
    expect(rule!.body.indexOf('Blocked?')).toBeLessThan(rule!.body.indexOf('`loop:end {'));
  });
});

describe('member baseline causal-evidence contract', () => {
  it('names every v2 field required by successful defect closes', () => {
    const completionRule = MEMBER_BASELINE_RULES.find((rule) => rule.head === 'Completion evidence is mandatory');
    expect(completionRule?.body).toContain('rootCauseVerification');
    for (const field of [
      'testProcedure',
      'predictedObservations:{hypothesis:',
      'alternativeHypothesis:',
      'actualObservation',
      'evidenceRefs',
    ]) expect(completionRule?.body).toContain(field);
    expect(completionRule?.body).toContain('The typed predictions must differ');
    expect(completionRule?.body).toContain('requires no prose template');
  });
});

beforeEach(() => {
  launchCoreSql.mockReset();
  launchCoreSql.mockResolvedValue([] as unknown[]);
});

describe('recordAgentLaunchResult durable completion evidence', () => {
  it('confirms the idempotency row was updated before reporting a durable receipt', async () => {
    launchCoreSql.mockResolvedValueOnce([{ idempotency_key: 'cached-launch' }]);

    const recorded = await recordAgentLaunchResult({
      workspaceId: 'ws-test',
      idempotencyKey: ' cached-launch ',
      summary: { opened: 2, failed: 0 },
    });

    expect(recorded).toBe(true);
    const [query, ...values] = launchCoreSql.mock.calls[0] ?? [];
    expect(String(query?.join(' '))).toContain('RETURNING idempotency_key');
    expect(values).toContain('cached-launch');
  });

  it('does not claim a durable receipt when the update matched no idempotency row', async () => {
    launchCoreSql.mockResolvedValueOnce([]);

    await expect(recordAgentLaunchResult({
      workspaceId: 'ws-test',
      idempotencyKey: 'missing-launch',
      summary: { opened: 1, failed: 0 },
    })).resolves.toBe(false);
  });

  it('does not claim a durable receipt when no idempotency key was supplied', async () => {
    await expect(recordAgentLaunchResult({
      workspaceId: 'ws-test',
      idempotencyKey: null,
      summary: { opened: 1, failed: 0 },
    })).resolves.toBe(false);
    expect(launchCoreSql).not.toHaveBeenCalled();
  });
});

describe('claimAgentLaunch crash recovery', () => {
  it('stores a caller-supplied replay identity atomically with the claim', async () => {
    const initialSummary = {
      requestKind: 'goals:start',
      requestFingerprint: 'fingerprint-1',
      phase: 'claimed',
    };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'goal-start:req-1' }]);

    const claim = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'goal-start:req-1',
      launchedBy: 'su-first',
      initialSummary,
      failClosed: true,
    });

    expect(claim.won).toBe(true);
    const insert = launchCoreSql.mock.calls[1];
    expect(String(insert?.[0]?.join(' '))).toContain('INSERT INTO harness_shared.agent_launch_idempotency');
    expect(insert?.slice(1)).toContain(JSON.stringify(initialSummary));
  });

  it('can fail closed when a caller requires a durable idempotency claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    launchCoreSql.mockRejectedValueOnce(new Error('ledger unavailable'));
    try {
      await expect(claimAgentLaunch({
        workspaceId: 'ws-test',
        idempotencyKey: 'goal-start:req-2',
        initialSummary: { requestKind: 'goals:start' },
        failClosed: true,
      })).rejects.toThrow('ledger unavailable');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('atomically lets an honest retry win after an empty in-progress claim outlives its lease', async () => {
    const firstNow = 1_800_000_000_000;
    const retryNow = firstNow + AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS + 1;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'crash-window' }])
      // Simulate the winning process disappearing before record/release. The
      // next call reaches the same UPSERT after the lease threshold.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'crash-window' }]);

    const first = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'crash-window',
      launchedBy: 'su-first',
      now: firstNow,
    });
    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'crash-window',
      launchedBy: 'su-retry',
      now: retryNow,
    });

    expect(first.won).toBe(true);
    expect(retry.won).toBe(true);
    const retryUpsert = launchCoreSql.mock.calls[3];
    const query = String(retryUpsert?.[0]?.join(' '));
    expect(query).toContain('ON CONFLICT (workspace_id, idempotency_key) DO UPDATE');
    expect(query).toContain("existing.summary = '{}'::jsonb");
    expect(retryUpsert?.slice(1)).toContain(retryNow - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS);
  });

  it('keeps a recent empty claim fail-closed so an ordinary retry cannot duplicate a launch', async () => {
    const now = 1_800_000_000_000;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ summary: {}, launched_at: now - 1_000, launched_by: 'su-first' }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'still-running',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry).toEqual({
      won: false,
      priorSummary: {},
      priorLaunchedAt: now - 1_000,
      priorLaunchedBy: 'su-first',
    });
  });

  it('never leases over a completed launch summary, even when the row is old', async () => {
    const now = 1_800_000_000_000;
    const summary = { opened: 1, mode: 'fresh' };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        summary,
        launched_at: now - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS - 1,
        launched_by: 'su-first',
      }]);

    const replay = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'completed-launch',
      launchedBy: 'su-retry',
      now,
    });

    expect(replay.won).toBe(false);
    expect(replay.priorSummary).toEqual(summary);
  });

  it('reclaims an old explicit agentStarted:null receipt with no recoverable task identity', async () => {
    const now = 1_800_000_000_000;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'stalled-launch' }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'stalled-launch',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry.won).toBe(true);
    const query = String(launchCoreSql.mock.calls[1]?.[0]?.join(' '));
    expect(query).toContain("existing.summary -> 'agentStarted' = 'null'::jsonb");
    expect(query).toContain("jsonb_typeof(existing.summary -> 'tasks') IS DISTINCT FROM 'array'");
    expect(query).toContain("jsonb_array_length(existing.summary -> 'tasks') = 0");
    expect(launchCoreSql.mock.calls[1]?.slice(1)).toContain(
      now - AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS,
    );
  });

  it('never leases over an old agentStarted:null receipt with a durable task identity', async () => {
    const now = 1_800_000_000_000;
    const summary = {
      opened: 1,
      agentStarted: null,
      mode: 'fresh',
      tasks: [{ taskId: 'task-still-recoverable', logPath: '/tmp/recoverable.log' }],
    };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        summary,
        launched_at: now - AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS - 1,
        launched_by: 'su-first',
      }]);

    const replay = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'recoverable-launch',
      launchedBy: 'su-retry',
      now,
    });

    expect(replay).toEqual({
      won: false,
      priorSummary: summary,
      priorLaunchedAt: now - AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS - 1,
      priorLaunchedBy: 'su-first',
    });
    const query = String(launchCoreSql.mock.calls[1]?.[0]?.join(' '));
    expect(query).toContain("jsonb_array_length(existing.summary -> 'tasks') = 0");
  });

  it('keeps a recent agentStarted:null receipt fail-closed', async () => {
    const now = 1_800_000_000_000;
    const summary = { opened: 1, agentStarted: null, mode: 'fresh' };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        summary,
        launched_at: now - 1_000,
        launched_by: 'su-first',
      }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'still-starting',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry).toEqual({
      won: false,
      priorSummary: summary,
      priorLaunchedAt: now - 1_000,
      priorLaunchedBy: 'su-first',
    });
  });
});

describe('injectAccountArg (P-012: a scripted psu launch must never sit on the account picker)', () => {
  it('injects --account=default into a psu command that lacks one', () => {
    const r = injectAccountArg('psu --no-picker --resume=abc', 'default');
    expect(r.injected).toBe(true);
    expect(r.command).toBe('psu --account=default --no-picker --resume=abc');
  });

  it('honors an explicit account', () => {
    const r = injectAccountArg('psu --resume=abc', 'pool-2');
    expect(r.command).toBe('psu --account=pool-2 --resume=abc');
  });

  it('leaves a command that already pins an account alone (=, space, and bare forms)', () => {
    for (const cmd of ['psu --account=auto --resume=x', 'psu --account auto --resume=x']) {
      const r = injectAccountArg(cmd, 'default');
      expect(r.injected).toBe(false);
      expect(r.command).toBe(cmd);
    }
  });

  it('leaves non-psu commands alone', () => {
    const r = injectAccountArg('npm run dev', 'default');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('npm run dev');
  });

  it('matches psu after a shell separator, not inside another word', () => {
    expect(injectAccountArg('cd /repo && psu --resume=x', 'default').command).toBe(
      'cd /repo && psu --account=default --resume=x',
    );
    expect(injectAccountArg('mypsu --resume=x', 'default').injected).toBe(false);
  });

  it('refuses a non-identity-shaped account (shell-injection guard)', () => {
    const r = injectAccountArg('psu --resume=x', 'a; rm -rf /');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --resume=x');
  });
});

describe('buildAgentLaunchCommand', () => {
  it('composes a fresh ad-hoc launch: no-picker + account-pinned', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude' })).toBe(
      'psu --no-picker --account=default --agent=claude',
    );
  });

  // Caught by the P-016 live-verify, NOT by the unit tests above — every one of them
  // passed `agent` explicitly, so the omitted-agent path never ran. psu rejects it at
  // boot (`--agent must be one of claude|omp|codex (got null)`) and the agent dies on a
  // dead prompt. A fresh launch must ALWAYS carry an agent.
  it('defaults the agent on a fresh launch — psu hard-fails without --agent', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh' })).toContain('--agent=claude');
    expect(buildAgentLaunchCommand({ mode: 'fresh', plan: 'p' })).toContain('--agent=claude');
  });

  it('does NOT pass --agent on a resume/fork (the recorded session already carries the kind)', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1' })).not.toContain('--agent');
    expect(buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1' })).not.toContain('--agent');
    // ...and `agent` alone still does not: on a resume it names the RECORDED
    // backend (launch-agent/revive-responder both pass it that way, to reach
    // Codex's model policy), never a conversion request. Only `targetAgent`
    // asks for a different backend — see the R-12 block below.
    expect(
      buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1', agent: 'codex' }),
    ).not.toContain('--agent');
  });

  // R-12 / R-14 (consult-expert-routing-2026-09-22, D-005). MEASURED defect, not a
  // hypothesis: with `--agent` unconditionally omitted here, psu recovers the backend
  // from the MODEL NAME alone (`parseArgs`: `if (!out.agent && hintedBackend) out.agent
  // = hintedBackend`), and `cloudModelBackendHint` returns null for an OMP target (its
  // vocabulary is deliberately open-set), for any unrecognized model id, and for a
  // conversion that names no model at all. `resolveResumeTarget` then falls through to
  // `sourceAgent`, so 3 of 4 cross-backend resume requests composed here resolved to
  // `operation:'native'` on the SOURCE backend — the caller's conversion silently
  // became a same-backend resume, with no error on any path. The round-trip through
  // psu's own resolver is pinned in apps/operator/lib/psu-launcher.test.ts; these
  // assertions pin the half operator-core owns.
  describe('cross-backend resume (R-12: the core must be able to SAY "resume onto a different backend")', () => {
    it('emits --agent for the TARGET backend when one is named', () => {
      expect(
        buildAgentLaunchCommand({ mode: 'resume', resumeId: '42', agent: 'claude', targetAgent: 'omp' }),
      ).toBe('psu --no-picker --account=default --resume=42 --agent=omp');
    });

    it('emits it for a model-less conversion too — the case the model hint can never rescue', () => {
      const cmd = buildAgentLaunchCommand({ mode: 'resume', resumeId: '42', agent: 'claude', targetAgent: 'omp' });
      expect(cmd).toContain('--agent=omp');
      expect(cmd).not.toContain('--model=');
    });

    // A conversion TO Codex is the one target that cannot be model-less: there is
    // no recorded Codex session to inherit from, and a --no-picker launch must
    // never fall back to the CLI/cache default. This assertion exists because the
    // first draft of the test above asserted the opposite for codex and composed a
    // command psu throws on at parse time ("Codex model is required") — a defect
    // that was unreachable while the conversion was still silently degrading to
    // the source backend. The refusal now comes from the core, with the policy
    // resolver's own message naming the way out.
    it('refuses a model-less conversion to Codex rather than composing one psu rejects at boot', () => {
      expect(() =>
        buildAgentLaunchCommand({ mode: 'resume', resumeId: '42', agent: 'claude', targetAgent: 'codex' }),
      ).toThrow(/Codex model is required/i);
      // Deliberately selecting the configured default is the sanctioned way through.
      expect(
        buildAgentLaunchCommand({
          mode: 'resume',
          resumeId: '42',
          agent: 'claude',
          targetAgent: 'codex',
          modelSource: 'configured-default',
        }),
      ).toContain('--model-source=configured-default');
    });

    it('applies the TARGET backend model policy, not the recorded one', () => {
      // Recorded claude, converting to codex: Codex's "never rely on the CLI/cache
      // default" rule is the target's rule, so --model-source must ride along.
      expect(
        buildAgentLaunchCommand({
          mode: 'resume',
          resumeId: '42',
          agent: 'claude',
          targetAgent: 'codex',
          model: 'gpt-5.6-sol:xhigh',
        }),
      ).toBe(
        'psu --no-picker --account=default --resume=42 --agent=codex --model=gpt-5.6-sol:xhigh --model-source=explicit',
      );
    });

    it('refuses a cross-backend FORK — psu has no such operation, so composing one is composing a command that cannot run', () => {
      expect(() =>
        buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1', agent: 'claude', targetAgent: 'codex' }),
      ).toThrow(/fork is a native same-backend operation/i);
      // Same backend named explicitly is a fork, not a conversion — allowed.
      expect(
        buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1', agent: 'claude', targetAgent: 'claude' }),
      ).toContain('--fork');
    });

    it('refuses an unknown target backend in the core rather than emitting an unlaunchable command', () => {
      expect(() =>
        buildAgentLaunchCommand({ mode: 'resume', resumeId: '42', targetAgent: 'gemini' }),
      ).toThrow(/targetAgent/);
    });

    it('is resume/fork-only — a fresh launch names its backend with `agent`', () => {
      expect(() =>
        buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', targetAgent: 'codex' }),
      ).toThrow(/targetAgent/);
    });

    it('pre-pins an explicitly isolated same-backend port while ordinary native resume stays protected', () => {
      expect(buildAgentLaunchCommand({
        mode: 'resume', agent: 'codex', targetAgent: 'codex', resumeId: '42', model: 'sol', ownerId: 'su-answer-owner',
      })).toContain('--owner-id=su-answer-owner');
      expect(() => buildAgentLaunchCommand({
        mode: 'resume', agent: 'codex', resumeId: '42', model: 'sol', ownerId: 'su-answer-owner',
      })).toThrow(/same-backend resume/);
    });
  });

  it('composes a plan launch', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', plan: 'my-plan' })).toBe(
      'psu --no-picker --account=default --agent=claude --plan=my-plan',
    );
  });

  it('composes a resume and a fork of the same session', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1' })).toBe(
      'psu --no-picker --account=default --resume=sid-1',
    );
    expect(buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1' })).toBe(
      'psu --no-picker --account=default --resume=sid-1 --fork',
    );
  });

  it('emits the configured Codex default when a model-less resume names that authority', () => {
    expect(
      buildAgentLaunchCommand({
        mode: 'resume',
        resumeId: '22661',
        agent: 'codex',
        modelSource: 'configured-default',
      }),
    ).toBe(
      `psu --no-picker --account=default --resume=22661 --model=${CODEX_SAFE_DEFAULT_MODEL} --model-source=configured-default`,
    );
  });

  it('honors an explicit account', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1', account: 'auto' })).toContain(
      '--account=auto',
    );
  });

  it('requires a sessionId in resume/fork mode', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'resume' })).toThrow(/requires sessionId/);
    expect(() => buildAgentLaunchCommand({ mode: 'fork' })).toThrow(/requires sessionId/);
  });

  it('accepts a tracked resume selector when native sessionId is unavailable', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', resumeId: '22661' })).toContain('--resume=22661');
  });

  it('adds --headless (which is what keeps a windowless agent injectable at all)', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', headless: true })).toContain('--headless');
  });

  it('fails closed when a scripted Codex launch has no model authority', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', agent: 'codex' })).toThrow(
      /Codex model is required/,
    );
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', agent: 'codex', headless: true })).toThrow(
      /Codex model is required/,
    );
    expect(
      buildAgentLaunchCommand({
        mode: 'fresh',
        agent: 'codex',
        modelSource: 'configured-default',
      }),
    ).toContain(`--model=${CODEX_SAFE_DEFAULT_MODEL} --model-source=configured-default`);
  });

  it('binds a plan to its harness', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', plan: 'my-plan', harness: 'papercusp' })).toContain(
      '--harness=papercusp --plan=my-plan',
    );
  });

  it('defaults every platform to the system account; auto requires an explicit selection', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', platform: 'darwin' })).toContain(
      '--account=default',
    );
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', platform: 'linux' })).toContain(
      '--account=default',
    );
  });

  it('refuses shell metacharacters in ANY value, not just extraArgs', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'resume', sessionId: 'x; rm -rf /' })).toThrow(
      /sessionId with shell metacharacters/,
    );
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', plan: '$(whoami)' })).toThrow(
      /plan with shell metacharacters/,
    );
  });

  it('shell-quotes extraArgs so structured JSON reaches psu as one argv value', () => {
    expect(
      buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', extraArgs: ['--model=opus', '--brain'] }),
    ).toBe('psu --no-picker --account=default --agent=claude --model=opus --brain');

    const offenderList = JSON.stringify({
      files: [
        {
          scope: 'superproject',
          file: 'apps/operator-docs/src/content/docs/example.mdx',
          detector: 'mdx',
          error: "unexpected ';' and $(touch /tmp/pwned)",
        },
      ],
    });
    const command = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      extraArgs: ['--git-sync-content-error', offenderList],
    });

    expect(command).toContain('--git-sync-content-error');
    // The command runs in a shell greeting. Replacing psu with printf verifies
    // that shell metacharacters remain literal and the JSON survives as one
    // argument, rather than becoming command syntax.
    const output = execFileSync(
      'bash',
      ['-lc', command.replace(/^psu /, "printf '%s\\n' ")],
      { encoding: 'utf8' },
    );
    expect(output.trimEnd().split('\n').at(-1)).toBe(offenderList);
  });

  // P-002: the per-member launch fields the general door now composes (so a
  // capability:launch-agent `members[i]` can differ in model/effort/context/limit/…).
  it('folds effort into the model spec (psu has no --effort flag)', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', model: 'opus', effort: 'high' });
    expect(cmd).toContain('--model=opus:high');
    expect(cmd).not.toContain('--effort');
  });

  it('quotes a model spec carrying characters outside the bare set (e.g. opus[1m])', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', model: 'opus[1m]', effort: 'high' });
    expect(cmd).toContain("--model='opus[1m]:high'");
  });

  it('refuses effort with no model — psu would silently drop it', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', effort: 'high' })).toThrow(
      /needs a model/,
    );
  });

  it('emits the full per-member launch flags (context/limit/role/feature/profile/brain/subagents/add-dir/launch-context)', () => {
    const cmd = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      contextSize: 'trimmed',
      compactionLimit: 200_000,
      role: 'reviewer',
      feature: 'F-12',
      profile: 'lean',
      brain: true,
      allowSubagents: true,
      addDir: ['/tmp/a'],
      launchContext: '/tmp/brief one.md',
    });
    expect(cmd).toContain('--context-size=trimmed');
    expect(cmd).toContain('--compaction-limit=200000');
    expect(cmd).toContain('--role=reviewer');
    expect(cmd).toContain('--feature=F-12');
    expect(cmd).toContain('--profile=lean');
    expect(cmd).toContain('--brain');
    expect(cmd).toContain('--allow-subagents');
    expect(cmd).toContain('--add-dir=/tmp/a');
    // A path with a space is shell-quoted, not rejected.
    expect(cmd).toContain("--launch-context='/tmp/brief one.md'");
  });

  it('omits the new optional flags entirely when unset (no flag, not a zero/false)', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude' });
    expect(cmd).toBe('psu --no-picker --account=default --agent=claude');
    for (const flag of ['--compaction-limit', '--context-size', '--role', '--stack', '--feature', '--profile', '--brain', '--allow-subagents', '--add-dir', '--launch-context']) {
      expect(cmd).not.toContain(flag);
    }
  });
});

describe('foldMemberSpec (P-002: member field wins; unset falls through, never zeroes)', () => {
  const base: FleetMemberDefaults = {
    agent: 'claude',
    account: 'default',
    model: 'sonnet',
    headless: true,
    contextSize: 'trimmed',
  };

  it('returns a copy of the base when no member spec is given', () => {
    expect(foldMemberSpec(base, undefined)).toEqual(base);
    expect(foldMemberSpec(base, undefined)).not.toBe(base);
  });

  it('a set member field overrides the fleet default for that member only', () => {
    const folded = foldMemberSpec(
      { ...base, stack: ['domain:base-domain'] },
      { model: 'opus', effort: 'high', account: 'pool-2', stack: ['domain:review-domain'] },
    );
    expect(folded.model).toBe('opus');
    expect(folded.effort).toBe('high');
    expect(folded.account).toBe('pool-2');
    expect(folded.stack).toEqual(['domain:review-domain']);
  });

  it('an UNSET member field falls through to the fleet default (never a zeroing override)', () => {
    const folded = foldMemberSpec(base, { role: 'reviewer' });
    // role came from the member; everything else inherits the base.
    expect(folded.role).toBe('reviewer');
    expect(folded.model).toBe('sonnet');
    expect(folded.account).toBe('default');
    expect(folded.headless).toBe(true);
    expect(folded.contextSize).toBe('trimmed');
    expect(folded.agent).toBe('claude');
  });

  it('an unset member agent inherits the fleet agent, never clears it', () => {
    expect(foldMemberSpec(base, { model: 'opus' }).agent).toBe('claude');
  });
});

describe('memberLaunchCommand', () => {
  it('builds the fleet auto-kickoff command with quoted free-form values', () => {
    expect(
      memberLaunchCommand({
        fleetSlug: 'ops',
        agent: 'claude',
        harness: 'papercusp',
        plan: 'my-plan',
        account: 'auto',
        launchContext: '/tmp/brief one.md',
        extraArgs: ['--add-dir=/tmp/work tree'],
      }),
    ).toBe(
      "psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan --account=auto --launch-context='/tmp/brief one.md' '--add-dir=/tmp/work tree'",
    );
  });

  it('WI-10004449: a spawned leader declares --fleet-role=leader; a member argv is unchanged', () => {
    const base = { fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' };
    expect(memberLaunchCommand({ ...base, fleetRole: 'leader' })).toBe(
      'psu --no-picker --fleet=ops --fleet-role=leader --agent=claude --harness=papercusp --plan=my-plan',
    );
    expect(memberLaunchCommand(base)).not.toContain('--fleet-role');
  });

  it('rejects shell metacharacters in fleet identity values', () => {
    expect(() =>
      memberLaunchCommand({ fleetSlug: 'ops; touch /tmp/pwned', agent: 'claude', harness: 'h', plan: 'p' }),
    ).toThrow(/fleet with shell metacharacters/);
  });

  // D-001: psu has NO --effort flag, and warn-and-drops unknown flags — so an
  // effort emitted separately is a SILENT no-op. It must ride the model spec.
  it('folds effort into the model spec instead of emitting a --effort psu never reads', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      model: 'opus[1m]',
      effort: 'high',
    });
    // `[1m]` is outside quoteLaunchValue's bare-token set, so the composed spec is quoted.
    expect(cmd).toContain("--model='opus[1m]:high'");
    expect(cmd).not.toContain('--effort');
  });

  it('fails closed when a no-picker Codex member has no model authority', () => {
    const base = { fleetSlug: 'ops', agent: 'codex' as const, harness: 'h', plan: 'p' };
    expect(() => memberLaunchCommand(base)).toThrow(/Codex model is required/);
    expect(() => memberLaunchCommand({ ...base, headless: true })).toThrow(/Codex model is required/);
    expect(memberLaunchCommand({ ...base, modelSource: 'configured-default' })).toContain(
      `--model=${CODEX_SAFE_DEFAULT_MODEL} --model-source=configured-default`,
    );
  });

  // P-005: the flag psu now parses + records onto launch_argv, which the compaction
  // watchdog reads back. Emitting it is what makes MemberSpec.compactionLimit real.
  it('emits --compaction-limit so the per-member limit reaches the seeding pass', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      compactionLimit: 200_000,
    });
    expect(cmd).toContain('--compaction-limit=200000');
  });

  it('omits --compaction-limit entirely when unset (no flag, not a zero)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'h', plan: 'p' });
    expect(cmd).not.toContain('--compaction-limit');
  });

  it('emits every stack binding as a repeatable --stack flag', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      stack: ['domain:papercusp-engineer', 'practice:careful-review'],
    });
    expect(cmd.split(' ')).toEqual(
      expect.arrayContaining(['--stack=domain:papercusp-engineer', '--stack=practice:careful-review']),
    );
  });

  // goal-mode-hardening P-009 / D-013: fleet:launch-on-plan { leader:'spawn' } must write
  // the fleet row naming its leader BEFORE that leader exists, so the leader's coord
  // identity is minted by the caller and pinned onto the launch. Without this flag reaching
  // psu, the pre-pin silently does nothing: the spawned agent mints its OWN id at boot, the
  // fleet row points at an identity that never appears, and the fleet is permanently
  // leaderless while every write involved reported success.
  it('emits --owner-id so a pre-pinned coord identity actually reaches the launched agent', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      ownerId: 'su-11111111-2222-3333-4444-555555555555',
    });
    expect(cmd).toContain('--owner-id=su-11111111-2222-3333-4444-555555555555');
  });

  // The slot matters, not just the presence: buildAgentLaunchCommand emits --owner-id in
  // exactly this position (after --agent, before --harness) and its doc states the reason —
  // a GUI launch and a tool launch stay argv-comparable, which is what lets the two be
  // diffed when one of them misbehaves. A drifting slot silently costs that property.
  it('emits --owner-id in the same argv slot buildAgentLaunchCommand uses (after --agent, before --harness)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      ownerId: 'su-abc',
    });
    expect(cmd.indexOf('--agent=')).toBeLessThan(cmd.indexOf('--owner-id='));
    expect(cmd.indexOf('--owner-id=')).toBeLessThan(cmd.indexOf('--harness='));
  });

  it('omits --owner-id entirely when unset (an ordinary member mints its own identity)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'h', plan: 'p' });
    expect(cmd).not.toContain('--owner-id');
  });

  // The composed command lands inside a terminal greeting one-liner, so an identity-shaped
  // value is VALIDATED rather than quoted — same treatment as fleet/agent/harness. A minted
  // ownerId can never contain metacharacters, so a value that does is a bug or an injection
  // and must be loud rather than shell-escaped into silent acceptance.
  it('refuses an ownerId carrying shell metacharacters instead of quoting it', () => {
    expect(() =>
      memberLaunchCommand({
        fleetSlug: 'ops',
        agent: 'claude',
        harness: 'h',
        plan: 'p',
        ownerId: 'su-abc; touch /tmp/pwned',
      }),
    ).toThrow(/refusing ownerId/);
  });

  // P-003: `plan` is optional — a pure claim-spec fleet launches with no plan, so the
  // member command omits --plan entirely (members self-pull via the fleet claim spec).
  it('omits --plan when no plan is given (pure claim-spec fleet)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp' });
    expect(cmd).not.toContain('--plan');
    expect(cmd).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp');
  });
});

describe('composeModelSpec (D-001: effort rides the model spec)', () => {
  it('passes the model through untouched when no effort is set', () => {
    expect(composeModelSpec('opus[1m]', undefined)).toBe('opus[1m]');
    expect(composeModelSpec(undefined, undefined)).toBeUndefined();
  });

  it('replaces an effort tail already on the spec (member effort must win)', () => {
    expect(composeModelSpec('opus[1m]:low', 'xhigh')).toBe('opus[1m]:xhigh');
  });

  it('leaves a non-effort colon segment alone (bedrock ids end in :0)', () => {
    expect(composeModelSpec('anthropic.claude-v2:0', 'high')).toBe('anthropic.claude-v2:0:high');
  });

  it('refuses an effort with no model — psu would drop it', () => {
    expect(() => composeModelSpec(undefined, 'high')).toThrow(/needs a model/);
  });

  it('refuses an unrecognized effort', () => {
    expect(() => composeModelSpec('opus[1m]', 'turbo')).toThrow(/unrecognized effort/);
  });
});

describe('resolveResumeTarget', () => {
  it.each([true, false])('retains recorded headless placement (%s)', async (headless) => {
    launchCoreSql.mockResolvedValue([{
      id: 22664, workspace_id: 'ws-test', coord_owner_id: OWNER, session_id: 'original-native',
      agent: 'codex', role: 'judge', cwd: '/repo', started_at: '2026-10-07T00:00:00.000Z',
      ended_at: '2026-10-07T00:01:00.000Z', ended_by: 'self',
      launch_argv: ['psu', '--account=auto', ...(headless ? ['--headless'] : [])],
    }] as unknown[]);
    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({ ok: true, headless });
  });

  it('resolves a tracked OMP thread-only row and keeps the raw session binding distinct', async () => {
    launchCoreSql.mockResolvedValue([{
      id: 22663, workspace_id: 'ws-omp', coord_owner_id: OWNER, session_id: null, omp_thread_id: 'omp-native-thread',
      agent: 'omp', cwd: '/repo', started_at: '2026-09-05T23:16:36.945Z',
      binding_started_at: '2026-09-05 23:16:36.945123+00', ended_at: null, ended_by: null,
    }] as unknown[]);
    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({
      ok: true, sessionId: 'omp-native-thread', ompThreadId: 'omp-native-thread', resumeId: 'omp-native-thread',
      binding: { coordOwnerId: OWNER, sessionId: null, ompThreadId: 'omp-native-thread' },
    });
  });

  it('rejects a ref with neither agentId nor sessionId (no DB round-trip)', async () => {
    const r = await resolveResumeTarget({});
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: 'not_found' });
  });

  it('returns the recorded source role and feature for identity-preserving recovery', async () => {
    launchCoreSql.mockResolvedValue([{
      id: 22664,
      workspace_id: 'ws-test',
      plan_slug: null,
      agent: 'claude',
      role: 'crm-agent',
      feature: 'WI-10007049',
      mode: 'console',
      terminal_bin: null,
      pid: null,
      window_id: null,
      omp_thread_id: null,
      label: null,
      cwd: '/repo',
      coord_owner_id: OWNER,
      session_id: 'source-session',
      started_at: '2026-10-07T00:00:00.000Z',
      binding_started_at: '2026-10-07 00:00:00.000123+00',
      ended_at: '2026-10-07T00:01:00.000Z',
      exit_code: 0,
      ended_by: 'self',
      launch_argv: ['psu', '--agent=claude'],
    }] as unknown[]);

    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({
      ok: true,
      role: 'crm-agent',
      feature: 'WI-10007049',
    });
  });

  it('uses session_turns only to recover the owner; an exact native UUID never rewinds to the owner row UUID', () => {
    expect(resolvedNativeSessionId('later-rollout-uuid', 'older-root-uuid')).toBe('later-rollout-uuid');
    expect(resolvedNativeSessionId('later-rollout-uuid', null)).toBe('later-rollout-uuid');
    expect(resolvedNativeSessionId(null, 'owner-latest-uuid')).toBe('owner-latest-uuid');

    const source = readFileSync(new URL('./agent-launch-core.ts', import.meta.url), 'utf8');
    expect(source).toContain('FROM harness_shared.session_turns t');
    expect(source).toContain('candidate_session_id');
    expect(source).toContain('t.ingested_at DESC');
    expect(source).toContain('coord_owner_id = (SELECT owner FROM indexed_owner)');
  });

  // WI-555403. A carry-respawn REWRITES the owner's adv_sessions row in place
  // (same row id, new session_id), so every EARLIER native session in the chain
  // has no adv_sessions row at all. Seeding the candidate CTE from adv_sessions
  // left indexed_owner NULL for exactly those sessions and they resolved as
  // not_found, even though session_turns still holds them under the same owner.
  const candidateFragmentOf = (calls: { 0?: TemplateStringsArray }[]): string | undefined =>
    calls.map((c) => String(c[0]?.join('?'))).find((q) => q.includes('candidate_session_id'));

  it('pins an exact native session as its own candidate, so an earlier session in a respawn chain still resolves', async () => {
    // The requested uuid is NOT in adv_sessions; the row that comes back is the
    // owner's CURRENT one, recovered via session_turns.
    launchCoreSql.mockResolvedValue([{
      id: 20807,
      workspace_id: 'ws-carry',
      coord_owner_id: OWNER,
      session_id: 'current-native-uuid',
      agent: 'claude',
      cwd: '/repo',
      started_at: '2026-08-29T00:04:31.000Z',
      binding_started_at: '2026-08-29 00:04:31.000123+00',
      ended_at: null,
      exit_code: null,
      ended_by: null,
    }] as unknown[]);

    const r = await resolveResumeTarget({ sessionId: 'earlier-native-uuid' });

    // The pin survives: we resume the transcript that was ASKED for, while the
    // owner/advSessionId metadata comes from the row that is current now.
    expect(r).toMatchObject({
      ok: true,
      sessionId: 'earlier-native-uuid',
      resumeId: 'earlier-native-uuid',
      ownerId: OWNER,
      advSessionId: 20807,
      binding: {
        coordOwnerId: OWNER,
        sessionId: 'current-native-uuid',
        startedAt: '2026-08-29 00:04:31.000123+00',
      },
    });

    const fragment = candidateFragmentOf(launchCoreSql.mock.calls as unknown as { 0?: TemplateStringsArray }[]);
    expect(fragment).toBeDefined();
    expect(fragment).not.toContain('harness_shared.adv_sessions');
  });

  it('uses a tracked Codex adv-session id when the row has no native session uuid', async () => {
    launchCoreSql.mockResolvedValue([{
      id: 22661,
      workspace_id: 'ws-codex',
      coord_owner_id: OWNER,
      session_id: null,
      agent: 'codex',
      cwd: '/repo',
      started_at: '2026-09-05T23:16:36.945Z',
      binding_started_at: '2026-09-05 23:16:36.945123+00',
      ended_at: null,
      exit_code: null,
      ended_by: null,
    }] as unknown[]);

    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({
      ok: true,
      sessionId: null,
      resumeId: '22661',
      ownerId: OWNER,
      advSessionId: 22661,
      model: null,
      modelSource: null,
      account: null,
    });
  });

  it('recovers the recorded Codex model and source from launch_argv for a resume', async () => {
    launchCoreSql.mockResolvedValue([{
      id: 22662,
      workspace_id: 'ws-codex',
      coord_owner_id: OWNER,
      session_id: null,
      agent: 'codex',
      cwd: '/repo',
      launch_argv: [
        'psu',
        '--agent=codex',
        '--account=auto',
        '--model=gpt-5.6-sol:xhigh',
        '--model-source=inherited',
      ],
      started_at: '2026-09-05T23:16:36.945Z',
      binding_started_at: '2026-09-05 23:16:36.945123+00',
      ended_at: null,
      exit_code: null,
      ended_by: null,
    }] as unknown[]);

    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({
      ok: true,
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'inherited',
      account: 'auto',
    });

    const queries = launchCoreSql.mock.calls.map((call) => String(call[0]?.join(' ')));
    expect(queries.some((query) => query.includes('launch_argv'))).toBe(true);
  });

  it('carries an inherited Codex model into the scripted resume command', () => {
    expect(buildAgentLaunchCommand({
      mode: 'resume',
      resumeId: '22662',
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'inherited',
      account: 'auto',
      headless: true,
    })).toBe(
      'psu --no-picker --account=auto --resume=22662 --headless --model=gpt-5.6-sol:xhigh --model-source=inherited',
    );
  });

  it('CONTROL: an agentId lookup still seeds its candidate from adv_sessions', async () => {
    launchCoreSql.mockResolvedValue([] as unknown[]);

    await resolveResumeTarget({ agentId: OWNER });

    const fragment = candidateFragmentOf(launchCoreSql.mock.calls as unknown as { 0?: TemplateStringsArray }[]);
    expect(fragment).toBeDefined();
    expect(fragment).toContain('harness_shared.adv_sessions');
  });
});

describe('probeFreshLaunchSessions', () => {
  it('executes the probe and maps the nullable native session id from adv_sessions', async () => {
    launchCoreSql.mockResolvedValueOnce([{
      id: 123,
      session_id: 'native-session-123',
      coord_owner_id: 'su-probed',
      successful_calls: 1,
      scheduler_calls: 0,
      successful_scheduler_calls: 0,
      ms_since_last_signal: 25,
      has_presence: true,
      scheduler_disposition: null,
      claimed_work_item_id: null,
      launch_spec: {},
      launch_argv: ['psu', '--headless'],
    }]);

    const sessions = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    });

    expect(sessions).toMatchObject([{
      advSessionId: 123,
      sessionId: 'native-session-123',
      ownerId: 'su-probed',
    }]);
    const query = launchCoreSql.mock.calls
      .map((call) => String(call[0]?.join(' ')))
      .find((candidate) => candidate.includes('s.session_id'));
    expect(query).toContain('s.session_id');
    expect(query).toMatch(/t\.status = 'ok'\s+AND t\.call_origin = 'agent'\s+--[\s\S]*?AND t\.invoked_at >= GREATEST\(s\.first_seen_at, to_timestamp\(/);
  });

  it('uses the authoritative self-wake oracle when session_briefs has stale `none`', async () => {
    launchCoreSql
      .mockResolvedValueOnce([{
        id: 125,
        session_id: 'native-session-125',
        coord_owner_id: 'su-probed',
        successful_calls: 1,
        scheduler_calls: 0,
        successful_scheduler_calls: 0,
        ms_since_last_signal: 25,
        has_presence: true,
        // This is the stale launch snapshot that caused EI-225344. The probe
        // must not consume it as the live wake truth.
        wake_source: 'none',
        scheduler_disposition: null,
        claimed_work_item_id: null,
        launch_spec: {},
        launch_argv: ['psu', '--headless'],
      }])
      // fetchSelfWake's two parallel queries: active loop, then event awaits.
      .mockResolvedValueOnce([{ target_owner_id: 'su-probed' }])
      .mockResolvedValueOnce([]);

    const sessions = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    });

    expect(sessions[0]?.workerAttestation.stages.durableWake).toEqual({
      status: 'satisfied',
      wakeSource: 'loop',
    });
    const queries = launchCoreSql.mock.calls.map((call) => String(call[0]?.join(' ')));
    expect(queries.some((query) => query.includes('harness_shared.routines'))).toBe(true);
    expect(queries.some((query) => query.includes('harness_shared.event_awaits'))).toBe(true);
    expect(queries.some((query) => query.includes('harness_shared.session_briefs'))).toBe(false);
  });

  it('fails closed when the authoritative self-wake oracle cannot be read', async () => {
    launchCoreSql
      .mockResolvedValueOnce([{
        id: 126,
        session_id: 'native-session-126',
        coord_owner_id: 'su-probed',
        successful_calls: 1,
        scheduler_calls: 0,
        successful_scheduler_calls: 0,
        ms_since_last_signal: 25,
        has_presence: true,
        scheduler_disposition: null,
        claimed_work_item_id: null,
        launch_spec: {},
        launch_argv: ['psu', '--headless'],
      }])
      .mockRejectedValueOnce(new Error('self-wake oracle unavailable'));

    await expect(probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    })).rejects.toThrow('fresh-launch probe failed: self-wake oracle unavailable');
  });

  it('treats the Claude [1m] context marker as equivalent during attestation', async () => {
    const row = (model: string) => ({
      id: 124,
      session_id: 'native-session-124',
      coord_owner_id: 'su-probed',
      successful_calls: 1,
      scheduler_calls: 1,
      successful_scheduler_calls: 1,
      ms_since_last_signal: 25,
      has_presence: true,
      wake_source: 'loop',
      scheduler_disposition: { kind: 'claimed', workItemId: 'WI-42407' },
      claimed_work_item_id: 'WI-42407',
      launch_spec: {
        agent: 'claude',
        workspaceId: 'ws-probe',
        harnessSlug: 'papercusp',
        planSlug: null,
        model,
        fleet: { slug: 'fleet-probe', role: 'member' },
      },
      launch_argv: [
        'psu',
        `--model=${model}`,
        '--account=default',
        '--carry=warm',
        '--headless',
      ],
    });
    const expected = {
      ownerId: 'su-probed',
      agent: 'claude',
      workspaceId: 'ws-probe',
      harnessSlug: 'papercusp',
      planSlug: null,
      model: 'claude-sonnet-5:xhigh',
      modelSource: null,
      effort: 'xhigh',
      account: 'default',
      carry: 'warm' as const,
      visibility: 'headless' as const,
      fleetSlug: 'fleet-probe',
      fleetRole: 'member',
    };

    launchCoreSql.mockResolvedValueOnce([row('claude-sonnet-5[1m]:xhigh')]);
    const normalized = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
      expectedOwnerIds: ['su-probed'],
      expectedAttestations: [expected],
    });
    expect(normalized[0]?.attestationDiffs).toEqual([]);

    launchCoreSql.mockResolvedValueOnce([row('claude-sonnet-4-6:xhigh')]);
    const genuinelyDifferent = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
      expectedOwnerIds: ['su-probed'],
      expectedAttestations: [expected],
    });
    expect(genuinelyDifferent[0]?.attestationDiffs).toEqual([
      {
        field: 'model',
        requested: 'claude-sonnet-5:xhigh',
        actual: 'claude-sonnet-4-6:xhigh',
      },
    ]);
  });
});

describe('injectKickoffAfterResume (D-008: the pty-socket is the only path to a resumed session)', () => {
  it('injects the kickoff as a turn once the pty host appears', async () => {
    const inject = vi.fn().mockResolvedValue(true);
    const tagTurn = vi.fn(async (input: { sid: string; origin: string; text: string }) => ({
      taggedText: `⟦turn-origin:${input.origin} nonce:0123456789abcdef⟧\n${input.text}`,
      envelope: `⟦turn-origin:${input.origin} nonce:0123456789abcdef⟧`,
      nonce: '0123456789abcdef',
      origin: 'wake-pump',
      ledgerWritten: true,
    }));
    const findHost = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(ptyHostFixture());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await injectKickoffAfterResume(OWNER, 'pick up where you left off', {
      findHost,
      inject,
      tagTurn,
      sleep,
      pollMs: 10,
      timeoutMs: 1000,
    });

    expect(r.delivered).toBe(true);
    // EI-153 addressing: the payload must NAME its addressee. Without `ownerId`
    // the receiving host's misdelivery guard abstains (its predicate is
    // `msg.ownerId != null && msg.ownerId !== ownerId`), so a stale or
    // mis-resolved socket silently accepts another agent's turn. Asserting the
    // field here is what keeps this path from regressing back to unaddressed.
    expect(inject).toHaveBeenCalledWith(`/run/psu-pty/${OWNER}.sock`, {
      mode: 'turn',
      data: '⟦turn-origin:wake-pump nonce:0123456789abcdef⟧\npick up where you left off',
      ownerId: OWNER,
    });
    expect(tagTurn).toHaveBeenCalledWith({
      sid: OWNER,
      origin: 'wake-pump',
      text: 'pick up where you left off',
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports a loud, actionable failure when the host never appears', async () => {
    const inject = vi.fn();
    const r = await injectKickoffAfterResume(OWNER, 'hi', {
      findHost: () => null,
      inject,
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 30,
    });

    expect(r.delivered).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(r.error).toMatch(/no live pty host appeared/);
  });

  it('reports a failed socket write instead of claiming delivery', async () => {
    const tagTurn = vi.fn(async (input: { sid: string; origin: string; text: string }) => ({
      taggedText: `⟦turn-origin:${input.origin} nonce:0123456789abcdef⟧\n${input.text}`,
      envelope: `⟦turn-origin:${input.origin} nonce:0123456789abcdef⟧`,
      nonce: '0123456789abcdef',
      origin: 'wake-pump',
      ledgerWritten: true,
    }));
    const r = await injectKickoffAfterResume(OWNER, 'hi', {
      findHost: () => ({ ownerId: OWNER, pid: 7, sock: '/run/x.sock' }) as never,
      inject: vi.fn().mockResolvedValue(false),
      tagTurn,
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 1000,
    });

    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/socket write failed/);
  });
});

describe('verifyResumeStarted (resume liveness is three-state)', () => {
  it('refuses an observed Codex successor even when launch argv requests the original UUID', async () => {
    const result = await verifyResumeStarted(OWNER, {
      expectedSessionId: 'original-native',
      findHost: () => ptyHostFixture({
        args: ['resume', 'original-native'],
        nativeSessionId: 'carry-successor',
      } as never),
      timeoutMs: 0,
    });

    expect(result).toMatchObject({ started: false, mismatch: true,
      expectedSessionId: 'original-native', actualSessionId: 'carry-successor' });
  });

  it.each([undefined, null])('keeps Codex argv-only identity unconfirmed (%s)', async (nativeSessionId) => {
    const result = await verifyResumeStarted(OWNER, {
      expectedSessionId: 'original-native',
      findHost: () => ptyHostFixture({
        args: ['resume', 'original-native'], nativeSessionId,
      } as never),
      timeoutMs: 0,
    });

    expect(result).toMatchObject({ started: null, mismatch: false,
      expectedSessionId: 'original-native', actualSessionId: null });
  });

  it('waits for the current Codex child observation before confirming an exact resume', async () => {
    const findHost = vi.fn()
      .mockReturnValueOnce(ptyHostFixture({ args: ['resume', 'original-native'] }))
      .mockReturnValue(ptyHostFixture({ args: ['resume', 'original-native'],
        nativeSessionId: 'original-native' } as never));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await verifyResumeStarted(OWNER, {
      expectedSessionId: 'original-native', findHost, sleep, timeoutMs: 1000, pollMs: 1,
    });

    expect(result).toMatchObject({ started: true, mismatch: false,
      actualSessionId: 'original-native' });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('confirms started once a live psu-pty host appears for the resumed identity', async () => {
    const findHost = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(ptyHostFixture());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await verifyResumeStarted(OWNER, { findHost, sleep, pollMs: 10, timeoutMs: 1000 });

    expect(r.started).toBe(true);
    expect(findHost).toHaveBeenCalledWith(OWNER);
    // Returned as soon as the host appeared — a healthy resume does not pay the full window.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('refuses a live owner host whose backend resumed a different native UUID', async () => {
    const r = await verifyResumeStarted(OWNER, {
      expectedSessionId: 'later-rollout-uuid',
      findHost: () => ({
        ownerId: OWNER,
        pid: 42,
        sock: `/run/psu-pty/${OWNER}.sock`,
        command: 'codex',
        args: ['--model', 'gpt-5.6-sol', 'resume', 'older-root-uuid'],
        nativeSessionId: 'older-root-uuid',
      }) as never,
    });

    expect(r).toMatchObject({
      started: false,
      mismatch: true,
      expectedSessionId: 'later-rollout-uuid',
      actualSessionId: 'older-root-uuid',
    });
  });

  // EI-21476169071856015: a healthy exact Codex resume registered more than seven
  // minutes after the 30s verifier refused it. No host inside a bounded window is
  // absence of evidence, not an observed no-op.
  it('reports started:null when no live host appears before the deadline', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await verifyResumeStarted(OWNER, {
      findHost: () => null,
      sleep,
      pollMs: 10,
      timeoutMs: 35,
    });

    expect(r.started).toBeNull();
    expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('verifyResumeStarted prepared cross-backend continuation', () => {
  function fixture(sourceBackend: 'claude' | 'codex' | 'omp' = 'codex') {
    const source = { id: 11, workspaceId: 'ws-test', coordOwnerId: OWNER, agent: sourceBackend,
      sessionId: 'source-native' } as AdvSessionRow;
    const target = { id: 12, workspaceId: 'ws-test', coordOwnerId: OWNER, agent: 'claude',
      sessionId: 'target-native', portId: 'port-1', portSourceAdvSessionId: 11,
      portStatus: 'delivered' } as AdvSessionRow;
    const port = { id: 'port-1', workspaceId: 'ws-test', sourceAdvSessionId: 11, targetAdvSessionId: 12,
      sourceBackend, targetBackend: 'claude', status: 'delivered', renderedHash: 'rendered-hash',
      metadata: {
        sourceCoordOwnerId: OWNER, targetCoordOwnerId: OWNER, targetNativeSessionId: 'target-native',
        bootstrapRequestHash: 'bootstrap-hash', bootstrapReceiptCommitted: true,
        bootstrapReceiptTargetAdvSessionId: 12,
        summary: { source: { advSessionId: 11, nativeSessionId: 'source-native', backend: sourceBackend,
          workspaceId: 'ws-test' }, target: { backend: 'claude' }, hashes: { rendered: 'rendered-hash' } },
        persistenceProof: { persisted: true, nativeRef: '/native/target-native.jsonl', renderedHash: 'rendered-hash' },
      } } as unknown as SessionPortRow;
    const host = { ownerId: OWNER, advSessionId: '12', command: 'claude', args: ['--session-id', 'target-native'] };
    const readAdvSession = vi.fn(async (id: number) => id === 11 ? source : id === 12 ? target : null);
    const readPort = vi.fn(async (_id: string, _workspace: string) => port);
    const options = { expectedSessionId: 'source-native',
      expectedPort: { sourceAdvSessionId: 11, targetBackend: 'claude' as const },
      findHost: () => host as never, readAdvSession, readPort, timeoutMs: 0 };
    return { source, target, port, host, options };
  }

  it.each(['codex', 'omp'] as const)('accepts %s→Claude only after exact source/target and persistence receipts', async (backend) => {
    const { options } = fixture(backend);
    const result = await verifyResumeStarted(OWNER, options);
    expect(result).toMatchObject({ started: true, mismatch: false,
      expectedSessionId: 'target-native', actualSessionId: 'target-native' });
    expect(options.readPort).toHaveBeenCalledWith('port-1', 'ws-test');
  });

  it.each([
    ['source owner', (f: ReturnType<typeof fixture>) => { f.source.coordOwnerId = 'su-other'; }],
    ['target owner', (f: ReturnType<typeof fixture>) => { f.target.coordOwnerId = 'su-other'; }],
    ['host owner', (f: ReturnType<typeof fixture>) => { f.host.ownerId = 'su-other'; }],
    ['target workspace', (f: ReturnType<typeof fixture>) => { f.target.workspaceId = 'other'; }],
    ['target backend', (f: ReturnType<typeof fixture>) => { f.target.agent = 'codex'; }],
    ['target lineage', (f: ReturnType<typeof fixture>) => { f.target.portSourceAdvSessionId = 99; }],
    ['port source', (f: ReturnType<typeof fixture>) => { f.port.sourceAdvSessionId = 99; }],
    ['port target', (f: ReturnType<typeof fixture>) => { f.port.targetAdvSessionId = 99; }],
    ['prepared owner', (f: ReturnType<typeof fixture>) => { f.port.metadata.targetCoordOwnerId = 'su-other'; }],
    ['prepared native', (f: ReturnType<typeof fixture>) => { f.port.metadata.targetNativeSessionId = 'other-native'; }],
    ['bootstrap target', (f: ReturnType<typeof fixture>) => { f.port.metadata.bootstrapReceiptTargetAdvSessionId = 99; }],
    ['source native', (f: ReturnType<typeof fixture>) => { f.options.expectedSessionId = 'other-source'; }],
    ['payload hash', (f: ReturnType<typeof fixture>) => {
      (f.port.metadata.persistenceProof as Record<string, unknown>).renderedHash = 'wrong-hash';
    }],
    ['native proof', (f: ReturnType<typeof fixture>) => {
      (f.port.metadata.persistenceProof as Record<string, unknown>).nativeRef = '/native/other-native.jsonl';
    }],
    ['host native', (f: ReturnType<typeof fixture>) => { f.host.args = ['--session-id', 'other-native']; }],
    ['terminal port', (f: ReturnType<typeof fixture>) => { f.port.status = 'failed'; }],
  ])('refuses a substituted %s', async (_label, change) => {
    const f = fixture();
    change(f);
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({ started: false, mismatch: true });
  });

  it.each([
    ['pending delivery', (f: ReturnType<typeof fixture>) => { f.port.status = 'pending'; f.target.portStatus = 'pending'; }],
    ['bootstrap receipt', (f: ReturnType<typeof fixture>) => { delete f.port.metadata.bootstrapReceiptCommitted; }],
    ['bootstrap target', (f: ReturnType<typeof fixture>) => { delete f.port.metadata.bootstrapReceiptTargetAdvSessionId; }],
    ['bootstrap hash', (f: ReturnType<typeof fixture>) => { delete f.port.metadata.bootstrapRequestHash; }],
    ['source summary', (f: ReturnType<typeof fixture>) => { delete f.port.metadata.summary; }],
    ['persistence proof', (f: ReturnType<typeof fixture>) => { delete f.port.metadata.persistenceProof; }],
    ['port row', (f: ReturnType<typeof fixture>) => { f.options.readPort.mockResolvedValue(null as never); }],
    ['probe unavailable', (f: ReturnType<typeof fixture>) => { f.options.readPort.mockRejectedValue(new Error('probe unavailable')); }],
  ])('keeps missing %s unconfirmed without rolling back a healthy process', async (_label, change) => {
    const f = fixture();
    change(f);
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({ started: null, mismatch: false });
  });

  it('waits for pending native persistence to become delivered', async () => {
    const f = fixture();
    f.port.status = 'pending';
    f.target.portStatus = 'pending';
    const sleep = vi.fn(async () => { f.port.status = 'delivered'; f.target.portStatus = 'delivered'; });
    const result = await verifyResumeStarted(OWNER, { ...f.options, sleep, timeoutMs: 1000, pollMs: 1 });
    expect(result.started).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  function codexTargetFixture() {
    const f = fixture('claude');
    f.target.agent = 'codex';
    f.port.targetBackend = 'codex';
    (f.port.metadata.summary as { target: { backend: string } }).target.backend = 'codex';
    const host = { ...f.host, command: 'codex', args: ['resume', 'target-native'],
      nativeSessionId: null as string | null | undefined };
    return { ...f, host, options: { ...f.options,
      expectedPort: { sourceAdvSessionId: 11, targetBackend: 'codex' as const },
      findHost: () => host as never } };
  }

  it.each([undefined, null])('accepts an unassigned bootstrap native UUID only after the Codex child identity is observed (%s)', async (bootstrapNative) => {
    const f = codexTargetFixture();
    f.port.metadata.targetNativeSessionId = bootstrapNative;
    f.host.nativeSessionId = 'target-native';
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({
      started: true, mismatch: false, expectedSessionId: 'target-native', actualSessionId: 'target-native',
    });
    f.host.nativeSessionId = null;
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({
      started: null, mismatch: false, expectedSessionId: 'target-native', actualSessionId: null,
    });
    f.host.nativeSessionId = 'unrelated-child';
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({
      started: false, mismatch: true, actualSessionId: 'unrelated-child',
    });
  });

  it.each([undefined, null])('keeps a delivered Codex conversion without observed identity unconfirmed (%s)', async (nativeSessionId) => {
    const f = codexTargetFixture();
    f.host.nativeSessionId = nativeSessionId;
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({
      started: null, mismatch: false, expectedSessionId: 'target-native', actualSessionId: null,
    });
  });

  it('waits for observed Codex conversion identity and rejects a contradictory child UUID', async () => {
    const f = codexTargetFixture();
    const sleep = vi.fn(async () => { f.host.nativeSessionId = 'target-native'; });
    f.host.args = ['resume', 'requested-predecessor'];
    expect(await verifyResumeStarted(OWNER, { ...f.options, sleep, timeoutMs: 1000, pollMs: 1 }))
      .toMatchObject({ started: true, mismatch: false, actualSessionId: 'target-native' });
    expect(sleep).toHaveBeenCalledTimes(1);
    f.host.nativeSessionId = 'unrelated-child';
    expect(await verifyResumeStarted(OWNER, f.options)).toMatchObject({
      started: false, mismatch: true, actualSessionId: 'unrelated-child',
    });
  });

  it('does not use a port receipt to override an ordinary same-backend UUID mismatch', async () => {
    const f = fixture();
    const { expectedPort: _port, ...ordinary } = f.options;
    expect(await verifyResumeStarted(OWNER, ordinary)).toMatchObject({ started: false,
      expectedSessionId: 'source-native', actualSessionId: 'target-native', mismatch: true });
    expect(f.options.readPort).not.toHaveBeenCalled();
  });
});

describe('nativeSessionIdFromHost', () => {
  it('reads the physical Codex observation and Claude/OMP resume flags', () => {
    expect(nativeSessionIdFromHost({ command: 'codex', nativeSessionId: 'codex-uuid',
      args: ['-m', 'gpt-5.6-sol', 'resume', 'predecessor-uuid'] })).toBe('codex-uuid');
    expect(nativeSessionIdFromHost({ command: '/usr/bin/codex', args: ['resume', 'requested-uuid'] })).toBeNull();
    expect(nativeSessionIdFromHost({ command: 'claude', args: ['--resume', 'claude-uuid'] })).toBe('claude-uuid');
    expect(nativeSessionIdFromHost({ command: 'omp', args: ['--resume-session=omp-uuid'] })).toBe('omp-uuid');
    expect(nativeSessionIdFromHost({ command: 'claude', args: ['--session-id', 'new-claude-uuid'] })).toBe('new-claude-uuid');
    expect(nativeSessionIdFromHost({ command: 'claude', args: ['--session-id=new-claude-uuid'] })).toBe('new-claude-uuid');
  });

  it('returns null when the host does not attest a native resume id', () => {
    expect(nativeSessionIdFromHost({ command: 'codex', args: ['--model', 'gpt-5.6-sol'] })).toBeNull();
    expect(nativeSessionIdFromHost({ command: 'codex' })).toBeNull();
    expect(nativeSessionIdFromHost({ command: 'codex', args: ['resume', '--last'] })).toBeNull();
  });
});

describe('guarded visible restoration', () => {
  it('permits shutdown only with a positive dead-window witness', () => {
    expect(restoreVisibleMayShutdown('dead')).toBe(true);
    expect(restoreVisibleMayShutdown('alive')).toBe(false);
    expect(restoreVisibleMayShutdown('unknown')).toBe(false);
    expect(restoreVisibleMayShutdown('not-a-window')).toBe(false);
  });

  it('waits for the exact old host to disappear before relaunching', async () => {
    const findHost = vi.fn().mockReturnValueOnce({ pid: 1 }).mockReturnValueOnce({ pid: 1 }).mockReturnValue(null);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForPtyHostGone(OWNER, { findHost: findHost as never, sleep, pollMs: 1, timeoutMs: 100 })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the old host never disappears', async () => {
    await expect(waitForPtyHostGone(OWNER, {
      findHost: (() => ({ pid: 1 })) as never,
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 25,
    })).resolves.toBe(false);
  });
});

describe('stale headless recovery guard', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');

  it('only marks an explicitly agent-launched headless host stale after measured idle time', () => {
    expect(
      isStaleHeadlessAgentHost(
        {
          bridgeTty: false,
          launchedBy: 'su-launcher',
          lastActivityAt: now - 31 * 60_000,
        },
        { now },
      ),
    ).toBe(true);
    expect(
      isStaleHeadlessAgentHost(
        {
          bridgeTty: false,
          launchedBy: 'su-launcher',
          lastOutputAt: now - 31 * 60_000,
          lastInputAt: now - 2 * 60_000,
        },
        { now },
      ),
    ).toBe(false);
  });

  it('fails closed for unknown provenance/activity and interactive or recent hosts', () => {
    const stale = now - 31 * 60_000;
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, lastActivityAt: stale }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, launchedBy: 'su-launcher' }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: true, launchedBy: 'su-launcher', lastActivityAt: stale }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, launchedBy: 'su-launcher', lastActivityAt: now - 5 * 60_000 }, { now })).toBe(false);
  });
});

describe('defaultLaunchAccountFor (WI-10004158 / D-011)', () => {
  const gateway = 'papercusp-gateway/claude-sonnet-4-6';
  const direct = 'openai-codex/gpt-5.6-terra:xhigh';

  it('routes an OMP gateway model to auto, from each source the engine reads', () => {
    expect(defaultLaunchAccountFor({ agent: 'omp', model: gateway })).toBe('auto');
    expect(defaultLaunchAccountFor({ agent: 'omp', ompNativeDefault: () => gateway })).toBe('auto');
    expect(defaultLaunchAccountFor({ agent: 'omp', model: direct, ompSelector: gateway })).toBe('auto');
  });

  it('uses the engine precedence: selector, then requested model, then native default', () => {
    expect(defaultLaunchAccountFor({ agent: 'omp', model: gateway, ompSelector: direct })).toBe('default');
    const nativeDefault = vi.fn(() => gateway);
    expect(defaultLaunchAccountFor({ agent: 'omp', model: direct, ompNativeDefault: nativeDefault })).toBe('default');
    expect(nativeDefault).not.toHaveBeenCalled();
  });

  it('keeps the default account for direct models, no model, and other backends', () => {
    expect(defaultLaunchAccountFor({ agent: 'omp', ompNativeDefault: () => direct })).toBe('default');
    expect(defaultLaunchAccountFor({ agent: 'omp', ompNativeDefault: () => null })).toBe('default');
    expect(defaultLaunchAccountFor({ agent: 'claude', model: gateway })).toBe('default');
    expect(defaultLaunchAccountFor({ agent: 'codex', ompNativeDefault: () => gateway })).toBe('default');
  });
});
