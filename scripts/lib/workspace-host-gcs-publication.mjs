import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGcloud = async (args) => (await exec('gcloud', args, {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 1800_000,
})).stdout;

export function gcsPublicationTarget(bucket, digest) {
  // A bucket subdomain preserves the existing origin-only URL derivation and
  // bundleUrl + '.minisig' companion rule, without bearer query strings.
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('GCS bucket must be a DNS-safe bucket name without dots');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('GCS publication requires the exact bundle digest');
  return { bucket, digest, origin: `https://${bucket}.storage.googleapis.com`,
    prefix: `artifacts/workspace-host/sha256/${digest}/` };
}

export async function verifyGcsPublicBytes(url, expected, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok || !response.body) throw new Error(`GCS public verification failed: HTTP ${response.status}`);
  return verifyGcsStream(response.body, expected);
}

/** Bounded operational verification through the serving Worker's real storage port.
 * The caller must durably journal the exact operation before this function writes.
 * Cleanup is restricted to this unique fixture and generation-fenced; original
 * artifacts and trusted finalization markers are never written or removed.
 * @param {{ baseUrl: string, bucket: string, githubToken: string, accessToken: string,
 * operationId: string, body: string,
 * recordOperation: (operation: { operationId: string, sha256: string, sizeBytes: number }) => Promise<void>,
 * positiveControl: { path: string, sha256: string, sizeBytes: number }, fetchImpl?: typeof fetch }} options
 */
export async function verifyGcsWorkspaceHostUpload({ baseUrl, bucket, githubToken, accessToken,
  operationId, body, recordOperation, positiveControl, fetchImpl = fetch }) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.origin !== baseUrl || origin.username || origin.password ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
    !body.includes(operationId) || Buffer.byteLength(body) > 4096 || !githubToken || !accessToken ||
    typeof recordOperation !== 'function' || !positiveControl.path.startsWith('/artifacts/workspace-host/sha256/') ||
    !/^[a-f0-9]{64}$/.test(positiveControl.sha256) || !Number.isSafeInteger(positiveControl.sizeBytes) ||
    positiveControl.sizeBytes < 1 || positiveControl.sizeBytes > 65536) throw new Error('invalid GCS verification plan');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const target = gcsPublicationTarget(bucket, sha256);
  const prefix = target.prefix;
  const key = prefix + 'server.tgz';
  const api = 'https://storage.googleapis.com/storage/v1/b/' + bucket + '/o';
  const path = '/admin/artifacts/workspace-host/sha256/' + sha256 + '/server.tgz/multipart';
  const publicPath = '/artifacts/workspace-host/sha256/' + sha256 + '/server.tgz';
  const operation = { operationId, sha256, sizeBytes: Buffer.byteLength(body) };
  const result = { ...operation, startedAt: new Date().toISOString(), checks: [], result: 'incomplete',
    cleanup: { deleted: [], complete: false, remaining: [], providerRemaining: [] } };
  const check = (name, ok, evidence = {}) => {
    result.checks.push({ name, ok: Boolean(ok), ...evidence });
    if (!ok) throw new Error(name);
  };
  const request = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
  const gcs = (suffix = '', init = {}) => request(api + suffix,
    { ...init, headers: { authorization: 'Bearer ' + accessToken, ...init.headers } });
  const object = name => '/' + encodeURIComponent(name);
  const list = async ownPrefix => {
    const response = await gcs('?prefix=' + encodeURIComponent(ownPrefix) + '&maxResults=100');
    if (response.status !== 200) throw new Error('verification cleanup list failed: HTTP ' + response.status);
    const page = await response.json();
    if (page.nextPageToken) throw new Error('verification namespace exceeded its bounded population');
    return page.items ?? [];
  };
  let mutated = false;
  let providerUploadId;
  try {
    // An occupied namespace belongs to somebody else: never clean it up.
    const existing = await list(prefix);
    check('unique-destination-absent', existing.length === 0);
    const anonymous = await request(baseUrl + path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    check('anonymous-write-denied', anonymous.status === 401, { status: anonymous.status });
    await recordOperation(operation);
    const headers = { authorization: 'Bearer ' + githubToken, 'content-type': 'application/json',
      'x-artifact-sha256': sha256, 'x-artifact-size': String(operation.sizeBytes), 'x-operation-id': operationId };
    const plan = JSON.stringify({ parts: [{ partNumber: 1, sha256, sizeBytes: operation.sizeBytes }] });
    mutated = true; // A lost initiation reply still requires exact-namespace cleanup.
    const first = await request(baseUrl + path, { method: 'POST', headers, body: plan });
    const started = await first.json();
    check('production-multipart-created', first.status === 201 && started.uploadId === operationId, { status: first.status });
    const stateResponse = await gcs(object(prefix + '.multipart/' + operationId + '.json') + '?alt=media');
    check('operation-state-durable', stateResponse.status === 200, { status: stateResponse.status });
    const state = await stateResponse.json();
    if (!/^[0-9a-f-]{36}$/.test(state.r2UploadId) || state.bundleSha256 !== sha256) throw new Error('unexpected provider upload identity');
    providerUploadId = state.r2UploadId;
    const again = await request(baseUrl + path, { method: 'POST', headers, body: plan });
    const resumed = await again.json();
    check('reconnect-resumes-original-operation', again.status === 200 && resumed.resumed === true && resumed.uploadId === operationId,
      { status: again.status });
    const before = await request(baseUrl + publicPath);
    check('unfinalized-public-read-before-upload-denied', before.status === 404, { status: before.status });
    const part = await request(baseUrl + path + '/parts/1?uploadId=' + operationId, { method: 'PUT', body,
      headers: { authorization: 'Bearer ' + githubToken, 'content-type': 'application/octet-stream',
        'content-length': String(operation.sizeBytes), 'x-part-sha256': sha256, 'x-part-size': String(operation.sizeBytes) } });
    const receipt = await part.json();
    check('declared-part-uploaded', part.status === 200 && typeof receipt.etag === 'string', { status: part.status });
    const complete = () => request(baseUrl + path + '/complete?uploadId=' + operationId, { method: 'POST',
      headers: { authorization: 'Bearer ' + githubToken, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: receipt.etag }] }) });
    const completed = await complete();
    check('multipart-complete', completed.status === 201, { status: completed.status });
    const metadataResponse = await gcs(object(key));
    check('completed-object-metadata-readable', metadataResponse.status === 200, { status: metadataResponse.status });
    const metadata = await metadataResponse.json();
    if (!/^[1-9]\d*$/.test(metadata.generation)) throw new Error('invalid completed generation');
    result.objectIdentity = { generation: metadata.generation, metageneration: metadata.metageneration,
      crc32c: metadata.crc32c, sizeBytes: Number(metadata.size) };
    await verifyGcsPublicBytes(api + object(key) + '?alt=media&generation=' + metadata.generation, operation,
      (url, init) => request(url, { ...init, headers: { authorization: 'Bearer ' + accessToken } }));
    check('generation-pinned-exact-bytes', true, { generation: metadata.generation, sha256, sizeBytes: operation.sizeBytes });
    const replay = await complete();
    const replayed = await replay.json();
    const replayMetadata = await gcs(object(key));
    const current = await replayMetadata.json();
    check('completion-replay-retains-generation', replay.status === 200 && replayed.deduped === true &&
      replayMetadata.status === 200 && current.generation === metadata.generation, { status: replay.status, generation: current.generation });
    const denied = await request(baseUrl + publicPath);
    check('unfinalized-public-read-after-completion-denied', denied.status === 404, { status: denied.status });
    const raw = await request('https://storage.googleapis.com/' + bucket + '/' + key);
    check('raw-private-bucket-anonymous-denied', raw.status === 401 || raw.status === 403, { status: raw.status });
    await verifyGcsPublicBytes(baseUrl + positiveControl.path, positiveControl, request);
    check('existing-finalized-public-positive-control', true);
    result.result = 'pass';
  } catch (error) {
    result.result = 'fail';
    result.error = error.message;
    result.errorCauseCode = error.cause?.code ?? null;
  } finally {
    if (mutated) {
      try {
        const own = await list(prefix);
        if (!providerUploadId) {
          const saved = own.find(item => item.name === prefix + '.multipart/' + operationId + '.json');
          if (saved) {
            const response = await gcs(object(saved.name) + '?alt=media&generation=' + saved.generation);
            if (!response.ok) throw new Error('cannot recover own provider upload identity');
            const state = await response.json();
            if (!/^[0-9a-f-]{36}$/.test(state.r2UploadId) || state.bundleSha256 !== sha256) throw new Error('unexpected recovery identity');
            providerUploadId = state.r2UploadId;
          }
        }
        // A request can still be committing, or have created its provider session
        // before the HTTP state became readable. An empty destination listing
        // does not establish that the unknown provider session is absent.
        if (!providerUploadId) throw new Error('provider upload cleanup is unknown after initiation');
        const providerPrefix = providerUploadId ? '__artifact_uploads/' + providerUploadId + '/' : null;
        const provider = providerPrefix ? await list(providerPrefix) : [];
        const allowed = new Set([key, prefix + '.multipart/' + operationId + '.json', prefix + '.multipart/' + operationId + '/parts/1.json']);
        if (own.some(item => !allowed.has(item.name)) || provider.some(item =>
          ![providerPrefix + 'session', providerPrefix + 'part-1'].includes(item.name))) throw new Error('unexpected object in verification namespace');
        for (const item of [...provider, ...own]) {
          if (!/^[1-9]\d*$/.test(item.generation)) throw new Error('invalid cleanup generation');
          const response = await gcs(object(item.name) + '?ifGenerationMatch=' + item.generation, { method: 'DELETE' });
          if (response.status !== 204 && response.status !== 404) throw new Error('generation-fenced cleanup failed: HTTP ' + response.status);
          result.cleanup.deleted.push({ key: item.name, generation: item.generation, status: response.status });
        }
        result.cleanup.remaining = (await list(prefix)).map(item => item.name);
        result.cleanup.providerRemaining = providerPrefix ? (await list(providerPrefix)).map(item => item.name) : [];
        result.cleanup.complete = result.cleanup.remaining.length === 0 && result.cleanup.providerRemaining.length === 0;
        if (!result.cleanup.complete) throw new Error('verification cleanup left residual objects');
      } catch (error) {
        result.cleanup.error = error.message;
        result.result = 'fail';
      }
    } else result.cleanup.complete = true;
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

async function verifyGcsStream(body, expected) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > expected.sizeBytes) throw new Error('GCS public object exceeds admitted size');
    hash.update(chunk);
  }
  const digest = hash.digest('hex');
  if (size !== expected.sizeBytes || digest !== expected.sha256) throw new Error('GCS public bytes differ from the admitted artifact');
  return { sha256: digest, sizeBytes: size };
}

/**
 * @param {string} uri
 * @param {{ sha256: string, sizeBytes: number }} expected
 * @param {(command: string, args: string[], options: any) =>
 *   import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} [spawnImpl]
 */
export async function verifyGcsPrivateBytes(uri, expected, spawnImpl = spawn) {
  const child = spawnImpl('gcloud', ['storage', 'cat', uri], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() :
      reject(new Error(`GCS authenticated read failed (${code ?? signal}): ${stderr}`)));
  });
  const bytes = verifyGcsStream(child.stdout, expected).catch(error => { child.kill(); throw error; });
  return (await Promise.all([bytes, completed]))[0];
}

/** Adopt already staged bytes into the Worker's descriptor contract. No upload,
 * finalization or IAM mutation is allowed on this recovery path.
 * `ctx`/`runMutation` (the release journal) are optional only for `planOnly`;
 * a mutating call without them is refused at runtime.
 * @param {{ target: any, objects: any, ctx?: any, runMutation?: any, planOnly?: boolean,
 *   gcloud?: (args: any) => Promise<string>, verifyPrivate?: typeof verifyGcsPrivateBytes,
 *   log?: typeof console.log }} options
 */
export async function adoptGcsWorkspaceHostObjects({ target, objects, ctx, runMutation,
  planOnly = false, gcloud = runGcloud, verifyPrivate = verifyGcsPrivateBytes, log = console.log }) {
  const canonical = gcsPublicationTarget(target.bucket, target.digest);
  const files = new Set(['server.tgz', 'server.tgz.minisig', 'sbom.cdx.json']);
  if (target.prefix !== canonical.prefix || !objects.length || objects.some(object =>
    !files.has(object.name) || !/^[a-f0-9]{64}$/.test(object.sha256) ||
    !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes <= 0 ||
    (object.name === 'server.tgz' && object.sha256 !== target.digest)) ||
    new Set(objects.map(object => object.name)).size !== objects.length) throw new Error('invalid GCS adoption plan');
  if (planOnly) return { planOnly: true, provider: 'gcs', adoptionOnly: true, target, objects };
  if (!ctx || !runMutation) throw new Error('GCS adoption requires the original release journal');
  const adopted = [];
  for (const object of objects) {
    const uri = `gs://${target.bucket}/${target.prefix}${object.name}`;
    const desired = { namespace: 'workspace-host-v1', bundleSha256: target.digest,
      file: object.name, fileSha256: object.sha256, sizeBytes: String(object.sizeBytes) };
    const read = async () => {
      const metadata = JSON.parse(await gcloud(['storage', 'objects', 'describe', uri, '--raw', '--format=json']));
      if (!/^[1-9]\d*$/.test(String(metadata.generation)) || !/^[1-9]\d*$/.test(String(metadata.metageneration)) ||
        Number(metadata.size) !== object.sizeBytes || metadata.metadata?.sha256 !== object.sha256 ||
        Object.entries(desired).some(([key, value]) => metadata.metadata?.[key] !== undefined && metadata.metadata[key] !== value)) {
        throw new Error(`GCS staged object conflicts with adoption: ${object.name}`);
      }
      return metadata;
    };
    const initial = await read();
    const generation = String(initial.generation);
    const metageneration = String(initial.metageneration);
    // Immutable generation addressing keeps the byte proof valid through the
    // metadata update, even if another writer changes the live object meanwhile.
    const verified = await verifyPrivate(`${uri}#${generation}`, object);
    if (verified.sha256 !== object.sha256 || verified.sizeBytes !== object.sizeBytes) throw new Error('GCS adoption byte verification failed');
    const inspect = async () => {
      const current = await read();
      if (String(current.generation) !== generation) throw new Error('GCS adoption generation changed');
      const complete = Object.entries(desired).every(([key, value]) => current.metadata?.[key] === value) &&
        current.cacheControl === 'private,no-store';
      if (complete) return { state: 'committed', value: { name: object.name, generation, metageneration: String(current.metageneration), ...verified },
        evidenceRefs: [`gcs:${target.bucket}/${target.prefix}${object.name}#${generation}`, `authenticated:sha256:${object.sha256}:${object.sizeBytes}`] };
      if (String(current.metageneration) !== metageneration) throw new Error('GCS adoption metageneration changed; outcome unknown');
      return { state: 'absent' };
    };
    const result = await runMutation(ctx, {
      stage: `publish.gcs.adopt.${object.name}`,
      input: { uri, generation, ...desired },
      reconcile: inspect,
      mutate: async () => {
        const prior = await inspect();
        if (prior.state === 'committed') return prior;
        await gcloud(['storage', 'objects', 'update', uri,
          `--if-generation-match=${generation}`, `--if-metageneration-match=${metageneration}`,
          `--update-custom-metadata=${Object.entries(desired).map(([key, value]) => `${key}=${value}`).join(',')}`,
          '--cache-control=private,no-store', '--quiet']);
        const committed = await inspect();
        if (committed.state !== 'committed') throw new Error('GCS adoption metadata did not persist');
        return committed;
      },
    });
    adopted.push(result);
    log(`GCS metadata adopted ${object.name} generation ${generation}`);
  }
  return { provider: 'gcs', adoptionOnly: true, adopted };
}

/**
 * `ctx`/`runMutation` (the release journal) are optional only for `planOnly`.
 * `fetchImpl` is accepted and deliberately never invoked: private staging must
 * not claim an anonymous delivery read (tests pass a throwing one as a tripwire).
 * @param {{ target: any, objects: any, expiresAt: any, ctx?: any, runMutation?: any,
 *   planOnly?: boolean, stageOnly?: boolean, gcloud?: (args: any) => Promise<string>,
 *   verifyPrivate?: typeof verifyGcsPrivateBytes, log?: typeof console.log, fetchImpl?: unknown }} options
 */
export async function publishGcsObjects({ target, objects, expiresAt, ctx, runMutation,
  planOnly = false, stageOnly = false, gcloud = runGcloud,
  verifyPrivate = verifyGcsPrivateBytes, log = console.log }) {
  if (!stageOnly) throw new Error('Direct GCS publication is private staging only; use the authenticated Worker upload/finalization route for delivery');
  if (!objects.length || objects.some(o => !/^[a-z0-9.-]+$/.test(o.name) || !/^[a-f0-9]{64}$/.test(o.sha256) ||
      !Number.isSafeInteger(o.sizeBytes) || o.sizeBytes <= 0)) throw new Error('invalid GCS object plan');
  const bucketUri = `gs://${target.bucket}`;
  // The existing Worker owns authentication and public finalization. This
  // recovery helper can stage exact private bytes, and never changes IAM.
  const accessScope = { kind: 'private', uri: `${bucketUri}/${target.prefix}` };
  const isAbsent = error => /\bHTTPError 404\b|not found: 404\./.test(String(error.stderr ?? error.message));
  // This read also proves which account can access the existing bucket. Preview
  // never modifies IAM or objects and requires no GitHub/R2 credential.
  await gcloud(['storage', 'buckets', 'describe', bucketUri, '--format=json']);
  objects = objects.filter(object => object.name !== 'manifest.json');
  if (objects.length === 0) throw new Error('GCS staging requires at least one artifact payload');
  if (planOnly) return { planOnly: true, stageOnly, provider: 'gcs', target, objects, accessScope, qualificationExpiresAt: expiresAt };
  if (!ctx || !runMutation) throw new Error('GCS writes require the original release journal');
  const inspectObject = async (object) => {
    let metadata;
    try {
      metadata = JSON.parse(await gcloud(['storage', 'objects', 'describe',
        `${bucketUri}/${target.prefix}${object.name}`, '--raw', '--format=json']));
    } catch (error) {
      // Authentication/transport failures are UNKNOWN, never permission to
      // upload again. Only the provider's explicit missing-object reply is absent.
      if (isAbsent(error)) return { state: 'absent' };
      throw error;
    }
    if (Number(metadata.size) !== object.sizeBytes || metadata.metadata?.sha256 !== object.sha256) {
      throw new Error(`GCS object conflicts with the admitted bytes: ${object.name}`);
    }
    return { state: 'committed', value: { generation: String(metadata.generation), sha256: object.sha256 },
      evidenceRefs: [`gcs:${target.bucket}/${target.prefix}${object.name}#${metadata.generation}`] };
  };
  for (const object of objects) {
    log(`GCS publish ${object.name} (${object.sizeBytes} bytes)`);
    const uri = `${bucketUri}/${target.prefix}${object.name}`;
    await runMutation(ctx, {
      stage: `publish.gcs.object.${object.name}`,
      input: { uri, sha256: object.sha256, sizeBytes: object.sizeBytes },
      reconcile: () => inspectObject(object),
      mutate: async () => {
        const prior = await inspectObject(object);
        if (prior.state === 'committed') return prior;
        await gcloud(['storage', 'cp', object.path, uri, '--if-generation-match=0',
          `--custom-metadata=sha256=${object.sha256}`, `--content-type=${object.contentType}`,
          '--cache-control=private,no-store', '--quiet']);
        const result = await inspectObject(object);
        if (result.state !== 'committed') throw new Error(`GCS upload did not persist: ${object.name}`);
        return result;
      },
    });
  }
  const verified = [];
  for (const object of objects) {
    const uri = `${bucketUri}/${target.prefix}${object.name}`;
    verified.push({ name: object.name, uri, ...await verifyPrivate(uri, object) });
  }
  await runMutation(ctx, { stage: 'publish.gcs.private.verify',
    input: { bucket: target.bucket, objects: verified },
    mutate: async () => ({ value: verified, evidenceRefs: verified.map(o => `authenticated:sha256:${o.sha256}:${o.sizeBytes}`) }),
    reconcile: async () => ({ state: 'committed', value: verified }),
  });
  log('GCS_PRIVATE_STAGE=PASS — public delivery and manifest publication remain pending');
  return { provider: 'gcs', stageOnly: true, verified, accessScope, qualificationExpiresAt: expiresAt };
}
