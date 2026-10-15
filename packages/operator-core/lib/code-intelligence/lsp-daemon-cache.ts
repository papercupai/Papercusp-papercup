/** Bounded answer reuse inside the existing managed LSP daemon. */
import { createHash } from 'node:crypto';
import { createCache } from '@papercusp/cache';
import { captureLspDaemonInputs, type LspDaemonInputSnapshot } from './lsp-daemon-cost-key';
import type { LspDaemonAnswer, LspDaemonRequest } from './lsp-daemon-protocol';
import type { LspLanguage } from './lsp-adapter';

export type MeasuredLspInputs = Extract<LspDaemonInputSnapshot, { measured: true }>;
export type LspCacheRevision = { measured: true; identity: string } | { measured: false; reason: string };
export interface LspCacheLifecycle {
  /** Refresh/restart the existing client before reuse; never infer external input closure. */
  prepare(language: LspLanguage, inputs: MeasuredLspInputs, file: string): Promise<LspCacheRevision>;
  current(language: LspLanguage, root: string): LspCacheRevision;
}
export const LSP_ANSWER_CACHE_BOUNDS = Object.freeze({ entries: 128, answerBytes: 256 * 1024, activeProjects: 32 });
class UncacheableAnswer extends Error {
  constructor(readonly answer: LspDaemonAnswer, readonly reason: string) { super(reason); }
}

/** No stale-while-revalidate: every hit reconciles actual bytes and live service identity.
 * Busy projects report a pending file instead of racing a restart against a query.
 * This debounces refresh bursts without retaining an unbounded queue or file watcher.
 */
export class LspDaemonAnswerCache {
  private readonly cache = createCache({ maxL1Entries: LSP_ANSWER_CACHE_BOUNDS.entries,
    defaultHardTtlMs: 30_000 });
  private readonly busy = new Set<string>();
  constructor(private readonly lifecycle: LspCacheLifecycle,
    private readonly capture = captureLspDaemonInputs) {}

  clear(): void { this.cache.clearL1(); }

  async query(request: LspDaemonRequest, language: LspLanguage, root: string, signal: AbortSignal,
    execute: () => Promise<LspDaemonAnswer>): Promise<LspDaemonAnswer> {
    const started = Date.now();
    const finish = (answer: LspDaemonAnswer, state: 'hit' | 'miss' | 'bypass' | 'pending', reason: string | null,
      fingerprint: string | null = null): LspDaemonAnswer => ({ ...structuredClone(answer),
      latencyMs: Date.now() - started,
      daemonCache: { state, reason, inputFingerprint: fingerprint,
        pendingFiles: state === 'pending' && request.args.file ? [request.args.file] : [] } });
    const bypass = async (reason: string) => finish(await execute(), 'bypass', reason);
    // Archives must record their own wire evidence; plugin declarations require their own input closure.
    if (request.archive || request.semanticCompletion || !request.workspaceId?.trim() || !request.args.file)
      return bypass('request has no cache-admitted input scope');
    const scope = `${language}\0${root}`;
    if (this.busy.has(scope) || this.busy.size >= LSP_ANSWER_CACHE_BOUNDS.activeProjects) {
      return finish({ backend: 'lsp-adapter', intent: request.op === 'symbol' ? 'definition' :
        request.op === 'workspace_symbols' ? 'symbol-search' : request.op === 'refactor_preview' ? 'rename-preview' :
        request.op === 'health' ? 'diagnostics' : request.op,
        query: request.args.file, sites: [], truncation: { truncated: false, totalAvailable: null, continuation: null },
        freshness: { health: 'degraded', indexedAt: null, indexedCommit: null, staleVsDisk: null },
        latencyMs: 0, error: 'LSP project refresh pending; retry after the current query completes.' }, 'pending', 'project refresh pending');
    }
    this.busy.add(scope);
    try {
      if (signal.aborted) throw signal.reason;
      const before = await this.capture(root);
      if (!before.measured) return bypass(before.reason);
      const revision = await this.lifecycle.prepare(language, before, request.args.file);
      if (!revision.measured) return bypass(revision.reason);
      const key = createHash('sha256').update(JSON.stringify({ op: request.op, args: request.args,
        input: before.fingerprint, service: revision.identity })).digest('hex');
      let state: 'hit' | 'miss' = 'miss';
      let answer: LspDaemonAnswer;
      try {
        answer = await this.cache.getOrSet(request.workspaceId, key, async () => {
          const result = await execute();
          if (result.error || result.freshness.health !== 'healthy' ||
              !result.evidence?.sourceScope.sourceFingerprint)
            throw new UncacheableAnswer(result, 'answer has no current healthy producer evidence');
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LSP_ANSWER_CACHE_BOUNDS.answerBytes)
            throw new UncacheableAnswer(result, 'answer byte bound exceeded');
          return structuredClone(result);
        }, { onOutcome: outcome => { if (outcome === 'hit') state = 'hit'; } });
      } catch (error) {
        if (!(error instanceof UncacheableAnswer)) throw error;
        return finish(error.answer, 'bypass', error.reason, before.fingerprint);
      }
      if (signal.aborted) { this.cache.forget(request.workspaceId, key); throw signal.reason; }
      const after = await this.capture(root);
      const current = this.lifecycle.current(language, before.root);
      if (!after.measured || after.fingerprint !== before.fingerprint ||
          !current.measured || current.identity !== revision.identity) {
        this.cache.forget(request.workspaceId, key);
        return finish({ ...answer, sites: [], evidence: undefined,
          truncation: { truncated: false, totalAvailable: null, continuation: null },
          freshness: { ...answer.freshness, health: 'degraded', staleVsDisk: null },
          error: 'LSP inputs or service changed during the request; re-resolve against current source.' },
        'pending', !after.measured || after.fingerprint !== before.fingerprint ?
          'inputs changed during query' : 'managed service changed during query');
      }
      return finish(answer, state, null, before.fingerprint);
    } finally { this.busy.delete(scope); }
  }
}
