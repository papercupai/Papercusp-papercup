import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(import.meta.resolve('@papercusp/verification-harness/network-isolation'));

describe('installed network isolation entry point', () => {
  it('preserves command arguments and exit status through the package export', () => {
    const result = spawnSync('/bin/bash', [wrapper, '--', process.execPath, '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(39)', 'a b', '$literal'], {
      encoding: 'utf8', env: { ...process.env, PAPERCUSP_E2E_NETNS: 'off' }, timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(39);
    expect(JSON.parse(result.stdout)).toEqual(['a b', '$literal']);
    expect(result.stderr).toContain('isolated=0 mode=off reason=disabled');
  });

  it('refuses required isolation before starting the command when helpers are absent', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'netns-package-'));
    try {
      const result = spawnSync('/bin/bash', [wrapper, '--', process.execPath, '-e',
        'process.stdout.write("COMMAND_STARTED")'], {
        encoding: 'utf8', env: { ...process.env, PATH: emptyPath, PAPERCUSP_E2E_NETNS: 'required' },
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(97);
      expect(result.stderr).toContain('network isolation is required');
      expect(result.stdout).not.toContain('COMMAND_STARTED');
    } finally { rmSync(emptyPath, { recursive: true, force: true }); }
  });

  it('retains DAD diagnostics and refuses to start the command in an unsettled namespace', () => {
    const path = mkdtempSync(join(tmpdir(), 'netns-unsettled-'));
    try {
      // Model only the namespace setup protocol; no host network settings change.
      const bwrap = join(path, 'bwrap');
      writeFileSync(bwrap, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeSync(8, JSON.stringify({ 'child-pid': process.pid }) + '\\n');
fs.closeSync(8);
fs.readSync(9, Buffer.alloc(2), 0, 2, null);
const argv = process.argv.slice(2);
const command = argv.slice(argv.indexOf('--') + 1);
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? 99);
`);
      const pasta = join(path, 'pasta');
      writeFileSync(pasta, '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -P ]; then : > "$2"; break; fi; shift; done\n');
      const ip = join(path, 'ip');
      writeFileSync(ip, '#!/bin/bash\nif [ "$1" = -o ]; then printf "1: tap inet 192.0.2.1/24\\n1: tap inet6 fe80::1/64 tentative\\n"; else printf "FIXTURE_DETAILS %s\\n" "$*"; fi\n');
      for (const file of [bwrap, pasta, ip]) chmodSync(file, 0o755);
      const result = spawnSync('/bin/bash', [wrapper, '--', process.execPath, '-e',
        'console.log("COMMAND_STARTED")'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${path}:${process.env.PATH}`, PAPERCUSP_E2E_NETNS: 'required',
          PAPERCUSP_E2E_NETNS_SETTLE_SEC: '0', VERIFY_TAURI_PID: undefined },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(97);
      expect(result.stdout).not.toContain('COMMAND_STARTED');
      expect(result.stderr).toContain('namespace addresses did not settle within 0s');
      expect(result.stderr).toContain('unsettled namespace diagnostics');
      expect(result.stderr).toContain('FIXTURE_DETAILS -details link show');
      expect(result.stderr).toContain('FIXTURE_DETAILS -6 -details addr show');
      expect(result.stderr).toMatch(/accept_dad=\d/);
    } finally { rmSync(path, { recursive: true, force: true }); }
  });
});
