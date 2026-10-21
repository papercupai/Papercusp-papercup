/**
 * Coverage for spawn-config: the harness-scoped spawn primitives shared by the
 * pty bridge + native console launcher. loadHarnessRegistry is mocked;
 * resolveSpawnCwd uses real temp dirs (it probes existsSync).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadHarnessRegistry = vi.fn();
const ORIGINAL_MCP_PROXY_BASE = process.env.PAPERCUSP_MCP_PROXY_BASE;
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a),
}));

import { resolveProjectDir, resolveStateDir, resolveSpawnCwd, resolveContextEnv } from './spawn-config';
import { turnProvenanceDir } from './turn-provenance/turn-provenance';

beforeAll(() => {
  loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: 'p', path: '/proj' }] });
});
afterEach(() => {
  loadHarnessRegistry.mockClear();
  if (ORIGINAL_MCP_PROXY_BASE === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
  else process.env.PAPERCUSP_MCP_PROXY_BASE = ORIGINAL_MCP_PROXY_BASE;
});

describe('resolveProjectDir / resolveStateDir', () => {
  it('resolves a registered slug to its path', async () => {
    expect(await resolveProjectDir('p')).toBe('/proj');
    expect(await resolveStateDir('p')).toBe('/proj/.papercusp');
  });

  it('returns null for an unknown slug', async () => {
    expect(await resolveProjectDir('ghost')).toBeNull();
    expect(await resolveStateDir('ghost')).toBeNull();
  });

  it('threads workspaceId into the registry lookup', async () => {
    await resolveProjectDir('p', 'ws-2');
    expect(loadHarnessRegistry).toHaveBeenCalledWith('ws-2');
  });
});

describe('resolveSpawnCwd', () => {
  let stateDir: string;
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'spawn-state-'));
    mkdirSync(join(stateDir, 'worktrees', 'lane-1'), { recursive: true });
  });
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  it('defaults to projectDir when no laneId', () => {
    expect(resolveSpawnCwd({ projectDir: '/proj', stateDir })).toBe('/proj');
  });

  it('uses the per-lane worktree when it exists', () => {
    expect(resolveSpawnCwd({ projectDir: '/proj', stateDir, laneId: 'lane-1' })).toBe(
      join(stateDir, 'worktrees', 'lane-1'),
    );
  });

  it('falls back to projectDir when the worktree dir is absent', () => {
    expect(resolveSpawnCwd({ projectDir: '/proj', stateDir, laneId: 'no-such-lane' })).toBe('/proj');
  });
});

describe('resolveContextEnv', () => {
  it('keeps callbacks on the request origin while routing long-lived MCP traffic through the stable proxy', () => {
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9171/';
    const env = resolveContextEnv({
      slug: 'p',
      stateDir: '/proj/.papercusp',
      requestUrl: 'http://127.0.0.1:3170/api/x?y=1',
    });
    expect(env.PAPERCUSP_HARNESS_SLUG).toBe('p');
    expect(env.PAPERCUSP_TURN_PROVENANCE_DIR).toBe(turnProvenanceDir());
    expect(env.PI_CODING_AGENT_DIR).toBe('/proj/.papercusp/pi-sessions');
    expect(env.PAPERCUSP_API_BASE).toBe('http://127.0.0.1:3170');
    expect(env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9171');
  });

  it('uses the standard :9071 fallback even when the callback URL is invalid', () => {
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    const env = resolveContextEnv({ slug: 'p', stateDir: null, requestUrl: 'not a url' });
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.PAPERCUSP_API_BASE).toBeUndefined();
    expect(env.PAPERCUSP_HARNESS_SLUG).toBe('p');
    expect(env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
  });

  it('propagates an explicit provenance-directory override to the child hook', () => {
    const previous = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = '/shared/turn-provenance';
    try {
      const env = resolveContextEnv({ slug: 'p', stateDir: null });
      expect(env.PAPERCUSP_TURN_PROVENANCE_DIR).toBe('/shared/turn-provenance');
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
      else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = previous;
    }
  });
});
