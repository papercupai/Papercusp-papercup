import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeChunk,
  encodeChunk,
  fingerprintRequest,
  startRecordProxy,
  type RecordedExchange,
} from './record-proxy';

const SSE = ['event: message_start\ndata: {"a":1}\n\n', 'event: content_block_delta\ndata: {"t":"héllo"}\n\n', 'event: message_stop\ndata: {}\n\n'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let upstream: http.Server;
let upstreamUrl: string;
let seen: Array<{ path: string; acceptEncoding: string | undefined; auth: string | undefined; body: string }>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'record-proxy-'));
  seen = [];
  upstream = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', async () => {
      seen.push({
        path: req.url ?? '',
        acceptEncoding: req.headers['accept-encoding'] as string | undefined,
        auth: req.headers.authorization,
        body: Buffer.concat(parts).toString('utf8'),
      });
      if (req.url === '/v1/limited') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end('{"error":"rate"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ev of SSE) {
        await sleep(30);
        res.write(ev);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function readExchanges(file: string): RecordedExchange[] {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecordedExchange);
}

describe('record proxy', () => {
  it('forwards a streamed reply byte-for-byte and records its chunks with increasing offsets', async () => {
    const outFile = path.join(dir, 'ex.jsonl');
    const proxy = await startRecordProxy({ upstream: upstreamUrl, outFile, sessionId: 's1' });
    const reqBody = JSON.stringify({ model: 'claude-sonnet-x', stream: true, messages: [{}, {}, {}], tools: [{}] });
    const res = await post(`${proxy.url}/v1/messages?beta=true`, reqBody, {
      authorization: 'Bearer papercusp-gateway',
      'accept-encoding': 'gzip, br',
    });
    await proxy.close();

    expect(res.status).toBe(200);
    expect(res.body).toBe(SSE.join(''));
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/v1/messages?beta=true');
    expect(seen[0].auth).toBe('Bearer papercusp-gateway');
    expect(seen[0].acceptEncoding).toBe('identity');
    expect(seen[0].body).toBe(reqBody);

    const [ex] = readExchanges(outFile);
    expect(ex.seq).toBe(0);
    expect(ex.sessionId).toBe('s1');
    expect(ex.path).toBe('/v1/messages?beta=true');
    expect(ex.status).toBe(200);
    expect(ex.contentType).toBe('text/event-stream');
    expect(ex.req).toEqual({
      bytes: Buffer.byteLength(reqBody),
      sha256: createHash('sha256').update(reqBody).digest('hex'),
      model: 'claude-sonnet-x',
      stream: true,
      messages: 3,
      tools: 1,
      inputToolOutputs: { count: 0, omitted: 0, items: [] },
    });
    expect(ex.chunks.map(decodeChunk).map((b) => b.toString('utf8')).join('')).toBe(SSE.join(''));
    expect(ex.resBytes).toBe(Buffer.byteLength(SSE.join('')));
    const ts = ex.chunks.map((c) => c.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(ex.ttfbMs).toBe(ts[0]);
    expect(ex.ttfbMs!).toBeGreaterThanOrEqual(20);
    expect(ex.totalMs).toBeGreaterThanOrEqual(ts[ts.length - 1]);
  });

  it('passes an upstream error status through and records it', async () => {
    const outFile = path.join(dir, 'ex.jsonl');
    const proxy = await startRecordProxy({ upstream: upstreamUrl, outFile, sessionId: 's2' });
    const res = await post(`${proxy.url}/v1/limited`, '{"input":[1,2]}');
    await proxy.close();
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    const [ex] = readExchanges(outFile);
    expect(ex.status).toBe(429);
    expect(ex.req.messages).toBe(2);
    expect(ex.chunks.map(decodeChunk).join('')).toBe('{"error":"rate"}');
  });

  it('answers 502 and records the error when the upstream is unreachable', async () => {
    const outFile = path.join(dir, 'ex.jsonl');
    const proxy = await startRecordProxy({ upstream: 'http://127.0.0.1:1', outFile, sessionId: 's3' });
    const res = await post(`${proxy.url}/v1/messages`, '{}');
    await proxy.close();
    expect(res.status).toBe(502);
    const [ex] = readExchanges(outFile);
    expect(ex.status).toBe(502);
    expect(ex.error).toMatch(/^upstream-request:/);
    expect(ex.ttfbMs).toBeNull();
  });

  it('numbers concurrent exchanges uniquely and writes one line per exchange', async () => {
    const outFile = path.join(dir, 'ex.jsonl');
    const proxy = await startRecordProxy({ upstream: upstreamUrl, outFile, sessionId: 's4' });
    await Promise.all([1, 2, 3].map((i) => post(`${proxy.url}/v1/messages`, JSON.stringify({ model: `m${i}` }))));
    expect(proxy.count()).toBe(3);
    await proxy.close();
    const exs = readExchanges(outFile);
    expect(exs.map((e) => e.seq).sort()).toEqual([0, 1, 2]);
    expect(new Set(exs.map((e) => e.req.model))).toEqual(new Set(['m1', 'm2', 'm3']));
  });
});

describe('chunk encoding', () => {
  it('keeps clean utf8 as text and falls back to base64 for a split multibyte sequence', () => {
    expect(encodeChunk(5, Buffer.from('ok é'))).toEqual({ t: 5, d: 'ok é' });
    const split = Buffer.from('é', 'utf8').subarray(0, 1);
    const enc = encodeChunk(6, split);
    expect(enc.d).toBeUndefined();
    expect(decodeChunk(enc).equals(split)).toBe(true);
  });

  it('fingerprints a non-JSON body without throwing', () => {
    const fp = fingerprintRequest(Buffer.from('not json'));
    expect(fp.model).toBeNull();
    expect(fp.bytes).toBe(8);
  });

  it('records bounded, redacted tool-output metadata for OpenAI and Anthropic requests', () => {
    const privateText = 'private tool output must not be recorded';
    const openAiBody = {
      model: 'gpt-5-codex',
      input: [
        { type: 'custom_tool_call', call_id: 'model-call', input: privateText },
        { type: 'custom_tool_call_output', call_id: 'codex-call-7', output: privateText },
        { type: 'function_call_output', call_id: 'function-call-8', output: { result: privateText } },
      ],
    };
    const openAiFingerprint = fingerprintRequest(Buffer.from(JSON.stringify(openAiBody)));
    expect(openAiFingerprint.inputToolOutputs).toEqual({
      count: 2,
      omitted: 0,
      items: [
        { type: 'custom_tool_call_output', callId: 'codex-call-7', outputBytes: Buffer.byteLength(privateText) },
        { type: 'function_call_output', callId: 'function-call-8', outputBytes: Buffer.byteLength(JSON.stringify({ result: privateText })) },
      ],
    });
    expect(JSON.stringify(openAiFingerprint)).not.toContain(privateText);

    const anthropicContent = [{ type: 'text', text: privateText }];
    const anthropicFingerprint = fingerprintRequest(Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-use-9', content: anthropicContent }] }],
    })));
    expect(anthropicFingerprint.inputToolOutputs).toEqual({
      count: 1,
      omitted: 0,
      items: [{ type: 'tool_result', callId: 'tool-use-9', outputBytes: Buffer.byteLength(JSON.stringify(anthropicContent)) }],
    });
    expect(JSON.stringify(anthropicFingerprint)).not.toContain(privateText);
  });

  it('caps tool-output metadata while retaining the total count', () => {
    const body = {
      input: Array.from({ length: 66 }, (_, i) => ({ type: 'function_call_output', call_id: `call-${i}`, output: 'x' })),
    };
    const fp = fingerprintRequest(Buffer.from(JSON.stringify(body)));
    expect(fp.inputToolOutputs).toMatchObject({ count: 66, omitted: 2 });
    expect(fp.inputToolOutputs?.items).toHaveLength(64);
  });
});
