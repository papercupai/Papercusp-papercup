import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultIsHeadlessResumeTurn,
  executeWake,
  isHeadlessResumeArgv,
  ledgerSafeResumeArgv,
  type ExecuteWakeDeps,
  type HeadlessResumeTurnInput,
} from './wake-executor';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeOutcome } from './types';
import { MultiSessionTestbed, makeDelivery, advSessionHandle, deadPid } from '../../../test/_multi-session-testbed';

/**
 * P0a wiring: executeWake's `resume-headless` channel must forward the detached turn's
 * eventual exit to `deps.onResumeTurnExit`, bound to THIS delivery — the seam the loop
 * turn-outcome handler uses to feed the autoloop circuit on a 429 turn-death. The
 * delivery is still 'delivered' the instant a PID lands (the observation is async).
 */
describe('wake-executor — resume-headless exit observation (P0a)', () => {
  let tb: MultiSessionTestbed;
  beforeEach(() => {
    tb = MultiSessionTestbed.create();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await tb.destroy();
  });

  async function exitedClaudeResumeDeps(over: Partial<ExecuteWakeDeps> = {}): Promise<{
    deps: ExecuteWakeDeps;
    s: ReturnType<MultiSessionTestbed['session']>;
  }> {
    const s = tb.session('A');
    const dead = await deadPid();
    const deps: ExecuteWakeDeps = {
      resolveWakeModeFn: async () => 'auto',
      findPsuHost: async () => null, // no live socket → fall through to the resume ladder
      getSession: async () =>
        ({
          pid: dead,
          endedAt: null,
          agent: 'claude',
          sessionId: 'native-A',
          coordOwnerId: null,
          cwd: s.cwd,
        }) as never,
      findPty: () => null,
      write: () => true,
      presence: async () => null,
      alive: () => false,
      // Hermetic Channel 2 resume path: the production default performs the
      // atomic DB claim, but this unit test only exercises detached-exit wiring.
      claimResume: async () => true,
      // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
      accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
      // The resume leg's harness fallback reads the live loop row. That blocked
      // real-PG attempt ran in every test here; model "no loop row" instead.
      getLoopStatusFn: (async () => null) as never,
      // EI-203843: executeWake's FIRST gate reads the owner's session lifecycle fail-closed.
      // Without a stub it hits real PG, throws, and parks every case as "custody unknown".
      // Model "no lifecycle row" (not shut down, not paused) so the resume ladder runs.
      getSessionLifecycle: async () => null,
      ...over,
    };
    // Hermetic owner election (WI-10008189): the handle reads not-alive, so executeWake elects
    // the owner's newest adv-session. Stamp the fixture row with its id + owner and model "no
    // successor", so it never reaches the real PG election read. A cell's own
    // getLatestSessionForOwner (via `over`) still wins.
    return { s, deps: { ...deps, ...tb.ownerElectionDeps(deps) } };
  }

  it('forwards the detached turn exit to onResumeTurnExit, bound to the delivery; still delivers on spawn', async () => {
    let observed: { d: DeliveryWork; exit: ResumeTurnExitRaw } | null = null;
    let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
    const synthetic: ResumeTurnExitRaw = { exitCode: 1, signal: null, stdoutTail: 'API Error: 429 · Rate limited', stderrTail: '' };

    const { deps, s } = await exitedClaudeResumeDeps({
      // Capture the onExit the executor passes; pretend a pid spawned.
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitWired = onExit;
        return 4242;
      },
      onResumeTurnExit: (d, exit) => {
        observed = { d, exit };
      },
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);

    // Delivered on spawn — the observation does NOT block the delivery.
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    // The executor wired an onExit closure into the spawn.
    expect(onExitWired).toBeTypeOf('function');
    // Firing it (as the real subprocess close would) reaches onResumeTurnExit with THIS delivery.
    onExitWired!(synthetic);
    expect(observed).not.toBeNull();
    expect(observed!.d.id).toBe(d.id);
    expect(observed!.d.subscriberId).toBe(s.ownerId);
    expect(observed!.exit).toEqual(synthetic);
  });

  it('restores transcript tool references in the resumed MCP seed and forwards poison disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const missing = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' }] },
      }));
      vi.stubEnv('PAPERCUSP_TOOLS', 'tools:find,coord:orient');
      const spawnedEnvs: Record<string, string>[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      let observedContext: unknown;
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const sendCoordMessage = vi.fn(async () => ({} as never));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        quarantineToolReferenceSession: quarantine as never,
        sendCoordMessage,
        spawnDetached: (_bin, _args, opts, onExit) => {
          spawnedEnvs.push(opts.env);
          onExitWired = onExit;
          return 4242;
        },
        onResumeTurnExit: (_d, _exit, context) => { observedContext = context; },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({
        subscriberId: s.ownerId,
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
      expect(spawnedEnvs[0]?.PAPERCUSP_TOOLS).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit');
      onExitWired!({ exitCode: 1, signal: null, stdoutTail: missing, stderrTail: '' });
      await vi.waitFor(() => expect(observedContext).toMatchObject({ poisoned: true, advSessionId: s.advSessionId }));
      expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
        transcriptPath,
        ownerId: s.ownerId,
        sessionId: 'native-A',
      }), missing);
      expect(sendCoordMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops queued wakes for the exact poisoned adv-session incarnation', async () => {
    let spawned = false;
    const { deps, s } = await exitedClaudeResumeDeps();
    deps.getSessionLifecycle = async () => ({
        poisoned: {
          advSessionId: s.advSessionId,
          sessionId: 'native-A',
          startedAt: '2026-09-24T10:00:00.123Z',
          at: '2026-09-24T10:05:00.000Z',
          by: 'resume-turn-detector',
          reason: 'three consecutive unavailable tool references',
          evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
        },
      });
    deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
    deps.spawnDetached = () => { spawned = true; return 4242; };
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    await expect(executeWake(d, deps)).resolves.toMatchObject({
      kind: 'drop',
      reason: expect.stringContaining('quarantined'),
    });
    expect(spawned).toBe(false);
  });

  it('does not let an old poison marker block a newer resumed incarnation', async () => {
    let spawned = false;
    const { deps, s } = await exitedClaudeResumeDeps({
      collectSessionFiles: async () => [],
      spawnDetached: () => { spawned = true; return 4242; },
    });
    deps.getSessionLifecycle = async () => ({
      poisoned: {
        advSessionId: s.advSessionId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        at: '2026-09-24T10:05:00.000Z',
        by: 'resume-turn-detector',
        reason: 'three consecutive unavailable tool references',
        evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
      },
    });
    deps.getSession = async () => ({
      id: s.advSessionId,
      workspaceId: 'row-ws',
      agent: 'claude',
      // Replaces the owner-election-wrapped getSession, so name the row's real owner
      // itself: the election parks a row it cannot attribute (WI-10008189).
      coordOwnerId: s.ownerId,
      sessionId: 'native-A',
      startedAt: '2026-09-24T10:06:00.000Z',
      endedAt: null,
      pid: await deadPid(),
      cwd: s.cwd,
    }) as never;
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawned).toBe(true);
  });

  it('quarantines a live interactive session before the next pty injection after three errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const error = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      const turn = () => JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: error }] },
      });
      writeFileSync(transcriptPath, [turn(), turn(), turn()].join('\n'));
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      // No live host can carry-respawn it (WI-10003466): quarantine stays the last resort.
      const recover = vi.fn(async () => 'unrecoverable' as const);
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        alive: () => true,
        quarantineToolReferenceSession: quarantine as never,
        recoverToolReferenceDeath: recover,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        spawnDetached: () => { throw new Error('poisoned live session must not spawn'); },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: 7777,
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      await expect(executeWake(d, deps)).resolves.toMatchObject({ kind: 'drop', reason: expect.stringContaining('quarantined') });
      expect(recover).toHaveBeenCalledWith(s.ownerId, expect.objectContaining({ workspaceId: 'row-ws' }));
      expect(quarantine).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('carry-respawns a dead Claude session before resuming a transcript with repeated unavailable-tool errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const error = "API Error: 400 Tool reference 'WaitForMcpServers' not found in available tools";
      const turn = () => JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: error }] },
      });
      writeFileSync(transcriptPath, [turn(), turn()].join('\n'));
      const recover = vi.fn(async () => 'queued' as const);
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      let spawned = false;
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        alive: () => false,
        recoverToolReferenceDeath: recover,
        quarantineToolReferenceSession: quarantine as never,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        spawnDetached: () => {
          spawned = true;
          return 4242;
        },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: 7777,
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      const out = await executeWake(d, deps);

      expect(out).toMatchObject({ kind: 'park', reason: expect.stringContaining('fresh context') });
      expect(recover).toHaveBeenCalledWith(s.ownerId, expect.objectContaining({ workspaceId: 'row-ws' }));
      expect(quarantine).not.toHaveBeenCalled();
      expect(spawned).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks reconciled tool-reference recovery for a dead Claude session when local transcript listing misses the file', async () => {
    const recover = vi.fn(async () => 'queued' as const);
    let spawned = false;
    const { deps, s } = await exitedClaudeResumeDeps({
      getSessionLifecycle: async () => null,
      collectSessionFiles: async () => [],
      alive: () => false,
      recoverToolReferenceDeath: recover,
      sendCoordMessage: vi.fn(async () => ({} as never)),
      spawnDetached: () => {
        spawned = true;
        return 4242;
      },
    });
    deps.getSession = async () => ({
      id: s.advSessionId,
      workspaceId: 'row-ws',
      harnessSlug: 'papercusp',
      agent: 'claude',
      coordOwnerId: s.ownerId,
      sessionId: 'native-A',
      startedAt: '2026-09-24T10:00:00.123Z',
      endedAt: null,
      pid: 7777,
      cwd: s.cwd,
    }) as never;
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

    const out = await executeWake(d, deps);

    expect(out).toMatchObject({ kind: 'park', reason: expect.stringContaining('fresh context') });
    expect(recover).toHaveBeenCalledWith(s.ownerId, expect.objectContaining({ workspaceId: 'row-ws' }));
    expect(spawned).toBe(false);
  });

  it.each([
    ['ExitPlanMode', 'started'],
    ['ExitPlanMode', 'refused'],
    ['WaitForMcpServers', 'started'],
    ['WaitForMcpServers', 'throws'],
    ['mcp__papercusp-su__plans_audit', 'started'],
    ['mcp__papercusp-su__plans_audit', 'refused'],
  ] as const)('uses fresh context for a dead no-host %s rejection (%s)', async (tool, launchResult) => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const turn = () => JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant', model: '<synthetic>',
          content: [{ type: 'text', text: `API Error: 400 Tool reference '${tool}' not found in available tools` }],
        },
      });
      writeFileSync(transcriptPath, [turn(), turn(), turn()].join('\n'));
      const launchColdFreshSuccessor = vi.fn(async (_input: Parameters<NonNullable<ExecuteWakeDeps['launchColdFreshSuccessor']>>[0]) => {
        if (launchResult === 'throws') throw new Error('successor unavailable');
        return launchResult === 'started';
      });
      const spawnDetached = vi.fn(() => 4242);
      const claimResume = vi.fn(async () => true);
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{ rel: 'projects/-repo/native-A.jsonl', abs: transcriptPath, bytes: 1, mtimeMs: 1 }],
        recoverToolReferenceDeath: async () => 'unrecoverable',
        launchColdFreshSuccessor,
        spawnDetached,
        claimResume,
        quarantineToolReferenceSession: quarantine as never,
      });
      deps.getSession = async () => ({
        id: s.advSessionId, workspaceId: 'row-ws', harnessSlug: 'papercusp',
        agent: 'claude', coordOwnerId: s.ownerId, sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z', endedAt: '2026-09-24T10:01:00.000Z',
        pid: 7777, cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      const out = await executeWake(d, deps);

      if (launchResult === 'started') {
        expect(out).toEqual({ kind: 'delivered', channel: 'cold-fresh-successor' });
      } else {
        expect(out).toMatchObject({ kind: 'park', reason: expect.stringContaining('without replaying') });
      }
      expect(launchColdFreshSuccessor).toHaveBeenCalledWith(expect.objectContaining({
        subscriberId: s.ownerId, workspaceId: 'row-ws', harness: 'papercusp', deliveryId: d.id,
      }));
      expect(launchColdFreshSuccessor.mock.calls[0]?.[0]).not.toHaveProperty('carry');
      expect(claimResume).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(quarantine).not.toHaveBeenCalled();
      if (launchResult === 'throws') {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`cold fresh successor failed for ${s.ownerId}`));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-10003466 (su-7dc2cf9d, 2026-09-27): a transient MCP disconnect left a LIVE
  // interactive session replaying `Tool reference 'mcp__papercusp-su__capability_bash'
  // not found` on every turn; this branch ENDED the session instead of recovering it.
  // A live carry-respawn-capable host must get a fresh successor and the wake must park
  // for it — never a quarantine, never an injection into the poisoned transcript.
  it.each([
    ['queued', 2],
    ['in-grace', 3],
  ] as const)('parks the wake instead of quarantining when recovery is %s (streak %i)', async (verdict, turns) => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const error = "API Error: 400 Tool reference 'mcp__papercusp-su__capability_bash' not found in available tools";
      const turn = () => JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: error }] },
      });
      writeFileSync(transcriptPath, Array.from({ length: turns }, turn).join('\n'));
      const quarantine = vi.fn(async () => ({ poisoned: true, turns }));
      const recover = vi.fn(async () => verdict);
      const injected: unknown[] = [];
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{ rel: 'projects/-repo/native-A.jsonl', abs: transcriptPath, bytes: 1, mtimeMs: 1 }],
        alive: () => true,
        quarantineToolReferenceSession: quarantine as never,
        recoverToolReferenceDeath: recover,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        findPty: ((...args: unknown[]) => { injected.push(args); return null; }) as never,
        spawnDetached: () => { throw new Error('poisoned live session must not spawn'); },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: 7777,
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      const out = await executeWake(d, deps);
      expect(out).toMatchObject({ kind: 'park', reason: expect.stringContaining('fresh context') });
      expect(recover).toHaveBeenCalledWith(s.ownerId, expect.objectContaining({ workspaceId: 'row-ws' }));
      expect(quarantine).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not quarantine when the LIVE transcript is healthy though the recorded one is poisoned', async () => {
    // After a carry-respawn the adv-session row can still name the dead predecessor's
    // transcript; the reconciled live transcript is the truth. 'not-dead' must neither
    // quarantine nor queue another respawn (that would be a respawn loop).
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const error = "API Error: 400 Tool reference 'mcp__papercusp-su__capability_bash' not found in available tools";
      const turn = () => JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: error }] },
      });
      writeFileSync(transcriptPath, [turn(), turn(), turn()].join('\n'));
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const recover = vi.fn(async () => 'not-dead' as const);
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{ rel: 'projects/-repo/native-A.jsonl', abs: transcriptPath, bytes: 1, mtimeMs: 1 }],
        alive: () => true,
        quarantineToolReferenceSession: quarantine as never,
        recoverToolReferenceDeath: recover,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        spawnDetached: () => { throw new Error('live session must not spawn'); },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: 7777,
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      const out = await executeWake(d, deps);
      expect(out.kind).not.toBe('drop');
      expect(recover).toHaveBeenCalledTimes(1);
      expect(quarantine).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds transcript tool references into a headless resume and quarantines a repeated failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const missing = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' }] },
      }));
      vi.stubEnv('PAPERCUSP_TOOLS', 'tools:find,coord:orient');
      const spawnedEnvs: Record<string, string>[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      let observedContext: unknown;
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        spawnDetached: (_bin, _args, opts, onExit) => {
          spawnedEnvs.push(opts.env);
          onExitWired = onExit;
          return 4242;
        },
        quarantineToolReferenceSession: quarantine as never,
        onResumeTurnExit: (_d, _exit, context) => { observedContext = context; },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({
        subscriberId: s.ownerId,
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
      expect(spawnedEnvs[0]?.PAPERCUSP_TOOLS).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit');
      onExitWired!({ exitCode: 1, signal: null, stdoutTail: missing, stderrTail: '' });
      await vi.waitFor(() => expect(observedContext).toMatchObject({ poisoned: true, advSessionId: s.advSessionId }));
      expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
        transcriptPath,
        ownerId: s.ownerId,
        sessionId: 'native-A',
      }), missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines a Codex resume whose turn failed on a context-window overflow (WI-6554700010008894)', async () => {
    const homes = mkdtempSync(join(tmpdir(), 'wake-codex-overflow-'));
    try {
      const s = tb.session('A');
      const nativeId = '01a10080-4435-7822-8b4f-d82fc7e81227';
      const sessionsDir = join(homes, `session-${s.advSessionId}`, 'sessions', '2026', '10', '03');
      mkdirSync(sessionsDir, { recursive: true });
      const rolloutPath = join(sessionsDir, `rollout-2026-10-03T02-42-48-${nativeId}.jsonl`);
      writeFileSync(
        rolloutPath,
        readFileSync(join(__dirname, '__fixtures__', 'codex-rollout-over-window.tail.jsonl'), 'utf8'),
      );
      vi.stubEnv('PAPERCUSP_SU_CODEX_HOMES_DIR', homes);
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      let observedContext: unknown;
      // The detector reads the rollout and decides; here the first exit finds a
      // one-turn streak and the second finds the threshold-crossing streak.
      const quarantine = vi
        .fn(async () => ({ poisoned: true, turns: 2 }))
        .mockResolvedValueOnce({ poisoned: false, turns: 1 });
      const { deps } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        ensureCodexHomeForWake: (async () => ({ ok: true, repaired: false })) as never,
        spawnDetached: (_bin, _args, _opts, onExit) => {
          onExitWired = onExit;
          return 4343;
        },
        quarantineCodexOverflowSession: quarantine as never,
        onResumeTurnExit: (_d, _exit, context) => { observedContext = context; },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'codex',
        coordOwnerId: s.ownerId,
        sessionId: nativeId,
        startedAt: '2026-10-12T11:26:21.000Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({
        subscriberId: s.ownerId,
        wakeHandle: advSessionHandle(s, { agent: 'codex', sessionId: nativeId, pid: 0 }),
      });

      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
      // The real exit shape (captured 2026-10-12 12:22Z): the turn overflowed, Codex then ran a
      // remote compact task, and THAT failed on the usage wall, so the exit tail names only the
      // compact failure. The rollout is still consulted; a short streak is not quarantined.
      const compactFailure =
        '{"type":"turn.failed","error":{"message":"Error running remote compact task: You’ve hit your usage limit. usage_limit_exceeded"}}';
      onExitWired!({ exitCode: 0, signal: null, stdoutTail: compactFailure, stderrTail: '' });
      await vi.waitFor(() => expect(quarantine).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(observedContext).toBeDefined());
      expect(observedContext).not.toMatchObject({ poisoned: true });

      observedContext = undefined;
      onExitWired!({ exitCode: 0, signal: null, stdoutTail: compactFailure, stderrTail: '' });
      await vi.waitFor(() => expect(observedContext).toMatchObject({ poisoned: true, advSessionId: s.advSessionId }));
      expect(quarantine).toHaveBeenCalledTimes(2);
      expect(quarantine).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent: 'codex', transcriptPath: rolloutPath, sessionId: nativeId }),
        compactFailure,
      );
      expect(observedContext).toMatchObject({
        transcriptPath: rolloutPath,
        poisonReason: expect.stringContaining('exceeded the model context window'),
      });
    } finally {
      rmSync(homes, { recursive: true, force: true });
    }
  });

  it('back-compat: with NO onResumeTurnExit dep, the spawn receives an undefined onExit and still delivers', async () => {
    let onExitArg: unknown = 'unset';
    const { deps, s } = await exitedClaudeResumeDeps({
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitArg = onExit;
        return 4242;
      },
      // no onResumeTurnExit
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(onExitArg).toBeUndefined();
  });

  // ── WI-10002854: one live process per session ───────────────────────────
  describe('split-brain fence (WI-10002854)', () => {
    it('accounts the spawned turn (ledger + adv pid, row workspace) and reports delivered only after the pid write', async () => {
      const inputs: HeadlessResumeTurnInput[] = [];
      let releasePidWrite!: () => void;
      const pidWrite = new Promise<void>((r) => {
        releasePidWrite = r;
      });
      const { deps, s } = await exitedClaudeResumeDeps({
        getSession: async () =>
          ({
            pid: await deadPid(),
            endedAt: null,
            agent: 'claude',
            sessionId: 'native-A',
            // null keeps the claude rematerialize leg (a PG read) out of this
            // unit test. The ledger owner then falls back to the subscriber.
            coordOwnerId: null,
            cwd: s.cwd,
            workspaceId: 'row-ws',
            launchArgv: ['--account=auto'],
          }) as never,
        spawnDetached: () => 4242,
        accountHeadlessResumeTurn: (input) => {
          inputs.push(input);
          return { pidRecorded: pidWrite, finish: () => {} };
        },
      });
      const d = makeDelivery({
        subscriberId: s.ownerId,
        workspaceId: 'coord-ws',
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      let settled = false;
      const pending = executeWake(d, deps).then((out) => {
        settled = true;
        return out;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false); // delivered is NOT reported before the pid write
      releasePidWrite();
      expect(await pending).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        pid: 4242,
        advSessionId: s.advSessionId,
        sessionWorkspaceId: 'row-ws', // the ROW's workspace, not the coord plane's
        coordOwnerId: s.ownerId,
        agent: 'claude',
        resumeId: 'native-A',
        declaredAccountRoute: { mode: 'auto', accountId: null },
      });
      // The ledger argv never carries the wake text verbatim.
      expect(inputs[0]!.argv.some((a) => a.startsWith('<wake-text '))).toBe(true);
    });

    it('closes the ledger row on exit AND still forwards the exit to onResumeTurnExit', async () => {
      const finished: ResumeTurnExitRaw[] = [];
      const forwarded: ResumeTurnExitRaw[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      const { deps, s } = await exitedClaudeResumeDeps({
        spawnDetached: (_b, _a, _o, onExit) => {
          onExitWired = onExit;
          return 4242;
        },
        accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: (e) => finished.push(e) }),
        onResumeTurnExit: (_d, e) => forwarded.push(e),
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });
      await executeWake(d, deps);
      const exit: ResumeTurnExitRaw = { exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' };
      onExitWired!(exit);
      expect(finished).toEqual([exit]);
      expect(forwarded).toEqual([exit]);
    });

    it('a failed spawn accounts nothing', async () => {
      let accounted = 0;
      const { deps, s } = await exitedClaudeResumeDeps({
        spawnDetached: () => null,
        accountHeadlessResumeTurn: () => {
          accounted++;
          return { pidRecorded: Promise.resolve(), finish: () => {} };
        },
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });
      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'error', error: 'headless resume spawn failed' });
      expect(accounted).toBe(0);
    });

    /** A live recorded pid for a loop-armed owner: without the fence this reaches
     *  WI-666's force-resume leg, which SIGINTs the pid. */
    async function liveLoopOwnerDeps(isHeadless: boolean) {
      const forced: number[] = [];
      const spawned: string[][] = [];
      const oracleCalls: Array<[number, string | null]> = [];
      const { deps, s } = await exitedClaudeResumeDeps({
        getSession: async () =>
          ({ pid: 7777, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => true,
        isLoopArmed: async () => true,
        forceResume: async (pid) => {
          forced.push(pid);
          return false;
        },
        isHeadlessResumeTurn: (pid, id) => {
          oracleCalls.push([pid, id]);
          return isHeadless;
        },
        spawnDetached: (_b, args) => {
          spawned.push(args);
          return 4242;
        },
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });
      return { out: await executeWake(d, deps), forced, spawned, oracleCalls };
    }

    it('parks (never SIGINTs, never double-resumes) while the recorded pid is a live headless turn of this session', async () => {
      const { out, forced, spawned, oracleCalls } = await liveLoopOwnerDeps(true);
      expect(out.kind).toBe('park');
      expect((out as { reason: string }).reason).toMatch(/headless resume turn pid 7777 is still running/);
      expect(oracleCalls).toEqual([[7777, 'native-A']]);
      expect(forced).toEqual([]);
      expect(spawned).toEqual([]);
    });

    it('control: the same live pid that is NOT a headless turn still reaches the WI-666 force leg', async () => {
      const { out, forced } = await liveLoopOwnerDeps(false);
      expect(forced).toEqual([7777]);
      expect(out.kind).toBe('park');
      expect((out as { reason: string }).reason).toMatch(/bounded force-resume/);
    });
  });
});

describe('isHeadlessResumeArgv / ledgerSafeResumeArgv (WI-10002854)', () => {
  it('matches every resume shape resumeCommandFor emits, only for the exact session id', () => {
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1', '-p', 'go'], 'sid-1')).toBe(true);
    expect(isHeadlessResumeArgv(['claude', '-p', '--resume', 'sid-1'], 'sid-1')).toBe(true);
    expect(isHeadlessResumeArgv(['omp', '-r', 'th-1', '--approval-mode', 'yolo', '-p', 'go'], 'th-1')).toBe(true);
    expect(isHeadlessResumeArgv(['codex', 'exec', 'resume', 'uuid-1', 'go'], 'uuid-1')).toBe(true);
    // An interactive (non -p) process on the session is not a headless turn.
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1'], 'sid-1')).toBe(false);
    // Another session's headless turn does not match, nor does a substring.
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-2', '-p'], 'sid-1')).toBe(false);
    expect(isHeadlessResumeArgv(['claude', '--resume=sid-1x', '-p'], 'sid-1')).toBe(false);
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1', '-p'], '')).toBe(false);
  });

  it('never stores the account-route token or the wake text on the ledger row', () => {
    const settings = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-123' } });
    const out = ledgerSafeResumeArgv(
      'claude',
      ['--settings', settings, '--settings={"x":"sk-secret-123"}', '--resume', 'sid-1', '-p', 'WAKE TEXT'],
      'WAKE TEXT',
    );
    expect(JSON.stringify(out)).not.toContain('sk-secret-123');
    expect(JSON.stringify(out)).not.toContain('WAKE TEXT');
    expect(out).toEqual([
      'claude',
      '--settings',
      '<redacted>',
      '--settings=<redacted>',
      '--resume',
      'sid-1',
      '-p',
      '<wake-text 9 chars>',
    ]);
  });
});

describe.skipIf(!existsSync('/proc/self/cmdline'))('defaultIsHeadlessResumeTurn — real /proc (WI-10002854)', () => {
  async function withChild(extra: string[], fn: (pid: number) => void): Promise<void> {
    // `--` stops node's own option parsing, so the resume-shaped tokens land
    // verbatim in /proc/<pid>/cmdline, the same as a real `claude -p` turn.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', ...extra], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      fn(child.pid!);
    } finally {
      child.kill('SIGKILL');
    }
  }

  it('reads the live argv: a headless turn of THIS session is recognised; others are not', async () => {
    await withChild(['--resume', 'sid-proc-1', '-p'], (pid) => {
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-1')).toBe(true);
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-2')).toBe(false);
      expect(defaultIsHeadlessResumeTurn(pid, null)).toBe(false);
    });
    await withChild(['--resume', 'sid-proc-1'], (pid) => {
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-1')).toBe(false);
    });
  });

  it('a dead pid answers false (the existing ladder decides)', async () => {
    expect(defaultIsHeadlessResumeTurn(await deadPid(), 'sid-proc-1')).toBe(false);
  });
});
