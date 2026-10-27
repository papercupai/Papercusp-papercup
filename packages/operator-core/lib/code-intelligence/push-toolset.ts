/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-006 (SPEC-P-006-B, AUTO-BAR-R-5-P-006): a push
 * or task brief names a follow-up tool only when the recipient session was LISTED that tool.
 *
 * The list is the session's last tools/list after every listing filter (seed, identity, role,
 * confinement), recorded by the MCP host in harness_shared.session_exposed_tools. It has to be
 * durable: the in-memory session surface (tool-allowlist.ts) lives in one operator process, and a
 * hook push can be served by a different one. No row, or a read that fails, is an UNKNOWN
 * toolset, and an unknown toolset names no tool. The answer itself is always inline, so dropping
 * the suggestion never drops the fact.
 */
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { normalizeMcpName } from '@papercusp/tooldef';

export type RecipientToolset =
  | { status: 'measured'; tools: ReadonlySet<string> }
  | { status: 'unknown'; reason: 'no-listing' | 'read-failed' | 'no-owner' };

export const UNKNOWN_TOOLSET: RecipientToolset = Object.freeze({ status: 'unknown', reason: 'no-listing' });

/** A measured toolset from listed names. An empty listing is measured and names nothing. */
export function toolsetFromNames(names: readonly string[]): RecipientToolset {
  return { status: 'measured', tools: new Set(names.filter(name => typeof name === 'string' && name.trim())
    .map(name => normalizeMcpName(name.trim()))) };
}

/** The tool a rendered call names: its first whitespace-delimited token (`testing:run {...}`). */
export function calledTool(call: string): string {
  return call.trim().split(/\s+/, 1)[0] ?? '';
}

export function canCall(toolset: RecipientToolset, tool: string): boolean {
  return toolset.status === 'measured' && tool.trim().length > 0 && toolset.tools.has(normalizeMcpName(tool.trim()));
}

/** The call when the recipient was listed its tool; otherwise undefined (never a partial call). */
export function callableSuggestion(call: string | null | undefined, toolset: RecipientToolset): string | undefined {
  return call && canCall(toolset, calledTool(call)) ? call : undefined;
}

const SAMPLE_READ_MS = 100;

/** Read the recipient's last listed toolset. Bounded; any failure is unknown, never "all tools". */
export async function readRecipientToolset(input: { workspace: string; owner: string }): Promise<RecipientToolset> {
  if (!input.workspace?.trim() || !input.owner?.trim()) return { status: 'unknown', reason: 'no-owner' };
  try {
    const { withWorkspace } = await import('@papercusp/db-org');
    const rows = await withWorkspace(input.workspace, async tx => {
      await tx`SELECT set_config('statement_timeout', ${String(SAMPLE_READ_MS)}, true)`;
      return tx<{ tools: string[] }[]>`SELECT tools FROM harness_shared.session_exposed_tools
        WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner}`;
    });
    return rows[0] ? toolsetFromNames(rows[0].tools) : { status: 'unknown', reason: 'no-listing' };
  } catch {
    return { status: 'unknown', reason: 'read-failed' };
  }
}

/** Last recorded listing per (workspace, owner) in this process, so an unchanged re-list does not write. */
const recorded = pinModuleState('@papercusp/operator-core.code-intel.push-toolset.recorded',
  () => ({ byKey: new Map<string, { digest: string; at: number }>() }));
const RECORD_REFRESH_MS = 10 * 60_000;
const RECORD_KEYS_MAX = 4_096;

/** Record the names tools/list just returned to this owner's session. Never throws: a failed
 * write leaves the previous row (or none, which reads as unknown). */
export async function rememberExposedTools(input: { workspace: string; owner: string; tools: readonly string[] },
  nowMs: number = Date.now()): Promise<boolean> {
  if (!input.workspace?.trim() || !input.owner?.trim()) return false;
  const tools = [...new Set(input.tools.filter(name => typeof name === 'string' && name.trim())
    .map(name => normalizeMcpName(name.trim())))].sort();
  const key = JSON.stringify([input.workspace, input.owner]);
  const digest = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  const previous = recorded.byKey.get(key);
  if (previous && previous.digest === digest && nowMs - previous.at < RECORD_REFRESH_MS) return false;
  try {
    const { withWorkspace } = await import('@papercusp/db-org');
    await withWorkspace(input.workspace, async tx => {
      await tx`SELECT set_config('lock_timeout', '100ms', true), set_config('statement_timeout', '500ms', true)`;
      await tx`INSERT INTO harness_shared.session_exposed_tools (workspace_id, owner_id, tools, listed_at)
        VALUES (${input.workspace}, ${input.owner}, ${tools}::text[], now())
        ON CONFLICT (workspace_id, owner_id) DO UPDATE SET tools = EXCLUDED.tools, listed_at = EXCLUDED.listed_at`;
    });
    if (recorded.byKey.size >= RECORD_KEYS_MAX) recorded.byKey.clear();
    recorded.byKey.set(key, { digest, at: nowMs });
    return true;
  } catch (error) {
    console.warn('[code-intel-push] exposed-tools record failed:', String(error).slice(0, 200));
    return false;
  }
}

/** Test seam: forget the per-process write memo. */
export function resetExposedToolsMemo(): void { recorded.byKey.clear(); }
