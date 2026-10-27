/**
 * Unit tests for launchAgent dispatch (agent-launch unification; P-032
 * converged ALL agents onto one path). Every backend POSTs to launch-su
 * with agent + harness + plan + model/resume/kickoff threaded through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchAgent, openPuiSuSession } from './launch-agent';

const origFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh Response per call — a Response body can only be read once, and
  // launchAgent retries across fallback endpoints (real fetch returns a
  // new response each time).
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  globalThis.fetch = origFetch;
});

function firstBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('launchAgent', () => {
  it.each(['refused', 'offline'])('does not launch on another operator when the selected machine is %s', async (failure) => {
    vi.stubEnv('PAPERCUSP_OPERATOR_BASE', '');
    vi.stubEnv('PAPERCUSP_HONO_PORT', '');
    vi.stubGlobal('window', {
      location: { protocol: 'https:', href: 'https://portal.test/desktops?desktopHost=machine-b&ws=own' },
    });
    // The fallback is healthy: reaching it would create an agent on the wrong machine.
    if (failure === 'refused') fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'selected_machine_unavailable' }), { status: 403 },
    ));
    else fetchMock.mockRejectedValueOnce(new Error('selected machine offline'));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', ownerId: 'wrong-machine' })));

    const result = await launchAgent({ agent: 'codex', slug: 'research' });

    expect(result).toEqual({ ok: false, error: failure === 'refused'
      ? 'selected_machine_unavailable' : 'selected machine offline' });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/adv/sessions/launch-su']);
  });

  it('agent-less launch sends agent:null — launch-su resolves the CONFIGURED backend', async () => {
    const r = await launchAgent({ slug: 'papercup', planSlug: 'p' });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const body = firstBody();
    expect(body.agent).toBeNull();
    expect(body.harness_slug).toBe('papercup');
    expect(body.plan_slug).toBe('p');
  });

  it('omp threads model / resume / kickoff through the body (P-032 parity)', async () => {
    await launchAgent({ agent: 'omp', slug: 'papercup', model: 'opus', resumeSessionId: 's-42', kickoff: { kind: 'new-plan' } });
    const body = firstBody();
    expect(body).toEqual({
      agent: 'omp',
      harness_slug: 'papercup',
      plan_slug: null,
      stack: null,
      selected_identity_revision: null,
      model: 'opus',
      resume_session_id: 's-42',
      kickoff: { kind: 'new-plan' },
      kickoff_prompt: null,
      defer_spawn: false,
      attached_engine: false,
      context_size: null,
      // WI-2140338: session compaction ceiling in tokens — null unless a goal
      // launch profile (or explicit caller) pins one.
      compaction_limit: null,
      // The launch body always carries the fleet/account keys, explicitly null when
      // the caller passes none — a GUI launch must never omit `account` (psu with no
      // --account opens an interactive picker that hangs the spawn). Pinned here so
      // dropping one from the wire body is a failure, not a silent behaviour change.
      fleet: null,
      fleet_name: null,
      fleet_scheme: null,
      account: null,
      // P-002: carry and attach are explicit on the wire. Null keeps the
      // ordinary live-spawn path byte/behavior compatible with bare psu.
      carry: null,
      attach_adv_session_id: null,
      // WI-6505: same always-on-the-wire discipline as the keys above. `false`
      // rather than null because headed IS the default, not "unspecified" — a
      // launch that omitted it would be indistinguishable from one that asked
      // for a window, which is the one confusion this flag must never create.
      headless: false,
      // P-042: the launch-time MODE, on the wire under the same discipline —
      // explicitly null when unset. null (not 'interactive' or '') because
      // "no mode requested" is the ABSENCE of a posture, and launch-su's
      // validator treats any non-empty value as a mode it must recognise.
      mode: null,
    });
  });

  it('headless:true rides the wire so a GUI launch can open a windowless member (WI-6505)', async () => {
    await launchAgent({ agent: 'claude', slug: 'papercup', headless: true });
    expect(firstBody().headless).toBe(true);
  });

  it('forwards an exact selected identity source pin into the shared launch route', async () => {
    const revision = 'a'.repeat(64);
    await launchAgent({ slug: null, stack: ['domain:research-steward'],
      selectedIdentityRevision: revision });
    expect(firstBody()).toMatchObject({ stack: ['domain:research-steward'],
      selected_identity_revision: revision });
  });

  it('mode rides the wire so a GUI launch can start in DRAIN (P-042)', async () => {
    await launchAgent({ agent: 'claude', slug: 'papercup', mode: 'drain' });
    expect(firstBody().mode).toBe('drain');
  });

  it('an omitted mode sends null — a plain interactive launch, unchanged (P-042)', async () => {
    await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(firstBody().mode).toBeNull();
  });

  it('deferSpawn → body carries defer_spawn:true and returns advSessionId (D-006)', async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok', deferred: true, advSessionId: 77 }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await launchAgent({ agent: 'claude', slug: null, planSlug: 'my-plan', deferSpawn: true });
    expect(r.ok).toBe(true);
    expect(r.advSessionId).toBe(77);
    expect(firstBody().defer_spawn).toBe(true);
  });

  it.each(['claude', 'codex', 'omp'] as const)(
    'PUI create requires explicit %s and records one deferred psu launch with carry',
    async (backend) => {
      fetchMock.mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            status: 'ok',
            deferred: true,
            advSessionId: 81,
            ownerId: 'su-created',
            agent: body.agent,
            workspaceId: 'papercusp-workspace',
            harnessSlug: body.harness_slug,
            planSlug: body.plan_slug,
            nativeSession: null,
          }),
          { status: 200 },
        );
      });

      const result = await openPuiSuSession({
        operation: 'create',
        backend,
        carry: 'warm',
        agentChatId: 'pui-created-chat',
        slug: 'papercup',
        planSlug: 'pui-plan',
        model: 'selected-model',
      });
      expect(result).toEqual({
        ok: true,
        session: {
          operation: 'created',
          backend,
          advSessionId: 81,
          ownerId: 'su-created',
          workspaceId: 'papercusp-workspace',
          harnessSlug: 'papercup',
          planSlug: 'pui-plan',
          nativeSession: null,
        },
      });
      expect(firstBody()).toMatchObject({
        agent: backend,
        agent_chat_id: 'pui-created-chat',
        model: 'selected-model',
        // PUI's attached-engine launch persists this route with the durable
        // conversation binding. Omitting it can silently use the owner's
        // nominated gateway route instead of the requested system account.
        account: 'default',
        carry: 'warm',
        defer_spawn: false,
        attached_engine: true,
        attach_adv_session_id: null,
      });
    },
  );

  it('PUI attach uses the same route by stable advSessionId and never requests a spawn', async () => {
    const nativeSession = {
      backend: 'omp',
      source: 'adv_sessions',
      ownerId: 'su-existing',
      ompThreadId: 'thread-42',
      agentHome: '/tmp/omp-agent',
      exactResumeSupported: true,
      missingReason: null,
    } as const;
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            attached: true,
            advSessionId: 42,
            ownerId: 'su-existing',
            agent: 'omp',
            workspaceId: 'papercusp-workspace',
            harnessSlug: 'papercup',
            planSlug: null,
            nativeSession,
          }),
          { status: 200 },
        ),
    );

    const result = await openPuiSuSession({
      operation: 'attach',
      backend: 'omp',
      advSessionId: 42,
      harnessSlug: 'papercup',
    });
    expect(result).toMatchObject({
      ok: true,
      session: {
        operation: 'attached',
        backend: 'omp',
        advSessionId: 42,
        ownerId: 'su-existing',
        nativeSession,
      },
    });
    expect(firstBody()).toMatchObject({
      agent: 'omp',
      attach_adv_session_id: 42,
      defer_spawn: false,
      carry: null,
    });
  });

  it('ordinary launch remains the live-spawn/bare-psu path, not the PUI attach path', async () => {
    await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(firstBody()).toMatchObject({
      agent: 'claude',
      defer_spawn: false,
      attach_adv_session_id: null,
      carry: null,
    });
  });

  it('claude → POST launch-su', async () => {
    const r = await launchAgent({ agent: 'claude', slug: 'papercup', planSlug: 'my-plan' });
    expect(r.ok).toBe(true);
    const body = firstBody();
    expect(body.agent).toBe('claude');
    expect(body.harness_slug).toBe('papercup');
    expect(body.plan_slug).toBe('my-plan');
  });

  it('codex → launch-su; maps psu_not_installed to an install hint', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', code: 'psu_not_installed', error: 'no psu' }), { status: 200 }));
    const r = await launchAgent({ agent: 'codex', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('omp_not_installed');
    expect(r.installCmd).toMatch(/install-standalone-mcp/);
  });

  it('surfaces a server error', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', error: 'boom' }), { status: 500 }));
    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });

  // EI-18696184925888288: launch-su can report ok:true with a `warning` when
  // its spawned terminal process exited almost immediately (a likely silent
  // launch failure) — launchAgent must pass that through, not drop it.
  it('surfaces a warning on an otherwise-ok response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ status: 'ok', terminal: 'gnome-terminal', pid: 123, warning: 'exited almost immediately' }),
          { status: 200 },
        ),
    );
    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBe('exited almost immediately');
  });

  it('an ok response with no warning field leaves r.warning undefined', async () => {
    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});
