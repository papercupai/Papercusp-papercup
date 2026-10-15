/**
 * decidePrDelivery — the fail-closed review-mode precondition for PR-required admission rules
 * (slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-013, D-015). Every non-ready shape
 * refuses with a named code; only a governed harness of a review-mode pot WITH a fork passes.
 */
import { describe, expect, it } from 'vitest';
import { checkPrDelivery, decidePrDelivery, type PrDeliveryRegistryEntry } from './pr-delivery';
import type { PotIntegrationModeRead } from '../harness/git-sync/pot-integration-mode';

const FORK = 'https://github.com/papercusp-agents/subject.git';
const review: PotIntegrationModeRead = { mode: 'review', source: 'set' };
const member: PrDeliveryRegistryEntry = { slug: 'subject', hive_slug: 'subject-pot', fork_remote: FORK };
const home: PrDeliveryRegistryEntry = { slug: 'subject-pot', self_repo: true };

describe('decidePrDelivery', () => {
  it('allows a pot member in review mode with a fork, naming the fork it will push to', () => {
    expect(decidePrDelivery({ harness: 'subject', projects: [member, home], read: review })).toEqual({
      ok: true,
      potHomeSlug: 'subject-pot',
      forkRemote: FORK,
    });
  });

  it('refuses a pot in direct mode, explicit or default — the #1748 drift shape', () => {
    for (const read of [{ mode: 'direct', source: 'set' }, { mode: 'direct', source: 'absent' }] as PotIntegrationModeRead[]) {
      const v = decidePrDelivery({ harness: 'subject', projects: [member, home], read });
      expect(v).toMatchObject({ ok: false, code: 'pr_delivery_requires_review_mode' });
      expect(!v.ok && v.message).toMatch(/straight to the main repository/);
    }
  });

  it('refuses an unreadable or malformed mode instead of assuming either answer', () => {
    for (const source of ['error', 'malformed'] as const) {
      expect(decidePrDelivery({ harness: 'subject', projects: [member, home], read: { mode: 'direct', source } })).toMatchObject({
        ok: false,
        code: 'pr_delivery_mode_unreadable',
      });
    }
  });

  it('refuses review mode without a fork: the fix could never reach a PR', () => {
    const noFork = { ...member, fork_remote: undefined };
    expect(decidePrDelivery({ harness: 'subject', projects: [noFork, home], read: review })).toMatchObject({
      ok: false,
      code: 'pr_delivery_fork_missing',
    });
  });

  it("refuses the pot's own metadata repository when the working copy lives on a member", () => {
    expect(decidePrDelivery({ harness: 'subject-pot', projects: [member, home], read: review })).toMatchObject({
      ok: false,
      code: 'pr_delivery_requires_review_mode',
    });
  });

  it('refuses a harness that belongs to no pot, and an unknown harness', () => {
    const loose: PrDeliveryRegistryEntry = { slug: 'loose', fork_remote: FORK };
    expect(decidePrDelivery({ harness: 'loose', projects: [loose], read: undefined })).toMatchObject({
      ok: false,
      code: 'pr_delivery_requires_review_mode',
    });
    expect(decidePrDelivery({ harness: 'nope', projects: [member], read: review })).toMatchObject({
      ok: false,
      code: 'pr_delivery_unknown_harness',
    });
  });

  it('names the next action in every refusal, including the submodule limitation', () => {
    const v = decidePrDelivery({ harness: 'subject', projects: [member, home], read: { mode: 'direct', source: 'set' } });
    expect(!v.ok && v.message).toMatch(/working-copy \(review\) mode with a fork configured/);
    expect(!v.ok && v.message).toMatch(/WI-10006416/);
  });
});

describe('checkPrDelivery', () => {
  it('reads the mode of the harness pot home and refuses when the registry cannot be read', async () => {
    const seen: string[] = [];
    const ok = await checkPrDelivery('ws', 'subject', {
      deps: { loadProjects: async () => [member, home], readMode: async (_ws, pot) => (seen.push(pot), review) },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(seen).toEqual(['subject-pot']);

    const broken = await checkPrDelivery('ws', 'subject', {
      deps: {
        loadProjects: async () => {
          throw new Error('registry down');
        },
        readMode: async () => review,
      },
    });
    expect(broken).toMatchObject({ ok: false, code: 'pr_delivery_mode_unreadable' });
  });
});
