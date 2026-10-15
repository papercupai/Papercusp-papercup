import { defineTool } from '@papercusp/tooldef/define-tool';
import { z } from 'zod';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, tenantContext, workspaceHeaderMismatch } from '../hosted-browser-context';
import { authorizeTutorialHelp, authorizeProductTutorialHelp, tutorialAssistanceRequestSchema, tutorialHelpRequestSchema, productTutorialHelpRequestSchema, type TutorialAssistanceRequest } from '../../onboarding/cloud-tutorial-help';
import { authorizeTutorialVoice, tutorialVoiceRequestSchema, type TutorialVoiceRequest } from '../../onboarding/cloud-tutorial-help';
import { readAccountTutorialProgress, readTutorialProgress, type AccountTutorialProgressRecord, type TutorialProgressRecord } from '../../onboarding/cloud-tutorial-progress';
import { isHostedPrincipal } from '../../auth/hosted-principal';
export { HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, createHostedTutorialProgressRoutes } from './hosted-tutorial-progress-routes';
export const HOSTED_BROWSER_TUTORIAL_HELP_PATH = '/hosted/browser/onboarding/tutorial-help' as const;
export const HOSTED_BROWSER_TUTORIAL_SPEECH_PATH = '/hosted/browser/onboarding/tutorial-speech' as const;
export const HOSTED_BROWSER_TUTORIAL_VOICE_TOKEN_PATH = '/hosted/browser/onboarding/tutorial-voice-token' as const;

export interface TutorialVoiceAdmission {
  controlWorkspaceId: string;
  organizationId: string;
  userId: string;
  /** Verified server session snapshot for transactional revocation checks. */
  sessionId: string;
  sessionVersion: number;
  customerWorkspaceId: string | null;
  lesson: TutorialVoiceRequest['context'];
}
/** Installed by server composition only. The issuer must atomically reserve
 * daily seconds and the user's live session before contacting the provider.
 * It must fail closed without verified restricted-key/agent duration limits.
 * No browser-supplied usage, limits, agent IDs or secrets reach this seam. */
export interface TutorialVoiceTokenProvider {
  disabled: (signal: AbortSignal) => Promise<boolean>;
  issue: (admission: TutorialVoiceAdmission, signal: AbortSignal) => Promise<
    // The issuer requests include_conversation_id=true and commits that
    // trusted remote identity before delivering this single-use URL. Agent
    // WebRTC tokens have no documented equivalent replay/TTL guarantee.
    { ok: true; connectionType: 'websocket'; signedUrl: string; sessionId: string; expiresAt: number; maximumSeconds: number }
    | { ok: false; reason: 'quota_exhausted' | 'session_active' | 'disabled' | 'unavailable' }>;
}

export function createHostedTutorialVoiceTokenRoute({ origin, controlPlaneWorkspaceId, runTenant, provider }: {
  origin: string; controlPlaneWorkspaceId: string; provider?: TutorialVoiceTokenProvider;
  runTenant: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  return defineTool({ method: 'POST', path: HOSTED_BROWSER_TUTORIAL_VOICE_TOKEN_PATH,
    auth: { capabilities: [], kind: ['user'], trust: ['verified'] }, cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const parsed = tutorialVoiceRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return jsonError('invalid_tutorial_context', 400);
      const account = parsed.data.context.version === 3;
      const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId,
        ...(!account && principal.selectedWorkspaceId ? { workspaceId: principal.selectedWorkspaceId } : {}) };
      // Scope forgery is rejected before reading progress or consulting a provider.
      if (parsed.data.expectedScope.tenantId !== scope.tenantId || parsed.data.expectedScope.userId !== scope.userId) {
        return jsonError('tutorial_scope_changed', 403);
      }
      if (!account) {
        if (!principal.selectedWorkspaceId) return jsonError('workspace_not_selected', 403);
        if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
        if (!('workspaceId' in parsed.data.expectedScope) || parsed.data.expectedScope.workspaceId !== principal.selectedWorkspaceId) {
          return jsonError('tutorial_scope_changed', 403);
        }
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      if (signal.aborted) return jsonError('tutorial_voice_cancelled', 408);
      if (!provider) return jsonError('tutorial_voice_unavailable', 503);
      try {
        if (await provider.disabled(signal)) return jsonError('tutorial_voice_disabled', 503);
        const context = account ? { principal: {
          kind: 'user' as const, profile: 'hosted' as const, authMethod: 'cookie-session' as const,
          trust: 'verified' as const, slug: principal.userId, workspaceId: principal.workspaceId,
          userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
          sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
        } } : tenantContext(principal);
        const record = await runTenant<AccountTutorialProgressRecord | TutorialProgressRecord | null>(context, tx => account
          ? readAccountTutorialProgress(tx, scope)
          : readTutorialProgress(tx, { ...scope, workspaceId: principal.selectedWorkspaceId! }, parsed.data.context.version === 2 ? 2 : 1, { requirePersisted: true }));
        let input: TutorialVoiceRequest;
        try { input = authorizeTutorialVoice(scope, parsed.data, record); }
        catch { return jsonError('tutorial_lesson_changed', 409); }
        if (signal.aborted) return jsonError('tutorial_voice_cancelled', 408);
        // Recheck after the tenant read; issuer also checks in its reservation
        // transaction to cover changes while acquiring cross-replica locks.
        if (await provider.disabled(signal)) return jsonError('tutorial_voice_disabled', 503);
        const result = await provider.issue({ controlWorkspaceId: controlPlaneWorkspaceId, organizationId: scope.tenantId, userId: scope.userId,
          sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
          customerWorkspaceId: account ? null : principal.selectedWorkspaceId!, lesson: input.context }, signal);
        if (!result.ok) return jsonError('tutorial_voice_' + result.reason,
          result.reason === 'quota_exhausted' ? 429 : result.reason === 'session_active' ? 409 : 503);
        if (signal.aborted) return jsonError('tutorial_voice_cancelled', 408);
        // Deliberate allowlist: provider diagnostics or credentials cannot be
        // accidentally serialized by spreading a provider result.
        // Fail closed if an old/misconfigured host still returns a WebRTC
        // token. The browser must not guess the SDK's default transport.
        const signedUrl = typeof result.signedUrl === 'string' ? new URL(result.signedUrl) : null;
        if (result.connectionType !== 'websocket' || !signedUrl
          || signedUrl.protocol !== 'wss:' || signedUrl.host !== 'api.elevenlabs.io'
          || signedUrl.pathname !== '/v1/convai/conversation' || signedUrl.username || signedUrl.password
          || signedUrl.hash || !signedUrl.searchParams.get('conversation_signature')
          || typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId.length > 256
          || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()
          || !Number.isSafeInteger(result.maximumSeconds) || result.maximumSeconds < 1 || result.maximumSeconds > 7200) {
          return jsonError('tutorial_voice_unavailable', 503);
        }
        return Response.json({ connectionType: result.connectionType, signedUrl: result.signedUrl,
          sessionId: result.sessionId, expiresAt: result.expiresAt,
          maximumSeconds: result.maximumSeconds }, { headers: { 'cache-control': 'no-store' } });
      } catch { return jsonError('tutorial_voice_unavailable', 503); }
    },
  });
}

export interface TutorialAssistanceDependencies {
  voiceToken?: TutorialVoiceTokenProvider;
  answer?: (input: TutorialAssistanceRequest, signal: AbortSignal, workspaceId: string) => Promise<string>;
  speech?: (text: string, engine: string, voiceId: string | undefined, signal?: AbortSignal) => Promise<{ audio: ArrayBuffer; contentType: string }>;
}
const speechOptions = {
  engine: z.enum(['kokoro', 'elevenlabs', 'openai', 'cartesia']),
  voiceId: z.string().min(1).max(200).optional(),
};
const speechSchema = z.union([
  tutorialHelpRequestSchema.extend(speechOptions).strict(),
  productTutorialHelpRequestSchema.extend(speechOptions).strict(),
]);

/** Guarded leaves shared by native and prebundled hosts. Each host supplies
 * its maintained execution provider; missing providers fail closed. */
export function createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId, runTenant, dependencies = {} }: {
  origin: string; controlPlaneWorkspaceId: string; dependencies?: TutorialAssistanceDependencies;
  runTenant?: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  const routes = [HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH].map(path => defineTool({
    method: 'POST', path, auth: { capabilities: [], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const raw: unknown = await request.json().catch(() => null);
      const parsed = (path === HOSTED_BROWSER_TUTORIAL_SPEECH_PATH ? speechSchema : tutorialAssistanceRequestSchema).safeParse(raw);
      if (!parsed.success) return jsonError('invalid_tutorial_context', 400);
      let input: TutorialAssistanceRequest;
      try {
        if (parsed.data.context.version === 3) {
          const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId };
          input = authorizeProductTutorialHelp(scope, {
            expectedScope: parsed.data.expectedScope, context: parsed.data.context, question: parsed.data.question,
          });
          if (!runTenant) return jsonError('tutorial_help_unavailable', 503);
          const record = await runTenant({ principal: {
            kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: principal.userId,
            workspaceId: principal.workspaceId, userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
            sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
          } }, tx => readAccountTutorialProgress(tx, scope)).catch(() => undefined);
          // Database/tenant-runner diagnostics can contain private scope or
          // connection details. Expose only the public recoverable outage.
          if (record === undefined) return jsonError('tutorial_help_unavailable', 503);
          if (!record || record.currentLessonId !== input.context.step || !['active', 'paused'].includes(record.disposition)) return jsonError('tutorial_lesson_changed', 409);
        } else {
          const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
          if (!selection.ok) return selection.response;
          if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
          input = authorizeTutorialHelp({ tenantId: principal.activeOrganizationId, userId: principal.userId, workspaceId: principal.selectedWorkspaceId! },
            { expectedScope: parsed.data.expectedScope, context: parsed.data.context, question: parsed.data.question });
        }
      } catch { return jsonError('invalid_tutorial_context', 403); }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      if (signal.aborted) return jsonError('tutorial_help_cancelled', 408);
      try {
        if (path === HOSTED_BROWSER_TUTORIAL_HELP_PATH) {
          if (!dependencies.answer) throw new Error('tutorial_help_unavailable');
          const answer = await dependencies.answer(input, signal, controlPlaneWorkspaceId);
          if (signal.aborted) return jsonError('tutorial_help_cancelled', 408);
          return Response.json({ answer }, { headers: { 'cache-control': 'no-store' } });
        }
        const voice = speechSchema.parse(raw);
        if (!dependencies.speech) throw new Error('tutorial_speech_unavailable');
        const speech = await dependencies.speech(input.question, voice.engine, voice.voiceId, signal);
        if (signal.aborted) return jsonError('tutorial_speech_cancelled', 408);
        return new Response(speech.audio, { headers: { 'content-type': speech.contentType, 'cache-control': 'no-store' } });
      } catch { return jsonError(path === HOSTED_BROWSER_TUTORIAL_HELP_PATH ? 'tutorial_help_unavailable' : 'tutorial_speech_unavailable', 503); }
    },
  }));
  return [...routes, ...(runTenant && dependencies.voiceToken ? [createHostedTutorialVoiceTokenRoute({
    origin, controlPlaneWorkspaceId, runTenant, provider: dependencies.voiceToken,
  })] : [])];
}
