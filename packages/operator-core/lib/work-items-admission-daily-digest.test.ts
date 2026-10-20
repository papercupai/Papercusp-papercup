import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  assessBulkStageYield,
  buildDailyDigestPrompt,
  dailyDigestWatchdogKey,
  parseDailyDigestProposals,
  runWorkItemAdmissionDailyDigest,
  encodeDailyDigestItems,
  MIN_DAILY_DIGEST_COVERAGE,
  DAILY_DIGEST_MAX_PROMPT_CHARS,
  DAILY_DIGEST_MAX_TITLE_CHARS,
  DAILY_DIGEST_MAX_SUMMARY_CHARS,
  DAILY_DIGEST_MAX_OUTPUT_TOKENS,
  DAILY_DIGEST_ANSWER_TOKENS,
  DAILY_DIGEST_ANSWER_TOKEN_SHARE,
  DAILY_DIGEST_TOKENS_PER_UMBRELLA,
  DAILY_DIGEST_TOKEN_OVERHEAD,
  DAILY_DIGEST_UMBRELLA_TITLE_CHARS,
  DAILY_DIGEST_UMBRELLA_BODY_CHARS,
  DAILY_DIGEST_UMBRELLA_REASON_CHARS,
  DAILY_DIGEST_MAX_MEMBERS_PER_UMBRELLA,
  DEFAULT_DAILY_DIGEST_MAX_TOKENS,
  MAX_DAILY_DIGEST_UMBRELLAS,
  MAX_UNKNOWN_MEMBER_RATIO,
  maxUmbrellasForOutputBudget,
  type DailyDigestContext,
  type DailyDigestItem,
} from './work-items-admission-daily-digest';
import { LEARNING_MODEL_SPEC } from './learning/model-policy';

/**
 * A bulk stage that actually judged what it set out to judge. Since D-035 this
 * is the only kind that may open the digest gate: `status:'complete'` alone was
 * satisfied by a stage that merged 0 pairs and left 1,500 of 1,770 unjudged, and
 * that vacuous stage authorised a 313k-token model call over undeduplicated
 * input. Tests below that exercise POST-gate behaviour use this so they are
 * testing what they claim to test rather than re-testing the gate.
 */
const YIELDING_STAGE_DETAIL = {
  resultCensusRunId: 'census-1',
  modelProtocol: {
    failures: 0,
    exhaustedBatches: 0,
    lastError: null,
    ignoredUnknownJudgements: 0,
    omittedExpectedJudgements: 0,
  },
};

const context: DailyDigestContext = {
  sourceBulkStageRunId: 'bulk-stage-1',
  sourceCensusRunId: 'census-1',
  censusAfter: 12,
  coverage: { live: 3, covered: 3, uncovered: 0, ratio: 1 },
  items: [
    {
      id: 'WI-1',
      title: 'Checkout command hangs',
      summary: 'The child exits while the checkout lock remains held.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
    {
      id: 'WI-2',
      title: 'Release queue stalls',
      summary: 'Promotion waits for the same orphaned checkout lock.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
    {
      id: 'WI-3',
      title: 'Sync misses deadline',
      summary: 'The worker cannot enter the checkout critical section.',
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: 0,
    },
  ],
  shards: [{ shardId: 0, members: ['WI-1', 'WI-2', 'WI-3'], ghosts: [] }],
};

describe('work-item admission daily digest', () => {
  it('builds an explicit full-corpus prompt with read-only shard context', () => {
    const prompt = buildDailyDigestPrompt(context);
    expect(prompt.system).toContain('DAILY FULL-CORPUS CLUSTER DIGEST');
    expect(prompt.system).toContain('Only IDs present in the CORPUS ITEMS section');
    expect(prompt.user).toContain('Checkout command hangs');
    expect(prompt.user).toContain('The child exits while the checkout lock remains held.');
    expect(prompt.user).toContain('census-1');
    expect(prompt.user).toContain('bulk-stage-1');
  });

  it('canonicalizes valid clusters and rejects unknown, overlapping, and undersized groups', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3', 'WI-4']);
    const proposal = {
      title: 'Orphaned checkout locks stall consumers',
      body: 'One dead child leaves a shared checkout lock held.',
      reason: 'Three independent consumers report the same lock boundary.',
      memberIds: ['WI-3', 'WI-1', 'WI-2'],
    };
    expect(parseDailyDigestProposals({ umbrellas: [proposal] }, allowed).proposals[0]?.memberIds).toEqual([
      'WI-1',
      'WI-2',
      'WI-3',
    ]);
    // D-034: a lone umbrella whose membership is 1/3 fabricated is over the
    // trust ceiling, so the reply is refused rather than repaired.
    expect(() => parseDailyDigestProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-2', 'WI-X'] }] }, allowed)).toThrow(
      'fabricated',
    );
    // Deduped to 2 real members, under the minimum: the umbrella is dropped, and
    // with nothing left the run still fails loudly rather than filing an empty digest.
    expect(() => parseDailyDigestProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-1', 'WI-2'] }] }, allowed)).toThrow(
      'none survived validation',
    );
  });

  it('keeps a contested member on the higher-ranked umbrella instead of failing the run (D-034)', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5', 'WI-6']);
    const base = {
      body: 'One dead child leaves a shared checkout lock held.',
      reason: 'Three independent consumers report the same lock boundary.',
    };
    const { proposals, clamps } = parseDailyDigestProposals(
      {
        umbrellas: [
          { ...base, title: 'First cause', memberIds: ['WI-1', 'WI-2', 'WI-3'] },
          { ...base, title: 'Second cause', memberIds: ['WI-3', 'WI-4', 'WI-5', 'WI-6'] },
        ],
      },
      allowed,
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.memberIds).toEqual(['WI-1', 'WI-2', 'WI-3']);
    // WI-3 stays with the first, higher-ranked umbrella and is dropped from the second.
    expect(proposals[1]?.memberIds).toEqual(['WI-4', 'WI-5', 'WI-6']);
    expect(clamps.duplicateMemberAssignmentsDropped).toBe(1);
  });

  it('drops a stray fabricated id but keeps the digest, and discloses it (D-034)', () => {
    const allowed = new Set(Array.from({ length: 30 }, (_, i) => `WI-${i}`));
    const umbrellas = Array.from({ length: 6 }, (_, i) => ({
      title: `Cause ${i}`,
      body: 'b',
      reason: 'r',
      memberIds: [`WI-${i * 5}`, `WI-${i * 5 + 1}`, `WI-${i * 5 + 2}`, `WI-${i * 5 + 3}`],
    }));
    // One invention among 24 proposed ids = 4.2%, under the 10% trust ceiling.
    umbrellas[2]!.memberIds = [...umbrellas[2]!.memberIds.slice(0, 3), 'EI-21462267124852221'];
    const { proposals, clamps } = parseDailyDigestProposals({ umbrellas }, allowed);
    expect(proposals).toHaveLength(6);
    expect(clamps.unknownMemberIdsDropped).toBe(1);
    expect(clamps.unknownMemberIdSample).toContain('EI-21462267124852221');
    expect(proposals[2]?.memberIds).not.toContain('EI-21462267124852221');
    expect(proposals[2]?.memberIds).toHaveLength(3);
  });

  /**
   * CONTROL — the threshold is what keeps D-034 a repair rather than a blindfold.
   * If someone removes it, a model fabricating membership wholesale would produce a
   * confident, entirely worthless digest. This pins that it still fails.
   */
  it('CONTROL: refuses a reply whose membership is fabricated past the trust ceiling (D-034)', () => {
    const allowed = new Set(Array.from({ length: 30 }, (_, i) => `WI-${i}`));
    const umbrellas = Array.from({ length: 6 }, (_, i) => ({
      title: `Cause ${i}`,
      body: 'b',
      reason: 'r',
      memberIds: [`WI-${i * 5}`, `WI-${i * 5 + 1}`, `FAKE-${i}a`, `FAKE-${i}b`],
    }));
    // 12 of 24 proposed ids invented = 50%, far past MAX_UNKNOWN_MEMBER_RATIO.
    expect(() => parseDailyDigestProposals({ umbrellas }, allowed)).toThrow('fabricated');
    expect(MAX_UNKNOWN_MEMBER_RATIO).toBeLessThan(0.5);
  });

  it('derives a stable normalized watchdog key', () => {
    expect(dailyDigestWatchdogKey('papercusp', 'Checkout lock leaked!')).toBe(
      dailyDigestWatchdogKey('papercusp', ' checkout  LOCK--leaked '),
    );
    expect(dailyDigestWatchdogKey('papercusp', 'Checkout lock leaked')).not.toBe(
      dailyDigestWatchdogKey('other', 'Checkout lock leaked'),
    );
  });

  it('D-035: blocks a COMPLETE but VACUOUS bulk stage instead of digesting undeduplicated input', async () => {
    // The historical failure, with stage wi882767-opus5-20260829-stage-1's real
    // numbers: it reached status:'complete' having merged 0 pairs, exhausted 10
    // of 12 batches and left 1,500 expected judgements unanswered — and that was
    // enough to open this gate and authorise a 313k-token model call over a
    // corpus the dedup pass had never actually touched.
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = [...strings].join(' ');
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) {
        return [
          {
            id: 'bulk-vacuous',
            detail: {
              status: 'complete',
              resultCensusRunId: 'census-1',
              modelProtocol: {
                failures: 46,
                exhaustedBatches: 10,
                omittedExpectedJudgements: 1500,
                lastError: 'expected object, received null',
              },
            },
          },
        ];
      }
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'daily-vacuous',
      now: () => Date.parse('2026-08-30T00:00:00Z'),
      sql,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      blockedReason: 'awaiting-yielding-bulk-stage',
      modelCalled: false,
    });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('D-035: a stage that judged everything it asked about still opens the gate', () => {
    // Calibration: without this the blocking assertions above would all pass on
    // a predicate that simply always returns false.
    expect(assessBulkStageYield(YIELDING_STAGE_DETAIL).yielded).toBe(true);
  });

  it('D-035: yield that cannot be PROVEN is treated as no yield', () => {
    // Pre-D-035 rows carry no modelProtocol at all. Inferring yield from silence
    // would rebuild the original defect one level down — a gate opening on
    // evidence it never checked — so absence must fail closed.
    expect(assessBulkStageYield({ resultCensusRunId: 'census-1' }).yielded).toBe(false);
    expect(assessBulkStageYield(null).yielded).toBe(false);
    expect(
      assessBulkStageYield({ modelProtocol: { exhaustedBatches: 'nope', omittedExpectedJudgements: 0 } }).yielded,
    ).toBe(false);
    // But an 'unknown' VERDICT is an answer, not a gap: only a judgement that
    // never came back counts against yield.
    expect(
      assessBulkStageYield({
        modelProtocol: { exhaustedBatches: 0, omittedExpectedJudgements: 0, ignoredUnknownJudgements: 12 },
      }).yielded,
    ).toBe(true);
  });

  it('records a blocked ledger row and never calls the model before a completed bulk stage', async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = [...strings].join(' ');
      statements.push(statement);
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) return [];
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'daily-blocked',
      now: () => Date.parse('2026-08-27T00:00:00Z'),
      sql,
      llmCall,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'awaiting-completed-bulk-stage', modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("run_kind = 'daily-digest'"))).toBe(true);
  });

  /**
   * The ledger's model_id previously wrote LEARNING_MODEL_SPEC unconditionally while the
   * llmCall used the same constant, so there was no way to run the digest on a reachable
   * model when the policy model's accounts were usage-walled — and no way for the ledger
   * to disagree with reality either. These two cases pin ONE resolved value to BOTH sites.
   */
  function digestHarness(opts: { model?: string }) {
    const bound: Array<Record<string, unknown>> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = [...strings].join(' ');
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) {
        return [{ id: 'bulk-1', detail: YIELDING_STAGE_DETAIL }];
      }
      if (statement.includes("run_kind = 'census'")) return [{ id: 'census-1', census_after: 3 }];
      if (statement.includes('FROM harness_shared.work_items')) {
        return context.items.map((item) => ({
          id: item.id, title: item.title, summary: item.summary,
          state: item.state, kind: item.kind, admission: item.admission,
        }));
      }
      if (statement.includes('dedup_shard_map')) {
        return context.items.map((item) => ({ shard_id: 0, item_id: item.id, role: 'member' }));
      }
      if (statement.includes('UPDATE harness_shared.admission_runs') && statement.includes('model_id =')) {
        bound.push({ statement, values });
      }
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn(async () => ({
      json: { umbrellas: [{ title: 'Orphaned checkout lock', body: 'One lock, three symptoms.', reason: 'shared mechanism', memberIds: ['WI-1', 'WI-2', 'WI-3'] }] },
      text: '', tokensIn: 11, tokensOut: 22,
    })) as unknown as Parameters<typeof runWorkItemAdmissionDailyDigest>[0]['llmCall'];
    return { sql, llmCall, bound };
  }

  it('defaults the model to the learning policy spec and records THAT id on the ledger', async () => {
    const { sql, llmCall, bound } = digestHarness({});
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId: 'daily-default',
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql, llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });
    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    const called = (llmCall as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { model: string };
    expect(called.model).toBe(LEARNING_MODEL_SPEC);
    // the SAME value must reach the ledger, not a re-read of the policy constant
    expect(bound.at(-1)?.values).toContain(LEARNING_MODEL_SPEC);
  });

  it('threads an explicit model override to BOTH the model call and the ledger model_id', async () => {
    const override = 'claude-opus-5:xhigh';
    const { sql, llmCall, bound } = digestHarness({});
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId: 'daily-override', model: override,
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql, llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });
    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    const called = (llmCall as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { model: string };
    expect(called.model).toBe(override);
    expect(bound.at(-1)?.values).toContain(override);
    // the regression this pins: the ledger must NOT name the policy model the run never used
    expect(bound.at(-1)?.values).not.toContain(LEARNING_MODEL_SPEC);
  });

  it('retries transient model transport failures with bounded backoff', async () => {
    const harness = digestHarness({});
    const llmCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNRESET 10.0.0.1:443'))
      .mockResolvedValueOnce({
        json: { umbrellas: [] },
        text: '',
        inputTokens: 11,
        outputTokens: 22,
      });
    const delay = vi.fn(async () => undefined);
    const result = await runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'daily-transient-retry',
      now: () => Date.parse('2026-08-29T00:00:00Z'),
      sql: harness.sql,
      llmCall: llmCall as unknown as Parameters<typeof runWorkItemAdmissionDailyDigest>[0]['llmCall'],
      retryBackoffsMs: [1],
      retryDelay: delay,
      fileUmbrella: vi.fn(),
      linkUmbrella: vi.fn(),
    });
    expect(result).toMatchObject({ status: 'complete', modelCalled: true, tokensIn: 11, tokensOut: 22 });
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1);
  });

  /**
   * D-028. The census shard map can never cover the live corpus EXACTLY on a live
   * workspace: a census takes ~510s while items arrive at ~8/min, so it is ~67 items
   * stale before it finishes. The old gate demanded exact coverage and therefore never
   * let a digest run at all — while already tolerating the opposite drift direction
   * (map entries whose item has left the corpus) one line above. These cases pin the
   * corrected asymmetry: arrivals are EXCLUDED and DISCLOSED above a floor, and the
   * invariants that actually protect the digest still hard-block.
   */
  function coverageHarness(opts: {
    corpusIds: string[];
    memberIds: string[];
    duplicateId?: string;
    dailyDigestUmbrellaIds?: string[];
  }) {
    const bound: Array<{ statement: string; values: unknown[] }> = [];
    const prompts: string[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = [...strings].join(' ');
      if (statement.includes('SELECT detail, tokens_in')) return [];
      if (statement.includes("run_kind = 'bulk-stage'")) return [{ id: 'bulk-1', detail: YIELDING_STAGE_DETAIL }];
      if (statement.includes("run_kind = 'census'")) return [{ id: 'census-1', census_after: 3 }];
      if (statement.includes('FROM harness_shared.work_items')) {
        const excludesPriorDigestUmbrellas = statement.includes("wi.payload -> 'dailyDigest' IS NULL");
        const corpusIds = opts.corpusIds.filter((id) =>
          !excludesPriorDigestUmbrellas || !opts.dailyDigestUmbrellaIds?.includes(id),
        );
        return corpusIds.map((id) => ({
          id, title: `title ${id}`, summary: `summary ${id}`, state: 'open', kind: 'bug', admission: 'admitted',
        }));
      }
      if (statement.includes('dedup_shard_map')) {
        const rows = opts.memberIds.map((id) => ({ shard_id: 0, item_id: id, role: 'member' }));
        if (opts.duplicateId) rows.push({ shard_id: 1, item_id: opts.duplicateId, role: 'member' });
        return rows;
      }
      if (statement.includes('UPDATE harness_shared.admission_runs')) bound.push({ statement, values });
      return [];
    }) as unknown as import('./work-items').OrgSql;
    const llmCall = vi.fn(async (call: { messages: Array<{ content: string }> }) => {
      prompts.push(call.messages.map((message) => message.content).join('\n'));
      return { json: { umbrellas: [] }, text: '', tokensIn: 5, tokensOut: 7 };
    }) as unknown as Parameters<typeof runWorkItemAdmissionDailyDigest>[0]['llmCall'];
    const detail = () => {
      const payload = bound.at(-1)?.values.find((value) => typeof value === 'string' && value.startsWith('{'));
      return JSON.parse(String(payload)) as Record<string, unknown>;
    };
    return { sql, llmCall, bound, prompts, detail };
  }

  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, index) => `WI-${index + from}`);

  const runCoverage = async (harness: ReturnType<typeof coverageHarness>, runId: string) =>
    runWorkItemAdmissionDailyDigest({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId,
      now: () => Date.parse('2026-08-29T00:00:00Z'), sql: harness.sql, llmCall: harness.llmCall,
      fileUmbrella: vi.fn(async () => ({ id: 'WI-U1', created: true })), linkUmbrella: vi.fn(async () => 3),
    });

  it('D-028: digests the covered subset when items arrived after the census, and discloses the gap', async () => {
    // 10 live, 9 in the map: WI-10 arrived after the census. 0.9 clears the floor.
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(9) });
    const result = await runCoverage(harness, 'daily-drift');

    expect(result).toMatchObject({ status: 'complete', modelCalled: true });
    expect(result.coverage).toEqual({ live: 10, covered: 9, uncovered: 1, ratio: 0.9 });
    // the arrival is EXCLUDED from what the model reasons over, not silently shardless
    expect(result.corpusSize).toBe(9);
    expect(harness.prompts[0]).toContain('WI-9');
    expect(harness.prompts[0]).not.toContain('WI-10');
    // and the drift is on the ledger row: disclosed partial coverage, never silent
    expect(harness.detail().coverage).toEqual({ live: 10, covered: 9, uncovered: 1, ratio: 0.9 });
    expect(harness.detail().outcome).toMatchObject({
      unit: 'links',
      attempted: 0,
      successful: 0,
      rolledBack: 0,
      unchanged: 0,
      uniqueRowsChanged: 0,
    });
  });

  it('D-028: still blocks below the coverage floor rather than digest a misleading sample', async () => {
    const covered = Math.floor(10 * MIN_DAILY_DIGEST_COVERAGE) - 1; // strictly under the floor
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(covered) });
    const result = await runCoverage(harness, 'daily-under-floor');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'census-coverage-mismatch', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
    // a blocked run still reports what it measured, so the block is diagnosable
    expect(result.coverage).toMatchObject({ live: 10, covered, uncovered: 10 - covered });
    expect(harness.detail().coverage).toMatchObject({ live: 10, covered });
    expect(harness.detail().outcome).toMatchObject({
      unit: 'links',
      attempted: 0,
      successful: 0,
      blockedReason: 'census-coverage-mismatch',
    });
  });

  it('D-028: duplicate member rows still hard-block — coverage tolerance never weakens the one-shard invariant', async () => {
    const harness = coverageHarness({ corpusIds: ids(10), memberIds: ids(10), duplicateId: 'WI-3' });
    const result = await runCoverage(harness, 'daily-duplicate');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'census-coverage-mismatch', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
  });

  it('does not feed prior daily-digest umbrellas back into the next source corpus', async () => {
    const harness = coverageHarness({
      corpusIds: ids(4),
      memberIds: ids(4),
      dailyDigestUmbrellaIds: ['WI-4'],
    });
    const result = await runCoverage(harness, 'daily-exclude-prior-umbrella');

    expect(result).toMatchObject({
      status: 'complete',
      corpusSize: 3,
      coverage: { live: 3, covered: 3, uncovered: 0, ratio: 1 },
    });
    expect(harness.prompts[0]).toContain('WI-3');
    expect(harness.prompts[0]).not.toContain('WI-4');
  });

  /**
   * D-029. The prompt used to stringify every item's full `summary` as pretty-printed
   * JSON. On the live corpus that produced a 3,220,412-token request against a 1,000,000
   * ceiling — a hard 400. Bounded excerpts now preserve source evidence without returning
   * to the unbounded payload; these cases pin excerpting and the prompt budget.
   */
  describe('D-029 prompt budget', () => {
    const bigItem = (index: number): DailyDigestItem => ({
      id: `WI-${index}`,
      // realistic live measurements: mean title ~110 chars, mean summary ~1,212 chars
      title: `item ${index} ${'t'.repeat(100)}`,
      summary: 's'.repeat(1_212),
      state: 'open',
      kind: 'bug',
      admission: 'admitted',
      shardId: index % 40,
    });

    it('sends a bounded summary excerpt so the model can distinguish unrelated shard members', () => {
      const summary = `UNIQUE_SUMMARY_SENTINEL ${'x'.repeat(300)} SUMMARY_TAIL_SENTINEL`;
      const prompt = buildDailyDigestPrompt({
        ...context,
        items: [{ ...context.items[0], summary }, ...context.items.slice(1)],
      });
      expect(prompt.user).toContain('Checkout command hangs');
      expect(prompt.user).toContain('UNIQUE_SUMMARY_SENTINEL');
      expect(prompt.user).not.toContain('SUMMARY_TAIL_SENTINEL');
      expect(prompt.system).toContain('A shared word, a shard assignment');
    });

    it('stays inside the budget at the real corpus scale that produced the 400', () => {
      const items = Array.from({ length: 5_471 }, (_, index) => bigItem(index));
      const prompt = buildDailyDigestPrompt({ ...context, items });

      expect(prompt.user.length).toBeLessThanOrEqual(DAILY_DIGEST_MAX_PROMPT_CHARS);
      expect(prompt.includedItems).toBe(5_471);
      expect(prompt.omittedItems).toBe(0);
      // CONTROL: the pre-fix shape (full summaries, pretty-printed) on this same corpus is
      // multiples of the budget — so the assertion above is a real constraint, not a
      // vacuous one that any encoding would satisfy
      expect(JSON.stringify(items, null, 2).length).toBeGreaterThan(DAILY_DIGEST_MAX_PROMPT_CHARS * 4);
    });

    it('trims to the budget and DISCLOSES what it left out rather than silently truncating', () => {
      const items = Array.from({ length: 50 }, (_, index) => bigItem(index));
      const encoded = encodeDailyDigestItems(items, 400);

      expect(encoded.included).toBeGreaterThan(0);
      expect(encoded.included).toBeLessThan(50);
      expect(encoded.included + encoded.omitted).toBe(50);
      expect(encoded.lines.join('\n').length).toBeLessThanOrEqual(400);

      // and the omission reaches the prompt as a visible note, not a silent gap
      const prompt = buildDailyDigestPrompt({ ...context, items });
      expect(prompt.omittedItems).toBe(0); // full budget fits 50 items
      const tiny = encodeDailyDigestItems(items, 200);
      expect(tiny.omitted).toBeGreaterThan(0);
    });

    it('keeps one item on exactly one line when title or summary contains newlines or tabs', () => {
      // The encoding is line- and tab-delimited, so unsanitized text would silently
      // corrupt the corpus the model parses — inventing ids that were never in the queue.
      const encoded = encodeDailyDigestItems([
        {
          ...bigItem(1),
          title: 'first line\nsecond\tline\r\nthird',
          summary: 'first summary\nsecond\tsummary\r\nthird',
        },
      ]);
      expect(encoded.lines).toHaveLength(1);
      expect(encoded.lines[0].split('\t')).toHaveLength(7);
      expect(encoded.lines[0]).not.toMatch(/[\n\r]/);
    });

    it('caps one pathological title so it cannot consume the whole budget', () => {
      const encoded = encodeDailyDigestItems([{ ...bigItem(1), title: 'x'.repeat(50_000) }]);
      const titleCell = encoded.lines[0].split('\t')[5];
      expect(titleCell.length).toBeLessThanOrEqual(DAILY_DIGEST_MAX_TITLE_CHARS);
    });

    it('caps a pathological summary excerpt independently of the title', () => {
      const encoded = encodeDailyDigestItems([{ ...bigItem(1), summary: 'y'.repeat(50_000) }]);
      const summaryCell = encoded.lines[0].split('\t')[6];
      expect(summaryCell.length).toBeLessThanOrEqual(DAILY_DIGEST_MAX_SUMMARY_CHARS);
      expect(summaryCell.endsWith('…')).toBe(true);
    });
  });

  it('D-028: an empty corpus still blocks as empty-corpus, never as a coverage mismatch', async () => {
    const harness = coverageHarness({ corpusIds: [], memberIds: [] });
    const result = await runCoverage(harness, 'daily-empty');

    expect(result).toMatchObject({ status: 'blocked', blockedReason: 'empty-corpus', modelCalled: false });
    expect(harness.prompts).toHaveLength(0);
  });
});

describe('daily digest output budget (D-031)', () => {
  // Chars-per-token for JSON of this shape. Deliberately CONSERVATIVE (real JSON
  // with punctuation and ids runs richer than 4 chars/token), so the invariant
  // errs toward refusing a budget that would actually have fit.
  const CHARS_PER_TOKEN = 4;

  /** Worst-case tokens for ONE umbrella at every schema maximum simultaneously. */
  const worstCaseUmbrellaTokens = (): number => {
    const chars =
      DAILY_DIGEST_UMBRELLA_TITLE_CHARS +
      DAILY_DIGEST_UMBRELLA_BODY_CHARS +
      DAILY_DIGEST_UMBRELLA_REASON_CHARS +
      DAILY_DIGEST_MAX_MEMBERS_PER_UMBRELLA * 24 + // a quoted id plus separator
      120; // per-object JSON keys/punctuation
    return Math.ceil(chars / CHARS_PER_TOKEN);
  };

  it('sizes one umbrella within the per-umbrella rate the cap is derived from', () => {
    expect(worstCaseUmbrellaTokens()).toBeLessThanOrEqual(DAILY_DIGEST_TOKENS_PER_UMBRELLA);
  });

  // THE INVARIANT. A full answer at the schema's own maxima must fit the budget
  // that has to carry it. Per D-031 an over-budget answer is not truncated-but-
  // usable on this path: the text is lost entirely, so "it will just get cut off"
  // is not an available fallback.
  it('a MAXIMAL answer fits the ANSWER budget, not merely the raw ceiling', () => {
    const worst = DAILY_DIGEST_TOKEN_OVERHEAD + MAX_DAILY_DIGEST_UMBRELLAS * worstCaseUmbrellaTokens();
    // Against DAILY_DIGEST_ANSWER_TOKENS, NOT DAILY_DIGEST_MAX_OUTPUT_TOKENS: only
    // ~20% of the ceiling arrives as answer text (D-032), so fitting the raw ceiling
    // still over-commits by 5x. That was the first fix's mistake.
    expect(worst).toBeLessThanOrEqual(DAILY_DIGEST_ANSWER_TOKENS);
    expect(DAILY_DIGEST_ANSWER_TOKENS).toBeLessThan(DAILY_DIGEST_MAX_OUTPUT_TOKENS);
  });

  // CONTROL for the correction itself: budgeting against the RAW ceiling would admit
  // ~5x more umbrellas than the answer budget can carry. If this stops holding, the
  // answer-share derivation has quietly become a no-op.
  it('control: deriving from the raw ceiling would over-commit by roughly 5x', () => {
    const fromRawCeiling = Math.floor(
      (DAILY_DIGEST_MAX_OUTPUT_TOKENS - DAILY_DIGEST_TOKEN_OVERHEAD) / DAILY_DIGEST_TOKENS_PER_UMBRELLA,
    );
    expect(fromRawCeiling).toBeGreaterThan(MAX_DAILY_DIGEST_UMBRELLAS * 4);
    expect(DAILY_DIGEST_TOKEN_OVERHEAD + fromRawCeiling * worstCaseUmbrellaTokens()).toBeGreaterThan(
      DAILY_DIGEST_ANSWER_TOKENS,
    );
  });

  it('derives the umbrella cap from the budget, and never drops below one', () => {
    expect(MAX_DAILY_DIGEST_UMBRELLAS).toBe(maxUmbrellasForOutputBudget());
    expect(DEFAULT_DAILY_DIGEST_MAX_TOKENS).toBe(DAILY_DIGEST_MAX_OUTPUT_TOKENS);
    const budgetForFive =
      (DAILY_DIGEST_TOKEN_OVERHEAD + 5 * DAILY_DIGEST_TOKENS_PER_UMBRELLA) / DAILY_DIGEST_ANSWER_TOKEN_SHARE;
    expect(maxUmbrellasForOutputBudget(budgetForFive)).toBe(5);
    expect(maxUmbrellasForOutputBudget(1)).toBe(1); // never zero or negative
  });

  // CONTROL — the pre-fix configuration, kept permanently so the invariant above
  // is provably not vacuous: 100 umbrellas x a 12,000-char body against a 20,000
  // token budget. If this ever starts fitting, the invariant is measuring nothing.
  it('control: the pre-fix configuration does NOT fit, which is why the digest returned empty', () => {
    const preFixUmbrellaTokens = Math.ceil((240 + 12_000 + 2_000 + 500 * 24 + 120) / CHARS_PER_TOKEN);
    const preFixWorst = 500 + 100 * preFixUmbrellaTokens;
    expect(preFixWorst).toBeGreaterThan(20_000);
  });

  it('TELLS the model the limits it must respect, not just the schema', () => {
    const { system } = buildDailyDigestPrompt(context);
    expect(system).toContain(`AT MOST ${MAX_DAILY_DIGEST_UMBRELLAS} umbrellas`);
    expect(system).toContain(`body <= ${DAILY_DIGEST_UMBRELLA_BODY_CHARS}`);
    expect(system).toContain(`memberIds <= ${DAILY_DIGEST_MAX_MEMBERS_PER_UMBRELLA}`);
  });

  it('clamps an answer that exceeds the derived umbrella cap instead of discarding the run (D-033)', () => {
    const tooMany = {
      umbrellas: Array.from({ length: MAX_DAILY_DIGEST_UMBRELLAS + 3 }, (_, i) => ({
        title: `t${i}`,
        body: 'b',
        reason: 'r',
        memberIds: [`WI-${i}a`, `WI-${i}b`, `WI-${i}c`],
      })),
    };
    const allowed = new Set(tooMany.umbrellas.flatMap((u) => u.memberIds));
    const { proposals, clamps } = parseDailyDigestProposals(tooMany, allowed);
    expect(proposals).toHaveLength(MAX_DAILY_DIGEST_UMBRELLAS);
    expect(clamps.umbrellasReturned).toBe(MAX_DAILY_DIGEST_UMBRELLAS + 3);
    expect(clamps.umbrellasDropped).toBe(3);
    // Ranked most-significant-first, so the TAIL is what gets dropped.
    expect(proposals[0]?.title).toBe('t0');
  });

  it('clamps over-long fields rather than rejecting the whole digest, and reports the overage (D-033)', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3']);
    // Derive the expected overage from the ACTUAL fixture: the clamp measures the
    // TRIMMED string, and 'word '.repeat(n) ends in a space, so a nominal constant
    // here is off by one against the value the code really sees.
    const longBody = 'word '.repeat(Math.ceil((DAILY_DIGEST_UMBRELLA_BODY_CHARS + 250) / 5)).trim();
    const expectedBodyOverage = longBody.length - DAILY_DIGEST_UMBRELLA_BODY_CHARS;
    const { proposals, clamps } = parseDailyDigestProposals(
      {
        umbrellas: [
          {
            title: 'x'.repeat(DAILY_DIGEST_UMBRELLA_TITLE_CHARS + 10),
            body: longBody,
            reason: 'y'.repeat(DAILY_DIGEST_UMBRELLA_REASON_CHARS + 30),
            memberIds: ['WI-1', 'WI-2', 'WI-3'],
          },
        ],
      },
      allowed,
    );
    expect(proposals).toHaveLength(1);
    const u = proposals[0]!;
    expect(u.title.length).toBeLessThanOrEqual(DAILY_DIGEST_UMBRELLA_TITLE_CHARS);
    expect(u.body.length).toBeLessThanOrEqual(DAILY_DIGEST_UMBRELLA_BODY_CHARS);
    expect(u.reason.length).toBeLessThanOrEqual(DAILY_DIGEST_UMBRELLA_REASON_CHARS);
    expect(clamps.titlesClamped).toBe(1);
    expect(clamps.bodiesClamped).toBe(1);
    expect(clamps.reasonsClamped).toBe(1);
    // The overage is what a future tuning pass re-derives the ceilings from, so it
    // must be the REAL distance past the ceiling, not merely a nonzero flag.
    expect(clamps.maxOverageChars.body).toBe(expectedBodyOverage);
    expect(clamps.maxOverageChars.reason).toBe(30);
    expect(clamps.maxOverageChars.title).toBe(10);
    // A word-boundary clamp must not hard-cut mid-word when a boundary is near.
    expect(u.body.endsWith('…')).toBe(true);
    expect(u.body).not.toMatch(/wor…$/);
  });

  it('leaves a compliant answer completely untouched and reports zero clamps (D-033)', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3']);
    const body = 'A real umbrella body well inside its ceiling.';
    const { proposals, clamps } = parseDailyDigestProposals(
      { umbrellas: [{ title: 'Compliant', body, reason: 'Because.', memberIds: ['WI-1', 'WI-2', 'WI-3'] }] },
      allowed,
    );
    expect(proposals[0]?.body).toBe(body);
    expect(clamps.bodiesClamped).toBe(0);
    expect(clamps.umbrellasDropped).toBe(0);
    expect(clamps.maxOverageChars.body).toBe(0);
  });

  /**
   * CONTROL — pins the D-033 regression, not merely the D-033 behaviour.
   *
   * This is the SHAPE that run wi882767-digest-d032-2 actually returned: a complete,
   * well-formed, untruncated digest whose bodies ran past the ceiling. Under the
   * pre-D-033 strict schema the entire ~5-minute run was discarded. If anyone
   * reverts the clamp to a bare `.max()` reject, this fails.
   */
  it('CONTROL: the real d032-2 shape is rejected outright by a bare strict schema', () => {
    const umbrellas = Array.from({ length: 14 }, (_, i) => ({
      title: `Umbrella ${i}`,
      body: 'z'.repeat(DAILY_DIGEST_UMBRELLA_BODY_CHARS + 120),
      reason: 'r',
      memberIds: [`WI-${i}a`, `WI-${i}b`, `WI-${i}c`],
    }));
    const strict = z.object({
      umbrellas: z.array(
        z.object({
          title: z.string().max(DAILY_DIGEST_UMBRELLA_TITLE_CHARS),
          body: z.string().max(DAILY_DIGEST_UMBRELLA_BODY_CHARS),
          reason: z.string().max(DAILY_DIGEST_UMBRELLA_REASON_CHARS),
          memberIds: z.array(z.string()),
        }),
      ),
    });
    expect(() => strict.parse({ umbrellas })).toThrow();

    // The same payload now survives, trimmed and disclosed.
    const { proposals, clamps } = parseDailyDigestProposals(
      { umbrellas },
      new Set(umbrellas.flatMap((u) => u.memberIds)),
    );
    expect(proposals).toHaveLength(14);
    expect(clamps.bodiesClamped).toBe(14);
    expect(clamps.maxOverageChars.body).toBe(120);
  });
});
