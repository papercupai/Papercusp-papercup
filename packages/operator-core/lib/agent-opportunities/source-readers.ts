/** Production hydration for the existing passive adapters. No raw evidence is persisted here. */
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { parseScratchUri, safeScratchFilesystemPath, scratchRootForWorkspace } from '../scratch-uri';
import { authorizeScratchReference, parseScratchReference } from '../scratch-reference';
import { findSessionTranscript } from '../claude-sessions';
import { findCodexRolloutPathByUuid, findOmpSessionPath } from '../session-transcript-resolvers';
import { nativeTranscriptSources, type NativeCorpusOptions, type NativeProvider } from './native-operation';
import type { SearchCorpusOptions } from './search-reformulation';
import { readSqlIntentRetention } from '../bash-substitution/sql-intent-corpus';
import type { MonitoredFamily } from './pipeline';
import { canonicalNativeRuntimeSources, reconcileNativeCapture } from './native-capture';

type Client = ReturnType<typeof getOrgPg>['sql'];
export interface OpportunityReaderOptions {
  workspaceId: string; harnessSlug: string; sourceBoundary: string; client?: Client;
  /** Fresh scope authorization, never a cached approval. The system census supplies its own scope. */
  authorize: SearchCorpusOptions['authorize'];
}

/** Read one stable bounded snapshot; oversize/growing/partial files stay unavailable. */
async function snapshot(path: string, cap: number): Promise<Buffer | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > cap) return null;
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    return length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      ? bytes.subarray(0, length) : null;
  } finally { await file.close(); }
}

export function productionOpportunityReaders(opts: OpportunityReaderOptions, deps: {
  /** Tests use real bounded files while retaining the database identity and ACL checks. */
  locateTranscript?: (input: { provider: NativeProvider; sessionId: string; actor: string; advId: string }) => Promise<string | null>;
  /** Trusted capture-receipt reader, never a public census argument or a policy
   * lookback. A native receipt must cover the activity index AND provider capture
   * for this exact scope/window. Absent instrumentation remains unknown. */
  readContinuity?: (input: { workspaceId: string; harnessSlug: string; sourceBoundary: string;
    family: Exclude<MonitoredFamily, 'sql'>; since: string; until: string }) => Promise<'complete' | 'gap' | 'unknown'>;
} = {}) {
  const sql = opts.client ?? getOrgPg().sql;
  const scopeAllowed = () => opts.authorize({ workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug, sourceBoundary: opts.sourceBoundary });
  const authorizeSource = (table: 'tool_invocations' | 'agent_activity') => async (id: string) => {
    if (!/^\d+$/.test(id) || !await scopeAllowed()) return null;
    const rows = table === 'tool_invocations'
      ? await sql`SELECT 1 FROM harness_shared.tool_invocations WHERE id=${id}::bigint
          AND workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}`
      : await sql`SELECT 1 FROM harness_shared.agent_activity WHERE id=${id}::bigint
          AND workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}`;
    return rows.length ? { sourceBoundary: opts.sourceBoundary } : null;
  };
  const ledger = authorizeSource('tool_invocations'), activity = authorizeSource('agent_activity');
  const readOutput: SearchCorpusOptions['readOutput'] = async input => {
    try {
      if (!input.outputRef || !await ledger(input.id)) return null;
      const [source] = await sql<{ actor: string }[]>`SELECT coord_owner_id AS actor
        FROM harness_shared.tool_invocations WHERE id=${input.id}::bigint
        AND workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
        AND tool_name=${input.tool} AND output_ref=${input.outputRef}`;
      if (!source?.actor) return null;
      const uri = parseScratchUri(input.outputRef);
      if (uri.workspaceId !== opts.workspaceId || uri.toolName !== input.tool) return null;
      const path = await realpath(safeScratchFilesystemPath(input.outputRef));
      const root = await realpath(scratchRootForWorkspace(opts.workspaceId));
      if (!path.startsWith(root + sep)) return null;
      const bytes = await snapshot(path, 2 * 1024 * 1024);
      if (!bytes) return null;
      const ref = parseScratchReference(bytes);
      if (!ref || ref.manifest.bodyOffsetInPayload == null) return null;
      authorizeScratchReference(ref.manifest, { workspaceId: opts.workspaceId, ownerId: source.actor });
      const body = JSON.parse(ref.payload.subarray(ref.manifest.bodyOffsetInPayload).toString('utf8'));
      // Recheck both the source link and its current authority after filesystem IO.
      const [current] = await sql`SELECT 1 FROM harness_shared.tool_invocations WHERE id=${input.id}::bigint
        AND workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
        AND tool_name=${input.tool} AND output_ref=${input.outputRef} AND coord_owner_id=${source.actor}`;
      if (!current || !await ledger(input.id)) return null;
      return { callId: `invocation:${input.id}`, provider: 'ledger', namespace: 'operator-dispatch', complete: true, body };
    } catch { return null; } // Missing, expired, corrupt or unauthorized evidence is UNKNOWN.
  };
  const readTranscript: NonNullable<NativeCorpusOptions['readTranscript']> = async input => {
    try {
      if (!input.callId || !await activity(input.id)) return null;
      if (!deps.locateTranscript) {
        // The latest native ID is not a runtime's source population: managed
        // carries leave earlier canonical transcripts in the same issued home.
        const bindings = () => sql<{ id: string; owner: string; provider: NativeProvider; harness: string | null }[]>`
          SELECT s.id::text,s.coord_owner_id AS owner,s.agent AS provider,${opts.harnessSlug}::text AS harness
          FROM harness_shared.adv_sessions s JOIN harness_shared.agent_activity a
            ON s.workspace_id=a.workspace_id AND s.coord_owner_id=a.owner_id AND s.agent=a.agent
          WHERE a.id=${input.id}::bigint AND a.workspace_id=${opts.workspaceId} AND a.harness_slug=${opts.harnessSlug}
            AND a.owner_id=${input.actor} AND a.agent=${input.provider} AND a.session_id=${input.sessionId}
            AND a.tool_use_id=${input.callId} AND harness_shared.is_agent_coord_owner_id(a.owner_id)
          ORDER BY s.id LIMIT 3`;
        const before = await bindings();
        if (!before.length || before.length > 2) return null;
        const matching = [];
        const deadline = Date.now() + 1000;
        for (const binding of before) {
          const read = await canonicalNativeRuntimeSources(binding, opts, deadline, input.sessionId);
          const sources = read.sources.filter(s => s.namespace === input.sessionId && s.callId === input.callId);
          if (sources.length) matching.push(sources);
        }
        if (matching.length !== 1 || JSON.stringify(before) !== JSON.stringify(await bindings()) || !await activity(input.id)) return null;
        return { sources: matching[0]!, status: 'measured' };
      }
      const binding = () => sql<{ id: string }[]>`SELECT s.id::text FROM harness_shared.agent_activity a
        JOIN harness_shared.adv_sessions s ON s.workspace_id=a.workspace_id AND s.coord_owner_id=a.owner_id
          AND s.agent=a.agent AND (s.session_id=a.session_id OR s.omp_thread_id=a.session_id OR s.id::text=a.session_id)
        WHERE a.id=${input.id}::bigint AND a.workspace_id=${opts.workspaceId} AND a.harness_slug=${opts.harnessSlug}
          AND a.owner_id=${input.actor} AND a.agent=${input.provider} AND a.session_id=${input.sessionId}
          AND a.tool_use_id=${input.callId} AND harness_shared.is_agent_coord_owner_id(a.owner_id)`;
      const sessions = await binding();
      if (sessions.length !== 1) return null;
      const advId = sessions[0]!.id;
      const path = deps.locateTranscript ? await deps.locateTranscript({ ...input, advId })
        : input.provider === 'claude' ? await findSessionTranscript(input.sessionId, { owner: input.actor })
          : input.provider === 'codex' ? await findCodexRolloutPathByUuid(input.sessionId, { homeOverride: codexHomeForSessionKey(advId) })
            : await findOmpSessionPath(input.sessionId, { sessionKey: advId });
      if (!path) return null;
      const bytes = await snapshot(path, 4 * 1024 * 1024);
      if (!bytes || !bytes.length || bytes.at(-1) !== 10) return null;
      const lines = bytes.toString('utf8').trimEnd().split('\n');
      if (lines.length > 4000 || lines.some(line => line.length > 256_000)) return null;
      const sources = nativeTranscriptSources(lines, { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
        authorizationScope: opts.sourceBoundary, actor: input.actor, verifiedAgent: true, origin: 'agent',
        provider: input.provider, sessionId: input.sessionId, complete: true }).filter(s => s.callId === input.callId);
      const current = await binding();
      if (current.length !== 1 || current[0]!.id !== advId || !await activity(input.id)) return null;
      return { sources, status: 'measured' };
    } catch { return null; }
  };
  const readContinuity = async (window: { family: Exclude<MonitoredFamily, 'sql'>; since: string; until: string }) => {
    if (!await scopeAllowed()) return 'unknown' as const;
    if (deps.readContinuity) return deps.readContinuity({ workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug, sourceBoundary: opts.sourceBoundary, ...window });
    // The SQL receipt tracks mutations to the entire scoped ledger, so the
    // three ledger adapters reuse it. It proves nothing about native capture.
    return window.family === 'native-operation' ? reconcileNativeCapture({ ...opts, ...window, authorize: scopeAllowed })
      : readSqlIntentRetention({ ...opts, ...window });
  };
  return { authorizeLedgerSource: ledger, authorizeActivitySource: activity, readOutput, readTranscript, readContinuity };
}
