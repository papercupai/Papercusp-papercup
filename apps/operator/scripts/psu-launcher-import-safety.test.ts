import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isolatedLauncherImport() {
  const home = mkdtempSync(join(tmpdir(), 'psu-import-safety-'));
  try {
    const output = execFileSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      timeout: 15_000,
      // Production psu starts in bare Node. A test-runner loader must not
      // resolve extensionless imports that would crash that real entrypoint.
      env: { ...process.env, HOME: home, NODE_OPTIONS: '' },
      input: `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        for (const key of ['PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_MCP_PROXY',
          'PAPERCUSP_MCP_PROXY_PORT', 'PAPERCUSP_OPERATOR_URL_PROVENANCE']) {
          delete process.env[key];
        }
        const probes = [];
        childProcess.spawnSync = (command, args) => {
          probes.push({ command, args });
          return { status: 0, stdout: command === 'curl' ? '200' : '', stderr: '' };
        };
        syncBuiltinESMExports();
        const launcher = await import(${JSON.stringify(new URL('./psu-launcher.mjs', import.meta.url).href)});
        launcher.sanitizeInheritedEnv({ PAPERCUSP_HARNESS_SLUG: 'isolated' });
        const afterImport = probes.length;
        const explicit = { url: 'http://127.0.0.1:4567', source: 'env' };
        const explicitEnv = {};
        launcher.applyLauncherOperatorUrlEnv(explicitEnv, explicit);
        const afterExplicit = probes.length;
        const first = {};
        launcher.applyLauncherOperatorUrlEnv(first);
        const afterFirstUse = probes.length;
        const second = {};
        launcher.applyLauncherOperatorUrlEnv(second);
        const afterSecondUse = probes.length;
        launcher.adoptOperatorTarget({ url: 'http://127.0.0.1:6789', source: 'env' });
        const adopted = {};
        launcher.applyLauncherOperatorUrlEnv(adopted);
        console.log(JSON.stringify({ afterImport, afterExplicit, afterFirstUse,
          afterSecondUse, afterAdoption: probes.length, adopted,
          explicitEnv, first, second, probes }));
      `,
    });
    return JSON.parse(output);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('launcher import does not discover a live operator', () => {
  it('keeps helper imports and explicitly supplied targets free of subprocess probes', () => {
    const result = isolatedLauncherImport();
    expect(result.afterImport).toBe(0);
    expect(result.afterExplicit).toBe(0);
    expect(result.explicitEnv.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:4567');
    expect(result.explicitEnv.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
  });

  it('uses the existing proxy discovery on first target use and caches that target', () => {
    const result = isolatedLauncherImport();
    expect(result.afterImport).toBe(0);
    expect(result.afterFirstUse).toBe(1);
    expect(result.afterSecondUse).toBe(result.afterFirstUse);
    expect(result.probes[0].command).toBe('curl');
    expect(result.probes[0].args.at(-1)).toBe('http://127.0.0.1:9071/__mcp_proxy_health');
    expect(result.first.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
    expect(result.first.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
    expect(result.second).toEqual(result.first);
    expect(result.afterAdoption).toBe(result.afterFirstUse);
    expect(result.adopted.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:6789');
    expect(result.adopted.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
  });
});
