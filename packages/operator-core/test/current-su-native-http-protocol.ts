/** Local scripted Responses protocol; no provider credentials or forwarding. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { decode } from '@papercusp/result-encoding';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../lib/inference-gateway/codex-cli-bridge';

type Body = Record<string, unknown>;
type Tool = { type: string; name: string; tools?: Tool[] };

function queuedCompactionAcknowledgement(value: unknown): Body | null {
  if (typeof value === 'string') {
    try { return queuedCompactionAcknowledgement(JSON.parse(value)); } catch { /* Try the lossless compact format. */ }
    const marker = /^format:\s*toon\n/.exec(value);
    if (!marker) return null;
    try { return queuedCompactionAcknowledgement(decode(value.slice(marker[0].length), 'toon')); }
    catch { return null; }
  }
  if (Array.isArray(value)) return value.map(queuedCompactionAcknowledgement).find(Boolean) ?? null;
  if (!value || typeof value !== 'object') return null;
  const body = value as Body;
  if (body.isError === true || body.ok === false) return null;
  if (body.requested === true && (body.respawn === 'queued' || body.status === 'queued')) return body;
  if (body.structuredContent !== undefined) return queuedCompactionAcknowledgement(body.structuredContent);
  if (Array.isArray(body.content)) return queuedCompactionAcknowledgement(body.content);
  // Native code-mode results use input_text; direct MCP results use text.
  // Decode only these transport bodies, never incidental prose in other fields.
  return ['text', 'input_text'].includes(String(body.type)) && typeof body.text === 'string'
    ? queuedCompactionAcknowledgement(body.text) : null;
}

export const FROZEN_NATIVE_CARRY_NOTE = 'The assignment already changed answer.txt to after; verify that retained edit.';
export const FROZEN_NATIVE_CARRY_LIMIT = 20_000;

/** Observe actual native provider input, independently of the carry builder.
 * Hash the exact delivered bytes; an echo, a queue receipt or a substring in a
 * tool result cannot certify a fresh user turn. */
export function inspectFrozenNativeCarryInput(body: Body, expected: {
  mode: 'on' | 'off'; initialPrompt: string; predecessorId: string;
}) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const input = Array.isArray(body.input) ? body.input as Body[] : [];
  const userTurns = input.filter(item => item.role === 'user').map(item => typeof item.content === 'string'
    ? item.content : Array.isArray(item.content) ? item.content.map(part =>
      part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('') : '');
  const turns = userTurns.filter(text => /^⟦turn-origin:self-compaction nonce:[a-f0-9]+⟧\n/.test(text));
  assert.equal(turns.length, 1, 'Frozen carry needs exactly one native user turn with its leading provenance');
  assert.ok(!input.some(item => ['function_call_output', 'custom_tool_call_output'].includes(String(item.type))),
    'Fresh carry must not replay predecessor tool results');
  const actual = turns[0];
  const match = /^⟦turn-origin:self-compaction nonce:[a-f0-9]+⟧\n([\s\S]*?)\n\n⟦codex-carry-lineage predecessor:([^⟧]+)⟧\n/.exec(actual);
  assert.ok(match, 'Frozen carry native turn lacks its exact first prompt and lineage boundary');
  assert.equal(match[2], expected.predecessorId, 'Frozen carry names a foreign predecessor');
  const note = expected.mode === 'on' ? FROZEN_NATIVE_CARRY_NOTE : null;
  const firstPrompt = expected.initialPrompt + (note
    ? `\n\nContinuation note from this assignment's prior session:\n${note}` : '');
  assert.equal(match[1], firstPrompt, 'Native delivered carry differs from its frozen task/note bytes');
  if (!note) assert.ok(!JSON.stringify(body.input).includes(FROZEN_NATIVE_CARRY_NOTE), 'Carry-off received the prior note');
  return { mode: expected.mode, inputSha256: hash(actual), firstPromptSha256: hash(match[1]),
    initialPromptSha256: hash(expected.initialPrompt), noteSha256: note ? hash(note) : null };
}

function offeredTools(body: Body) {
  const flattened: Array<Tool & { namespace?: string }> = [];
  const visit = (tools: Tool[], namespace?: string) => {
    for (const tool of tools) {
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) visit(tool.tools, tool.name);
      else flattened.push({ ...tool, namespace });
    }
  };
  visit(Array.isArray(body.tools) ? body.tools as Tool[] : []);
  return flattened;
}

function scriptedTool(body: Body, kind: 'edit' | 'compact', options: { frozen?: boolean } = {}) {
  const flattened = offeredTools(body);
  const command = "printf 'after\\n' > /app/answer.txt";
  const direct = flattened.find(tool => tool.type === 'function' && (kind === 'edit'
    ? /(?:^|__)exec_command$/.test(tool.name)
    : /(?:^|__)session_request_compaction$/.test(tool.name)));
  const invoke = flattened.find(tool => tool.type === 'function' && /(?:^|__)tools_invoke$/.test(tool.name));
  const exec = flattened.find(tool => tool.type === 'custom' && tool.name === 'exec' && tool.namespace === 'functions');
  const tool = direct ?? (kind === 'compact' ? invoke : undefined) ?? exec;
  assert.ok(tool, `Native ${kind} tool missing: ${JSON.stringify(flattened.map(({ type, name, namespace }) => ({ type, name, namespace })))}`);
  const compactArgs = options.frozen ? { continueNote: FROZEN_NATIVE_CARRY_NOTE } : {};
  const input = direct ? kind === 'edit' ? { cmd: command } : compactArgs
    : kind === 'compact' ? { name: 'session:request-compaction', args: compactArgs } : { cmd: command };
  const text = tool === exec ? kind === 'edit'
    ? `text(await tools.exec_command(${JSON.stringify(input)}));`
    : `text(await tools.mcp__papercusp_su__tools_invoke(${JSON.stringify(input)}));` : JSON.stringify(input);
  const call = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
    id: 'fc_private_' + kind, call_id: 'call_private_' + kind, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    ...(tool.type === 'custom' ? { input: text } : { arguments: text }), status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: String(body.model), text: '',
    inputTokens: options.frozen ? FROZEN_NATIVE_CARRY_LIMIT + 2_000 : 100, outputTokens: 8 }), output: [call] };
  return ['response.output_item.added', 'response.output_item.done', 'response.completed'].map(type =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(type === 'response.completed'
      ? { response } : { output_index: 0, item: call }) })}\n\n`).join('') + 'data: [DONE]\n\n';
}

export function createCurrentSuNativeProtocol(options: { frozen?: boolean } = {}) {
  let initialBody: Body | undefined, initialInput: string | undefined;
  let stage: 'initial' | 'edit' | 'compact' | 'queued' = 'initial';
  let carryInputSeen = false;
  let predecessorSessionId: string | undefined;
  let queuedCarry: Body | null = null;
  const census: Array<Record<string, unknown>> = [];
  const acknowledgement = (body: Body) => codexCliResponsesCompletionSse(codexCliResponsesBody({
    model: String(body.model), text: 'Private managed carry protocol acknowledgement.', inputTokens: 100, outputTokens: 8,
  }));
  return {
    get initialBody() { return initialBody; },
    get carryRequested() { return stage === 'queued'; },
    get carryInputSeen() { return carryInputSeen; },
    get predecessorSessionId() { return predecessorSessionId; },
    get queuedCarry() { return queuedCarry; },
    census,
    async respond(body: Body, proof: { predecessorSessionId: string | null; editApplied: () => boolean;
      binding?: { read: () => Promise<string | null>; deadlineMs: number };
      beforeCompaction?: (nativeId: string) => Promise<void> }) {
      const input = JSON.stringify(body.input) ?? '';
      const items = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const outputs = items.filter(item => item && ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)));
      const result = (kind: 'edit' | 'compact') => outputs.find(item => item.call_id === 'call_private_' + kind);
      const expectedPredecessorSessionId = predecessorSessionId ?? proof.predecessorSessionId;
      const lineage = Boolean(expectedPredecessorSessionId) && input.includes('codex-carry-lineage predecessor:' + expectedPredecessorSessionId);
      const tools = offeredTools(body);
      const row: Record<string, unknown> = { index: census.length + 1, at: new Date().toISOString(),
        stage, bodyKeys: Object.keys(body), inputBytes: Buffer.byteLength(input),
        inputHash: createHash('sha256').update(input).digest('hex'), lineage, expectedPredecessorSessionId,
        tools: tools.map(({ type, name, namespace }) => ({ type, name, namespace })),
        outputs: outputs.map(item => ({ type: item.type, callId: item.call_id,
          // Retain only our fixed protocol results, never the full launch prompt.
          ...(['call_private_edit', 'call_private_compact'].includes(String(item.call_id))
            ? { output: String(typeof item.output === 'string' ? item.output : JSON.stringify(item.output)).slice(-5000) } : {}) })),
        action: 'acknowledge' };
      census.push(row);
      try {
        if (stage === 'compact' && result('compact')) {
          const received = JSON.stringify(result('compact')!.output) ?? '';
          queuedCarry = queuedCompactionAcknowledgement(result('compact')!.output);
          assert.ok(queuedCarry,
            'Managed boundary did not queue: ' + received.slice(-5000));
          stage = 'queued';
        }
        carryInputSeen ||= stage === 'queued' && lineage;
        // A tool-free request has no driving step. Its purpose is deliberately
        // not inferred; the census preserves the framing for native diagnosis.
        if (!tools.length || stage === 'queued') return acknowledgement(body);
        if (stage === 'initial' && input.includes('<cwd>/app</cwd>')) {
          const wire = scriptedTool(body, 'edit', options);
          initialBody = body; initialInput = input; stage = 'edit'; row.action = 'edit';
          return wire;
        }
        if ((stage === 'edit' || stage === 'compact') && result('edit')) {
          assert.ok(proof.editApplied(), 'Native scripted edit was not applied before compaction');
          const wire = scriptedTool(body, 'compact', options);
          // Initial transport can precede native binding; after compaction the
          // same database row can name the successor. Freeze at the boundary
          // we actually drive, never infer identity from the carry text itself.
          let boundId = predecessorSessionId ?? proof.predecessorSessionId;
          if (!boundId && proof.binding) {
            const binding = proof.binding;
            assert.ok(Number.isFinite(binding.deadlineMs), 'Native binding needs the existing task deadline');
            row.bindingWait = true;
            row.action = 'awaiting-binding';
            // The fast scripted edit can finish before the launcher's native
            // persistence proof publishes its mapping. Hold THIS response,
            // without granting another task budget or deriving an id from text.
            while (!boundId) {
              const remaining = binding.deadlineMs - Date.now();
              assert.ok(remaining > 0, 'Native predecessor binding deadline expired before compaction');
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                boundId = await Promise.race([binding.read(), new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('Native predecessor binding deadline expired before compaction')), remaining);
                })]);
              } finally { clearTimeout(timer); }
              if (!boundId) await new Promise(resolve => setTimeout(resolve, Math.min(50,
                Math.max(0, binding.deadlineMs - Date.now()))));
            }
            assert.ok(proof.editApplied(), 'Native scripted edit was not applied before compaction');
          }
          assert.ok(boundId, 'Native predecessor must be bound before compaction');
          predecessorSessionId ??= boundId;
          await proof.beforeCompaction?.(predecessorSessionId);
          row.expectedPredecessorSessionId = predecessorSessionId;
          stage = 'compact'; row.action = 'compact';
          return wire;
        }
        // A transport retry of the kickoff gets the same idempotent edit call.
        if (stage === 'edit' && input === initialInput) { row.action = 'edit-retry'; return scriptedTool(body, 'edit', options); }
        return acknowledgement(body);
      } catch (error) { row.action = 'failed'; row.error = String(error); throw error; }
      finally { row.nextStage = stage; }
    },
  };
}

/** Node does not await an async request listener. Turn its rejection into an
 * awaited scenario failure so the owner's finally can return container files. */
export function guardedCurrentSuNativeHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  report: (error: unknown) => void) {
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Requests can fail before the scenario reaches its race; keep that failure
  // latched without producing a detached unhandled rejection in the meantime.
  void failure.catch(() => {});
  const listener: RequestListener = (req, res) => {
    void Promise.resolve().then(() => handler(req, res)).catch(error => {
      let observed = error;
      try { report(error); } catch (reportError) { observed = new AggregateError([error, reportError], 'Native handler and diagnostic retention failed'); }
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Private native protocol handler failed' } }));
      } catch { res.destroy(); }
      rejectFailure(observed);
    });
  };
  return { listener, failure };
}
