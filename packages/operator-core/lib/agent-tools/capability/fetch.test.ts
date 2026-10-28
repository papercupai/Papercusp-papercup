import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INLINE_OUTPUT_CAP } from './bash-jobs';
import capabilityFetch from './fetch';
import { CapabilityFetchSizeLimitError, readResponseBody } from './fetch';
import { failureClassOf } from '../../failure-loop-circuit-breaker';

const mocks = vi.hoisted(() => ({
  fetchWithCapabilityPolicy: vi.fn(),
  resolveOperationBoundaryProfile: vi.fn(),
  screen: vi.fn(),
  labelExternalContent: vi.fn(),
}));

vi.mock('./fetch-policy', () => ({
  CapabilityFetchPolicyError: class CapabilityFetchPolicyError extends Error {},
  DEFAULT_MAX_REDIRECTS: 5,
  fetchWithCapabilityPolicy: mocks.fetchWithCapabilityPolicy,
}));

vi.mock('./boundary-profile', () => ({
  resolveOperationBoundaryProfile: mocks.resolveOperationBoundaryProfile,
}));

vi.mock('../../external-content', () => ({
  heuristicScreener: { screen: mocks.screen },
  labelExternalContent: mocks.labelExternalContent,
}));

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

function fetchArgs(status: number, expectedStatuses?: number[]) {
  const url = 'https://example.test/negative-control';
  mocks.fetchWithCapabilityPolicy.mockResolvedValueOnce({
    response: new Response(JSON.stringify({ error: 'invalid_execution_kind' }), { status }),
    finalUrl: url,
    finalMethod: 'GET',
    redirectCount: 0,
    release: vi.fn(async () => undefined),
  });
  return capabilityFetch.handler({ url, ...(expectedStatuses ? { expected_statuses: expectedStatuses } : {}) } as never, {
    signal: new AbortController().signal,
  } as never);
}

function toolResult(value: unknown): { isError?: boolean; content?: Array<{ type: string; text?: string }> } {
  return value as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOperationBoundaryProfile.mockResolvedValue({ kind: 'trusted', reason: 'superuser' });
  mocks.screen.mockResolvedValue({ decision: 'allow' });
  mocks.labelExternalContent.mockReturnValue({ kind: 'fetch', host: 'example.test' });
});

describe('capability:fetch expected HTTP statuses', () => {
  it('validates a non-empty unique set of HTTP status codes', () => {
    const parse = (expected_statuses: number[]) => capabilityFetch.args.safeParse({
      url: 'https://example.test/',
      expected_statuses,
    });

    expect(parse([400, 409]).success).toBe(true);
    expect(parse([]).success).toBe(false);
    expect(parse([99]).success).toBe(false);
    expect(parse([600]).success).toBe(false);
    expect(parse([400, 400]).success).toBe(false);
    expect(capabilityFetch.args.safeParse({
      browser: { op: 'open' },
      expected_statuses: [400],
    }).success).toBe(false);
  });

  it('keeps the default non-2xx tool-error behavior', async () => {
    const result = toolResult(await fetchArgs(400));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toMatchObject({ ok: false, status: 400 });
    expect(failureClassOf({ ok: true, result } as never)).toBe('refused');
  });

  it('treats an explicitly expected refusal as a successful tool call and preserves its response', async () => {
    const result = toolResult(await fetchArgs(400, [400]));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      status: 400,
      body: JSON.stringify({ error: 'invalid_execution_kind' }),
    });
    expect(failureClassOf({ ok: true, result } as never)).toBeNull();
  });

  it('does not suppress an unexpected non-2xx status', async () => {
    const result = toolResult(await fetchArgs(409, [400]));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toMatchObject({ ok: false, status: 409 });
    expect(failureClassOf({ ok: true, result } as never)).toBe('refused');
  });
});

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
