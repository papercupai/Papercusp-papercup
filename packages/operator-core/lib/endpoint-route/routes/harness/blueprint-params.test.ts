import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  resolvePhasedProject: vi.fn(),
  loadBlueprintFromFile: vi.fn(),
}));

vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
  existsSync: h.existsSync,
}));
vi.mock('../../../harness-core', () => ({
  resolvePhasedProject: h.resolvePhasedProject,
  harnessDir: (project: { path: string }) => project.path,
}));
vi.mock('@papercusp/orchestrator/blueprint', () => ({
  loadBlueprintFromFile: h.loadBlueprintFromFile,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'selected-workspace' }));

import routes from './blueprint-params';

type RouteEntry = {
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

const route = (routes as unknown as RouteEntry[]).find((entry) => entry.path === '/harness/:slug/blueprint-params')!;

function call(query = ''): Promise<Response> {
  return route.handler(new Request(`http://127.0.0.1:3070/api/harness/workspace/blueprint-params${query}`), {
    params: { slug: 'workspace' },
  });
}

beforeEach(() => {
  h.existsSync.mockReset().mockReturnValue(true);
  h.resolvePhasedProject.mockReset().mockResolvedValue({ slug: 'workspace', path: '/repos/workspace' });
  h.loadBlueprintFromFile.mockReset().mockReturnValue({
    blueprint: {
      id: 'work-identity',
      params: { 'aiBackend.default.model': { type: 'string' } },
      lexicon: { workUnit: 'deliverable', reviewGate: 'review' },
      retired: { at: 'D-025', reason: 'fixture' },
      knobs: {
        aiBackend: {
          default: { model: 'default-model' },
          roles: { reviewer: { model: 'review-model', extraArgs: ['--effort', 'high'] } },
        },
      },
      gym: { rubric: { version: 'gym-v1', dimensions: { quality: 'Is it good?' } } },
      acceptance: {
        kind: 'judge',
        rubric: { version: 'accept-v1', dimensions: { complete: 'Is it complete?' } },
      },
    },
  });
});

describe('GET /harness/:slug/blueprint-params identity sections', () => {
  it('projects the exact resolved blueprint sections without parallel field names', async () => {
    const response = await call('?phase=testing');
    expect(response.status).toBe(200);
    expect(h.resolvePhasedProject).toHaveBeenCalledWith('workspace', 'testing', 'selected-workspace');
    expect(h.loadBlueprintFromFile).toHaveBeenCalledWith('/repos/workspace/blueprint.yaml');
    expect(await response.json()).toEqual({
      blueprintId: 'work-identity',
      params: { 'aiBackend.default.model': { type: 'string' } },
      identity: {
        lexicon: { workUnit: 'deliverable', reviewGate: 'review' },
        retired: { at: 'D-025', reason: 'fixture' },
        knobs: {
          aiBackend: {
            default: { model: 'default-model' },
            roles: { reviewer: { model: 'review-model', extraArgs: ['--effort', 'high'] } },
          },
        },
        gym: { rubric: { version: 'gym-v1', dimensions: { quality: 'Is it good?' } } },
        acceptance: {
          rubric: { version: 'accept-v1', dimensions: { complete: 'Is it complete?' } },
        },
      },
    });
  });

  it('keeps a stable empty identity shape for a legacy harness without a blueprint', async () => {
    h.existsSync.mockReturnValue(false);
    expect(await (await call()).json()).toEqual({
      blueprintId: null,
      params: {},
      identity: {
        lexicon: {},
        retired: null,
        knobs: { aiBackend: null },
        gym: { rubric: null },
        acceptance: { rubric: null },
      },
    });
    expect(h.loadBlueprintFromFile).not.toHaveBeenCalled();
  });

  it('fails soft with the same empty identity shape when blueprint resolution fails', async () => {
    h.loadBlueprintFromFile.mockImplementation(() => {
      throw new Error('invalid identity layer');
    });
    expect(await (await call()).json()).toMatchObject({
      blueprintId: null,
      params: {},
      identity: {
        lexicon: {},
        retired: null,
        knobs: { aiBackend: null },
        gym: { rubric: null },
        acceptance: { rubric: null },
      },
      error: 'invalid identity layer',
    });
  });
});
