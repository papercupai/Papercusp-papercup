/**
 * The MCP server names Papercusp registers its own tool catalog under.
 *
 * Every client mangles a tool name with the SERVER name it was registered
 * under (Claude: `mcp__<server>__<group>_<verb>`; Codex:
 * `mcp__<server with - → _>.<group>_<verb>`), so any reader that has to undo
 * that mangling needs the exact set of names the writers use. Keep both sides
 * on these constants: the launch-config writers key their `mcpServers` entry
 * with them, and `canonicalSessionPartToolName` derives its accepted prefixes
 * from {@link PAPERCUSP_MCP_SERVER_NAMES}. A server name added here is picked
 * up by the reader with no second edit (WI-6554700010008643: the reader knew
 * only `papercusp-su`, so ~13k rows/day from `papercusp` spawns stayed mangled).
 *
 * Dependency-free on purpose: the transcript ingester imports this, and it must
 * not pull in launch/config modules with filesystem side effects.
 */

/** Headless/spawned agents and console launches (`role-launch-spec`, `console-launcher`, Codex homes). */
export const PAPERCUSP_MCP_SERVER = 'papercusp';

/** The interactive psu server in `~/.claude.json` / `[mcp_servers.papercusp-su]`. */
export const PSU_MCP_SERVER = 'papercusp-su';

/** Every server name a Papercusp tool call can be mangled with. */
export const PAPERCUSP_MCP_SERVER_NAMES: readonly string[] = [PAPERCUSP_MCP_SERVER, PSU_MCP_SERVER];
