/** Native operator providers. The Portal injects its existing HTTP transport
 * instead of bundling this operator execution graph into hosted sign-in. */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { TutorialAssistanceRequest } from '../../onboarding/cloud-tutorial-help';
import { createHostedTutorialAssistanceRoutes as createGuardedRoutes } from './hosted-tutorial-progress';

async function answerLesson(input: TutorialAssistanceRequest, signal: AbortSignal, workspaceId: string): Promise<string> {
  await import('../../agent-tools/operator/converse');
  const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
  const converse = lookupByMcpName('operator:converse');
  if (!converse) throw new Error('tutorial_help_unavailable');
  const ctx: UnifiedToolContext = { log: () => {}, signal, progress: () => {}, emit: () => {}, workspaceId,
    role: 'operator', runId: crypto.randomUUID(), spawnId: crypto.randomUUID(), transport: 'in_process', uiClientId: null };
  const result = await dispatchProjectedTool(converse, 'operator:converse', {
    messages: [{ role: 'user', content: input.question }], trigger: 'user_message', modality: 'text',
    hostTrust: 'public', lessonContext: input.context, sessionUser: null,
  }, ctx, {});
  if (!result.ok || result.result?.isError || signal.aborted) throw new Error('tutorial_help_unavailable');
  const content = result.result?.content.find(part => part.type === 'text');
  const value = JSON.parse(content?.type === 'text' ? content.text : '{}') as { assembled?: unknown };
  if (typeof value.assembled !== 'string' || !value.assembled.trim()) throw new Error('tutorial_help_empty');
  return value.assembled.trim().slice(0, 2000);
}

async function speakLesson(text: string, engine: string, voiceId: string | undefined, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('tutorial_speech_cancelled');
  const { isHostedTtsEngineUnavailable } = await import('../../voice-release-availability');
  if (isHostedTtsEngineUnavailable(engine)) throw new Error('tutorial_speech_unavailable');
  const [{ synthesize }, { loadVoicePrefs }] = await Promise.all([
    import('./agent-mcp/tts-synth'), import('../../voice-prefs'),
  ]);
  const speech = await synthesize(engine as Parameters<typeof synthesize>[0], text, voiceId, await loadVoicePrefs(), { signal });
  if (!speech.ok) throw new Error('tutorial_speech_unavailable');
  return speech;
}

export function createHostedTutorialAssistanceRoutes(options: Parameters<typeof createGuardedRoutes>[0]) {
  return createGuardedRoutes({ ...options,
    dependencies: { answer: answerLesson, speech: speakLesson, ...options.dependencies } });
}
