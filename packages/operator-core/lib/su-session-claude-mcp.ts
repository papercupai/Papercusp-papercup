/** Private SDK transport for the existing operator MCP host. Credentials stay
 * in this process; the CLI receives only the SDK server's name and framing. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

export async function createClaudeNativeMcpServer(input: {
  url: string;
  headers: Readonly<Record<string, string>>;
  runtimeBearer: string;
  beforeToolCall(callId: string, signal: AbortSignal): Promise<boolean>;
  onToolsListed?(tools: Array<{ name: string; annotations?: { readOnly?: boolean } }>): void;
}, host?: {
  register(server: McpServer): void;
  options(): ConstructorParameters<typeof McpServer>[1];
}): Promise<McpServer> {
  let canonical = host;
  if (!canonical) {
    const module = await import('./endpoint-route/routes/transport/_mcp-host');
    canonical = { register: module.registerMcpHost, options: module.mcpHostServerOptions };
  }
  const server = new McpServer({ name: 'papercusp-su', version: '1' }, canonical.options());
  const register = server.server.setRequestHandler.bind(server.server);
  const headers = Object.freeze({ ...input.headers, host: new URL(input.url).host });
  server.server.setRequestHandler = (schema, handler) => register(schema, async (request, extra) => {
    const callId = request.method === 'tools/call' ? request.params?._meta?.['claudecode/toolUseId'] : undefined;
    // Metadata only rendezvouses with the independently observed root call.
    // Unobserved/subagent calls retain the ordinary path with NO private bearer.
    const observed = typeof callId === 'string' && await input.beforeToolCall(callId, extra.signal);
    const result = await handler(request, { ...extra, requestInfo: { url: new URL(input.url),
      headers: { ...headers, ...(observed ? { 'x-papercusp-native-runtime': input.runtimeBearer } : {}) } } });
    if (request.method === 'tools/list') input.onToolsListed?.(ListToolsResultSchema.parse(result).tools.map(tool => ({
      name: tool.name,
      ...(typeof tool.annotations?.readOnlyHint === 'boolean' ? { annotations: { readOnly: tool.annotations.readOnlyHint } } : {}),
    })));
    return result;
  });
  canonical.register(server);
  return server;
}
