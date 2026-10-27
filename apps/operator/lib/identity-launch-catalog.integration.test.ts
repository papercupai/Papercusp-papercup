/**
 * R-9 (su-mode-contract-identity-unification-2026-09-24 P-008) integration layer:
 * the CLI and GUI identity pickers discover installed identities through the ONE
 * real catalog route, page through it, keep incompatible/broken entries visible
 * with a reason, offer SU by default, and launch exactly the named composition the
 * preview showed.
 *
 * Real: the blueprint source files (installed tier + local library under a
 * throwaway PAPERCUSP_HOME), the bootstrap-su options route handler and its
 * loopback principal gate, listIdentitySources, preview/save of the named
 * composition, the CLI's pickIdentity/identityPickerChoices, the GUI's
 * buildIdentityLaunchOptions and the launch-spec compiler. Stubbed: only the
 * transport (fetch → the in-process handler) and the terminal prompt (select),
 * which is the human's keypress.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify as yaml } from 'yaml';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';

const WORKSPACE = `r9-identity-catalog-${process.pid}`;
const INSTALLED = 'zz-r9-installed-domain';
const PRACTICE = 'zz-r9-local-practice';
const PROVIDER = 'zz-r9-needs-producer';
const UNSIGNED = 'zz-r9-unsigned-installed';
const NAMED = 'zz-r9-named-review';

let root: string;
let home: string;
let priorHome: string | undefined;
let priorBase: string | undefined;
type Page = {
  status: string;
  identities: Array<{ id: string; tier: string; sourceRevision: string; slots: Array<{ slot: string }>;
    launchCompatibility?: { eligible: boolean; reason: string | null } }>;
  unreadable: Array<{ id: string; error: string }>;
  nextAfter: string | null;
};
const requested: string[] = [];

async function writeBlueprint(dir: string, source: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'blueprint.yaml'), yaml(source));
}

async function routeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(`${url.pathname}${url.search}`);
  const { default: routes } = await import('@papercusp/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su');
  const route = (routes as Array<{ method: string; path?: string; handler: (r: Request, c: unknown) => Promise<Response> }>)
    .find((entry) => entry.method === 'GET' && entry.path === '/agent-mcp/console/bootstrap-su/options');
  if (!route) throw new Error('bootstrap-su options route is not registered');
  // Real principal gate: a loopback Host resolves the loopback principal.
  return route.handler(new Request(`http://127.0.0.1:3070${url.pathname}${url.search}`,
    { headers: { host: '127.0.0.1:3070' } }), { log() {} });
}

async function readAllPages(): Promise<Page[]> {
  const pages: Page[] = [];
  let after: string | null = null;
  for (let index = 0; index < 50; index++) {
    const query = new URLSearchParams({ identities: '1', limit: '30', workspace: WORKSPACE });
    if (after) query.set('after', after);
    const response = await routeFetch(`http://127.0.0.1:3070/api/agent-mcp/console/bootstrap-su/options?${query}`);
    const page = await response.json() as Page;
    expect(response.status, JSON.stringify(page)).toBe(200);
    expect(page.status).toBe('ok');
    pages.push(page);
    if (!page.nextAfter) return pages;
    expect(page.nextAfter).not.toBe(after);
    after = page.nextAfter;
  }
  throw new Error('identity catalog cursor never terminated');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'r9-identity-catalog-'));
  home = join(root, 'papercusp-home');
  priorHome = process.env.PAPERCUSP_HOME;
  priorBase = process.env.PAPERCUSP_OPERATOR_URL;
  process.env.PAPERCUSP_HOME = home;
  // A hermetic non-:3070 loopback pin: psu never probes the box's live proxy or
  // operator.json, and the fetch stub below serves every request in-process.
  process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:3999';
  const { _resetPapercuspRootForTests } = await import('@papercusp/operator-core/lib/papercusp-root');
  _resetPapercuspRootForTests();

  // Installed tier: one attested (eligible) component and one unsigned (broken).
  const installed = { id: INSTALLED, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }] };
  await writeBlueprint(join(home, 'blueprints', INSTALLED), { ...installed,
    attestation: { contentHash: layerContentHash(installed), signedBy: 'r9-integration-fixture' } });
  const installedPrompts = join(home, 'blueprints', INSTALLED, 'prompts');
  await mkdir(installedPrompts, { recursive: true });
  await writeFile(join(installedPrompts, 'agent-base-overlay.md'), '# Installed integration domain\n');
  await writeBlueprint(join(home, 'blueprints', UNSIGNED),
    { id: UNSIGNED, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }] });
  // Local library: an abstract practice component and a provider-bound (incompatible) one.
  await writeBlueprint(join(home, '.papercusp', 'blueprints', PRACTICE),
    { id: PRACTICE, extends: 'base', version: '1.0.0', slots: [{ slot: 'practice' }] });
  const practicePrompts = join(home, '.papercusp', 'blueprints', PRACTICE, 'prompts');
  await mkdir(practicePrompts, { recursive: true });
  await writeFile(join(practicePrompts, 'practice.md'), '# Integration practice\n');
  await writeBlueprint(join(home, '.papercusp', 'blueprints', PROVIDER), {
    id: PROVIDER, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
    contributions: [{ id: 'current-brief', purpose: 'operational', source: 'provider', refresh: 'launch',
      inputKind: 'setting', ref: 'current-brief', producerRef: 'papercusp.fleet-leader-brief@1', verb: 'read' }],
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch as typeof fetch);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@inquirer/prompts');
  if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = priorHome;
  if (priorBase === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
  else process.env.PAPERCUSP_OPERATOR_URL = priorBase;
  const { _resetPapercuspRootForTests } = await import('@papercusp/operator-core/lib/papercusp-root');
  _resetPapercuspRootForTests();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('R-9 identity launch catalog (integration)', () => {
  it('pages the real catalog, keeps invalid entries visible with reasons, and offers SU first in CLI and GUI', async () => {
    const pages = await readAllPages();
    expect(pages.length).toBeGreaterThan(1);
    const identities = pages.flatMap((page) => page.identities);
    const unreadable = pages.flatMap((page) => page.unreadable);

    const installed = identities.find((entry) => entry.id === INSTALLED);
    expect(installed).toMatchObject({ tier: 'installed', launchCompatibility: { eligible: true, reason: null } });
    expect(installed!.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    // Abstract components stay discoverable with their slot.
    expect(identities.find((entry) => entry.id === PRACTICE)).toMatchObject({ tier: 'local',
      slots: [expect.objectContaining({ slot: 'practice' })] });
    const incompatible = identities.find((entry) => entry.id === PROVIDER);
    expect(incompatible?.launchCompatibility).toMatchObject({ eligible: false,
      reason: expect.stringContaining('producer binding') });
    const broken = unreadable.find((entry) => entry.id === UNSIGNED);
    expect(broken?.error).toMatch(/attestation/);

    // scripts/mutation-probe.sh copy-out seam: {} is a mutated psu-launcher.mjs in a repo mirror.
    const { identityPickerChoices } = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
      ? await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)
      : await import('../scripts/psu-launcher.mjs');
    const cli = pages.flatMap((page, index) => identityPickerChoices(page)
      .filter((choice: { value: string }) => index === 0 || choice.value !== 'su'));
    expect(identityPickerChoices(pages[0])[0]).toMatchObject({ value: 'su' });
    expect(cli.find((choice: { value: string }) => choice.value === `domain:${INSTALLED}`)?.disabled).toBeUndefined();
    expect(cli.find((choice: { value: string }) => choice.value === `domain:${PROVIDER}`)?.disabled)
      .toContain('producer binding');
    expect(cli.find((choice: { value: string }) => choice.value === `invalid:${UNSIGNED}`)?.disabled)
      .toMatch(/attestation/);

    const { buildIdentityLaunchOptions, IDENTITY_SELECT_DEFAULT } = await import('../app/adv/sessions/NewSessionLauncher');
    const gui = buildIdentityLaunchOptions({ identities: identities as never, unreadable, nextAfter: null });
    expect(IDENTITY_SELECT_DEFAULT).toBe('su');
    expect(gui[0]).toMatchObject({ value: 'su', label: 'SU' });
    expect(gui.find((option) => option.value === `domain:${INSTALLED}`)?.disabled).toBe(false);
    expect(gui.find((option) => option.value === `domain:${PROVIDER}`)).toMatchObject({ disabled: true,
      detail: expect.stringContaining('producer binding') });
    expect(gui.find((option) => option.value === `invalid:${UNSIGNED}`)).toMatchObject({ disabled: true,
      detail: expect.stringMatching(/attestation/) });
  });

  it('launches the saved named composition the preview showed, reached by paging the CLI picker', async () => {
    const { previewNamedIdentityComposition, saveNamedIdentityComposition } =
      await import('@papercusp/operator-core/lib/identity-management');
    const { resolveNamedIdentityCompositionSelection } =
      await import('@papercusp/operator-core/lib/agent-identities/source');
    const input = { id: NAMED, repoDir: home, componentRefs: [`domain:${INSTALLED}`, `practice:${PRACTICE}`] };
    const preview = await previewNamedIdentityComposition(input);
    expect(preview.preview.launchCompatibility).toMatchObject({ eligible: true });
    expect((await saveNamedIdentityComposition(input)).ok).toBe(true);
    const selection = await resolveNamedIdentityCompositionSelection(NAMED, home);
    expect(selection.stack).toEqual(input.componentRefs);
    const previewLayers = preview.preview.layers.map((layer: { id: string }) => layer.id);
    expect(selection.layers.map((layer) => layer.id)).toEqual(previewLayers);

    // A human pages the CLI picker ("Load more…") until the saved composition shows, then picks it.
    const select = vi.fn(async ({ choices, default: fallback }: { choices: Array<{ value: string }>; default: string }) => {
      expect(fallback).toBe('su');
      expect(choices[0]?.value).toBe('su');
      return choices.some((choice) => choice.value === `composition:${NAMED}`) ? `composition:${NAMED}` : '__next__';
    });
    vi.doMock('@inquirer/prompts', () => ({ select }));
    requested.length = 0;
    const { pickIdentity } = await import('../scripts/psu-launcher.mjs');
    const picked = await pickIdentity(WORKSPACE, undefined);
    expect(picked).toEqual({ stack: [`composition:${NAMED}`], selectedIdentityRevision: selection.sourceRevision });
    expect(select.mock.calls.length).toBeGreaterThan(1);
    expect(requested.some((path) => path.includes('after='))).toBe(true);

    // The launch compiler pins exactly the layers the preview showed, at the picked revision.
    const { compileLaunchSpecificationArtifact } = await import('@papercusp/operator-core/lib/role-launch-spec');
    const artifact = await compileLaunchSpecificationArtifact({
      promptText: 'R-9 integration launch', cwd: home, workspaceId: WORKSPACE, harnessSlug: 'r9-identity-catalog',
      role: 'su', stack: selection.stack, compositionRootId: NAMED,
      state: { schemaVersion: 1, principal: { kind: 'su', role: 'su', profile: 'engineer' } },
    } as never);
    const pinned = artifact.specificationArtifact.inputs.filter((entry) => entry.kind === 'blueprint-layer');
    for (const layer of selection.layers) {
      expect(pinned, layer.id).toContainEqual(expect.objectContaining({ ref: layer.id, contentHash: layer.contentHash }));
    }
  });
});
