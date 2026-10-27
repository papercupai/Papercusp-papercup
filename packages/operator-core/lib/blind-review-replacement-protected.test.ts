import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { replacementFixture } from './__tests__/_blind-review-replacement-fixture';

describe('recruiter replacement eligibility interleaving', () => {
  const fixture = () => replacementFixture(resolve(__dirname, '../../..'),
    'packages/operator-core/lib/blind-review-replacement-protected.test.ts');

  it.each(['inconclusive', 'conclusive', 'live', 'resuming', 'reserved'])('protected-state-interleaving-%s: rechecks eligibility after the brief while reservation is pending', async kind => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    f.deps.resolveImplementers = async () => { entered(); await barrier; return ['su-author']; };
    const request = f.run();
    await pending;
    expect(f.state.attempts).toEqual([]);
    if (kind === 'conclusive') { f.state.material.outcome = 'conclusive'; f.state.material.summary = 'CONCLUSIVE: reviewed'; }
    if (kind === 'live') f.state.ended = false;
    if (kind === 'resuming') f.state.sourceStatus = 'resuming';
    if (kind === 'reserved') f.state.resumeClaim = 'resume-active';
    release();
    if (kind === 'inconclusive') {
      expect(await request).toMatchObject({ ok: true, attempt: { status: 'ready' } });
      expect(f.launch).toHaveBeenCalledTimes(1);
    } else {
      expect(await request).toMatchObject({ ok: false, error: 'review_protected' });
      expect(f.state.attempts).toEqual([]);
      expect(f.launch).not.toHaveBeenCalled();
    }
  });
});

// EI-27120731037609627: a reviewer that registered and died while nobody watched its
// exit has no adv_sessions.ended_at. Positive terminal evidence closes it; anything
// weaker keeps the review protected.
describe('unobserved reviewer end', () => {
  const fixture = () => replacementFixture(resolve(__dirname, '../../..'),
    'packages/operator-core/lib/blind-review-replacement-protected.test.ts');

  it('unobserved-end-reconciled: closes a dead reviewer on terminal task evidence and replaces it', async () => {
    const f = fixture();
    f.state.ended = false;
    f.state.tasks = [{ state: 'ended_unobserved', session_id: 'native-original' }];
    expect(await f.run()).toMatchObject({ ok: true, attempt: { status: 'ready' } });
    expect(f.state.reconciledEnd).toBe(true);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['running-task', { tasks: [{ state: 'ended_unobserved', session_id: 'native-original' }, { state: 'running', session_id: 'native-original' }] }],
    ['live-host', { tasks: [{ state: 'ended_unobserved', session_id: 'native-original' }], liveHost: { pid: 4242 } }],
    ['other-session', { tasks: [{ state: 'exited', session_id: 'native-other' }] }],
    ['no-task', { tasks: [] }],
    ['unaccounted-task', { tasks: [{ state: 'unaccounted', session_id: 'native-original' }] }],
  ])('unobserved-end-protected-%s: refuses without positive terminal evidence', async (_kind, patch) => {
    const f = fixture();
    f.state.ended = false;
    Object.assign(f.state, patch);
    expect(await f.run()).toMatchObject({ ok: false, error: 'review_protected' });
    expect(f.state.reconciledEnd).toBe(false);
    expect(f.state.attempts).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
  });
});

// EI-27120299877087815: review #109 was told to call tools its own ceiling refuses, so it
// spent the review on capability_denied. The replacement path refuses such a howToRun
// before it opens the reservation transaction.
describe('howToRun outside the reviewer ceiling', () => {
  const fixture = () => replacementFixture(resolve(__dirname, '../../..'),
    'packages/operator-core/lib/blind-review-replacement-protected.test.ts');

  it('how-to-run-outside-ceiling: refuses before any reservation and launch', async () => {
    const f = fixture();
    const begin = vi.spyOn(f.sql, 'begin');
    expect(await f.run({ howToRun: 'Run the suite, then file findings with work_items:create.' }))
      .toMatchObject({ ok: false, error: 'how_to_run_outside_ceiling' });
    expect(begin).not.toHaveBeenCalled();
    expect(f.state.attempts).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('how-to-run-admitted: replaces when howToRun names only admitted tools', async () => {
    const f = fixture();
    expect(await f.run({ howToRun: 'Run the suite with testing:run, then read testing:run-status.' }))
      .toMatchObject({ ok: true, attempt: { status: 'ready' } });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});
