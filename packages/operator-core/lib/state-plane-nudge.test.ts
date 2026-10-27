import { beforeEach, describe, expect, it } from 'vitest';

import {
  DOOR_POLL_TURN_THRESHOLD,
  DOOR_VALUE_FRESH_MS,
  _resetBatchNudgeState,
  maybeStatePlaneNudge,
} from './code-run-batch-nudge';

const T0 = 1_700_000_000_000;
const S = 'sess-1';
const QUOTE = { body: [{ text: 'Gate verdict red; candidate sha abcdef1234567.' }] };

/** Feed one call into the nudge plane and return whatever it wanted to say. */
function call(toolName: string, offsetMs: number, sessionKey = S, args?: unknown): string | null {
  return maybeStatePlaneNudge({ sessionKey, toolName, args, now: T0 + offsetMs });
}

beforeEach(() => {
  _resetBatchNudgeState();
});

describe('state-plane nudge — ACT/QUOTE rule', () => {
  it('fires on a durable write holding an un-re-read door value', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    const hint = call('coord:send', 5_000, S, QUOTE);
    expect(hint).toBeTruthy();
    expect(hint).toContain('state:read');
    expect(hint).toContain('dev:pipeline_position');
  });

  it('stays QUIET when the agent re-read the plane after the door call', () => {
    // The control for the test above: identical calls plus the re-read the rule asks for.
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('state:read', 2_000)).toBeNull();
    expect(call('coord:send', 5_000, S, QUOTE)).toBeNull();
  });

  it('still fires when the state:read came BEFORE the door call (ordering is the rule)', () => {
    expect(call('state:read', 0)).toBeNull();
    expect(call('dev:pipeline_position', 2_000)).toBeNull();
    expect(call('coord:send', 5_000, S, QUOTE)).toBeTruthy();
  });

  it('stays quiet for a write with no door value in hand', () => {
    expect(call('coord:send', 0, S, QUOTE)).toBeNull();
  });

  it('stays quiet once the door value has gone stale', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('coord:send', DOOR_VALUE_FRESH_MS + 1_000, S, QUOTE)).toBeNull();
  });

  it('stays quiet for a non-quote-sink tool', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('capability:read', 1_000)).toBeNull();
  });

  it('is one-shot per session — it teaches, it does not hector', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('coord:send', 1_000, S, QUOTE)).toBeTruthy();
    expect(call('dev:pipeline_position', 2_000)).toBeNull();
    expect(call('coord:send', 3_000, S, QUOTE)).toBeNull();
  });

  it('does not leak state across sessions', () => {
    expect(call('dev:pipeline_position', 0, 'sess-a')).toBeNull();
    expect(call('coord:send', 1_000, 'sess-b', QUOTE)).toBeNull();
  });

  it('recognises every declared quote sink', () => {
    for (const [sink, args] of [
      ['coord:send', QUOTE],
      ['coord:escalate', { body: 'Gate verdict red.' }],
      ['plans:add-decision', { body: 'Gate verdict red.' }],
      ['work_items:comment', { body: 'Gate verdict red.' }],
      ['work_items:comment', { comment: 'Gate verdict red.' }],
      ['work_items:checkpoint', { did: 'Gate verdict red.' }],
      ['work_items:complete', { completion: { summary: 'Gate verdict red.' } }],
      ['facts:assert', { body: 'Gate verdict red.' }],
      ['plans:set-now', { state: 'Gate verdict red.', next: 'Repair the failing test.' }],
    ] as const) {
      _resetBatchNudgeState();
      expect(call('dev:pipeline_position', 0)).toBeNull();
      expect(call(sink, 1_000, S, args), `${sink} should be treated as a quote sink`).toBeTruthy();
    }
  });

  it('stays quiet for a claim/admission-only message after a sourceRuntimeOnly read', () => {
    expect(call('dev:pipeline_position', 0, S, {
      path: 'packages/operator-core/lib/dao-hr/native.e2e.test.ts', sourceRuntimeOnly: true,
    })).toBeNull();
    expect(call('coord:send', 138_000, S, {
      to: ['@fleet-leader:dao-delivery-sol61-20261022'], expects: 'none',
      summary: 'Exact scheduler claim committed; admission floor honored',
      body: [{ text: 'Claim receipt belongs to this member. No widening, force, or reclassification.' }],
    })).toBeNull();
    // An unrelated write must not consume the one-shot warning for a subsequent real quote.
    expect(call('coord:send', 139_000, S, QUOTE)).toContain('state:read');
  });

  it.each([
    {},
    { body: [{ text: 'The scheduler admitted the exact bug; implementing its regression.' }] },
    { body: [{ text: 'Add tests for candidate sha, gate verdict, deploy sha, and main-behind-staging.' }] },
    { body: [{ text: 'Read state:read { cell: "gate.greenCheckpoint.verdict" } before reporting.' }] },
    { id: 'gate.greenCheckpoint.verdict', body: 'Document the freshness rule.' },
  ])('stays quiet when write content contains no transcribed pipeline value: %j', (args) => {
    call('dev:pipeline_position', 0);
    expect(call('coord:send', 5_000, S, args)).toBeNull();
  });

  it.each([
    { summary: 'Candidate sha abcdef1234567' },
    { body: [{ text: 'Gate verdict is green.' }] },
    { completion: { summary: 'Deploy sha is abcdef1234567.' } },
    { did: 'main-behind-staging = 4' },
    { body: 'git.mainBehindStaging: false' },
    { body: { gate: { verdict: 'red' }, candidate: { sha: 'abcdef1234567' } } },
    { body: { deploy: { sha: 'abcdef1234567' } } },
    { body: { mainBehindStaging: true } },
    { body: 'gate.greenCheckpoint.candidate: abcdef1234567' },
    { body: 'deploy.3070.sha = abcdef1234567' },
    { body: { deploy: { '3070': { sha: 'abcdef1234567' } } } },
  ])('still warns for an actual pipeline quote after a source-only read: %j', (args) => {
    call('dev:pipeline_position', 0, S, { path: 'apps/x.ts', sourceRuntimeOnly: true });
    expect(call('coord:send', 5_000, S, args)).toContain('state:read');
  });

  it('normalizes MCP names and tools:invoke wrappers without losing quote args', () => {
    call('mcp__papercusp_su__tools_invoke', 0, S, {
      name: 'dev:pipeline_position', args: { sourceRuntimeOnly: true, path: 'apps/x.ts' },
    });
    expect(call('mcp__papercusp_su__tools_invoke', 5_000, S, {
      name: 'coord:send', args: { summary: 'Claim admitted' },
    })).toBeNull();
    expect(call('mcp__papercusp_su__coord_send', 6_000, S, QUOTE)).toContain('state:read');
  });

  it('preserves re-read ordering through a tools:invoke-wrapped state:read after a source-only door', () => {
    call('dev:pipeline_position', 0, S, { path: 'apps/x.ts', sourceRuntimeOnly: true });
    call('tools:invoke', 2_000, S, { name: 'state:read', args: { cell: 'gate.greenCheckpoint.verdict' } });
    expect(call('tools:invoke', 5_000, S, { name: 'coord:send', args: QUOTE })).toBeNull();
  });

  it('stays total for cyclic or unreadable content without consuming the warning', () => {
    call('dev:pipeline_position', 0);
    const cycle: { body?: unknown } = {};
    cycle.body = cycle;
    expect(call('coord:send', 1_000, S, cycle)).toBeNull();
    const unreadable = { get body(): never { throw new Error('unreadable'); } };
    expect(call('coord:send', 2_000, S, unreadable)).toBeNull();
    expect(call('coord:send', 3_000, S, QUOTE)).toContain('state:read');
  });
});

describe('state-plane nudge — WAIT/POLL rule', () => {
  it('fires once a door is read across the threshold of separate turns', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('dev:pipeline_position', 60_000)).toBeNull();
    const hint = call('dev:pipeline_position', 120_000);
    expect(DOOR_POLL_TURN_THRESHOLD).toBe(3);
    expect(hint).toBeTruthy();
    expect(hint).toContain('state:subscribe');
  });

  it('does NOT count distinct pipeline source-containment probes as polling one predicate', () => {
    const probes = [
      { path: 'packages/operator-core/lib/dao-hr/native.e2e.test.ts', sourceRuntimeOnly: true },
      { path: 'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
        marker: 'synchronizeAcceptanceBarSubjectRevision', sourceRuntimeOnly: true },
      { path: 'packages/operator-core/lib/acceptance-bar-pin-reconcile.ts', sourceRuntimeOnly: true },
    ];
    for (const [index, args] of probes.entries()) {
      expect(call('dev:pipeline_position', index * 60_000, S, args)).toBeNull();
    }
  });

  it('still nudges when the same exact source-containment predicate repeats across turns', () => {
    const args = {
      path: 'packages/operator-core/lib/dao-hr/native.e2e.test.ts',
      expectedSourceSha256: 'a'.repeat(64),
      sourceRuntimeOnly: true,
    };
    expect(call('dev:pipeline_position', 0, S, args)).toBeNull();
    expect(call('dev:pipeline_position', 60_000, S, args)).toBeNull();
    expect(call('dev:pipeline_position', 120_000, S, args)).toContain('same dev:pipeline_position check');
  });

  it('does NOT treat calls batched into ONE turn as a poll loop', () => {
    // Calls dispatched from one response block cost a single round-trip. Nudging them
    // would punish exactly the batching behaviour the sibling nudge in this file asks for.
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('dev:pipeline_position', 50)).toBeNull();
    expect(call('dev:pipeline_position', 100)).toBeNull();
    expect(call('dev:pipeline_position', 150)).toBeNull();
  });

  it('stays QUIET when the agent already subscribed — it made the right call', () => {
    expect(call('state:subscribe', 0)).toBeNull();
    expect(call('dev:pipeline_position', 10_000)).toBeNull();
    expect(call('dev:pipeline_position', 70_000)).toBeNull();
    expect(call('dev:pipeline_position', 130_000)).toBeNull();
  });

  it('is one-shot per session', () => {
    call('dev:pipeline_position', 0);
    call('dev:pipeline_position', 60_000);
    expect(call('dev:pipeline_position', 120_000)).toBeTruthy();
    expect(call('dev:pipeline_position', 180_000)).toBeNull();
  });
});
