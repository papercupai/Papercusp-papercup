import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  readClaudeIntegrationState,
  buildClaudeMcpEntry,
  resolveClaudeConfigPath,
} from './claude-integration';

let home: string;
const claudeBin = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 2_000 }).stdout?.trim();
const execFileAsync = promisify(execFile);

async function seedPhase1(token = 'TOK-abc', agentId = 'agent-xyz') {
  await mkdir(join(home, '.papercusp'), { recursive: true });
  await writeFile(join(home, '.papercusp', 'superuser-token'), token + '\n');
  await writeFile(join(home, '.papercusp', 'su-agent-id'), agentId + '\n');
}

async function writeClaudeJson(obj: unknown) {
  await writeFile(resolveClaudeConfigPath(home), JSON.stringify(obj, null, 2));
}

async function readClaudeJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolveClaudeConfigPath(home), 'utf8'));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'claude-integ-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('buildClaudeMcpEntry', () => {
  it('env-interpolates operator url + sid + workspace + profile (not baked)', () => {
    const e = buildClaudeMcpEntry('http://localhost:3070', 'TOK', 'agent-1', '');
    expect(e.type).toBe('http');
    expect(e.url).toBe(
      '${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}/api/mcp?superuser=1' +
        '&client=${PAPERCUSP_SID:-agent-1}&native_session=${CLAUDE_CODE_SESSION_ID:-}' +
        '&workspace=${PAPERCUSP_WORKSPACE:-}' +
        // recall drill 2 (2026-07-12): ?harness= feeds the initialize-time memory
        // prelude's recall query — absent, every psu session was a bare session
        // with NO session-start recall. Env-expanded like the rest.
        '&harness=${PAPERCUSP_HARNESS_SLUG:-}&profile=${PAPERCUSP_PROFILE:-}' +
        // su-context-size-variants: the ?tools= trim lever — empty default (full catalog) until
        // psu exports PAPERCUSP_TOOLS = CORE spine for a --context-size=trimmed claude.
        '&tools=${PAPERCUSP_TOOLS:-}' +
        // deterministic-tool-definition-delivery-2026-09-21: the SECOND axis of the same
        // decision. ?tools= says WHICH tools are advertised; tools_compact says HOW MUCH of
        // each one ships (prose stripped, shape kept). psu exports PAPERCUSP_TOOLS_COMPACT
        // from the GENERATED delivery artifact, so neither list is hand-maintained.
        // Unset/empty ⇒ nothing is compacted. Env-expanded like the rest — asserted here
        // because the builder emits it unconditionally, between ?tools= and ?ctx_tier=.
        '&tools_compact=${PAPERCUSP_TOOLS_COMPACT:-}' +
        // context-trimming-tiers D-004: the payload-tier lever, same env-expanded pattern.
        '&ctx_tier=${PAPERCUSP_CONTEXT_TIER:-}',
    );
    expect(e.headers.Authorization).toBe('Bearer TOK');
  });
  it('power profile bakes profile=power as the fallback', () => {
    expect(buildClaudeMcpEntry('http://x', 'T', 'a', 'power').url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });

  it('keeps the standalone Claude installer bound to the live native session too', () => {
    const installer = readFileSync(
      new URL('../../../../apps/operator/scripts/install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    expect(installer).toContain("&native_session=${CLAUDE_CODE_SESSION_ID:-}");
    expect(installer).toContain("'x-papercusp-native-session': '${PAPERCUSP_NATIVE_SESSION_ID:-}'");
  });

  it.skipIf(!claudeBin)('sends the managed native header through actual Claude HTTP config expansion', async () => {
    const nativeId = '11111111-1111-4111-8111-111111111111';
    const observed: Array<{ header: string | string[] | undefined; query: string | null }> = [];
    const server = createServer((req, res) => {
      observed.push({
        header: req.headers['x-papercusp-native-session'],
        query: new URL(req.url!, 'http://localhost').searchParams.get('native_session'),
      });
      // Configuration health-check only; never invoke an agent or a model.
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const entry = buildClaudeMcpEntry(`http://127.0.0.1:${address.port}`, 'diagnostic', 'probe', '');
      await writeClaudeJson({ mcpServers: { probe: entry } });
      const env = {
        PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
        PAPERCUSP_NATIVE_SESSION_ID: nativeId,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
      await execFileAsync(claudeBin!, ['mcp', 'get', 'probe'], { cwd: home, env, timeout: 15_000 });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((r) => r.header === nativeId && r.query === '')).toBe(true);
      // An absent launch identity must not emit a placeholder or authenticate as
      // a predecessor. The legacy native query still works for a bare client.
      observed.length = 0;
      const { PAPERCUSP_NATIVE_SESSION_ID: _managedId, ...bareEnv } = env;
      await execFileAsync(claudeBin!, ['mcp', 'get', 'probe'], {
        cwd: home, env: { ...bareEnv, CLAUDE_CODE_SESSION_ID: nativeId }, timeout: 15_000,
      });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((r) => !r.header && r.query === nativeId)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 40_000);
});

describe('installClaudeIntegration', () => {
  it('registers papercusp-su into an existing ~/.claude.json, preserving every other key', async () => {
    await seedPhase1('TOK-1', 'agent-1');
    await writeClaudeJson({ numStartups: 7, theme: 'dark', mcpServers: { other: { type: 'http', url: 'u', headers: {} } } });

    const res = await installClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    expect(res.mcpServerInstalled).toBe(true);

    const cfg = await readClaudeJson();
    expect(cfg.numStartups).toBe(7); // preserved
    expect(cfg.theme).toBe('dark'); // preserved
    const servers = cfg.mcpServers as Record<string, { url: string; headers: { Authorization: string } }>;
    expect(servers.other).toBeDefined(); // other server preserved
    expect(servers['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-');
    expect(servers['papercusp-su'].url).toContain('client=${PAPERCUSP_SID:-agent-1}');
    expect(servers['papercusp-su'].headers.Authorization).toBe('Bearer TOK-1');
  });

  it('is idempotent — a second call writes nothing', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    const first = await installClaudeIntegration({ home });
    expect(first.changed).toBe(true);
    const second = await installClaudeIntegration({ home });
    expect(second.changed).toBe(false);
    expect(second.mcpServerInstalled).toBe(true);
  });

  it('WI-1457: bakes the resilient-proxy base as the fallback when PAPERCUSP_MCP_PROXY_BASE is set', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    try {
      const res = await installClaudeIntegration({ home });
      expect(res.changed).toBe(true);
      const servers = (await readClaudeJson()).mcpServers as Record<string, { url: string }>;
      // The operator-side reconciler must never re-mint a direct-:3070 fallback
      // while the environment routes agents through the proxy (the regression
      // that silently undid the P-006 cutover).
      expect(servers['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:9071}');
    } finally {
      delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    }
  });

  it('P-007: dev-box default (no PAPERCUSP_MCP_PROXY_BASE, no PAPERCUSP_DESKTOP) bakes the resilient :9071 proxy fallback, never direct :3070', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    const prevDesktop = process.env.PAPERCUSP_DESKTOP;
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    delete process.env.PAPERCUSP_DESKTOP;
    try {
      const res = await installClaudeIntegration({ home });
      expect(res.changed).toBe(true);
      const servers = (await readClaudeJson()).mcpServers as Record<string, { url: string }>;
      // The proxy fronts :3070's deploy-restarts (WI-1457); a bare `claude` must
      // ride it by DEFAULT — even a dev-box reconcile with neither env set — so a
      // deploy no longer drops the session's tools. A direct-:3070 fallback here is
      // the exact regression that silently reverted the P-006 cutover.
      expect(servers['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:9071}');
      expect(servers['papercusp-su'].url).not.toContain(':3070');
    } finally {
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
      if (prevDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
      else process.env.PAPERCUSP_DESKTOP = prevDesktop;
    }
  });

  it('NEVER creates ~/.claude.json when claude was never launched (dev box, seedIfAbsent off)', async () => {
    await seedPhase1();
    const res = await installClaudeIntegration({ home });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('claude_not_initialized');
    await expect(stat(resolveClaudeConfigPath(home))).rejects.toBeTruthy(); // still absent
  });

  it('WI-3091 desktop: seedIfAbsent CREATES a minimal ~/.claude.json with papercusp-su when absent', async () => {
    await seedPhase1();
    const res = await installClaudeIntegration({ home, seedIfAbsent: true });
    expect(res.changed).toBe(true);
    expect(res.mcpServerInstalled).toBe(true);
    expect(res.reason).toBeUndefined();
    const cfg = await readClaudeJson();
    // onboarding pre-completed so claude's own theme/trust flow can't BLOCK the psu launch
    expect(cfg.hasCompletedOnboarding).toBe(true);
    const srv = (cfg.mcpServers as Record<string, { type: string; url: string; headers: Record<string, string> }>)['papercusp-su'];
    expect(srv?.type).toBe('http');
    // env-interpolated url self-heals across the dynamic desktop operator port
    expect(srv?.url).toContain('${PAPERCUSP_OPERATOR_URL:-');
    expect(srv?.url).toContain('/api/mcp?superuser=1');
    expect(srv?.headers?.Authorization).toBe('Bearer TOK-abc');
  });

  it('WI-3247 desktop: seedIfAbsent bakes the stable MCP proxy fallback, not a dynamic or dead operator port', async () => {
    await seedPhase1();
    const prevDesktop = process.env.PAPERCUSP_DESKTOP;
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    process.env.PAPERCUSP_DESKTOP = '1';
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    try {
      const res = await installClaudeIntegration({ home, seedIfAbsent: true });
      expect(res.changed).toBe(true);
      const srv = ((await readClaudeJson()).mcpServers as Record<string, { url: string }>)['papercusp-su'];
      expect(srv.url).toContain('${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:9071}');
    } finally {
      if (prevDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
      else process.env.PAPERCUSP_DESKTOP = prevDesktop;
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
    }
  });

  it('WI-3091 desktop: seedIfAbsent is idempotent when the file already exists (merges, does not overwrite user keys)', async () => {
    await seedPhase1();
    await writeClaudeJson({ hasCompletedOnboarding: true, theme: 'dark', mcpServers: { other: { type: 'http', url: 'http://x' } } });
    const res = await installClaudeIntegration({ home, seedIfAbsent: true });
    expect(res.changed).toBe(true); // added papercusp-su
    const cfg = await readClaudeJson();
    expect(cfg.theme).toBe('dark'); // preserved
    const servers = cfg.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeTruthy(); // preserved
    expect(servers['papercusp-su']).toBeTruthy(); // added
  });

  it('returns phase1_not_run when token/agent-id are missing', async () => {
    await writeClaudeJson({ mcpServers: {} }); // claude.json exists, but no ~/.papercusp secrets
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('phase1_not_run');
    expect(res.changed).toBe(false);
  });

  it('skips (does not destroy) an invalid ~/.claude.json', async () => {
    await seedPhase1();
    await writeFile(resolveClaudeConfigPath(home), '{ this is not json ');
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('claude_json_invalid');
    expect(res.changed).toBe(false);
    // file left untouched (not renamed away)
    expect(await readFile(resolveClaudeConfigPath(home), 'utf8')).toBe('{ this is not json ');
  });

  it('writes 0600 (not group/world readable)', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    await installClaudeIntegration({ home });
    const st = await stat(resolveClaudeConfigPath(home));
    expect(st.mode & 0o077).toBe(0);
  });

  it('honors the profile option (power)', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    await installClaudeIntegration({ home, profile: 'power' });
    const servers = (await readClaudeJson()).mcpServers as Record<string, { url: string }>;
    expect(servers['papercusp-su'].url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });
});

describe('uninstallClaudeIntegration', () => {
  it('removes papercusp-su, preserves other servers', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} }, keep: { type: 'http', url: 'y', headers: {} } } });
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    const servers = (await readClaudeJson()).mcpServers as Record<string, unknown>;
    expect(servers['papercusp-su']).toBeUndefined();
    expect(servers.keep).toBeDefined();
  });

  it('no-ops when ~/.claude.json is absent', async () => {
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(false);
  });
});

describe('readClaudeIntegrationState', () => {
  it('reports installed when papercusp-su present', async () => {
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} } } });
    const st = await readClaudeIntegrationState({ home });
    expect(st.claudeConfigExists).toBe(true);
    expect(st.mcpServerInstalled).toBe(true);
  });
});
