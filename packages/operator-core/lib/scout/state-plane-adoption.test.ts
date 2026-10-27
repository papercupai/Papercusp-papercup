import { describe, expect, it } from 'vitest';

import {
  ACT_WINDOW_MS,
  POLL_TURN_THRESHOLD,
  type PlaneCallRow,
  computeStatePlaneAdoption,
  readStatePlaneAdoption,
} from './state-plane-adoption';

const T0 = 1_700_000_000_000;

/** The grouping key is the AGENT — deliberately not a spawn. See the module header. */
function row(ownerId: string, toolName: string, offsetMs: number,
  args: unknown = { body: [{ text: 'Gate verdict red.' }] }): PlaneCallRow {
  return { ownerId, toolName, atMs: T0 + offsetMs, args };
}

describe('state-plane-adoption — D-003: an empty denominator is null, never 0', () => {
  it('reports rate null and unmeasurable for a window with no activity', () => {
    const out = computeStatePlaneAdoption([], 7);
    expect(out.actQuote.opportunities).toBe(0);
    expect(out.actQuote.rate).toBeNull();
    expect(out.wait.rate).toBeNull();
    expect(out.unmeasurable).toBe(true);
  });

  it('does NOT report unmeasurable once a real opportunity exists', () => {
    // The live case this guards: measured 2026-08-08 the fleet fell to 12 calls/day, and
    // an idle window reported as "0% adoption" reads as a regression that never happened.
    const out = computeStatePlaneAdoption(
      [row('su-a', 'dev:pipeline_position', 0), row('su-a', 'coord:send', 1_000)],
      7,
    );
    expect(out.unmeasurable).toBe(false);
    expect(out.actQuote.rate).toBe(0);
  });
});

describe('state-plane-adoption — grouping is by AGENT, not by spawn (regression)', () => {
  it('joins a door read to a later write by the SAME agent', () => {
    // REGRESSION CONTROL. The first cut of this module partitioned by `spawn_id`, which on
    // harness_shared.tool_invocations is per-CALL: measured 2026-08-08, 543,974 of 550,683
    // spawn groups (98.8%) were singletons at mean 1.1 calls. Under that grouping these two
    // rows land in different partitions and this metric reports 0 opportunities forever —
    // a well-formed, confident, entirely wrong number. If this test ever fails with
    // `opportunities: 0`, someone has re-introduced a session-shaped grouping key.
    const out = computeStatePlaneAdoption(
      [row('su-a', 'dev:pipeline_position', 0), row('su-a', 'coord:send', 5_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
  });

  it('does NOT join a door read by one agent to a write by another', () => {
    const out = computeStatePlaneAdoption(
      [row('su-a', 'dev:pipeline_position', 0), row('su-b', 'coord:send', 1_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(0);
  });
});

describe('state-plane-adoption — METRIC A (act/quote)', () => {
  it('excludes unrelated messages and missing content while retaining actual pipeline quotes', () => {
    const out = computeStatePlaneAdoption([
      row('su-a', 'dev:pipeline_position', 0, { sourceRuntimeOnly: true }),
      row('su-a', 'coord:send', 1_000, { summary: 'Exact claim admitted; floor honored.' }),
      row('su-a', 'coord:send', 2_000, null),
      row('su-a', 'coord:send', 3_000, { body: 'Re-read the gate verdict before reporting.' }),
      row('su-a', 'coord:send', 4_000, { body: { mainBehindStaging: false } }),
    ], 7);
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(0);
  });

  it('reads stored argument content at the SQL seam instead of restoring a content-blind denominator', async () => {
    const raw = [
      { owner_id: 'su-a', tool_name: 'dev:pipeline_position', at_ms: T0, args_json: { sourceRuntimeOnly: true } },
      { owner_id: 'su-a', tool_name: 'coord:send', at_ms: T0 + 1_000, args_json: { summary: 'Claim admitted' } },
      { owner_id: 'su-a', tool_name: 'state:read', at_ms: T0 + 2_000, args_json: {} },
      { owner_id: 'su-a', tool_name: 'coord:send', at_ms: T0 + 3_000, args_json: { body: 'Candidate sha abcdef1234567' } },
    ];
    const out = await readStatePlaneAdoption(async <T>(query: string) => {
      expect(query).toContain('args_json');
      return raw as T[];
    }, { workspaceId: 'test-workspace', windowDays: 7 });
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(1);
  });

  it('counts a door-then-write as an unadopted opportunity', () => {
    const out = computeStatePlaneAdoption(
      [row('su-a', 'dev:pipeline_position', 0), row('su-a', 'coord:send', 5_000)],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(0);
    expect(out.actQuote.rate).toBe(0);
  });

  it('counts a door-then-state:read-then-write as ADOPTED', () => {
    const out = computeStatePlaneAdoption(
      [
        row('su-a', 'dev:pipeline_position', 0),
        row('su-a', 'state:read', 3_000),
        row('su-a', 'coord:send', 5_000),
      ],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(1);
    expect(out.actQuote.rate).toBe(1);
  });

  it('does NOT credit a state:read that precedes the door read (ordering is the point)', () => {
    // Control for the pair above: identical tools, different ORDER, opposite verdict. A
    // re-read before the value exists re-reads nothing, and without this check the metric
    // could be satisfied by reading in the wrong order.
    const out = computeStatePlaneAdoption(
      [
        row('su-a', 'state:read', 0),
        row('su-a', 'dev:pipeline_position', 3_000),
        row('su-a', 'coord:send', 5_000),
      ],
      7,
    );
    expect(out.actQuote.opportunities).toBe(1);
    expect(out.actQuote.adopted).toBe(0);
  });

  it('does not count a write with no door value in hand as an opportunity', () => {
    const out = computeStatePlaneAdoption([row('su-a', 'coord:send', 0)], 7);
    expect(out.actQuote.opportunities).toBe(0);
  });

  it('does not count a write once the door value has gone stale', () => {
    const out = computeStatePlaneAdoption(
      [
        row('su-a', 'dev:pipeline_position', 0),
        row('su-a', 'coord:send', ACT_WINDOW_MS + 1_000),
      ],
      7,
    );
    expect(out.actQuote.opportunities).toBe(0);
  });
});

describe('state-plane-adoption — METRIC B (wait/poll)', () => {
  const pollRows = (owner: string) => [
    row(owner, 'dev:pipeline_position', 0),
    row(owner, 'dev:pipeline_position', 60_000),
    row(owner, 'dev:pipeline_position', 120_000),
  ];

  it('counts a multi-turn door poll as an unadopted opportunity', () => {
    const out = computeStatePlaneAdoption(pollRows('su-a'), 7);
    expect(out.wait.opportunities).toBe(1);
    expect(out.wait.adopted).toBe(0);
  });

  it('counts a poll that also used state:subscribe as ADOPTED', () => {
    const out = computeStatePlaneAdoption(
      [...pollRows('su-a'), row('su-a', 'state:subscribe', 130_000)],
      7,
    );
    expect(out.wait.opportunities).toBe(1);
    expect(out.wait.adopted).toBe(1);
    expect(out.wait.rate).toBe(1);
  });

  it('does NOT treat calls batched into ONE inference turn as a poll loop', () => {
    // TURNS, not raw calls — the code-run-adoption P-012 lesson. Three calls dispatched
    // from one response block cost a single round-trip; counting them as a poll loop
    // would inflate the denominator with sessions that were already optimal.
    const out = computeStatePlaneAdoption(
      [
        row('su-a', 'dev:pipeline_position', 0),
        row('su-a', 'dev:pipeline_position', 50),
        row('su-a', 'dev:pipeline_position', 100),
      ],
      7,
    );
    expect(out.wait.opportunities).toBe(0);
  });

  it('counts ONE opportunity per poll loop, however many calls it made', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row('su-a', 'dev:pipeline_position', i * 60_000),
    );
    const out = computeStatePlaneAdoption(many, 7);
    // 12 calls spanning 11min — one loop inside the 30min window, so exactly one charge.
    expect(out.wait.opportunities).toBe(1);
  });

  it('charges an agent twice for two genuinely separate waits', () => {
    const out = computeStatePlaneAdoption(
      [...pollRows('su-a'), ...pollRows('su-a').map((r) => ({ ...r, atMs: r.atMs + 86_400_000 }))],
      7,
    );
    expect(out.wait.opportunities).toBe(2);
  });

  it('needs at least POLL_TURN_THRESHOLD turns before it is a poll loop', () => {
    const out = computeStatePlaneAdoption(
      [row('su-a', 'dev:pipeline_position', 0), row('su-a', 'dev:pipeline_position', 60_000)],
      7,
    );
    expect(POLL_TURN_THRESHOLD).toBe(3);
    expect(out.wait.opportunities).toBe(0);
  });
});

describe('state-plane-adoption — P-006: the ratio can actually reach 100%', () => {
  it('reaches 1.0 on both axes when every opportunity is taken', () => {
    // This is the whole reason P-006 exists. The Phase-1 metric ("plane share of pipeline
    // reads") could not reach 1.0 by construction, because CLAUDE.md prescribes the DOOR
    // as the first read — so perfect behaviour still emitted door calls and scored as a
    // miss. Perfect behaviour here scores 1.0 DESPITE those door calls being present.
    const rows: PlaneCallRow[] = [
      row('su-a', 'dev:pipeline_position', 0),
      row('su-a', 'state:read', 1_000),
      row('su-a', 'coord:send', 2_000),

      row('su-b', 'dev:pipeline_position', 0),
      row('su-b', 'dev:pipeline_position', 60_000),
      row('su-b', 'dev:pipeline_position', 120_000),
      row('su-b', 'state:subscribe', 130_000),
    ];
    const out = computeStatePlaneAdoption(rows, 7);
    expect(out.actQuote.rate).toBe(1);
    expect(out.wait.rate).toBe(1);
    expect(out.unmeasurable).toBe(false);
  });

  it('tracks BREADTH separately from depth (Phase 1 found breadth the weak axis)', () => {
    const rows: PlaneCallRow[] = [
      // su-a adopts, repeatedly.
      row('su-a', 'dev:pipeline_position', 0),
      row('su-a', 'state:read', 1_000),
      row('su-a', 'coord:send', 2_000),
      row('su-a', 'dev:pipeline_position', 3_000),
      row('su-a', 'state:read', 4_000),
      row('su-a', 'coord:send', 5_000),
      // su-b never does.
      row('su-b', 'dev:pipeline_position', 0),
      row('su-b', 'coord:send', 2_000),
    ];
    const out = computeStatePlaneAdoption(rows, 7);
    expect(out.actQuote.agentsWithOpportunity).toBe(2);
    expect(out.actQuote.agentsAdopting).toBe(1);
    // Depth looks healthy (2 of 3) while breadth is half — the distinction Phase 1 needed.
    expect(out.actQuote.adopted).toBe(2);
    expect(out.actQuote.opportunities).toBe(3);
  });
});
