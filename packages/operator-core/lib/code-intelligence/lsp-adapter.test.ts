/**
 * Unit coverage for the LSP adapter's pure decision functions.
 *
 * WI-40224 / WI-41090 — the false-empty class. Per-intent readiness decides WHEN to
 * answer; `healthForAnswer` decides whether an answer may be BELIEVED. The
 * second is what this file guards, because it is the durable half: a
 * readiness bug is bounded, but a readiness bug that also certifies its own
 * output as trustworthy turns a temporary gap into an authoritative lie.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireLspProjectLease,
  canaryReadinessIsStable,
  certifyCanaryAnswer,
  ensureOpen,
  withLspSnapshotEvidence,
  evictIfLanguageServiceDead,
  healthForAnswer,
  probeLanguageServiceLiveness,
  prepareIntentReadiness,
  readinessStrategyFor,
  readinessVerdict,
  resolveSymbolSearchScope,
  specForLanguage,
  typescriptInitializationOptions,
  typescriptWorkspaceMemoryMb,
  resolveServerBin,
  resolveLspVendorDir,
  resolveTsserverPath,
  symbolSearchEmptyCaveat,
  type LspReadinessIntent,
  type LspReadinessStrategy,
} from './lsp-adapter.ts';
import { isTrustworthyEmpty, sourceIdentityContinuity, type BackendHealth, type CodeIntelAnswer } from './contracts.ts';

type Client = {
  health: BackendHealth;
  certifiedReadiness?: ReadonlySet<LspReadinessIntent>;
  unprovenReadiness?: ReadonlySet<LspReadinessIntent>;
};

const rust = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  ...over,
});
const ts = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  ...over,
});

describe('healthForAnswer — an empty answer must earn the right to be believed', () => {
  it('REFUSES to certify an empty from a rust server that never reported quiescent', () => {
    // The exact measured defect: rust-analyzer answered implementations
    // healthy-and-EMPTY while still indexing, and isTrustworthyEmpty blessed
    // it, so an agent asking "who implements this trait?" was told "nobody".
    expect(healthForAnswer(rust(), 'references', 0)).toBe('degraded');
  });

  it('REFUSES to certify an empty while the server says it is NOT quiescent', () => {
    expect(healthForAnswer(rust(), 'implementations', 0)).toBe('degraded');
  });

  it('certifies an empty once the server itself reports quiescent', () => {
    // The positive case — without this the guard would just break Rust empties
    // permanently, which is not a fix.
    expect(
      healthForAnswer(
        rust({ certifiedReadiness: new Set<LspReadinessIntent>(['references']) }),
        'references',
        0,
      ),
    ).toBe('healthy');
  });

  it('does NOT withhold trust from a NON-EMPTY answer', () => {
    // Deliberate asymmetry: sites are positive evidence and cannot be a
    // false-empty. Degrading them would suppress good answers for no gain.
    expect(healthForAnswer(rust(), 'references', 3)).toBe('healthy');
    expect(healthForAnswer(rust(), 'implementations', 1)).toBe('healthy');
  });

  it('defaults an unproven TypeScript empty to degraded too', () => {
    expect(healthForAnswer(ts(), 'symbol-search', 0)).toBe('degraded');
  });

  it("one intent's proof never certifies another intent's empty", () => {
    const client = ts({ certifiedReadiness: new Set<LspReadinessIntent>(['definition']) });
    expect(healthForAnswer(client, 'definition', 0)).toBe('healthy');
    expect(healthForAnswer(client, 'references', 0)).toBe('degraded');
  });

  it('never UPGRADES health — an unhealthy server stays unhealthy', () => {
    const proof = new Set<LspReadinessIntent>(['references']);
    expect(healthForAnswer(rust({ health: 'unhealthy', certifiedReadiness: proof }), 'references', 0)).toBe(
      'unhealthy',
    );
    expect(healthForAnswer(rust({ health: 'degraded', certifiedReadiness: proof }), 'references', 0)).toBe(
      'degraded',
    );
    expect(healthForAnswer(rust({ health: 'unknown' }), 'references', 5)).toBe('unknown');
  });
});

describe('canary readiness — a first positive answer is not proof of completeness', () => {
  type CanaryClient = {
    language: 'typescript';
    health: BackendHealth;
    progressGeneration: number;
    certifiedReadiness: Set<LspReadinessIntent>;
    canaryReadiness: Map<LspReadinessIntent, {
      siteCount: number;
      progressGeneration: number;
      sawProgressBoundary: boolean;
      sawAnswerChange: boolean;
    }>;
    unprovenReadiness: Set<LspReadinessIntent>;
  };

  const canaryClient = (): CanaryClient => ({
    language: 'typescript',
    health: 'healthy',
    progressGeneration: 0,
    certifiedReadiness: new Set(),
    canaryReadiness: new Map(),
    unprovenReadiness: new Set(),
  });

  it('rejects a first positive sample and a stable early partial plateau', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    expect(healthForAnswer(client, 'references', 2)).toBe('degraded');

    // A progress boundary alone must not bless the same early partial answer.
    client.progressGeneration = 1;
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    expect(healthForAnswer(client, 'references', 2)).toBe('degraded');
    expect(client.certifiedReadiness.has('references')).toBe(false);
  });

  it('requires a changed answer followed by a stable post-progress sample', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    client.progressGeneration = 1;
    // The index has advanced, but this first larger answer is still only a
    // candidate; it has not yet demonstrated stability after the transition.
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(false);
    expect(healthForAnswer(client, 'references', 198)).toBe('degraded');

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(true);
    expect(healthForAnswer(client, 'references', 198)).toBe('healthy');
    expect(client.certifiedReadiness.has('references')).toBe(true);
  });

  it('keeps the proof ledger per intent', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    client.progressGeneration = 1;
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(false);
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(true);

    expect(client.certifiedReadiness.has('references')).toBe(true);
    expect(healthForAnswer(client, 'definition', 0)).toBe('degraded');
    expect(healthForAnswer(client, 'definition', 1)).toBe('healthy');
  });

  it('defines stable as same answer only after both required transitions', () => {
    const first = {
      siteCount: 2,
      progressGeneration: 0,
      sawProgressBoundary: false,
      sawAnswerChange: false,
    };
    expect(canaryReadinessIsStable(undefined, first)).toBe(false);
    expect(
      canaryReadinessIsStable(first, {
        ...first,
        progressGeneration: 1,
        sawProgressBoundary: true,
      }),
    ).toBe(false);
    expect(
      canaryReadinessIsStable(
        { ...first, sawProgressBoundary: true, sawAnswerChange: true },
        {
          siteCount: 198,
          progressGeneration: 1,
          sawProgressBoundary: true,
          sawAnswerChange: true,
        },
      ),
    ).toBe(false);
    expect(
      canaryReadinessIsStable(
        { siteCount: 198, progressGeneration: 1, sawProgressBoundary: true, sawAnswerChange: true },
        { siteCount: 198, progressGeneration: 1, sawProgressBoundary: true, sawAnswerChange: true },
      ),
    ).toBe(true);
  });
});

describe('healthForAnswer composes with isTrustworthyEmpty (the contract that consumes it)', () => {
  const answerWith = (health: BackendHealth) => ({
    sites: [] as never[],
    error: null,
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
  });

  it('the degraded verdict actually makes the empty UNTRUSTWORTHY end to end', () => {
    // The whole point of returning 'degraded' rather than logging a warning:
    // isTrustworthyEmpty is the function callers use to decide whether an
    // empty means "none exist". This asserts the two agree.
    const health = healthForAnswer(rust(), 'references', 0);
    expect(isTrustworthyEmpty(answerWith(health) as never)).toBe(false);
  });

  it('CONTROL: the pre-fix behaviour really did bless it', () => {
    // Falsifiability control. Had the adapter kept reporting client.health,
    // this is what the caller would have seen — a trustworthy empty. If this
    // control ever fails, isTrustworthyEmpty changed underneath us and the
    // guard above may be passing for the wrong reason.
    expect(isTrustworthyEmpty(answerWith('healthy') as never)).toBe(true);
  });

  it('a quiescent server still produces a trustworthy empty', () => {
    const health = healthForAnswer(
      rust({ certifiedReadiness: new Set<LspReadinessIntent>(['references']) }),
      'references',
      0,
    );
    expect(isTrustworthyEmpty(answerWith(health) as never)).toBe(true);
  });
});

/**
 * WI-40250 — the recurrence guard for the `else-is-rust` fallthrough.
 *
 * The original bug was not that rust was wrong; it was that rust was the ELSE
 * ARM. `resolveServerBin` and both `languageId` sites read
 * `if (language === 'typescript') … else <rust>`, so ANY language that was not
 * typescript resolved to the rust-analyzer binary and was labelled `rust`.
 * Widening `LspLanguage` compiled clean and failed only at runtime, as a
 * confident wrong answer rather than an error.
 *
 * These tests fail if that shape ever returns. The important one is the LAST:
 * an unknown language must REFUSE, never silently resolve to some other
 * language's server.
 */
describe('WI-40250 — an unknown language refuses instead of falling through to rust', () => {
  it('gives each known language its OWN languageId, not a binary typescript/rust split', () => {
    expect(specForLanguage('typescript').languageId).toBe('typescript');
    expect(specForLanguage('rust').languageId).toBe('rust');
  });

  it('declares readiness per language AND intent rather than hardcoding rust', () => {
    expect(readinessStrategyFor('rust', 'definition')).toEqual({
      kind: 'progress-signal',
      intent: 'definition',
    });
    expect(readinessStrategyFor('typescript', 'definition')).toEqual({
      kind: 'settle-window',
      intent: 'definition',
      settleMs: 5_000,
    });
    expect(readinessStrategyFor('typescript', 'references')).toEqual({
      kind: 'canary-query',
      intent: 'references',
      minimumSites: 1,
    });
  });

  it('uses the conservative canary default for an unmeasured intent', () => {
    expect(specForLanguage('typescript').readinessStrategy['symbol-search']).toBeUndefined();
    expect(readinessStrategyFor('typescript', 'symbol-search')).toEqual({
      kind: 'canary-query',
      intent: 'symbol-search',
      minimumSites: 1,
    });
  });

  it('REFUSES an unknown language loudly, and never hands back another server', () => {
    // Cast is the whole point: this simulates a plain-JS caller, a persisted
    // value, or a request payload carrying a language the union does not know.
    const unknown = 'cobol' as unknown as Parameters<typeof specForLanguage>[0];

    expect(() => specForLanguage(unknown)).toThrow(/Unknown LSP language/);
    // The regression signature: before the fix this returned the rust-analyzer
    // path instead of throwing.
    expect(() => resolveServerBin(unknown)).toThrow(/Unknown LSP language/);
  });

  it('names the known languages in the refusal, so the fix is obvious at the call site', () => {
    const unknown = 'cobol' as unknown as Parameters<typeof specForLanguage>[0];
    expect(() => specForLanguage(unknown)).toThrow(/typescript/);
    expect(() => specForLanguage(unknown)).toThrow(/rust/);
  });
});

/**
 * WI-40251 — the recurrence guard for the stale-open-document class.
 *
 * Per the LSP spec an OPEN document's client copy is authoritative and the
 * server MUST ignore disk. The original defect: `ensureOpen` was
 * `if (openDocs.has(uri)) return` — open once, frozen forever — so any write
 * that did not go through `lsp.apply` (Edit/Write via the lock hook, git-sync,
 * the merge-resolver, a human's editor) left the SHARED server answering about
 * text that no longer exists, fleet-wide, while certifying it healthy.
 *
 * The fix is a pull-based content hash on every call. These tests fail if
 * anyone restores the open-once shape: the important assertion is that a
 * mutated file forces didClose + didOpen carrying the NEW text — not a no-op.
 */
describe('ensureOpen — disk freshness and readiness invalidation', () => {
  type Sent = { method: string; params: { textDocument: { uri: string; text?: string; version?: number } } };

  let dir: string;
  let file: string;
  let sent: Sent[];
  let client: Parameters<typeof ensureOpen>[0];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wi-40251-ensure-open-'));
    file = join(dir, 'subject.ts');
    await writeFile(file, 'export const a = 1;\n');
    sent = [];
    // A minimal fake: ensureOpen touches only language, openDocs, and
    // connection.sendNotification. The cast is deliberate (same style as the
    // WI-40250 suite) — a real LspClient carries a live child process.
    client = {
      language: 'typescript',
      openDocs: new Map<string, { mtimeMs: number; size: number }>(),
      // Deliberately old: opening a new document must invalidate this stale
      // readiness observation before it can reach prepareIntentReadiness.
      idleSince: Date.now() - 60_000,
      connection: {
        sendNotification: (method: string, params: unknown) => {
          sent.push({ method, params } as Sent);
        },
      },
    } as unknown as Parameters<typeof ensureOpen>[0];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('first call opens the document with the disk text and stamps it', async () => {
    const uri = await ensureOpen(client, file);

    expect(sent.map((s) => s.method)).toEqual(['textDocument/didOpen']);
    expect(sent[0].params.textDocument.text).toBe('export const a = 1;\n');
    const stamp = (client as unknown as { openDocs: Map<string, { mtimeMs: number; size: number }> }).openDocs.get(uri);
    expect(stamp).toBeDefined();
    expect(stamp!.size).toBe('export const a = 1;\n'.length);
    expect(client.openDocs.get(uri)!.contentHash).toBe(createHash('sha256').update(sent[0].params.textDocument.text!).digest('hex'));
  });

  const answer = (sites: CodeIntelAnswer['sites'] = [{ path: 'subject.ts', line1: 1, kind: null }]): CodeIntelAnswer => ({
    backend: 'lsp-adapter', intent: 'definition', query: 'a', sites,
    truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null },
    latencyMs: 1, error: null,
  });

  it('keeps sent-text identities after a disk edit, then requires re-resolution after reopening', async () => {
    await ensureOpen(client, file);
    const snapshot = new Map(client.openDocs);
    const first = withLspSnapshotEvidence(answer(), client, snapshot, dir);
    const oldId = first.evidence!.siteIdentities[0].versionedSymbolId;
    expect(oldId).not.toBeNull();
    await writeFile(file, '// changed by a peer\nexport const a = 2;\n');
    const retained = withLspSnapshotEvidence(answer(), client, snapshot, dir);
    expect(retained.evidence).toEqual(first.evidence);
    expect(retained.freshness.staleVsDisk).toBeNull();
    await ensureOpen(client, file);
    const fresh = withLspSnapshotEvidence(answer([{ path: 'subject.ts', line1: 2, kind: null }]), client, new Map(client.openDocs), dir);
    expect(sourceIdentityContinuity(oldId, fresh.evidence!.siteIdentities[0].versionedSymbolId)).toBe('needs-resolution');
    expect(first.evidence!.siteIdentities[0].versionedSymbolId).toBe(oldId);
    const raced = withLspSnapshotEvidence(answer(), client, snapshot, dir);
    expect(raced.sites).toEqual([]);
    expect(raced.error).toMatch(/snapshot changed during/);
    expect(raced.freshness.health).toBe('degraded');
    expect(raced.evidence!.sourceScope.sourceFingerprint).toBeNull();
  });

  it('leaves unopened returned files and legacy stamps unversioned', async () => {
    const uri = await ensureOpen(client, file);
    await writeFile(join(dir, 'unopened.ts'), 'export const other = 1;\n');
    const result = withLspSnapshotEvidence(answer([{ path: 'unopened.ts', line1: 1, kind: null }]), client, new Map(client.openDocs), dir);
    expect(result.evidence!.siteIdentities[0]).toMatchObject({ contentHash: null, versionedSymbolId: null });
    expect(result.evidence!.sourceScope.supportingFiles.map(source => source.path)).toEqual(['subject.ts']);
    client.openDocs.set(uri, { mtimeMs: 0, size: 0 });
    const legacy = withLspSnapshotEvidence(answer(), client, new Map(client.openDocs), dir);
    expect(legacy.evidence!.sourceScope.sourceFingerprint).toBeNull();
    expect(legacy.evidence!.siteIdentities[0].versionedSymbolId).toBeNull();
  });

  it('rejects a closed or replaced snapshot even when replacement text is identical', async () => {
    const uri = await ensureOpen(client, file);
    const snapshot = new Map(client.openDocs);
    client.openDocs.set(uri, { ...client.openDocs.get(uri)! });
    expect(withLspSnapshotEvidence(answer([]), client, snapshot, dir).error).toMatch(/snapshot changed/);
    client.openDocs.delete(uri);
    expect(withLspSnapshotEvidence(answer(), client, snapshot, dir).evidence!.siteIdentities).toEqual([]);
  });

  it('does not retain source proof when sending didOpen fails', async () => {
    client.connection.sendNotification = vi.fn().mockRejectedValue(new Error('closed connection'));
    await expect(ensureOpen(client, file)).rejects.toThrow('closed connection');
    expect(client.openDocs.size).toBe(0);
  });

  it('invalidates the server idle period BEFORE opening a new document (WI-2142941)', async () => {
    expect((client as unknown as { idleSince: number | null }).idleSince).not.toBeNull();

    await ensureOpen(client, file);

    expect((client as unknown as { idleSince: number | null }).idleSince).toBeNull();
  });

  it('an UNCHANGED file is a no-op — no didClose/didOpen thrash on the hot path', async () => {
    await ensureOpen(client, file);
    sent.length = 0;
    (client as unknown as { idleSince: number | null }).idleSince = 123;

    await ensureOpen(client, file);

    expect(sent).toEqual([]);
    expect((client as unknown as { idleSince: number | null }).idleSince).toBe(123);
  });

  it('refreshes changed bytes even when a peer preserves file size and mtime', async () => {
    const uri = await ensureOpen(client, file);
    const before = await stat(file);
    sent.length = 0;
    await writeFile(file, 'export const a = 2;\n');
    await utimes(file, before.atime, before.mtime);
    await ensureOpen(client, file);
    expect(sent.map(row => row.method)).toEqual(['textDocument/didClose', 'textDocument/didOpen']);
    expect(sent[1]?.params.textDocument.text).toBe('export const a = 2;\n');
    expect(client.openDocs.get(uri)?.contentHash).toBe(createHash('sha256').update('export const a = 2;\n').digest('hex'));
  });

  it('a file mutated on disk forces didClose + didOpen carrying the NEW text — never a silent stale serve', async () => {
    await ensureOpen(client, file);
    sent.length = 0;
    (client as unknown as { idleSince: number | null }).idleSince = 123;

    // Longer content: the size delta makes the staleness detection
    // deterministic even when both writes land in the same mtime millisecond.
    await writeFile(file, 'export const a = 2; // rewritten by a peer\n');
    const uri = await ensureOpen(client, file);

    // The regression signature: before the fix this was [] — open-once, serve
    // stale forever.
    expect(sent.map((s) => s.method)).toEqual(['textDocument/didClose', 'textDocument/didOpen']);
    expect(sent[0].params.textDocument.uri).toBe(uri);
    expect(sent[1].params.textDocument.text).toBe('export const a = 2; // rewritten by a peer\n');
    // Re-open restores the version-1 invariant the rest of the adapter assumes
    // (no incremental sync was ever established).
    expect(sent[1].params.textDocument.version).toBe(1);
    expect((client as unknown as { idleSince: number | null }).idleSince).toBeNull();
  });

  it('re-opening RE-STAMPS, so the next unchanged read is again a no-op (no perpetual thrash)', async () => {
    await ensureOpen(client, file);
    await writeFile(file, 'export const a = 3; // second disk write\n');
    await ensureOpen(client, file);
    sent.length = 0;

    await ensureOpen(client, file);

    expect(sent).toEqual([]);
  });

  it('refuses a deleted source and closes its retained document before any query can reuse it', async () => {
    const uri = await ensureOpen(client, file);
    sent.length = 0;
    client.certifiedReadiness = new Set<LspReadinessIntent>(['references']);
    client.quiescent = true;

    await rm(file);
    await expect(ensureOpen(client, file)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(client.openDocs.has(uri)).toBe(false);
    expect(client.certifiedReadiness.size).toBe(0);
    expect(client.quiescent).toBeNull();
    expect(sent).toEqual([{ method: 'textDocument/didClose', params: { textDocument: { uri } } }]);

    // Recreating the path must load the new text, never revive the old copy.
    await writeFile(file, 'export const recreated = 2;\n');
    await ensureOpen(client, file);
    expect(sent.at(-1)?.method).toBe('textDocument/didOpen');
    expect(sent.at(-1)?.params.textDocument.text).toBe('export const recreated = 2;\n');
  });

  it('invalidates a deleted document even when its close notification fails', async () => {
    const uri = await ensureOpen(client, file);
    client.certifiedReadiness = new Set<LspReadinessIntent>(['references']);
    await rm(file);
    client.connection.sendNotification = vi.fn().mockRejectedValue(new Error('closed connection'));

    await expect(ensureOpen(client, file)).rejects.toThrow('closed connection');
    expect(client.openDocs.has(uri)).toBe(false);
    expect(client.certifiedReadiness.size).toBe(0);
  });
});

describe('WI-41095 — independently copied vendor binding', () => {
  let parent: string;
  let vendor: string;
  let tsserver: string;
  let launcher: string;

  beforeEach(async () => {
    vi.stubEnv('PAPERCUSP_LSP_VENDOR_DIR', undefined);
    vi.stubEnv('PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB', '8192');
    parent = await mkdtemp(join(tmpdir(), 'wi41095-vendor-binding-'));
    vendor = join(parent, 'copied-vendor');
    const compiler = join(vendor, 'node_modules', '@typescript', 'old');
    await mkdir(join(compiler, 'lib'), { recursive: true });
    await writeFile(join(compiler, 'package.json'), '{"name":"typescript","version":"6.0.3"}');
    tsserver = join(compiler, 'lib', 'tsserver.js');
    await writeFile(tsserver, '// declared server entry');
    await writeFile(join(compiler, 'lib', 'typescript.js'), "module.exports = { version: 'declared-copy' };");
    const server = join(vendor, 'node_modules', 'typescript-language-server');
    await mkdir(server);
    await writeFile(join(server, 'cli.js'), '// declared wrapper entry');
    await mkdir(join(vendor, 'node_modules', '.bin'));
    launcher = join(vendor, 'node_modules', '.bin', 'typescript-language-server');
    await symlink('../typescript-language-server/cli.js', launcher);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(parent, { recursive: true, force: true });
  });

  it('retains the maintained default and selects only a canonical configured root', async () => {
    expect(resolveLspVendorDir()).toBe(join(homedir(), '.papercusp', 'vendor', 'lsp'));
    vi.stubEnv('PAPERCUSP_LSP_VENDOR_DIR', vendor);
    expect(resolveLspVendorDir()).toBe(vendor);
    const alias = join(parent, 'vendor-alias');
    await symlink(vendor, alias);
    for (const invalid of ['', './vendor', `${vendor}/..`, alias, tsserver, join(parent, 'missing')])
      expect(() => resolveLspVendorDir(invalid)).toThrow('PAPERCUSP_LSP_VENDOR_DIR');
  });

  it('binds the launcher, tsserver initialization, identity and cache compiler to the same copy', () => {
    const spec = specForLanguage('typescript');
    expect(spec.resolveBin(vendor)).toBe(launcher);
    expect(resolveTsserverPath(vendor)).toBe(tsserver);
    expect(spec.initializationOptions(parent, undefined, vendor)).toMatchObject({ tsserver: { path: tsserver } });
    expect(spec.identityFiles!(vendor)).toEqual([tsserver]);
    expect(createRequire(resolveTsserverPath(vendor))('./typescript.js').version).toBe('declared-copy');
  });

  it('captures the selected root at module bootstrap across every production lookup', async () => {
    vi.stubEnv('PAPERCUSP_LSP_VENDOR_DIR', vendor);
    vi.resetModules();
    try {
      const adapter = await import('./lsp-adapter.ts');
      vi.stubEnv('PAPERCUSP_LSP_VENDOR_DIR', join(parent, 'later-installation'));
      expect(adapter.LSP_VENDOR_DIR).toBe(vendor);
      expect(adapter.resolveServerBin('typescript')).toBe(launcher);
      expect(adapter.resolveTsserverPath()).toBe(tsserver);
      const spec = adapter.specForLanguage('typescript');
      expect(spec.initializationOptions(parent)).toMatchObject({ tsserver: { path: tsserver } });
      expect(spec.identityFiles!()).toEqual([tsserver]);
    } finally { vi.resetModules(); }
  });

  it('refuses an ancestor compiler rather than borrowing from the donor installation', async () => {
    const ancestor = join(parent, 'node_modules', '@typescript', 'old', 'lib');
    await mkdir(ancestor, { recursive: true });
    await writeFile(join(ancestor, 'tsserver.js'), '// ambient compiler');
    await rm(join(vendor, 'node_modules', '@typescript'), { recursive: true });
    expect(() => resolveTsserverPath(vendor)).toThrow('escapes vendor root');
    expect(() => specForLanguage('typescript').initializationOptions(parent, undefined, vendor))
      .toThrow('escapes vendor root');
  });

  it('refuses a compiler symlink outside the declared root', async () => {
    const outside = join(parent, 'external-tsserver.js');
    await writeFile(outside, '// external compiler');
    await rm(tsserver);
    await symlink(outside, tsserver);
    expect(() => resolveTsserverPath(vendor)).toThrow('escapes vendor root');
  });

  it('refuses a wrapper symlink outside the declared root before launch', async () => {
    const outside = join(parent, 'external-wrapper.js');
    await writeFile(outside, '// external wrapper');
    await rm(launcher);
    await symlink(outside, launcher);
    expect(() => specForLanguage('typescript').resolveBin(vendor)).toThrow('escapes vendor root');
  });

  it('reports an incomplete selected installation instead of returning a home server', async () => {
    await rm(launcher);
    expect(specForLanguage('typescript').resolveBin(vendor)).toBeNull();
    await rm(join(vendor, 'node_modules', '@typescript'), { recursive: true });
    expect(() => resolveTsserverPath(vendor)).toThrow(`No tsserver.js found under ${vendor}`);
  });
});

describe('WI-41095 — workspace source sizing', () => {
  const tsserverPath = createRequire(import.meta.url).resolve('@typescript/old/lib/tsserver.js');
  let root: string;

  beforeEach(async () => {
    vi.stubEnv('PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB', '');
    root = await mkdtemp(join(tmpdir(), 'wi41095-heap-policy-'));
    await writeFile(join(root, 'source.ts'), 'export const value = 1;');
    await writeFile(join(root, 'tsconfig.json'), '{"include":["*.ts"]}');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('increases the launched budget as the same configured project grows', async () => {
    const small = typescriptInitializationOptions(tsserverPath, undefined, root).maxTsServerMemory!;
    // Sparse fixtures do not allocate large source buffers in the test worker.
    await truncate(join(root, 'source.ts'), 80 * 1024 * 1024);
    const large = typescriptInitializationOptions(tsserverPath, undefined, root).maxTsServerMemory!;
    await truncate(join(root, 'source.ts'), 160 * 1024 * 1024);
    const larger = typescriptInitializationOptions(tsserverPath, undefined, root).maxTsServerMemory!;
    expect(large).toBeGreaterThan(small);
    expect(larger).toBeGreaterThan(large);
  });

  it('uses compiler extends/exclude rules without omitting test roots', async () => {
    await writeFile(join(root, 'base.json'), '{"include":["*.ts"],"exclude":["excluded.ts"]}');
    await writeFile(join(root, 'tsconfig.json'), '{"extends":"./base.json"}');
    await writeFile(join(root, 'excluded.ts'), '');
    await truncate(join(root, 'excluded.ts'), 160 * 1024 * 1024);
    const before = typescriptWorkspaceMemoryMb(root, tsserverPath);
    await writeFile(join(root, 'source.test.ts'), '');
    await truncate(join(root, 'source.test.ts'), 80 * 1024 * 1024);
    const after = typescriptWorkspaceMemoryMb(root, tsserverPath);
    expect(after).toBeGreaterThan(before);
    await rm(join(root, 'excluded.ts'));
    expect(typescriptWorkspaceMemoryMb(root, tsserverPath)).toBe(after);
  });

  it('refuses invalid project configuration rather than returning the old ceiling', async () => {
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"invalid"}}');
    expect(() => typescriptWorkspaceMemoryMb(root, tsserverPath)).toThrow('Cannot size TypeScript project');
    vi.stubEnv('PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB', '9216');
    expect(typescriptInitializationOptions(tsserverPath, undefined, root).maxTsServerMemory).toBe(9216);
    expect(typescriptInitializationOptions(tsserverPath, 8192, root).maxTsServerMemory).toBe(8192);
    expect(typescriptInitializationOptions(tsserverPath, null, root)).not.toHaveProperty('maxTsServerMemory');
  });

  it('sizes inferred and JavaScript projects rather than reverting to a fixed ceiling', async () => {
    await rm(join(root, 'tsconfig.json'));
    const small = typescriptWorkspaceMemoryMb(root, tsserverPath);
    await truncate(join(root, 'source.ts'), 80 * 1024 * 1024);
    expect(typescriptWorkspaceMemoryMb(root, tsserverPath)).toBeGreaterThan(small);
    await rm(join(root, 'source.ts'));
    await writeFile(join(root, 'jsconfig.json'), '{"include":["*.js"]}');
    await writeFile(join(root, 'source.js'), '');
    await truncate(join(root, 'source.js'), 80 * 1024 * 1024);
    expect(typescriptWorkspaceMemoryMb(root, tsserverPath)).toBeGreaterThan(small);
  });

  it('follows named project references, deduplicates roots and terminates cycles', async () => {
    await mkdir(join(root, 'project'));
    await writeFile(join(root, 'tsconfig.json'), '{"files":[],"references":[{"path":"./project/tsconfig.build.json"}]}');
    await writeFile(join(root, 'project', 'tsconfig.build.json'), '{"include":["../source.ts"],"references":[{"path":"../tsconfig.json"}]}');
    const small = typescriptWorkspaceMemoryMb(root, tsserverPath);
    await truncate(join(root, 'source.ts'), 80 * 1024 * 1024);
    const large = typescriptWorkspaceMemoryMb(root, tsserverPath);
    expect(large).toBeGreaterThan(small);
    await writeFile(join(root, 'project', 'tsconfig.json'), '{"include":["../source.ts"]}');
    expect(typescriptWorkspaceMemoryMb(root, tsserverPath)).toBe(large);
  });

  it.each(['invalid', '-1', '0', 'Infinity', '1.5'])('refuses invalid memory setting %s before a child starts', setting => {
    vi.stubEnv('PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB', setting);
    expect(() => typescriptInitializationOptions(tsserverPath, undefined, root)).toThrow('positive integer');
    // Explicit caller choices take precedence over an unrelated bad setting.
    expect(typescriptInitializationOptions(tsserverPath, 8192, root).maxTsServerMemory).toBe(8192);
    expect(typescriptInitializationOptions(tsserverPath, null, root)).not.toHaveProperty('maxTsServerMemory');
  });
});

describe('WI-2142895 — one foreground TypeScript project per client', () => {
  type Sent = { method: string; params: { textDocument: { uri: string } } };

  let root: string;
  let projectA: string;
  let projectB: string;
  let fileA1: string;
  let fileA2: string;
  let fileB: string;
  let sent: Sent[];
  let client: Parameters<typeof acquireLspProjectLease>[0];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wi-2142895-project-lease-'));
    projectA = join(root, 'a');
    projectB = join(root, 'b');
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    await Promise.all([
      writeFile(join(projectA, 'tsconfig.json'), '{}\n'),
      writeFile(join(projectB, 'tsconfig.json'), '{}\n'),
    ]);
    fileA1 = join(projectA, 'one.ts');
    fileA2 = join(projectA, 'two.ts');
    fileB = join(projectB, 'one.ts');
    await Promise.all([
      writeFile(fileA1, 'export const one = 1;\n'),
      writeFile(fileA2, 'export const two = 2;\n'),
      writeFile(fileB, 'export const other = 3;\n'),
    ]);

    sent = [];
    client = {
      language: 'typescript',
      rootPath: root,
      openDocs: new Map(),
      diagnostics: new Map(),
      idleSince: Date.now() - 60_000,
      quiescent: null,
      certifiedReadiness: new Set(),
      canaryReadiness: new Map(),
      unprovenReadiness: new Set(),
      connection: {
        sendNotification: (method: string, params: unknown) => {
          sent.push({ method, params } as Sent);
        },
      },
    } as unknown as Parameters<typeof acquireLspProjectLease>[0];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('closes the old project BEFORE opening a document in a different project', async () => {
    const releaseA = await acquireLspProjectLease(client, fileA1);
    await ensureOpen(client, fileA1);
    releaseA();
    sent.length = 0;

    const releaseB = await acquireLspProjectLease(client, fileB);
    await ensureOpen(client, fileB);
    releaseB();

    expect(sent.map((entry) => entry.method)).toEqual(['textDocument/didClose', 'textDocument/didOpen']);
    expect(sent[0].params.textDocument.uri).toContain('/a/one.ts');
    expect(sent[1].params.textDocument.uri).toContain('/b/one.ts');
    expect(client.openDocs.size).toBe(1);
    expect([...client.openDocs.keys()][0]).toContain('/b/one.ts');
  });

  it('keeps documents in the SAME project open, avoiding needless project reloads', async () => {
    const releaseA1 = await acquireLspProjectLease(client, fileA1);
    await ensureOpen(client, fileA1);
    releaseA1();
    sent.length = 0;

    const releaseA2 = await acquireLspProjectLease(client, fileA2);
    await ensureOpen(client, fileA2);
    releaseA2();

    expect(sent.map((entry) => entry.method)).toEqual(['textDocument/didOpen']);
    expect(client.openDocs.size).toBe(2);
  });

  it('serializes different projects but allows concurrent users of one project', async () => {
    const releaseA1 = await acquireLspProjectLease(client, fileA1);
    const releaseA2 = await acquireLspProjectLease(client, fileA2);

    let acquiredB = false;
    const pendingB = acquireLspProjectLease(client, fileB).then((release) => {
      acquiredB = true;
      return release;
    });
    await Promise.resolve();
    expect(acquiredB).toBe(false);

    releaseA1();
    await Promise.resolve();
    expect(acquiredB).toBe(false);

    releaseA2();
    const releaseB = await pendingB;
    expect(acquiredB).toBe(true);
    releaseB();
  });

  it('makes release idempotent so an error path cannot underflow the lease', async () => {
    const release = await acquireLspProjectLease(client, fileA1);
    release();
    release();

    const releaseB = await acquireLspProjectLease(client, fileB);
    releaseB();
  });
});

/**
 * EI-21929741479590036 — `workspace_symbols` answered nothing on either
 * language, and the obvious repair (give it a working root) would have made it
 * answer something WORSE.
 *
 * A symbol search covers ONE project. `isTrustworthyEmpty()` believes an empty
 * from a server that claims health, so a scoped search that emits
 * `sites: [] / error: null / health: 'healthy'` certifies an absence it cannot
 * support. Measured before the fix: `account_options` — a `pub fn` that exists
 * in apps/tui — returned exactly that shape when asked at the
 * papercusp-desktop/src-tauri root. These guard both halves: the scope must be
 * established or refused, and an empty must never be silent.
 */
describe('workspace_symbols search scope', () => {
  /** The exact answer shape `isTrustworthyEmpty` reads as "absence proven". */
  const certifiesAbsence = (a: {
    sites: readonly unknown[];
    error: string | null;
    health: BackendHealth;
  }) => a.sites.length === 0 && a.error === null && a.health === 'healthy';

  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lsp-scope-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('CONTROL: the predicate really does catch the pre-fix shape', () => {
    // Calibration. Without this, every assertion below could pass because
    // `certifiesAbsence` had stopped measuring anything rather than because
    // the adapter stopped emitting the shape.
    expect(certifiesAbsence({ sites: [], error: null, health: 'healthy' })).toBe(true);
    // ...and it must not fire on a genuine hit, or it would forbid all answers.
    expect(certifiesAbsence({ sites: ['a site'], error: null, health: 'healthy' })).toBe(false);
  });

  it('an empty search states its scope, so a healthy server cannot certify absence', () => {
    const caveat = symbolSearchEmptyCaveat('account_options', 'rust', {
      root: '/repo/papercusp-desktop/src-tauri',
      anchor: null,
    });
    expect(caveat).toMatch(/NOT evidence/);
    expect(caveat).toContain('/repo/papercusp-desktop/src-tauri');
    // The fix, stated as the shape it forbids.
    expect(certifiesAbsence({ sites: [], error: caveat, health: 'healthy' })).toBe(false);
    // And it lands on isTrustworthyEmpty's honest-loud-failure branch, not its
    // believe-the-healthy-empty branch.
    expect(
      isTrustworthyEmpty({
        backend: 'lsp-adapter',
        intent: 'symbol-search',
        query: 'account_options',
        sites: [],
        truncation: { truncated: false, totalAvailable: 0, continuation: null },
        freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null },
        latencyMs: 1,
        error: caveat,
      }),
    ).toBe(true);
  });

  it('refuses a rust search whose root has no crate graph, instead of answering empty', () => {
    const scope = resolveSymbolSearchScope('rust', undefined, dir);
    expect(scope.error).toMatch(/Cargo\.toml/);
    // The refusal has to be ACTIONABLE — naming the arg that fixes it.
    expect(scope.error).toMatch(/'file'|rootPath/);
  });

  it('accepts a rust root that is itself a crate', async () => {
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const scope = resolveSymbolSearchScope('rust', undefined, dir);
    expect(scope.error).toBeNull();
    expect(scope.root).toBe(dir);
  });

  it('lets a rust anchor select its own crate root', async () => {
    const crate = join(dir, 'apps', 'tui');
    await mkdir(join(crate, 'src'), { recursive: true });
    await writeFile(join(crate, 'Cargo.toml'), '[package]\nname = "tui"\n');
    const anchor = join(crate, 'src', 'main.rs');
    await writeFile(anchor, 'pub fn account_options() {}\n');

    const scope = resolveSymbolSearchScope('rust', anchor, dir);
    expect(scope.error).toBeNull();
    // The crate, NOT the workspace root it was invoked from.
    expect(scope.root).toBe(crate);
    expect(scope.anchor).toBe(anchor);
  });

  it('refuses an unanchored TypeScript search — rootPath cannot create a project', () => {
    // tsserver builds projects from OPENED DOCUMENTS, never from the root URI,
    // so this refusal is not a missing-config problem a root could fix.
    const scope = resolveSymbolSearchScope('typescript', undefined, dir);
    expect(scope.error).toMatch(/No Project/);
    expect(scope.error).toMatch(/'file'/);
  });

  it("roots an anchored TypeScript search at the anchor's OWN tsconfig project", async () => {
    const pkg = join(dir, 'packages', 'operator-core');
    await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    const anchor = join(pkg, 'lib', 'x.ts');
    await writeFile(anchor, 'export const x = 1;\n');

    const scope = resolveSymbolSearchScope('typescript', anchor, dir);
    expect(scope.error).toBeNull();
    expect(scope.anchor).toBe(anchor);
    // The PROJECT, not the workspace root it was invoked from — the same rule
    // the rust branch applies to Cargo.toml. navto searches the server's LOADED
    // projects and tsserver loads from its own root URI, so rooted at `dir`
    // (which holds no tsconfig) the anchor lands in an inferred project navto
    // never searches. Measured 2026-08-31 on the live host, EI-21929741479590036:
    // repo-root 6/6 empty for symbols that exist; package-root found at 591ms.
    expect(scope.root).toBe(pkg);
  });

  it('roots JavaScript file and directory searches at their configured jsconfig project', async () => {
    const pkg = join(dir, 'javascript-project');
    await mkdir(join(pkg, 'src'), { recursive: true });
    await writeFile(join(pkg, 'jsconfig.json'), '{"compilerOptions":{"allowJs":true},"include":["src/*.js"]}\n');
    const anchor = join(pkg, 'src', 'control.js');
    await writeFile(anchor, 'export function target() { return 1; }\n');
    for (const input of [anchor, join(pkg, 'src')]) {
      expect(resolveSymbolSearchScope('typescript', input, dir)).toEqual({ root: pkg, anchor, error: null });
    }
  });

  it('refuses directory searches across nested JavaScript projects and deduplicates their markers', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}\n');
    for (const name of ['first', 'second']) {
      const pkg = join(dir, name);
      await mkdir(pkg);
      await writeFile(join(pkg, 'jsconfig.json'), '{"compilerOptions":{"allowJs":true}}\n');
      await writeFile(join(pkg, 'control.js'), 'export const target = 1;\n');
    }
    await writeFile(join(dir, 'first', 'tsconfig.json'), '{}\n');
    const scope = resolveSymbolSearchScope('typescript', dir, dir);
    expect(scope.anchor).toBeNull();
    expect(scope.error).toContain('2 nested tsconfig/jsconfig project(s)');
    expect(scope.error).toContain(join(dir, 'first'));
    expect(scope.error).toContain(join(dir, 'second'));
  });

  it('refuses an anchored TypeScript search with no tsconfig above the anchor', async () => {
    await mkdir(join(dir, 'loose'), { recursive: true });
    const anchor = join(dir, 'loose', 'x.ts');
    await writeFile(anchor, 'export const x = 1;\n');

    // Refusing beats rooting somewhere arbitrary: an inferred-project search
    // answers `sites: []` for symbols that plainly exist, which is the exact
    // false-absence shape this whole module exists to prevent.
    const scope = resolveSymbolSearchScope('typescript', anchor, dir);
    expect(scope.error).toMatch(/tsconfig\.json/);
    expect(scope.error).toMatch(/'file'/);
  });

  // P-002 (gitnexus-deterministic-integration-2026-10-05, D-010): an agent
  // replacing `grep -rn "export function X" <dir>` knows a DIRECTORY, and a
  // directory used to die with a raw EISDIR from being opened as a document.
  it('resolves a TypeScript DIRECTORY anchor to its project and an openable non-test source', async () => {
    const pkg = join(dir, 'packages', 'operator-core');
    await mkdir(join(pkg, 'lib', 'memory'), { recursive: true });
    await writeFile(join(pkg, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    await writeFile(join(pkg, 'lib', 'memory', 'a.test.ts'), 'export const t = 1;\n');
    await writeFile(join(pkg, 'lib', 'memory', 'types.d.ts'), 'export type T = 1;\n');
    await writeFile(join(pkg, 'lib', 'memory', 'store.ts'), 'export function store() {}\n');

    const scope = resolveSymbolSearchScope('typescript', join(pkg, 'lib', 'memory'), dir);
    expect(scope.error).toBeNull();
    expect(scope.root).toBe(pkg);
    // A real source, never the directory (EISDIR), a declaration file, or a
    // test file that a tsconfig may exclude into an inferred project.
    expect(scope.anchor).toBe(join(pkg, 'lib', 'memory', 'store.ts'));
  });

  it('refuses a directory anchor that spans NESTED tsconfig projects, naming them', async () => {
    for (const lib of ['alpha', 'beta']) {
      await mkdir(join(dir, 'libs', 'generic', lib, 'src'), { recursive: true });
      await writeFile(join(dir, 'libs', 'generic', lib, 'tsconfig.json'), '{}\n');
      await writeFile(join(dir, 'libs', 'generic', lib, 'src', 'index.ts'), 'export const x = 1;\n');
    }
    const scope = resolveSymbolSearchScope('typescript', join(dir, 'libs', 'generic'), dir);
    // Answering for one project would read as ABSENCE for symbols in the other.
    expect(scope.error).toMatch(/2 nested tsconfig\/jsconfig project/);
    expect(scope.error).toContain(join(dir, 'libs', 'generic', 'alpha'));
    expect(scope.anchor).toBeNull();
  });

  it('refuses a directory anchor that holds no TypeScript source to open', async () => {
    const pkg = join(dir, 'packages', 'docs-only');
    await mkdir(join(pkg, 'notes'), { recursive: true });
    await writeFile(join(pkg, 'tsconfig.json'), '{}\n');
    await writeFile(join(pkg, 'notes', 'README.md'), '# x\n');
    const scope = resolveSymbolSearchScope('typescript', join(pkg, 'notes'), dir);
    expect(scope.error).toMatch(/no TypeScript source/);
    expect(scope.error).toMatch(/'file'/);
  });

  it('roots a rust DIRECTORY anchor at the crate holding it, opening nothing', async () => {
    const crate = join(dir, 'apps', 'tui');
    await mkdir(join(crate, 'src'), { recursive: true });
    await writeFile(join(crate, 'Cargo.toml'), '[package]\nname = "tui"\n');
    const scope = resolveSymbolSearchScope('rust', join(crate, 'src'), dir);
    expect(scope.error).toBeNull();
    expect(scope.root).toBe(crate);
    expect(scope.anchor).toBeNull();
  });

  /**
   * The tests above drive the two helpers directly, which cannot see whether
   * `lspWorkspaceSymbols` still CALLS them — delete either call site and every
   * assertion above stays green. That is the same blind spot that let an
   * identical dropped-argument bug survive a fully covered file once already:
   * a missing call is an absent value, not a wrong one, so only a check that
   * looks at the wiring itself can catch it. Driving the real function instead
   * would need a live language server, which a unit test must not require.
   */
  it('lspWorkspaceSymbols still WIRES both halves (deletion guard)', () => {
    const source = readFileSync(new URL('./lsp-adapter.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function lspWorkspaceSymbols');
    expect(start, 'lspWorkspaceSymbols not found — rename the guard with it').toBeGreaterThan(-1);
    // Bound the slice to this function so a call in a NEIGHBOUR cannot satisfy it.
    const end = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    // Half 1: the scope must be resolved (or refused) before the server is asked.
    expect(body).toContain('resolveSymbolSearchScope(');
    expect(body).toMatch(/scope\.error\s*\)\s*return fail\(/);
    // Half 2: an empty must never be returned without its scope caveat.
    expect(body).toContain('symbolSearchEmptyCaveat(');
    expect(body).toMatch(/sites\.length === 0/);

    // CONTROL: the slice really is the function body and not an empty string,
    // or all four assertions above would be asserting against nothing.
    expect(body).toContain("const intent: CodeIntelIntent = 'symbol-search'");
    expect(body.length).toBeGreaterThan(500);
  });

  it('keeps the project lease release in the outer finally path', () => {
    const source = readFileSync(new URL('./lsp-adapter.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function lspWorkspaceSymbols');
    expect(start, 'lspWorkspaceSymbols not found — rename the guard with it').toBeGreaterThan(-1);
    const end = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    // The lease callback must be assigned directly in the anchored branch.
    // Keeping that assignment out of Promise.then preserves TypeScript's
    // narrowing through the finally block and guarantees error-path cleanup.
    expect(body).toMatch(
      /if\s*\(scope\.anchor\)\s*\{\s*const leased = await getLeasedClient\(/,
    );
    expect(body).toContain('releaseProjectLease = leased.release;');
    expect(body).toMatch(/finally\s*\{[\s\S]*releaseProjectLease\?\.\(\);/);
    expect(body).not.toContain('.then((leased) =>');
  });
});

describe('readinessVerdict — only the server may certify; silence is never proof (WI-2142382)', () => {
  const settleWindow = (settleMs = 5_000): LspReadinessStrategy => ({
    kind: 'settle-window',
    intent: 'definition',
    settleMs,
  });
  const progressSignal: LspReadinessStrategy = {
    kind: 'progress-signal',
    intent: 'references',
  };

  /**
   * The MEASURED state at the instant a false proof was minted, copied from
   * the live client rather than imagined. Probe: a cross-project `definition`
   * at packages/operator-core/lib/pty-bridge.ts:169, isolated one case per
   * process. The second query returned sites=[nothing] health=healthy
   * error=null while the client read exactly this.
   */
  const measuredAtFalseProof = {
    quiescent: null,
    everSettled: true,
    idle: true,
    idleForMs: 5_001,
  } as const;

  it('REGRESSION: the exact measured state yields answerable, NOT certified', () => {
    // Before the fix this returned 'certified', which put 'definition' into
    // certifiedReadiness, which made healthForAnswer hand an EMPTY answer the
    // client's 'healthy' — a false absence that isTrustworthyEmpty then
    // reported as fact, irrevocably for that client's life.
    expect(readinessVerdict(settleWindow(), measuredAtFalseProof)).toBe('answerable');
  });

  it('DEMONSTRATES why the everSettled guard was the wrong fix — it was already true', () => {
    // The originally-filed root cause was "the settle-window branch certifies
    // on pure silence because it lacks the everSettled guard its sibling has".
    // The measurement refuted it: everSettled was TRUE at the false proof, so
    // that guard would have changed nothing on the real failing case. These
    // assertions pin the reason — the verdict is identical either way, so
    // everSettled is orthogonal here and cannot be the discriminator.
    expect(measuredAtFalseProof.everSettled).toBe(true);
    expect(readinessVerdict(settleWindow(), measuredAtFalseProof)).toBe('answerable');
    expect(readinessVerdict(settleWindow(), { ...measuredAtFalseProof, everSettled: false })).toBe(
      'answerable',
    );
  });

  it('certifies ONLY on the server’s own quiescent verdict', () => {
    expect(readinessVerdict(settleWindow(), { ...measuredAtFalseProof, quiescent: true })).toBe(
      'certified',
    );
    expect(readinessVerdict(progressSignal, { ...measuredAtFalseProof, quiescent: true })).toBe(
      'certified',
    );
  });

  it('an explicit NOT-quiescent outranks any amount of idle, in both strategies', () => {
    const busy = { ...measuredAtFalseProof, quiescent: false, idleForMs: 600_000 };
    expect(readinessVerdict(settleWindow(), busy)).toBe('wait');
    expect(readinessVerdict(progressSignal, busy)).toBe('wait');
  });

  it('waits while progress is in flight, however long the strategy window is', () => {
    // The FIRST measured query sat here: pendingProgress=1, so not idle. It
    // polled to the deadline and refused honestly. That is the code working.
    const loading = { quiescent: null, everSettled: false, idle: false, idleForMs: 0 };
    expect(readinessVerdict(settleWindow(1), loading)).toBe('wait');
    expect(readinessVerdict(progressSignal, loading)).toBe('wait');
  });

  it('holds until the settle window has actually elapsed', () => {
    expect(
      readinessVerdict(settleWindow(5_000), { ...measuredAtFalseProof, idleForMs: 4_999 }),
    ).toBe('wait');
  });

  it('progress-signal still requires a COMPLETED cycle before even a canary', () => {
    // Pre-first-progress silence carries no information from a server that
    // announces its indexing.
    const neverSettled = { quiescent: null, everSettled: false, idle: true, idleForMs: 600_000 };
    expect(readinessVerdict(progressSignal, neverSettled)).toBe('wait');
    expect(readinessVerdict(progressSignal, { ...neverSettled, everSettled: true })).toBe('canary');
  });

  it('a canary-query strategy is unproven by construction', () => {
    const strategy: LspReadinessStrategy = {
      kind: 'canary-query',
      intent: 'references',
      minimumSites: 1,
    };
    expect(readinessVerdict(strategy, { ...measuredAtFalseProof, quiescent: true })).toBe('canary');
  });

  it('END TO END: a settle-window empty is now UNTRUSTWORTHY, a non-empty still answers', () => {
    // 'answerable' means the intent never enters certifiedReadiness, and
    // certifyCanaryAnswer refuses a zero-site answer. So the empty degrades.
    expect(readinessVerdict(settleWindow(), measuredAtFalseProof)).toBe('answerable');
    const uncertified = ts();
    expect(healthForAnswer(uncertified, 'definition', 0)).toBe('degraded');
    expect(
      isTrustworthyEmpty({
        sites: [],
        error: null,
        freshness: {
          health: healthForAnswer(uncertified, 'definition', 0),
          indexedAt: null,
          staleVsDisk: null,
          indexedCommit: null,
        },
      } as never),
    ).toBe(false);

    // Availability is NOT what we gave up: a non-empty answer is still served.
    expect(healthForAnswer(uncertified, 'definition', 1)).toBe('healthy');
  });

  it('REGRESSION #2: answerable must not degrade a CORRECT non-empty answer', () => {
    // The first cut of this fix returned 'canary' here instead of 'answerable'.
    // That routed positives into certifyCanaryAnswer's stability guard, which
    // demands a progress boundary AND an answer change between samples —
    // evidence a WARM server never produces, because its correct answer is
    // stable from the very first query. Result: every correct answer became
    // permanently 'degraded'.
    //
    // MEASURED against real language servers before this assertion existed:
    //   pinModuleState   -> libs/generic/module-singleton/src/index.ts:106  degraded
    //   managedSetInterval -> libs/generic/scheduled-registry/src/index.ts:315 degraded
    // Both were 'healthy' before the change, and both are the CORRECT site.
    //
    // The previous suite could not catch this: it asserted healthForAnswer on a
    // hand-built client, which never ran the certifyCanaryAnswer step that
    // populates unprovenReadiness. So it must be asserted on the COMPOSED path.
    const client = {
      language: 'typescript' as const,
      health: 'healthy' as const,
      progressGeneration: 0,
      certifiedReadiness: new Set<LspReadinessIntent>(),
      canaryReadiness: new Map(),
      unprovenReadiness: new Set<LspReadinessIntent>(),
    };
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(readinessVerdict(settleWindow(), measuredAtFalseProof)).toBe('answerable');

    // 'answerable' mints no proof AND marks nothing unproven.
    expect(certifyCanaryAnswer(adapterClient, 'definition', 'answerable', 1)).toBe(false);
    expect(client.unprovenReadiness.has('definition')).toBe(false);
    expect(client.certifiedReadiness.has('definition')).toBe(false);

    // The positive keeps its health; the empty still degrades. Both halves.
    expect(healthForAnswer(client, 'definition', 1)).toBe('healthy');
    expect(healthForAnswer(client, 'definition', 0)).toBe('degraded');

    // FALSIFIABILITY CONTROL: the first cut's verdict really did degrade it.
    // If this stops reproducing, the assertion above proves nothing.
    expect(certifyCanaryAnswer(adapterClient, 'definition', 'canary', 1)).toBe(false);
    expect(client.unprovenReadiness.has('definition')).toBe(true);
    expect(healthForAnswer(client, 'definition', 1)).toBe('degraded');
  });

  it('CONTROL: the pre-fix rule really would have certified this state', () => {
    // Falsifiability control, kept permanently. This reproduces the OLD
    // predicate literally. If it ever stops returning true, this suite is
    // passing for the wrong reason and the regression above proves nothing.
    const oldSettleWindowWouldCertify = (o: typeof measuredAtFalseProof, settleMs: number) =>
      o.quiescent !== false && o.idle && o.idleForMs >= settleMs;
    expect(oldSettleWindowWouldCertify(measuredAtFalseProof, 5_000)).toBe(true);
    expect(readinessVerdict(settleWindow(), measuredAtFalseProof)).not.toBe('certified');
  });
});

describe('prepareIntentReadiness — a quiet server is not re-timed by every query (WI-2142532)', () => {
  // WHY THIS ASSERTS ON THE COMPOSED PATH, not on readinessVerdict:
  //
  // readinessVerdict is PURE over the `idleForMs` it is handed. It was correct
  // before this regression and correct after it, so all 20 of its tests stayed
  // green while warm `definition` went from ~1ms to 5036ms. The mechanism was
  // never the comparison — it was that `idleSince` lived in this function's
  // STACK FRAME, so every call re-measured the idle window from zero and paid
  // the full 5000ms settle even on a server idle for minutes.
  //
  // It hid behind the very bug the `answerable` verdict fixed: the settle window
  // used to return 'certified' and CACHE the proof, so only the first query ever
  // paid the window. That cache was doing double duty — a (false) correctness
  // proof AND a (legitimate) performance memo. Removing the false proof removed
  // the memo with it.
  //
  // MEASURED on the frozen corpus (definition-cross-package-bare-specifier),
  // median of 5 warm queries: v2 2ms · v3 2ms · v5 1ms · v6 5036ms (max 5037ms).
  // A fixed toll, not a distribution — the signature of a re-paid countdown.
  const tsClient = (idleSince: number | null, pending: Array<string> = []) =>
    ({
      language: 'typescript' as const,
      health: 'healthy' as const,
      quiescent: null,
      everSettled: true,
      pendingProgress: new Set(pending),
      idleSince,
      certifiedReadiness: new Set(),
      canaryReadiness: new Map(),
      unprovenReadiness: new Set(),
      progressGeneration: 0,
    }) as unknown as Parameters<typeof prepareIntentReadiness>[0];

  it('answers IMMEDIATELY when the server has been continuously idle past the window', async () => {
    const client = tsClient(Date.now() - 60_000);
    const startedAt = Date.now();

    // A 250ms budget is far below the 5000ms settle window: if the window were
    // re-measured from this call, this could only time out.
    await expect(prepareIntentReadiness(client, 'definition', 250)).resolves.toBe('answerable');
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('STILL waits out the window when the idle period only just began', async () => {
    // Falsifiability control. Without it, the assertion above is equally
    // satisfied by deleting the settle window altogether — which would restore
    // the warm latency AND reopen the false-empty the window exists to prevent.
    const client = tsClient(Date.now());
    await expect(prepareIntentReadiness(client, 'definition', 250)).resolves.toBe('timeout');
  });

  it('does not RESET the idle observation it reads — the period survives the query', async () => {
    // The regression stated as a property: a query is an OBSERVER of the idle
    // period, never its origin. This is what a stack-frame variable cannot do.
    const idleSince = Date.now() - 20;
    const client = tsClient(idleSince);

    await prepareIntentReadiness(client, 'definition', 100);

    expect((client as unknown as { idleSince: number | null }).idleSince).toBe(idleSince);
  });

  it('treats a LOADING server as not idle regardless of any stale timestamp', async () => {
    // Guards the direction that matters for correctness: a stale idleSince must
    // never let an actively-indexing server answer.
    const client = tsClient(Date.now() - 60_000, ['token-1']);
    await expect(prepareIntentReadiness(client, 'definition', 250)).resolves.toBe('timeout');
  });
});

/**
 * WI-2142693 — the dead-language-service class.
 *
 * The adapter spawns `typescript-language-server`, but the process that answers
 * a query is `tsserver`, ITS CHILD. Measured: kill the child and the wrapper
 * lives on — no exit, no notification, zero bytes of stderr — answering `null`
 * to a query that returned a real site seconds before, and never respawning.
 * `child.on('exit')` therefore cannot fire for the one failure whose own comment
 * says it exists to catch, and `getClient` re-hands the corpse to every future
 * caller for the life of the process.
 *
 * These cases pin the two decisions that each produce a CONFIDENT WRONG ANSWER
 * rather than an error, so neither can be "simplified" away later:
 *  - childless rust is healthy, not dead (rust-analyzer has no child at all);
 *  - childless-and-never-seen is "not yet", not "died".
 */
describe('probeLanguageServiceLiveness (WI-2142693)', () => {
  const tsChild = (over: Partial<{ pid: number; exitCode: number | null; killed: boolean }> = {}) => ({
    pid: 4242,
    exitCode: null as number | null,
    killed: false,
    ...over,
  });

  it('reports alive while the wrapper owns a child, and remembers having seen one', () => {
    const client = {
      language: 'typescript' as const,
      tsserverSeen: undefined as boolean | undefined,
      child: tsChild(),
    };
    expect(probeLanguageServiceLiveness(client, () => [4243, 4244])).toBe('alive');
    // The latch is the whole basis for any later 'dead' verdict.
    expect(client.tsserverSeen).toBe(true);
  });

  it('reports DEAD once a wrapper we have seen with a child has none', () => {
    const client = { language: 'typescript' as const, tsserverSeen: true, child: tsChild() };
    expect(probeLanguageServiceLiveness(client, () => [])).toBe('dead');
  });

  it('reports unknown — NOT dead — for a childless wrapper never seen with a child', () => {
    // The startup trap: before tsserver is spawned, "no children" means "not
    // yet". Calling that death would evict every server during its own boot.
    const client = {
      language: 'typescript' as const,
      tsserverSeen: undefined as boolean | undefined,
      child: tsChild(),
    };
    expect(probeLanguageServiceLiveness(client, () => [])).toBe('unknown');
  });

  it('never condemns a childless rust client', () => {
    // rust-analyzer is ONE process with no children. A language-blind
    // "no children ⇒ dead" would evict every healthy rust client on its first
    // legitimately-empty answer.
    const client = { language: 'rust' as const, tsserverSeen: true, child: tsChild() };
    expect(probeLanguageServiceLiveness(client, () => [])).toBe('unknown');
  });

  it('reports unknown when the child list cannot be read', () => {
    // Off Linux there is no /proc; an unreadable list must not read as "empty".
    const client = { language: 'typescript' as const, tsserverSeen: true, child: tsChild() };
    expect(probeLanguageServiceLiveness(client, () => null)).toBe('unknown');
  });

  it('still catches the wrapper itself exiting', () => {
    const client = { language: 'typescript' as const, tsserverSeen: true, child: tsChild({ exitCode: 1 }) };
    expect(probeLanguageServiceLiveness(client, () => [4243])).toBe('dead');
  });
});

describe('evictIfLanguageServiceDead (WI-2142693)', () => {
  const deadClient = () =>
    ({
      language: 'typescript',
      rootPath: '/repo',
      tsserverSeen: true,
      health: 'healthy',
      lastError: null,
      child: { pid: 4242, exitCode: null, killed: false },
    }) as unknown as Parameters<typeof evictIfLanguageServiceDead>[0];

  it('UNREGISTERS the dead client so the next query starts a fresh server', () => {
    // Detection alone would only make the outage honest. `getClient` reuses any
    // client whose health is not 'unhealthy', so without the delete the corpse
    // is handed out forever — the difference between a crash and an outage.
    const client = deadClient();
    const clients = new Map([['typescript::/repo', client]]);
    const reason = evictIfLanguageServiceDead(client, clients, () => []);
    expect(reason).toMatch(/language service died/i);
    expect(client.health).toBe('unhealthy');
    expect(clients.has('typescript::/repo')).toBe(false);
  });

  it('leaves a live client registered and untouched', () => {
    const client = deadClient();
    const clients = new Map([['typescript::/repo', client]]);
    expect(evictIfLanguageServiceDead(client, clients, () => [4243])).toBeNull();
    expect(client.health).toBe('healthy');
    expect(clients.has('typescript::/repo')).toBe(true);
  });

  it('surfaces the stderr tail when the server left one', () => {
    // stderr is piped and, before this fix, never read — which is why five
    // separate probes found a corpse and no cause.
    const client = deadClient();
    (client as unknown as { stderrTail: string }).stderrTail = 'FATAL ERROR: heap out of memory';
    const reason = evictIfLanguageServiceDead(client, new Map(), () => []);
    expect(reason).toContain('heap out of memory');
  });
});

describe('typescriptInitializationOptions — the tsserver memory ceiling (WI-2142840)', () => {
  /**
   * MEASURED, same probe, one variable changed: at node's default old-space
   * tsserver reached 4314MB RSS and self-aborted (`Signal: SIGABRT`), taking
   * every TypeScript answer down with it; at 6144 it reached 4981MB, SURVIVED,
   * and returned the correct site for the query that had never once answered.
   *
   * These cases exist because the option was a literal buried in the spawn
   * path, where deleting it would break nothing any unit run could see — the
   * damage shows up only as an empty `definition` against a large package,
   * which is exactly the shape that stayed misdiagnosed for five investigations.
   */
  it('passes maxTsServerMemory, so tsserver does not run at the ceiling it dies at', () => {
    expect(typescriptInitializationOptions('/x/tsserver.js', 6144)).toEqual({
      tsserver: { path: '/x/tsserver.js' },
      maxTsServerMemory: 6144,
    });
  });

  it('carries a default that clears the measured 4314MB abort point', () => {
    const opts = typescriptInitializationOptions('/x/tsserver.js');
    // Not an equality assertion on 6144: the value may be retuned, but a
    // default at or below where it demonstrably aborts is the regression.
    expect(opts.maxTsServerMemory ?? 0).toBeGreaterThan(4314);
  });

  it('OMITS the key when null, so an opt-out restores node default rather than pinning another number', () => {
    const opts = typescriptInitializationOptions('/x/tsserver.js', null);
    expect(opts).toEqual({ tsserver: { path: '/x/tsserver.js' } });
    expect('maxTsServerMemory' in opts).toBe(false);
  });

  it('CONTROL: the assertion really does catch the pre-fix shape', () => {
    // The pre-fix options object was exactly this, and it is what shipped the
    // crash. If the guard above ever stops failing on it, it has gone slack.
    const preFix = { tsserver: { path: '/x/tsserver.js' } } as {
      tsserver: { path: string };
      maxTsServerMemory?: number;
    };
    expect(preFix.maxTsServerMemory ?? 0).not.toBeGreaterThan(4314);
  });
});
