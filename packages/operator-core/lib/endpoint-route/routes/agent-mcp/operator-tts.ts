/**
 * POST /api/agent-mcp/operator-tts — full-reply TTS synthesis for non-browser
 * clients (the TUI's PTT path — voice-mode-tui-port-2026-06-05 D-006).
 *
 * Body: `{ text: string, engine?, voiceId? }` → `{ ok, engine, contentType,
 * audioBase64 }`. Unlike `operator-tts-preview` (200-char samples for the
 * settings page), this accepts bounded speech chunks (up to 4000 characters each) and returns
 * base64 JSON instead of raw bytes — the TUI's IPC `sys:http` bridge is
 * binary-unsafe (UTF-8 string frames). Engine + voice default from the
 * operator's voice prefs (D-003); `'browser'` (speechSynthesis — meaningless
 * outside a browser) falls back to kokoro when kokoro's health check passes.
 *
 * Per-provider synthesis is the shared `synthesize()` registry (./tts-synth) —
 * the ONE server-side implementation, also used by operator-tts-preview and
 * re-exported here for the in-process callers (voice-node/agent-peer, sentinel
 * proactive sweep, tests). Keys stay server-side. `auth: 'loopback'`.
 */
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';
import {
  MAX_TEXT_CHARS,
  resolveTtsEngine,
} from './operator-voice-proxy-helpers';
import { kokoroTtsAvailable } from '../../../voice-node/kokoro-local';
import { synthesize, synthesizeReading } from './tts-synth';
import { CONTENT_LIMITS, ContentIntakeError, readContent, type ContentInput } from '../../../content-intake';
import { ContentSummaryError, summaryOptionsSchema, summarizeContent } from '../../../content-summary';
import { decodeProvidedContent, providedContentSchema } from '../../../agent-tools/documents/content';

/** Same authorized provided-content contract; this operation never starts speech. */
async function summaryResponse(req: Request, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const content = providedContentSchema.safeParse(body.content);
  const options = summaryOptionsSchema.safeParse(body.summary ?? {});
  if (!content.success || !options.success) return Response.json({ ok: false, error: 'Valid provided content and summary options are required.' }, { status: 400 });
  const [{ getSessionUserOrDefault }, { activeWorkspaceId }] = await Promise.all([import('../../../auth'), import('../../../workspace-registry')]);
  const user = await getSessionUserOrDefault(req.headers);
  const workspaceId = activeWorkspaceId();
  if (!user?.id || !workspaceId || workspaceId === '*') return Response.json({ ok: false, error: 'A current user and workspace are required.' }, { status: 401 });
  try {
    // Shared decoder: also decodes base64 PDFs inside a `collection` payload.
    const input: ContentInput = decodeProvidedContent(content.data);
    const source = await readContent(input, { workspaceId, readerId: `user:${user.id}`, signal }, { authorize: async candidate => candidate.kind !== 'reference' });
    return Response.json({ ok: true, ...await summarizeContent(source, options.data, signal) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ContentIntakeError || error instanceof ContentSummaryError) {
      const status = error.code === 'cancelled' ? 499 : error.code === 'cloud-consent-required' ? 403 : error.code === 'budget-exceeded' ? 429 : error.code === 'local-route-unavailable' ? 503 : error instanceof ContentIntakeError ? 422 : 502;
      return Response.json({ ok: false, code: error.code, error: error.message,
        ...(error instanceof ContentSummaryError && error.diagnostics ? { diagnostics: error.diagnostics } : {}) }, { status });
    }
    throw error;
  }
}

/** Explicit original reading on the same speech endpoint; never a summary operation. */
async function readingResponse(body: Record<string, unknown>, requestSignal: AbortSignal): Promise<Response> {
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return Response.json({ ok: false, error: 'text (string) required' }, { status: 400 });
  if (text.length > CONTENT_LIMITS.maxChars || Buffer.byteLength(text, 'utf8') > CONTENT_LIMITS.maxInputBytes) {
    return Response.json({ ok: false, error: 'Source exceeds the reading limit; select a smaller section.' }, { status: 413 });
  }
  if (body.format !== undefined && body.format !== 'text' && body.format !== 'markdown') {
    return Response.json({ ok: false, error: 'format must be text or markdown' }, { status: 400 });
  }
  if (body.allowCloud !== undefined && typeof body.allowCloud !== 'boolean') {
    return Response.json({ ok: false, error: 'allowCloud must be a boolean' }, { status: 400 });
  }
  // This loopback route consumes supplied text only: no reference dereference,
  // file access, or remote fetching. Source readers retain their existing ACLs.
  const prefs = await loadVoicePrefs();
  const abort = new AbortController();
  const signal = AbortSignal.any([requestSignal, abort.signal]);
  const reading = synthesizeReading(text, prefs, {
    format: body.format as 'text' | 'markdown' | undefined,
    allowCloud: body.allowCloud === true,
    signal,
  });
  // Surface initial provider/privacy errors as an actionable HTTP error. Later
  // failures are stream records and never produce a false completed receipt.
  const first = await reading.next();
  if (first.value && !first.value.ok) {
    await reading.return(undefined);
    return Response.json(first.value, { status: first.value.status });
  }
  const encode = (record: unknown) => new TextEncoder().encode(JSON.stringify(record) + '\n');
  let emitted = 0;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) { controller.close(); return; }
        const next = started ? await reading.next() : first;
        started = true;
        if (signal.aborted) { controller.close(); return; }
        if (next.done) {
          controller.enqueue(encode({ ok: true, type: 'completed', chunks: emitted }));
          controller.close();
          return;
        }
        const result = next.value;
        if (!result.ok) {
          controller.enqueue(encode({ ...result, type: 'error', chunks: emitted }));
          controller.close();
          return;
        }
        const { audio, ...progress } = result;
        controller.enqueue(encode({ ...progress, type: 'chunk', audioBase64: Buffer.from(audio).toString('base64') }));
        emitted++;
      } catch (error) { abort.abort(); controller.error(error); }
    },
    async cancel() { abort.abort(); await reading.return(undefined); },
  }, { highWaterMark: 0 });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}

// Re-export the canonical synth so existing `from './operator-tts'` importers
// (voice-node/agent-peer.ts, sentinel-proactive-sweep-deps.ts, the voice-io /
// elevenlabs-live tests) keep resolving without a churn of import rewrites.
export { synthesize, type Synth, type SynthOptions } from './tts-synth';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-tts',
  auth: 'loopback',
  // Summaries own a bounded budget up to 180s, as on documents:read. The
  // watchdog must permit that budget and abort the same underlying work.
  timeoutSec: 190,
  async handler(req, ctx) {
    const signal = ctx?.signal ? AbortSignal.any([req.signal, ctx.signal]) : req.signal;
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ ok: false, error: 'JSON object required' }, { status: 400 });
    }
    if (body.operation === 'read') return readingResponse(body, signal);
    if (body.operation === 'summarize') return summaryResponse(req, body, signal);
    if (body.operation !== undefined) return Response.json({ ok: false, error: 'unsupported operation' }, { status: 400 });
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return Response.json({ ok: false, error: 'text (string) required' }, { status: 400 });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return Response.json({
        ok: false,
        error: 'text must be at most ' + MAX_TEXT_CHARS + ' characters per request',
      }, { status: 413 });
    }
    const prefs = await loadVoicePrefs();
    // Resolve engine + apply the browser→kokoro health-gated fallback (D-006):
    // 'browser' (speechSynthesis) is meaningless in a terminal, so it maps to
    // local kokoro only when kokoro can synthesize here — an HTTP kokoro server
    // OR the provisioned in-process engine (P-009) — else a clean error.
    const resolved = await resolveTtsEngine(body.engine, prefs, () => kokoroTtsAvailable());
    if (!resolved.ok) {
      return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
    }
    const engine = resolved.engine;
    const voiceId = typeof body.voiceId === 'string' && body.voiceId ? body.voiceId : undefined;

    const synth = await synthesize(engine, text, voiceId, prefs, { signal });
    if (!synth.ok) {
      return Response.json({ ok: false, error: synth.error, engine }, { status: synth.status });
    }
    return Response.json({
      ok: true,
      engine,
      contentType: synth.contentType,
      audioBase64: Buffer.from(synth.audio).toString('base64'),
    });
  },
});
