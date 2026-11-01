import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  loadHarnessRegistry: vi.fn(),
}));

vi.mock('../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-registry')>();
  return { ...actual, loadHarnessRegistry: h.loadHarnessRegistry };
});

const { resolveCurrentTokens, resolveFileTokensWithProvenance, findFileInSiblingCheckouts, describeUnresolvedFileDep } = await import('./resolvers');

let tempRoot: string | undefined;
let canonicalRoot: string | undefined;
const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;

afterEach(async () => {
  h.loadHarnessRegistry.mockReset();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  if (canonicalRoot) await rm(canonicalRoot, { recursive: true, force: true });
  tempRoot = undefined;
  canonicalRoot = undefined;
  if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
});

async function makeCanonicalRoot(): Promise<string> {
  canonicalRoot = await mkdtemp(join(tmpdir(), 'freshness-canonical-root-'));
  await mkdir(join(canonicalRoot, 'apps', 'operator'), { recursive: true });
  await mkdir(join(canonicalRoot, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(canonicalRoot, 'apps', 'operator', 'package.json'), '{}');
  await writeFile(join(canonicalRoot, 'libs', 'papercusp', 'package.json'), '{}');
  process.env.PAPERCUSP_INTEGRATION_ROOT = canonicalRoot;
  return canonicalRoot;
}

describe('file dependency resolution', () => {
  it('resolves repo-relative refs against the declaring harness registry path', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-harness-root-'));
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await writeFile(join(tempRoot, 'src', 'owner.ts'), 'export const owner = true;');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const tokens = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(tokens.get(dep)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(h.loadHarnessRegistry).toHaveBeenCalledWith('papercusp-workspace');
  });

  it('reports the canonical fallback root when the registered harness path is phantom', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-phantom-root-'));
    const canonical = await makeCanonicalRoot();
    await mkdir(join(canonical, 'src'), { recursive: true });
    await writeFile(join(canonical, 'src', 'owner.ts'), 'export const owner = true;');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const result = await resolveFileTokensWithProvenance(['src/owner.ts'], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(result.tokens.get('src/owner.ts')).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.root).toBe(canonical);
    expect(result.rootSource).toBe('canonical-repo');
  });

  it('falls back to the canonical repo when the registry root is phantom and the canonical repo resolves every ref', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-phantom-root-'));
    const canonical = await makeCanonicalRoot();
    await mkdir(join(canonical, 'src'), { recursive: true });
    await writeFile(join(canonical, 'src', 'owner.ts'), 'export const owner = true;');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const expected = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
      repoRoot: canonical,
    });
    const actual = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(actual.get(dep)).toBe(expected.get(dep));
    expect(actual.get(dep)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('keeps a resolving registry root authoritative when the canonical repo also contains the ref', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-preferred-root-'));
    const canonical = await makeCanonicalRoot();
    for (const [root, body] of [[tempRoot, 'preferred'], [canonical, 'canonical']] as const) {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'owner.ts'), body);
    }
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const expected = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
      repoRoot: tempRoot,
    });
    const actual = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(actual.get(dep)).toBe(expected.get(dep));
  });

  it('does not assemble one dependency set from files split across two checkouts', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-split-preferred-root-'));
    const canonical = await makeCanonicalRoot();
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(canonical, 'src'), { recursive: true });
    await writeFile(join(tempRoot, 'src', 'preferred.ts'), 'preferred only');
    await writeFile(join(canonical, 'src', 'canonical.ts'), 'canonical only');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const preferredDep = 'file:src/preferred.ts';
    const canonicalDep = 'file:src/canonical.ts';
    const tokens = await resolveCurrentTokens([preferredDep, canonicalDep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(tokens.get(preferredDep)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(tokens.get(canonicalDep)).toBeNull();
  });

  it('resolves existing directories only for callers that explicitly allow them', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-directory-root-'));
    await mkdir(join(tempRoot, 'apps', 'tui'), { recursive: true });

    const dep = 'file:apps/tui';
    const defaultTokens = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'papercusp',
      repoRoot: tempRoot,
    });
    const directoryTokens = await resolveCurrentTokens(
      [dep],
      {
        workspaceId: 'papercusp-workspace',
        harness: 'papercusp',
        repoRoot: tempRoot,
      },
      { allowDirectories: true },
    );

    expect(defaultTokens.get(dep)).toBeNull();
    expect(directoryTokens.get(dep)).toBe('present:directory');
  });
});

describe('sibling-checkout hint for an unresolvable file: dep (EI-22169368425533789)', () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  });

  it('finds a ref that exists in a DIFFERENT top-level checkout under the workspace root', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'freshness-workspace-root-'));
    await mkdir(join(workspaceRoot, 'portal', 'packages', 'ui', 'src'), { recursive: true });
    await writeFile(join(workspaceRoot, 'portal', 'packages', 'ui', 'src', 'shell.tsx'), 'export {};');
    await mkdir(join(workspaceRoot, 'papercusp'), { recursive: true }); // sibling with no hit

    const hit = findFileInSiblingCheckouts('packages/ui/src/shell.tsx', { workspaceRoot });

    expect(hit).toBe('portal');
  });

  it('returns null when no sibling checkout has the ref either', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'freshness-workspace-root-'));
    await mkdir(join(workspaceRoot, 'portal'), { recursive: true });
    await mkdir(join(workspaceRoot, 'papercusp'), { recursive: true });

    expect(findFileInSiblingCheckouts('packages/ui/src/shell.tsx', { workspaceRoot })).toBeNull();
  });

  it('never escapes a sibling root via an absolute or ../-escaping ref', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'freshness-workspace-root-'));
    await mkdir(join(workspaceRoot, 'portal'), { recursive: true });

    expect(findFileInSiblingCheckouts('/etc/passwd', { workspaceRoot })).toBeNull();
    expect(findFileInSiblingCheckouts('../../../../etc/passwd', { workspaceRoot })).toBeNull();
  });

  it('never throws when the workspace root itself does not exist', () => {
    expect(findFileInSiblingCheckouts('any/path.ts', { workspaceRoot: '/no/such/workspace-root' })).toBeNull();
  });

  it('describeUnresolvedFileDep names the sibling and repo-qualification hint on a hit', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'freshness-workspace-root-'));
    await mkdir(join(workspaceRoot, 'portal', 'packages', 'ui', 'src'), { recursive: true });
    await writeFile(join(workspaceRoot, 'portal', 'packages', 'ui', 'src', 'shell.tsx'), 'export {};');

    const msg = describeUnresolvedFileDep('file:packages/ui/src/shell.tsx', {
      workspaceRoot,
      harness: 'papercusp',
    });

    expect(msg).toContain('"file:packages/ui/src/shell.tsx"');
    expect(msg).toContain('harness "papercusp"');
    expect(msg).toContain('sibling checkout "portal"');
    expect(msg).not.toContain('could not be resolved right now');
  });

  it('describeUnresolvedFileDep falls back to the original bare message on a true miss', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'freshness-workspace-root-'));
    await mkdir(join(workspaceRoot, 'portal'), { recursive: true });

    const msg = describeUnresolvedFileDep('file:no/such/file.ts', { workspaceRoot, harness: 'papercusp' });

    expect(msg).toBe('"file:no/such/file.ts" could not be resolved right now and was not stamped');
  });
});
