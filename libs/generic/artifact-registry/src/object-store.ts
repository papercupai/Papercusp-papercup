import type { BlobStore } from './blob-store.js';

/** Host-facing extension of BlobStore. Visibility and finalization stay in the host. */
export interface ObjectMetadata {
  key: string;
  size: number;
  version: string;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  customMetadata: Record<string, string>;
  httpMetadata: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
}

export interface ObjectBody extends ObjectMetadata {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export type ObjectInput = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string | Blob;
export interface ObjectPutOptions {
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  sha256?: string;
  onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string };
}
export interface UploadedPart { partNumber: number; etag: string }
export interface MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, body: ObjectInput): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<ObjectMetadata>;
  abort(): Promise<void>;
}
export interface ObjectStore {
  head(key: string): Promise<ObjectMetadata | null>;
  get(key: string): Promise<ObjectBody | null>;
  put(key: string, body: ObjectInput, options?: ObjectPutOptions): Promise<ObjectMetadata | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: ObjectMetadata[]; truncated: boolean; cursor?: string;
  }>;
  createMultipartUpload(key: string, options?: ObjectPutOptions): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

/** Keep the registry's existing four-method port; richer hosts use ObjectStore directly. */
export function objectStoreAsBlobStore(store: ObjectStore): BlobStore<ObjectBody> {
  return {
    head: key => store.head(key),
    get: key => store.get(key),
    delete: key => store.delete(key),
    async put(key, body, options) {
      await store.put(key, body, {
        sha256: options?.sha256,
        httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
      });
    },
  };
}
