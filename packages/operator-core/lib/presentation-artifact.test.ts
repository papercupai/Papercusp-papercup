import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const kit = resolve(import.meta.dirname, '../../../docs/presentations/papercusp-architecture-2026-10-21');
const fixtures: string[] = [];
const required = [
  'README.md', 'build.mjs', 'deck.pdf', 'index.html', 'manifest.json',
  'presenter-notes.md', 'slides.json', 'verification.json', 'verify.mjs',
  'maps/architecture.html', 'maps/architecture.svg', 'maps/cupboard.html', 'maps/cupboard.svg',
  'evidence/overview.png', 'evidence/concepts.png', 'evidence/trace.png',
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-presentation-'));
  fixtures.push(root);
  cpSync(kit, root, { recursive: true });
  symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

function render(root: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    // Execute the copy: even an older verifier's default root is confined to this fixture.
    execFile(process.execPath, [join(root, 'verify.mjs'), root], { timeout: 90_000, maxBuffer: 2_000_000 },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolveRun(stdout));
  });
}

// Expected deliverables and origins come from the owner-facing contract, not the manifest.
function inspectKit(root: string) {
  for (const file of required) assert.ok(statSync(join(root, file)).size > 0, `empty ${file}`);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.mapSources.architecture.publicUrl, 'https://papercusp.com/architecture/');
  assert.equal(manifest.mapSources.cupboard.publicUrl, 'https://papercusp.com/cupboard/');
  assert.deepEqual(manifest.sourceFiles, ['slides.json', 'build.mjs']);
  const verification = JSON.parse(readFileSync(join(root, 'verification.json'), 'utf8'));
  assert.equal(verification.status, 'passed');
  for (const file of verification.files) {
    assert.equal(sha256(readFileSync(join(root, file.path))), file.sha256, `digest mismatch ${file.path}`);
  }
  assert.equal(readFileSync(join(root, 'deck.pdf')).subarray(0, 5).toString(), '%PDF-');
  const archive = join(root, 'presentation.zip');
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual([...entries].sort(), [...required].sort(), 'archive membership');
  for (const file of required) {
    const archived = execFileSync('unzip', ['-p', archive, file], { maxBuffer: 2_000_000 });
    assert.equal(sha256(archived), sha256(readFileSync(join(root, file))), `stale archive ${file}`);
  }
  const notes = readFileSync(join(root, 'presenter-notes.md'), 'utf8');
  assert.match(notes, /30 minute session/);
  assert.match(notes, /28 minutes 20 seconds/);
  assert.equal(verification.spokenTiming.humanRehearsal, 'not performed');
}

afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('architecture presentation artifact', () => {
  it('renders the complete presentation without network', async () => {
    const root = fixture();
    await render(root);
    const result = JSON.parse(readFileSync(join(root, 'verification.json'), 'utf8'));
    expect(result.status).toBe('passed');
    expect(result.checks.map((check: { viewport: { width: number } }) => check.viewport.width)).toEqual([1440, 1280]);
    expect(result.pdf).toMatchObject({ pages: 27, notesExcluded: true, titleCoverage: 'every slide' });
    expect(result.networkRequests).toEqual([]);
    expect(result.browserErrors).toEqual([]);
  }, 120_000);

  it('rejects a layout that displays inactive slides', async () => {
    const root = fixture();
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('.slide{display:none;');
    writeFileSync(join(root, 'index.html'), html.replace('.slide{display:none;', '.slide{display:block;'));
    await expect(render(root)).rejects.toThrow('exactly one slide must be displayed');
  }, 30_000);

  it('delivers an intact editable kit with source attribution', () => { inspectKit(kit); });

  it('rejects missing editable source', () => {
    const root = fixture();
    rmSync(join(root, 'slides.json'));
    expect(() => inspectKit(root)).toThrow(/slides.json/);
  });

  it('rejects source bytes that disagree with the verified package', () => {
    const root = fixture();
    writeFileSync(join(root, 'slides.json'), '{}\n');
    expect(() => inspectKit(root)).toThrow('digest mismatch slides.json');
  });
});
