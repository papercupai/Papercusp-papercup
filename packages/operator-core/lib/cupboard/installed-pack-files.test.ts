/**
 * EI-25837518317183010: an installed trigger pack's files went missing while
 * its installation row stayed live, and the only signal was
 * `trigger_pack_template_unreadable ... at plan.md`, which named no directory.
 *
 * Two guards:
 *  - replacePluginDir never leaves the install target absent or half-written
 *    (it used to rm the target and then copy into it);
 *  - readPackTemplate names the absolute path it looked at and says when the
 *    whole pack directory is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replacePluginDir } from './install-plugin-core';
import { readPackTemplate } from './trigger-pack-materialize';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'installed-pack-files-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(join(dir, rel, '..'), { recursive: true });
    await fs.writeFile(join(dir, rel), body);
  }
}

async function siblings(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe('replacePluginDir', () => {
  it('installs into an absent target and excludes the repo .git', async () => {
    const src = join(root, 'src');
    await writeTree(src, { 'papercusp.json': '{"name":"@acme/pack"}', 'plan.md': 'v1', '.git/HEAD': 'ref' });
    const parent = join(root, 'global-plugins', '@acme');
    await fs.mkdir(parent, { recursive: true });
    const target = join(parent, 'pack');

    await replacePluginDir(src, target);

    expect(await fs.readFile(join(target, 'plan.md'), 'utf8')).toBe('v1');
    expect(existsSync(join(target, '.git'))).toBe(false);
    expect(await siblings(parent)).toEqual(['pack']);
  });

  it('replaces an existing install completely and leaves no staging or set-aside copy', async () => {
    const parent = join(root, 'global-plugins');
    const target = join(parent, 'pack');
    await writeTree(target, { 'papercusp.json': '{}', 'plan.md': 'old', 'stale.md': 'gone after upgrade' });
    const src = join(root, 'src');
    await writeTree(src, { 'papercusp.json': '{}', 'plan.md': 'new' });

    await replacePluginDir(src, target);

    expect(await fs.readFile(join(target, 'plan.md'), 'utf8')).toBe('new');
    expect(existsSync(join(target, 'stale.md'))).toBe(false);
    expect(await siblings(parent)).toEqual(['pack']);
  });

  it('keeps the previous install intact when the copy fails', async () => {
    const parent = join(root, 'global-plugins');
    const target = join(parent, 'pack');
    await writeTree(target, { 'papercusp.json': '{}', 'plan.md': 'installed' });

    await expect(replacePluginDir(join(root, 'no-such-source'), target)).rejects.toThrow();

    expect(await fs.readFile(join(target, 'plan.md'), 'utf8')).toBe('installed');
    expect(await siblings(parent)).toEqual(['pack']);
  });
});

describe('readPackTemplate', () => {
  it('reads a template inside the pack', async () => {
    const pack = join(root, 'pack');
    await writeTree(pack, { 'plan.md': '# plan' });
    await expect(readPackTemplate(pack, 'plan.md', 'triage-message')).resolves.toBe('# plan');
  });

  it('names the absolute path when a template is missing from a present pack', async () => {
    const pack = join(root, 'pack');
    await fs.mkdir(pack, { recursive: true });
    await expect(readPackTemplate(pack, 'plan.md', 'triage-message')).rejects.toMatchObject({
      code: 'trigger_pack_template_unreadable',
      message: expect.stringContaining(join(pack, 'plan.md')),
    });
  });

  it('says the pack directory is missing, with its absolute path, when the installed files are gone', async () => {
    const pack = join(root, 'global-plugins', '@papercupai', 'bug-triage');
    const error = await readPackTemplate(pack, 'plan.md', 'triage-message').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'trigger_pack_template_unreadable' });
    const message = (error as Error).message;
    expect(message).toContain(`the pack directory ${pack} is missing`);
    expect(message).toContain('reinstall');
  });
});
