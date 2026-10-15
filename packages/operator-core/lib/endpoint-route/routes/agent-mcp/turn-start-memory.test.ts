/**
 * turn-start-memory.test.ts — the turn-start injection endpoint's admission
 * behavior (context-injection-audit-2026-07-28 P-035 / F-E).
 *
 * The load-bearing case is the FIRST one: a SHORT prompt must reach the memory
 * pipeline. A `MIN_PROMPT_CHARS = 40` gate used to drop every prompt below 40
 * characters, and that gate is the audit's founding symptom — it silently
 * discarded the owner's 23-char question, a specific and entirely on-topic
 * prompt, because length was standing in as a proxy for relevance. F-B
 * (cosine-gated fusion) made the push path able to return zero on its own
 * merits, so the proxy was deleted with no replacement.
 *
 * These tests exist to stop it coming back: if anyone reintroduces a length
 * floor here — as a constant, an env var, or an inline `prompt.length <` — the
 * first two cases fail loudly rather than the regression being discovered
 * months later by an owner wondering why a short question got no memory.
 *
 * This endpoint previously had NO test file at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryWorkDeadline, type MemoryWorkDeadline } from '../../../memory/op-deadline';
import type { MemoryBlockBuildContext } from '../../../memory/injection-block-cache';
import {
  configureReadCursorStore,
  DELIVERY_TOKEN_KEY,
  InMemoryReadCursorStore,
  resetReadCursorStore,
  type AckConfirmation,
  type AckResult,
  type CursorState,
} from '../../../agent-tools/coordination/read-cursors';
import type { PackageOrientationClass } from '../../../agent-identities/package-orientation-classes';

const {
  buildMemoryContextBlockMock,
  preparePendingControlTransitionMock,
  markControlTransitionPreparedMock,
  failControlTransitionActivationMock,
  convergeActivationToLaunchRecordMock,
  applyRelaunchedActivationMock,
  acknowledgeControlTransitionMock,
  renderStackTransitionContextResultMock,
  detectHarnessSlugSyncMock,
  resolveAgentSignalsMock,
  recordInjectionCoverageMock,
  buildGrantedSourcesContextBlockMock,
  getMemoryBlockBoundedResultMock,
  withOptionalMemoryAdmissionMock,
  buildTurnStartOrientationBlockMock,
  readSuLaunchSpecByOwnerMock,
  readAdvSessionLaunchRecordByOwnerMock,
  evaluateTurnStartPackageSinkMock,
  packageSinkReceiptMock,
} = vi.hoisted(() => ({
  buildMemoryContextBlockMock: vi.fn(),
  preparePendingControlTransitionMock: vi.fn(),
  markControlTransitionPreparedMock: vi.fn(),
  failControlTransitionActivationMock: vi.fn(),
  convergeActivationToLaunchRecordMock: vi.fn(),
  applyRelaunchedActivationMock: vi.fn(),
  acknowledgeControlTransitionMock: vi.fn(),
  renderStackTransitionContextResultMock: vi.fn(),
  detectHarnessSlugSyncMock: vi.fn(),
  resolveAgentSignalsMock: vi.fn(),
  recordInjectionCoverageMock: vi.fn(),
  buildGrantedSourcesContextBlockMock: vi.fn(),
  getMemoryBlockBoundedResultMock: vi.fn(),
  withOptionalMemoryAdmissionMock: vi.fn(),
  buildTurnStartOrientationBlockMock: vi.fn(),
  readSuLaunchSpecByOwnerMock: vi.fn(),
  readAdvSessionLaunchRecordByOwnerMock: vi.fn(),
  evaluateTurnStartPackageSinkMock: vi.fn(),
  packageSinkReceiptMock: vi.fn(),
}));

// Same relative specifiers the source's dynamic imports use (this test is
// colocated under routes/agent-mcp/).
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: buildMemoryContextBlockMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-1' }) }));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  preparePendingControlTransition: preparePendingControlTransitionMock,
  markControlTransitionPrepared: markControlTransitionPreparedMock,
  failControlTransitionActivation: failControlTransitionActivationMock,
  convergeActivationToLaunchRecord: convergeActivationToLaunchRecordMock,
  applyRelaunchedActivation: applyRelaunchedActivationMock,
  acknowledgeControlTransition: acknowledgeControlTransitionMock,
  renderControlTransitionContext: (t: unknown) => `CTRL:${String((t as { kind?: string }).kind)}`,
}));
vi.mock('../../../stack-binding-channel', () => ({
  renderStackTransitionContextResult: renderStackTransitionContextResultMock,
}));
// Spread the real module: `adv-sessions` is PROTECTED because it has 74 exports,
// so a bare factory enumerating only what this test needs today silently strands
// the file the next time an export is added (WI-7187/WI-7185).
vi.mock('../../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../../adv-sessions')>()),
  readSuLaunchSpecByOwner: readSuLaunchSpecByOwnerMock,
  readAdvSessionLaunchRecordByOwner: readAdvSessionLaunchRecordByOwnerMock,
}));
vi.mock('../../../memory/detect-harness-slug', () => ({
  detectHarnessSlugSync: detectHarnessSlugSyncMock,
}));
vi.mock('../../../memory/agent-signals', () => ({
  resolveAgentSignalsForOwner: resolveAgentSignalsMock,
}));
vi.mock('../../../memory/injection-delivery-coverage', () => ({
  recordInjectionCoverage: recordInjectionCoverageMock,
}));
// enterprise-data-sources P-017: the route's fourth leg is the granted-sources
// builder (Personal Vault + subscribed organization sources + pot), which wraps
// the vault's ambient leg. Its own suites own the per-leg authorization.
vi.mock('../../../data-sources/granted-sources-injection', () => ({
  buildGrantedSourcesContextBlock: buildGrantedSourcesContextBlockMock,
}));
vi.mock('../../../memory/injection-block-cache', () => ({
  getMemoryBlockBoundedResult: getMemoryBlockBoundedResultMock,
}));
vi.mock('../../../memory/mid-turn-admission', () => ({
  withOptionalMemoryAdmission: withOptionalMemoryAdmissionMock,
}));
vi.mock('../../../turn-start-orientation', () => ({
  buildTurnStartOrientationBlock: buildTurnStartOrientationBlockMock,
}));
// The real sink reads the control anchor and the class registry; its own
// integration test owns that. Here only the endpoint's composition is measured.
vi.mock('../../../agent-identities/turn-start-package-sink', () => ({
  evaluateTurnStartPackageSink: evaluateTurnStartPackageSinkMock,
  packageSinkReceipt: packageSinkReceiptMock,
}));

import routes from './turn-start-memory';
import { setSessionConfinementResolver } from '../../../capability-envelope/session-confinement-port';

const endpoint = routes[0] as unknown as {
  handler: (req: Request) => Promise<Response>;
};

const post = async (body: unknown): Promise<{ ok: boolean; text: string; deliveryToken?: string }> => {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/turn-start-memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as { ok: boolean; text: string; deliveryToken?: string };
};

it('suppresses all live turn-start context before recall, control or package reads for frozen sessions', async () => {
  setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'],
    denyAmbientContext: true, reason: 'frozen benchmark', imposedBy: 'host' }));
  try {
    expect(await post({ owner: 'su-frozen', workspace: 'private', prompt: 'retrieve live context' })).toEqual({ ok: true, text: '' });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(preparePendingControlTransitionMock).not.toHaveBeenCalled();
    expect(evaluateTurnStartPackageSinkMock).not.toHaveBeenCalled();
  } finally { setSessionConfinementResolver(undefined); }
});

beforeEach(() => {
  setSessionConfinementResolver(() => null);
  configureReadCursorStore(new InMemoryReadCursorStore());
  buildMemoryContextBlockMock.mockReset().mockResolvedValue('MEM-BLOCK');
  preparePendingControlTransitionMock.mockReset().mockResolvedValue(null);
  markControlTransitionPreparedMock.mockReset().mockResolvedValue(true);
  failControlTransitionActivationMock.mockReset().mockResolvedValue(true);
  convergeActivationToLaunchRecordMock.mockReset().mockResolvedValue(false);
  applyRelaunchedActivationMock.mockReset().mockResolvedValue(false);
  acknowledgeControlTransitionMock.mockReset().mockResolvedValue(true);
  renderStackTransitionContextResultMock.mockReset().mockResolvedValue({ text: '', rendered: true });
  detectHarnessSlugSyncMock.mockReset().mockReturnValue({ slug: null, source: null });
  resolveAgentSignalsMock.mockReset().mockResolvedValue(undefined);
  recordInjectionCoverageMock.mockReset().mockResolvedValue(undefined);
  buildGrantedSourcesContextBlockMock.mockReset().mockResolvedValue(null);
  withOptionalMemoryAdmissionMock.mockReset().mockImplementation(async (run: () => Promise<unknown>) => ({
    admitted: true,
    value: await run(),
  }));
  getMemoryBlockBoundedResultMock
    .mockReset()
    .mockImplementation(
      async (
        _workspaceId: string,
        _scopeKey: string,
        build: (deadline: MemoryWorkDeadline, ctx: MemoryBlockBuildContext) => Promise<string | null>,
      ) => {
        const deadline = createMemoryWorkDeadline(2000);
        try {
          // A cold miss: the caller waits on this build (the real cache's contract).
          return { status: 'ready', block: await build(deadline, { callerWaiting: () => true }) };
        } finally {
          deadline.close();
        }
      },
    );
  buildTurnStartOrientationBlockMock.mockReset().mockResolvedValue({ block: '', deliveryToken: null });
  readSuLaunchSpecByOwnerMock.mockReset().mockResolvedValue(null);
  readAdvSessionLaunchRecordByOwnerMock.mockReset().mockResolvedValue(null);
  evaluateTurnStartPackageSinkMock.mockReset().mockResolvedValue({ result: null, classes: [] });
  packageSinkReceiptMock.mockReset().mockReturnValue(null);
});
afterEach(() => resetReadCursorStore());

/**
 * The coverage write is fire-and-forget (`void`, never awaited) and reaches its
 * module through a dynamic import, so it lands a few microtasks AFTER the
 * response resolves. Settle the queue before asserting — otherwise these tests
 * would pass or fail on scheduling luck, which is worse than not having them.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('turn-start-memory admission (F-E: no length floor)', () => {
  it('preserves bound-plan orientation and eligible memory alongside cited knowledge with server-bound agent scope', async () => {
    detectHarnessSlugSyncMock.mockReturnValue({ slug: 'papercusp',source: 'meta-papercup' });
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: '## Orientation\nBound plan: current repair requirement',deliveryToken: null });
    buildMemoryContextBlockMock.mockResolvedValue('Relevant memory: retain verified snapshot\n\n'
      + 'Related context: [plan other-repair] tail decision; [doc repair-runbook] prerequisite; [report rpt-repair] dated evidence');
    const out = await post({ owner: 'su-knowledge-reader',prompt: 'repair the queue boundary',harness: 'papercusp',client: 'codex' });
    expect(out.text).toContain('Bound plan: current repair requirement');
    expect(out.text).toContain('retain verified snapshot');
    expect(out.text).toContain('[plan other-repair]');
    expect(out.text).toContain('[doc repair-runbook] prerequisite');
    expect(out.text).toContain('[report rpt-repair] dated evidence');
    expect(buildMemoryContextBlockMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-test',harnessSlugs: ['papercusp'],session: expect.objectContaining({ sessionId: 'su-knowledge-reader',client: 'codex' }),
    }));
  });
  it('shares the host-wide optional-memory admission and preserves orientation when capacity is full', async () => {
    withOptionalMemoryAdmissionMock.mockResolvedValueOnce({ admitted: false, reason: 'at_capacity' });
    buildTurnStartOrientationBlockMock.mockResolvedValue({
      block: '## Orientation\n- continue without optional recall',
      deliveryToken: null,
    });

    const out = await post({ owner: 'sess-1', prompt: 'continue', harness: 'papercusp' });
    await settle();

    expect(withOptionalMemoryAdmissionMock).toHaveBeenCalledOnce();
    expect(getMemoryBlockBoundedResultMock).not.toHaveBeenCalled();
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(recordInjectionCoverageMock).not.toHaveBeenCalled();
    expect(out.text).toContain('continue without optional recall');
  });

  it('returns orientation when memory misses its bounded deadline, without recording healthy quiet', async () => {
    getMemoryBlockBoundedResultMock.mockResolvedValue({ status: 'deadline', block: null });
    buildTurnStartOrientationBlockMock.mockResolvedValue({
      block: '## Orientation\n- improvement triage: top EI-1',
      deliveryToken: null,
    });

    const out = await post({ owner: 'sess-1', prompt: 'continue', harness: 'papercusp' });
    await settle();

    expect(out.text).toContain('improvement triage: top EI-1');
    expect(out.text).not.toContain('MEM-BLOCK');
    expect(getMemoryBlockBoundedResultMock).toHaveBeenCalledWith('ws-test', 'turn-start:sess-1', expect.any(Function), { sessionId: 'sess-1' });
    expect(recordInjectionCoverageMock).not.toHaveBeenCalled();
  });

  it("a 23-char prompt REACHES the memory pipeline — the audit's founding symptom", async () => {
    // Verbatim length of the owner prompt the old 40-char gate dropped.
    const prompt = 'why is recall empty??!';
    expect(prompt.length).toBeLessThan(40);

    const out = await post({ owner: 'sess-1', prompt, harness: 'papercusp' });

    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toContain('MEM-BLOCK');
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      // P-044: the structured form. `userText` is the COSINE leg's query and is
      // still the human's words alone — deliberately, since identifiers were
      // measured diluting that vector (D-041).
      queryContext: { userText: prompt },
      harnessSlugs: ['papercusp'],
      session: { sessionId: 'sess-1', port: 'turn-start' },
      // WI-10004485: the deadline-bound turn-start build overlaps the gated
      // lexical leg with the cosine leg instead of running them in series.
      overlapGatedLexical: true,
    });
    // WI-10004485: the cache says whether anyone still waits on this build, so a
    // background rebuild is not bounded by a hook wall nobody is behind.
    const { callerWaiting } = buildMemoryContextBlockMock.mock.calls[0]![0] as { callerWaiting?: () => boolean };
    expect(typeof callerWaiting).toBe('function');
    expect(callerWaiting!()).toBe(true);
  });

  it("even a 1-char prompt reaches it — relevance is the floor's job, not the length's", async () => {
    await post({ owner: 'sess-1', prompt: 'y' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('a signal-free prompt injects NOTHING when the pipeline finds nothing — the real gate', async () => {
    // The point of F-E: "continue" is filtered by RELEVANCE returning no hits,
    // not by a character count refusing to ask. Same prompt the old gate
    // dropped a priori; now it is asked and answered honestly.
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'continue' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('');
  });

  it('memoryEnabled:false still skips recall — the ONE admission gate that remains', async () => {
    await post({ owner: 'sess-1', prompt: 'a real question about the deploy pipeline', memoryEnabled: false });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
  });

  it('clamps a very long prompt to the query head rather than embedding a pasted document', async () => {
    await post({ owner: 'sess-1', prompt: 'x'.repeat(5_000) });
    const { queryContext } = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: { userText: string };
    };
    expect(queryContext.userText).toHaveLength(1_000);
  });

  it('CTRL is delivered even for a prompt carrying no recall signal at all', async () => {
    // A mode/loop/carry/route transition must take effect at the very next
    // boundary, so it is deliberately NOT subject to any prompt gating.
    preparePendingControlTransitionMock.mockResolvedValue({ kind: 'mode', generation: 1 });
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'ok' });
    expect(out.text).toBe('CTRL:mode');
  });

  it('retries a failed stack render, then acknowledges the generation exactly once after recovery', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const transition = { kind: 'mode', generation: 7 };
    let pending = true;
    preparePendingControlTransitionMock.mockImplementation(async () => (pending ? transition : null));
    renderStackTransitionContextResultMock
      .mockResolvedValueOnce({ text: '', rendered: false })
      .mockResolvedValueOnce({ text: 'STACK-RECOVERED', rendered: true });
    acknowledgeControlTransitionMock.mockImplementation(async () => {
      pending = false;
      return true;
    });

    const failed = await post({ owner: 'sess-1', prompt: 'first attempt' });
    expect(failed.ok).toBe(true);
    expect(failed.text).toBe('CTRL:mode');
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();

    const recovered = await post({ owner: 'sess-1', prompt: 'retry' });
    expect(recovered.text).toBe('CTRL:mode\n\nSTACK-RECOVERED');
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();

    const settled = await post({
      owner: 'sess-1',
      prompt: 'after recovery',
      confirmedDelivery: recovered.deliveryToken,
    });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 7, undefined, undefined);
    expect(settled.text).toBe('');
    expect(preparePendingControlTransitionMock).toHaveBeenCalledTimes(3);
    expect(renderStackTransitionContextResultMock).toHaveBeenCalledTimes(2);
    // No activation rides this transition, so there is no authority to converge.
    expect(convergeActivationToLaunchRecordMock).not.toHaveBeenCalled();
  });

  // EI-23886889674609842 defect #1: a failed render must not strand `applied` behind
  // a relaunch — but must never be ACKNOWLEDGED either (the stack block stays pending).
  it('on a failed render with an activation, records the failure then offers convergence — never an ack', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const desired = { specificationRevision: 'spec-new', stateRevision: 'state-new' };
    preparePendingControlTransitionMock.mockResolvedValue({
      kind: 'mode',
      generation: 8,
      state: { activation: { desired } },
    });
    renderStackTransitionContextResultMock.mockResolvedValue({ text: '', rendered: false });

    const out = await post({ owner: 'sess-1', prompt: 'render fails' });
    expect(out.text).toBe('CTRL:mode');
    expect(failControlTransitionActivationMock).toHaveBeenCalledWith(
      'sess-1',
      'ws-test',
      8,
      desired,
      'stack transition render failed',
    );
    expect(convergeActivationToLaunchRecordMock).toHaveBeenCalledWith('sess-1', 'ws-test', 8, desired);
    expect(markControlTransitionPreparedMock).not.toHaveBeenCalled();
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('fail-soft: a throwing memory pipeline never surfaces an error into the turn', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildMemoryContextBlockMock.mockRejectedValue(new Error('backend down'));
    const out = await post({ owner: 'sess-1', prompt: 'a question about storage policy' });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
    expect(warning).toHaveBeenCalledWith('[turn-start] memory path failed (context omitted):', 'backend down');
  });

  // EI-18893248175645463: an operator/superuser-scope session never sends
  // `harness` (PAPERCUSP_HARNESS_SLUG is only exported for harness-scoped
  // spawns) — measured live, this starved the harness+hive memory pools for
  // that session's ENTIRE lifetime, not just an occasional miss. `cwd`
  // fallback detection closes that gap.
  describe('cwd fallback (EI-18893248175645463)', () => {
    it('no harness in body, but cwd resolves one → harnessSlugs carries it', async () => {
      detectHarnessSlugSyncMock.mockReturnValue({ slug: 'papercusp', source: 'meta-papercup' });
      await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/home/dev/papercupai-workspace/papercup' });
      expect(detectHarnessSlugSyncMock).toHaveBeenCalledWith({ cwd: '/home/dev/papercupai-workspace/papercup' });
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: ['papercusp'] });
    });

    it('an explicit harness in body WINS over cwd detection — never overridden', async () => {
      await post({
        owner: 'sess-1',
        prompt: 'a real question',
        harness: 'papercusp-public-site',
        cwd: '/some/other/dir',
      });
      expect(detectHarnessSlugSyncMock).not.toHaveBeenCalled();
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: ['papercusp-public-site'] });
    });

    it('no harness, no cwd → stays bare (unchanged behavior)', async () => {
      await post({ owner: 'sess-1', prompt: 'a real question' });
      expect(detectHarnessSlugSyncMock).not.toHaveBeenCalled();
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });

    it('no harness, cwd given but detection finds nothing → stays bare, never throws', async () => {
      detectHarnessSlugSyncMock.mockReturnValue({ slug: null, source: null });
      const out = await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/tmp/nowhere' });
      expect(out.ok).toBe(true);
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });

    it('detection throwing degrades to bare rather than failing the turn', async () => {
      detectHarnessSlugSyncMock.mockImplementation(() => {
        throw new Error('fs boom');
      });
      const out = await post({ owner: 'sess-1', prompt: 'a real question', cwd: '/tmp/nowhere' });
      expect(out.ok).toBe(true);
      expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({ harnessSlugs: [] });
    });
  });

  it('requires an owner', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/turn-start-memory', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'a question' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('agent signals reach the query (context-injection-audit-2026-07-28 P-044 / F-L)', () => {
  const signals = {
    workItem: { id: 'WI-6512' },
    trajectory: { paths: ['apps/operator-vite/src/components/HistoryDropdown.tsx'] },
  };

  it('carries resolved signals into queryContext — the wiring, not just the composition', async () => {
    // Without this the resolver is built, tested and NEVER CALLED in production:
    // `recall-query`'s unit tests would still pass and the feature would be dead
    // code. This asserts the endpoint actually asks for signals and passes them on.
    resolveAgentSignalsMock.mockResolvedValue(signals);
    await post({ owner: 'sess-1', prompt: 'why is session history slow', cwd: '/repo' });
    expect(resolveAgentSignalsMock).toHaveBeenCalledTimes(1);
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      queryContext: { userText: 'why is session history slow', agentSignals: signals },
    });
  });

  it('omits agentSignals entirely when none resolve — not an empty object', async () => {
    // `lexicalQueryText` returns undefined for absent signals, which is what
    // keeps the no-signals turn byte-identical to pre-P-044. An empty object
    // would be indistinguishable at the seam but is a different claim.
    resolveAgentSignalsMock.mockResolvedValue(undefined);
    await post({ owner: 'sess-1', prompt: 'why is session history slow' });
    const { queryContext } = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: Record<string, unknown>;
    };
    expect(queryContext).not.toHaveProperty('agentSignals');
  });

  it('a THROWING resolver degrades to no signals rather than failing the turn', async () => {
    resolveAgentSignalsMock.mockRejectedValue(new Error('pg down'));
    const out = await post({ owner: 'sess-1', prompt: 'why is session history slow' });
    expect(out.text).toContain('MEM-BLOCK');
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      queryContext: { userText: 'why is session history slow' },
    });
  });
});

describe('granted-sources leg (Personal Vault + subscribed sources + pot)', () => {
  it('renders granted source context as a separate block after general memory', async () => {
    buildGrantedSourcesContextBlockMock.mockResolvedValue('VAULT-BLOCK');

    const out = await post({
      owner: 'meeting-prep-run-1',
      prompt: 'prepare me for the Acme review',
      workspace: 'ws-test',
    });

    expect(out.text).toBe('MEM-BLOCK\n\nVAULT-BLOCK');
    expect(buildGrantedSourcesContextBlockMock).toHaveBeenCalledWith({
      ownerId: 'meeting-prep-run-1',
      userId: 'u-1',
      workspaceId: 'ws-test',
      query: 'prepare me for the Acme review',
      // No launch record for this owner: the session is unknown, judged by dataUse only.
      session: null,
    });
  });

  // enterprise-readiness P-007 (WI-6554700010011738): the leg is judged against the
  // RECEIVING session's provider, resolved from its newest launch record.
  it('passes the receiving session backend/model from its launch record', async () => {
    buildGrantedSourcesContextBlockMock.mockResolvedValue('VAULT-BLOCK');
    readAdvSessionLaunchRecordByOwnerMock.mockResolvedValue({
      workspaceId: 'ws-test',
      agent: 'codex',
      launchSpec: { agent: 'codex', model: 'gpt-5.5:high' },
      launchArgv: null,
    });

    await post({ owner: 'su-codex-1', prompt: 'summarize the org policy', workspace: 'ws-test' });

    expect(readAdvSessionLaunchRecordByOwnerMock).toHaveBeenCalledWith('su-codex-1');
    expect(buildGrantedSourcesContextBlockMock.mock.calls[0]![0]).toMatchObject({
      ownerId: 'su-codex-1',
      session: { agent: 'codex', model: 'gpt-5.5:high' },
    });
  });

  it('an unreadable launch record leaves the session unknown instead of failing the leg', async () => {
    buildGrantedSourcesContextBlockMock.mockResolvedValue('VAULT-BLOCK');
    readAdvSessionLaunchRecordByOwnerMock.mockRejectedValue(new Error('adv_sessions unreachable'));

    const out = await post({ owner: 'su-x', prompt: 'prepare me for the Acme review', workspace: 'ws-test' });

    expect(out.text).toBe('MEM-BLOCK\n\nVAULT-BLOCK');
    expect(buildGrantedSourcesContextBlockMock.mock.calls[0]![0]).toMatchObject({ session: null });
  });

  it('injects nothing when authorization refuses the caller', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    buildGrantedSourcesContextBlockMock.mockResolvedValue(null);

    const out = await post({ owner: 'coding-agent-1', prompt: 'search the owner vault' });

    expect(out.text).toBe('');
    expect(buildGrantedSourcesContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('does not even invoke personal recall when turn-start memory is disabled', async () => {
    const out = await post({
      owner: 'meeting-prep-run-1',
      prompt: 'prepare me for the Acme review',
      memoryEnabled: false,
    });

    expect(out.text).toBe('');
    expect(buildGrantedSourcesContextBlockMock).not.toHaveBeenCalled();
  });
});

/**
 * ACK-ON-PROOF pass-through (owner-directive-delivery-redesign-2026-09-22 P-005).
 * The endpoint only relays: the key's PRESENCE in the body opts in, so an old
 * hook that never sends it must reach the orientation builder with no token
 * argument at all, not with a null that would discard its every delivery.
 */
describe('orientation delivery token relay (P-005)', () => {
  it('relays a confirmed token in and the new delivery token out', async () => {
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: '## Orientation\n- x', deliveryToken: 'tok-2' });

    const out = await post({ owner: 'sess-1', prompt: 'go', confirmedDelivery: 'tok-1' });

    expect(buildTurnStartOrientationBlockMock.mock.calls[0]![0]).toMatchObject({ confirmedDeliveryToken: 'tok-1' });
    expect(out.deliveryToken).toBe('tok-2');
    expect(out.text).toContain('## Orientation');
  });

  it('an explicit null opts in with nothing proven', async () => {
    await post({ owner: 'sess-1', prompt: 'go', confirmedDelivery: null });

    expect(buildTurnStartOrientationBlockMock.mock.calls[0]![0]).toMatchObject({ confirmedDeliveryToken: null });
  });

  it('a hook that omits the key stays on ack-on-arrival and gets no token field', async () => {
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: '## Orientation\n- x', deliveryToken: null });

    const out = await post({ owner: 'sess-1', prompt: 'go' });

    expect(buildTurnStartOrientationBlockMock.mock.calls[0]![0]).not.toHaveProperty('confirmedDeliveryToken');
    expect(out).not.toHaveProperty('deliveryToken');
  });
});

/**
 * Delivery-coverage emission (WI-37597).
 *
 * `recordInjectionCoverage` used to be called from `mid-turn-context.ts` and
 * nowhere else, so `context_injection_coverage` had never held a single
 * `turn-start` row for any client. The detector that answers "is this client
 * being served context?" was therefore structurally blind to a turn-start
 * outage — which is why EI-20001110634702380, a real turn-start injection
 * failure, closed cause-undetermined.
 *
 * ⚠ The near-miss that made this hard to see: this file ALREADY contained
 * `port: 'turn-start'`, on the `session` object feeding memory_recall_stats —
 * a DIFFERENT SINK. A grep for the port literal said "covered" while the
 * counter had never been written. These cases assert the RECORDER was called,
 * never that the string appears.
 */
describe('turn-start delivery coverage (WI-37597)', () => {
  it('records a recalled event, attributed to the calling client', async () => {
    await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();

    expect(recordInjectionCoverageMock).toHaveBeenCalledTimes(1);
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'recalled', client: 'omp' }),
    ]);
  });

  it('records no-recall when the pipeline returns nothing — healthy quiet is still a reading', async () => {
    // The whole point: a silent turn is DISTINGUISHABLE from a dead hook only
    // because the silent one still writes a row.
    buildMemoryContextBlockMock.mockResolvedValue(null);
    await post({ owner: 'sess-1', prompt: 'a prompt that matches nothing', client: 'claude' });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'no-recall' }),
    ]);
  });

  it('records no-signal when the caller opted out of memory', async () => {
    // Not an outage. Recording nothing here would make a client that always
    // disables memory indistinguishable from one whose hook is dead.
    await post({ owner: 'sess-1', prompt: 'anything', client: 'codex', memoryEnabled: false });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', outcome: 'no-signal', client: 'codex' }),
    ]);
  });

  it('records an UNATTRIBUTED client rather than inventing one', async () => {
    // A caller without the P-005 threading records '' — a real reading. Guessing
    // a client name here would manufacture coverage for a client that may not
    // have sent the request.
    await post({ owner: 'sess-1', prompt: 'no client field here' });
    await settle();
    expect(recordInjectionCoverageMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ port: 'turn-start', client: '' }),
    ]);
  });

  it('records NOTHING when the pipeline throws — a fault must not read as healthy quiet', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The outcome vocabulary has no failure value, and 'no-recall' means healthy
    // quiet, so recording it would actively hide the fault. Writing nothing
    // leaves the turn absent from the numerator, which the outage detector
    // already reads as broken.
    buildMemoryContextBlockMock.mockRejectedValue(new Error('pg down'));
    const out = await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();
    expect(out.ok).toBe(true); // still fail-soft — the turn is never harmed
    expect(warning).toHaveBeenCalledWith('[turn-start] memory path failed (context omitted):', expect.any(String));
    expect(recordInjectionCoverageMock).not.toHaveBeenCalled();
  });

  it('never lets a failing coverage write harm the turn', async () => {
    // The recorder swallows its own errors, but the call site must survive one
    // regardless — this endpoint's whole contract is that it cannot cost a turn.
    recordInjectionCoverageMock.mockRejectedValue(new Error('coverage table gone'));
    const out = await post({ owner: 'sess-1', prompt: 'why is recall empty', client: 'omp' });
    await settle();
    expect(out.ok).toBe(true);
    expect(out.text).toContain('MEM-BLOCK');
  });
});

/**
 * WI-10002021 — `requiresFreshContext` means "a successor host must carry this before
 * it is acknowledged". That is a WAIT, but nothing ended it on its own: `stackBefore`
 * is rewritten ONLY when the control STATE next changes (control-anchor's ON CONFLICT
 * clause), never by acknowledgement. So the successor recomputed the identical
 * stackBefore→state.stack diff, got `relaunch-with-carry` again, skipped prepare+ack
 * again, and `applied` never converged to the specification it was actually running —
 * after which identity-grants-port reads current !== applied and denies
 * 'stale-artifact' on EVERY tool for the life of the session, including the
 * coord:orient recovery door. A wait with no terminating condition is a veto.
 *
 * The wait genuinely ends when THIS session's own launch record carries the desired
 * specification: the relaunch already happened and we are the successor.
 */
describe('relaunch-with-carry convergence (WI-10002021)', () => {
  const desired = { specificationRevision: 'spec-new', stateRevision: 'state-new' };
  const transitionWithActivation = {
    kind: 'stack',
    generation: 11,
    state: { activation: { desired } },
  };

  const armRelaunchWithCarry = () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue(transitionWithActivation);
    renderStackTransitionContextResultMock.mockResolvedValue({
      text: 'STACK-LAYER',
      rendered: true,
      requiresFreshContext: true,
    });
  };

  it('withholds acknowledgement while the launch record still predates the desired spec', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-old' });

    const out = await post({ owner: 'sess-1', prompt: 'before the relaunch' });

    expect(out.text).toBe('CTRL:stack\n\nSTACK-LAYER');
    expect(markControlTransitionPreparedMock).not.toHaveBeenCalled();
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    expect(convergeActivationToLaunchRecordMock).not.toHaveBeenCalled();
  });

  it('converges once the launch record carries the desired spec — the successor IS the fresh context', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-new' });

    const out = await post({ owner: 'sess-1', prompt: 'after the relaunch' });

    expect(out.text).toBe('CTRL:stack\n\nSTACK-LAYER');
    expect(markControlTransitionPreparedMock).toHaveBeenCalledWith('sess-1', 'ws-test', 11, desired);
    expect(convergeActivationToLaunchRecordMock).toHaveBeenCalledWith('sess-1', 'ws-test', 11, desired);
    expect(convergeActivationToLaunchRecordMock.mock.invocationCallOrder[0]).toBeLessThan(
      markControlTransitionPreparedMock.mock.invocationCallOrder[0]!,
    );
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    await post({ owner: 'sess-1', prompt: 'host emitted the successor layer', confirmedDelivery: out.deliveryToken });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 11, undefined, desired);
  });

  it('a never-advancing launch record still never converges — the permanent-skip loop, pinned', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-old' });

    for (const prompt of ['turn one', 'turn two', 'turn three']) {
      await post({ owner: 'sess-1', prompt });
    }

    // Identical diff on every turn: this is exactly the loop that used to run for the
    // life of the session. The test above is what makes it terminate on a real relaunch.
    expect(renderStackTransitionContextResultMock).toHaveBeenCalledTimes(3);
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('keeps waiting when the launch record is unreadable — never acknowledges on a fault', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockRejectedValue(new Error('adv_sessions unreachable'));

    const out = await post({ owner: 'sess-1', prompt: 'launch record down' });

    expect(out.ok).toBe(true); // fail-soft: a read fault never costs the turn
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('keeps waiting when the launch record carries no specificationRevision at all', async () => {
    armRelaunchWithCarry();
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ harnessSlug: 'papercusp' });

    await post({ owner: 'sess-1', prompt: 'legacy launch record' });

    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it('does not consult the launch record at all for an ordinary in-place transition', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue(transitionWithActivation);
    renderStackTransitionContextResultMock.mockResolvedValue({
      text: 'STACK-LAYER',
      rendered: true,
      requiresFreshContext: false,
    });

    const out = await post({ owner: 'sess-1', prompt: 'in-place mode flip' });
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    await post({ owner: 'sess-1', prompt: 'host emitted the layer', confirmedDelivery: out.deliveryToken });

    expect(readSuLaunchSpecByOwnerMock).not.toHaveBeenCalled();
    expect(convergeActivationToLaunchRecordMock).not.toHaveBeenCalled();
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * WI-10003459 (residual): a carry-respawn's launch artifact IS the consumption of
 * `desired`. Turn-start offers the launch-proven receipt on the FIRST turn after a
 * relaunch — before prepare, without touching the delivery ack — so the new
 * process's usage never bills the predecessor's revision for a whole turn. The
 * restart/launch-record guards live in applyRelaunchedActivation (real-PG tested in
 * session-identity-attribution.integration.test.ts); here we pin the call contract.
 */
describe('carry-respawn applies at the relaunch, not a turn later (WI-10003459)', () => {
  const desired = { specificationRevision: 'spec-relaunched', stateRevision: 'state-relaunched' };
  const arm = (requiresFreshContext: boolean) => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue({
      kind: 'mode',
      generation: 21,
      state: { activation: { desired } },
    });
    renderStackTransitionContextResultMock.mockResolvedValue({ text: 'STACK', rendered: true, requiresFreshContext });
    readSuLaunchSpecByOwnerMock.mockResolvedValue({ specificationRevision: 'spec-relaunched' });
  };

  it('offers the launch-proven receipt before prepare on the first turn, and still defers the ack', async () => {
    arm(false);
    applyRelaunchedActivationMock.mockResolvedValue(true);

    const out = await post({ owner: 'sess-1', prompt: 'first turn after carry-respawn' });

    expect(out.text).toBe('CTRL:mode\n\nSTACK');
    expect(applyRelaunchedActivationMock).toHaveBeenCalledTimes(1);
    expect(applyRelaunchedActivationMock).toHaveBeenCalledWith('sess-1', 'ws-test', 21, desired);
    expect(applyRelaunchedActivationMock.mock.invocationCallOrder[0]).toBeLessThan(
      markControlTransitionPreparedMock.mock.invocationCallOrder[0]!,
    );
    // Authority/attribution moved; the prompt text still awaits delivery proof.
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    expect(out.deliveryToken).toBeTruthy();
    await post({ owner: 'sess-1', prompt: 'second turn', confirmedDelivery: out.deliveryToken });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 21, undefined, desired);
  });

  it('is offered on the relaunch-with-carry path too, ahead of the denial rescue', async () => {
    arm(true);

    await post({ owner: 'sess-1', prompt: 'successor of a stack relaunch' });

    expect(applyRelaunchedActivationMock).toHaveBeenCalledWith('sess-1', 'ws-test', 21, desired);
    expect(applyRelaunchedActivationMock.mock.invocationCallOrder[0]).toBeLessThan(
      convergeActivationToLaunchRecordMock.mock.invocationCallOrder[0]!,
    );
  });

  it('a refused or throwing receipt never costs the turn — prepare and delivery proceed', async () => {
    arm(false);
    applyRelaunchedActivationMock.mockRejectedValue(new Error('pg down'));

    const out = await post({ owner: 'sess-1', prompt: 'receipt write fails' });

    expect(out.text).toBe('CTRL:mode\n\nSTACK');
    expect(markControlTransitionPreparedMock).toHaveBeenCalledWith('sess-1', 'ws-test', 21, desired);
    expect(out.deliveryToken).toBeTruthy();
  });

  it('is never offered when no activation rides the transition, or the stack failed to render', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    preparePendingControlTransitionMock.mockResolvedValue({ kind: 'mode', generation: 22, state: {} });
    await post({ owner: 'sess-1', prompt: 'no activation' });
    expect(applyRelaunchedActivationMock).not.toHaveBeenCalled();

    preparePendingControlTransitionMock.mockResolvedValue({
      kind: 'mode',
      generation: 23,
      state: { activation: { desired } },
    });
    renderStackTransitionContextResultMock.mockResolvedValue({ text: '', rendered: false });
    await post({ owner: 'sess-1', prompt: 'render failed' });
    expect(applyRelaunchedActivationMock).not.toHaveBeenCalled();
  });
});

describe('control activation waits for host emission (WI-10003297)', () => {
  const desired = { specificationRevision: 'spec-new', stateRevision: 'state-new' };
  beforeEach(() => {
    let pending = true;
    preparePendingControlTransitionMock.mockImplementation(async () =>
      pending ? { kind: 'stack', generation: 12, state: { activation: { desired } } } : null,
    );
    acknowledgeControlTransitionMock.mockImplementation(async () => {
      pending = false;
      return true;
    });
    renderStackTransitionContextResultMock.mockResolvedValue({ text: 'IDENTITY-LAYER', rendered: true });
    buildMemoryContextBlockMock.mockResolvedValue(null);
  });

  const assertNoAcknowledgmentBeforeResponse = async () => {
    let release!: () => void;
    const delayed = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    buildGrantedSourcesContextBlockMock.mockReturnValueOnce(delayed);
    const request = post({ owner: 'sess-1', prompt: 'slow response', confirmedDelivery: null });
    try {
      await vi.waitFor(() => expect(markControlTransitionPreparedMock).toHaveBeenCalled());
      // The hook can time out now. Nothing has reached the host yet.
      expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    } finally {
      release();
      await request;
    }
    return await request;
  };

  it('does not mark Applied while another response leg is pending or after an unconfirmed response', async () => {
    const dropped = await assertNoAcknowledgmentBeforeResponse();
    expect(dropped.deliveryToken).toBeTruthy();
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    const retry = await post({ owner: 'sess-1', prompt: 'next turn after timeout', confirmedDelivery: null });
    expect(retry.text).toContain('IDENTITY-LAYER');
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    const confirmed = await post({ owner: 'sess-1', prompt: 'emitted retry', confirmedDelivery: retry.deliveryToken });
    expect(confirmed.text).not.toContain('IDENTITY-LAYER');
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-1', 'ws-test', 12, undefined, desired);
    await post({ owner: 'sess-1', prompt: 'later turn', confirmedDelivery: retry.deliveryToken });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
  });

  it('negative control: the same oracle catches an acknowledgment during preparation', async () => {
    // Permanent fault injection at the existing dependency seam reproduces the
    // pre-fix ordering without ever mutating shared production source.
    markControlTransitionPreparedMock.mockImplementation(async () => {
      await acknowledgeControlTransitionMock('sess-1', 'ws-test', 12, undefined, desired);
      return true;
    });
    await expect(assertNoAcknowledgmentBeforeResponse()).rejects.toThrow('not be called');
  });

  it('preserves delivery when staging fails and never treats orientation proof as control proof', async () => {
    class UnavailableStore extends InMemoryReadCursorStore {
      override async stage(): Promise<void> {
        throw new Error('store unavailable');
      }
    }
    configureReadCursorStore(new UnavailableStore());
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: 'ORIENTATION', deliveryToken: 'orientation-only' });
    const offered = await post({ owner: 'sess-1', prompt: 'offer' });
    expect(offered.text).toContain('IDENTITY-LAYER');
    expect(offered.deliveryToken).toBe('orientation-only');
    await post({ owner: 'sess-1', prompt: 'confirmed orientation only', confirmedDelivery: offered.deliveryToken });
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
  });

  it.each([null, 'wrong-token', undefined])(
    'redelivers when the host confirms %s instead of the offered token',
    async (token) => {
      await post({ owner: 'sess-1', prompt: 'offer' });
      const retry = await post({ owner: 'sess-1', prompt: 'unproved', confirmedDelivery: token });
      expect(retry.text).toContain('IDENTITY-LAYER');
      expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    },
  );

  it('shares orientation proof, but never applies another session from its token', async () => {
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: 'ORIENTATION', deliveryToken: 'shared-token' });
    const offered = await post({ owner: 'sess-1', prompt: 'offer' });
    expect(offered.deliveryToken).toBe('shared-token');
    await post({ owner: 'sess-other', prompt: 'wrong session', confirmedDelivery: offered.deliveryToken });
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    await post({ owner: 'sess-1', prompt: 'right session', confirmedDelivery: offered.deliveryToken });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed acknowledgment from the committed delivery proof', async () => {
    const offered = await post({ owner: 'sess-1', prompt: 'offer' });
    acknowledgeControlTransitionMock.mockRejectedValueOnce(new Error('write unavailable'));
    await post({ owner: 'sess-1', prompt: 'confirm', confirmedDelivery: offered.deliveryToken });
    const recovered = await post({ owner: 'sess-1', prompt: 'retry committed proof', confirmedDelivery: null });
    expect(recovered.text).not.toContain('IDENTITY-LAYER');
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledTimes(2);
  });
});

describe('portable-identity P-010 package sink', () => {
  const SURFACE = 'turn-start-package-sink';
  const PLATFORM = '## Orientation\n- platform row';
  const brief: PackageOrientationClass = {
    id: 'package:pkg-a/brief',
    identityId: 'pkg-a',
    contributionId: 'brief',
    applicableSinks: ['turn-start'],
    order: 0,
    rowCeiling: { maxRows: 3, recoveryVerb: 'x' },
    render: () => ['- pkg-a/brief: hello'],
  };

  /** Records what the endpoint stages, and what each ACK commits, on the package surface. */
  class RecordingStore extends InMemoryReadCursorStore {
    readonly staged: CursorState[] = [];
    readonly committed: Array<CursorState | null> = [];
    override async stage(ownerId: string, surface: string, next: CursorState): Promise<void> {
      if (surface === SURFACE) this.staged.push({ ownerId, ...next });
      return super.stage(ownerId, surface, next);
    }
    override async ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation): Promise<AckResult> {
      const out = await super.ackAndRead(ownerId, surface, confirmation);
      if (surface === SURFACE) this.committed.push(out.committed);
      return out;
    }
  }
  let store: RecordingStore;
  beforeEach(() => {
    store = new RecordingStore();
    configureReadCursorStore(store);
  });

  it('appends package rows after the platform block and stages a rendered receipt under the delivered token', async () => {
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: PLATFORM, deliveryToken: 'tok-o' });
    evaluateTurnStartPackageSinkMock.mockResolvedValue({ result: null, classes: [brief] });
    packageSinkReceiptMock.mockReturnValue({ version: 1, status: 'rendered' });
    const out = await post({ owner: 'sess-1', prompt: 'package turn' });
    expect(out.text).toBe(`${PLATFORM}\n- pkg-a/brief: hello\n\nMEM-BLOCK`);
    expect(out.deliveryToken).toBe('tok-o');
    expect(store.staged).toEqual([
      { ownerId: 'sess-1', version: 1, status: 'rendered', rendered: true, [DELIVERY_TOKEN_KEY]: 'tok-o' },
    ]);
  });

  it('stages rendered:false under a minted token when the sink returns a receipt but no rows', async () => {
    packageSinkReceiptMock.mockReturnValue({ version: 1, status: 'fenced' });
    const out = await post({ owner: 'sess-1', prompt: 'fenced turn' });
    expect(out.text).toBe('MEM-BLOCK');
    expect(out.deliveryToken).toEqual(expect.any(String));
    expect(store.staged).toEqual([
      { ownerId: 'sess-1', version: 1, status: 'fenced', rendered: false, [DELIVERY_TOKEN_KEY]: out.deliveryToken },
    ]);
  });

  it('a rejecting sink costs only its rows: platform orientation and memory are still delivered', async () => {
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: PLATFORM, deliveryToken: 'tok-o' });
    evaluateTurnStartPackageSinkMock.mockRejectedValue(new Error('provider exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await post({ owner: 'sess-1', prompt: 'sink fails' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn-start:package-sink failed: provider exploded'));
    warn.mockRestore();
    // Non-vacuous: the sink really ran and rejected (an unreachable sink also
    // renders nothing — that is how a missing import once passed this test).
    expect(evaluateTurnStartPackageSinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'sess-1', workspaceId: 'ws-test' }),
    );
    expect(out).toEqual({ ok: true, text: `${PLATFORM}\n\nMEM-BLOCK`, deliveryToken: 'tok-o' });
    expect(store.staged).toEqual([]);
    expect(packageSinkReceiptMock).not.toHaveBeenCalled();
  });

  it('commits a staged receipt only when the next turn confirms the token it was staged under', async () => {
    packageSinkReceiptMock.mockReturnValue({ version: 1, status: 'fenced' });
    await post({ owner: 'sess-1', prompt: 'offer' });
    const unproved = await post({ owner: 'sess-1', prompt: 'unproved', confirmedDelivery: 'wrong-token' });
    await post({ owner: 'sess-1', prompt: 'proved', confirmedDelivery: unproved.deliveryToken });
    expect(store.committed).toEqual([null, null, { version: 1, status: 'fenced', rendered: false }]);
  });
});

/**
 * WI-10005053: the hook aborts at its wall and then prints NOTHING, so one slow
 * leg used to cost the whole response — including a CTRL line that was ready
 * long before — and left the staged control candidate unprovable, which held
 * in-place identity activations at `prepared` turn after turn (measured on
 * su-d5eaa301, 2026-10-01). With a declared wall the endpoint now answers at
 * `arrivedAt + wallMs - margin` with the ready legs. Real timers: the property
 * under test IS wall-clock behaviour, and every wait here is well under 1s.
 */
describe('response deadline (WI-10005053)', () => {
  // wallMs 200 → margin min(300, 50) = 50 → the endpoint answers ~150ms in.
  const WALL_MS = 200;
  const SLOW_MS = 1_000;
  // The endpoint answers ~150ms in; a pre-fix endpoint waits >= SLOW_MS. The
  // bound sits far from both so a loaded CI host cannot flip the verdict.
  const ANSWERED_BY_MS = 600;
  const desired = { specificationRevision: 'spec-dl', stateRevision: 'state-dl' };
  const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    let pending = true;
    preparePendingControlTransitionMock.mockImplementation(async () =>
      pending ? { kind: 'stack', generation: 21, state: { activation: { desired } } } : null,
    );
    acknowledgeControlTransitionMock.mockImplementation(async () => {
      pending = false;
      return true;
    });
    renderStackTransitionContextResultMock.mockResolvedValue({ text: 'IDENTITY-LAYER', rendered: true });
    buildMemoryContextBlockMock.mockResolvedValue(null);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('turnStartRespondBy: only a sane declared wall yields a deadline, cut by the margin', async () => {
    const { turnStartRespondBy } = await import('./turn-start-memory');
    expect(turnStartRespondBy(1_000, 2_500)).toBe(1_000 + 2_500 - 300);
    expect(turnStartRespondBy(1_000, WALL_MS)).toBe(1_000 + WALL_MS - 50);
    for (const bad of [undefined, null, '2500', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      expect(turnStartRespondBy(1_000, bad)).toBeNull();
    }
  });

  it('delivers the ready CTRL at the deadline when orientation is slow, under a token the late orientation never owns', async () => {
    let orientationSettled = false;
    buildTurnStartOrientationBlockMock.mockImplementationOnce(() =>
      after(SLOW_MS, { block: 'LATE-ORIENTATION', deliveryToken: 'late-o' }).finally(() => {
        orientationSettled = true;
      }),
    );
    const t0 = Date.now();
    const out = await post({ owner: 'sess-dl', prompt: 'slow orientation', confirmedDelivery: null, wallMs: WALL_MS });
    const elapsed = Date.now() - t0;

    // The pre-fix endpoint waited the full SLOW_MS here — past the hook's wall.
    expect(elapsed).toBeLessThan(ANSWERED_BY_MS);
    expect(out.text).toContain('IDENTITY-LAYER');
    expect(out.text).not.toContain('LATE-ORIENTATION');
    expect(out.deliveryToken).toEqual(expect.any(String));
    expect(out.deliveryToken).not.toBe('late-o');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('omitted orientation'));

    // Let the omitted leg finish; it must not disturb the delivered proof.
    await vi.waitFor(() => expect(orientationSettled).toBe(true), { timeout: SLOW_MS * 2 });
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    await post({ owner: 'sess-dl', prompt: 'next turn', confirmedDelivery: out.deliveryToken });
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith('sess-dl', 'ws-test', 21, undefined, desired);
  });

  it('never stages a control candidate that missed the deadline, so its later confirmation acknowledges nothing', async () => {
    preparePendingControlTransitionMock.mockImplementationOnce(() =>
      after(SLOW_MS, { kind: 'stack', generation: 21, state: { activation: { desired } } }),
    );
    buildTurnStartOrientationBlockMock.mockResolvedValue({ block: 'ORIENTATION', deliveryToken: 'tok-o' });

    const t0 = Date.now();
    const out = await post({ owner: 'sess-dl', prompt: 'slow control', confirmedDelivery: null, wallMs: WALL_MS });
    expect(Date.now() - t0).toBeLessThan(ANSWERED_BY_MS);
    expect(out.text).toContain('ORIENTATION');
    expect(out.text).not.toContain('IDENTITY-LAYER');
    expect(out.deliveryToken).toBe('tok-o');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('omitted control'));

    // The late leg still prepares; nothing may stage it under the sent token.
    await vi.waitFor(() => expect(markControlTransitionPreparedMock).toHaveBeenCalled(), { timeout: SLOW_MS * 2 });
    const retry = await post({ owner: 'sess-dl', prompt: 'confirm orientation', confirmedDelivery: out.deliveryToken });
    expect(acknowledgeControlTransitionMock).not.toHaveBeenCalled();
    // …and the transition is offered again, now that control is fast.
    expect(retry.text).toContain('IDENTITY-LAYER');
  });

  it('hands memory the margin-adjusted deadline, not the raw wall', async () => {
    const t0 = Date.now();
    await post({ owner: 'sess-dl', prompt: 'memory deadline', wallMs: WALL_MS });
    const t1 = Date.now();
    const { respondByMs } = buildMemoryContextBlockMock.mock.calls[0]![0] as { respondByMs?: number };
    expect(respondByMs).toBeGreaterThanOrEqual(t0 + WALL_MS - 50);
    expect(respondByMs).toBeLessThanOrEqual(t1 + WALL_MS - 50);
  });

  it('a hook that declares no wall still waits for every leg (unchanged contract)', async () => {
    buildTurnStartOrientationBlockMock.mockImplementationOnce(() =>
      after(300, { block: 'PATIENT-ORIENTATION', deliveryToken: null }),
    );
    const out = await post({ owner: 'sess-dl', prompt: 'no wall' });
    expect(out.text).toContain('PATIENT-ORIENTATION');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('response deadline'));
  });
});
