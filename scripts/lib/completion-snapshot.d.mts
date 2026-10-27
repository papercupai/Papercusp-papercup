/** Serialize JSON incrementally without a document-sized string. */
export function jsonChunks(value: unknown): Generator<string>;
/** SHA-256 of the same UTF-8 bytes produced by JSON.stringify. */
export function jsonSha256(value: unknown): string;
/** Append completionIntegrity while preserving the existing snapshot format. */
export function completionSnapshotChunks(payload: unknown): Generator<string>;
/** JSON.parse-compatible synchronous reader with bounded input buffers. */
export function readCompletionJsonSync(path: string, chunkBytes?: number): any;
