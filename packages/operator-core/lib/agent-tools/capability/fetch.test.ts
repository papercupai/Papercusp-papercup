import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INLINE_OUTPUT_CAP } from './bash-jobs';
import { CapabilityFetchSizeLimitError, readResponseBody } from './fetch';

function responseFrom(chunks: string[]): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
  });
  return new Response(stream);
}

describe('readResponseBody', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('keeps a response at or below the cap in memory without creating a spill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);

    const result = await readResponseBody(responseFrom(['hello', ' world']), 11, root);

    expect(result).toEqual({ body: 'hello world', truncated: false });
  });

  it('streams an oversized response to disk while retaining only the bounded prefix inline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);

    const result = await readResponseBody(responseFrom(['0123', '456789']), 5, root);

    expect(result.truncated).toBe(true);
    expect(result.body).toBe('01234');
    expect(result.logPath).toBeDefined();
    expect(readFileSync(result.logPath!, 'utf8')).toBe('0123456789');
  });

  it('spills past the shared inline ceiling and reports the returned body as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);
    const body = JSON.stringify({ ok: true, audioBase64: 'A'.repeat(INLINE_OUTPUT_CAP + 10) });

    const result = await readResponseBody(responseFrom([body]), INLINE_OUTPUT_CAP + 100, root);

    expect(result.truncated).toBe(true);
    expect(result.body).toBe(body.slice(0, INLINE_OUTPUT_CAP));
    expect(result.logPath).toBeDefined();
    const spilledBody = readFileSync(result.logPath!, 'utf8');
    expect(spilledBody).toBe(body);
    expect(JSON.parse(spilledBody)).toMatchObject({ ok: true, audioBase64: expect.any(String) });
  });

  it('does not call Response.text, so the cap is enforced by the stream reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);
    const response = responseFrom(['streamed']);
    Object.defineProperty(response, 'text', { value: () => { throw new Error('text() must not be used'); } });

    await expect(readResponseBody(response, 32, root)).resolves.toEqual({ body: 'streamed', truncated: false });
  });

  it('rejects an oversized declared body before pulling it into memory', async () => {
    let pulled = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-length': '1000' } });

    await expect(readResponseBody(response, 16, undefined, 32)).rejects.toBeInstanceOf(
      CapabilityFetchSizeLimitError,
    );
    expect(pulled).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('cancels a chunked body at the hard download ceiling instead of spooling without bound', async () => {
    let cancelled = false;
    const chunks = ['1234', '5678', 'overflow'];
    let index = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]!));
      },
      cancel() { cancelled = true; },
    }));

    await expect(readResponseBody(response, 4, undefined, 8)).rejects.toMatchObject({
      code: 'response_size_limit_exceeded',
      maxDownloadBytes: 8,
    });
    expect(cancelled).toBe(true);
  });
});
