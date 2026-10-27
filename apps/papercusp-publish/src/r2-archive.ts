/**
 * Private object-store archive — the eject-path's load-bearing component (§15.7).
 *
 * Layout under prefix `publish/`:
 *   publish/<tenantId>/<deploymentId>/manifest.json
 *   publish/<tenantId>/<deploymentId>/files/<sha256>.bin
 */

import type { Env } from './env.ts';

function archivePrefix(env: Env, tenantId: string, deploymentId: string): string {
  return `${env.ARCHIVE_PREFIX}${tenantId}/${deploymentId}/`;
}

export function archivePath(env: Env, tenantId: string, deploymentId: string): string {
  return archivePrefix(env, tenantId, deploymentId);
}

export async function writeManifest(
  env: Env,
  tenantId: string,
  deploymentId: string,
  manifestJson: string,
): Promise<void> {
  await env.ARCHIVE.put(
    archivePrefix(env, tenantId, deploymentId) + 'manifest.json',
    manifestJson,
    { httpMetadata: { contentType: 'application/json' } },
  );
}

export async function writeFile(
  env: Env,
  tenantId: string,
  deploymentId: string,
  sha256: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
): Promise<void> {
  await env.ARCHIVE.put(
    archivePrefix(env, tenantId, deploymentId) + 'files/' + sha256 + '.bin',
    body,
  );
}

export async function deletePrefix(
  env: Env,
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const prefix = archivePrefix(env, tenantId, deploymentId);
  let cursor: string | undefined;
  do {
    const list = await env.ARCHIVE.list({ prefix, cursor });
    for (const obj of list.objects) await env.ARCHIVE.delete(obj.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
