/**
 * OMP 18 owned in-process MCP extension. Built with the same client assembly
 * ptool uses; no stdio child, forked runtime, or HTTP intermediary on the UDS leg.
 */
import { readFile } from 'node:fs/promises';
import { closeSync, createReadStream, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  connectAgentMcp, type NativeOmpConfig, type SuNativeToolCall,
} from '../../operator-core/lib/agent-mcp-client';

type NativeToolCallHandler = (event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
  context: { sessionManager: { getSessionId(): string } }) => Promise<void | { block: true; reason: string }>;

export interface NativeExtensionApi {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    mcpServerName: string; mcpToolName: string; approval: 'read' | 'write';
    strict: false;
    execute(id: string, params: Record<string, unknown>, signal?: AbortSignal,
      onUpdate?: unknown, context?: { sessionManager: { getSessionId(): string } }): Promise<unknown>;
  }): void;
  on(name: 'session_shutdown', handler: () => Promise<void>): void;
  on(name: 'tool_call' | 'tool_result', handler: NativeToolCallHandler): void;
}

export async function registerNativeMcp(pi: NativeExtensionApi, config: NativeOmpConfig,
  nativeHook?: { observe(call: SuNativeToolCall): Promise<void>; close(): void }): Promise<void> {
  const native = config.papercuspNativeMcp;
  if (!native || native.version !== 1) return;
  const connections: Array<Awaited<ReturnType<typeof connectAgentMcp>>> = [];
  const originals = new Map<string, SuNativeToolCall>();
  const callKey = (call: SuNativeToolCall) => JSON.stringify([call.nativeSessionId, call.callId]);
  pi.on('session_shutdown', async () => {
    originals.clear();
    nativeHook?.close();
    await Promise.allSettled(connections.map(x => x.client.close()));
  });
  if (nativeHook) pi.on('tool_call', async (event, context) => {
    try {
      // Snapshot BEFORE yielding to another hook. Rewriters may change both
      // the returned input and OMP's later assistant-message snapshot.
      const call = structuredClone({ nativeSessionId: context.sessionManager.getSessionId(),
        callId: event.toolCallId, tool: event.toolName, arguments: event.input });
      const key = callKey(call);
      if (originals.has(key) || originals.size >= 1000) throw new Error('native_hook_original_conflict');
      await nativeHook.observe(call);
      originals.set(key, call);
    } catch (error) {
      // Fixed error codes only: never echo native arguments or credentials.
      const code = error instanceof Error && /^native_hook_[a-z_]+$/.test(error.message)
        ? error.message : error instanceof Error && error.name === 'DataCloneError' ? 'snapshot_failed' : 'unknown';
      console.error('[papercusp-native-hook] observation-refused', code);
      return { block: true, reason: 'The native host could not retain the original tool call.' };
    }
  });
  if (nativeHook) pi.on('tool_result', async (event, context) => {
    const key = JSON.stringify([context.sessionManager.getSessionId(), event.toolCallId]);
    const original = originals.get(key);
    try {
      if (!original || original.tool !== event.toolName) throw new Error('native_hook_original_missing');
      // tool_result carries the actual input after other hooks have rewritten
      // it. Keep it separate from the snapshot acknowledged before execution.
      await nativeHook.observe(structuredClone({ ...original, executedArguments: event.input }));
    } catch {
      console.error('[papercusp-native-hook] execution-observation-refused');
      throw new Error('native_hook_execution_observation_refused');
    } finally { originals.delete(key); }
  });
  try {
    for (const [name, server] of Object.entries(native.servers)) {
      if (!server.url) throw new Error('native_mcp_url_missing');
      const headers = { ...server.headers };
      for (const value of Object.values(headers)) {
        // Never run shell-derived headers inside this adapter. The launcher
        // resolves its known credential fields before handing us the config.
        if (value.startsWith('!')) throw new Error('native_mcp_unresolved_header');
      }
      const connection = await connectAgentMcp({
        url: server.url, headers, mode: native.mode, home: native.home,
        name: 'papercusp-omp-native', timeoutMs: 15_000,
      });
      connections.push(connection);
      const { client } = connection;
      let catalog = new Set<string>();
      const refresh = async () => {
        const next = new Set<string>();
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const tool of page.tools) {
            next.add(tool.name);
            pi.registerTool({
              name: `mcp__${name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
              label: `${name}/${tool.name}`, description: tool.description ?? '',
              parameters: tool.inputSchema, mcpServerName: name, mcpToolName: tool.name,
              approval: tool.annotations?.readOnlyHint === true ? 'read' : 'write', strict: false,
              async execute(id, params, signal, _onUpdate, context) {
                if (!catalog.has(tool.name)) throw new Error('native_mcp_tool_removed');
                // Read the native callback's current session for EVERY call,
                // including after OMP rotates it. Inherited env/config and model
                // arguments cannot supply this identity. Reuse the existing MCP
                // threadId/callId carrier; the host still verifies its binding,
                // exact observed call, principal and ACL independently.
                const sessionId = context?.sessionManager.getSessionId();
                const nativeCall = typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
                  && typeof id === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(id)
                  ? { threadId: sessionId, callId: id } : undefined;
                const result = await client.callTool({ name: tool.name, arguments: params,
                  ...(nativeCall ? { _meta: nativeCall } : {}) }, undefined, { signal });
                return {
                  content: result.content,
                  details: {
                    ...result,
                    // Client-observed connection, never a server-authored claim.
                    // Keep compact model-visible content untouched and expose no
                    // socket paths, credential headers or credential-bearing URLs.
                    nativeMcp: {
                      transportKind: connection.transportKind,
                      ...(connection.operatorId ? { operatorId: connection.operatorId } : {}),
                      ...(connection.generation ? { generation: connection.generation } : {}),
                    },
                  },
                  isError: result.isError,
                };
              },
            });
          }
          cursor = page.nextCursor;
          if (cursor && seenCursors.has(cursor)) throw new Error('native_mcp_catalog_cursor_cycle');
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        catalog = next;
      };
      // SDK notifications are PUSH. Removed entries cannot execute through old
      // OMP registrations; new/changed entries replace the named registration.
      client.setNotificationHandler(ToolListChangedNotificationSchema, refresh);
      await refresh();
    }
  } catch (error) {
    nativeHook?.close();
    await Promise.allSettled(connections.map(x => x.client.close()));
    throw error;
  }
}

/** The process parent supplies this descriptor, not MCP configuration/model
 * arguments. Its ACK only proves host observation, never scope or execution. */
function connectNativeHook(): { observe(call: SuNativeToolCall): Promise<void>; close(): void } | undefined {
  const descriptor = process.env.PAPERCUSP_NATIVE_HOOK_FD;
  delete process.env.PAPERCUSP_NATIVE_HOOK_FD;
  if (descriptor === undefined) return;
  if (descriptor !== '3') throw new Error('native_hook_descriptor_invalid');
  // Bun 1.3 treats an inherited net.Socket({fd}) as read-only even when the
  // descriptor is a duplex socket. Standard fd streams preserve both halves
  // in Node and the installed Bun OMP runtime; the host still owns this pipe.
  const input = createReadStream('', { fd: 3, autoClose: false });
  const output = createWriteStream('', { fd: 3, autoClose: false });
  let sequence = 0, buffer = '', stopped = false;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const close = (reason: 'shutdown' | 'pipe_error' | 'pipe_closed' | 'invalid_ack' | 'timeout' | 'write_failed' = 'shutdown') => {
    if (stopped) return;
    if (reason !== 'shutdown') console.error('[papercusp-native-hook] closed', reason);
    stopped = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('native_hook_closed')); }
    pending.clear(); input.destroy(); output.destroy();
    try { closeSync(3); } catch { /* The process owns this descriptor exclusively. */ }
  };
  input.setEncoding('utf8');
  const pipeError = (error: NodeJS.ErrnoException) => {
    if (stopped) return;
    console.error('[papercusp-native-hook] pipe-error', /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'unknown');
    close('pipe_error');
  };
  input.on('error', pipeError); output.on('error', pipeError);
  input.on('end', () => close('pipe_closed'));
  input.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 4096) { close('invalid_ack'); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line), request = pending.get(frame.id);
        if (!request || Object.keys(frame).sort().join(',') !== 'id,ok' || typeof frame.ok !== 'boolean') { close('invalid_ack'); return; }
        pending.delete(frame.id); clearTimeout(request.timer);
        if (frame.ok) request.resolve(); else request.reject(new Error('native_hook_refused'));
      } catch { close('invalid_ack'); return; }
    }
  });
  return { close, observe(call) {
    if (stopped) return Promise.reject(new Error('native_hook_closed'));
    const id = ++sequence, line = JSON.stringify({ id, ...call }) + '\n';
    if (Buffer.byteLength(line) > 1_048_576) return Promise.reject(new Error('native_hook_frame_too_large'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => close('timeout'), 15_000);
      pending.set(id, { resolve, reject, timer });
      output.write(line, error => {
        if (!error) return;
        const code = (error as NodeJS.ErrnoException).code;
        console.error('[papercusp-native-hook] write-error', typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown');
        close('write_failed');
      });
    });
  } };
}

export default async function nativeExtension(pi: NativeExtensionApi): Promise<void> {
  const explicitAgent = process.env.PI_CODING_AGENT_DIR;
  const configRoot = process.env.PI_CONFIG_DIR;
  const agentDir = explicitAgent ?? (configRoot
    ? join(isAbsolute(configRoot) ? configRoot : join(homedir(), configRoot), 'agent')
    : join(homedir(), '.omp', 'agent'));
  const raw = await readFile(join(agentDir, 'mcp.json'), 'utf8');
  const hook = connectNativeHook();
  try { await registerNativeMcp(pi, JSON.parse(raw), hook); }
  catch (error) { hook?.close(); throw error; }
}
