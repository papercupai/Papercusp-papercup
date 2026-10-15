/**
 * Tests for omp-integration (P-010 of
 * desktop-app-install-integration-2026-05-23).
 *
 * Fake ~/.omp/ + ~/.papercusp/ tree under tmp; covers:
 *  - merge preserves other MCP servers
 *  - re-run is a no-op when already current
 *  - wrapper installs at omp-co-located path when binary detected
 *  - wrapper falls back to ~/.local/bin/omp-su when no binary
 *  - pathWarning fires when wrapperDir not on PATH
 *  - legacy block stripped from CLAUDE.md
 *  - legacy auto-discovered extension removed
 *  - phase1_not_run reason when token + agent_id missing
 *  - uninstall removes papercusp-su but preserves other servers
 *  - read-only state snapshot vs. install action
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  installOmpIntegration,
  uninstallOmpIntegration,
  readOmpIntegrationState,
  resolveOmpPaths,
  ensureOmpGatewayProvider,
  removeOmpGatewayProvider,
} from '../omp-integration';
import { resolveInstallPaths } from '../papercusp-files';

let tmpHome: string;

async function seedPhase1(home: string, token = 'tok-abc-123', agentId = 'agent-456') {
  const p = resolveInstallPaths(home);
  await fs.mkdir(p.papercuspDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.tokenPath, token + '\n', { mode: 0o600 });
  await fs.writeFile(p.agentIdPath, agentId + '\n', { mode: 0o600 });
}

async function makeFakeOmp(): Promise<string> {
  const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-omp-bin-'));
  const fakeOmp = path.join(fakeBinDir, 'omp');
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'LOG="$HOME/.omp-config-log"',
    'mkdir -p "$HOME"',
    'if [ "${1:-}" = "config" ] && [ "${2:-}" = "get" ]; then',
    '  KEY="$3"',
    '  FILE="$HOME/.omp-config-${KEY//\\//_}"',
    '  if [ -f "$FILE" ]; then cat "$FILE"; fi',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ]; then',
    '  KEY="$3"',
    '  VALUE="$4"',
    '  FILE="$HOME/.omp-config-${KEY//\\//_}"',
    '  printf "%s" "$VALUE" > "$FILE"',
    '  printf "%s=%s\\n" "$KEY" "$VALUE" >> "$LOG"',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n');
  await fs.writeFile(fakeOmp, script, { mode: 0o755 });
  return fakeOmp;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-omp-int-'));
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('ensureOmpGatewayProvider / removeOmpGatewayProvider (P-001)', () => {
  const modelsYml = () => resolveOmpPaths(tmpHome).modelsYmlPath;

  it('creates models.yml with the papercusp-gateway provider when absent', async () => {
    const r = await ensureOmpGatewayProvider(modelsYml(), { port: 8788 });
    expect(r).toEqual({ wrote: true, created: true });
    const txt = await fs.readFile(modelsYml(), 'utf8');
    expect(txt).toContain('papercusp-gateway:');
    expect(txt).toContain('http://127.0.0.1:8788');
    expect(txt).toContain('claude-sonnet-4-6');
    expect(txt).toContain('x-papercusp-priority');
  });

  it('is idempotent on re-run (no second write)', async () => {
    await ensureOmpGatewayProvider(modelsYml(), { port: 8788 });
    expect(await ensureOmpGatewayProvider(modelsYml(), { port: 8788 })).toEqual({ wrote: false, created: false });
  });

  it('preserves other providers, the default, and comments', async () => {
    await fs.mkdir(path.dirname(modelsYml()), { recursive: true });
    await fs.writeFile(modelsYml(), '# my comment\nproviders:\n  ollama:\n    baseUrl: "http://127.0.0.1:11434"\n');
    const r = await ensureOmpGatewayProvider(modelsYml(), { port: 9999 });
    expect(r.wrote).toBe(true);
    const txt = await fs.readFile(modelsYml(), 'utf8');
    expect(txt).toContain('# my comment');          // comment preserved
    expect(txt).toContain('ollama:');                // other provider preserved
    expect(txt).toContain('papercusp-gateway:');      // new provider added
    expect(txt).toContain('http://127.0.0.1:9999');   // honors the port override
  });

  it('removeOmpGatewayProvider deletes only the gateway provider', async () => {
    await fs.mkdir(path.dirname(modelsYml()), { recursive: true });
    await fs.writeFile(modelsYml(), 'providers:\n  ollama:\n    baseUrl: "x"\n');
    await ensureOmpGatewayProvider(modelsYml(), { port: 8788 });
    expect(await removeOmpGatewayProvider(modelsYml())).toBe(true);
    const txt = await fs.readFile(modelsYml(), 'utf8');
    expect(txt).not.toContain('papercusp-gateway');
    expect(txt).toContain('ollama:');
    expect(await removeOmpGatewayProvider(modelsYml())).toBe(false); // second remove is a no-op
  });
});

describe('installOmpIntegration', () => {
  it('phase1 not run: returns reason=phase1_not_run, no changes', async () => {
    const result = await installOmpIntegration({ home: tmpHome, ompBinaryPath: null });
    expect(result.supported).toBe(true);
    expect(result.reason).toBe('phase1_not_run');
    expect(result.changed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.mcpServerInstalled).toBe(false);
  });

  it('first run: creates mcp.json (omp-su wrapper retired — NOT installed, P-050)', async () => {
    await seedPhase1(tmpHome);
    const result = await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });
    expect(result.supported).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.mcpServerInstalled).toBe(true);
    expect(result.wrapperInstalled).toBe(false); // wrapper retired — install no longer writes it
    expect(result.wrapperPath).toBe(path.join(tmpHome, '.local', 'bin', 'omp-su'));

    const cfg = JSON.parse(
      await fs.readFile(resolveOmpPaths(tmpHome).mcpJsonPath, 'utf8'),
    );
    expect(cfg.mcpServers['papercusp-su']).toEqual({
      type: 'http',
      url: 'http://localhost:3070/api/mcp?superuser=1&client=agent-456',
      headers: {
        Authorization: 'Bearer tok-abc-123',
        'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
        'x-papercusp-workspace': '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
        'x-papercusp-profile': '!printf %s "${PAPERCUSP_PROFILE:-}"',
        'x-papercusp-harness': '!printf %s "${PAPERCUSP_HARNESS_SLUG:-}"',
      },
    });
  });

  it('P-007: default fallback (no operatorUrl, no PAPERCUSP_MCP_PROXY_BASE) bakes the resilient :9071 proxy, never direct :3070', async () => {
    await seedPhase1(tmpHome);
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    try {
      const result = await installOmpIntegration({ home: tmpHome, ompBinaryPath: null });
      expect(result.changed).toBe(true);
      const cfg = JSON.parse(await fs.readFile(resolveOmpPaths(tmpHome).mcpJsonPath, 'utf8'));
      // OMP reads the url LITERALLY (no env interpolation), so the reconciler must
      // bake the restart-resilient proxy by default — a direct :3070 re-minted away
      // the P-006 cutover within minutes (the same class P-007 fixed for claude).
      expect(cfg.mcpServers['papercusp-su'].url).toBe(
        'http://127.0.0.1:9071/api/mcp?superuser=1&client=agent-456',
      );
    } finally {
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
    }
  });

  it('wrapperPath co-locates with the detected omp binary (no wrapper written, P-050)', async () => {
    await seedPhase1(tmpHome);
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-bin-'));
    const fakeOmp = path.join(fakeBinDir, 'omp');
    await fs.writeFile(fakeOmp, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const result = await installOmpIntegration({
        home: tmpHome,
        operatorUrl: 'http://localhost:3070',
        ompBinaryPath: fakeOmp,
      });
      // Path is still reported (so a stale wrapper can be found), but install
      // no longer writes one.
      expect(result.wrapperPath).toBe(path.join(fakeBinDir, 'omp-su'));
      expect(result.wrapperInstalled).toBe(false);
      await expect(fs.access(result.wrapperPath)).rejects.toThrow();
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('configures OMP-native Hindsight when an omp binary is available', async () => {
    await seedPhase1(tmpHome);
    const fakeOmp = await makeFakeOmp();
    try {
      await installOmpIntegration({
        home: tmpHome,
        operatorUrl: 'http://localhost:3070',
        ompBinaryPath: fakeOmp,
      });
      const logPath = path.join(tmpHome, '.omp-config-log');
      const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
      expect(lines).toEqual([
        'memory.backend=hindsight',
        'hindsight.apiUrl=http://localhost:8888',
        'hindsight.scoping=per-project-tagged',
        'hindsight.autoRecall=true',
        'hindsight.autoRetain=true',
      ]);

      await installOmpIntegration({
        home: tmpHome,
        operatorUrl: 'http://localhost:3070',
        ompBinaryPath: fakeOmp,
      });
      const secondLines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
      expect(secondLines).toEqual(lines);
    } finally {
      await fs.rm(path.dirname(fakeOmp), { recursive: true, force: true });
    }
  });

  it('does not run OMP config through a PATH entry that delegates to psu --agent=omp', async () => {
    await seedPhase1(tmpHome);
    const originalPath = process.env.PATH;
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-psu-omp-bin-'));
    const fakeOmp = path.join(fakeBinDir, 'omp');
    const invocationLog = path.join(tmpHome, 'psu-shim-invoked.log');
    const psuLauncher = path.join(tmpHome, 'scripts', 'psu.mjs');

    await fs.writeFile(
      fakeOmp,
      [
        '#!/bin/sh',
        `# hosted wrapper: node ${psuLauncher} --agent=omp "$@"`,
        `printf '%s\\n' "$*" >> "${invocationLog}"`,
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.PATH = [fakeBinDir, originalPath].filter(Boolean).join(path.delimiter);

    try {
      const result = await installOmpIntegration({ home: tmpHome });

      expect(result.ompBinaryPath).toBeNull();
      expect(result.actions.some((action) => action.startsWith('configured OMP Hindsight'))).toBe(false);
      await expect(fs.access(invocationLog)).rejects.toThrow();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await fs.rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('reports changed=true when it corrects stale OMP Hindsight config', async () => {
    await seedPhase1(tmpHome);
    const fakeOmp = await makeFakeOmp();
    try {
      await installOmpIntegration({
        home: tmpHome,
        operatorUrl: 'http://localhost:3070',
        ompBinaryPath: fakeOmp,
      });
      await fs.writeFile(path.join(tmpHome, '.omp-config-memory.backend'), 'memory', 'utf8');

      const rerun = await installOmpIntegration({
        home: tmpHome,
        operatorUrl: 'http://localhost:3070',
        ompBinaryPath: fakeOmp,
      });

      expect(rerun.changed).toBe(true);
      expect(rerun.actions).toContain(
        'configured OMP Hindsight (memory.backend)',
      );
    } finally {
      await fs.rm(path.dirname(fakeOmp), { recursive: true, force: true });
    }
  });

  it('re-run is a no-op (returns changed=false, empty actions)', async () => {
    await seedPhase1(tmpHome);
    const first = await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });
    expect(first.changed).toBe(true);

    const second = await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });
    expect(second.changed).toBe(false);
    expect(second.actions).toEqual([]);
    expect(second.mcpServerInstalled).toBe(true);
    expect(second.wrapperInstalled).toBe(false); // wrapper retired (P-050)
  });

  it('WI-4393: heals a stale pre-carrier-headers entry (mcpEntryEquals used to compare only Authorization, so a header-set change here silently never reached an already-installed machine)', async () => {
    await seedPhase1(tmpHome);
    const ompPaths = resolveOmpPaths(tmpHome);
    await fs.mkdir(ompPaths.ompAgentDir, { recursive: true });
    // Simulate a machine installed before the x-papercusp-* carrier headers
    // existed on this entry: same type/url/Authorization, headers otherwise bare.
    await fs.writeFile(
      ompPaths.mcpJsonPath,
      JSON.stringify({
        mcpServers: {
          'papercusp-su': {
            type: 'http',
            url: 'http://localhost:3070/api/mcp?superuser=1&client=agent-456',
            headers: { Authorization: 'Bearer tok-abc-123' },
          },
        },
      }),
    );

    const result = await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });

    expect(result.changed).toBe(true);
    expect(result.actions).toContain('updated mcpServers.papercusp-su');
    const cfg = JSON.parse(await fs.readFile(ompPaths.mcpJsonPath, 'utf8'));
    expect(cfg.mcpServers['papercusp-su'].headers).toEqual({
      Authorization: 'Bearer tok-abc-123',
      'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
      'x-papercusp-workspace': '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
      'x-papercusp-profile': '!printf %s "${PAPERCUSP_PROFILE:-}"',
      'x-papercusp-harness': '!printf %s "${PAPERCUSP_HARNESS_SLUG:-}"',
    });

    // And THIS reconciled state is now itself a stable fixed point.
    const second = await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });
    expect(second.changed).toBe(false);
  });

  it('merge preserves other MCP servers in mcp.json', async () => {
    await seedPhase1(tmpHome);
    const ompPaths = resolveOmpPaths(tmpHome);
    await fs.mkdir(ompPaths.ompAgentDir, { recursive: true });
    await fs.writeFile(
      ompPaths.mcpJsonPath,
      JSON.stringify({
        mcpServers: {
          'other-server': { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer y' } },
        },
        unrelated: 'preserved',
      }),
    );

    await installOmpIntegration({
      home: tmpHome,
      operatorUrl: 'http://localhost:3070',
      ompBinaryPath: null,
    });

    const cfg = JSON.parse(await fs.readFile(ompPaths.mcpJsonPath, 'utf8'));
    expect(cfg.mcpServers['other-server']).toBeDefined();
    expect(cfg.mcpServers['papercusp-su']).toBeDefined();
    expect(cfg.unrelated).toBe('preserved');
  });

  it('strips the legacy CLAUDE.md playbook block', async () => {
    await seedPhase1(tmpHome);
    const ompPaths = resolveOmpPaths(tmpHome);
    await fs.mkdir(ompPaths.ompAgentDir, { recursive: true });
    const before = [
      '# top of file',
      '',
      '<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->',
      'old playbook content',
      '<!-- END papercusp-su playbook -->',
      '',
      '# bottom of file',
      '',
    ].join('\n');
    await fs.writeFile(ompPaths.legacyContextPath, before);

    const result = await installOmpIntegration({
      home: tmpHome,
      ompBinaryPath: null,
    });
    expect(result.actions.some((a) => a.startsWith('stripped legacy'))).toBe(true);

    const after = await fs.readFile(ompPaths.legacyContextPath, 'utf8');
    expect(after).not.toContain('BEGIN papercusp-su playbook');
    expect(after).toContain('# top of file');
    expect(after).toContain('# bottom of file');
  });

  it('removes the legacy auto-discovered extension copy', async () => {
    await seedPhase1(tmpHome);
    const ompPaths = resolveOmpPaths(tmpHome);
    await fs.mkdir(path.dirname(ompPaths.legacyExtensionPath), { recursive: true });
    await fs.writeFile(ompPaths.legacyExtensionPath, '// legacy ext');

    await installOmpIntegration({ home: tmpHome, ompBinaryPath: null });

    expect(
      await fs
        .access(ompPaths.legacyExtensionPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});

describe('readOmpIntegrationState', () => {
  it('reports installed=false on a fresh tree', async () => {
    const state = await readOmpIntegrationState({ home: tmpHome, ompBinaryPath: null });
    expect(state.mcpServerInstalled).toBe(false);
    expect(state.wrapperInstalled).toBe(false);
    expect(state.legacyBlockPresent).toBe(false);
    expect(state.wrapperPath).toBe(path.join(tmpHome, '.local', 'bin', 'omp-su'));
  });

  it('reports mcpServerInstalled=true after install (wrapper retired → still false)', async () => {
    await seedPhase1(tmpHome);
    await installOmpIntegration({ home: tmpHome, ompBinaryPath: null });
    const state = await readOmpIntegrationState({ home: tmpHome, ompBinaryPath: null });
    expect(state.mcpServerInstalled).toBe(true);
    expect(state.wrapperInstalled).toBe(false); // P-050: install no longer writes the wrapper
  });

  it('pathWarning fires when wrapperDir not on PATH', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const state = await readOmpIntegrationState({ home: tmpHome, ompBinaryPath: null });
      expect(state.pathWarning).toContain('not on PATH');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('pathWarning null when wrapperDir IS on PATH', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.join(tmpHome, '.local', 'bin')}:/usr/bin`;
    try {
      const state = await readOmpIntegrationState({ home: tmpHome, ompBinaryPath: null });
      expect(state.pathWarning).toBeNull();
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('uninstallOmpIntegration', () => {
  it('removes papercusp-su entry but preserves other servers', async () => {
    await seedPhase1(tmpHome);
    const ompPaths = resolveOmpPaths(tmpHome);
    await fs.mkdir(ompPaths.ompAgentDir, { recursive: true });
    await fs.writeFile(
      ompPaths.mcpJsonPath,
      JSON.stringify({
        mcpServers: {
          'other-server': { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer y' } },
        },
      }),
    );
    await installOmpIntegration({ home: tmpHome, ompBinaryPath: null });

    const result = await uninstallOmpIntegration({ home: tmpHome, ompBinaryPath: null });
    expect(result.changed).toBe(true);
    expect(result.mcpServerInstalled).toBe(false);
    expect(result.wrapperInstalled).toBe(false);

    const cfg = JSON.parse(await fs.readFile(ompPaths.mcpJsonPath, 'utf8'));
    expect(cfg.mcpServers['other-server']).toBeDefined();
    expect(cfg.mcpServers['papercusp-su']).toBeUndefined();
  });

  it('uninstall on an empty tree is a no-op', async () => {
    const result = await uninstallOmpIntegration({ home: tmpHome, ompBinaryPath: null });
    expect(result.changed).toBe(false);
    expect(result.actions).toEqual([]);
  });
});
