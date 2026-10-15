import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COLDSNAP_PIN,
  coldsnapCompositionOption,
  coldsnapCrateUrl,
  installPinnedColdsnap,
  inspectPinnedColdsnap,
  pinnedColdsnapExecutable,
  pinnedColdsnapRoot,
  patchColdsnapDiagnosticSource,
  resolveColdsnapExecutable,
  sha256Hex,
  type ColdsnapInstallDeps,
  type ColdsnapPin,
} from './coldsnap-pin';

const CRATE = new TextEncoder().encode('fake coldsnap crate bytes');
const PIN: ColdsnapPin = { version: '9.9.9', crateSha256: sha256Hex(CRATE) };

/** An in-memory install world: files, executables and a recorded command log. */
function world(options: { crate?: Uint8Array; cargoProducesBinary?: boolean } = {}) {
  const files = new Map<string, string>();
  const executables = new Set<string>();
  const commands: { command: string; args: readonly string[] }[] = [];
  const removed: string[] = [];
  const deps: ColdsnapInstallDeps = {
    fetchBytes: async () => options.crate ?? CRATE,
    run(command, args) {
      commands.push({ command, args });
      if (command === 'cargo' && options.cargoProducesBinary !== false) {
        const root = args[args.indexOf('--root') + 1]!;
        executables.add(join(root, 'bin', 'coldsnap'));
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    makeTempDir: async () => '/tmp/work',
    removeDir: async (path) => void removed.push(path),
    writeFile: async (path, data) => void files.set(path, typeof data === 'string' ? data : `<${data.length} bytes>`),
    readFile: async (path) => files.get(path),
    isExecutable: (path) => executables.has(path),
    now: () => new Date('2026-10-02T22:00:00Z'),
  };
  return { deps, files, executables, commands, removed };
}

describe('coldsnap pin', () => {
  it('pins a published crate version with a 64-hex sha256 and a static.crates.io url', () => {
    expect(COLDSNAP_PIN.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(COLDSNAP_PIN.crateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(coldsnapCrateUrl()).toBe(`https://static.crates.io/crates/coldsnap/coldsnap-${COLDSNAP_PIN.version}.crate`);
  });

  it('installs into a versioned root under ~/.papercusp/tools', () => {
    expect(pinnedColdsnapRoot('/home/u', PIN)).toBe('/home/u/.papercusp/tools/coldsnap/9.9.9');
    expect(pinnedColdsnapExecutable('/home/u', PIN)).toBe('/home/u/.papercusp/tools/coldsnap/9.9.9/bin/coldsnap');
  });
});

describe('resolveColdsnapExecutable', () => {
  const pinned = pinnedColdsnapExecutable('/home/u');

  it('lets an explicit override win even when the pinned binary is installed', () => {
    expect(resolveColdsnapExecutable({ HOME: '/home/u', PAPERCUSP_AWS_COLDSNAP_EXECUTABLE: '/opt/coldsnap' }, () => true)).toBe('/opt/coldsnap');
  });

  it('uses the pinned binary when it is installed and executable', () => {
    expect(resolveColdsnapExecutable({ HOME: '/home/u' }, (path) => path === pinned)).toBe(pinned);
    expect(coldsnapCompositionOption({ HOME: '/home/u' }, (path) => path === pinned)).toEqual({ coldsnapExecutable: pinned });
  });

  it('falls back to the PATH default (undefined) when neither is available', () => {
    expect(resolveColdsnapExecutable({ HOME: '/home/u' }, () => false)).toBeUndefined();
    expect(resolveColdsnapExecutable({}, () => true)).toBeUndefined();
    expect(coldsnapCompositionOption({}, () => true)).toEqual({});
  });

  describe('against the real filesystem', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'coldsnap-pin-'));
    });
    afterEach(async () => rm(home, { recursive: true, force: true }));

    it('requires the pinned file to be executable, not merely present', async () => {
      const path = pinnedColdsnapExecutable(home);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '#!/bin/sh\n');
      expect(resolveColdsnapExecutable({ HOME: home })).toBeUndefined();
      await chmod(path, 0o755);
      expect(resolveColdsnapExecutable({ HOME: home })).toBe(path);
    });
  });
});

describe('installPinnedColdsnap', () => {
  const mainSource = 'async fn main() { if let Err(e) = run().await { eprintln!("{e}"); } }';
  const uploadSource = 'elapsed.as_secs_f64(),\n                            e\n' +
    'let error_report: String = block_errors.values().map(|e| e.to_string()).collect();';

  it('keeps diagnostic binaries separate and refuses an uninstrumented stamp', async () => {
    const pin: ColdsnapPin = { ...PIN, diagnosticsRevision: 1 };
    const w = world();
    const root = pinnedColdsnapRoot('/home/u', pin);
    expect(root).not.toBe(pinnedColdsnapRoot('/home/u', PIN));
    w.executables.add(pinnedColdsnapExecutable('/home/u', pin));
    w.files.set(join(root, 'papercusp-coldsnap.json'), JSON.stringify({
      version: pin.version, crateSha256: pin.crateSha256, installedAt: w.deps.now().toISOString(),
    }));
    expect((await inspectPinnedColdsnap('/home/u', w.deps, pin)).installed).toBe(false);
    w.files.set('/tmp/work/coldsnap-9.9.9/src/bin/coldsnap/main.rs', mainSource);
    w.files.set('/tmp/work/coldsnap-9.9.9/src/upload.rs', uploadSource);
    await installPinnedColdsnap('/home/u', w.deps, { pin });
    expect((await inspectPinnedColdsnap('/home/u', w.deps, pin)).installed).toBe(true);
    expect(w.files.get('/tmp/work/coldsnap-9.9.9/src/bin/coldsnap/main.rs')).toContain('snafu::Report::from_error(&e)');
    expect(w.files.get('/tmp/work/coldsnap-9.9.9/src/upload.rs')).toContain('snafu::Report::from_error(e).to_string()');
    expect(w.commands[1]!.args).toContain(root);
    expect((await installPinnedColdsnap('/home/u', w.deps, { pin })).status).toBe('already-installed');
    expect(w.commands).toHaveLength(2);
  });

  it.each(['main', 'upload'] as const)('refuses missing or duplicated %s error sites before cargo runs', async (file) => {
    const source = file === 'main' ? mainSource : uploadSource;
    expect(() => patchColdsnapDiagnosticSource('', file)).toThrow(/exactly one source anchor/);
    expect(() => patchColdsnapDiagnosticSource(source + source, file)).toThrow(/exactly one source anchor/);
    const w = world();
    w.files.set('/tmp/work/coldsnap-9.9.9/src/bin/coldsnap/main.rs', file === 'main' ? '' : mainSource);
    w.files.set('/tmp/work/coldsnap-9.9.9/src/upload.rs', file === 'upload' ? '' : uploadSource);
    await expect(installPinnedColdsnap('/home/u', w.deps, { pin: { ...PIN, diagnosticsRevision: 1 } })).rejects.toThrow(/refusing to build/);
    expect(w.commands.map(c => c.command)).toEqual(['tar']);
    expect([...w.files.keys()].some(path => path.endsWith('papercusp-coldsnap.json'))).toBe(false);
    expect(w.removed).toEqual(['/tmp/work']);
  });

  it('verifies the crate checksum, builds it --locked into the versioned root, and stamps it last', async () => {
    const w = world();
    const result = await installPinnedColdsnap('/home/u', w.deps, { pin: PIN });
    expect(result).toEqual({
      status: 'installed',
      version: '9.9.9',
      executable: '/home/u/.papercusp/tools/coldsnap/9.9.9/bin/coldsnap',
      crateSha256: PIN.crateSha256,
    });
    expect(w.commands.map((c) => c.command)).toEqual(['tar', 'cargo']);
    expect(w.commands[1]!.args).toEqual([
      'install', '--locked', '--force', '--path', '/tmp/work/coldsnap-9.9.9', '--root', '/home/u/.papercusp/tools/coldsnap/9.9.9',
    ]);
    expect(JSON.parse(w.files.get('/home/u/.papercusp/tools/coldsnap/9.9.9/papercusp-coldsnap.json')!)).toMatchObject({
      version: '9.9.9',
      crateSha256: PIN.crateSha256,
    });
    expect(w.removed).toEqual(['/tmp/work']);
  });

  it('refuses a crate whose checksum differs from the pin before unpacking or building anything', async () => {
    const w = world({ crate: new TextEncoder().encode('tampered crate') });
    await expect(installPinnedColdsnap('/home/u', w.deps, { pin: PIN })).rejects.toThrow(/checksum mismatch/);
    expect(w.commands).toEqual([]);
    expect([...w.files.keys()]).toEqual([]);
  });

  it('is idempotent once the stamped binary matches the pin', async () => {
    const w = world();
    await installPinnedColdsnap('/home/u', w.deps, { pin: PIN });
    const again = await installPinnedColdsnap('/home/u', w.deps, { pin: PIN });
    expect(again.status).toBe('already-installed');
    expect(w.commands).toHaveLength(2);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['non-string', 1790982000000],
    ['invalid date', 'not-a-date'],
  ])('does not trust an install stamp with a %s timestamp', async (_label, installedAt) => {
    const w = world();
    const executable = pinnedColdsnapExecutable('/home/u', PIN);
    w.executables.add(executable);
    w.files.set(join(pinnedColdsnapRoot('/home/u', PIN), 'papercusp-coldsnap.json'), JSON.stringify({
      version: PIN.version,
      crateSha256: PIN.crateSha256,
      installedAt,
    }));

    expect(await inspectPinnedColdsnap('/home/u', w.deps, PIN)).toEqual({
      installed: false,
      executable,
      reason: 'install stamp missing or unreadable',
    });
    expect((await installPinnedColdsnap('/home/u', w.deps, { pin: PIN })).status).toBe('installed');
    expect(w.commands.map((c) => c.command)).toEqual(['tar', 'cargo']);
    expect(await inspectPinnedColdsnap('/home/u', w.deps, PIN)).toEqual({ installed: true, executable });
  });

  it('rebuilds when the stamp records a different pin (a pin bump never trusts the old build)', async () => {
    const w = world();
    await installPinnedColdsnap('/home/u', w.deps, { pin: PIN });
    const root = pinnedColdsnapRoot('/home/u', PIN);
    w.files.set(join(root, 'papercusp-coldsnap.json'), JSON.stringify({
      version: '9.9.9', crateSha256: '0'.repeat(64), installedAt: w.deps.now().toISOString(),
    }));
    expect((await installPinnedColdsnap('/home/u', w.deps, { pin: PIN })).status).toBe('installed');
    expect(w.commands).toHaveLength(4);
  });

  it('writes no stamp when cargo leaves no executable behind', async () => {
    const w = world({ cargoProducesBinary: false });
    await expect(installPinnedColdsnap('/home/u', w.deps, { pin: PIN })).rejects.toThrow(/not executable/);
    expect([...w.files.keys()].some((path) => path.endsWith('papercusp-coldsnap.json'))).toBe(false);
    expect(w.removed).toEqual(['/tmp/work']);
  });
});
