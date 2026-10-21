/**
 * read-byte-page-door-fit.test.ts — WI-39670.
 *
 * `capability:read`'s byte window is the documented recovery path for a spilled
 * tool result: page the spill, base64-decode `data`, follow `next_cursor`. Every
 * tool result also passes the `resultEach` door, and an over-budget result is
 * projected — which for this tool truncates `data` MID-BASE64. The decode then
 * yields a valid plaintext prefix followed by `invalid input`: silent corruption
 * of the path an agent runs precisely when it has already lost state, while
 * `ok:true`, `eof:false` and a well-formed `next_cursor` all still look healthy.
 *
 * A 4096-byte page is 5464 chars of base64 on its own — over the 6000-char door
 * before the envelope is even counted — so the maximum page the schema ADVERTISED
 * could never be returned intact (EI-20545077286837456, EI-20501871898754755;
 * both were watchdog-auto-closed while the defect stayed live).
 *
 * So these tests assert the property that matters — a page that survives the door
 * and decodes cleanly — rather than any particular page size, and they exercise
 * the real door rather than re-deriving its arithmetic.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor } from '../../result-door';
import type { DoorableResult } from '../../result-door';
import { storeVolatileScratchReference, writeScratchReference } from '../../scratch-reference';
import readTool, { MAX_BYTE_PAGE, MIN_PAGE_BYTES, doorSafePageBytes } from './read';

let sandbox: string;
let filePath: string;
let prevScratchRoot: string | undefined;

/** Distinctive, non-repeating bytes so a truncated decode cannot accidentally match. */
function payload(bytes: number): Buffer {
  let s = '';
  for (let i = 0; s.length < bytes; i++) s += `chunk-${i}-${'abcdefghij'[i % 10]}-payload|`;
  return Buffer.from(s.slice(0, bytes), 'utf8');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-byte-page-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
  // A deep path is part of the subject: `file_path` is absolute and appears
  // TWICE in the response, so path length is what moves the real ceiling. This
  // mirrors a REAL scratch path (~170 chars) on purpose — at ~140 chars an
  // unclamped 4096-byte page lands at ~5944 chars and slips under the 6000-char
  // door, so the fixture passes for the wrong reason and the guard stops
  // constraining anything. Measured: the production repro was 6104 chars.
  filePath = join(
    sandbox,
    'scratch',
    'papercusp-workspace',
    'work_items:get',
    '6168d863-ee2f-4570-a1b2-8c1b631cee4d',
    'nested-scratch-segment',
    'result-door-1786953789399.md',
  );
  // Self-computing fixture precondition, not a magic length: the path must be
  // deep enough that clamping actually ENGAGES at the advertised max. Without
  // this the suite passes whether or not the clamp exists (measured — an
  // earlier ~140-char fixture let the mutant survive).
  expect(doorSafePageBytes(filePath, MAX_BYTE_PAGE)).toBeLessThan(MAX_BYTE_PAGE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, payload(40_000));
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Run the tool, then push its result through the REAL door the way the transport does. */
async function readThroughDoor(args: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) {
  const res = (await readTool.handler(args as never, { projectDir: sandbox, ...ctxExtra } as never)) as {
    content: Array<{ type: string; text: string }>;
  };
  const doored = applyResultDoor(
    { content: res.content as Array<{ type: 'text'; text: string }> },
    { toolName: 'capability:read', workspaceId: 'ws-1', runId: '99999999-8888-4777-8666-555555555555' },
  ) as DoorableResult;
  const text = (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text;
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

/** Model the outer result door used when capability:read is reached through tools:invoke. */
async function readThroughNestedInvokeDoor(args: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) {
  const res = (await readTool.handler(args as never, { projectDir: sandbox, ...ctxExtra } as never)) as {
    content: Array<{ type: string; text: string }>;
  };
  const doored = applyResultDoor(
    { content: res.content as Array<{ type: 'text'; text: string }> },
    { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: '99999999-8888-4777-8666-555555555555' },
  ) as DoorableResult;
  const text = (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text;
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

/** The tool's own response, BEFORE the door — the thing that must fit. */
async function rawResponseText(args: Record<string, unknown>): Promise<string> {
  const res = (await readTool.handler(args as never, { projectDir: sandbox } as never)) as {
    content: Array<{ text: string }>;
  };
  return res.content[0].text;
}

const DOOR_BUDGET_CHARS = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;

describe('EI-25801373601150765: capability:read async filesystem contract', () => {
  it('keeps filesystem calls on the byte-page path asynchronous', () => {
    const source = readFileSync(new URL('./read-handler.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/import\s+\{\s*open,\s*readFile,\s*stat\s*\}\s+from\s+['\"]node:fs\/promises['\"]/);
    expect(source).toMatch(
      /await\s+(?:stat\(abs\)|trackScratchAsync\(\s*['"]stat['"],\s*\(\)\s*=>\s*stat\(abs\)\s*\))/,
    );
    expect(source).toMatch(/await\s+open\(abs,\s*['\"]r['\"]\)/);
    expect(source).toMatch(/await\s+fd\.read\(/);
    expect(source).toMatch(/await\s+fd\.close\(\)/);
    expect(source).toMatch(
      /await\s+(?:readFile\(abs\)|trackScratchAsync\(\s*['"]file-read['"],\s*\(\)\s*=>\s*readFile\(abs\)\s*\))/,
    );

    for (const syncApi of ['openSync', 'readSync', 'closeSync', 'statSync', 'readFileSync']) {
      expect(source).not.toMatch(new RegExp(`\\b${syncApi}\\b`));
    }
  });
});

describe('WI-39670: byte-window pages survive the result door intact', () => {
  it('emits a response within the door budget at the ADVERTISED max byte_limit', async () => {
    // The crisp invariant, independent of how the door happens to project: a
    // response the door must not touch. This is what the clamp exists to hold,
    // and it bites for ANY path length rather than only the fixture's.
    const text = await rawResponseText({ file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });
    expect(text.length).toBeLessThanOrEqual(DOOR_BUDGET_CHARS);
  });

  it('holds that budget for pathological path lengths too', async () => {
    // The ceiling moves with the path; a fixed page size would only relocate the
    // cliff. Build progressively deeper real files and re-check the invariant.
    for (const depth of [1, 6, 12]) {
      const deep = join(sandbox, 'scratch', Array.from({ length: depth }, () => 'deep-scratch-segment').join('/'), 'spill.md');
      mkdirSync(dirname(deep), { recursive: true });
      writeFileSync(deep, payload(40_000));
      const text = await rawResponseText({ file_path: deep, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });
      expect(text.length).toBeLessThanOrEqual(DOOR_BUDGET_CHARS);
      expect(JSON.parse(text).data as string).toBe(
        Buffer.from(payload(40_000).subarray(0, JSON.parse(text).byte_length as number)).toString('base64'),
      );
    }
  });

  it('returns base64 that decodes cleanly at the ADVERTISED max byte_limit', async () => {
    const { parsed } = await readThroughDoor({ file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });

    // The door must not have projected the payload — this is the whole defect.
    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed.ok).toBe(true);

    const data = parsed.data as string;
    expect(data).not.toContain('TRUNCATED');
    // A truncated base64 string decodes to a prefix; a whole one round-trips.
    const decoded = Buffer.from(data, 'base64');
    expect(decoded.length).toBe(parsed.byte_length);
    expect(decoded.toString('base64')).toBe(data);
    expect(decoded.equals(payload(40_000).subarray(0, decoded.length))).toBe(true);
  });

  it('keeps scratch-reference pages lossless through the outer tools:invoke door', async () => {
    const referencePath = filePath;
    const original = payload(40_000);
    const reference = writeScratchReference({
      filePath: referencePath,
      payload: original,
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'text/plain',
      content: [{ index: 0, type: 'text', byteCount: original.length }],
    });
    expect(doorSafePageBytes(referencePath, MAX_BYTE_PAGE, reference)).toBeLessThan(MAX_BYTE_PAGE);

    const { parsed } = await readThroughNestedInvokeDoor(
      { file_path: referencePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE },
      { workspaceId: 'ws-1' },
    );

    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed.ok).toBe(true);
    const data = parsed.data as string;
    const decoded = Buffer.from(data, 'base64');
    expect(decoded.length).toBe(parsed.byte_length);
    expect(decoded.toString('base64')).toBe(data);
    expect(parsed.byte_limit_clamped).toEqual({
      requested: MAX_BYTE_PAGE,
      applied: decoded.length,
    });
    expect(decoded.equals(original.subarray(0, decoded.length))).toBe(true);
    expect((parsed.next_cursor as { args: { byte_offset: number } }).args.byte_offset).toBe(decoded.length);
  });

  it('pages a volatile scratch fallback losslessly through capability:read uri alias and tools:invoke', async () => {
    const original = payload(40_000);
    const fallback = storeVolatileScratchReference({
      payload: original,
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'application/octet-stream',
      content: [{ index: 0, type: 'text', byteCount: original.length }],
    });
    expect(fallback).not.toBeNull();

    const chunks: Buffer[] = [];
    let args: Record<string, unknown> = {
      uri: fallback!.uri,
      byte_offset: 0,
      byte_limit: MAX_BYTE_PAGE,
    };
    for (let hop = 0; hop < 200; hop++) {
      const { parsed } = await readThroughNestedInvokeDoor(args, { workspaceId: 'ws-1' });
      expect(parsed).not.toHaveProperty('_projection');
      expect(parsed).toMatchObject({ ok: true, total_bytes: original.length });
      const data = parsed.data as string;
      const decoded = Buffer.from(data, 'base64');
      expect(decoded.length).toBe(parsed.byte_length);
      expect(decoded.toString('base64')).toBe(data);
      chunks.push(decoded);

      const next = parsed.next_cursor as { args: Record<string, unknown> } | null;
      if (next === null) {
        expect(parsed.eof).toBe(true);
        break;
      }
      expect(next.args.file_path).toBe(fallback!.uri);
      args = next.args;
    }

    expect(Buffer.concat(chunks).equals(original)).toBe(true);
  });

  it('requires byte windows and enforces workspace scope for volatile scratch fallbacks', async () => {
    const fallback = storeVolatileScratchReference({
      payload: 'small fallback',
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'text/plain',
    });
    expect(fallback).not.toBeNull();

    const noWindow = await readThroughDoor({ file_path: fallback!.uri });
    expect(noWindow.parsed).toMatchObject({ ok: false, reason: 'volatile_reference_requires_byte_window' });

    const wrongWorkspace = await readThroughDoor(
      { file_path: fallback!.uri, byte_offset: 0, byte_limit: 256 },
      { workspaceId: 'ws-2' },
    );
    expect(wrongWorkspace.parsed).toMatchObject({ ok: false, reason: 'workspace_mismatch' });
  });

  it('refuses oversized scratch-reference line and raw windows before they spill recursively', async () => {
    const cases = [
      {
        name: 'raw single line',
        fileName: 'oversized-raw-line.md',
        original: payload(DOOR_BUDGET_CHARS + 1_024),
        args: { raw: true },
      },
      {
        name: 'numbered line window',
        fileName: 'oversized-numbered-lines.md',
        original: Buffer.from(Array.from({ length: 5 }, () => 'x'.repeat(1_500)).join('\n')),
        args: {},
      },
    ];

    for (const example of cases) {
      expect(example.original.length).toBeGreaterThan(DOOR_BUDGET_CHARS);
      const referencePath = join(sandbox, 'scratch', example.fileName);
      writeScratchReference({
        filePath: referencePath,
        payload: example.original,
        workspaceId: 'ws-1',
        audience: 'workspace',
        mediaType: 'text/plain',
        content: [{ index: 0, type: 'text', byteCount: example.original.length }],
      });

      const { text, parsed } = await readThroughNestedInvokeDoor(
        { file_path: referencePath, ...example.args },
        { workspaceId: 'ws-1' },
      );

      expect(parsed).toMatchObject({ ok: false, reason: 'scratch_line_window_too_large' });
      expect(parsed.message).toContain('byte_offset+byte_limit');
      expect(parsed).not.toHaveProperty('_projection');
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DOOR_BUDGET_CHARS);
    }
  });

  it('reports the page it actually returned, and advances by exactly that', async () => {
    const { parsed } = await readThroughDoor({ file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });

    const byteLength = parsed.byte_length as number;
    expect(byteLength).toBeGreaterThan(0);
    expect(byteLength).toBeLessThanOrEqual(MAX_BYTE_PAGE);
    // Clamping is only lossless if the cursor advances by the REAL page size.
    const cursor = parsed.next_cursor as { args: { byte_offset: number; byte_limit: number } };
    expect(parsed.byte_limit_clamped).toEqual({
      requested: MAX_BYTE_PAGE,
      applied: byteLength,
    });
    expect(cursor.args.byte_offset).toBe(byteLength);
    // ...and only stable if it stops asking for a size that will be clamped again.
    expect(cursor.args.byte_limit).toBe(byteLength);
  });

  it('honors an explicitly small page when a long path fits below the normal floor', async () => {
    const deep = join(sandbox, Array.from({ length: 40 }, (_, i) => `segment-${i}-${'x'.repeat(50)}`).join('/'), 'spill.md');
    expect(doorSafePageBytes(deep, MAX_BYTE_PAGE)).toBeGreaterThan(256);
    expect(doorSafePageBytes(deep, MAX_BYTE_PAGE)).toBeLessThan(MIN_PAGE_BYTES);

    mkdirSync(dirname(deep), { recursive: true });
    const original = payload(40_000);
    writeFileSync(deep, original);

    const { parsed } = await readThroughDoor({ file_path: deep, byte_offset: 0, byte_limit: 256 });
    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed.ok).toBe(true);
    expect(parsed.byte_length).toBe(256);
    expect(parsed).not.toHaveProperty('byte_limit_clamped');
    expect(Buffer.from(parsed.data as string, 'base64')).toEqual(original.subarray(0, 256));
  });

  it('pages a file to eof losslessly by following its own cursors', async () => {
    const original = payload(40_000);
    const chunks: Buffer[] = [];
    let args: Record<string, unknown> = { file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE };

    for (let hop = 0; hop < 200; hop++) {
      const { parsed } = await readThroughDoor(args);
      expect(parsed).not.toHaveProperty('_projection');
      chunks.push(Buffer.from(parsed.data as string, 'base64'));
      const next = parsed.next_cursor as { args: Record<string, unknown> } | null;
      if (next === null) {
        expect(parsed.eof).toBe(true);
        break;
      }
      args = next.args;
    }

    // Reassembly is the real acceptance test: any truncated hop corrupts this.
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
  });

  it('REFUSES rather than serving a page the door would truncate', async () => {
    // A path so long that not even MIN_PAGE_BYTES fits. Clamping UP to a floor
    // here would re-emit an over-budget response and reintroduce exactly the
    // silent mid-base64 truncation this fix exists to prevent, so the contract
    // is a stated refusal — the guarantee stays unconditional.
    const deep = join(sandbox, Array.from({ length: 40 }, (_, i) => `segment-${i}-${'x'.repeat(50)}`).join('/'), 'spill.md');
    expect(doorSafePageBytes(deep, MAX_BYTE_PAGE)).toBeLessThan(MIN_PAGE_BYTES);

    mkdirSync(dirname(deep), { recursive: true });
    writeFileSync(deep, payload(40_000));
    const raw = await rawResponseText({ file_path: deep, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });
    const parsed = JSON.parse(raw) as { ok: boolean; reason?: string; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('path_too_long_for_byte_window');
    // The refusal has to say what to do instead, or it just relocates the dead end.
    expect(parsed.message).toContain('offset/limit/tail');
    // A refusal is only an improvement if it still fits the door.
    expect(raw.length).toBeLessThanOrEqual(DOOR_BUDGET_CHARS);
  });

  it('shrinks the page as the path grows, since the path is in the envelope twice', () => {
    const shortPath = '/tmp/s.md';
    const longPath = `/tmp/${'deep-scratch-segment/'.repeat(12)}result-door-1786953789399.md`;

    expect(doorSafePageBytes(longPath, MAX_BYTE_PAGE)).toBeLessThan(
      doorSafePageBytes(shortPath, MAX_BYTE_PAGE),
    );
    // A caller asking for less than the ceiling is never inflated to it.
    expect(doorSafePageBytes(shortPath, 1_024)).toBe(1_024);
  });
});
