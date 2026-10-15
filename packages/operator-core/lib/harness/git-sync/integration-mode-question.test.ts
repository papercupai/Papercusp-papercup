import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_MODE_QUESTION,
  integrationModeQuestion,
  parseIntegrationModeAnswer,
} from './integration-mode-question';

describe('integrationModeQuestion (P-017, D-007 wording)', () => {
  it('renders the owner-approved question with the repo name substituted', () => {
    const q = integrationModeQuestion({ repoLabel: 'acme/widgets' });
    expect(q.prompt).toBe("Where should the agents' work go?");
    expect(q.prompt).toBe(INTEGRATION_MODE_QUESTION);
    expect(q.defaultValue).toBe('direct');
    expect(q.options.map((o) => o.value)).toEqual(['direct', 'review']);
    const [direct, review] = q.options;
    expect(direct.label).toBe('Straight into acme/widgets');
    expect(direct.description).toBe('Agents commit directly, as today.');
    expect(review.label).toBe('Into a working copy of acme/widgets');
    expect(review.description).toBe(
      'Agents work freely there, and their combined work reaches acme/widgets only through PRs you (or a reviewer) approve.',
    );
    expect(q.options.every((o) => o.available)).toBe(true);
  });

  it('exposes no low-level git settings — exactly two answers, no remote/branch fields', () => {
    const q = integrationModeQuestion({ repoLabel: 'acme/widgets' });
    for (const o of q.options) {
      expect(Object.keys(o).sort()).toEqual(['available', 'description', 'label', 'value']);
      expect(`${o.label} ${o.description}`).not.toMatch(/remote|branch|push|fork|hiveGit/i);
    }
  });

  it('makes the working copy unavailable, with a reason, when the pot has no test suite', () => {
    const q = integrationModeQuestion({ repoLabel: 'acme/widgets', hasTestSuite: false });
    const review = q.options.find((o) => o.value === 'review')!;
    expect(review.available).toBe(false);
    expect(review.unavailableReason).toMatch(/test suite/);
    expect(q.options.find((o) => o.value === 'direct')!.available).toBe(true);
  });

  it('P-014 / D-017 (WI-10006416): offers the working copy for a repo that uses submodules', () => {
    // Submodules are supported: choosing the working copy forks every submodule too.
    const q = integrationModeQuestion({ repoLabel: 'acme/widgets', hasTestSuite: true, hasSubmodules: true });
    const review = q.options.find((o) => o.value === 'review')!;
    expect(review.available).toBe(true);
    expect(review.unavailableReason).toBeUndefined();
    expect(q.defaultValue).toBe('direct');
    expect(q.blocked).toBeUndefined();
  });

  it('falls back to a generic repo name when the label is blank', () => {
    const q = integrationModeQuestion({ repoLabel: '  ' });
    expect(q.options[0].label).toBe('Straight into the main repository');
  });

  it('parses only known answers', () => {
    expect(parseIntegrationModeAnswer('direct')).toBe('direct');
    expect(parseIntegrationModeAnswer('review')).toBe('review');
    for (const v of ['Review', 'working-copy', '', null, undefined, 1]) expect(parseIntegrationModeAnswer(v)).toBeNull();
  });
});
