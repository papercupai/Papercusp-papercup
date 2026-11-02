/**
 * Unit tests for the pure min/max responder-selection half of the relevance
 * router (plan consult-min-max-and-rubric-vetting-2026-08-17, P-001;
 * decisions D-001 §1 / D-002 / D-003). selectResponders is deliberately pure
 * and shared by every selecting surface so the semantics cannot drift between
 * call sites — these tests pin them.
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { buildSidecarFirstEmbedder, EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../search/prose-vector-dims';
import {
  selectResponders,
  routeConsult,
  type ConsultRouteDeps,
  type ExpertiseRoutingReceipt,
  selectionSnapshot,
  snapshotCandidateQualifies,
  qualifyingScoreOf,
  relevanceOf,
  freshnessOf,
  expertiseSubject,
  extractPathTokens,
  subjectEvidenceQuery,
  contrastedSubjectScore,
  subjectContrasts,
  scoreSubjectEvidence,
  meetsRoutingFloors,
  SUBJECT_EVIDENCE_MIN_SCORE,
  FRESHNESS_BASE,
  relativeLexicalRanks,
  type RoutingCandidate,
  type SelectedResponder,
} from './relevance-router';

describe('relativeLexicalRanks — lexical fallback scores are engine-independent (BM25 plan P-005)', () => {
  it('divides by the best score, so unbounded BM25 scores keep their order instead of all clamping to 1', () => {
    const rows = [{ owner: 'a', lexicalRank: 8 }, { owner: 'b', lexicalRank: '4' }, { owner: 'c', lexicalRank: 2 }];
    expect(relativeLexicalRanks(rows).map((r) => r.lexicalRank)).toEqual([1, 0.5, 0.25]);
  });

  it('gives the same values for ts_rank_cd-sized scores in the same ratios', () => {
    const rows = [{ lexicalRank: 0.08 }, { lexicalRank: 0.04 }, { lexicalRank: 0.02 }];
    expect(relativeLexicalRanks(rows).map((r) => r.lexicalRank)).toEqual([1, 0.5, 0.25]);
  });

  it('keeps zero and non-finite scores at zero instead of dividing by them', () => {
    expect(relativeLexicalRanks([{ lexicalRank: 0 }, { lexicalRank: 0 }]).map((r) => r.lexicalRank)).toEqual([0, 0]);
    expect(relativeLexicalRanks([{ lexicalRank: 'NaN' }, { lexicalRank: 2 }]).map((r) => r.lexicalRank)).toEqual([0, 1]);
    expect(relativeLexicalRanks([])).toEqual([]);
  });
});

const cand = (ownerId: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  ownerId,
  score: 0.7,
  relevance: 0.7,
  relativeAgeDays: 0,
  signals: { similarity: 0.72, verification: 0.3, authorship: 0, freshness: 1 },
  evidence: [],
  liveness: 'live',
  ...over,
});

const ids = (s: SelectedResponder[]) => s.map((x) => x.candidate.ownerId);
const vias = (s: SelectedResponder[]) => s.map((x) => x.via);

describe('problem-specific expertise qualification', () => {
  it('does not mistake prose slash pairs for a repository subject', () => {
    const question = 'Distinguish child/source lease actors with a before/after audit and CPU/q8 scoring.';
    expect(extractPathTokens(question)).toEqual([]);
    expect(expertiseSubject(question)).toBeNull();
    expect(extractPathTokens('Compare before/after in packages/core/lease.ts and `src/leases`.'))
      .toEqual(['packages/core/lease.ts', 'src/leases']);
    expect(extractPathTokens('Inspect ./src/leases, /var/log/leases and src/leases/.'))
      .toEqual(['./src/leases', '/var/log/leases', 'src/leases/']);
  });

  it('scores a natural question with punctuation without requiring a named tool contract', async () => {
    const question = 'Which lease writer caused the before/after change? Note: preserve the native cleanup receipt.';
    const scorer = vi.fn(async () => [0.9, 0.1]);
    const contracts = [{ name: 'session:request-compaction', description: 'Recover a generic continuation.' }];
    const primary = 'Which lease writer caused the before/after change?';
    expect(subjectEvidenceQuery(question)).toBe(primary);
    expect(await scoreSubjectEvidence(question, ['lease actor audit with generic continuation'],
      Date.now() + 4000, { scorer, contracts })).toEqual([0.9]);
    expect(scorer).toHaveBeenCalledWith('lease actor audit with generic continuation',
      [primary, 'session:request-compaction\nRecover a generic continuation.'], expect.any(Object));
    expect(subjectEvidenceQuery('Context: the native child kept a receipt. Which lease actor changed it? Preserve the log.'))
      .toBe('Context: the native child kept a receipt. Which lease actor changed it?');
    expect(subjectEvidenceQuery('Diagnose native lease actors and preserve the original receipt'))
      .toBe('Diagnose native lease actors and preserve the original receipt');
  });

  it('rejects natural-question procedural overlap when another primary action explains the passage better', async () => {
    const question = 'Which native lease actor changed the source?';
    const contracts = [{ name: 'session:request-compaction', description: 'Recover a generic continuation.' }];
    const scorer = vi.fn(async (passage: string, _texts: string[]) => passage.startsWith('lease') ? [0.92, 0.2] : [0.78, 0.95]);
    const deadline = Date.now() + 4000;
    const scores = await scoreSubjectEvidence(question,
      ['lease actor with generic continuation', 'generic continuation before/after recovery'], deadline, { scorer, contracts });
    expect(scores[0]).toBeGreaterThanOrEqual(SUBJECT_EVIDENCE_MIN_SCORE);
    expect(scores[1]).toBeLessThan(SUBJECT_EVIDENCE_MIN_SCORE);
    for (const call of scorer.mock.calls) expect(call[1]).toEqual([
      question, 'session:request-compaction\nRecover a generic continuation.',
    ]);
    expect(await scoreSubjectEvidence(question, ['generic continuation'], deadline,
      { scorer, contracts: [] })).toEqual([null]);
    expect(await scoreSubjectEvidence(question, ['generic continuation'], deadline,
      { scorer: async () => [0.9], contracts })).toEqual([null]);
  });

  it('requires primary-issue evidence even when a passage matches the contextual preamble', async () => {
    const question = 'For distributed request processing, which writer changed the resource lease? Preserve the receipt.';
    const primary = 'For distributed request processing, which writer changed the resource lease?';
    const issue = 'which writer changed the resource lease?';
    const contracts = [{ name: 'request:deliver', description: 'Deliver a distributed request.' }];
    const scorer = vi.fn(async (text: string, queries: string[]) => queries.map(query => {
      if (query === primary) return 0.9;
      if (query === issue) return text.startsWith('writer') ? 0.8 : 0.1;
      return 0.2;
    }));
    const scores = await scoreSubjectEvidence(question, ['writer lease audit for a distributed request', 'distributed request delivery'],
      Date.now() + 4000, { scorer, contracts });
    expect(scores[0]).toBeGreaterThanOrEqual(SUBJECT_EVIDENCE_MIN_SCORE);
    expect(scores[1]).toBeLessThan(SUBJECT_EVIDENCE_MIN_SCORE);
    expect(scorer.mock.calls[0][1]).toEqual([primary, issue, 'request:deliver\nDeliver a distributed request.']);
  });

  it('reports bounded scoring causes without exposing provider errors or changing unknown scores', async () => {
    const contracts = [{ name: 'request:deliver', description: 'Deliver a distributed request.' }];
    const onFailure = vi.fn();
    const deadline = Date.now() + 4000;
    const question = 'Which writer changed the lease?';
    const texts = ['lease writer and distributed request delivery'];
    const scorer = vi.fn(async () => { throw Object.assign(new Error('private provider payload'), { name: 'RerankDeadlineError' }); });
    expect(await scoreSubjectEvidence(question, texts, deadline, { scorer, contracts, onFailure })).toEqual([null]);
    expect(onFailure).toHaveBeenLastCalledWith({ reason: 'scorer-error', errorCode: 'ETIMEDOUT' });
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private provider payload');
    onFailure.mockClear();
    expect(await scoreSubjectEvidence('missing:contract', texts, deadline, { scorer, contracts, onFailure })).toEqual([null]);
    expect(onFailure).toHaveBeenLastCalledWith({ reason: 'missing-contract' });
    onFailure.mockClear();
    expect(await scoreSubjectEvidence(question, texts, Date.now() - 1, { scorer, contracts, onFailure })).toEqual([null]);
    expect(onFailure).toHaveBeenLastCalledWith({ reason: 'deadline' });
    onFailure.mockClear();
    expect(await scoreSubjectEvidence(question, texts, deadline, { scorer: async () => [], contracts, onFailure })).toEqual([null]);
    expect(onFailure).toHaveBeenLastCalledWith({ reason: 'score-shape' });
    expect(await scoreSubjectEvidence(question, texts, deadline, {
      scorer: async () => [], contracts, onFailure: () => { throw new Error('diagnostic failure'); },
    })).toEqual([null]);
  });

  it('nominates competing primary actions without matching their operational boilerplate', () => {
    const contracts = [
      { name: 'db:migrate', description: 'Apply a SQL migration.' },
      { name: 'accounts:pin', description: 'Pin a billing account. Inference model migration endpoint routing.' },
      { name: 'dev:cache_stats', description: 'Read cache statistics. Inference model migration endpoint routing.' },
      { name: 'fleet:status', description: 'Read fleet status. Inference model migration endpoint routing.' },
      { name: 'gateway:owner_report', description: 'Report inference model migration endpoint routing outcomes.' },
    ];
    expect(subjectContrasts('db:migrate', 'inference model migration endpoint routing', contracts).map(c => c.name))
      .toEqual(['gateway:owner_report']);
  });

  it('compares the registered primary action without unrelated operational notes', () => {
    expect(subjectEvidenceQuery('db:migrate',
      'Apply a SQL migration file, coordinated. DRY RUN unless confirm:true; drain before applying.'))
      .toBe('db:migrate\nApply a SQL migration file, coordinated.');
    expect(subjectEvidenceQuery('gateway:owner_report',
      'Report inference routing outcomes. Uses the shared SQL ledger for durable history.'))
      .toBe('gateway:owner_report\nReport inference routing outcomes.');
    expect(subjectEvidenceQuery('computer:observe',
      'Read org.example.Widget v2.1 roles and state. Returns activation references.'))
      .toBe('computer:observe\nRead org.example.Widget v2.1 roles and state.');
    expect(subjectEvidenceQuery('tools:read', 'x'.repeat(2_000)))
      .toBe(`tools:read\n${'x'.repeat(1_500)}`);
    expect(subjectEvidenceQuery('db:migrate', '  ')).toBeNull();
    expect(subjectEvidenceQuery('src/schema.sql', 'Operational notes.')).toBe('src/schema.sql');
  });

  it('requires measured contract evidence to beat a competing system, rather than trusting a high absolute score', async () => {
    expect(contrastedSubjectScore(0.74, [0.91])).toBeLessThan(0.5);
    expect(contrastedSubjectScore(0.81, [0.65])).toBeGreaterThan(0.5);
    expect(contrastedSubjectScore(0.4, [0.1])).toBeLessThan(0.5);
    for (const alternatives of [[], [null], [NaN], [2]]) expect(contrastedSubjectScore(0.9, alternatives)).toBeNull();
    const contracts = [
      { name: 'computer:provision_desktop', description: 'Start a sandboxed GUI desktop.' },
      { name: 'computer:observe', description: 'Read accessible GUI widgets.' },
      { name: 'release:checkpoint-run', description: 'Run the release gate checkpoint suite.' },
    ];
    expect(subjectContrasts('computer:provision_desktop', 'release gate checkpoint', contracts).map(c => c.name))
      .toEqual(['release:checkpoint-run']);
    const scorer = vi.fn(async (_query: string, texts: string[]) => texts.map((_, i) => i ? 0.91 : 0.74));
    const scores = await scoreSubjectEvidence('computer:provision_desktop', ['release gate checkpoint'], Date.now() + 4000, { contracts, scorer });
    expect(scores[0]).toBeLessThan(0.5);
    expect(scorer.mock.calls[0][0]).toBe('release gate checkpoint');
    expect(scorer.mock.calls[0][1]).toEqual(['computer:provision_desktop\nStart a sandboxed GUI desktop.',
      'release:checkpoint-run\nRun the release gate checkpoint suite.']);
    expect(await scoreSubjectEvidence('missing:contract', ['text'], Date.now() + 4000, { contracts, scorer })).toEqual([null]);
  });

  it('keeps equal competing contracts unmeasured while preserving a supported absolute-floor win', () => {
    expect(contrastedSubjectScore(0.8, [0.8])).toBeNull();
    expect(contrastedSubjectScore(0.8, [0.2, 0.8])).toBeNull();
    expect(contrastedSubjectScore(0.5, [0.5])).toBeNull();
    expect(contrastedSubjectScore(0.5, [0.1])).toBe(SUBJECT_EVIDENCE_MIN_SCORE);
  });

  it('propagates overlapping contract ambiguity without discarding a distinct supported passage', async () => {
    const contracts = [
      { name: 'computer:provision_desktop', description: 'Start a sandboxed GUI desktop.' },
      { name: 'release:checkpoint-run', description: 'Run the release gate checkpoint suite.' },
    ];
    const scorer = async (text: string) => text.startsWith('equal') ? [0.8, 0.8] : [0.5, 0.1];
    expect(await scoreSubjectEvidence('computer:provision_desktop',
      ['equal release gate checkpoint', 'distinct release gate checkpoint'], Date.now() + 4000, { contracts, scorer }))
      .toEqual([null, SUBJECT_EVIDENCE_MIN_SCORE]);
  });

  it('keeps measured peer evidence when another passage cannot be scored, and preserves missing contrasts as unknown', async () => {
    const contracts = [
      { name: 'computer:provision_desktop', description: 'Start a sandboxed GUI desktop.' },
      { name: 'release:checkpoint-run', description: 'Run the release gate checkpoint suite.' },
    ];
    const scorer = async (text: string) => {
      if (text.startsWith('unavailable')) throw new Error('deadline');
      return [0.9, 0.2];
    };
    const observed = await scoreSubjectEvidence('computer:provision_desktop',
      ['unavailable release checkpoint', 'desktop repair instead of release checkpoint'], Date.now() + 4000, { contracts, scorer });
    expect(observed[0]).toBeNull();
    expect(observed[1]).toBeGreaterThan(0.5);
    expect(await scoreSubjectEvidence('computer:provision_desktop', ['unrelated'], Date.now() + 4000, { contracts, scorer })).toEqual([null]);
  });

  it('anchors named tools independently of shared ownership decision words', () => {
    expect(expertiseSubject('stale desktop rows block computer:provision_desktop; use soleOwner?')).toBe('computer:provision_desktop');
    expect(expertiseSubject('inspect packages/core/lease.ts for stale leases')).toBe('packages/core/lease.ts');
    expect(expertiseSubject('For the existing code-cleanup-campaigns-2026-10-26 first real campaign, is there a safe route?'))
      .toBe('code-cleanup-campaigns-2026-10-26');
    expect(expertiseSubject('Audit acceptance-mobile-agent-sessions-2026-10-12 revision11; emit with acknowledgeExisting:true.'))
      .toBeNull();
    expect(expertiseSubject('how should ownership work?')).toBeNull();
    expect(subjectEvidenceQuery('computer:observe')).toBeNull();
    expect(subjectEvidenceQuery('computer:observe', 'Capture a desktop screenshot.')).toContain('desktop screenshot');
    expect(subjectEvidenceQuery('packages/core/lease.ts')).toBe('packages/core/lease.ts');
  });

  it('preserves a conceptual positive and refuses above-floor mismatches, including snapshot refill', () => {
    const floors = { simFloor: 0.4, relevanceFloor: 0.41 };
    for (const status of ['supported', 'mismatch', 'unmeasured'] as const) {
      const candidate = cand('historical-expert', { subjectEvidence: {
        subject: 'computer:provision_desktop', status,
        score: status === 'unmeasured' ? null : status === 'supported' ? 0.692 : 0.350,
      } });
      expect(meetsRoutingFloors(candidate, floors)).toBe(status === 'supported');
      expect(snapshotCandidateQualifies(floors, candidate)).toBe(status === 'supported');
    }
    expect(SUBJECT_EVIDENCE_MIN_SCORE).toBe(0.5);
    expect(meetsRoutingFloors(cand('legacy'), floors)).toBe(true);
    expect(meetsRoutingFloors(cand('subject-only', { signals: { similarity: 0.1, verification: 1, authorship: 1, freshness: 1 },
      subjectEvidence: { subject: 'computer:provision_desktop', status: 'supported', score: 1 } }), floors)).toBe(false);
  });

  it('keeps a subject mismatch labelled minimum instead of restoring expert status', () => {
    const negative = cand('gate-owner', { subjectEvidence: { subject: 'computer:provision_desktop', status: 'mismatch', score: 0.35 } });
    expect(vias(selectResponders({ qualified: [], allCandidates: [negative], min: 1, max: 1 }))).toEqual(['minimum']);
  });
});

describe('routing stage receipts', () => {
  it('derives production callers and requires attributable telemetry and a receipt sink on every binding', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const files = execFileSync('rg', [
      '-l', '\\brouteConsult\\b', 'apps', 'packages', 'libs',
      '--glob', '*.ts', '--glob', '*.tsx', '--glob', '!*.test.ts',
      '--glob', '!*.test.tsx', '--glob', '!*.integration.test.ts',
      '--glob', '!**/node_modules/**', '--glob', '!**/dist/**',
    ], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    const callers: string[] = [];
    const gaps: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, `file://${root}`), 'utf8'),
        ts.ScriptTarget.Latest, true);
      const names = new Set(['routeConsult']);
      const discoverAliases = (node: ts.Node) => {
        if (ts.isImportSpecifier(node) && node.propertyName?.text === 'routeConsult') names.add(node.name.text);
        if (ts.isBindingElement(node) && node.propertyName?.getText(source) === 'routeConsult'
          && ts.isIdentifier(node.name)) names.add(node.name.text);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && ts.isIdentifier(node.initializer) && names.has(node.initializer.text)) names.add(node.name.text);
        ts.forEachChild(node, discoverAliases);
      };
      discoverAliases(source);
      const property = (node: ts.Node | undefined, name: string) => node && ts.isObjectLiteralExpression(node)
        ? node.properties.find(p => p.name?.getText(source).replace(/['"]/g, '') === name) : undefined;
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && (
          (ts.isIdentifier(node.expression) && names.has(node.expression.text))
          || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'routeConsult')
          || (ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression)
            && node.expression.argumentExpression.text === 'routeConsult')
        )) {
          const label = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          callers.push(label);
          const telemetry = property(node.arguments[0], 'telemetry');
          const recorder = property(node.arguments[1], 'recordTelemetry');
          // An inert value cannot satisfy the production receipt requirement.
          const recorderConfigured = recorder && ts.isPropertyAssignment(recorder)
            && (ts.isArrowFunction(recorder.initializer) || ts.isFunctionExpression(recorder.initializer)
              || (ts.isIdentifier(recorder.initializer) && recorder.initializer.text !== 'undefined'));
          if (!telemetry || !ts.isPropertyAssignment(telemetry)
            || !['caller', 'policy', 'buildSha'].every(key => property(telemetry.initializer, key))
            || !recorderConfigured) gaps.push(label);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    // A deleted/renamed mechanism cannot make an empty census pass.
    expect(callers.some(path => path.startsWith('packages/operator-core/lib/consult/get-feedback-prod.ts:'))).toBe(true);
    expect(gaps, `Unattributable production routing calls: ${gaps.join(', ')}`).toEqual([]);
  });

  const params = {
    workspaceId: 'fixture-workspace', requesterId: 'requester', question: 'private question',
    telemetry: { caller: 'fixture-caller', policy: 'consult-default', buildSha: '1234567', correlationId: 'fixture-correlation' },
  };

  it('records a pre-query exception once without losing its identity or logging private text', async () => {
    const error = Object.assign(new Error('private error containing secret text'), { code: '57P01' });
    const receipts: ExpertiseRoutingReceipt[] = [];
    let tick = 0;
    await expect(routeConsult(params, {
      getSql: () => { throw error; }, embed: null, embeddingProfile: null, embeddingMode: null,
      monotonicNow: () => ++tick, recordTelemetry: r => { receipts.push(r); },
    })).rejects.toBe(error);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      caller: 'fixture-caller', policy: 'consult-default', correlationId: 'fixture-correlation',
      buildSha: '1234567', outcome: 'threw', verdict: null, errorCode: '57P01', stages: {},
    });
    expect(JSON.stringify(receipts)).not.toContain('private');
    expect(receipts[0].durationMs).toBeGreaterThan(0);
  });

  it('distinguishes missing embedding from a measured no-expert verdict, and keeps unexecuted stages absent', async () => {
    const sql = vi.fn(async () => []) as unknown as ReturnType<ConsultRouteDeps['getSql']>;
    const receipts: ExpertiseRoutingReceipt[] = [];
    const result = await routeConsult(params, {
      getSql: () => sql, embed: null, embeddingProfile: null, embeddingMode: null,
      recordTelemetry: r => { receipts.push(r); },
    });
    expect(result.verdict).toBe('relevance_unmeasured');
    expect(receipts[0]).toMatchObject({ outcome: 'degraded', verdict: 'relevance_unmeasured' });
    expect(receipts[0].stages.embedding).toBeUndefined();
    expect(receipts[0].stages.verification).toBeUndefined();
    expect(receipts[0].stages.transcripts?.outcome).toBe('returned');
    expect(receipts[0].stages.ranking?.outcome).toBe('returned');
    expect(result.snapshot.measurement).toEqual(receipts[0]);
  });

  it('a synchronous or rejected diagnostic recorder does not replace the routing exception', async () => {
    const error = new Error('route failed');
    for (const recordTelemetry of [() => { throw new Error('sink failed'); }, async () => { throw new Error('sink failed'); }]) {
      await expect(routeConsult(params, {
        getSql: () => { throw error; }, embed: null, embeddingProfile: null, embeddingMode: null,
        recordTelemetry,
      })).rejects.toBe(error);
    }
  });

  it.each([
    ['provider code', Object.assign(new Error('private provider text'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    ['wrapped abort', new Error('private wrapper', { cause: new DOMException('private abort text', 'AbortError') }), 'ABORT_ERR'],
    ['wrapped timeout', new Error('private wrapper', { cause: new DOMException('private timeout text', 'TimeoutError') }), 'ETIMEDOUT'],
    ['unsafe code', Object.assign(new Error('private error'), { code: 'private credential value' }), 'routing_exception'],
  ])('retains a safe %s for an embedding exception recovered by lexical fallback', async (_label, error, code) => {
    const sql = vi.fn(async () => []) as unknown as ReturnType<ConsultRouteDeps['getSql']>;
    const receipts: ExpertiseRoutingReceipt[] = [];
    const result = await routeConsult(params, {
      getSql: () => sql, embed: async () => { throw error; },
      embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
      embeddingMode: 'gemma', recordTelemetry: r => { receipts.push(r); },
    });
    expect(result.verdict).toBe('relevance_unmeasured');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: 'degraded', errorCode: null,
      stages: { embedding: { outcome: 'threw', errorCode: code } } });
    expect(result.snapshot.measurement).toEqual(receipts[0]);
    expect(JSON.stringify(receipts)).not.toContain('private');
  });

  it('retains a native HTTP timeout through the sidecar wrapper and recovered router stage', async () => {
    let received = 0;
    let healthy = true;
    const server = createServer((request, response) => {
      received++;
      request.resume();
      if (healthy) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ vectors: [[1, 0]], dims: 2, runtime: 'test', modelRev: 'test' }));
      }
      // The second request reaches HTTP but never answers. The production
      // client's own deadline must survive its terminal wrapper and the
      // router's lexical recovery as a safe code, without retaining the query.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      expect(address).not.toBeNull();
      if (!address || typeof address === 'string') throw new Error('missing private HTTP port');
      const fallback = vi.fn(() => { throw new Error('unexpected fallback'); });
      const embed = buildSidecarFirstEmbedder({
        url: `http://127.0.0.1:${address.port}`, model: 'gemma', kind: 'query',
        timeoutMs: 1000, maxAttempts: 1, fallback, onTransition: () => {},
      });
      expect(await embed('healthy control')).toEqual([1, 0]);
      healthy = false;
      const sql = vi.fn(async () => []) as unknown as ReturnType<ConsultRouteDeps['getSql']>;
      const receipts: ExpertiseRoutingReceipt[] = [];
      const result = await routeConsult({ ...params, question: 'private HTTP timeout query' }, {
        getSql: () => sql, embed,
        embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
        embeddingMode: 'gemma', recordTelemetry: receipt => { receipts.push(receipt); },
      });
      expect(received).toBe(2);
      expect(fallback).not.toHaveBeenCalled();
      expect(result.verdict).toBe('relevance_unmeasured');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ outcome: 'degraded', errorCode: null,
        stages: { embedding: { outcome: 'threw', errorCode: 'ABORT_ERR' } } });
      expect(result.snapshot.measurement).toEqual(receipts[0]);
      expect(JSON.stringify(receipts)).not.toContain('private HTTP timeout query');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('bounds cyclic error causes without replacing the recovered routing result', async () => {
    const error = Object.assign(new Error('private cycle'), { cause: null as unknown });
    error.cause = error;
    const sql = vi.fn(async () => []) as unknown as ReturnType<ConsultRouteDeps['getSql']>;
    const result = await routeConsult(params, {
      getSql: () => sql, embed: async () => { throw error; },
      embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
      embeddingMode: 'gemma',
    });
    expect(result.verdict).toBe('relevance_unmeasured');
    expect(result.snapshot.measurement?.stages.embedding).toMatchObject({ errorCode: 'routing_exception' });
  });
});

describe('selectResponders — floor picks', () => {
  it('selects every qualified candidate best-first up to max, labeled via:floor', () => {
    const q = [cand('a', { score: 0.9 }), cand('b', { score: 0.8 }), cand('c', { score: 0.7 })];
    const s = selectResponders({ qualified: q, allCandidates: q, min: 1, max: 2 });
    expect(ids(s)).toEqual(['a', 'b']); // capped at max, order preserved
    expect(vias(s)).toEqual(['floor', 'floor']);
  });

  it('does not fill past min when qualified already satisfies it', () => {
    const q = [cand('a')];
    const all = [cand('a'), cand('fill')];
    const s = selectResponders({ qualified: q, allCandidates: all, min: 1, max: 3 });
    expect(ids(s)).toEqual(['a']); // fill is for reaching MIN, never max
  });
});

describe('selectResponders — minimum fill (D-001 §1 / D-002)', () => {
  it('requires supported source evidence before selecting a below-floor minimum', () => {
    const subject = 'code-cleanup-campaigns-2026-10-26';
    const mismatch = cand('unrelated', { subjectEvidenceCoverage: {
      status: 'mismatch', required: [subject],
      evidence: [{ subject, status: 'mismatch', score: 0.1 }], unresolved: [],
    } });
    const unmeasured = cand('unknown', { subjectEvidenceCoverage: {
      status: 'unmeasured', required: [subject],
      evidence: [{ subject, status: 'unmeasured', score: null }], unresolved: [],
    } });
    const strict = { qualified: [], allCandidates: [mismatch, unmeasured], min: 1, max: 3, requireSupportedSubjectEvidence: true };
    expect(selectResponders(strict)).toEqual([]);
    expect(ids(selectResponders({ ...strict, allCandidates: [mismatch], requireSupportedSubjectEvidence: false })))
      .toEqual(['unrelated']);
    const supported = cand('grounded', { subjectEvidenceCoverage: {
      status: 'supported', required: [subject],
      evidence: [{ subject, status: 'supported', score: 0.9 }], unresolved: [],
    } });
    expect(vias(selectResponders({ ...strict, allCandidates: [supported] }))).toEqual(['minimum']);
  });

  it('fills to min from allCandidates when the floors filtered everyone, labeled via:minimum', () => {
    const all = [cand('best', { score: 0.4 }), cand('next', { score: 0.3 })];
    const s = selectResponders({ qualified: [], allCandidates: all, min: 1, max: 3 });
    expect(ids(s)).toEqual(['best']);
    expect(vias(s)).toEqual(['minimum']);
  });

  it('mixes floor picks and fills, deduped by ownerId (qualified ⊆ allCandidates)', () => {
    const a = cand('a', { score: 0.9 });
    const all = [a, cand('b', { score: 0.45 }), cand('c', { score: 0.35 })];
    const s = selectResponders({ qualified: [a], allCandidates: all, min: 2, max: 3 });
    expect(ids(s)).toEqual(['a', 'b']); // 'a' not re-picked from the fill pool
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('min is clamped to max', () => {
    const all = [cand('a'), cand('b'), cand('c')];
    const s = selectResponders({ qualified: [], allCandidates: all, min: 5, max: 2 });
    expect(s).toHaveLength(2);
  });

  it('min 0 restores pure-floor selection: nothing qualified ⇒ empty', () => {
    const all = [cand('below', { score: 0.3 })];
    expect(selectResponders({ qualified: [], allCandidates: all, min: 0, max: 3 })).toEqual([]);
  });
});

describe('selectResponders — selectability gate (liveness, D-008 §5)', () => {
  const notDead = (c: RoutingCandidate) => c.liveness !== 'ended';

  it('skips unselectable candidates in BOTH legs', () => {
    const deadQ = cand('dead-q', { score: 0.9, liveness: 'ended' });
    const liveQ = cand('live-q', { score: 0.8 });
    const all = [deadQ, liveQ, cand('dead-fill', { score: 0.5, liveness: 'ended' }), cand('live-fill', { score: 0.4 })];
    const s = selectResponders({ qualified: [deadQ, liveQ], allCandidates: all, min: 2, max: 3, isSelectable: notDead });
    expect(ids(s)).toEqual(['live-q', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('skips owner-paused candidates in BOTH legs', () => {
    const pausedQ = cand('paused-q', { score: 0.9, ownerPaused: true });
    const liveQ = cand('live-q', { score: 0.8 });
    const pausedFill = cand('paused-fill', { score: 0.5, ownerPaused: true });
    const liveFill = cand('live-fill', { score: 0.4 });
    const s = selectResponders({
      qualified: [pausedQ, liveQ],
      allCandidates: [pausedQ, liveQ, pausedFill, liveFill],
      min: 2,
      max: 3,
      isSelectable: (c) => c.ownerPaused !== true,
    });
    expect(ids(s)).toEqual(['live-q', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('rejects unknown liveness from absent presence in BOTH legs', () => {
    const absentFloor = cand('absent-floor', { score: 0.9, liveness: 'unknown' });
    const liveFloor = cand('live-floor', { score: 0.8 });
    const absentFill = cand('absent-fill', { score: 0.5, liveness: 'unknown' });
    const liveFill = cand('live-fill', { score: 0.4 });
    const s = selectResponders({
      qualified: [absentFloor, liveFloor],
      allCandidates: [absentFloor, liveFloor, absentFill, liveFill],
      min: 2,
      max: 3,
      // Missing presence is normalized to `unknown`; only a reachable live or
      // parked session may receive the cascade wake.
      isSelectable: (c) => c.liveness === 'live' || c.liveness === 'parked',
    });
    expect(ids(s)).toEqual(['live-floor', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('a minimum only fillable by the unreachable stays UNFILLED (honest short set)', () => {
    const all = [cand('dead', { liveness: 'ended' })];
    expect(selectResponders({ qualified: [], allCandidates: all, min: 1, max: 3, isSelectable: notDead })).toEqual([]);
  });

  it('max 0 selects nobody regardless of min', () => {
    const all = [cand('a')];
    expect(selectResponders({ qualified: all, allCandidates: all, min: 1, max: 0 })).toEqual([]);
  });
});

describe('relevanceOf — stage 1 has no time term (D-001 §1)', () => {
  const signals = { similarity: 0.8, verification: 0.5, authorship: 0 };

  it('renormalizes by the weight total, so the floor keeps its meaning under any weights', () => {
    // The floor is calibrated against a [0,1] quantity. Without the
    // renormalization, dropping a signal's weight would silently lower every
    // candidate's score and quietly raise the effective bar.
    expect(relevanceOf(signals, { similarity: 0.55, verification: 0.15, authorship: 0.15 })).toBeCloseTo(
      (0.55 * 0.8 + 0.15 * 0.5) / 0.85,
      10,
    );
    // Same weights at double scale ⇒ identical relevance.
    expect(relevanceOf(signals, { similarity: 1.1, verification: 0.3, authorship: 0.3 })).toBeCloseTo(
      relevanceOf(signals, { similarity: 0.55, verification: 0.15, authorship: 0.15 }),
      10,
    );
  });

  it('all-zero weights yield 0 rather than NaN', () => {
    expect(relevanceOf(signals, { similarity: 0, verification: 0, authorship: 0 })).toBe(0);
  });
});

describe('freshnessOf — stage 2 is RELATIVE (D-001 §2)', () => {
  const DAY = 86_400_000;
  const H = 7;

  it('is shift-invariant: moving the whole set in time changes nothing', () => {
    const a = freshnessOf(1_000 * DAY, 1_010 * DAY, H);
    const b = freshnessOf(2_000 * DAY, 2_010 * DAY, H); // same gap, 1000 days later
    expect(b).toEqual(a);
    expect(a.relativeAgeDays).toBe(10);
  });

  it('the reference candidate is fully fresh, and a fresher-than-reference one cannot exceed it', () => {
    expect(freshnessOf(500 * DAY, 500 * DAY, H)).toEqual({ freshness: 1, relativeAgeDays: 0 });
    // An unqualified candidate may be newer than the freshest QUALIFIED one.
    expect(freshnessOf(505 * DAY, 500 * DAY, H)).toEqual({ freshness: 1, relativeAgeDays: 0 });
  });

  it('decays toward the base, never to zero', () => {
    const ancient = freshnessOf(0, 10_000 * DAY, H);
    expect(ancient.freshness).toBeGreaterThanOrEqual(FRESHNESS_BASE);
    expect(ancient.freshness).toBeCloseTo(FRESHNESS_BASE, 6);
  });

  it('undated inputs are honest rather than scored: no reference ⇒ no differentiation', () => {
    expect(freshnessOf(500 * DAY, null, H)).toEqual({ freshness: 1, relativeAgeDays: null });
    expect(freshnessOf(null, 500 * DAY, H)).toEqual({ freshness: FRESHNESS_BASE, relativeAgeDays: null });
  });

  it('a non-positive half-life degrades to a step, not to NaN/Infinity', () => {
    expect(freshnessOf(500 * DAY, 500 * DAY, 0)).toEqual({ freshness: 1, relativeAgeDays: 0 });
    expect(freshnessOf(499 * DAY, 500 * DAY, 0)).toEqual({ freshness: FRESHNESS_BASE, relativeAgeDays: 1 });
  });
});

describe('snapshotCandidateQualifies — reads a persisted snapshot on its OWN terms', () => {
  it('two-stage snapshot: the floor reads `relevance`, never the comparison score', () => {
    const snap = { relevanceFloor: 0.41, simFloor: 0.4 };
    // Stale but relevant: a low comparison score with an above-floor relevance
    // is EXACTLY the case D-001 exists for — it must label `floor`.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.6, score: 0.15, signals: { similarity: 0.7 } })).toBe(true);
    // …and the reverse must not be admitted by a generous score.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.2, score: 0.99, signals: { similarity: 0.7 } })).toBe(false);
    // The hard sim sub-floor still gates independently.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.9, score: 0.9, signals: { similarity: 0.1 } })).toBe(false);
  });

  it('pre-D-001 snapshot: `floor` + the blended `score` are applied as that record meant them', () => {
    // These rows are still in consult_state.routing until the last one expires.
    // Judging them by the new rule would relabel a responder's provenance.
    const legacy = { floor: 0.5, simFloor: 0.4 };
    expect(snapshotCandidateQualifies(legacy, { score: 0.62, signals: { similarity: 0.7 } })).toBe(true);
    expect(snapshotCandidateQualifies(legacy, { score: 0.31, signals: { similarity: 0.7 } })).toBe(false);
  });

  it('an unreadable floor admits NOBODY — a missing bar is unknown, not zero', () => {
    // Guessing here would promote a best-available fill to "qualified expert",
    // which is the one mislabel the whole D-002 provenance rule exists to stop.
    expect(snapshotCandidateQualifies({ simFloor: 0.4 }, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(false);
    expect(snapshotCandidateQualifies({ relevanceFloor: 0.41 }, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(
      false,
    );
    expect(snapshotCandidateQualifies(null, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(false);
    expect(snapshotCandidateQualifies({ relevanceFloor: 0.41, simFloor: 0.4 }, null)).toBe(false);
  });
});

describe('qualifyingScoreOf — the displayable number, across both snapshot generations', () => {
  it('prefers relevance, falls back to the pre-D-001 blended score, and never throws on a partial record', () => {
    expect(qualifyingScoreOf({ relevance: 0.62, score: 0.19 })).toBe(0.62);
    // A pre-D-001 selection entry has NO relevance at all. The wake copy renders
    // these straight out of consult_state.routing, so reaching for a missing
    // field here is a TypeError mid-wake, not a cosmetic gap.
    expect(qualifyingScoreOf({ score: 0.71 })).toBe(0.71);
    expect(qualifyingScoreOf({})).toBe(0);
    expect(qualifyingScoreOf(null)).toBe(0);
    // Non-finite is not a number worth printing.
    expect(qualifyingScoreOf({ relevance: Number.NaN, score: 0.5 })).toBe(0.5);
  });
});

describe('selectionSnapshot — persisted provenance (D-002)', () => {
  it('records min/max and each selection with via + score + similarity + liveness', () => {
    const a = cand('a', {
      score: 0.9,
      relevance: 0.95,
      signals: { similarity: 0.8, verification: 0.3, authorship: 0, freshness: 0.95 },
      evidence: [
        { session_id: 'session-a', turn_idx: 4, ts: '2026-09-23T00:00:00.000Z', sim: 0.8 },
      ],
    });
    const b = cand('b', {
      score: 0.4,
      relevance: 0.44,
      signals: { similarity: 0.3, verification: 0.3, authorship: 0, freshness: 0.91 },
      liveness: 'parked',
    });
    const snap = selectionSnapshot(2, 3, [
      { candidate: a, via: 'floor' },
      { candidate: b, via: 'minimum' },
    ]);
    // `relevance` rides along with `score` deliberately: `via` is derived from
    // the stage-1 number, so a provenance record holding only the stage-2 score
    // cannot be checked against the floors it claims to describe.
    expect(snap).toEqual({
      min: 2,
      max: 3,
      selected: [
        {
          ownerId: 'a', via: 'floor', score: 0.9, relevance: 0.95, similarity: 0.8, liveness: 'live',
          evidence: [{ session_id: 'session-a', turn_idx: 4, ts: '2026-09-23T00:00:00.000Z', sim: 0.8 }],
        },
        { ownerId: 'b', via: 'minimum', score: 0.4, relevance: 0.44, similarity: 0.3, liveness: 'parked' },
      ],
    });
  });
});
