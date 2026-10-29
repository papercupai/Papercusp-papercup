/**
 * Independent P023 acceptance tests for change-kind-declared-proof P003 / R3.
 * Exercise the existing close gate so preimplementation calibration collects
 * normally and fails on observable guidance, not on a missing future module.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evaluateChangeKindGate,
  type ChangeKindGateInput,
  type ChangeKindProofDeps,
} from './change-kind-proof';
import type { ChangeKindEvidence } from './change-kind-catalog';
import type { CurrentBuildTestClassId } from './serving-runtimes';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(files: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'change-kind-r3-'));
  fixtures.push(root);
  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(contents));
  }));
  return root;
}

// The existing injectable gate boundary gains repo context; no new module is
// imported before it exists. The implementing task owns production wiring.
type RepoProofDeps = ChangeKindProofDeps & {
  repoRoot: string;
  harnessSlug: string;
  testClass?: CurrentBuildTestClassId;
};

function deps(root: string, overrides: Partial<RepoProofDeps> = {}): RepoProofDeps {
  return { repoRoot: root, harnessSlug: 'example-project', ...overrides };
}

function close(overrides: Partial<ChangeKindGateInput> = {}): ChangeKindGateInput {
  return {
    itemId: 'WI-r3-fixture',
    successfulClose: true,
    declaredAtClose: ['ui'],
    declaredReason: 'The fixture changes a visible UI state.',
    stored: null,
    root: {},
    ...overrides,
  };
}

async function refusal(input: ChangeKindGateInput, context: RepoProofDeps): Promise<string> {
  const result = await evaluateChangeKindGate(input, context);
  expect(result.applicable).toBe(true);
  if (!result.applicable || result.outcome !== 'refuse') {
    expect.fail(`R3 must keep the unproved close open; received ${JSON.stringify(result)}`);
  }
  return result.error;
}

const TAURI_RUNNER = /verify-tauri-headless\.sh|headless\s+Tauri\s+runner/i;
const BROWSER_RUNNER = /headless\s+browser|\bverdict\b|\bplaywright\b/i;

describe('R3 bundled stack defaults through actual completion refusals', () => {
  it.each(['tauri.conf.json', 'src-tauri/tauri.conf.json'])(
    'names the headless Tauri runner for %s without adapter configuration',
    async (manifest) => {
      const root = await repo({ [manifest]: { productName: 'Fixture desktop' } });
      const message = await refusal(close(), deps(root));
      expect(message).toMatch(TAURI_RUNNER);
      expect(message).not.toMatch(/default[^\n]*headless\s+browser/i);
    },
  );

  it('keeps the desktop runner when a Tauri app also has a web frontend manifest', async () => {
    const root = await repo({
      'src-tauri/tauri.conf.json': { productName: 'Hybrid fixture' },
      'package.json': { dependencies: { react: '19.0.0', vite: '7.0.0' } },
    });
    expect(await refusal(close(), deps(root))).toMatch(TAURI_RUNNER);
  });

  it.each([
    ['Next', { dependencies: { next: '15.0.0' } }],
    ['Vite', { devDependencies: { vite: '7.0.0' } }],
    ['SvelteKit', { devDependencies: { '@sveltejs/kit': '2.0.0' } }],
  ])('names a headless browser for the %s framework manifest without configuration', async (_name, manifest) => {
    const root = await repo({ 'package.json': manifest });
    expect(await refusal(close(), deps(root))).toMatch(BROWSER_RUNNER);
  });

  it('tells an unknown stack to name its runner while retaining the artifact obligation', async () => {
    const root = await repo({ 'package.json': { name: 'unrecognized-stack' } });
    const message = await refusal(close(), deps(root));
    expect(message).toMatch(/unknown|unrecognized|not recognized/i);
    expect(message).toMatch(/(?:name|choose|specify)\s+(?:your\s+)?(?:own\s+)?(?:headless\s+)?(?:tool|runner)/i);
    expect(message).toMatch(/artifact|capture|screenshot/i);
  });

  it('does not let a custom runner name substitute for an unknown stack artifact', async () => {
    const root = await repo();
    const proof: ChangeKindEvidence = {
      kind: 'ui',
      summary: 'Custom recorder exercised the changed ready state.',
      testsRun: 'bespoke-ui-recorder --state ready',
      testResult: 'passed',
      build: 'abc1234',
      states: [{ name: 'ready', evidence: 'recorded ready state' }],
      distinguishingChecks: [{ assertion: 'ready label', expected: 'Ready', plausibleWrong: 'Loading' }],
    };
    const message = await refusal(close({ kindEvidence: [proof] }), deps(root));
    expect(message).toMatch(/artifact|capture|screenshot/i);
  });

  it('permits an unknown stack custom runner with recorded artifact and the other UI proof', async () => {
    const root = await repo();
    const artifact = join(root, 'ready.png');
    await writeFile(artifact, 'unit fixture; the injected artifact reader judges this citation');
    const proof: ChangeKindEvidence = {
      kind: 'ui',
      summary: 'Custom recorder exercised the changed ready state.',
      testsRun: 'bespoke-ui-recorder --state ready',
      testResult: 'passed',
      build: 'abc1234',
      artifacts: [artifact],
      states: [{ name: 'ready', evidence: artifact }],
      distinguishingChecks: [{ assertion: 'ready label', expected: 'Ready', plausibleWrong: 'Loading' }],
    };
    const result = await evaluateChangeKindGate(close({ kindEvidence: [proof] }), deps(root, {
      verifyUiArtifacts: async () => ({ ok: true, basis: 'image', artifacts: [] }),
    }));
    expect(result).toMatchObject({ applicable: true, outcome: 'pass', kinds: ['ui'] });
  });

  it('uses Papercusp background isolation guidance instead of the stack default when a class overrides it', async () => {
    const root = await repo({ 'tauri.conf.json': { productName: 'Papercusp fixture' } });
    const message = await refusal(close({ declaredAtClose: ['background-job'] }), deps(root, {
      harnessSlug: 'papercusp',
      testClass: 'background-federation',
    }));
    expect(message).toContain('scripts/with-test-pg.mjs');
    expect(message).toContain('--isolated-runtime');
  });

  it('does not recommend a web-manifest browser for a background job without a registered test class', async () => {
    const root = await repo({ 'package.json': { dependencies: { astro: '5.0.0' } } });
    const message = await refusal(close({ declaredAtClose: ['background-job'] }), deps(root, {
      harnessSlug: 'papercusp',
    }));
    expect(message).toMatch(/no testClass is registered/i);
    expect(message).toMatch(/name the isolated runtime and command/i);
    expect(message).not.toMatch(BROWSER_RUNNER);
  });

  it('does not apply a Papercusp-only route override to an unrelated web harness', async () => {
    const root = await repo({ 'package.json': { dependencies: { next: '15.0.0' } } });
    const message = await refusal(close(), deps(root, { testClass: 'background-federation' }));
    expect(message).toMatch(BROWSER_RUNNER);
    expect(message).not.toContain('scripts/with-test-pg.mjs');
  });
});
