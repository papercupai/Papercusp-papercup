import { describe, expect, it } from 'vitest';

import type { OpenCardSnapshot, CardPresentation } from '@papercusp/agent-mcp';

import { composeAmbiguityPrompt } from './compose-ambiguity-prompt';
import {
  attachActive,
  clearActive,
  createRouterState,
  expirePending,
  markPending,
  MAX_AMBIGUITY_ROUNDS,
  PRE_CARD_GRACE_MS,
  resetRouter,
  routeTranscript,
} from './voice-card-router';

function card(presentation: CardPresentation | undefined): OpenCardSnapshot {
  return {
    correlationId: 'cid-x',
    prompt: 'pick',
    dataSchemaJson: {},
    presentation,
    createdAt: 100,
  };
}

const yesNo: CardPresentation = {
  kind: 'radio',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
};

const apples: CardPresentation = {
  kind: 'radio',
  options: [
    { id: 'apple_red', label: 'Red apple' },
    { id: 'apple_green', label: 'Green apple' },
  ],
};

describe('voice-card-router — no active, no pending', () => {
  it('fall_through when nothing armed', () => {
    const state = createRouterState();
    expect(
      routeTranscript(state, { text: 'yes', tsMs: 1 }, composeAmbiguityPrompt).kind,
    ).toBe('fall_through');
  });
});

describe('voice-card-router — active', () => {
  it.each([['yes', 'submit'], ['cancel', 'decline']])('retains owning card scope on %s after clearing active state', (text, kind) => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'original-card', runId: 'original-run',
      conversationId: 'original-conversation', workspaceId: 'original-workspace', card: card(yesNo) });
    expect(routeTranscript(state, { text, tsMs: 200 }, composeAmbiguityPrompt)).toMatchObject({
      kind, conversationId: 'original-conversation', workspaceId: 'original-workspace',
      correlationId: 'original-card', runId: 'original-run',
    });
    expect(state.active).toBeNull();
  });
  it('submit on exact id match', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c1', runId: 'r1', card: card(yesNo) });
    const out = routeTranscript(state, { text: 'yes', tsMs: 200 }, composeAmbiguityPrompt);
    expect(out).toMatchObject({ kind: 'submit', correlationId: 'c1', runId: 'r1' });
    if (out.kind === 'submit') expect(out.payload.picks).toEqual(['yes']);
    expect(state.active).toBeNull();
  });

  it('decline on phrase', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c1', runId: 'r1', card: card(yesNo) });
    const out = routeTranscript(state, { text: 'cancel', tsMs: 200 }, composeAmbiguityPrompt);
    expect(out).toMatchObject({ kind: 'decline', correlationId: 'c1', runId: 'r1' });
    expect(state.active).toBeNull();
  });

  it('null match → fall_through, active stays armed', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c1', runId: 'r1', card: card(yesNo) });
    const out = routeTranscript(
      state,
      { text: 'what time is it', tsMs: 200 },
      composeAmbiguityPrompt,
    );
    expect(out.kind).toBe('fall_through');
    expect(state.active).not.toBeNull();
  });

  it('ambiguous emits disambiguation prompt, counter increments', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c1', runId: 'r1', card: card(apples) });
    const out = routeTranscript(state, { text: 'apple', tsMs: 200 }, composeAmbiguityPrompt);
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.round).toBe(1);
      expect(out.prompt).toBe('Did you mean Red apple, or Green apple?');
    }
    expect(state.active).not.toBeNull();
    expect(state.ambiguityRounds).toBe(1);
  });

  it('max 2 disambiguation rounds, then fall_through', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c1', runId: 'r1', card: card(apples) });
    for (let i = 0; i < MAX_AMBIGUITY_ROUNDS; i++) {
      const out = routeTranscript(state, { text: 'apple', tsMs: 100 + i }, composeAmbiguityPrompt);
      expect(out.kind).toBe('ambiguous');
    }
    // Round 3 → fall_through; active not cleared (lifecycle owns that).
    const out3 = routeTranscript(state, { text: 'apple', tsMs: 999 }, composeAmbiguityPrompt);
    expect(out3.kind).toBe('fall_through');
    expect(state.active).not.toBeNull();
  });
});

describe('voice-card-router — pending / snapshot race', () => {
  it('transcript while pending → buffered', () => {
    const state = createRouterState();
    markPending(state, 100);
    const out = routeTranscript(state, { text: 'yes', tsMs: 150 }, composeAmbiguityPrompt);
    expect(out.kind).toBe('buffered');
    expect(state.buffer.length).toBe(1);
  });

  it('transcript older than pending arming by > grace → fall_through (pre-card)', () => {
    const state = createRouterState();
    markPending(state, 1000);
    const out = routeTranscript(
      state,
      { text: 'yes', tsMs: 1000 - PRE_CARD_GRACE_MS - 1 },
      composeAmbiguityPrompt,
    );
    expect(out.kind).toBe('fall_through');
    expect(state.buffer.length).toBe(0);
  });

  it('attachActive drains buffer, returns transcripts in order', () => {
    const state = createRouterState();
    markPending(state, 100);
    routeTranscript(state, { text: 'yes', tsMs: 150 }, composeAmbiguityPrompt);
    routeTranscript(state, { text: 'no', tsMs: 160 }, composeAmbiguityPrompt);
    const drained = attachActive(state, {
      correlationId: 'c1', runId: 'r1', card: card(yesNo),
    });
    expect(drained.map((t) => t.text)).toEqual(['yes', 'no']);
    expect(state.buffer.length).toBe(0);
    expect(state.pendingObservedAtMs).toBeNull();
    expect(state.active?.correlationId).toBe('c1');
  });

  it('expirePending drains buffer and clears pending', () => {
    const state = createRouterState();
    markPending(state, 100);
    routeTranscript(state, { text: 'late', tsMs: 200 }, composeAmbiguityPrompt);
    const drained = expirePending(state);
    expect(drained.map((t) => t.text)).toEqual(['late']);
    expect(state.pendingObservedAtMs).toBeNull();
    expect(state.buffer.length).toBe(0);
  });
});

describe('voice-card-router — lifecycle', () => {
  it('clearActive resets active + rounds, leaves buffer alone', () => {
    const state = createRouterState();
    attachActive(state, { correlationId: 'c', runId: 'r', card: card(yesNo) });
    state.ambiguityRounds = 1;
    clearActive(state);
    expect(state.active).toBeNull();
    expect(state.ambiguityRounds).toBe(0);
  });

  it('resetRouter clears everything', () => {
    const state = createRouterState();
    markPending(state, 100);
    routeTranscript(state, { text: 'x', tsMs: 150 }, composeAmbiguityPrompt);
    attachActive(state, { correlationId: 'c', runId: 'r', card: card(yesNo) });
    state.ambiguityRounds = 1;
    resetRouter(state);
    expect(state.pendingObservedAtMs).toBeNull();
    expect(state.active).toBeNull();
    expect(state.buffer.length).toBe(0);
    expect(state.ambiguityRounds).toBe(0);
  });
});
