/**
 * loop-wake-recipe — unit tests (compaction-continuity-hardening-2026-07-07
 * P-005c). Query extraction + the one-liner are pure; the lookup runs through
 * injected sql/embedder seams. Load-bearing contracts: the ABSOLUTE cosine
 * floor gates the splice, and the whole path is fail-soft + time-bounded (a
 * dead embedder or slow DB yields null, never an error or a stalled fire).
 */
import { describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';
import {
  extractWakeRecipeQuery,
  findTopRecipeForWake,
  renderWakeRecipeLine,
  LOOP_WAKE_RECIPE_SIM_FLOOR,
} from './loop-wake-recipe';

const CHECKPOINT = [
  '## Did',
  'P-004 landed.',
  '## Left',
  'P-005..P-008.',
  '## Key insight',
  'The boundary is substring-matchable.',
  '## Next action',
  'Implement the pg_query guards and splice recipes into the wake form.',
].join('\n');

describe('extractWakeRecipeQuery', () => {
  it("uses the checkpoint's ## Next action section when present", () => {
    expect(extractWakeRecipeQuery(CHECKPOINT, 'kickoff line')).toBe(
      'Implement the pg_query guards and splice recipes into the wake form.',
    );
  });

  it('falls back to the checkpoint head when there is no Next action section', () => {
    expect(extractWakeRecipeQuery('just a raw note', 'kickoff line')).toBe('just a raw note');
  });

  it('falls back to the kickoff first non-empty line without a checkpoint', () => {
    expect(extractWakeRecipeQuery(null, '\n\n🔁 Work the plan.\nmore lines')).toBe(
      '🔁 Work the plan.',
    );
    expect(extractWakeRecipeQuery('   ', 'goal one-liner')).toBe('goal one-liner');
  });

  it('caps the query length', () => {
    const q = extractWakeRecipeQuery('x'.repeat(2000), 'k');
    expect(q.length).toBeLessThanOrEqual(400);
  });
});

describe('renderWakeRecipeLine', () => {
  it('renders id + runCount + cosine as one line', () => {
    const line = renderWakeRecipeLine({ id: 'recipe-abc', title: 'Batch triage', runCount: 7, sim: 0.734 });
    expect(line).toContain("recipes:run { id: 'recipe-abc' }");
    expect(line).toContain('run 7×');
    expect(line).toContain('cosine 0.73');
    expect(line).not.toContain('\n');
  });

  it('truncates a long title', () => {
    const line = renderWakeRecipeLine({ id: 'r', title: 'T'.repeat(200), runCount: 1, sim: 0.9 });
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(300);
  });
});

/** A tagged-template sql stub returning canned recipe rows. */
function stubSql(rows: Array<Record<string, unknown>>) {
  const sql = (async () => rows) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
    unsafe: (text: string) => string;
  };
  sql.unsafe = (text: string) => text;
  return sql as never;
}

const okEmbedder = async () => [0.1, 0.2, 0.3];
const queryEmbedder = (embed: (text: string) => Promise<number[]>) => ({
  embed,
  profile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
});

describe('findTopRecipeForWake', () => {
  it('includes the exact stored-profile predicate in the recipe cosine query', async () => {
    const identifiers: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      return [{ id: 'r-profile', title: 'Profiled', script: 'return 1;', run_count: 2, sim: 0.9 }];
    }) as unknown as {
      (strings: TemplateStringsArray, ...values: unknown[]): Array<Record<string, unknown>>;
      unsafe: (text: string) => string;
    };
    sql.unsafe = (text: string) => {
      identifiers.push(text);
      return text;
    };
    const hit = await findTopRecipeForWake('do the thing', {
      sql: sql as never,
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit?.id).toBe('r-profile');
    expect(identifiers).toContain('embedding_profile');
    expect(identifiers).toContain('embedding_mode');
  });

  it('returns the top hit when the ABSOLUTE cosine clears the floor', async () => {
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([{ id: 'r1', title: 'Do the thing', run_count: 3, sim: 0.82 }]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r1', title: 'Do the thing', runCount: 3, sim: 0.82 });
  });

  it('returns null when the top hit sits below the floor (topical noise)', async () => {
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([{ id: 'r1', title: 'Unrelated', run_count: 3, sim: LOOP_WAKE_RECIPE_SIM_FLOOR - 0.01 }]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toBeNull();
  });

  it('returns null with no matching recipe rows', async () => {
    expect(
      await findTopRecipeForWake('do the thing', { sql: stubSql([]), queryEmbedder: queryEmbedder(okEmbedder) }),
    ).toBeNull();
  });

  it('returns null when no embedder is available (quota exhausted / model missing)', async () => {
    expect(await findTopRecipeForWake('do the thing', { sql: stubSql([]), queryEmbedder: null })).toBeNull();
  });

  it('returns null for a blank query without touching the seams', async () => {
    const sql = (async () => {
      throw new Error('must not be called');
    }) as never;
    expect(await findTopRecipeForWake('   ', { sql, queryEmbedder: queryEmbedder(okEmbedder) })).toBeNull();
  });

  it('fails soft to null when the DB read throws', async () => {
    const sql = (async () => {
      throw new Error('pg down');
    }) as never;
    expect(await findTopRecipeForWake('q', { sql, queryEmbedder: queryEmbedder(okEmbedder) })).toBeNull();
  });

  it('yields null when the lookup outlives the time budget (the fire path must not stall)', async () => {
    const never = () => new Promise<number[]>(() => {});
    const hit = await findTopRecipeForWake('q', {
      sql: stubSql([]),
      queryEmbedder: queryEmbedder(never),
      timeoutMs: 30,
    });
    expect(hit).toBeNull();
  });

  it('coerces a string run_count/sim (bigint/numeric wire types)', async () => {
    const hit = await findTopRecipeForWake('q', {
      sql: stubSql([{ id: 'r2', title: 'T', run_count: '11', sim: '0.71' }]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r2', title: 'T', runCount: 11, sim: 0.71 });
  });

  // WI-4946: the top cosine hit embeds an opaque dev:pg_query call — permanently
  // unrunnable via recipes:run (recipe-authority.ts's `unresolved`, independent of
  // any context match). The splice must skip past it to the next-best candidate
  // instead of recommending a guaranteed authority_unresolved dead end.
  it('skips a top hit whose script is authority-unresolved (opaque dev:pg_query) and falls through to the next candidate', async () => {
    const unresolvedScript = 'return await tools.call("dev:pg_query", { sql: "SELECT 1" });';
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([
        { id: 'r-opaque', title: 'Opaque one', script: unresolvedScript, run_count: 1, sim: 0.9 },
        { id: 'r-clean', title: 'Clean one', script: 'return await tools.docs.search({ query: "x" });', run_count: 4, sim: 0.75 },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r-clean', title: 'Clean one', runCount: 4, sim: 0.75 });
  });

  it('returns null when every candidate clearing the floor is authority-unresolved', async () => {
    const unresolvedScript = 'return await tools.call("capability:bash", { cmd: "ls" });';
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([
        { id: 'r-opaque-1', title: 'Opaque one', script: unresolvedScript, run_count: 1, sim: 0.9 },
        { id: 'r-opaque-2', title: 'Opaque two', script: unresolvedScript, run_count: 2, sim: 0.8 },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toBeNull();
  });

  // EI-21459619725350397: the gate-parking recipe was unbound and therefore
  // surfaced here even though its loop.arm overwrote the caller's active
  // mission. Loop mutators are caller-scoped state and must be skipped before
  // the wake splice can recommend the next candidate.
  it('skips a caller-scoped loop mutator and falls through to the next candidate', async () => {
    const mutatingScript = `
      await tools.events.await({ event: 'release:green:papercusp' });
      return await tools.loop.arm({ intervalSec: 300, goal: 'db-performance-remediation' });
    `;
    const hit = await findTopRecipeForWake('wait for completion', {
      sql: stubSql([
        { id: 'r-mutating-loop', title: 'Park on gate', script: mutatingScript, run_count: 2, sim: 0.91 },
        {
          id: 'r-safe',
          title: 'Read verification state',
          script: 'return await tools.docs.search({ query: "verification" });',
          run_count: 4,
          sim: 0.74,
        },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r-safe', title: 'Read verification state', runCount: 4, sim: 0.74 });
  });

  it('skips an entity-bound recipe and falls through to an unbound candidate', async () => {
    const boundScript =
      "return await tools.work_items.complete({ id: 'EI-OTHER', completion: { summary: 'done' } });";
    const hit = await findTopRecipeForWake('close the verified item', {
      sql: stubSql([
        { id: 'r-wrong-item', title: 'Close item', script: boundScript, run_count: 1, sim: 0.91 },
        {
          id: 'r-unbound',
          title: 'Read verification state',
          script: 'return await tools.docs.search({ query: "verification" });',
          run_count: 4,
          sim: 0.74,
        },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({
      id: 'r-unbound',
      title: 'Read verification state',
      runCount: 4,
      sim: 0.74,
    });
  });

  it('skips a recipe bound to a fixed goal id held in a const', async () => {
    const goalBoundScript = `
      const gid = 'work-on-everything-fresh-grading-and-improvement-60d3a8';
      await tools.goals.get({ id: gid });
      await tools.search.fulltext({ query: 'goal_budget_unmeasurable respawner launch refused safety cap' });
    `;
    const hit = await findTopRecipeForWake('inspect the dispatch refusal', {
      sql: stubSql([
        {
          id: 'r-wrong-goal',
          title: 'Verify pause timestamps + holder-refusal hypothesis',
          script: goalBoundScript,
          run_count: 1,
          sim: 0.66,
        },
        {
          id: 'r-safe',
          title: 'Read current dispatch state',
          script: 'return await tools.docs.search({ query: "dispatch state" });',
          run_count: 2,
          sim: 0.64,
        },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r-safe', title: 'Read current dispatch state', runCount: 2, sim: 0.64 });
  });

  it('returns null when every candidate clearing the floor is entity-bound', async () => {
    const boundScript =
      "return await tools.work_items.claim({ id: 'EI-OTHER', harness: 'papercusp' });";
    expect(
      await findTopRecipeForWake('claim the next item', {
        sql: stubSql([
          { id: 'r-bound', title: 'Claim item', script: boundScript, run_count: 1, sim: 0.88 },
        ]),
        queryEmbedder: queryEmbedder(okEmbedder),
      }),
    ).toBeNull();
  });

  it('does not walk past a candidate that misses the floor even if a later row would resolve', async () => {
    const unresolvedScript = 'return await tools.call("dev:pg_query", { sql: "SELECT 1" });';
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([
        { id: 'r-opaque', title: 'Opaque one', script: unresolvedScript, run_count: 1, sim: 0.9 },
        {
          id: 'r-below-floor',
          title: 'Below floor',
          script: 'return 1;',
          run_count: 4,
          sim: LOOP_WAKE_RECIPE_SIM_FLOOR - 0.01,
        },
      ]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toBeNull();
  });

  it('treats a missing/null script as resolvable (fail-open on the legacy shape, not fail-closed)', async () => {
    const hit = await findTopRecipeForWake('do the thing', {
      sql: stubSql([{ id: 'r-no-script', title: 'No script column', run_count: 2, sim: 0.7 }]),
      queryEmbedder: queryEmbedder(okEmbedder),
    });
    expect(hit).toEqual({ id: 'r-no-script', title: 'No script column', runCount: 2, sim: 0.7 });
  });
});
