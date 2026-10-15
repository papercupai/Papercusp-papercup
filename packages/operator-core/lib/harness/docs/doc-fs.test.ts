/**
 * Tests for doc-fs — the docs-tree walk, the `../` traversal guard, and the
 * default-doc picker. Run with:
 *   cd packages/operator-core && npx vitest run lib/harness/docs/doc-fs.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { listDocBodies, safeJoinUnderRoot, readDocBody, chooseDefaultDoc, docFilePath, docIdForRepoPath } from './doc-fs';

describe('safeJoinUnderRoot (traversal guard)', () => {
  const root = '/srv/harness/docs';

  it('joins a normal relative path under the root', () => {
    expect(safeJoinUnderRoot(root, 'guide/intro.md')).toBe('/srv/harness/docs/guide/intro.md');
  });

  it('returns the root itself for an empty / dot path', () => {
    expect(safeJoinUnderRoot(root, '')).toBe(resolvePath(root));
    expect(safeJoinUnderRoot(root, '.')).toBe(resolvePath(root));
  });

  it('rejects a ../ escape', () => {
    expect(safeJoinUnderRoot(root, '../secret.md')).toBeNull();
    expect(safeJoinUnderRoot(root, '../../etc/passwd')).toBeNull();
  });

  it('rejects an absolute path that escapes the root', () => {
    expect(safeJoinUnderRoot(root, '/etc/passwd')).toBeNull();
  });

  it('rejects a sibling-directory prefix attack (docs vs docs-evil)', () => {
    expect(safeJoinUnderRoot(root, '../docs-evil/x.md')).toBeNull();
  });

  it('allows a deep nested path', () => {
    expect(safeJoinUnderRoot(root, 'a/b/c/d.md')).toBe('/srv/harness/docs/a/b/c/d.md');
  });
});

describe('chooseDefaultDoc', () => {
  it('returns null for an empty list', () => {
    expect(chooseDefaultDoc([])).toBeNull();
  });

  it('prefers index.md', () => {
    expect(chooseDefaultDoc(['guide.md', 'README.md', 'index.md'])).toBe('index.md');
  });

  it('falls back to README when there is no index', () => {
    expect(chooseDefaultDoc(['guide.md', 'README.md'])).toBe('README.md');
  });

  it('falls back to the first entry when neither index nor README exist', () => {
    expect(chooseDefaultDoc(['guide.md', 'other.md'])).toBe('guide.md');
  });

  it('is case-insensitive for index/README', () => {
    expect(chooseDefaultDoc(['Guide.md', 'INDEX.MDX'])).toBe('INDEX.MDX');
    expect(chooseDefaultDoc(['a.md', 'readme.mdx'])).toBe('readme.mdx');
  });
});

describe('listDocBodies / readDocBody (real fs)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'doc-fs-'));
    await writeFile(join(root, 'index.md'), '# Index');
    await mkdir(join(root, 'guide'), { recursive: true });
    await writeFile(join(root, 'guide', 'intro.mdx'), '# Intro');
    await writeFile(join(root, 'notes.txt'), 'ignored');       // not .md/.mdx
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeFile(join(root, '.hidden', 'secret.md'), 'skip'); // dot dir skipped
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects only .md/.mdx, relative + sorted, skipping dotfiles/dirs and non-md', async () => {
    expect(await listDocBodies(root)).toEqual(['guide/intro.mdx', 'index.md']);
  });

  it('returns [] for a missing root', async () => {
    expect(await listDocBodies(join(root, 'does-not-exist'))).toEqual([]);
  });

  it('reads a doc body by relative path', async () => {
    expect(await readDocBody(root, 'index.md')).toBe('# Index');
    expect(await readDocBody(root, 'guide/intro.mdx')).toBe('# Intro');
  });

  it('returns null for a missing file', async () => {
    expect(await readDocBody(root, 'nope.md')).toBeNull();
  });

  it('returns null for a traversal attempt rather than reading outside the root', async () => {
    expect(await readDocBody(root, '../../../etc/passwd')).toBeNull();
  });
  it('namespaces a second file-authoritative corpus without copying or hiding the primary', async () => {
    const publicRoot = join(root, '.public-source');
    await mkdir(publicRoot);
    await writeFile(join(publicRoot, 'quickstart.mdx'), '# Public quickstart');
    const roots = { docsRoot: root, sources: { 'public-manual': publicRoot } };
    expect(await listDocBodies(roots)).toEqual(['guide/intro.mdx', 'index.md', 'public-manual/quickstart.mdx']);
    expect(await readDocBody(roots, 'public-manual/quickstart.mdx')).toBe('# Public quickstart');
    expect(await readDocBody(roots, 'index.md')).toBe('# Index');
    expect(docFilePath(roots, 'public-manual/quickstart.mdx')).toBe(join(publicRoot, 'quickstart.mdx'));
    expect(docIdForRepoPath(root, roots, '.public-source/quickstart.mdx')).toBe('public-manual/quickstart.mdx');
    expect(docIdForRepoPath(root, roots, 'index.md')).toBe('index.md');
    expect(await readDocBody(roots, 'public-manual/../index.md')).toBeNull();
    expect(await readDocBody(roots, 'constructor/index.md')).toBeNull();
    await symlink(join(root, 'index.md'), join(publicRoot, 'escape.mdx'));
    expect(await readDocBody(roots, 'public-manual/escape.mdx')).toBeNull();
    await rm(publicRoot, { recursive: true, force: true });
  });
});
