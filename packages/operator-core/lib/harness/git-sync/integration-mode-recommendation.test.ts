/**
 * P-018 (pot-review-integration-mode-2026-10-05): every recommendation rule,
 * the lock, the no-test-suite fallbacks and the workspace-default fallback.
 */
import { describe, it, expect } from 'vitest';
import { recommendIntegrationMode } from './integration-mode-recommendation';
import { integrationModeQuestion } from './integration-mode-question';
import type { RepoIntegrationFacts } from '../github-repo-permissions';

const UNKNOWN: RepoIntegrationFacts = {
  canWrite: null,
  isPrivate: null,
  defaultBranch: null,
  mainRequiresPr: null,
  otherCommitters: null,
  hasCi: null,
};
const repoLabel = 'acme/widgets';
const f = (over: Partial<RepoIntegrationFacts>): RepoIntegrationFacts => ({ ...UNKNOWN, canWrite: true, ...over });

describe('recommendIntegrationMode', () => {
  it('no write access → working copy, LOCKED, with a one-line reason naming the repo', () => {
    const r = recommendIntegrationMode(f({ canWrite: false }), { repoLabel });
    expect(r).toMatchObject({ recommended: 'review', locked: true, rule: 'no-write-access' });
    expect(r.reason).toContain("can't push to acme/widgets");
    expect(r.reason.split('\n')).toHaveLength(1);
    expect(r.blocked).toBeUndefined();
  });

  it('no write access beats every other fact, including a private sole-committer repo', () => {
    const r = recommendIntegrationMode(f({ canWrite: false, isPrivate: true, otherCommitters: false }), { repoLabel, policyDefault: 'direct' });
    expect(r).toMatchObject({ recommended: 'review', locked: true });
  });

  it('protected / PR-required main → recommend working copy (not locked)', () => {
    const r = recommendIntegrationMode(f({ mainRequiresPr: true, defaultBranch: 'trunk' }), { repoLabel });
    expect(r).toMatchObject({ recommended: 'review', locked: false, rule: 'main-requires-pr' });
    expect(r.reason).toContain('trunk');
  });

  it('other committers → recommend working copy', () => {
    expect(recommendIntegrationMode(f({ otherCommitters: true }), { repoLabel })).toMatchObject({
      recommended: 'review', locked: false, rule: 'other-committers',
    });
  });

  it('CI / deploy workflows → recommend working copy', () => {
    expect(recommendIntegrationMode(f({ hasCi: true, otherCommitters: false }), { repoLabel })).toMatchObject({
      recommended: 'review', locked: false, rule: 'has-ci',
    });
  });

  it('private repo with you as the sole committer → recommend straight in', () => {
    expect(recommendIntegrationMode(f({ isPrivate: true, otherCommitters: false, hasCi: false }), { repoLabel, policyDefault: 'review' })).toMatchObject({
      recommended: 'direct', locked: false, rule: 'private-sole-committer',
    });
  });

  it('nothing decisive → the workspace default, else straight in', () => {
    expect(recommendIntegrationMode(UNKNOWN, { repoLabel, policyDefault: 'review' })).toMatchObject({ recommended: 'review', rule: 'workspace-default' });
    expect(recommendIntegrationMode(UNKNOWN, { repoLabel, policyDefault: 'direct' })).toMatchObject({ recommended: 'direct', rule: 'workspace-default' });
    expect(recommendIntegrationMode(null, { repoLabel })).toMatchObject({ recommended: 'direct', locked: false, rule: 'fallback' });
    // An invalid configured default is ignored, not trusted.
    expect(recommendIntegrationMode(null, { repoLabel, policyDefault: 'yolo' as never })).toMatchObject({ rule: 'fallback' });
  });

  it('no test suite: an unlocked working-copy recommendation falls back to straight in and says why', () => {
    const r = recommendIntegrationMode(f({ otherCommitters: true }), { repoLabel, hasTestSuite: false });
    expect(r).toMatchObject({ recommended: 'direct', locked: false, rule: 'other-committers' });
    expect(r.reason).toContain('no test suite');
  });

  it('no write access AND no test suite: locked, and blocked with both reasons', () => {
    const r = recommendIntegrationMode(f({ canWrite: false }), { repoLabel, hasTestSuite: false });
    expect(r.locked).toBe(true);
    expect(r.blocked).toContain("can't push");
    expect(r.blocked).toContain('no test suite');
  });
});

describe('integrationModeQuestion with a recommendation', () => {
  it('marks the recommended option', () => {
    const q = integrationModeQuestion({ repoLabel, recommendation: recommendIntegrationMode(f({ otherCommitters: true }), { repoLabel }) });
    expect(q.options.find((o) => o.value === 'review')?.recommended).toBe(true);
    expect(q.options.find((o) => o.value === 'direct')?.recommended).toBeUndefined();
    // An unlocked recommendation leaves both choosable and the unanswered default unchanged.
    expect(q.options.every((o) => o.available)).toBe(true);
    expect(q.defaultValue).toBe('direct');
  });

  it('a lock disables the other option with the lock reason and defaults to the locked answer', () => {
    const rec = recommendIntegrationMode(f({ canWrite: false }), { repoLabel });
    const q = integrationModeQuestion({ repoLabel, recommendation: rec });
    const direct = q.options.find((o) => o.value === 'direct')!;
    expect(direct.available).toBe(false);
    expect(direct.unavailableReason).toBe(rec.reason);
    expect(q.defaultValue).toBe('review');
    expect(q.blocked).toBeUndefined();
  });

  it('lock + no test suite: no option is choosable and the question is blocked', () => {
    const rec = recommendIntegrationMode(f({ canWrite: false }), { repoLabel, hasTestSuite: false });
    const q = integrationModeQuestion({ repoLabel, hasTestSuite: false, recommendation: rec });
    expect(q.options.every((o) => !o.available)).toBe(true);
    expect(q.blocked).toBe(rec.blocked);
  });

  it('the workspace default is the unanswered default, unless that option is unavailable', () => {
    expect(integrationModeQuestion({ repoLabel, defaultMode: 'review' }).defaultValue).toBe('review');
    expect(integrationModeQuestion({ repoLabel, defaultMode: 'review', hasTestSuite: false }).defaultValue).toBe('direct');
    expect(integrationModeQuestion({ repoLabel }).defaultValue).toBe('direct');
  });
});
