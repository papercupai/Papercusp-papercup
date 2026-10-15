import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_SPOOL_BYTES,
  createGatewayPayloadSpool,
  type GatewayPayloadSpool,
} from './inference-gateway/payload-spool';
import {
  DURABLE_SCRATCH_REFERENCE_SCHEME,
  DURABLE_SCRATCH_REFERENCE_TTL_MS,
  authorizeScratchReference,
  isDurableScratchReferenceUri,
  parseScratchReference,
  persistVolatileScratchReference,
  readDurableScratchReference,
  ScratchReferenceError,
  readVolatileScratchReference,
  scratchReferenceBodyByteOffset,
  storeVolatileScratchReference,
  VOLATILE_SCRATCH_REFERENCE_TTL_MS,
  writeScratchReference,
} from './scratch-reference';

describe('stable scratch references', () => {
  let dir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scratch-reference-'));
    previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = dir;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
    else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores one self-describing file and verifies its payload hash and byte count', () => {
    const filePath = join(dir, 'ws', 'tool', 'run', 'result.json');
    const payload = Buffer.from('{"ok":true}', 'utf8');
    const manifest = writeScratchReference({
      filePath,
      payload,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'application/json',
      content: [{ index: 0, type: 'text', byteCount: payload.length }],
      nowMs: 1_000,
    });

    const parsed = parseScratchReference(readFileSync(filePath));
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
    expect(parsed!.manifest).toEqual(manifest);
    expect(parsed!.payloadByteOffset).toBeGreaterThan(0);
    expect(manifest.expiresAt).not.toBe(manifest.createdAt);
  });

  it('fails closed on tampering and enforces expiry, workspace, and owner audience', () => {
    const filePath = join(dir, 'ws', 'tool', 'run', 'result.txt');
    const manifest = writeScratchReference({
      filePath,
      payload: 'secret',
      workspaceId: 'ws',
      ownerId: 'su-1',
      mediaType: 'text/plain',
      nowMs: 10_000,
    });

    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-1', nowMs: 10_001,
    })).not.toThrow();
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'other', ownerId: 'su-1', nowMs: 10_001,
    })).toThrowError(ScratchReferenceError);
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-2', nowMs: 10_001,
    })).toThrowError(/restricted to its creating owner/);
    expect(() => authorizeScratchReference(manifest, {
      workspaceId: 'ws', ownerId: 'su-1', nowMs: Date.parse(manifest.expiresAt),
    })).toThrowError(/expired/);

    const bytes = readFileSync(filePath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(filePath, bytes);
    expect(() => parseScratchReference(readFileSync(filePath))).toThrowError(/SHA-256 mismatch/);
  });

  it('publishes the body boundary against the PAYLOAD, and drops one that does not point into it', () => {
    // EI-21949915395361184. A file-relative offset cannot be stored in the header it
    // would have to measure, so the manifest carries the payload-relative number and
    // the file offset stays derived. Proving the round-trip here is what stops a
    // future writer from "simplifying" it into a file offset that is self-referential.
    const filePath = join(dir, 'ws', 'tool', 'run', 'body.md');
    const prefix = '# preamble a reader must skip\n\n';
    const body = '{"ok":true,"rows":[1,2,3]}';
    const manifest = writeScratchReference({
      filePath,
      payload: prefix + body,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'text/plain',
      bodyOffsetInPayload: Buffer.byteLength(prefix, 'utf8'),
      nowMs: 1_000,
    });

    expect(manifest.bodyOffsetInPayload).toBe(Buffer.byteLength(prefix, 'utf8'));
    const raw = readFileSync(filePath);
    const offset = scratchReferenceBodyByteOffset(manifest);
    expect(offset).not.toBeNull();
    expect(JSON.parse(raw.subarray(offset!).toString('utf8'))).toEqual({ ok: true, rows: [1, 2, 3] });

    // The header is exactly two lines, which is what makes the shell recipe in the
    // spill (`head -2 | wc -c`) a derivation rather than a guess.
    const firstNewline = raw.indexOf(0x0a);
    const secondNewline = raw.indexOf(0x0a, firstNewline + 1);
    expect(secondNewline + 1 + manifest.bodyOffsetInPayload!).toBe(offset);

    // An offset that does not point into this payload is DROPPED, not written down
    // wrong: past the end it would send a reader to EOF, which reads as an empty body
    // rather than as a broken manifest.
    const bogus = writeScratchReference({
      filePath: join(dir, 'ws', 'tool', 'run', 'bogus.md'),
      payload: prefix + body,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'text/plain',
      bodyOffsetInPayload: Buffer.byteLength(prefix + body, 'utf8') + 1,
      nowMs: 1_000,
    });
    expect(bogus.bodyOffsetInPayload).toBeUndefined();
    expect(scratchReferenceBodyByteOffset(bogus)).toBeNull();
  });

  it('returns null for legacy scratch files', () => {
    expect(parseScratchReference(Buffer.from('legacy payload'))).toBeNull();
  });

  it('keeps volatile recovery bytes exact and enforces workspace, owner, and expiry', () => {
    const payload = Buffer.from('volatile result with exact bytes: \u2603', 'utf8');
    const stored = storeVolatileScratchReference({
      payload,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'text/plain',
      content: [{ index: 0, type: 'text', byteCount: payload.length }],
      bodyOffsetInPayload: 0,
    });

    expect(stored).not.toBeNull();
    expect(stored!.uri).toMatch(/^papercusp:\/\/scratch-memory\/[0-9a-f-]{36}$/);
    expect(stored!.manifest).toMatchObject({
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      byteCount: payload.length,
      bodyOffsetInPayload: 0,
    });
    expect(readVolatileScratchReference(stored!.uri, {
      workspaceId: 'ws', ownerId: 'su-1',
    }).payload).toEqual(payload);

    expect(() => readVolatileScratchReference(stored!.uri, {
      workspaceId: 'other', ownerId: 'su-1',
    })).toThrowError(/different workspace/);
    expect(() => readVolatileScratchReference(stored!.uri, {
      workspaceId: 'ws', ownerId: 'su-2',
    })).toThrowError(/restricted to its creating owner/);
    expect(() => readVolatileScratchReference(stored!.uri, {
      workspaceId: 'ws', ownerId: 'su-1', nowMs: Date.parse(stored!.manifest.expiresAt),
    })).toThrowError(/expired/);
    expect(() => readVolatileScratchReference(stored!.uri, {
      workspaceId: 'ws', ownerId: 'su-1',
    })).toThrowError(/no longer available/);
  });

  it('persists volatile fallbacks in the content-addressed spool with bounded expiry and manifest authorization', async () => {
    const nowMs = 1_000;
    const payload = Buffer.from('durable recovery bytes: ☃', 'utf8');
    const stored = storeVolatileScratchReference({
      payload,
      workspaceId: 'ws',
      ownerId: 'su-1',
      audience: 'owner',
      mediaType: 'text/plain',
      content: [{ index: 0, type: 'text', byteCount: payload.length }],
      nowMs,
    });
    expect(stored).not.toBeNull();
    if (!stored) throw new Error('volatile scratch reference was not stored');

    const blobs = new Map<string, Buffer>();
    const spool: GatewayPayloadSpool = {
      spool: vi.fn(async (body: Buffer) => {
        const payloadRef = createHash('sha256').update(body).digest('hex');
        blobs.set(payloadRef, Buffer.from(body));
        return { payloadRef, bytes: body.byteLength, deduped: false };
      }),
      read: vi.fn(async (payloadRef: string) => {
        const bytes = blobs.get(payloadRef);
        return bytes ? Buffer.from(bytes) : null;
      }),
      retain: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      sweep: vi.fn(async () => 0),
    };
    const createSpool = vi.spyOn(
      await import('./inference-gateway/payload-spool'),
      'createGatewayPayloadSpool',
    ).mockReturnValue(spool);

    try {
      const persistAtMs = nowMs + 1;
      const persisted = await persistVolatileScratchReference(stored.uri, {
        workspaceId: 'ws',
        ownerId: 'su-1',
        nowMs: persistAtMs,
      });

      expect(DURABLE_SCRATCH_REFERENCE_TTL_MS).toBe(VOLATILE_SCRATCH_REFERENCE_TTL_MS);
      expect(createSpool).toHaveBeenNthCalledWith(1, {
        maxBytes: DEFAULT_MAX_SPOOL_BYTES,
        ttlMs: Date.parse(stored.manifest.expiresAt) - persistAtMs,
      });
      expect(persisted.uri).toMatch(new RegExp('^' + DURABLE_SCRATCH_REFERENCE_SCHEME + '/[a-f0-9]{64}$'));
      expect(isDurableScratchReferenceUri(persisted.uri)).toBe(true);
      expect(spool.spool).toHaveBeenCalledWith(expect.any(Buffer), {
        contentType: 'application/vnd.papercusp.scratch-reference',
      });

      const recovered = await readDurableScratchReference(persisted.uri, {
        workspaceId: 'ws',
        ownerId: 'su-1',
        nowMs: persistAtMs + 1,
      });
      expect(recovered).toEqual({ manifest: stored.manifest, payload });

      await expect(readDurableScratchReference(persisted.uri, {
        workspaceId: 'other',
        ownerId: 'su-1',
        nowMs: persistAtMs + 2,
      })).rejects.toThrowError(/different workspace/);
      await expect(readDurableScratchReference(persisted.uri, {
        workspaceId: 'ws',
        ownerId: 'su-2',
        nowMs: persistAtMs + 2,
      })).rejects.toThrowError(/restricted to its creating owner/);
      await expect(readDurableScratchReference(persisted.uri, {
        workspaceId: 'ws',
        ownerId: 'su-1',
        nowMs: Date.parse(stored.manifest.expiresAt),
      })).rejects.toThrowError(/expired/);
    } finally {
      createSpool.mockRestore();
    }
  });

  it('enforces the volatile entry and cache-count bounds', () => {
    const tooLarge = storeVolatileScratchReference({
      payload: Buffer.alloc(16 * 1024 * 1024 + 1),
      workspaceId: 'ws',
      audience: 'workspace',
      mediaType: 'application/octet-stream',
    });
    expect(tooLarge).toBeNull();

    const refs = Array.from({ length: 65 }, (_, index) => storeVolatileScratchReference({
      payload: `entry-${index}`,
      workspaceId: 'ws',
      audience: 'workspace',
      mediaType: 'text/plain',
    }));
    expect(refs.every((entry) => entry !== null)).toBe(true);
    expect(() => readVolatileScratchReference(refs[0]!.uri, { workspaceId: 'ws' }))
      .toThrowError(/no longer available/);
    expect(readVolatileScratchReference(refs.at(-1)!.uri, { workspaceId: 'ws' }).payload.toString())
      .toBe('entry-64');
  });
});
