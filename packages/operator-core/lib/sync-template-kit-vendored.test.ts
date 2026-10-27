import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'p020-vendor-'));
  fixtures.push(path);
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(path, rel)), { recursive: true }); writeFileSync(join(path, rel), text); };
  for (const rel of ['scripts/sync-template-kit-vendored.mjs', 'scripts/lib/vendored-manifest.mjs']) {
    mkdirSync(dirname(join(path, rel)), { recursive: true }); copyFileSync(join(root, rel), join(path, rel));
  }
  write('libs/generic/template-kit/package.json', '{"name":"@papercusp/template-kit","main":"./src/index.ts"}\n');
  write('libs/generic/template-kit/tsconfig.json', '{}\n');
  write('libs/generic/template-kit/src/index.ts', 'export const value = 1;\n');
  write('libs/generic/template-kit/src/index.test.ts', 'dev harness excluded\n');
  write('templates/root/checks/composition.test.ts', 'import { value } from "@papercusp/template-kit";\n');
  mkdirSync(join(path, 'apps/copied-app'), { recursive: true });
  const run = (...args: string[]) => spawnSync(process.execPath, [join(path, 'scripts/sync-template-kit-vendored.mjs'), ...args],
    { encoding: 'utf8', timeout: 10000 });
  return { path, write, run };
}

describe('P020 maintained template-kit derivation', () => {
  it('derives declared app and template targets, detects both drift directions, and is idempotent', () => {
    const { path, write, run } = fixture();
    expect(run('--target=apps/copied-app', '--check').status).toBe(1);
    expect(existsSync(join(path, 'apps/copied-app/template-kit'))).toBe(false);
    expect(run('--target=apps/copied-app').status).toBe(0);
    expect(run('--target=apps/copied-app', '--check').status).toBe(0);
    for (const target of ['templates/root', 'apps/copied-app']) {
      expect(readFileSync(join(path, target, 'template-kit/src/index.ts'), 'utf8')).toBe('export const value = 1;\n');
      expect(existsSync(join(path, target, 'template-kit/src/index.test.ts'))).toBe(false);
    }
    write('libs/generic/template-kit/src/new.ts', 'export const added = true;\n');
    write('apps/copied-app/template-kit/src/stale.ts', 'removed canonical input\n');
    const drift = run('--target=apps/copied-app', '--check');
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('apps/copied-app/template-kit/src/new.ts missing');
    expect(drift.stderr).toContain('apps/copied-app/template-kit/src/stale.ts has no canonical counterpart');
    expect(run('--target=apps/copied-app').status).toBe(0);
    expect(run('--target=apps/copied-app', '--check').status).toBe(0);
    expect(existsSync(join(path, 'apps/copied-app/template-kit/src/stale.ts'))).toBe(false);
  });

  it.each(['../outside', '/tmp/outside', 'apps/../outside', ''])('rejects an escaping target before writing: %s', target => {
    const { path, run } = fixture();
    expect(run(`--target=${target}`).status).toBe(2);
    expect(existsSync(join(path, 'templates/root/template-kit'))).toBe(false);
  });

  it('rejects a symlink escape before writing any target', () => {
    const { path, run } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'p020-outside-'));
    fixtures.push(outside);
    symlinkSync(outside, join(path, 'apps/escaped'));
    expect(run('--target=apps/escaped').status).toBe(2);
    expect(existsSync(join(path, 'templates/root/template-kit'))).toBe(false);
    expect(existsSync(join(outside, 'template-kit'))).toBe(false);
  });

  it.each(['directory', 'runtime-file'])('refuses a symlink inside a derived payload: %s', kind => {
    const { path, write, run } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'p020-payload-outside-'));
    fixtures.push(outside);
    writeFileSync(join(outside, 'index.ts'), 'preserved outside bytes\n');
    if (kind === 'directory') symlinkSync(outside, join(path, 'apps/copied-app/template-kit'));
    else {
      write('apps/copied-app/template-kit/src/placeholder.ts', 'inside\n');
      symlinkSync(join(outside, 'index.ts'), join(path, 'apps/copied-app/template-kit/src/index.ts'));
    }
    expect(run('--target=apps/copied-app').status).toBe(2);
    expect(existsSync(join(path, 'templates/root/template-kit'))).toBe(false);
    expect(readFileSync(join(outside, 'index.ts'), 'utf8')).toBe('preserved outside bytes\n');
  });
});
