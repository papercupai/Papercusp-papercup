/**
 * jsonlAtDepth descend-filter contract (session-db-archive-retire-dirs
 * P-005). The su-codex-homes root is FAT (~20 subdirs per home; historically
 * 282k dirs total) — the descend filter must keep the walk pinned to
 * <home>/sessions/YYYY/MM/DD and never enumerate the rest (the 2026-07-05
 * sweep-hang class).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const discoveryReads = vi.hoisted(() => ({ enabled: false, active: 0, peak: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    if (!discoveryReads.enabled) return actual.readdir(...args);
    discoveryReads.active++;
    discoveryReads.peak = Math.max(discoveryReads.peak, discoveryReads.active);
    try { return await actual.readdir(...args); }
    finally { discoveryReads.active--; }
  } };
});
import { codexTranscriptMeta, jsonlAtDepth } from './session-ingest';

let root: string | null = null;
afterEach(async () => {
  discoveryReads.enabled = false;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('jsonlAtDepth', () => {
  it('overlaps discovery reads with a bounded fanout while preserving every transcript', async () => {
    root = await mkdtemp(join(tmpdir(), 'walker-bounded-'));
    const expected: string[] = [];
    for (let i = 0; i < 48; i++) {
      const day = join(root, `session-${i}`);
      await mkdir(day);
      const file = join(day, 'rollout.jsonl');
      await writeFile(file, 'a\n');
      await writeFile(join(day, 'ignore.txt'), 'not a transcript');
      expected.push(file);
    }
    discoveryReads.active = discoveryReads.peak = 0;
    discoveryReads.enabled = true;
    const found = await jsonlAtDepth(root, 1);
    expect(found.sort()).toEqual(expected.sort());
    expect(discoveryReads.peak).toBeGreaterThan(1);
    expect(discoveryReads.peak).toBeLessThanOrEqual(16);
    expect(discoveryReads.active).toBe(0);
  });

  it('descend filter prunes non-sessions subtrees of per-session codex homes', async () => {
    root = await mkdtemp(join(tmpdir(), 'walker-'));
    // the real payload
    await mkdir(join(root, 'session-1', 'sessions', '2026', '07', '10'), { recursive: true });
    await writeFile(join(root, 'session-1', 'sessions', '2026', '07', '10', 'rollout-a.jsonl'), 'a\n');
    await mkdir(join(root, 'session-2', 'sessions', '2026', '07', '09'), { recursive: true });
    await writeFile(join(root, 'session-2', 'sessions', '2026', '07', '09', 'rollout-b.jsonl'), 'b\n');
    // noise at the same depth under a NON-sessions level-2 dir
    await mkdir(join(root, 'session-1', 'chrome', 'x', 'y', 'z'), { recursive: true });
    await writeFile(join(root, 'session-1', 'chrome', 'x', 'y', 'z', 'noise.jsonl'), 'n\n');

    const unfiltered = await jsonlAtDepth(root, 5);
    expect(unfiltered.length).toBe(3); // proves the noise IS reachable without the filter

    const filtered = await jsonlAtDepth(root, 5, (name, level) => (level === 2 ? name === 'sessions' : true));
    expect(filtered.map((p) => p.split('/').pop()).sort()).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl']);
  });

  it('missing root yields empty, never throws', async () => {
    expect(await jsonlAtDepth('/nonexistent-root-xyz', 3)).toEqual([]);
  });
});

describe('codexTranscriptMeta (WI-4664)', () => {
  it('stamps a managed per-session Codex rollout with diagnostics.lockOwnerSid', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-meta-'));
    const day = join(root, 'su-codex-homes', 'session-11801', 'sessions', '2026', '07', '13');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(root, 'su-codex-homes', 'session-11801', 'papercusp-diagnostics.json'),
      JSON.stringify({ lockOwnerSid: 'su-owner-123' }),
    );
    const path = join(day, 'rollout-2026-07-13T00-00-00-019f4fa9-4a09-78c0-8a35-d7e3382d1f8f.jsonl');

    expect(codexTranscriptMeta(path)).toEqual({
      sessionId: '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f',
      owner: 'su-owner-123',
    });
  });

  it('fails closed for shared, missing, or malformed diagnostics', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-meta-'));
    const managedDay = join(root, 'su-codex-homes', 'session-1', 'sessions', '2026', '07', '13');
    await mkdir(managedDay, { recursive: true });
    const managed = join(managedDay, 'rollout-2026-07-13T00-00-00-session-id.jsonl');
    expect(codexTranscriptMeta(managed)).toMatchObject({ owner: null });

    await writeFile(join(root, 'su-codex-homes', 'session-1', 'papercusp-diagnostics.json'), '{bad');
    expect(codexTranscriptMeta(managed)).toMatchObject({ owner: null });

    const shared = join(root, '.codex', 'sessions', '2026', '07', '13', 'rollout-shared.jsonl');
    expect(codexTranscriptMeta(shared)).toMatchObject({ owner: null });
  });
});
