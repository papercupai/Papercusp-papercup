/** Operator-facing LSP facade: closed contract and transport only. */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { activeWorkspaceId } from '../workspace-registry.ts';
import { queryLspDaemon } from './lsp-daemon-client.ts';
import { DEFAULT_RESOURCE_BUDGET, unmeasuredSourceEvidence, type BackendHealth, type CodeIntelAnswer, type CodeIntelIntent } from './contracts.ts';
import type { LspLanguage } from './lsp-adapter.ts';
import { queryPushSnapshot } from './push-snapshot';

export type LspFacadeOp = 'symbol' | 'references' | 'implementations' | 'diagnostics' | 'workspace_symbols' | 'refactor_preview' | 'health';
export const LSP_FACADE_OPS: readonly LspFacadeOp[] = Object.freeze([
  'symbol', 'references', 'implementations', 'diagnostics', 'workspace_symbols', 'refactor_preview', 'health',
]);
export const MAX_SITES_PER_ANSWER = Math.max(1, Math.floor(DEFAULT_RESOURCE_BUDGET.resultTokensMax / 12));
export interface LspFacadeArgs {
  file?: string;
  line1?: number;
  character?: number;
  rootPath?: string;
  name?: string;
  language?: LspLanguage;
  newName?: string;
  limit?: number;
}
const INTENT_BY_OP: Record<LspFacadeOp, CodeIntelIntent> = {
  symbol: 'definition', references: 'references', implementations: 'implementations',
  diagnostics: 'diagnostics', workspace_symbols: 'symbol-search',
  refactor_preview: 'rename-preview', health: 'diagnostics',
};
function refusal(op: LspFacadeOp, query: string, error: string, health: BackendHealth, startedAt: number): CodeIntelAnswer {
  return {
    backend: 'lsp-adapter', intent: INTENT_BY_OP[op], query, sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - startedAt, error,
  };
}
export async function lspFacade(
  op: LspFacadeOp,
  args: LspFacadeArgs = {},
  caller: { workspaceId?: string; actorId?: string; priority?: number; deadlineAtMs?: number } = {},
): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const rootPath = args.rootPath ?? process.cwd();
  let repositoryId: string | null = null;
  try { repositoryId = `local-root:${createHash('sha256').update(realpathSync(rootPath)).digest('hex')}`; }
  catch { /* An inaccessible root is explicitly unmeasured. */ }
  const scoped = (answer: CodeIntelAnswer): CodeIntelAnswer => answer.evidence ? answer : { ...answer,
    evidence: unmeasuredSourceEvidence(answer, { repositoryId,
      identityKind: repositoryId ? 'local-root' : 'unknown', paths: ['.'], basis: 'compiler-project', language: args.language }, [
      'The LSP producer has not supplied document snapshot hashes; source versions remain unknown. Later disk reads cannot establish which bytes the server used.',
      'Loaded project scope does not establish exhaustive source coverage or runtime execution.',
    ]) };
  if (!LSP_FACADE_OPS.includes(op)) return scoped(refusal('health', String(op), `unknown lsp op '${op}'. The op set is closed: ${LSP_FACADE_OPS.join(', ')}`, 'unknown', started));
  const enabled = await getFlag(FLAGS.CODE_INTEL_LSP, 'system').catch(() => false);
  if (!enabled) return scoped(refusal(op, args.file ?? args.name ?? '', `code-intelligence LSP facade is disabled (flag ${FLAGS.CODE_INTEL_LSP}). This is a DISABLED answer, not an empty one — do not read it as "no results".`, 'unknown', started));
  if (op === 'symbol' && (!args.language || args.language === 'typescript')) {
    const snapshot = await queryPushSnapshot({ op: 'definition', root: rootPath, workspaceId: caller.workspaceId,
      file: args.file, line1: args.line1, character: args.character, limit: args.limit });
    if (snapshot) return snapshot;
  }
  return scoped(await queryLspDaemon({
    op, args: { ...args, rootPath },
    workspaceId: caller.workspaceId ?? activeWorkspaceId(), actorId: caller.actorId,
    priority: caller.priority, deadlineAtMs: caller.deadlineAtMs ?? started + 90_000,
  }));
}
export function lspFacadeOpSpec(): Array<{ op: LspFacadeOp; requires: string[]; reads: true; writes: false }> {
  return [
    { op: 'symbol', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'references', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'implementations', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'diagnostics', requires: ['file'], reads: true, writes: false },
    { op: 'workspace_symbols', requires: ['name'], reads: true, writes: false },
    { op: 'refactor_preview', requires: ['file', 'line1', 'character', 'newName'], reads: true, writes: false },
    { op: 'health', requires: [], reads: true, writes: false },
  ];
}
