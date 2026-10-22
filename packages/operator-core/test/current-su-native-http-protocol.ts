/** Local scripted Responses protocol; no provider credentials or forwarding. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { decode } from '@papercusp/result-encoding';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../lib/inference-gateway/codex-cli-bridge';

type Body = Record<string, unknown>;
type Tool = { type: string; name: string; tools?: Tool[] };

function queuedCompactionAcknowledgement(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return queuedCompactionAcknowledgement(JSON.parse(value)); } catch { /* Try the lossless compact format. */ }
    const marker = /^format:\s*toon\n/.exec(value);
    if (!marker) return false;
    try { return queuedCompactionAcknowledgement(decode(value.slice(marker[0].length), 'toon')); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.some(queuedCompactionAcknowledgement);
  if (!value || typeof value !== 'object') return false;
  const body = value as Body;
  if (body.isError === true || body.ok === false) return false;
  if (body.requested === true && (body.respawn === 'queued' || body.status === 'queued')) return true;
  if (body.structuredContent !== undefined) return queuedCompactionAcknowledgement(body.structuredContent);
  if (Array.isArray(body.content)) return queuedCompactionAcknowledgement(body.content);
  // Native code-mode results use input_text; direct MCP results use text.
  // Decode only these transport bodies, never incidental prose in other fields.
  return ['text', 'input_text'].includes(String(body.type)) && typeof body.text === 'string'
    && queuedCompactionAcknowledgement(body.text);
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

function scriptedTool(body: Body, kind: 'edit' | 'compact') {
  const flattened = offeredTools(body);
  const command = "printf 'after\\n' > /app/answer.txt";
  const direct = flattened.find(tool => tool.type === 'function' && (kind === 'edit'
    ? /(?:^|__)exec_command$/.test(tool.name)
    : /(?:^|__)session_request_compaction$/.test(tool.name)));
  const invoke = flattened.find(tool => tool.type === 'function' && /(?:^|__)tools_invoke$/.test(tool.name));
  const exec = flattened.find(tool => tool.type === 'custom' && tool.name === 'exec' && tool.namespace === 'functions');
  const tool = direct ?? (kind === 'compact' ? invoke : undefined) ?? exec;
  assert.ok(tool, `Native ${kind} tool missing: ${JSON.stringify(flattened.map(({ type, name, namespace }) => ({ type, name, namespace })))}`);
  const input = direct ? kind === 'edit' ? { cmd: command } : {}
    : kind === 'compact' ? { name: 'session:request-compaction', args: {} } : { cmd: command };
  const text = tool === exec ? kind === 'edit'
    ? `text(await tools.exec_command(${JSON.stringify(input)}));`
    : `text(await tools.mcp__papercusp_su__tools_invoke(${JSON.stringify(input)}));` : JSON.stringify(input);
  const call = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
    id: 'fc_private_' + kind, call_id: 'call_private_' + kind, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    ...(tool.type === 'custom' ? { input: text } : { arguments: text }), status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: String(body.model), text: '', inputTokens: 100, outputTokens: 8 }), output: [call] };
  return ['response.output_item.added', 'response.output_item.done', 'response.completed'].map(type =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(type === 'response.completed'
      ? { response } : { output_index: 0, item: call }) })}\n\n`).join('') + 'data: [DONE]\n\n';
}

export function createCurrentSuNativeProtocol() {
  let initialBody: Body | undefined, initialInput: string | undefined;
  let stage: 'initial' | 'edit' | 'compact' | 'queued' = 'initial';
  let carryInputSeen = false;
  let predecessorSessionId: string | undefined;
  const census: Array<Record<string, unknown>> = [];
  const acknowledgement = (body: Body) => codexCliResponsesCompletionSse(codexCliResponsesBody({
    model: String(body.model), text: 'Private managed carry protocol acknowledgement.', inputTokens: 100, outputTokens: 8,
  }));
  return {
    get initialBody() { return initialBody; },
    get carryRequested() { return stage === 'queued'; },
    get carryInputSeen() { return carryInputSeen; },
    get predecessorSessionId() { return predecessorSessionId; },
    census,
    respond(body: Body, proof: { predecessorSessionId: string; editApplied: () => boolean }) {
      const input = JSON.stringify(body.input) ?? '';
      const items = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const outputs = items.filter(item => item && ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)));
      const result = (kind: 'edit' | 'compact') => outputs.find(item => item.call_id === 'call_private_' + kind);
      const expectedPredecessorSessionId = predecessorSessionId ?? proof.predecessorSessionId;
      const lineage = input.includes('codex-carry-lineage predecessor:' + expectedPredecessorSessionId);
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
          assert.ok(queuedCompactionAcknowledgement(result('compact')!.output),
            'Managed boundary did not queue: ' + received.slice(-5000));
          stage = 'queued';
        }
        carryInputSeen ||= stage === 'queued' && lineage;
        // A tool-free request has no driving step. Its purpose is deliberately
        // not inferred; the census preserves the framing for native diagnosis.
        if (!tools.length || stage === 'queued') return acknowledgement(body);
        if (stage === 'initial' && input.includes('<cwd>/app</cwd>')) {
          const wire = scriptedTool(body, 'edit');
          initialBody = body; initialInput = input; stage = 'edit'; row.action = 'edit';
          return wire;
        }
        if ((stage === 'edit' || stage === 'compact') && result('edit')) {
          assert.ok(proof.editApplied(), 'Native scripted edit was not applied before compaction');
          const wire = scriptedTool(body, 'compact');
          // Initial transport can precede native binding; after compaction the
          // same database row can name the successor. Freeze at the boundary
          // we actually drive, never infer identity from the carry text itself.
          assert.ok(proof.predecessorSessionId, 'Native predecessor must be bound before compaction');
          predecessorSessionId ??= proof.predecessorSessionId;
          row.expectedPredecessorSessionId = predecessorSessionId;
          stage = 'compact'; row.action = 'compact';
          return wire;
        }
        // A transport retry of the kickoff gets the same idempotent edit call.
        if (stage === 'edit' && input === initialInput) { row.action = 'edit-retry'; return scriptedTool(body, 'edit'); }
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
