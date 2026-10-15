/**
 * The plan/rubric/recipe Cupboard round-trip contract
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-016).
 *
 * These tests deliberately invoke every new publish/install core. The earlier
 * P-016 gate only exercised serializers and kind-generic helpers; a green lane
 * therefore could not detect a broken new-kind entrypoint. Each case below crosses
 * the real self-describing store boundary on a hermetic PAPERCUSP_HOME, while git,
 * GitHub metadata, and the public listing write remain dependency seams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import type { CodeRecipeRow } from '../code-recipes-store';
import type { RecipeAuthorityDescriptor, RecipeAuthorityRefs } from '../recipe-authority';

const external = vi.hoisted(() => ({
  publishListingToCupboard: vi.fn(),
  parseGithubRemote: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
  getRubric: vi.fn(),
  defaultReleaseSigner: vi.fn(),
}));

vi.mock('./publish-listing', () => ({
  publishListingToCupboard: external.publishListingToCupboard,
}));
vi.mock('./blueprint-release-signer', async (orig) => ({
  ...(await orig<typeof import('./blueprint-release-signer')>()),
  defaultReleaseSigner: external.defaultReleaseSigner,
}));

vi.mock('./resolve-repo-coords', () => ({
  parseGithubRemote: external.parseGithubRemote,
  fetchGithubRepoMeta: external.fetchGithubRepoMeta,
}));

vi.mock('../rubrics', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRubric: external.getRubric,
}));

import { publishRubricToCupboard } from './publish-rubric-core';
import { installRubricFromCupboardCore } from './install-rubric-core';
import { publishPlanToCupboard } from './publish-plan-core';
import { installPlanFromCupboardCore } from './install-plan-core';
import { publishRecipeToCupboard } from './publish-recipe-core';
import { installRecipeFromCupboardCore } from './install-recipe-core';

let root: string;
let previousPapercuspHome: string | undefined;

const GITHUB_URL = 'https://github.com/acme/cupboard-library';

const RUBRIC_CRITERION = {
  key: 'round-trip',
  title: 'Round-trips',
  model: 'Published content can be installed without losing its contract.',
  method: 'Publish the fixture, install its mirror-repo directory, and compare the resolved fields.',
  driftMarkers: 'A publisher or installer returns success while omitting the manifest contract.',
};

function rubricManifest(rubricId: string): Record<string, unknown> {
  return {
    rubricId,
    title: `Rubric ${rubricId}`,
    characteristic: 'cupboard-round-trip',
    description: 'Grades the Cupboard round trip.',
    ratingScale: ['pass', 'partial', 'fail', 'unknown'],
    methodRef: rubricId,
    criteria: [RUBRIC_CRITERION],
    version: '1.0.0',
    source: 'installed',
  };
}

function livePlanMarkdown(slug = 'publish-plan-source'): string {
  return `---
title: Publish plan source
slug: ${slug}
status: active
created: 2026-08-21
updated: 2026-08-21
---

# Publish plan source

The template preserves this outcome prose while removing live execution state.

## Phase 1 — build

- **P-001** \`done\` Build the portable thing — note: completed as WI-1234

## Decisions

### D-001 — Grade the feature ship

Use plan-class-feature-ship for acceptance.
`;
}

function templatePlanMarkdown(slug: string): string {
  return `---
title: Installed plan template
slug: ${slug}
status: draft
---

# Installed plan template

This plan is inert until instantiated.

## Phase 1 — build

- **P-001** \`todo\` Build the portable thing
`;
}

const EMPTY_REFS: RecipeAuthorityRefs = {
  workspaces: [],
  fleets: [],
  plans: [],
  harnesses: [],
  items: [],
  resources: [],
};

const PORTABLE_AUTHORITY: RecipeAuthorityDescriptor = {
  refs: EMPTY_REFS,
  unresolved: false,
  unresolvedCause: null,
  bound: false,
};

const RECIPE_ROW = {
  id: 'publish-recipe-source',
  title: 'Publish recipe source',
  description: 'Runs a portable Cupboard recipe.',
  script: 'const rows = await tools.work_items_list({ limit: 1 }); return rows;',
  toolsUsed: ['work_items:list'],
  tags: ['cupboard'],
} as unknown as CodeRecipeRow;

async function writeRubricDir(parent: string, ref: string): Promise<string> {
  const dir = join(parent, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'rubric.json'), `${JSON.stringify(rubricManifest(ref), null, 2)}\n`, 'utf8');
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'rubric', version: '1.0.0' })}\n`, 'utf8');
  await fs.writeFile(join(dir, 'METHOD.md'), '# Round-trip method\n', 'utf8');
  return dir;
}

async function writePlanDir(parent: string, ref: string): Promise<string> {
  const dir = join(parent, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'plan.md'), templatePlanMarkdown(ref), 'utf8');
  await fs.writeFile(
    join(dir, 'listing.json'),
    `${JSON.stringify({ kind: 'plan', version: '1.0.0', requires_rubrics: [{ rubricRef: 'plan-class-feature-ship' }] })}\n`,
    'utf8',
  );
  return dir;
}

async function writeRecipeDir(parent: string, ref: string): Promise<string> {
  const dir = join(parent, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'recipe.json'),
    `${JSON.stringify(
      {
        id: ref,
        title: `Recipe ${ref}`,
        description: 'Installed recipe fixture.',
        script: 'return await tools.work_items_list({ limit: 1 });',
        toolsUsed: ['work_items:list'],
        tags: ['cupboard'],
        authorityUnresolved: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'recipe', version: '1.0.0' })}\n`, 'utf8');
  return dir;
}

function cloneFixture(repo: string): (url: string, dest: string) => Promise<void> {
  return async (_url, dest) => {
    await fs.cp(repo, dest, { recursive: true });
  };
}

/** Install deps for an UNPINNED roundtrip: only the tip-clone path may run. The pin
 *  legs throw so a core that starts fetching-by-SHA without a pin fails here loudly
 *  instead of silently copying the fixture (the pinned path has its own suite in
 *  install-self-describing-core.test.ts). */
function unpinnedDeps(repo: string, root: string) {
  return {
    cloneRepo: cloneFixture(repo),
    fetchAtSha: async (): Promise<void> => {
      throw new Error('unpinned roundtrip: fetchAtSha must not be called');
    },
    listTreeBlobs: async (): Promise<never> => {
      throw new Error('unpinned roundtrip: listTreeBlobs must not be called');
    },
    tmpDir: () => root,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cupboard-judgment-roundtrip-'));
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = root;
  _resetPapercuspRootForTests();

  external.publishListingToCupboard.mockReset();
  external.publishListingToCupboard.mockResolvedValue({ ok: true, data: { id: 'listing-1' } });
  external.parseGithubRemote.mockReset();
  external.parseGithubRemote.mockReturnValue({ owner: 'acme', repo: 'cupboard-library' });
  external.fetchGithubRepoMeta.mockReset();
  external.fetchGithubRepoMeta.mockResolvedValue({
    id: 4242,
    html_url: GITHUB_URL,
  });
  external.getRubric.mockReset();
  external.getRubric.mockResolvedValue({ status: 'active', ratifiedBy: 'reviewer@example.com' });
  const keypair = generateEd25519KeypairDer();
  external.defaultReleaseSigner.mockReset();
  external.defaultReleaseSigner.mockResolvedValue({
    githubUserId: 42,
    githubLogin: 'fixture-publisher',
    devicePubkey: keypair.pubkeyBase64,
    sign: async (bytes: Buffer) => signWithPrivateKeyDer(keypair.privateKeyDer, bytes),
  });
});

afterEach(async () => {
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('rubric Cupboard round trip', () => {
  it('surfaces a signing refusal before publishing the local release', async () => {
    await writeRubricDir(join(root, 'rubrics'), 'publish-rubric');
    external.defaultReleaseSigner.mockRejectedValueOnce(new Error('fixture signing identity unavailable'));
    const result = await publishRubricToCupboard({ ref: 'publish-rubric', github_url: GITHUB_URL });
    expect(result).toMatchObject({ ok: false, detail: 'fixture signing identity unavailable' });
    expect(external.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('publishes a local rubric as a rubric listing', async () => {
    await writeRubricDir(join(root, 'rubrics'), 'publish-rubric');

    const result = await publishRubricToCupboard({
      ref: 'publish-rubric',
      github_url: GITHUB_URL,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, listing: { id: 'listing-1' } });
    expect(external.publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'rubric',
        listing_ref: 'publish-rubric',
        title: 'Rubric publish-rubric',
      }),
    );
  });

  it('refuses to publish when the authoritative rubric source is missing', async () => {
    external.getRubric.mockResolvedValue(null);

    const result = await publishRubricToCupboard({ ref: 'missing-rubric', github_url: GITHUB_URL });

    expect(result).toMatchObject({ ok: false, status: 404, error: 'rubric "missing-rubric" not found' });
    expect(external.fetchGithubRepoMeta).not.toHaveBeenCalled();
    expect(external.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('refuses to publish an inactive authoritative rubric', async () => {
    external.getRubric.mockResolvedValue({ status: 'proposed', ratifiedBy: 'reviewer@example.com' });

    const result = await publishRubricToCupboard({ ref: 'proposed-rubric', github_url: GITHUB_URL });

    expect(result).toMatchObject({ ok: false, status: 409, error: 'rubric "proposed-rubric" is not active' });
    expect(external.fetchGithubRepoMeta).not.toHaveBeenCalled();
    expect(external.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('refuses to publish an active rubric without ratification', async () => {
    external.getRubric.mockResolvedValue({ status: 'active', ratifiedBy: '  ' });

    const result = await publishRubricToCupboard({ ref: 'unratified-rubric', github_url: GITHUB_URL });

    expect(result).toMatchObject({ ok: false, status: 409, error: 'rubric "unratified-rubric" is not ratified' });
    expect(external.fetchGithubRepoMeta).not.toHaveBeenCalled();
    expect(external.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('installs and resolves a rubric self-describing directory', async () => {
    const repo = join(root, 'rubric-repo');
    await writeRubricDir(repo, 'install-rubric');

    const result = await installRubricFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'install-rubric' },
      unpinnedDeps(repo, root),
    );

    expect(result).toMatchObject({
      ok: true,
      ref: 'install-rubric',
      rubricId: 'install-rubric',
      hasMethod: true,
      source: GITHUB_URL,
    });
    expect(await fs.readFile(join(root, 'rubrics', 'install-rubric', 'METHOD.md'), 'utf8')).toContain(
      'Round-trip method',
    );
  });
});

describe('plan Cupboard round trip', () => {
  it('sanitizes, materializes, and publishes a plan listing with rubric dependencies', async () => {
    const result = await publishPlanToCupboard(
      {
        slug: 'publish-plan-source',
        listing_ref: 'publish-plan',
        github_url: GITHUB_URL,
      },
      async () => ({ content: livePlanMarkdown(), title: 'Publish plan source' }),
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, exportedOnly: false, listing: { id: 'listing-1' } });
    expect(external.publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'plan',
        listing_ref: 'publish-plan',
        requires_rubrics: [{ rubricRef: 'plan-class-feature-ship' }],
      }),
    );
    const exported = await fs.readFile(join(root, 'plan-templates', 'publish-plan', 'plan.md'), 'utf8');
    expect(exported).toContain('status: draft');
    expect(exported).toContain('The template preserves this outcome prose');
    expect(exported).not.toContain('WI-1234');
    expect(exported).not.toContain('`done`');
  });

  it('installs and parses a plan template directory', async () => {
    const repo = join(root, 'plan-repo');
    await writePlanDir(repo, 'install-plan');

    const result = await installPlanFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'install-plan' },
      unpinnedDeps(repo, root),
    );

    expect(result).toMatchObject({
      ok: true,
      ref: 'install-plan',
      templateSlug: 'install-plan',
      itemCount: 1,
      requiresRubrics: [{ rubricRef: 'plan-class-feature-ship' }],
      source: GITHUB_URL,
    });
    expect(await fs.readFile(join(root, 'plan-templates', 'install-plan', 'plan.md'), 'utf8')).toContain(
      '`todo`',
    );
  });
});

describe('recipe Cupboard round trip', () => {
  it('sanitizes, materializes, and publishes a recipe listing with its tool surface', async () => {
    const result = await publishRecipeToCupboard(
      {
        id: RECIPE_ROW.id,
        listing_ref: 'publish-recipe',
        github_url: GITHUB_URL,
      },
      async () => ({ row: RECIPE_ROW, authority: PORTABLE_AUTHORITY }),
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, exportedOnly: false, listing: { id: 'listing-1' } });
    // A recipe's tool surface is CONSUMPTION, not provision: installing a recipe registers
    // none of these tools, so it rides as `uses_tools`. The public Worker refuses
    // `provides_tools` on kind='recipe' (plugin|pack only), which is why sending it there
    // made every recipe publish fail with HTTP 400 (WI-10001747).
    const publishedBody = vi.mocked(external.publishListingToCupboard).mock.calls[0]?.[0];
    expect(publishedBody).toMatchObject({
      listing_kind: 'recipe',
      listing_ref: 'publish-recipe',
      uses_tools: ['work_items:list'],
    });
    // Both directions: the field the receiver rejects must not be on the wire at all.
    expect(publishedBody).not.toHaveProperty('provides_tools');
    const manifest = JSON.parse(
      await fs.readFile(join(root, 'recipes', 'publish-recipe', 'recipe.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'publish-recipe-source',
      toolsUsed: ['work_items:list'],
      authorityUnresolved: false,
    });
    expect(manifest).not.toHaveProperty('createdBy');
  });

  it('installs and resolves a recipe self-describing directory', async () => {
    const repo = join(root, 'recipe-repo');
    await writeRecipeDir(repo, 'install-recipe');

    const result = await installRecipeFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'install-recipe' },
      unpinnedDeps(repo, root),
    );

    expect(result).toMatchObject({
      ok: true,
      ref: 'install-recipe',
      recipeId: 'install-recipe',
      toolsUsed: ['work_items:list'],
      authorityUnresolved: false,
      source: GITHUB_URL,
    });
    expect(await fs.readFile(join(root, 'recipes', 'install-recipe', 'recipe.json'), 'utf8')).toContain(
      'install-recipe',
    );
  });
});
