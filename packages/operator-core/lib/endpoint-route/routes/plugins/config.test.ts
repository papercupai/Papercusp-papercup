/**
 * WI-6554700010008325 — GET /api/plugins/config(s) are `auth: 'public'` and
 * used to return plugin-config files verbatim, including OAuth tokens written
 * by fsTokenStorage and the in-app Slack bot/app tokens. These tests pin that
 * no stored secret leaves through either GET, and that the settings forms'
 * GET → PUT round trip keeps the stored secret instead of persisting the mask.
 *
 * Fixture values are deliberately NOT provider-shaped: masking is directed by
 * the key (and the plugin's configSchema), never by recognising a value.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../plugin-configs-pg', () => ({ mirrorPluginConfig: vi.fn(async () => {}) }));
vi.mock('../../../plugin-enables-pg', () => ({ mirrorHarness: vi.fn(async () => {}) }));

import { _resetPapercuspRootForTests } from '../../../papercusp-root';
import { PLUGIN_CONFIG_SECRET_MASK } from '../../../plugin-config-secrets';
import configRoutes from './config';
import configsRoute from './configs';

const HARNESS = 'secret-fixture';
const BOT = 'fixture-bot-value-0001';
const APP = 'fixture-app-value-0002';
const ACCESS = 'fixture-access-value-0003';
const REFRESH = 'fixture-refresh-value-0004';
const SIGNING = 'fixture-schema-marked-value-0005';

let home: string;
let previousHome: string | undefined;

type RouteLike = { method: string; handler: (req: Request) => Promise<Response> };

function configsDir(): string {
  return join(home, 'harnesses', HARNESS, 'plugin-configs');
}

function writeConfig(plugin: string, config: Record<string, unknown>): void {
  mkdirSync(configsDir(), { recursive: true });
  writeFileSync(join(configsDir(), `${plugin}.json`), JSON.stringify(config));
}

function readConfig(plugin: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configsDir(), `${plugin}.json`), 'utf8'));
}

function route(method: 'GET' | 'PUT'): RouteLike {
  const found = (configRoutes as unknown as RouteLike[]).find((r) => r.method === method);
  if (!found) throw new Error(`no ${method} /plugins/config route`);
  return found;
}

async function getConfig(plugin: string): Promise<Response> {
  return route('GET').handler(new Request(
    `http://127.0.0.1/api/plugins/config?harness=${HARNESS}&plugin=${plugin}`,
  ));
}

async function putConfig(plugin: string, config: Record<string, unknown>): Promise<Response> {
  return route('PUT').handler(new Request('http://127.0.0.1/api/plugins/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness: HARNESS, plugin, config }),
  }));
}

beforeEach(() => {
  previousHome = process.env.PAPERCUSP_HOME;
  home = mkdtempSync(join(tmpdir(), 'plugin-config-secrets-'));
  process.env.PAPERCUSP_HOME = home;
  _resetPapercuspRootForTests();

  // A harness plugin whose configSchema marks a non-obviously-named field secret.
  const pluginDir = join(home, 'harnesses', HARNESS, 'plugins', 'schema-plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'papercusp.json'), JSON.stringify({
    name: 'schema-plugin',
    version: '1.0.0',
    configSchema: {
      type: 'object',
      properties: {
        signing: { type: 'string', format: 'password' },
        channel: { type: 'string' },
      },
    },
  }));

  // The key shape the retired in-app Slack socket path stored under plugin config.
  writeConfig('slack-socket', {
    default_bot_token: BOT,
    default_app_token: APP,
    default_team: 'T123',
  });
  // Same key shape as oauth/token.ts (`<field>`, `<field>_refresh`, ...).
  writeConfig('github-plugin', {
    github_token: ACCESS,
    github_token_refresh: REFRESH,
    github_token_expires_at: 1791682301616,
    github_token_expired: false,
    max_tokens: 4096,
    repo: 'org/repo',
    credentialRef: 'provider:github',
  });
  writeConfig('schema-plugin', { signing: SIGNING, channel: 'C42' });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousHome;
  _resetPapercuspRootForTests();
  rmSync(home, { recursive: true, force: true });
});

const SECRETS = [BOT, APP, ACCESS, REFRESH, SIGNING];

describe('GET /api/plugins/config', () => {
  it('returns no stored secret for any plugin', async () => {
    for (const plugin of ['slack-socket', 'github-plugin', 'schema-plugin']) {
      const text = await (await getConfig(plugin)).text();
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
  });

  it('masks Slack, OAuth and schema-marked secrets and keeps ordinary fields', async () => {
    expect((await (await getConfig('slack-socket')).json()).config).toEqual({
      default_bot_token: PLUGIN_CONFIG_SECRET_MASK,
      default_app_token: PLUGIN_CONFIG_SECRET_MASK,
      default_team: 'T123',
    });
    expect((await (await getConfig('github-plugin')).json()).config).toEqual({
      github_token: PLUGIN_CONFIG_SECRET_MASK,
      github_token_refresh: PLUGIN_CONFIG_SECRET_MASK,
      github_token_expires_at: 1791682301616,
      github_token_expired: false,
      max_tokens: 4096,
      repo: 'org/repo',
      credentialRef: 'provider:github',
    });
    expect((await (await getConfig('schema-plugin')).json()).config).toEqual({
      signing: PLUGIN_CONFIG_SECRET_MASK,
      channel: 'C42',
    });
  });
});

describe('GET /api/plugins/configs', () => {
  it('masks secrets in the batched read', async () => {
    const res = await (configsRoute as unknown as RouteLike).handler(new Request(
      `http://127.0.0.1/api/plugins/configs?harness=${HARNESS}&plugins=slack-socket,github-plugin,schema-plugin`,
    ));
    const text = await res.text();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    const body = JSON.parse(text);
    expect(body.configs['slack-socket'].default_bot_token).toBe(PLUGIN_CONFIG_SECRET_MASK);
    expect(body.configs['github-plugin'].repo).toBe('org/repo');
    expect(body.configs['schema-plugin']).toEqual({ signing: PLUGIN_CONFIG_SECRET_MASK, channel: 'C42' });
  });
});

describe('PUT /api/plugins/config after a masked GET', () => {
  it('keeps the stored secret when the form sends the mask back', async () => {
    const got = await (await getConfig('github-plugin')).json();
    expect((await (await putConfig('github-plugin', { ...got.config, repo: 'org/other' })).json()).ok).toBe(true);

    const stored = readConfig('github-plugin');
    expect(stored.github_token).toBe(ACCESS);
    expect(stored.github_token_refresh).toBe(REFRESH);
    expect(stored.repo).toBe('org/other');
    expect(JSON.stringify(stored)).not.toContain(PLUGIN_CONFIG_SECRET_MASK);
  });

  it('keeps a schema-marked secret on a save of another field', async () => {
    const got = await (await getConfig('schema-plugin')).json();
    await putConfig('schema-plugin', { ...got.config, channel: 'C99' });
    expect(readConfig('schema-plugin')).toEqual({ signing: SIGNING, channel: 'C99' });
  });

  it('creates a new config file readable only by its owner', async () => {
    await putConfig('fresh-plugin', { api_key: 'fixture-typed-value' });
    const mode = statSync(join(configsDir(), 'fresh-plugin.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('stores a newly typed secret and drops a mask with nothing stored behind it', async () => {
    const res = await putConfig('slack-socket', {
      default_bot_token: 'fixture-new-typed-value',
      default_app_token: PLUGIN_CONFIG_SECRET_MASK,
      other_bot_token: PLUGIN_CONFIG_SECRET_MASK,
      default_team: 'T123',
    });
    expect((await res.json()).ok).toBe(true);
    expect(readConfig('slack-socket')).toEqual({
      default_bot_token: 'fixture-new-typed-value',
      default_app_token: APP,
      default_team: 'T123',
    });
  });
});
