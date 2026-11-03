import { describe, expect, it } from 'vitest';
import docsAuthor from '../docs/author';
import plansGet from '../plans/get';
import { harnessArg } from '../_harness-scope';

describe('workspace-scoped harness guidance (EI-9247)', () => {
  it('directs scoped superusers to a concrete harness and reserves all for unscoped sessions', () => {
    const descriptions = [
      docsAuthor.args.shape.harness.description,
      plansGet.description,
      plansGet.guidance?.when,
      harnessArg.description,
    ];

    for (const description of descriptions) {
      expect(description).toContain('papercusp');
      expect(description).toContain('unscoped');
      expect(description).toContain('--all-workspaces');
    }
  });
});
