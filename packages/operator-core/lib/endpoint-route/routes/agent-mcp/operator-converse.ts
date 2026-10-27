/**
 * POST /api/agent-mcp/operator-converse — SSE stream of operator's next turn.
 * Thin shim into the operator:converse tool; resolves session user from
 * cookies (the one HTTP-only step), budget pre-flight, forwards the rest.
 * Ported from app/api/agent-mcp/operator-converse/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { sseResponse } from '@papercusp/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  subscribeWorkspace,
  resolveBearer,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { activeWorkspaceId } from '../../../workspace-registry';
import { rolePromptUnavailableDetails } from '../../../prompt-assembly';
import { checkBudget, shouldBypassOperatorBudget } from '../../../operator-budget';
import { getConversationById, getOrCreateActiveConversation } from '../../../operator-conversations';
import { UI_CONTEXT_MAX_CHARS } from '../../../chat-context-sections';
import { defineTool } from '@papercusp/agent-mcp';
import { tutorialHelpContextSchema, type TutorialHelpContext } from '../../../onboarding/cloud-tutorial-help';
import { getOrgPg } from '@papercusp/db-org';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';
import { findConverseTurn } from '../../../agent-tools/operator/converse-turn';
import { operatorChatSessionAuthority } from '../../../operator-chat-store';

interface ConverseRequestBody {
  chatProtocolVersion?: 1;
  operation?: 'reconnect' | 'cancel';
  turnId?: string;
  afterSequence?: number;
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?:
    | 'user_message'
    | 'quiet_wait_resume'
    | 'open_canvas'
    | 'user_says_ready'
    | 'user_welcomed'
    | 'continue'
    | 'sentinel_scan';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  voiceProfile?: 'standard' | 'slim';
  /** Rendering surface: 'desktop' (default) vs 'tui' (the pui terminal
   *  workbench). Forwarded to operator:converse so it injects per-surface
   *  affordances (tui-operator-surface D-003). */
  surface?: 'desktop' | 'tui';
  uiClientId?: string;
  conversationId?: string;
  isAutoFire?: boolean;
  /** Which persona the brain assumes — the Sentinel-as-Herald re-home seam.
   *  Defaults to 'operator' (backward-compatible). 'sentinel' resolves the
   *  `papercup:converse` tool alias (same handler, loads the Herald persona). */
  role?: string;
  /** Host trust (papercup-chat-one-component-one-contract-2026-09-06 P-005,
   *  D-007 §2). This route is loopback-only, so the CALLER is a trusted host
   *  process: the desktop / TUI omit it (⇒ 'owner', byte-identical legacy);
   *  the portal host proxy asserts 'public' for a turn it forwards from
   *  behind its per-user boundary. Asserting 'public' only ever REMOVES
   *  privilege (no superuser mount, no workspace-internal prompt sections). */
  hostTrust?: 'owner' | 'public';
  /** The per-user boundary's bearer for a public turn — the ONLY credential
   *  a public brain's MCP mount may carry (never the disk superuser token).
   *  Without it a public turn runs tool-less. */
  principalToken?: string;
  /** The hosting surface's current UI context (orientation data, never
   *  authority) — the agent-chats seam's `body.context`. Capped at
   *  UI_CONTEXT_MAX_CHARS; longer is a 400. */
  uiContext?: string;
  lessonContext?: TutorialHelpContext;
}

async function controlTurn(req: Request, body: ConverseRequestBody): Promise<Response> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (body.chatProtocolVersion !== 1 || !['reconnect', 'cancel'].includes(body.operation ?? '')
    || typeof body.conversationId !== 'string' || !uuid.test(body.conversationId)
    || typeof body.turnId !== 'string' || !uuid.test(body.turnId)
    || body.lessonContext !== undefined || body.messages !== undefined
    || !Number.isSafeInteger(body.afterSequence ?? 0) || (body.afterSequence ?? 0) < 0) {
    return Response.json({ error: 'invalid turn control' }, { status: 400 });
  }
  try {
    const workspaceId = activeWorkspaceId();
    let expectedPrincipalId: string | undefined;
    let authorizeAdditional;
    if (body.hostTrust === 'public') {
      const bearer = typeof body.principalToken === 'string' ? body.principalToken.trim() : '';
      const principal = bearer ? await resolveBearer(bearer) : null;
      if (principal?.kind !== 'pi' || principal.workspaceId !== workspaceId) {
        return Response.json({ error: 'unauthorized' }, { status: 403 });
      }
      const sessionId = principal.slug.replace(/^pi:/, '');
      expectedPrincipalId = `pi:${sessionId}`;
      authorizeAdditional = operatorChatSessionAuthority({ workspaceId, principalId: expectedPrincipalId,
        credential: { kind: 'pi', sessionId, bearer }, capability: 'chat:write', toolName: 'chat:ask_choice' });
    } else {
      const responder = await getSessionUserOrLocalDefaultAuthority(req);
      if (!responder || responder.user.workspace_id !== workspaceId) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      authorizeAdditional = responder.authorize;
    }
    const turn = await findConverseTurn({ sql: getOrgPg().sql, workspaceId,
      identity: { conversationId: body.conversationId, turnId: body.turnId }, authorizeAdditional, expectedPrincipalId });
    if (!turn) return Response.json({ error: 'turn not found' }, { status: 404 });
    if (body.operation === 'cancel') {
      const cancelled = await turn.recovery.cancel(turn.identity);
      return cancelled.ok ? Response.json({ ok: true, state: cancelled.value.state })
        : Response.json({ error: cancelled.code }, { status: cancelled.code === 'conflict' ? 409 : 503 });
    }
    let cursor = body.afterSequence ?? 0;
    const initial = await turn.recovery.replay(turn.identity, cursor);
    if (!initial.ok) return Response.json({ error: initial.code },
      { status: ['invalid-cursor', 'replay-expired'].includes(initial.code) ? 409 : 503 });
    return sseResponse({ signal: req.signal, setup: async sink => {
      let stopped = false;
      let subscription: { stop(): void } | undefined;
      sink.onClose(() => { stopped = true; subscription?.stop(); });
      const fail = () => {
        if (!stopped) { sink.event('error', { code: 'needs-reconciliation', message: 'Turn stream needs reconciliation' }); sink.close(); }
      };
      try {
        subscription = await turn.watch(async checkpoint => {
          const replay = await turn.recovery.replay(turn.identity, cursor);
          if (!replay.ok) throw new Error(replay.code);
          if (stopped || sink.closed) return;
          for (const event of replay.value) { sink.event('chat-event', event); cursor = event.sequence; }
          sink.event('turn-state', checkpoint.state);
          if (['completed', 'failed', 'cancelled'].includes(checkpoint.state.phase)) {
            sink.done({ persistedTurn: turn.receipt, phase: checkpoint.state.phase });
          }
        }, fail);
        if (stopped) subscription.stop();
      } catch { fail(); }
    } });
  } catch (error) {
    return Response.json({ error: error instanceof Error && error.message === 'unauthorized'
      ? 'unauthorized' : 'turn needs reconciliation' },
    { status: error instanceof Error && error.message === 'unauthorized' ? 403 : 503 });
  }
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-converse',
  auth: 'loopback',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  // The watchdog times only the handler's PRE-FLIGHT (json/budget/auth — the
  // SSE Response returns before streaming starts; route-stack clears the timer
  // in its `finally` the moment that Response comes back, so it never bounds
  // the stream itself), but under PG contention those awaits can queue past a
  // fixed budget and 408 a healthy voice turn (observed live 2026-06-07: brain
  // route died at $0.00 spend in an op-S13 run while the box was loaded).
  // EI-110's own residual note: bumping to a bigger fixed number (this was
  // `120`) just moves the same false-408 to a worse PG storm — it doesn't
  // remove it. `null` is the structural fix already used by every other
  // pre-flight-then-stream SSE route in this tree (zero-harness/sse.ts,
  // flags/stream.ts, coord/inbox-sse.ts, harness/clobber-stream.ts,
  // deploy/frame-view.ts, operator/state-snapshot.ts, the agent-tools/plugins
  // catchalls) — this route is exactly that shape and was the one left behind
  // on a magic number. The brain's own caps govern the stream.
  timeoutSec: null,
  async handler(req) {
    let body: ConverseRequestBody = {};
    try {
      body = (await req.json()) as ConverseRequestBody;
    } catch {
      return new Response('invalid JSON body', { status: 400 });
    }

    // P-005 (D-007 §2): host trust + the public boundary's bearer + the
    // surface's UI context. Validated here, applied by operator:converse
    // (toolset + MCP mount) and buildOperatorPrompt (which sections render).
    if (body.hostTrust !== undefined && body.hostTrust !== 'owner' && body.hostTrust !== 'public') {
      return Response.json({ error: "hostTrust must be 'owner' or 'public'" }, { status: 400 });
    }
    const hostTrust: 'owner' | 'public' = body.hostTrust === 'public' ? 'public' : 'owner';
    if (body.chatProtocolVersion !== undefined && body.chatProtocolVersion !== 1) {
      return Response.json({ error: 'unsupported chat protocol' }, { status: 400 });
    }
    if (body.operation !== undefined) return controlTurn(req, body);
    if (body.turnId !== undefined || body.afterSequence !== undefined
      || (body.chatProtocolVersion === 1 && body.lessonContext !== undefined)) {
      return Response.json({ error: 'invalid turn control' }, { status: 400 });
    }
    let lessonContext: TutorialHelpContext | undefined;
    if (body.lessonContext !== undefined) {
      const parsed = tutorialHelpContextSchema.safeParse(body.lessonContext);
      if (!parsed.success || hostTrust !== 'public' || body.conversationId !== undefined
        || body.principalToken !== undefined || (body.role !== undefined && body.role !== 'operator')) {
        return Response.json({ error: 'invalid_tutorial_context' }, { status: 400 });
      }
      lessonContext = parsed.data;
    }
    if (body.uiContext !== undefined && typeof body.uiContext !== 'string') {
      return Response.json({ error: 'uiContext must be a string' }, { status: 400 });
    }
    if (typeof body.uiContext === 'string' && body.uiContext.length > UI_CONTEXT_MAX_CHARS) {
      return Response.json(
        { error: `uiContext exceeds ${UI_CONTEXT_MAX_CHARS} chars` },
        { status: 400 },
      );
    }
    const principalToken =
      typeof body.principalToken === 'string' && body.principalToken.trim()
        ? body.principalToken.trim()
        : undefined;

    const budget = shouldBypassOperatorBudget(body.uiClientId) ? null : await checkBudget();
    if (budget?.state && budget.exceeded) {
      return new Response(
        `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
        { status: 402 },
      );
    }

    let sessionUser: { id: string; username: string; display_name: string; has_password: boolean } | null = null;
    try {
      const { getSessionUserOrDefault } = await import('../../../auth');
      sessionUser = lessonContext ? null : await getSessionUserOrDefault(req.headers);
    } catch (err) {
      console.warn('[operator-converse] session user resolution failed:', (err as Error).message);
    }

    // Sentinel-as-Herald re-home seam: resolve `${role}:converse`. Default
    // 'operator' is byte-identical to before; 'sentinel' resolves the
    // papercup:converse alias (same handler, Herald persona). An unknown role
    // falls back to operator:converse so a stray value can't 500 a live turn.
    //
    // P-012 (text parity): an EXPLICIT body.role wins (P-006). When the caller
    // didn't set one, fall back to the `humanFacingRole` voice pref so the
    // Sentinel repoint is consistent with the voice + device paths. Default
    // remains 'operator' (pref unset/'operator' → byte-for-byte unchanged).
    let role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : '';
    if (!role) {
      try {
        const { loadVoicePrefs } = await import('../../../voice-prefs');
        const prefs = await loadVoicePrefs();
        // 'sentinel' is the pre-rename pref value (WI-2932) — accepted, resolves
        // to the canonical 'papercup' role id.
        role = prefs.humanFacingRole === 'papercup' ? 'papercup' : 'operator';
      } catch {
        role = 'operator';
      }
    }
    // The papercup persona brain is registered under `papercup:converse`
    // (sentinel-converse.ts); every other role resolves `${role}:converse`.
    // A stale explicit 'sentinel' still routes there during the expand phase.
    const converseToolName = role === 'papercup' ? 'papercup:converse' : `${role}:converse`;
    const operatorConverseTool = lookupByMcpName(converseToolName) ?? lookupByMcpName('operator:converse');
    if (!operatorConverseTool) {
      return new Response(`${converseToolName} tool not registered`, { status: 500 });
    }

    const ctrl = new AbortController();
    const workspaceId = activeWorkspaceId();

    // An explicit id is a fail-closed target, not a hint. Validate it inside
    // the request's workspace before starting an expensive stream; prompt
    // assembly then re-resolves its subject from this canonical row rather
    // than accepting work-item metadata from the browser.
    if (body.conversationId !== undefined) {
      const requestedId = body.conversationId.trim();
      if (!requestedId) {
        return Response.json({ error: 'conversationId must be non-empty' }, { status: 400 });
      }
      const conversation = await getConversationById(requestedId, workspaceId);
      if (!conversation) {
        return Response.json(
          { error: 'conversation not found in the active workspace' },
          { status: 404 },
        );
      }
      body.conversationId = conversation.id;
    } else if (!lessonContext && hostTrust === 'owner') {
      body.conversationId = (await getOrCreateActiveConversation(workspaceId)).id;
    }

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        // Versioned connections are subscribers. Only the explicit durable
        // cancellation operation aborts their producer. Legacy0 retains its
        // existing disconnect behavior during the ordered adapter rollout.
        if (body.chatProtocolVersion !== 1) sink.onClose(() => ctrl.abort());

        // WI-5023: expose this turn's own card-correlator runId up front, on
        // every modality. Purely additive (a new event name; nothing existing
        // changes) and scoped to THIS request's own id — it does not forward
        // any card/state data itself, so it cannot leak another conversation's
        // cards. It lets a caller that wants to observe cards in TEXT mode
        // (production text UI already does this over its own separate
        // GET /operator/state-snapshot subscription; the llm-testing harness
        // needs the same runId to scope that subscription to its own turn)
        // correlate without widening what THIS stream forwards.
        const runId = globalThis.crypto.randomUUID();
        sink.event('run-meta', { runId,
          ...(body.chatProtocolVersion === 1 ? { chatProtocolVersion: 1 } : {}),
          ...(!lessonContext && body.conversationId ? { turnPersistence: 1, conversationId: body.conversationId } : {}) });

        let offStateChannel: (() => void) | null = null;
        // Owner text chat already consumes the workspace-wide
        // /operator/state-snapshot stream directly. Public text chat cannot:
        // its portal proxy owns one upstream converse SSE and projects the
        // safe card subset from that stream. Forward cards here for public
        // trust too, or a nested chat:ask_choice registers and blocks while
        // the portal has no channel on which to see or answer it.
        if (body.modality === 'voice' || body.hostTrust === 'public') {
          offStateChannel = subscribeWorkspace(workspaceId, (vs) => {
            if (sink.closed) return;
            const hasVoiceCard = vs.snapshot.openCards?.some(
              (c) => typeof c.fallbackText === 'string' && c.fallbackText.length > 0,
            );
            if (!hasVoiceCard) return;
            sink.event('state-snapshot', vs);
          });
          sink.onClose(offStateChannel);
        }

        if (body.conversationId && body.uiClientId
          && ['continue', 'user_says_ready', 'user_message'].includes(body.trigger ?? '')) {
          const { recordChainEvent } = await import('../../../operator-continue-chains');
          if (body.trigger === 'continue') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'continue',
            });
          } else if (body.trigger === 'user_says_ready' && body.isAutoFire) {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'auto_fire_terminal',
            });
          } else if (body.trigger === 'user_message') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'reset',
            });
          }
        }

        const ctxBase: UnifiedToolContext = {
          log: (msg) => {
            console.log(`[${converseToolName}][tool] ${msg}`);
          },
          signal: ctrl.signal,
          progress: () => {},
          emit: () => {
            /* installed by dispatchProjectedToolStream */
          },
          workspaceId,
          role,
          runId,
          interactiveCardCapability: true,
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: body.uiClientId ?? null,
        };

        let totalCost = 0;
        let unreportedFrames = 0;
        let lessonAnswer: string | undefined;
        let persistedTurn: { conversationId: string; turnId: string; seq: number } | undefined;
        try {
          for await (const ev of dispatchProjectedToolStream(
            operatorConverseTool,
            converseToolName,
            {
              messages: body.messages ?? [],
              voiceProfile: body.voiceProfile,
              trigger: body.trigger,
              welcomedUser: body.welcomed_user,
              mayAskActive: body.mayAskActive,
              modality: body.modality,
              surface: body.surface,
              uiClientId: body.uiClientId,
              // Enables rolling-summary context + the post-turn compaction
              // pass (operator-context-compaction-2026-06-05).
              conversationId: body.conversationId,
              // Sentinel-as-Herald re-home seam: forward the persona role so the
              // prompt builder loads the matching persona set ('operator' default).
              role,
              sessionUser,
              lessonContext,
              // P-005 (D-007 §2): trust-keyed toolset / mount / prompt sections.
              hostTrust,
              principalToken,
              uiContext: body.uiContext,
            },
            ctxBase,
            {},
          )) {
            if (ctrl.signal.aborted) break;
            if (ev.kind === 'event') {
              if (body.chatProtocolVersion === 1 && !['chat-event', 'turn-meta'].includes(ev.name)) continue;
              emitToSseSink(sink, operatorConverseTool, ev.name, ev.data);
            } else if (ev.kind === 'done') {
              try {
                const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
                const out = JSON.parse(text) as { totalCost?: number; assembled?: string; unreportedFrames?: number;
                  persistedTurn?: { conversationId: string; turnId: string; seq: number } };
                if (out.persistedTurn) persistedTurn = out.persistedTurn;
                if (lessonContext && typeof out.assembled === 'string') lessonAnswer = out.assembled.trim().slice(0, 2000);
                if (typeof out.totalCost === 'number' && Number.isFinite(out.totalCost)) totalCost = out.totalCost;
                if (typeof out.unreportedFrames === 'number' && Number.isSafeInteger(out.unreportedFrames) && out.unreportedFrames > 0) {
                  unreportedFrames += out.unreportedFrames;
                }
              } catch (e) {
                console.warn('[operator-converse] tool result parse failed:', e);
              }
            } else if (ev.kind === 'error') {
              if (!ctrl.signal.aborted) sink.event('error', rolePromptUnavailableDetails(ev.error) ?? { message: ev.error.message });
              sink.close();
              return;
            }
          }
          sink.done({ costUsd: totalCost, ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
            ...(persistedTurn ? { persistedTurn } : {}),
            ...(lessonContext ? { answer: lessonAnswer ?? '' } : {}) });
        } catch (err) {
          if (!ctrl.signal.aborted) {
            sink.event('error', rolePromptUnavailableDetails(err) ?? { message: err instanceof Error ? err.message : String(err) });
          }
          sink.close();
        }
      },
    });
  },
});
