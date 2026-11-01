import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { gcsObjectStore, type ObjectStore } from '@papercusp/artifact-registry';
import { archivePath, writeFile as archiveFile, writeManifest } from '../src/r2-archive.ts';
import type { Env } from '../src/env.ts';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exercise the existing publish archive port; the Google JSON API supplies the
 * independent generation-pinned restore oracle and generation-fenced cleanup. */
export async function verifyPublishArchive(options: {
  store: ObjectStore; bucket: string; accessToken: string; operationId: string; body: string;
  recordOperation: (operation: { operationId: string; prefix: string; sha256: string }) => Promise<void>;
  fetchImpl?: typeof fetch;
}) {
  const { store, bucket, accessToken, operationId, body, recordOperation, fetchImpl = fetch } = options;
  if (!uuid.test(operationId) || !body.includes(operationId) || Buffer.byteLength(body) > 4096 ||
      !accessToken || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('invalid archive verification plan');
  const env = { ARCHIVE: store, ARCHIVE_PREFIX: 'publish/' } as Env;
  const tenant = 'verification-' + operationId;
  const deployment = 'deployment-' + operationId;
  const prefix = archivePath(env, tenant, deployment);
  const sha256 = digest(body);
  const fileKey = prefix + 'files/' + sha256 + '.bin';
  const manifestKey = prefix + 'manifest.json';
  const manifest = JSON.stringify({ files: [{ path: 'verification.txt', sha256, sizeBytes: Buffer.byteLength(body) }] });
  const api = 'https://storage.googleapis.com/storage/v1/b/' + bucket + '/o';
  const result = { operationId, prefix, sha256, startedAt: new Date().toISOString(), finishedAt: '',
    result: 'incomplete' as 'incomplete' | 'pass' | 'fail', checks: [] as { name: string; ok: boolean; evidence: string }[],
    generations: {} as Record<string, string>, error: undefined as string | undefined,
    cleanup: { complete: false, deleted: [] as { key: string; generation: string; status: number }[],
      remaining: [] as string[], error: undefined as string | undefined } };
  const request = (suffix: string, init: RequestInit = {}, anonymous = false) => fetchImpl(api + suffix,
    { ...init, headers: { ...(anonymous ? {} : { authorization: 'Bearer ' + accessToken }), ...init.headers },
      signal: AbortSignal.timeout(20_000) });
  const check = (name: string, ok: boolean, evidence: string) => {
    result.checks.push({ name, ok, evidence });
    if (!ok) throw new Error(name);
  };
  const list = async () => {
    const r = await request('?prefix=' + encodeURIComponent(prefix) + '&maxResults=3');
    if (r.status !== 200) throw new Error('archive list failed: HTTP ' + r.status);
    const page = await r.json() as { items?: { name: string; generation: string }[]; nextPageToken?: string };
    if (page.nextPageToken) throw new Error('unexpected archive population');
    return page.items ?? [];
  };
  let ownsFixture = false;
  try {
    check('unique-archive-absent', (await list()).length === 0, prefix);
    await recordOperation({ operationId, prefix, sha256 });
    ownsFixture = true; // A lost write response still requires reconciliation and cleanup.
    const bytes = new TextEncoder().encode(body);
    await archiveFile(env, tenant, deployment, sha256,
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }));
    await writeManifest(env, tenant, deployment, manifest);
    for (const [key, expected] of [[fileKey, body], [manifestKey, manifest]] as const) {
      const suffix = '/' + encodeURIComponent(key!);
      const r = await request(suffix);
      check('google-metadata-' + (key === fileKey ? 'file' : 'manifest'), r.status === 200, 'HTTP ' + r.status);
      const metadata = await r.json() as { name: string; generation: string; size: string; contentType?: string };
      if (metadata.name !== key || !/^[1-9]\d*$/.test(metadata.generation)) throw new Error('invalid archive generation identity');
      result.generations[key!] = metadata.generation;
      const restored = await request(suffix + '?alt=media&generation=' + metadata.generation);
      const actual = new Uint8Array(await restored.arrayBuffer());
      check('google-pinned-bytes-' + (key === fileKey ? 'file' : 'manifest'), restored.status === 200 &&
        digest(actual) === digest(expected!) && actual.byteLength === Buffer.byteLength(expected!) &&
        Number(metadata.size) === actual.byteLength, 'generation=' + metadata.generation + '; sha256=' + digest(actual));
      if (key === manifestKey) check('manifest-content-type', metadata.contentType === 'application/json', String(metadata.contentType));
      const anonymous = await request(suffix + '?alt=media&generation=' + metadata.generation, {}, true);
      check('private-anonymous-denied-' + (key === fileKey ? 'file' : 'manifest'),
        anonymous.status === 401 || anonymous.status === 403, 'HTTP ' + anonymous.status);
    }
    const portRead = await store.get(fileKey);
    check('archive-port-restores-admitted-file', !!portRead && digest(new Uint8Array(await portRead.arrayBuffer())) === sha256,
      'expected sha256=' + sha256);
    const wrongTenant = archivePath(env, 'other-' + operationId, deployment) + 'files/' + sha256 + '.bin';
    check('other-tenant-has-no-file', await store.get(wrongTenant) === null, wrongTenant);
    result.result = 'pass';
  } catch (error) {
    result.result = 'fail';
    result.error = error instanceof Error ? error.message : 'archive verification failed';
  } finally {
    if (ownsFixture) {
      try {
        const objects = await list();
        if (objects.some(x => ![fileKey, manifestKey].includes(x.name) || !/^[1-9]\d*$/.test(x.generation))) {
          throw new Error('unexpected archive object; cleanup refused');
        }
        for (const object of objects) {
          const r = await request('/' + encodeURIComponent(object.name) + '?ifGenerationMatch=' + object.generation, { method: 'DELETE' });
          if (r.status !== 204 && r.status !== 404) throw new Error('generation-fenced archive cleanup failed: HTTP ' + r.status);
          result.cleanup.deleted.push({ key: object.name, generation: object.generation, status: r.status });
        }
        result.cleanup.remaining = (await list()).map(x => x.name);
        result.cleanup.complete = result.cleanup.remaining.length === 0;
        if (!result.cleanup.complete) throw new Error('archive cleanup left objects');
      } catch (error) {
        result.result = 'fail'; result.cleanup.error = error instanceof Error ? error.message : 'archive cleanup failed';
      }
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

async function main() {
  const [bucket, journalPath, receiptPath] = process.argv.slice(2);
  if (!bucket || !journalPath?.startsWith('docs/evidence/') || !receiptPath?.startsWith('docs/evidence/') ||
      [journalPath, receiptPath].some(p => p.split('/').includes('..'))) throw new Error('usage: verify-archive.ts BUCKET docs/evidence/JOURNAL.json docs/evidence/RECEIPT.json');
  const sourcePaths = ['apps/papercusp-publish/scripts/verify-archive.ts', 'apps/papercusp-publish/src/r2-archive.ts',
    'libs/generic/artifact-registry/src/gcs-object-store.ts', 'apps/papercusp-publish/scripts/verify-archive.test.ts'];
  const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p, digest(await readFile(p))])));
  const sourceHashesBefore = await hashes();
  const accessToken = execFileSync('gcloud', ['auth', 'print-access-token'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
  const operationId = randomUUID();
  const observation = await verifyPublishArchive({ bucket, accessToken, operationId,
    body: 'Admitted P004 archive verification ' + operationId + '\n',
    store: gcsObjectStore({ bucket, accessToken: async () => accessToken,
      fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) }),
    recordOperation: async operation => { await writeFile(journalPath, JSON.stringify({ ...operation, bucket,
      sourceHashesBefore, at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' }); } });
  const sourceHashesAfter = await hashes();
  const sourceStable = JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter);
  const assertions = observation.checks.map(c => ({ id: c.name, passed: c.ok, evidence: c.evidence }));
  assertions.push({ id: 'fenced-archive-cleanup', passed: observation.cleanup.complete,
    evidence: JSON.stringify(observation.cleanup) }, { id: 'source-stable', passed: sourceStable, evidence: JSON.stringify(sourceHashesAfter) });
  const exitCode = observation.result === 'pass' && observation.cleanup.complete && sourceStable ? 0 : 1;
  await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, kind: 'operational-test-evidence',
    name: 'Publish archive restored from real private Google storage', framework: 'node',
    command: ['node', '--import', 'tsx', 'apps/papercusp-publish/scripts/verify-archive.ts', bucket, journalPath, receiptPath],
    exitCode, startedAt: observation.startedAt, finishedAt: observation.finishedAt,
    summary: 'Existing publish archive port writes admitted bytes and manifest; independent Google JSON API restores exact generations and checksums; anonymous reads are denied; cleanup is generation-fenced.',
    assertions, observation, bucket, sourceHashesBefore, sourceHashesAfter,
    scope: 'Live Google storage and maintained archive port. Does not establish a deployed publish Worker, historical R2 census, or full migration acceptance.' }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ receiptPath, result: observation.result, cleanup: observation.cleanup.complete, sourceStable }));
  process.exitCode = exitCode;
}

if (isCliEntry(import.meta.url)) {
  main().catch(() => { console.error('archive verification failed; inspect the retained journal and receipt'); process.exitCode = 1; });
}
