import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBearerMock, matchResourceMock } = vi.hoisted(() => ({
  resolveBearerMock: vi.fn(),
  matchResourceMock: vi.fn(() => null),
}));

vi.mock('./auth', () => ({ resolveBearer: resolveBearerMock }));
vi.mock('@papercusp/tooldef', () => ({
  applyEntityRefEnums: vi.fn(),
  formatOptsFromCtx: vi.fn(),
  getCatalog: vi.fn(() => []),
  getPromptCatalog: vi.fn(() => []),
  getResourceCatalog: vi.fn(() => []),
  lookup: vi.fn(),
  lookupByMcpName: vi.fn(),
  lookupPrompt: vi.fn(),
  matchResource: matchResourceMock,
  serializeToolResponse: vi.fn(),
  standardValidate: vi.fn(),
  toArgsJsonSchema: vi.fn(),
}));

import { writeScratchReference } from '@papercusp/operator-core/lib/scratch-reference';
import { getPrompt, listPrompts, listResources, readResource } from './server';
import { lookupPrompt } from '@papercusp/tooldef';

const WORKSPACE = 'resource-reader-ws';
const OWNER = 'pi:resource-reader';
const OTHER_OWNER = 'pi:other';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

const principal = (slug = OWNER, workspaceId = WORKSPACE) => ({
  kind: 'pi' as const,
  slug,
  workspaceId,
  capabilities: new Set<string>(),
  authMethod: 'bearer-token' as const,
  trust: 'trusted' as const,
});

const superuserPrincipal = (workspaceId = WORKSPACE) => ({
  kind: 'system' as const,
  slug: OWNER,
  workspaceId,
  capabilities: new Set(['*']),
  authMethod: 'bearer-token' as const,
  trust: 'trusted' as const,
});

let scratchRoot: string;
let previousScratchRoot: string | undefined;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'agent-mcp-resource-reader-'));
  previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
  resolveBearerMock.mockReset();
  matchResourceMock.mockReset();
  matchResourceMock.mockReturnValue(null);
});

afterEach(() => {
  if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
  rmSync(scratchRoot, { recursive: true, force: true });
});

function scratchPath(basename = 'result.spill'): string {
  return join(scratchRoot, WORKSPACE, 'work_items:get', RUN_ID, basename);
}

function scratchUri(basename = 'result.spill'): string {
  return `papercusp://scratch/${WORKSPACE}/work_items:get/${RUN_ID}/${basename}`;
}

describe('readResource scratch references', () => {
  it('reads an authenticated self-describing scratch spill', async () => {
    resolveBearerMock.mockResolvedValue(principal());
    writeScratchReference({
      filePath: scratchPath(),
      payload: '{"ok":true,"rows":[1]}',
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      audience: 'owner',
      mediaType: 'application/json',
    });

    const result = await readResource({ uri: scratchUri(), bearer: 'valid-bearer' });

    expect(result).toEqual({
      ok: true,
      contents: {
        uri: scratchUri(),
        mimeType: 'application/json',
        text: '{"ok":true,"rows":[1]}',
      },
    });
    expect(matchResourceMock).not.toHaveBeenCalled();
  });

  it('requires a valid bearer before touching a scratch URI', async () => {
    resolveBearerMock.mockResolvedValue(null);

    const result = await readResource({ uri: scratchUri('missing.spill'), bearer: 'invalid-bearer' });

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_bearer' } });
  });

  it('reads a scratch spill from an already-authenticated superuser principal', async () => {
    resolveBearerMock.mockResolvedValue(null);
    writeScratchReference({
      filePath: scratchPath(),
      payload: '{"from":"superuser"}',
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      audience: 'owner',
      mediaType: 'application/json',
    });

    const result = await readResource({ uri: scratchUri(), principal: superuserPrincipal() });

    expect(result).toEqual({
      ok: true,
      contents: {
        uri: scratchUri(),
        mimeType: 'application/json',
        text: '{"from":"superuser"}',
      },
    });
    expect(resolveBearerMock).not.toHaveBeenCalled();
  });

  it('keeps an exact-tool PI bearer out of MCP resource reads', async () => {
    resolveBearerMock.mockResolvedValue({
      ...principal(),
      allowedTools: new Set(['tasks:list']),
    });

    expect(await listResources({ bearer: 'scoped-bearer' })).toEqual({ ok: true, resources: [] });
    expect(await readResource({ uri: scratchUri('not-created.spill'), bearer: 'scoped-bearer' }))
      .toMatchObject({ ok: false, error: { code: 'tool_scope_only' } });
  });

  it('keeps an exact-tool PI bearer out of MCP prompt reads', async () => {
    resolveBearerMock.mockResolvedValue({
      ...principal(),
      allowedTools: new Set(['tasks:list']),
    });
    vi.mocked(lookupPrompt).mockReturnValue({ name: 'agent:role', description: 'role', tier: 'low', render: vi.fn() });

    expect(await listPrompts('scoped-bearer')).toEqual({ ok: true, prompts: [] });
    expect(await getPrompt({ name: 'agent:role', args: {}, bearer: 'scoped-bearer' }))
      .toMatchObject({ ok: false, error: { code: 'tool_scope_only' } });
  });

  it('lets an explicitly unscoped superuser follow the URI workspace', async () => {
    writeScratchReference({
      filePath: scratchPath(),
      payload: 'all-workspaces',
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      audience: 'owner',
      mediaType: 'text/plain',
    });

    const result = await readResource({
      uri: scratchUri(),
      principal: superuserPrincipal('*'),
    });

    expect(result).toMatchObject({
      ok: true,
      contents: { uri: scratchUri(), text: 'all-workspaces' },
    });
  });

  it('enforces workspace and owner boundaries for scratch references', async () => {
    resolveBearerMock.mockResolvedValue(principal(OTHER_OWNER));
    writeScratchReference({
      filePath: scratchPath(),
      payload: 'private',
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      audience: 'owner',
      mediaType: 'text/plain',
    });

    const ownerResult = await readResource({ uri: scratchUri(), bearer: 'other-owner-bearer' });
    expect(ownerResult).toMatchObject({ ok: false, error: { code: 'forbidden_reference' } });

    resolveBearerMock.mockResolvedValue(principal(OWNER, 'other-workspace'));
    const workspaceResult = await readResource({ uri: scratchUri(), bearer: 'other-workspace-bearer' });
    expect(workspaceResult).toMatchObject({ ok: false, error: { code: 'workspace_mismatch' } });
  });

  it('keeps legacy scratch files readable after authentication', async () => {
    resolveBearerMock.mockResolvedValue(principal());
    mkdirSync(dirname(scratchPath('legacy.txt')), { recursive: true });
    writeFileSync(scratchPath('legacy.txt'), 'legacy payload', { encoding: 'utf8' });

    const result = await readResource({ uri: scratchUri('legacy.txt'), bearer: 'valid-bearer' });

    expect(result).toEqual({
      ok: true,
      contents: {
        uri: scratchUri('legacy.txt'),
        mimeType: 'text/plain',
        text: 'legacy payload',
      },
    });
  });
});
