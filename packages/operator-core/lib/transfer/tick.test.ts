/**
 * tick.test.ts — the whole nightly flow with fake ports (P-022 / FB-08):
 * distill → free probationary admission (PG row + memory entry with tier
 * metadata) → student-transfer tests → promote / demote / retire mirrored
 * onto memory. Zero LLM/PG.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryBackend, MemoryEntry, RememberOptions, UpdatePatch } from '@papercusp/memory';
import type { GovernedSpendAttemptOutcome, SpendAttemptReport } from '../learning-governor/registrants';
import type { SpendAttemptKind } from '../learning-governor/spend';
import { MEMORY_TIER_KEY } from '../memory/two-tier';
import type { ReplayTranscript } from '../replay/types';
import { DEFAULT_TRANSFER_TICK, type TransferTickOptions } from './gate';
import { lessonSignature } from './distill';
import type { AdmitLessonInput, AdmitLessonResult } from './store';
import { runTransferTick, type TransferStorePort, type TransferTickDeps } from './tick';
import { transferReplayPort } from './replay-adapter';
import { runReplayBattery } from '../replay/battery';
import type { TransferLesson, TransferTestOutcome } from './types';

/* ── fakes ──────────────────────────────────────────────────────────────── */

function fakeLessonRow(input: AdmitLessonInput, id: string): TransferLesson {
  return {
    workspaceId: input.workspaceId,
    id,
    signature: input.signature,
    title: input.title ?? null,
    lessonText: input.lessonText,
    sourceKind: input.sourceKind ?? 'transcript',
    sourceRef: input.sourceRef ?? null,
    tier: 'probationary',
    status: 'candidate',
    testCount: 0,
    passCount: 0,
    failCount: 0,
    lastTestedAt: null,
    lastBatteryId: null,
    lastDelta: null,
    memoryId: null,
    packCandidateId: null,
    signalOrigin: 'replay',
    potSlug: input.potSlug ?? null,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
}

class FakeStore implements TransferStorePort {
  rows = new Map<string, TransferLesson>();
  errorsMarked: string[] = [];
  outcomes: Array<{ id: string; tier: string; status: string; delta: number; batteryId: string }> = [];
  private seq = 0;

  async admit(input: AdmitLessonInput): Promise<AdmitLessonResult> {
    for (const row of this.rows.values()) {
      if (row.signature === input.signature) {
        return { admitted: false, reason: 'duplicate-signature', lesson: row };
      }
    }
    const row = fakeLessonRow(input, `L${++this.seq}`);
    this.rows.set(row.id, row);
    return { admitted: true, lesson: row };
  }

  async listForTesting(q: { workspaceId: string; limit: number }): Promise<TransferLesson[]> {
    return [...this.rows.values()]
      .filter((r) => r.tier === 'probationary' || r.tier === 'validated')
      .sort((a, b) => Number(b.tier === 'probationary') - Number(a.tier === 'probationary'))
      .slice(0, q.limit);
  }

  async recordOutcome(q: {
    id: string;
    transition: { tier: TransferLesson['tier']; status: TransferLesson['status']; passCount: number; failCount: number };
    batteryId: string;
    delta: number;
  }): Promise<TransferLesson> {
    const row = this.rows.get(q.id)!;
    Object.assign(row, {
      tier: q.transition.tier,
      status: q.transition.status,
      passCount: q.transition.passCount,
      failCount: q.transition.failCount,
      testCount: row.testCount + 1,
      lastBatteryId: q.batteryId,
      lastDelta: q.delta,
    });
    this.outcomes.push({ id: q.id, tier: q.transition.tier, status: q.transition.status, delta: q.delta, batteryId: q.batteryId });
    return { ...row };
  }

  async markError(q: { id: string }): Promise<void> {
    this.errorsMarked.push(q.id);
    const row = this.rows.get(q.id);
    if (row) row.status = 'error';
  }

  async setMemoryId(q: { id: string; memoryId: string | null }): Promise<void> {
    const row = this.rows.get(q.id);
    if (row) row.memoryId = q.memoryId;
  }
}

class FakeMemory implements MemoryBackend {
  readonly name = 'fake';
  entries = new Map<string, MemoryEntry>();
  forgotten: string[] = [];
  private seq = 0;

  async available() {
    return { ok: true as const };
  }
  async remember(text: string, opts: RememberOptions) {
    const id = `M${++this.seq}`;
    this.entries.set(id, { id, text, scope: opts.scope, kind: opts.kind ?? 'project', metadata: opts.metadata ?? {} });
    return { ids: [id], storedEvents: 1 };
  }
  async search() {
    return [];
  }
  async list() {
    return [...this.entries.values()];
  }
  async get(id: string) {
    return this.entries.get(id) ?? null;
  }
  async forget(id: string) {
    this.entries.delete(id);
    this.forgotten.push(id);
  }
  async update(id: string, patch: UpdatePatch) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`no entry ${id}`);
    if (patch.text) entry.text = patch.text;
    if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
  }
}

function transcriptOf(ref: string): ReplayTranscript {
  return {
    ref,
    turns: [
      { index: 0, role: 'user', text: 'do the task' },
      { index: 1, role: 'assistant', text: 'working' },
      { index: 2, role: 'tool_use', text: '{}', toolName: 'Bash' },
      { index: 3, role: 'assistant', text: 'done' },
    ],
  };
}

interface Harness {
  deps: TransferTickDeps;
  store: FakeStore;
  memory: FakeMemory;
  spends: Array<{ costUsd: number; note: string; disposition: string }>;
}

/**
 * A thin stand-in for the governor's attempt seam: it grants what is asked and
 * records how each attempt CLOSED. Deliberately thin — the settle-on-every-path
 * guarantee is the governor's own invariant and is tested against the real
 * `runGovernedSpendAttempt` in learning-governor/registrants.test.ts; here we
 * only care that the tick opens an attempt and reports the right disposition.
 */
function fakeSpendAttempt(
  spends: Array<{ costUsd: number; note: string; disposition: string }>,
): TransferTickDeps['spendAttempt'] {
  return async <T>(q: {
    attemptKind: SpendAttemptKind;
    requestedUsd: number;
    note: string;
    runRef?: string;
    run: (grant: { reservedUsd: number; clamped: boolean }) => Promise<SpendAttemptReport<T>>;
  }): Promise<GovernedSpendAttemptOutcome<T>> => {
    try {
      const report = await q.run({ reservedUsd: q.requestedUsd, clamped: false });
      const disposition = report.cancelled ? 'cancelled' : 'used';
      spends.push({ costUsd: report.costUsd, note: q.note, disposition });
      return {
        ok: true,
        value: report.value,
        costUsd: report.costUsd,
        reservationId: 'res-fake',
        clamped: false,
        cancelled: report.cancelled === true,
        settlement: null,
      };
    } catch (e) {
      const burned = (e as { costUsd?: unknown }).costUsd;
      const costUsd = typeof burned === 'number' && burned > 0 ? burned : 0;
      spends.push({ costUsd, note: q.note, disposition: 'failed' });
      return {
        ok: false,
        reason: 'failed',
        error: e instanceof Error ? e.message : String(e),
        costUsd,
        reservationId: 'res-fake',
        settlement: null,
      };
    }
  };
}

function makeHarness(overrides: Partial<TransferTickDeps> = {}): Harness {
  const store = new FakeStore();
  const memory = new FakeMemory();
  const spends: Array<{ costUsd: number; note: string; disposition: string }> = [];
  const deps: TransferTickDeps = {
    store,
    spendAttempt: fakeSpendAttempt(spends),
    lister: async () => ['/logs/a.jsonl'],
    source: { load: async (ref) => transcriptOf(ref) },
    llm: async () => ({ text: '[{"title":"T","lesson":"Run tests before claiming done."}]', costUsd: 0.01 }),
    replay: null,
    memory,
    log: () => {},
    ...overrides,
  };
  return { deps, store, memory, spends };
}

const OPTS: TransferTickOptions = { ...DEFAULT_TRANSFER_TICK, memoryScope: 'harness:test' };

/* ── distillation leg ───────────────────────────────────────────────────── */

describe('runTransferTick — distillation leg', () => {
  it('admits distilled lessons probationary: PG row + memory entry with tier metadata + origin=replay', async () => {
    const { deps, store, memory, spends } = makeHarness();
    const result = await runTransferTick('ws', deps, OPTS);

    expect(result).toMatchObject({
      transcriptsScanned: 1,
      lessonsDistilled: 1,
      lessonsAdmitted: 1,
      tested: 0,
      testingSkippedNoReplay: true,
      errors: 0,
    });
    const lesson = [...store.rows.values()][0];
    expect(lesson.tier).toBe('probationary');
    expect(lesson.memoryId).toBe('M1');

    const entry = memory.entries.get('M1')!;
    expect(entry.scope).toBe('harness:test');
    expect(entry.metadata).toMatchObject({
      [MEMORY_TIER_KEY]: 'probationary',
      origin: 'replay',
      transfer_lesson_id: lesson.id,
    });
    // D-002: distillation spend ledgered (the battery leg ledgers elsewhere).
    expect(spends).toEqual([{ costUsd: 0.01, note: 'lesson distillation', disposition: 'used' }]);
  });

  it('a re-distilled duplicate is a no-op (no second memory entry, no double row)', async () => {
    const { deps, store, memory } = makeHarness({
      lister: async () => ['/logs/a.jsonl', '/logs/b.jsonl'],
    });
    const result = await runTransferTick('ws', deps, OPTS);
    expect(result.lessonsDistilled).toBe(2);
    expect(result.lessonsAdmitted).toBe(1);
    expect(store.rows.size).toBe(1);
    expect(memory.entries.size).toBe(1);
  });

  it('a failed transcript load is counted and never sinks the tick', async () => {
    const { deps } = makeHarness({
      lister: async () => ['/logs/bad.jsonl', '/logs/good.jsonl'],
      source: {
        load: async (ref) => {
          if (ref.includes('bad')) throw new Error('corrupt');
          return transcriptOf(ref);
        },
      },
    });
    const result = await runTransferTick('ws', deps, OPTS);
    expect(result.errors).toBe(1);
    expect(result.lessonsAdmitted).toBe(1);
  });
});

/* ── testing leg ────────────────────────────────────────────────────────── */

function seededHarness(outcome: TransferTestOutcome | Error, seedFails = 0): Harness {
  const h = makeHarness({
    lister: async () => [], // no new distillation — test the queue only
    replay: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  // Seed one already-admitted probationary lesson linked to memory M1.
  void h.store.rows.set('L1', {
    ...fakeLessonRow(
      { workspaceId: 'ws', signature: lessonSignature('seeded'), lessonText: 'seeded', sourceRef: '/logs/a.jsonl' },
      'L1',
    ),
    memoryId: 'M1',
    failCount: seedFails,
  });
  void h.memory.entries.set('M1', {
    id: 'M1',
    text: 'seeded',
    scope: 'harness:test',
    metadata: { [MEMORY_TIER_KEY]: 'probationary' },
  });
  return h;
}

describe('runTransferTick — testing leg (the student-transfer gate, D-006)', () => {
  it('hands actual replay provenance to the store before mirroring the memory tier', async () => {
    const h = seededHarness({ withComposite: 8, baselineComposite: 6, batteryId: 'unused', costUsd: 0 });
    const order: string[] = [];
    const port = transferReplayPort({ workspaceId: 'ws',
      runner: async () => ({ outputText: 'verified', costUsd: 0.01, inputTokens: 1, outputTokens: 1, replayed: true }),
      llmCall: async ({ messages }) => {
        const score = messages[0].content.includes('variant: with lesson') ? 8 : 6;
        return { text: JSON.stringify({ d1: score, d2: score, d3: score, rationale: 'fixture' }), costUsd: 0.01 } as never;
      },
      runGoverned: async ({ config }, deps) => ({ verdict: { allow: true, remainingUsd: 1 }, result: await runReplayBattery(config, deps) }),
    });
    h.deps.replay = port;
    const record = h.store.recordOutcome.bind(h.store);
    h.deps.store = { ...h.deps.store, admit: h.store.admit.bind(h.store), listForTesting: h.store.listForTesting.bind(h.store),
      markError: h.store.markError.bind(h.store), setMemoryId: h.store.setMemoryId.bind(h.store),
      recordOutcome: async (q) => {
        order.push('persist');
        expect(q.evaluation?.outcomes).toHaveLength(2);
        expect(q.evaluation?.experiment.batteryId).toBe(q.batteryId);
        expect(q.evaluation?.experiment.codeHash).toBeNull();
        return record(q);
      },
    };
    const update = h.memory.update.bind(h.memory);
    h.memory.update = async (id, patch) => { order.push('mirror'); await update(id, patch); };
    await runTransferTick('ws', h.deps, OPTS);
    expect(order).toEqual(['persist', 'mirror']);
  });

  it('a PASSING lesson promotes to validated and the memory tier is patched', async () => {
    const h = seededHarness({ withComposite: 8, baselineComposite: 6, batteryId: 'B1', costUsd: 0.05 });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ tested: 1, passed: 1, failed: 0, retired: 0 });
    expect(h.store.rows.get('L1')!.tier).toBe('validated');
    expect(h.memory.entries.get('M1')!.metadata![MEMORY_TIER_KEY]).toBe('validated');
    // Battery cost reported but NOT ledgered here (the governed replay path owns it).
    expect(result.costUsd).toBeCloseTo(0.05);
    expect(h.spends).toEqual([]);
  });

  it.each(['inconclusive', 'missing'] as const)('never mirrors a native pass when the persisted result is %s', async (kind) => {
    const h = seededHarness({ withComposite: 8, baselineComposite: 6, batteryId: 'B1', costUsd: 0.05 });
    h.deps.store.recordOutcome = async () => kind === 'missing' ? null : { ...h.store.rows.get('L1')!, status: 'error' };
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ tested: 1, passed: 0, errors: 1 });
    expect(h.memory.entries.get('M1')!.metadata![MEMORY_TIER_KEY]).toBe('probationary');
    expect(h.memory.forgotten).toEqual([]);
  });

  it('mirrors the persisted demotion even when the native proposed verdict passed', async () => {
    const h = seededHarness({ withComposite: 8, baselineComposite: 6, batteryId: 'B1', costUsd: 0.05 });
    h.deps.store.recordOutcome = async () => ({ ...h.store.rows.get('L1')!, status: 'failed', tier: 'probationary' });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ passed: 0, failed: 1 });
    expect(h.memory.entries.get('M1')!.metadata![MEMORY_TIER_KEY]).toBe('probationary');
  });

  it('a FAILING lesson stays probationary (demotion target), memory untouched', async () => {
    const h = seededHarness({ withComposite: 6.1, baselineComposite: 6, batteryId: 'B1', costUsd: 0.01 });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ tested: 1, passed: 0, failed: 1, retired: 0 });
    expect(h.store.rows.get('L1')!.tier).toBe('probationary');
    expect(h.memory.entries.get('M1')!.metadata![MEMORY_TIER_KEY]).toBe('probationary');
    expect(h.memory.forgotten).toEqual([]);
  });

  it('the FINAL failure retires the lesson and forgets its memory entry (retention, D-006)', async () => {
    const h = seededHarness(
      { withComposite: 5, baselineComposite: 6, batteryId: 'B9', costUsd: 0.01 },
      DEFAULT_TRANSFER_TICK.maxFailsBeforeRetire - 1,
    );
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ tested: 1, retired: 1, failed: 0 });
    expect(h.store.rows.get('L1')!.tier).toBe('retired');
    expect(h.store.rows.get('L1')!.memoryId).toBeNull();
    expect(h.memory.forgotten).toEqual(['M1']);
  });

  it('a replay error marks the lesson errored — recorded, never silently dropped', async () => {
    const h = seededHarness(new Error('replay refused'));
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result).toMatchObject({ tested: 0, errors: 1 });
    expect(h.store.errorsMarked).toEqual(['L1']);
  });

  it('with no replay port the leg self-skips with an honest count', async () => {
    const h = makeHarness({ lister: async () => [], replay: null });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result.testingSkippedNoReplay).toBe(true);
    expect(result.tested).toBe(0);
  });
});

/* ── distillation spend: the attempt is the ledgered unit (P-005) ────────── */

describe('distillation spend closes every attempt', () => {
  const OPTS: TransferTickOptions = { ...DEFAULT_TRANSFER_TICK, maxTranscriptsPerTick: 2 };

  it('ledgers a FAILED proposer call, charged for the tokens it burned before throwing', async () => {
    // Pre-P-005 this transcript produced `errors += 1` and NOTHING on the
    // ledger: the distiller threw, so no cost was ever reported, so the
    // `costUsd > 0` guard dropped a real charge on the floor.
    const h = makeHarness({
      llm: async () => {
        throw Object.assign(new Error('model returned unparseable JSON'), { costUsd: 0.004 });
      },
    });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(result.errors).toBe(1);
    expect(result.lessonsDistilled).toBe(0);
    expect(h.spends).toEqual([{ costUsd: 0.004, note: 'lesson distillation', disposition: 'failed' }]);
    // The burned money still lands in the tick's own cost total.
    expect(result.costUsd).toBeCloseTo(0.004);
  });

  it('ledgers a ZERO-COST distillation as an attempt rather than nothing at all', async () => {
    const h = makeHarness({ llm: async () => ({ text: '[]', costUsd: 0 }) });
    await runTransferTick('ws', h.deps, OPTS);
    expect(h.spends).toEqual([{ costUsd: 0, note: 'lesson distillation', disposition: 'used' }]);
  });

  it('STOPS the leg when the governor refuses — no point retrying every transcript', async () => {
    const attempted: string[] = [];
    const h = makeHarness({
      lister: async () => ['/logs/a.jsonl', '/logs/b.jsonl'],
      spendAttempt: async (q) => {
        attempted.push(q.runRef ?? '');
        return { ok: false, reason: 'refused', refusal: 'no-headroom', headroomUsd: 0 };
      },
    });
    const result = await runTransferTick('ws', h.deps, OPTS);
    expect(attempted).toEqual(['/logs/a.jsonl']); // broke out; did not try the second
    expect(result.errors).toBe(0); // exhaustion is a budget state, not an error
    expect(result.lessonsDistilled).toBe(0);
  });
});
