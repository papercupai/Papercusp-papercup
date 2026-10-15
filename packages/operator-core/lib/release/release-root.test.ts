import { describe, expect, it } from 'vitest';
import { describeReleaseRoot, resolveReleaseRoot } from './release-root';

// WI-10005161: the box's release checkout is a sibling of the tree agents EDIT, not of
// whichever checkout happens to be serving. :3170 serves a physical staging generation
// (95-bundled-entry exports `pwd -P`), whose sibling never holds a release checkout.
const STAGING_GENERATION =
  '/ws/papercusp-staging.generations/.candidate-ab679a25a55f.LcugsF/checkout';

describe('describeReleaseRoot', () => {
  it(':3070 shape — no declarations — derives the integration root sibling', () => {
    expect(describeReleaseRoot({ integrationRoot: '/ws/papercusp', env: {} })).toEqual({
      root: '/ws/papercup-release',
      source: 'integration-root-sibling',
    });
  });

  it(':3170 shape — the declared canonical edit tree anchors the release checkout, not the generation', () => {
    const got = describeReleaseRoot({
      integrationRoot: STAGING_GENERATION,
      env: { PAPERCUSP_CANONICAL_TREE: '/ws/papercusp' },
    });
    expect(got).toEqual({ root: '/ws/papercup-release', source: 'canonical-tree-sibling' });
    // The pre-fix derivation, kept as a calibration: it is exactly the path git could not cd into.
    expect(
      describeReleaseRoot({ integrationRoot: STAGING_GENERATION, env: {} }).root,
    ).toBe('/ws/papercusp-staging.generations/.candidate-ab679a25a55f.LcugsF/papercup-release');
  });

  it('PAPERCUSP_RELEASE_ROOT (bg-host declares it) beats the canonical-tree sibling', () => {
    expect(
      describeReleaseRoot({
        integrationRoot: STAGING_GENERATION,
        env: { PAPERCUSP_RELEASE_ROOT: '/ws/papercusp-release', PAPERCUSP_CANONICAL_TREE: '/ws/papercusp' },
      }),
    ).toEqual({ root: '/ws/papercusp-release', source: 'PAPERCUSP_RELEASE_ROOT' });
  });

  it('an explicit override beats every env declaration', () => {
    expect(
      describeReleaseRoot({
        integrationRoot: '/ws/papercusp',
        override: '/elsewhere/rel',
        env: { PAPERCUSP_RELEASE_ROOT: '/ws/papercusp-release', PAPERCUSP_CANONICAL_TREE: '/ws/papercusp' },
      }),
    ).toEqual({ root: '/elsewhere/rel', source: 'override' });
  });

  it('blank declarations are absent, not empty paths', () => {
    expect(
      describeReleaseRoot({
        integrationRoot: '/ws/papercusp',
        override: '   ',
        env: { PAPERCUSP_RELEASE_ROOT: '', PAPERCUSP_CANONICAL_TREE: '  ' },
      }),
    ).toEqual({ root: '/ws/papercup-release', source: 'integration-root-sibling' });
  });

  it('resolveReleaseRoot returns the same root', () => {
    expect(
      resolveReleaseRoot({ integrationRoot: STAGING_GENERATION, env: { PAPERCUSP_CANONICAL_TREE: '/ws/papercusp' } }),
    ).toBe('/ws/papercup-release');
  });
});
