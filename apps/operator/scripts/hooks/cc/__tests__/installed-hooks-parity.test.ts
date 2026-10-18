import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED_DIR = join(homedir(), '.papercusp', 'hooks', 'cc');
const INSTALLED_EXTENSIONS = new Set(['.mjs', '.py', '.sh']);

function hookFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = name.slice(name.lastIndexOf('.'));
      return (
        INSTALLED_EXTENSIONS.has(ext) &&
        !name.endsWith('.tmp') &&
        !name.endsWith('.bak') &&
        !name.includes('.bak-')
      );
    })
    .sort();
}

function parityProblems(sourceDir: string, installedDir: string): string[] {
  const sources = hookFiles(sourceDir);
  if (sources.length === 0) return ['source hook population is empty'];

  return sources.flatMap((name) => {
    const source = join(sourceDir, name);
    const installed = join(installedDir, name);
    if (!existsSync(installed)) return [`missing installed hook: ${name}`];
    return readFileSync(source).equals(readFileSync(installed))
      ? []
      : [`installed bytes differ: ${name}`];
  });
}

describe('installed cc hook parity', () => {
  it('ships the canonical host-platform home helper unchanged', () => {
    const canonical = resolve(SOURCE_DIR, '../../../../../libs/host-platform/src/home.mjs');
    expect(readFileSync(join(SOURCE_DIR, 'pc_home.mjs'), 'utf8')).toBe(readFileSync(canonical, 'utf8'));
  });

  it('loads affected hooks from a detached installation without node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-load-'));
    const installed = join(root, 'hooks');
    const names = [
      'artifact-url-delivery-guard.mjs',
      'precompact-managed-carry.mjs',
      'pretooluse-schedule-wakeup-provenance.mjs',
      'posttooluse-proof-stale-nudge.mjs',
      'posttooluse-frozen-candidate-edit-nudge.mjs',
      'posttooluse-launch-prose-budget-nudge.mjs',
    ];
    try {
      cpSync(SOURCE_DIR, installed, {
        recursive: true,
        filter: (source) => !source.includes('__tests__'),
      });
      const urls = names.map((name) => pathToFileURL(join(installed, name)).href);
      const run = () => spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `await Promise.all(${JSON.stringify(urls)}.map(url => import(url))); console.log('hooks loaded');`,
      ], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 });
      const loaded = run();
      expect(loaded.stderr).toBe('');
      expect(loaded.status).toBe(0);
      expect(loaded.stdout.trim()).toBe('hooks loaded');

      // A missing dependency must fail this check instead of silently passing
      // through the hooks' fail-open policy.
      rmSync(join(installed, 'pc_home.mjs'));
      const incomplete = run();
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain('ERR_MODULE_NOT_FOUND');
      expect(incomplete.stderr).toContain('pc_home.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps atomic-edit temporary files out of the source hook directory', () => {
    const transient = readdirSync(SOURCE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.includes('.tmp'))
      .map((entry) => entry.name)
      .sort();

    expect(transient).toEqual([]);
  });

  it('detects a missing installed hook and byte drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-parity-'));
    const sourceDir = join(root, 'source');
    const installedDir = join(root, 'installed');
    mkdirSync(sourceDir);
    mkdirSync(installedDir);

    try {
      writeFileSync(join(sourceDir, 'probe.sh'), 'source bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([
        'missing installed hook: probe.sh',
      ]);

      writeFileSync(join(installedDir, 'probe.sh'), 'source bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([]);

      writeFileSync(join(installedDir, 'probe.sh'), 'stale installed bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([
        'installed bytes differ: probe.sh',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The green checkpoint runs from a frozen checkout on a host whose installed
  // hooks follow the live operator. Comparing those two generations makes a
  // source change fail CI even when the installer and both copies are correct.
  // Keep the live parity probe available explicitly for operator diagnosis;
  // the fixture test above remains in every suite and proves drift detection.
  it.runIf(process.env.PAPERCUSP_VERIFY_INSTALLED_CC_HOOKS === '1')(
    'every current hook source matches the installed runtime copy byte-for-byte',
    () => {
      expect(existsSync(INSTALLED_DIR)).toBe(true);
      expect(parityProblems(SOURCE_DIR, INSTALLED_DIR)).toEqual([]);
    },
  );
});
