/**
 * Secret masking for plugin-config JSON crossing the REST boundary.
 *
 * Plugin-config files (`~/.papercusp/harnesses/<h>/plugin-configs/<plugin>.json`)
 * are where `fsTokenStorage` keeps OAuth access/refresh tokens and where the
 * in-app Slack path keeps bot/app tokens. `GET /api/plugins/config(s)` are
 * `auth: 'public'` and feed the settings forms, so every credential-bearing
 * value is replaced by {@link PLUGIN_CONFIG_SECRET_MASK} before it leaves the
 * host (WI-6554700010008325).
 *
 * The settings forms round-trip GET → edit → PUT, so a masked value comes back
 * on save. {@link restoreMaskedPluginConfigSecrets} swaps each mask back to
 * the stored value at the same path, so saving an unrelated field never
 * overwrites a stored token with the mask.
 *
 * A value is a secret when it is a non-empty string AND either its key names a
 * credential ({@link isSensitiveValueKey}, the shared redaction test), its key
 * is an OAuth refresh slot (`<field>_refresh`), or the plugin's configSchema
 * marks the property `format: 'password'`, `writeOnly: true` or
 * `x-secret: true`. Non-string values (`max_tokens: 4096`,
 * `<field>_expires_at`, `<field>_expired`) are configuration, not secrets.
 */
import { isSensitiveValueKey } from './sensitive-text';

/** Placeholder returned in place of a stored secret. A PUT that sends it back
 *  keeps the stored value. */
export const PLUGIN_CONFIG_SECRET_MASK = '[stored secret]';

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaProperty(schema: JsonSchemaNode | null | undefined, key: string): JsonSchemaNode | null {
  if (!schema || !isPlainObject(schema.properties)) return null;
  const prop = (schema.properties as Record<string, unknown>)[key];
  return isPlainObject(prop) ? prop : null;
}

function schemaMarksSecret(prop: JsonSchemaNode | null): boolean {
  if (!prop) return false;
  return prop.format === 'password' || prop.writeOnly === true || prop['x-secret'] === true;
}

function keyNamesSecret(key: string): boolean {
  return isSensitiveValueKey(key) || /_refresh$/i.test(key);
}

function maskValue(value: unknown, key: string | null, prop: JsonSchemaNode | null): unknown {
  if (typeof value === 'string') {
    if (value.length > 0 && ((key !== null && keyNamesSecret(key)) || schemaMarksSecret(prop))) {
      return PLUGIN_CONFIG_SECRET_MASK;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = prop && isPlainObject(prop.items) ? (prop.items as JsonSchemaNode) : null;
    // Array elements inherit the key's secrecy: a `tokens: ["…"]` list is secret.
    return value.map((entry) => maskValue(entry, key, items ?? prop));
  }
  if (isPlainObject(value)) return redactPluginConfigSecrets(value, prop);
  return value;
}

/** Return a copy of `config` with every secret value replaced by the mask. */
export function redactPluginConfigSecrets(
  config: Record<string, unknown>,
  schema?: JsonSchemaNode | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = maskValue(value, key, schemaProperty(schema, key));
  }
  return out;
}

function restoreValue(incoming: unknown, stored: unknown): { keep: boolean; value: unknown } {
  if (incoming === PLUGIN_CONFIG_SECRET_MASK) {
    // A mask with nothing stored behind it means "no value": drop the key
    // rather than persisting the placeholder as if it were a credential.
    return stored === undefined || stored === PLUGIN_CONFIG_SECRET_MASK
      ? { keep: false, value: undefined }
      : { keep: true, value: stored };
  }
  if (Array.isArray(incoming)) {
    const storedItems = Array.isArray(stored) ? stored : [];
    const items: unknown[] = [];
    incoming.forEach((entry, index) => {
      const restored = restoreValue(entry, storedItems[index]);
      if (restored.keep) items.push(restored.value);
    });
    return { keep: true, value: items };
  }
  if (isPlainObject(incoming)) {
    return {
      keep: true,
      value: restoreMaskedPluginConfigSecrets(incoming, isPlainObject(stored) ? stored : {}),
    };
  }
  return { keep: true, value: incoming };
}

/**
 * Replace each mask in an incoming config with the value stored at the same
 * path. A mask with no stored value is dropped. Never mutates its inputs.
 */
export function restoreMaskedPluginConfigSecrets(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const restored = restoreValue(value, stored[key]);
    if (restored.keep) out[key] = restored.value;
  }
  return out;
}
