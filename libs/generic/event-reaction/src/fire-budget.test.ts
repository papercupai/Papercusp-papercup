/**
 * The per-contributor fire budget port (identities-v1 P-030 (c)), at the engine
 * layer: routing, fail-open, and the surfacing contract. The POLICY (window,
 * threshold, ledger) is the host's and is tested in
 * `packages/operator-core/lib/events/reaction-fire-budget.test.ts`.
 *
 * Deliberately a separate file from `engine.test.ts`: these cases are about one
 * optional port, and the durable case below is a REGRESSION GUARD that should be
 * findable by name rather than buried in the engine's general suite.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  scheduleReaction,
  type DurableSeam,
  type FireBudget,
  type FireInProcess,
  type OnReactionFailure,
} from './engine';
import type { ReactionCause, ReactionRule } from './types';

interface TestEvent {
  kind: string;
  item?: string;
}

const CAUSE: ReactionCause = { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'run-1' };

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(rule: Partial<ReactionRule<TestEvent>> = {}) {
  const fireInProcess = vi.fn<FireInProcess<TestEvent>>(async () => ({ ok: true }));
  const onFailure = vi.fn<OnReactionFailure<TestEvent>>(() => {});
  const log = vi.fn<(m: string) => void>();
  const durableRun = vi.fn<DurableSeam<TestEvent>['run']>(async () => {});

  const schedule = (budget?: FireBudget<TestEvent>, durable?: DurableSeam<TestEvent>) =>
    scheduleReaction<TestEvent>({
      // A CONTRIBUTED rule by default: capability-scoped, as every plugin/standalone
      // install path registers one. First-party cases override `capability` away.
      rule: { id: 'r1', on: 'demo:tool', fire: 'sink:tool', source: 'plugin:acme', capability: 'plugin:acme', ...rule },
      fire: 'sink:tool',
      args: { echoed: 'WI-1' },
      event: { kind: 'demo:tool', item: 'WI-1' },
      cause: CAUSE,
      fireInProcess,
      durable,
      log,
      onFailure,
      budget,
    });

  return { fireInProcess, onFailure, log, durableRun, schedule };
}

describe('scheduleReaction — per-contributor fire budget (P-030 c)', () => {
  it('fires the reaction when the budget allows it, and passes the contributor as the key', async () => {
    const h = harness();
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: true }));

    await h.schedule(budget);
    await flush();

    expect(budget).toHaveBeenCalledOnce();
    // A contributed rule's `source` IS the budget key — a host that keys on
    // anything else budgets the wrong thing entirely.
    expect(budget).toHaveBeenCalledWith(expect.objectContaining({ contributor: 'plugin:acme' }));
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.onFailure).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD (WI-10005204): first-party rules carry a provenance `source`
  // too. Keying on it put every same-label built-in into one shared 500/60m bucket
  // and made the host count its ledger on every built-in fire (~157/s live from the
  // cache-tag ECA rule, source 'events-file').
  it('passes contributor:null for a first-party rule even when it carries a provenance source', async () => {
    const h = harness({ source: 'events-file', capability: undefined });
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: true }));

    await h.schedule(budget);
    await flush();

    expect(budget).toHaveBeenCalledWith(expect.objectContaining({ contributor: null }));
    expect(h.fireInProcess).toHaveBeenCalledOnce();
  });

  it('never leaves a contributed rule unbudgeted: no source falls back to its rule id', async () => {
    const h = harness({ source: undefined });
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: true }));

    await h.schedule(budget);
    await flush();

    expect(budget).toHaveBeenCalledWith(expect.objectContaining({ contributor: 'rule:r1' }));
  });

  it('passes contributor:null for a first-party rule that declares no source', async () => {
    const h = harness({ source: undefined, capability: undefined });
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: true }));

    await h.schedule(budget);
    await flush();

    expect(budget).toHaveBeenCalledWith(expect.objectContaining({ contributor: null }));
  });

  it('DENIES: does not fire, and surfaces the refusal as stage "budget" carrying the reason', async () => {
    const h = harness();
    const reason = 'contributor "plugin:acme" has fired 500 reactions in the last 60m';
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: false, reason }));

    await h.schedule(budget);
    await flush();

    expect(h.fireInProcess).not.toHaveBeenCalled();
    // A deliberate policy drop is still ANSWERABLE — it goes out the same failure
    // port as a real failure, distinguished only by `stage` (ruling D).
    expect(h.onFailure).toHaveBeenCalledOnce();
    expect(h.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'budget', error: reason }),
    );
  });

  it('a denied reaction still carries the dedup id, so the drop correlates with the ledger row', async () => {
    const h = harness();
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: false, reason: 'over budget' }));

    await h.schedule(budget);
    await flush();

    expect(h.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ dedupId: expect.any(String) as unknown as string }),
    );
  });

  /**
   * THE REGRESSION THAT MATTERS (ruling B).
   *
   * `rule.mode ?? 'durable'` means DURABLE IS THE DEFAULT ROUTE. A budget applied
   * around `fireInProcess` — the obvious place, since that is where the reaction
   * visibly happens — would leave almost every real rule unbudgeted while looking
   * correct and passing every in-process test above. This is the ONLY case that
   * fails if the check is moved below the durable/in-process split.
   */
  it('budgets the DURABLE route too: a denied mode:"durable" rule never reaches the durable seam', async () => {
    const h = harness({ mode: 'durable' });
    const durable: DurableSeam<TestEvent> = { enabled: () => true, run: h.durableRun };
    const budget = vi.fn<FireBudget<TestEvent>>(async () => ({ allow: false, reason: 'over budget' }));

    await h.schedule(budget, durable);
    await flush();

    expect(h.durableRun).not.toHaveBeenCalled();
    expect(h.fireInProcess).not.toHaveBeenCalled();
    expect(h.onFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: 'budget' }));
  });

  it('FAILS OPEN: a throwing budget port allows the reaction and is not reported as a failure', async () => {
    const h = harness();
    const budget = vi.fn<FireBudget<TestEvent>>(async () => {
      throw new Error('ledger unreachable');
    });

    await h.schedule(budget);
    await flush();

    // A fairness control must not become a system-wide reaction outage; the depth
    // cap already bounds the catastrophic case (ruling C).
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.onFailure).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('fire budget'));
  });

  it('is OPTIONAL: with no budget port the reaction fires unchanged', async () => {
    const h = harness();

    await h.schedule(undefined);
    await flush();

    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.onFailure).not.toHaveBeenCalled();
  });
});
