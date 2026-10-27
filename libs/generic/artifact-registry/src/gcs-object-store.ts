import { sha256Hex } from './content-address.js';
import type {
  MultipartUpload, ObjectBody, ObjectInput, ObjectMetadata, ObjectPutOptions, ObjectStore, UploadedPart,
} from './object-store.js';

type GcsObject = {
  name: string; size: string; generation: string; updated?: string;
  metadata?: Record<string, string>; contentType?: string; cacheControl?: string;
  contentDisposition?: string; contentEncoding?: string; contentLanguage?: string;
};
type Session = { key: string; options: ObjectPutOptions };
const UPLOADS = '__artifact_uploads/';
const HTTP_FIELDS = ['contentType', 'cacheControl', 'contentDisposition', 'contentEncoding', 'contentLanguage'] as const;
const HTTP_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'content-encoding', 'content-language'];

export class GcsStorageError extends Error {
  constructor(public readonly code: number, operation: string) {
    // Provider bodies can contain credentials or private object paths. Do not echo them.
    super(`GCS ${operation} failed (HTTP ${code})`);
    this.name = 'GcsStorageError';
  }
}

/** Private GCS JSON API backend. Authentication is injected; this adapter owns bytes only. */
export function gcsObjectStore(config: {
  bucket: string;
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): ObjectStore {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) throw new Error('invalid GCS bucket');
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o`;
  const objectUrl = (key: string) => `${base}/${encodeURIComponent(key)}`;
  const uploadBase = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o`;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await config.accessToken()}`);
    return fetchImpl(url, { ...init, headers });
  }
  async function readMetadata(key: string): Promise<GcsObject | null> {
    const r = await request(objectUrl(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new GcsStorageError(r.status, 'metadata read');
    return r.json() as Promise<GcsObject>;
  }
  function metadata(x: GcsObject): ObjectMetadata {
    const size = Number(x.size);
    if (!Number.isSafeInteger(size) || size < 0 || !/^\d+$/.test(x.generation)) throw new Error('invalid GCS object metadata');
    const httpMetadata: Record<string, string> = {};
    HTTP_FIELDS.forEach(k => { if (x[k] !== undefined) httpMetadata[k] = x[k]!; });
    return {
      key: x.name, size, version: x.generation, etag: x.generation, httpEtag: `"${x.generation}"`,
      uploaded: new Date(x.updated ?? 0), customMetadata: x.metadata ?? {}, httpMetadata,
      writeHttpMetadata(headers) {
        HTTP_FIELDS.forEach((k, i) => { if (httpMetadata[k] !== undefined) headers.set(HTTP_HEADERS[i]!, httpMetadata[k]!); });
      },
    };
  }
  function uploadMetadata(options: ObjectPutOptions): Record<string, unknown> {
    return { ...Object.fromEntries(HTTP_FIELDS.filter(k => options.httpMetadata?.[k] !== undefined)
      .map(k => [k, options.httpMetadata![k]])), metadata: options.customMetadata ?? {} };
  }
  async function generationCondition(key: string, options: ObjectPutOptions): Promise<string | null | undefined> {
    const condition = options.onlyIf;
    if (!condition || Object.keys(condition).length === 0) return undefined;
    if (condition.etagDoesNotMatch === '*' && condition.etagMatches === undefined) return '0';
    if (condition.etagMatches !== undefined && condition.etagDoesNotMatch === undefined) {
      const expected = condition.etagMatches.replace(/^"|"$/g, '');
      if (!/^\d+$/.test(expected)) throw new Error('invalid generation condition');
      const current = await readMetadata(key);
      return current?.generation === expected ? expected : null;
    }
    throw new Error('unsupported object precondition');
  }

  const store: ObjectStore = {
    async head(key) { const x = await readMetadata(key); return x ? metadata(x) : null; },
    async get(key): Promise<ObjectBody | null> {
      const x = await readMetadata(key);
      if (!x) return null;
      const url = new URL(objectUrl(key));
      url.searchParams.set('alt', 'media');
      url.searchParams.set('generation', x.generation);
      const r = await request(url.href);
      // A generation disappearing between metadata and bytes is an error, not absence.
      if (!r.ok || !r.body) throw new GcsStorageError(r.status, 'generation-pinned read');
      return { ...metadata(x), body: r.body, arrayBuffer: () => r.arrayBuffer(), text: () => r.text(), json: <T>() => r.json() as Promise<T> };
    },
    async put(key, body, options = {}) {
      if (options.sha256) {
        if (body instanceof ReadableStream) throw new Error('stream SHA256 must be verified by the upload protocol');
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Blob ? await body.arrayBuffer() : body;
        if (await sha256Hex(bytes) !== options.sha256) throw new Error('sha_mismatch');
      }
      const condition = await generationCondition(key, options);
      if (condition === null) return null;
      const url = new URL(uploadBase);
      url.searchParams.set('uploadType', 'resumable'); url.searchParams.set('name', key);
      if (condition !== undefined) url.searchParams.set('ifGenerationMatch', condition);
      const begin = await request(url.href, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(uploadMetadata(options)),
      });
      if (begin.status === 412) return null;
      if (!begin.ok) throw new GcsStorageError(begin.status, 'upload initiation');
      const location = begin.headers.get('location');
      const destination = location ? new URL(location) : null;
      if (!destination || destination.origin !== 'https://storage.googleapis.com' || !destination.pathname.startsWith('/upload/')) {
        throw new Error('invalid GCS upload destination');
      }
      const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', body: body as BodyInit };
      if (body instanceof ReadableStream) init.duplex = 'half';
      const done = await request(destination.href, init);
      if (done.status === 412) return null;
      if (!done.ok) throw new GcsStorageError(done.status, 'upload');
      return metadata(await done.json() as GcsObject);
    },
    async delete(key) {
      const r = await request(objectUrl(key), { method: 'DELETE' });
      if (r.status !== 404 && !r.ok) throw new GcsStorageError(r.status, 'delete');
    },
    async list(options = {}) {
      const url = new URL(base);
      if (options.prefix !== undefined) url.searchParams.set('prefix', options.prefix);
      if (options.cursor !== undefined) url.searchParams.set('pageToken', options.cursor);
      url.searchParams.set('maxResults', String(Math.min(1000, Math.max(1, options.limit ?? 1000))));
      const r = await request(url.href);
      if (!r.ok) throw new GcsStorageError(r.status, 'list');
      const page = await r.json() as { items?: GcsObject[]; nextPageToken?: string };
      return { objects: (page.items ?? []).map(metadata), truncated: Boolean(page.nextPageToken), cursor: page.nextPageToken };
    },
    async createMultipartUpload(key, options = {}) {
      const uploadId = crypto.randomUUID();
      const sessionKey = `${UPLOADS}${uploadId}/session`;
      const value = JSON.stringify({ key, options });
      try {
        const created = await store.put(sessionKey, value, {
          onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
        });
        if (!created) throw new Error('multipart session collision');
      } catch (error) {
        // Initiation can commit before its response is lost. Reconcile this exact
        // UUID and immutable session bytes instead of creating another operation.
        const existing = await store.get(sessionKey);
        if (!existing || existing.size > 64 * 1024 || await existing.text() !== value) throw error;
      }
      return store.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('invalid GCS multipart upload id');
      const prefix = `${UPLOADS}${uploadId}/`;
      async function session(): Promise<Session> {
        const object = await store.get(`${prefix}session`);
        if (!object || object.size > 64 * 1024) throw new Error('multipart session missing');
        const s = await object.json<Session>();
        if (s.key !== key || !s.options || typeof s.options !== 'object') throw new Error('multipart session does not match destination');
        return s;
      }
      async function compose(destination: string, sources: { name: string; generation: string }[], options: ObjectPutOptions) {
        const url = new URL(`${objectUrl(destination)}/compose`);
        url.searchParams.set('ifGenerationMatch', '0');
        const r = await request(url.href, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceObjects: sources, destination: uploadMetadata(options) }),
        });
        if (r.status !== 412 && !r.ok) throw new GcsStorageError(r.status, 'compose');
        if (r.status !== 412) return metadata(await r.json() as GcsObject);
        const existing = await store.head(destination);
        if (!existing || existing.customMetadata.gcsUploadId !== uploadId ||
          existing.customMetadata.gcsPartsHash !== options.customMetadata?.gcsPartsHash) {
          throw new GcsStorageError(412, 'create-only compose');
        }
        return existing;
      }
      const upload: MultipartUpload = {
        key, uploadId,
        async uploadPart(partNumber, body) {
          await session();
          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('invalid part number');
          const object = await store.put(`${prefix}part-${partNumber}`, body);
          if (!object) throw new Error('part upload failed');
          return { partNumber, etag: object.version };
        },
        async complete(parts: UploadedPart[]) {
          const s = await session();
          if (!parts.length || parts.some((p, i) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > 10000 ||
            !/^\d+$/.test(p.etag) || (i > 0 && parts[i - 1]!.partNumber >= p.partNumber))) throw new Error('invalid multipart receipts');
          const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(parts)));
          const options = { ...s.options, customMetadata: { ...s.options.customMetadata, gcsUploadId: uploadId, gcsPartsHash: hash } };
          const existing = await store.head(key);
          if (existing) {
            if (existing.customMetadata.gcsUploadId === uploadId && existing.customMetadata.gcsPartsHash === hash) return existing;
            throw new GcsStorageError(412, 'create-only multipart destination');
          }
          let sources = parts.map(p => ({ name: `${prefix}part-${p.partNumber}`, generation: p.etag }));
          let level = 0;
          while (sources.length > 32) {
            const next: typeof sources = [];
            for (let i = 0; i < sources.length; i += 32) {
              const name = `${prefix}compose-${hash}-${level}-${i / 32}`;
              const object = await compose(name, sources.slice(i, i + 32), options);
              next.push({ name, generation: object.version });
            }
            sources = next; level++;
          }
          // Originals/parts remain until explicit abort/GC after independent byte verification.
          return compose(key, sources, options);
        },
        async abort() {
          await session();
          let cursor: string | undefined;
          do {
            const page = await store.list({ prefix, cursor });
            for (const object of page.objects) if (object.key !== `${prefix}session`) await store.delete(object.key);
            cursor = page.cursor;
          } while (cursor);
          await store.delete(`${prefix}session`);
        },
      };
      return upload;
    },
  };
  return store;
}
