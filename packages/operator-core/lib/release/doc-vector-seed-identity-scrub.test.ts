/**
 * WI-10006868: the doc-vector seed's anchors are heading slugs, so a heading that quotes a
 * person leaked into a shipped bundle. These tests run the REAL release audit's --scrub-text
 * against a seed whose anchor carries an identity the audit itself hunts (read from the audit's
 * own --identity-literals, so no identity is written into this file), and pin fail-closed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOC_VECTOR_SEED_FORMAT,
  DOC_VECTOR_SEED_VERSION,
  readDocVectorSeed,
  writeDocVectorSeed,
  type DocVectorSeed,
} from '../search/doc-vector-seed';
import { RELEASE_IDENTITY_AUDIT_SCRIPT, scrubDocVectorSeedIdentity } from './doc-vector-seed-identity-scrub';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** One identity literal the audit refuses: the audit's own list, never a literal in this file. */
function auditedIdentityLiteral(): string {
  const out = execFileSync('python3', [join(REPO_ROOT, RELEASE_IDENTITY_AUDIT_SCRIPT), '--identity-literals'], {
    encoding: 'utf8',
  });
  const literal = out
    .split('\n')
    .map((line) => line.split('\t')[0] ?? '')
    .find((value) => /^[A-Za-z0-9]{6,}$/.test(value));
  if (!literal) throw new Error('the release audit reported no alphanumeric identity literal to test with');
  return literal;
}

function seedWithAnchor(anchor: string): DocVectorSeed {
  return {
    manifest: {
      format: DOC_VECTOR_SEED_FORMAT,
      version: DOC_VECTOR_SEED_VERSION,
      mode: 'gemma',
      profileId: 'test-profile',
      dims: 2,
      dtype: 'f32le',
      sourceKeys: ['papercusp-engineering'],
      rows: [
        ['papercusp-engineering', 'agent-insights/plain', 'overview', 'sha-a'],
        ['papercusp-engineering', 'agent-insights/leaky', anchor, 'sha-b'],
      ],
      createdAt: '2026-10-06T00:00:00.000Z',
    },
    vectors: new Float32Array([0.25, 0.5, 0.75, 1]),
  };
}

const dirs: string[] = [];
async function tempSeedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dvs-scrub-'));
  dirs.push(dir);
  return join(dir, 'doc-vector-seed');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scrubDocVectorSeedIdentity', () => {
  it('supports an injected runner when the importer mocks only synchronous subprocesses', async () => {
    const synchronousRunner = vi.fn();
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ execFileSync: synchronousRunner }));
    try {
      const { scrubDocVectorSeedIdentity: scrub } = await import('./doc-vector-seed-identity-scrub');
      const dir = await tempSeedDir();
      await writeDocVectorSeed(dir, seedWithAnchor('overview-2'));
      const run = vi.fn(async () => {});
      expect(await scrub(dir, REPO_ROOT, run)).toEqual({ rows: 2 });
      expect(run).toHaveBeenCalledWith('python3', [join(REPO_ROOT, RELEASE_IDENTITY_AUDIT_SCRIPT), '--scrub-text', dir]);
      expect(synchronousRunner).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('redacts an audited identity from a heading-slug anchor and keeps every row aligned with its vector', async () => {
    const literal = auditedIdentityLiteral();
    const dir = await tempSeedDir();
    await writeDocVectorSeed(dir, seedWithAnchor(`same-bug-class-the-${literal.toLowerCase()}-incident-fixed`));
    expect((await readFile(join(dir, 'manifest.json'), 'utf8')).toLowerCase()).toContain(literal.toLowerCase());

    const result = await scrubDocVectorSeedIdentity(dir, REPO_ROOT);

    const text = await readFile(join(dir, 'manifest.json'), 'utf8');
    expect(text.toLowerCase()).not.toContain(literal.toLowerCase());
    expect(result.rows).toBe(2);
    const seed = await readDocVectorSeed(dir);
    expect(seed.manifest.rows[0]).toEqual(['papercusp-engineering', 'agent-insights/plain', 'overview', 'sha-a']);
    expect(Array.from(seed.vectors)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('fails closed when the scrub command fails', async () => {
    const dir = await tempSeedDir();
    await writeDocVectorSeed(dir, seedWithAnchor('overview-2'));
    await expect(
      scrubDocVectorSeedIdentity(dir, REPO_ROOT, async () => {
        throw new Error('python3 exited 1');
      }),
    ).rejects.toThrow('python3 exited 1');
  });

  it('fails closed when the rewrite leaves a manifest that no longer matches its vectors', async () => {
    const dir = await tempSeedDir();
    await writeDocVectorSeed(dir, seedWithAnchor('overview-2'));
    await expect(
      scrubDocVectorSeedIdentity(dir, REPO_ROOT, async () => {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
        manifest.rows.pop();
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
      }),
    ).rejects.toThrow();
  });
});
