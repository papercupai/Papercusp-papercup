/** P010: optional authoring advice, after the canonical plan write. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { loadHarnessRegistry } from '../harness-registry';
import { resolveAgentIdentity } from '../agent-tools/coordination/identity';
import { withBoundedTimeout } from '../bounded-timeout';
import { peekPushSnapshot, safeSnapshotPath, type PushSnapshot } from './push-snapshot';
import { composeReuseBrief, registeredReuseBriefProviders, type ReuseBriefProvider, type ReuseContribution, type ReuseProviderContext } from './reuse-brief-providers';
import { recordReuseBriefIssued } from './reuse-brief-ledger';
import { boundChangeHistoryProviders } from './change-history';

export interface AuthoringReuseDeps {
  root?: (workspace: string, harness: string) => Promise<string | undefined>;
  snapshot?: () => PushSnapshot | null;
  providers?: readonly ReuseBriefProvider[];
  recordIssued?: typeof recordReuseBriefIssued;
}
// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedGit: typeof execFile.__promisify__ | undefined;
const git = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedGit ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;

/** Root and attribution come from the same scoped caller as the successful
 * authoring operation. Advice cannot roll back or gate that operation. */
export async function authoringReuse(ctx: UnifiedToolContext, input: {
  workspaceId: string; harness: string; plan: string; item?: string;
  text: string; paths?: readonly string[];
}, deps: AuthoringReuseDeps = {}) {
  const deadline = Date.now() + 6_000;
  if (!ctx.dispatchCallId) return undefined;
  const result = await withBoundedTimeout(async signal => {
    const identity = resolveAgentIdentity(ctx);
    const rootPath = deps.root ? await deps.root(input.workspaceId, input.harness)
      // notify-classification: {"id":"packages/operator-core/lib/code-intelligence/reuse-authoring.ts#<module>/authoringReuse/<callback>:2ef58b637d7c379cbfa6:1","classification":"durable","reason":"Harness discovery reaches notification paths through the shared authoring graph; retain the terminal obligation pending P-009 review.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      : (await loadHarnessRegistry(input.workspaceId)).projects.find(row => row.slug === input.harness)?.path;
    if (!rootPath) return undefined;
    const root = await realpath(rootPath), snapshot = (deps.snapshot ?? (() => peekPushSnapshot(input.harness)))();
    const paths = new Set(input.paths ?? []);
    for (const match of input.text.matchAll(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|sql)\b/g)) paths.add(match[0]);
    // Explicit anchors/path mentions define the scope. Only anchorless prose
    // discovers symbol candidates: common words can name many unrelated symbols.
    // The provider still re-parses all selected bytes before issuing advice.
    if (!paths.size) {
      const tokens = new Set(input.text.match(/[A-Za-z_$][\w$]*/g) ?? []);
      for (const symbols of snapshot?.symbols?.values() ?? []) {
        for (const symbol of symbols) if (tokens.has(symbol.name)) paths.add(symbol.path);
        if (paths.size > 12) break;
      }
    }
    if (paths.size > 12) return { status: 'unknown' as const, hints: [] };
    const sourceFiles: { path: string; sha256: string }[] = [];
    for (const path of paths) {
      signal.throwIfAborted();
      if (!safeSnapshotPath(path)) return { status: 'unknown' as const, hints: [] };
      const file = await realpath(resolve(root, path)), rel = relative(root, file);
      if (isAbsolute(rel) || rel !== path || rel.startsWith('../') || (await stat(file)).size > 250_000) return undefined;
      sourceFiles.push({ path, sha256: createHash('sha256').update(await readFile(file, { signal })).digest('hex') });
    }
    let commit: string | null = null;
    try {
      const actual = (await git('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'],
        { encoding: 'utf8', timeout: 300, maxBuffer: 1024, signal })).stdout.trim();
      if (/^[a-f0-9]{40,64}$/.test(actual)) commit = actual;
    } catch { /* Source advice remains available; history attribution stays unknown. */ }
    const context: ReuseProviderContext = { surface: 'authoring', workspaceId: input.workspaceId,
      owner: identity.ownerId, invocation: ctx.dispatchCallId!, plan: input.plan,
      planItems: input.item ? [input.item] : [], paths: [...paths], sourceFiles: sourceFiles.length ? sourceFiles : undefined,
      sourceVersion: createHash('sha256').update(sourceFiles.length
        ? JSON.stringify(sourceFiles.map(file => [file.path, file.sha256])) : input.text).digest('hex'),
      itemText: input.text, repository: { workspaceId: input.workspaceId, rootPath: root, harness: input.harness }, commit };
    const registered = registeredReuseBriefProviders();
    const history = boundChangeHistoryProviders({ harness: input.harness, root: async () => root });
    // notify-classification: {"id":"packages/operator-core/lib/code-intelligence/reuse-authoring.ts#<module>/authoringReuse/<callback>:29cff27bb9cca60acf47:1","classification":"durable","reason":"Reuse provider composition can reach notification paths through its providers; retain their terminal delivery obligations without claiming delivery is proved.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const composed = await composeReuseBrief({ base: { hints: [] as ReuseContribution[] }, context, deadline: deadline - 150,
      providers: deps.providers ?? [...registered, ...history.filter(provider => !registered.some(row => row.id === provider.id))],
      append: (base, contribution) => ({ hints: [...base.hints, contribution] }) });
    const recover = { tool: 'graph:query', args: { op: 'similar', paths: [...paths] } };
    let ledger: 'recorded' | 'unknown' | 'not-needed' = 'not-needed';
    if (composed.observations.some(row => row.status === 'issued')) {
      ledger = 'unknown';
      try { if (await (deps.recordIssued ?? recordReuseBriefIssued)({ context, observations: composed.observations, recover }, signal)) ledger = 'recorded'; }
      catch { /* Preserve delivered hints and the successful canonical write. */ }
    }
    ctx.metadata?.({ reuseBriefProviders: [{ context, observations: composed.observations, recover, ledger }] });
    return { ...composed.brief, observations: composed.observations, ledger };
  }, { timeoutMs: Math.max(1, deadline - Date.now()), fallback: undefined, label: 'plan-authoring:reuse', signal: ctx.signal });
  return result.value;
}
