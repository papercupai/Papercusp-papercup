import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryRematerializeFromArchive } from './psu-launcher.mjs';

const roots: string[] = [];

function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeClaudeTranscript(root: string, sessionId: string) {
  const project = join(root, 'projects', 'archive-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), '{}\n');
}

function archiveFetch(root: string, sourceKind = 'claude') {
  return vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    sourceKind,
    written: 1,
    root,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('tryRematerializeFromArchive — tracked Claude provenance root', () => {
  it('pins the tracked session to the archive root only when its exact transcript exists there', async () => {
    const archiveRoot = tempRoot('psu-archive-root-');
    const home = tempRoot('psu-archive-home-');
    const sessionId = 'd51d6775-b05f-4aaf-a61c-6b6ab0db5e1a';
    const sourceSession = {
      agent: 'claude',
      sessionId,
      configDir: '/old/claude-config',
      coordOwnerId: 'su-archive-owner',
    };
    writeClaudeTranscript(archiveRoot, sessionId);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const restored = await tryRematerializeFromArchive(sessionId, 'claude', {
      fetchImpl: archiveFetch(archiveRoot),
      operatorUrl: 'https://operator.test',
      token: 'test-token',
      sourceSession,
      home,
    });

    expect(restored).toMatchObject({ ok: true, sourceKind: 'claude', root: archiveRoot });
    expect(sourceSession).toMatchObject({
      agent: 'claude',
      sessionId,
      configDir: archiveRoot,
      coordOwnerId: 'su-archive-owner',
    });
  });

  it('leaves configDir unchanged when the restored root lacks that exact transcript', async () => {
    const archiveRoot = tempRoot('psu-archive-root-');
    const home = tempRoot('psu-archive-home-');
    const sessionId = '5a4b7617-d51e-4b88-a75b-2debfecfb31d';
    const sourceSession = { agent: 'claude', sessionId, configDir: '/old/claude-config' };
    writeClaudeTranscript(archiveRoot, 'another-session');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await tryRematerializeFromArchive(sessionId, 'claude', {
      fetchImpl: archiveFetch(archiveRoot),
      operatorUrl: 'https://operator.test',
      token: 'test-token',
      sourceSession,
      home,
    });

    expect(sourceSession.configDir).toBe('/old/claude-config');
  });

  it.each([
    ['a different tracked session id', { agent: 'claude', sessionId: 'other-session' }],
    ['a non-Claude tracked session', { agent: 'codex', sessionId: 'd37ad434-3ac1-4c46-bfb2-0a0e0e88b291' }],
  ])('does not retarget %s', async (_label, identity) => {
    const archiveRoot = tempRoot('psu-archive-root-');
    const home = tempRoot('psu-archive-home-');
    const sessionId = 'd37ad434-3ac1-4c46-bfb2-0a0e0e88b291';
    const sourceSession = { ...identity, configDir: '/old/claude-config' };
    writeClaudeTranscript(archiveRoot, sessionId);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await tryRematerializeFromArchive(sessionId, 'claude', {
      fetchImpl: archiveFetch(archiveRoot),
      operatorUrl: 'https://operator.test',
      token: 'test-token',
      sourceSession,
      home,
    });

    expect(sourceSession.configDir).toBe('/old/claude-config');
  });

  it('ignores a non-Claude restored archive result', async () => {
    const archiveRoot = tempRoot('psu-archive-root-');
    const home = tempRoot('psu-archive-home-');
    const sessionId = '596e539c-58c8-4bc1-aec8-56251d299644';
    const sourceSession = { agent: 'claude', sessionId, configDir: '/old/claude-config' };
    writeClaudeTranscript(archiveRoot, sessionId);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await tryRematerializeFromArchive(sessionId, 'claude', {
      fetchImpl: archiveFetch(archiveRoot, 'codex'),
      operatorUrl: 'https://operator.test',
      token: 'test-token',
      sourceSession,
      home,
    });

    expect(sourceSession.configDir).toBe('/old/claude-config');
  });
});
