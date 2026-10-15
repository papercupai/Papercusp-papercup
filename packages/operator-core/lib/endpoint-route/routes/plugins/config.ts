/**
 * GET  /api/plugins/config?harness=<h>&plugin=<slug> — read per-harness config.
 * PUT  /api/plugins/config — write per-harness config (prunes schema defaults, bumps configHash).
 * Ported from app/api/plugins/config/route.ts. GET is `auth: 'public'`, PUT `auth: 'loopback'`.
 *
 * The config file also holds OAuth and Slack tokens, so GET masks every secret
 * value and PUT swaps a returned mask back to the stored value
 * (plugin-config-secrets.ts, WI-6554700010008325).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { mirrorHarness } from '../../../plugin-enables-pg';
import { mirrorPluginConfig } from '../../../plugin-configs-pg';
import { listPluginsIn } from '../../../plugin-catalog';
import { papercuspRoot } from '../../../papercusp-root';
import {
  redactPluginConfigSecrets,
  restoreMaskedPluginConfigSecrets,
} from '../../../plugin-config-secrets';
import { defineTool } from '@papercusp/agent-mcp';

function HARNESSES_DIR() { return join(papercuspRoot(), 'harnesses'); }
function GLOBAL_PLUGINS_DIR() { return join(papercuspRoot(), 'global-plugins'); }

function pruneSchemaDefaults(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return config;
  const properties = ((schema as { properties?: unknown }).properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const prop = properties[k];
    if (!prop) { out[k] = v; continue; }
    if (prop.type === 'object' && prop.properties && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const pruned = pruneSchemaDefaults(v as Record<string, unknown>, prop);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
      continue;
    }
    if ('default' in prop) {
      const def = prop.default;
      if (Array.isArray(v) && Array.isArray(def)) {
        if (JSON.stringify(v) === JSON.stringify(def)) continue;
      } else if (v === def) {
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

async function findPluginManifest(harness: string, inputSlug: string): Promise<{
  schema: Record<string, unknown> | null;
  canonicalName: string;
} | null> {
  const sources = [
    join(HARNESSES_DIR(), harness, 'plugins'),
    GLOBAL_PLUGINS_DIR(),
  ];
  for (const dir of sources) {
    const items = await listPluginsIn(dir, 'global');
    for (const m of items) {
      const dirBase = m.path.split('/').pop();
      if (m.name === inputSlug || dirBase === inputSlug) {
        return {
          schema: (m as { configSchema?: Record<string, unknown> }).configSchema ?? null,
          canonicalName: m.name,
        };
      }
    }
  }
  return null;
}

const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_DIR_SLUG = /^@?[a-z0-9][a-z0-9@._/-]{0,127}$/i;

function configHash(config: Record<string, unknown>): string {
  return 'sha256-' + createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 32);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  // 0600 like fsTokenStorage: a plugin config can hold a typed or OAuth secret.
  // The mode applies when the file is created; an existing file keeps its own.
  await fs.writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

const get = defineTool({
  method: 'GET',
  path: '/plugins/config',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    if (!HARNESS_SLUG.test(harness)) return Response.json({ error: 'invalid harness' }, { status: 400 });
    if (!PLUGIN_DIR_SLUG.test(plugin)) return Response.json({ error: 'invalid plugin slug' }, { status: 400 });
    const m = await findPluginManifest(harness, plugin);
    const canonicalSlug = m?.canonicalName ?? plugin;
    const canonicalPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${canonicalSlug}.json`);
    const fallbackPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
    const config =
      (await readJson<Record<string, unknown>>(canonicalPath))
      ?? (await readJson<Record<string, unknown>>(fallbackPath))
      ?? {};
    return Response.json({ config: redactPluginConfigSecrets(config, m?.schema ?? null) });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/plugins/config',
  auth: 'loopback',
  async handler(req) {
    let body: { harness?: string; plugin?: string; config?: unknown };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

    const harness = String(body.harness ?? '').trim();
    const plugin = String(body.plugin ?? '').trim();
    if (!HARNESS_SLUG.test(harness)) return Response.json({ ok: false, error: 'invalid harness' }, { status: 400 });
    if (!PLUGIN_DIR_SLUG.test(plugin)) return Response.json({ ok: false, error: 'invalid plugin slug' }, { status: 400 });
    const cfg = body.config;
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      return Response.json({ ok: false, error: 'config must be a JSON object' }, { status: 400 });
    }

    const m = await findPluginManifest(harness, plugin);
    const canonicalSlug = m?.canonicalName ?? plugin;
    const configPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${canonicalSlug}.json`);
    // GET masked every stored secret, so a form save sends the mask back:
    // restore the stored value at each masked path before persisting.
    const stored =
      (await readJson<Record<string, unknown>>(configPath))
      ?? (await readJson<Record<string, unknown>>(join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`)))
      ?? {};
    const restored = restoreMaskedPluginConfigSecrets(cfg as Record<string, unknown>, stored);
    const pruned = pruneSchemaDefaults(restored, m?.schema ?? null);

    await writeJson(configPath, pruned);
    if (canonicalSlug !== plugin) {
      const legacyPath = join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
      if (existsSync(legacyPath)) {
        try { await fs.unlink(legacyPath); } catch (e) {
          console.warn('[plugins/config] failed to unlink legacy path', legacyPath, e);
        }
      }
    }
    try { await mirrorPluginConfig(harness, canonicalSlug, pruned); } catch (e) {
      console.warn('[plugins/config] PG config mirror failed for', harness, canonicalSlug, e);
    }

    const enabledPath = join(HARNESSES_DIR(), harness, 'enabled-plugins.json');
    const enabled = (await readJson<{ enabled: Record<string, { version: string; enabledAt: string; configHash: string }> }>(enabledPath))
      ?? { enabled: {} };
    const enabledKey = enabled.enabled[canonicalSlug] ? canonicalSlug
      : enabled.enabled[plugin] ? plugin
      : null;
    if (enabledKey) {
      enabled.enabled[enabledKey].configHash = configHash(pruned);
      await writeJson(enabledPath, enabled);
      try { await mirrorHarness(harness); } catch (e) {
        console.warn('[plugins/config] PG mirror failed for', harness, e);
      }
    }

    return Response.json({
      ok: true,
      harness,
      plugin: canonicalSlug,
      configHash: configHash(pruned),
      path: configPath,
    });
  },
});

export default [get, put];
