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
 * finalization or IAM mutation is allowed on this recovery path. */
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
