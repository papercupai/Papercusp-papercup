/**
 * mid-turn-context.p018-acceptance.test.ts — the P-018 ACCEPTANCE REPLAY
 * (context-injection-audit-2026-07-28, Phase 7).
 *
 * P-018 is the plan's one acceptance case, and it is a REPLAY rather than a unit
 * test: "an su spent ~20 tool calls (grep/ls/curl/psql) re-deriving WI-6512 … a
 * dead-end matcher firing on the FIRST grep for the symptom would have cost one
 * line and saved the entire investigation. Use this as the acceptance test for
 * Phase 7 — replay that tool-call sequence and assert the push fires early."
 *
 * ─── WHY THIS FILE EXISTS ALONGSIDE mid-turn-context.test.ts ───────────────────
 *
 * That sibling mocks `buildMemoryContextBlock` outright, so its P-018 block can
 * only assert "the endpoint called the pipeline on call one". That is the
 * THROTTLE half of the claim and none of the RETRIEVAL half: a push that fires
 * early and carries the wrong record saves nobody. The load-bearing question is
 * whether the query the production code DERIVES from the first investigation
 * batch is discriminative enough to pull the already-recorded answer out from
 * under plausible neighbours. So this file mocks the STORE and runs the REAL
 * `buildMemoryContextBlock` — real floors, real pool partitioning, real
 * near-duplicate collapse, real budget, real epoch dedup, real corpus
 * composition — over a seeded corpus.
 *
 * The subject under test is therefore `deriveBatchQuery` + the admission
 * pipeline, NOT the scorer below. `relevance()` is deliberately generic (weighted
 * token overlap) and blind to which record is "the answer": it never sees an id,
 * a scope or a hand-placed thumb. If the derived query stopped naming the
 * symptom, the answer would stop out-ranking the decoys and these tests would go
 * red — which is the property worth pinning.
 *
 * ─── PROVENANCE OF THE REPLAY (read before "fixing" the fixture) ───────────────
 *
 * The raw transcript jsonl for that session is GONE (checked 2026-08-02:
 * absent from ~/.claude/projects and ~/.papercusp), and `session_turns` stores
 * assistant prose only — no tool rows. So the sequence below is RECONSTRUCTED,
 * not captured, from the two sources that did survive:
 *
 *   • session 0f7b47b5-df90-4821-b482-b0363b9834c0, turns 63–69
 *     (2026-07-27T23:13:08Z → 23:15:05Z) — each turn's prose names what that
 *     step did ("Let me find what that dropdown actually calls", "timing the two
 *     hops the modal makes", "421k turns, 2.2 GB", …);
 *   • WI-6512's body, which enumerates the concrete measurements and names
 *     `sessions/read.ts:104`, `sessions:list`, `harness_shared.session_turns`,
 *     `AgentsRunningPill` / `SwarmTab` / `SessionChatModal`.
 *
 * Every symbol and path in the fixture appears in one of those two records, and
 * all of them exist in the tree today. The count is thirteen calls across the
 * seven recorded batches; the plan's "~20" counts the whole detour including the
 * filing turns, which carry no investigation signal and are not replayed.
 *
 * ─── THE FRAMING, STATED PLAINLY ──────────────────────────────────────────────
 *
 * On the original night WI-6512 did not exist yet — it was the OUTPUT of the
 * investigation, so nothing could have been pushed on call one. The acceptance
 * case is therefore the one WI-6512 itself names in its own body: *"Filing so the
 * evidence is not lost and the next agent does not re-measure."* This replay is
 * that next agent. It runs the same thirteen calls against a store that already
 * holds the finding, and asserts the push lands on batch ONE — the call that
 * saves the other twelve.
 *
 * ═══ ⚠ READ THIS BEFORE CITING THIS FILE AS "P-018 PASSES" ═══════════════════
 *
 * IT DOES NOT. This file pins the TRANSPORT half of the acceptance case only —
 * fires on batch one, pays once, stays in budget, cannot be silenced by a
 * warm-up throttle. Those are corpus-independent and genuinely green.
 *
 * ═══ RETRIEVAL: WAS RED, FIXED 2026-08-03 (WI-6857 / D-060) ═════════════════
 *
 * Re-measured live on :3170 after the fix — the same seven batches, real store,
 * three fresh-owner passes, all identical: **1 of 7, batch ONE (turn 63)**. That
 * IS the pass; this item's criterion is "batch 1 or 2, without the query naming
 * the id". Batches 2-7 are a SEPARATE defect (WI-7237: `corpusQueryText` keeps
 * two terms BY LENGTH, and a 3+ digit token short-circuits the query to that
 * number alone) and cannot move at any budget — do not read 6 misses as a
 * partial fix, and do not read 1 of 7 as a full green either.
 *
 * Root cause was TWO INDEPENDENT CUTS, neither of them the query — which is why
 * three well-run single-variable experiments each measured 0/7 CORRECTLY and
 * each concluded WRONGLY. CUT 1: the corpus leg retrieved WI-6512 on every
 * batch and dropped it `budget-exhausted` at rank 4 (caps now 6/1800). CUT 2:
 * `clampToBudget` cut the WHOLE composed block at 350, deleting the pointer
 * section `composeWithCorpus` appends last — it now clamps the mem0 half only.
 * Before → after, same batches: 398-403 chars / no pointer section / 0 of 7 →
 * 1109-2255 chars / pointers on all 7 / 1 of 7.
 *
 * THE ORIGINAL RED, kept because its four probes are the reason the diagnosis
 * was findable at all. Measured 2026-08-02, verbatim:
 *
 *   • batch 1 fired — 377 chars, so the timing claim holds;
 *   • WI-6512 appeared in ZERO of the seven batches. Total 2,360 chars of
 *     pointers delivered, none of them the recorded answer;
 *   • the mem0 leg contributed NOTHING to any batch (every block carried only
 *     the corpus heading). A direct `memory:search` for the symptom in plain
 *     words returns ZERO hits — the finding was never written to mem0 at all;
 *   • isolating query dilution from corpus reach with four probes: only a query
 *     naming the literal id `WI-6512` retrieves it. The symptom in plain words
 *     does not, and neither does the replayed batch (which matches on
 *     `apps/operator-vite/src` path noise instead);
 *   • the sharpest one: the clean symptom query returns EI-18862790811651475 —
 *     a work-item whose text is "asked whether I ever figured out why loading
 *     session history takes several seconds. I searched, found nothing". The
 *     corpus surfaces the RECORD OF THE SAME FAILURE rather than the answer.
 *
 * That verdict was recorded as a plan Decision rather than as a permanently-red
 * test here — a test that cannot pass until a fix lands belongs on the fix, not
 * in the fleet gate. It also could not have been caught here: **a fixture green
 * in this file must never be read as the acceptance case passing.** A four-record
 * fixture cannot reproduce the ceiling and the crowd-out that actually decide
 * what surfaces — that is precisely what both cuts turned out to be, and the trap
 * this very file walked into on its first draft. The acceptance number comes from
 * replaying REPLAY against the live endpoint, and from nowhere else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Host seams. Everything below the endpoint is faked; the pipeline itself is real.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-su' }) }));
// No hive resolution — an empty registry keeps the pull to user + harness.
vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()), loadHarnessRegistry: async () => ({ projects: [] }) }));
// Every PG read on the injection path is best-effort and degrades to "no
// filtering" on an empty result; the epoch ledger is faked separately below
// because this replay depends on it actually WORKING.
//
// PARTIAL mock, deliberately: `@papercusp/agent-mcp`'s bootstrap (pulled in by
// `defineTool`) reads db-org's `generated` schema tables at module load, so a
// wholesale replacement fails the import before a single test runs.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: async () => [] }),
}));

/**
 * A real, in-memory session-epoch ledger. Faked rather than stubbed-empty
 * because the "fires early" claim is only affordable if the SAME record is not
 * re-paid on all thirteen calls — that is the D-006 port-agnostic dedup, and a
 * no-op stub would let a broken dedup pass. Mirrors production's UUID-shape
 * filter so the fixture's ids have to be real UUIDs, exactly as live rows are.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ledger = new Set<string>();
const ledgerKey = (session: string, epoch: number, id: string): string => `${session}|${epoch}|${id}`;
vi.mock('../../../memory/session-epoch-ledger', () => ({
  currentSessionEpoch: async () => 0,
  alreadySurfacedIds: async (_sql: unknown, sessionId: string, epoch: number, ids: readonly string[]) =>
    new Set(ids.filter((id) => UUID_SHAPE.test(id) && ledger.has(ledgerKey(sessionId, epoch, id)))),
  stampSurfaced: async (_sql: unknown, sessionId: string, epoch: number, ids: readonly string[]) => {
    for (const id of ids) if (UUID_SHAPE.test(id)) ledger.add(ledgerKey(sessionId, epoch, id));
    return true;
  },
}));

const { getMemoryBackendMock, recallCorpusContextMock, withMidTurnMemoryAdmissionMock } = vi.hoisted(() => ({
  getMemoryBackendMock: vi.fn(),
  recallCorpusContextMock: vi.fn(),
  withMidTurnMemoryAdmissionMock: vi.fn(),
}));
vi.mock('../../../memory/backend', () => ({ getMemoryBackend: getMemoryBackendMock }));
vi.mock('../../../memory/corpus-recall-io', () => ({ recallCorpusContext: recallCorpusContextMock }));
// The endpoint's optional recall is host-admitted in production. Keep this
// acceptance replay focused on retrieval and transport by admitting its real
// pipeline inside the partial-PG fixture, as the sibling endpoint suite does.
// Mid-turn recall now runs under identity-declared bounds (P-012): the REAL
// bounded wrapper runs, with only its host admission swapped for the fake.
vi.mock('../../../memory/mid-turn-admission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../memory/mid-turn-admission')>();
  return {
    ...actual,
    withMidTurnMemoryAdmission: withMidTurnMemoryAdmissionMock,
    withIdentityBoundedMemoryAdmission: (
      readBounds: Parameters<typeof actual.withIdentityBoundedMemoryAdmission>[0],
      run: Parameters<typeof actual.withIdentityBoundedMemoryAdmission>[1],
    ) => actual.withIdentityBoundedMemoryAdmission(readBounds, run, withMidTurnMemoryAdmissionMock),
  };
});
// The replayed session wears no identity, so its recall is unbounded — exactly
// the recall this replay measured. The real read would hit the PG rail. PARTIAL:
// the injection pipeline also uses this module's pure helpers (shareOfLimit, …).
vi.mock('../../../agent-identities/identity-recall', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-identities/identity-recall')>()),
  readAppliedIdentityRecall: async () => null,
}));
// No identity ⇒ no worn post-tool rules; the real sink reads identity rules from PG.
vi.mock('../../../agent-identities/sync-hook-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-identities/sync-hook-rules')>()),
  evaluateHookContextSink: async () => ({ text: '', result: null }),
}));
vi.mock('../../../memory/agent-signals', () => ({
  resolveClaimedWorkItemIdForOwner: async () => undefined,
}));
// The code-intel push is a separate leg with its own reserved budget and its own
// suites; this replay asserts the MEMORY push, so that leg contributes nothing.
vi.mock('../../../code-intelligence/push-channel', () => ({ codeIntelPushText: async () => '' }));

import routes, { deriveBatchQuery, type BatchCall } from './mid-turn-context';
// The endpoint fails CLOSED (empty push) for an owner-bearing request when no host
// confinement resolver is installed — a unit process never boots the host. Install
// the unconfined resolver the sibling endpoint suites use, so the replay measures
// retrieval and transport rather than the missing-policy refusal.
import { setSessionConfinementResolver } from '../../../capability-envelope/session-confinement-port';

// ─────────────────────────────────────────────────────────────────────────────
// A generic lexical relevance model — blind to which record is "the answer"
// ─────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'are', 'was', 'its',
  'src', 'ts', 'tsx', 'txt', 'com', 'http', 'null', 'true', 'false',
]);

/** Split identifiers the way a lexical leg does: camelCase apart, then alnum runs. */
const tokens = (s: string): string[] =>
  (s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOP.has(t),
  );

/** Digit-bearing tokens (WI-6512, 3170, 6512) are the rare identifiers a lexical
 *  leg leans on, so they weigh more than a common domain word. */
const weight = (t: string): number => (/\d/.test(t) ? 3 : 1);

/**
 * Weighted token overlap, normalised by the query into [0,1]. Deterministic and
 * content-only: it cannot see ids, scopes, or the fixture's intent.
 */
function relevance(query: string, text: string): number {
  const q = tokens(query);
  const t = new Set(tokens(text));
  if (q.length === 0 || t.size === 0) return 0;
  let hit = 0;
  let total = 0;
  for (const term of new Set(q)) {
    total += weight(term);
    if (t.has(term)) hit += weight(term);
  }
  return total === 0 ? 0 : hit / total;
}

/**
 * The admission floor, IN THIS SCORER'S OWN UNITS.
 *
 * ⚠ Deliberately NOT production's 0.45. That is an EMBEDDING-cosine floor;
 * `relevance()` is term overlap — a different scale entirely — and asserting
 * against 0.45 here would be asserting a number this file cannot mean. (Measured
 * while writing this: batch one's derived query scores 0.36 against the answer,
 * which says nothing whatsoever about what the real cosine leg would score.)
 *
 * What the tests actually pin is the SEPARATION, not the constant: the recorded
 * answer clears this floor and every decoy scores ZERO against the same query.
 * Any value strictly between the two selects the identical set, so this number
 * is not load-bearing — and `separation()` below asserts the gap directly rather
 * than trusting it.
 */
const FAKE_FLOOR = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// The seeded store: one already-recorded answer, three plausible neighbours
// ─────────────────────────────────────────────────────────────────────────────

/** WI-6512's own findings, as a memory the next agent should be handed. */
const ANSWER_ID = '2f1c8a44-6b90-4a1e-9a2f-6d0c5e7b31aa';

interface SeedRow {
  id: string;
  text: string;
  kind: string;
  scope: string;
}

const CORPUS: SeedRow[] = [
  {
    id: ANSWER_ID,
    kind: 'project',
    scope: 'harness:papercusp',
    text:
      'WI-6512 — agents running dropdown, session history takes seconds: the database is RULED OUT. ' +
      'sessions list is 20-41ms; the session history query is 75ms for the worst session on the box. ' +
      'sessions read.ts already projects narrow, so the session_turns embedding and tsvector payload is not pulled. ' +
      'Look at the UI transport path, not the query.',
  },
  {
    id: '8d3f4b21-1c77-4f0e-8f9b-2a41d6c90e15',
    kind: 'project',
    scope: 'u-su',
    text:
      'Force a deploy instead of waiting on git-sync: deploy-cli.ts --execute, and ' +
      'PAPERCUSP_ALLOW_DEV_RESTART=1 is required on the dev box or the restart step is withheld.',
  },
  {
    id: 'c50a9e73-2f18-4d6a-b1c4-77e2f0a8b934',
    kind: 'project',
    scope: 'harness:papercusp',
    text:
      'The papercusp-task-manager flag was decorative before WI-6499 wired the spawn chokepoints; ' +
      'it now defaults OFF and gates beginSyncEnrolment plus the reconcile routine.',
  },
  {
    id: 'a71b6c05-9e34-4c2d-83af-1b5d90e4c268',
    kind: 'feedback',
    scope: 'u-su',
    text:
      'PgBouncer sat built, tested and flag-OFF for weeks. Finished work never ships dark — ' +
      'flipping the flag on is the final step of the same task, not a hand-off.',
  },
];

/** Rank one query against the seeded corpus, applying the fake's own floor. */
const scoreRows = (query: string, scopes: readonly string[], limit: number) =>
  CORPUS.filter((r) => scopes.includes(r.scope))
    .map((r) => ({ id: r.id, text: r.text, kind: r.kind, scope: r.scope, score: relevance(query, r.text) }))
    .filter((r) => r.score >= FAKE_FLOOR)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);

/**
 * The full ranking (floor NOT applied) plus the gap between the best and second
 * — the scale-free form of "the derived query discriminates".
 */
const separation = (query: string): { ranked: Array<{ id: string; score: number }>; gap: number } => {
  const ranked = CORPUS.map((r) => ({ id: r.id, score: relevance(query, r.text) })).sort(
    (a, b) => b.score - a.score,
  );
  return { ranked, gap: (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0) };
};

const backend = {
  name: 'p018-fake',
  // Honest about what this scorer is — injection.ts stamps this onto the recall
  // telemetry, and mislabelling a lexical overlap as a cosine is exactly the
  // scale conflation D-001/F-F was filed about.
  scoreScale: 'lexical' as const,
  available: async () => ({ ok: true }),
  search: vi.fn(async (query: string, opts: { scope: string | readonly string[]; limit?: number }) => {
    const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
    return scoreRows(query, scopes, opts.limit ?? 12);
  }),
};

/**
 * The P-008 corpus leg (D-037) — the ONLY leg that can structurally reach a
 * work-item, which is what makes WI-6512 itself reachable rather than just a
 * memory ABOUT it. Query-sensitive off the same blind scorer, so its pointer has
 * to be earned by the derived query too.
 */
const CORPUS_POINTER_TEXT =
  'WI-6512 agents running dropdown session history several seconds database ruled out sessions list read measured';

// ─────────────────────────────────────────────────────────────────────────────
// The replay — session 0f7b47b5 turns 63–69, reconstructed
//
// The seven batches live in `memory/bench/wi-6512-replay.ts` and are imported by
// BOTH this file and the LIVE replay CLI. That is deliberate and load-bearing:
// this header states that the acceptance number comes from replaying REPLAY
// against the live endpoint "and from nowhere else", which is only true while
// the live replay and this one are the SAME seven batches. Two copies would
// diverge silently, and the divergence would land precisely on the number the
// plan cites. See that module for the provenance of every symbol below.
// ─────────────────────────────────────────────────────────────────────────────

import { REPLAY } from '../../../memory/bench/wi-6512-replay';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const endpoint = routes[0] as unknown as { handler: (req: Request) => Promise<Response> };

/** The injection path stamps the epoch ledger fire-and-forget; let it settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function post(owner: string, calls: BatchCall[]): Promise<string> {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/mid-turn-context', {
      method: 'POST',
      body: JSON.stringify({ owner, toolCalls: calls, harness: 'papercusp', workspace: 'papercusp-workspace' }),
    }),
  );
  const out = (await res.json()) as { ok: boolean; text: string };
  await settle();
  return out.text;
}

/** Run the whole replay for one session, returning the push text per batch. */
async function replay(owner: string): Promise<string[]> {
  const pushes: string[] = [];
  for (const batch of REPLAY) pushes.push(await post(owner, batch.calls));
  return pushes;
}

let seq = 0;
const newOwner = (): string => `p018-sess-${++seq}`;

beforeEach(() => {
  setSessionConfinementResolver(() => null);
  ledger.clear();
  backend.search.mockClear();
  getMemoryBackendMock.mockReset().mockReturnValue(backend);
  withMidTurnMemoryAdmissionMock
    .mockReset()
    .mockImplementation(async (run: () => Promise<unknown>) => ({ admitted: true, value: await run() }));
  recallCorpusContextMock.mockReset().mockImplementation(async ({ queryText }: { queryText: string }) => {
    const score = relevance(queryText, CORPUS_POINTER_TEXT);
    return score >= FAKE_FLOOR
      ? {
          heading: 'Related context',
          outcome: 'ok',
          dropped: [],
          embedderAvailable: true,
          candidateCount: 1,
          retrievalDepth: 8,
          rerank: 'nothing-to-reorder',
          legs: null,
          lines: [
            {
              line: '- WI-6512 (bug, open) — agents-running dropdown session history: DB ruled out, measurements attached',
              handle: { kind: 'work_item' as const, ref: 'WI-6512' },
            },
          ],
        }
      : {
          heading: 'Related context',
          outcome: 'ok',
          dropped: [],
          embedderAvailable: true,
          candidateCount: 0,
          retrievalDepth: 8,
          rerank: 'nothing-to-reorder',
          legs: null,
          lines: [],
        };
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('P-018 TRANSPORT half — replaying the WI-6512 investigation (retrieval measured live, see header)', () => {
  it('fires on batch ONE — the call that saves the other twelve', async () => {
    const pushes = await replay(newOwner());
    const firstHit = pushes.findIndex((p) => p.length > 0);
    // Not "eventually", not "after a warm-up": index 0. A min-interval throttle
    // in place of the rolling ceiling would push this to 1+ and fail here.
    expect(firstHit).toBe(0);
    expect(pushes[0]).toContain('WI-6512');
  });

  it('DELIVERS the recorded answer once retrieval returns it', async () => {
    // Conditional by construction: GIVEN a store that ranks the answer first,
    // the render + budget + clamp path hands back its substance rather than a
    // bare heading. This says nothing about whether LIVE retrieval ranks it —
    // measured 2026-08-02, it does not (see the header).
    const pushes = await replay(newOwner());
    expect(pushes[0]).toMatch(/ruled out|75ms|20-41ms/i);
  });

  it('out-ranks the plausible neighbours — the derived query is doing the work', async () => {
    // The scorer is blind; the discrimination has to come from deriveBatchQuery.
    const { ranked, gap } = separation(deriveBatchQuery(REPLAY[0]!.calls));
    expect(ranked[0]!.id).toBe(ANSWER_ID);
    // Scale-free form of the claim: the answer is not merely first, it is
    // SEPARATED — the runner-up scores nothing at all against the same query.
    // That gap, not the floor constant, is what makes the floor safe to set.
    expect(ranked[1]!.score).toBe(0);
    expect(gap).toBe(ranked[0]!.score);
    // Which the floor then converts into "exactly one record is admitted".
    expect(ranked.filter((s) => s.score >= FAKE_FLOOR).map((s) => s.id)).toEqual([ANSWER_ID]);
  });

  it('reaches the WORK-ITEM through the P-008 corpus leg, not only a memory about it', async () => {
    // The mem0 leg can only ever return a memory ABOUT the finding; WI-6512
    // itself is reachable only because D-037 added the second retrieval leg —
    // the exact structural gap WI-6771 recorded. Prove it carries the push on
    // its own, with the mem0 corpus emptied so nothing else can be the source.
    const saved = CORPUS.splice(0, CORPUS.length);
    try {
      const pushes = await replay(newOwner());
      expect(recallCorpusContextMock).toHaveBeenCalled();
      const asked = (recallCorpusContextMock.mock.calls[0]![0] as { queryText: string }).queryText;
      expect(relevance(asked, CORPUS_POINTER_TEXT)).toBeGreaterThanOrEqual(FAKE_FLOOR);
      expect(pushes[0]).toContain('WI-6512');
    } finally {
      CORPUS.push(...saved);
    }
  });
});

describe('P-018 TRANSPORT half — firing early stays CHEAP across the whole replay', () => {
  // ⚠ DO NOT SKIP THIS TEST. It briefly was, on 2026-08-02 21:46Z, on my (su-5ca1d)
  // reading that it was parked on the known WI-6857 retrieval gap. That was WRONG:
  // it was catching a REAL production regression, WI-7163 — commit 0da8ebaab9
  // (WI-6870, 20:51:40Z) dropped the `&& lines.length > 0` first-row budget exemption
  // in injection.ts, so a caller with a small budget (mid-turn passes 350 chars
  // against a ~3,700-char record) got NOTHING instead of one whole row. Restored in
  // a046942e43. Un-skipped 21:59Z so that fix is actually exercised.
  //
  // The lesson worth keeping: this assertion is the ONLY one here that requires the
  // MEM0 record specifically, because it matches on the id — every sibling can be
  // satisfied by the corpus leg alone, whose fixture text also mentions WI-6512 and
  // "ruled out". So this is the case that fails first when mid-turn injection breaks,
  // and a green file with this one skipped is indistinguishable from a working one.
  it('pays for the answer ONCE, not on all thirteen calls (D-006 epoch dedup)', async () => {
    const pushes = await replay(newOwner());
    const carrying = pushes.filter((p) => p.includes(ANSWER_ID));
    expect(carrying).toHaveLength(1);
  });

  it('keeps the whole investigation under one turn-start block', async () => {
    const pushes = await replay(newOwner());
    const total = pushes.reduce((n, p) => n + p.length, 0);
    // Thirteen mid-turn calls must cost less than ONE 4000-char turn-start
    // injection — otherwise mid-turn delivery is the bloat it was meant to avoid.
    expect(total).toBeLessThan(4_000);
  });

  it('never suppresses the FIRST call, even when the rolling ceiling later bites', async () => {
    // The regression this pins: swapping the rolling ceiling for a min-interval
    // throttle would silence exactly the call P-018 is about. Fresh session,
    // first call, immediately after a burst from another session.
    const noisy = newOwner();
    for (let i = 0; i < 30; i++) {
      await post(noisy, [{ tool: 'Grep', toolInput: { pattern: `noise-${i}` }, toolResponse: 'x' }]);
    }
    const fresh = await post(newOwner(), REPLAY[0]!.calls);
    expect(fresh).toContain('WI-6512');
  });
});

describe('P-018 TRANSPORT half — the negative control', () => {
  it('says NOTHING when the answer was never recorded', async () => {
    // Without this the suite could pass by injecting on every call. Drop the
    // answer from both legs and the same replay must go silent.
    const answerIdx = CORPUS.findIndex((r) => r.id === ANSWER_ID);
    const saved = CORPUS[answerIdx]!;
    CORPUS.splice(answerIdx, 1);
    recallCorpusContextMock.mockResolvedValue({ lines: [] });
    try {
      const pushes = await replay(newOwner());
      expect(pushes.every((p) => p === '')).toBe(true);
    } finally {
      CORPUS.splice(answerIdx, 0, saved);
    }
  });

  it('does not fire on an unrelated investigation — the floor is real', async () => {
    const pushes = await replay(newOwner());
    expect(pushes[0]).not.toContain('PgBouncer');
    expect(pushes[0]).not.toContain('task-manager');
  });
});
