/**
 * result-door-encoding-contract.test.ts — EI-20685195115158619.
 *
 * The spill cursor's recovery instruction is the ONLY guidance an agent has at
 * the moment it hits a capped result, and it is load-bearing: a spilled payload
 * is exactly the situation where an agent is trying to recover authoritative
 * in-flight state and cannot afford a detour.
 *
 * The reported defect was that the cursor "declares base64 but the file is
 * plaintext". The declaration is in fact CORRECT — but about the RESPONSE of the
 * prescribed `capability:read` call, not about the file on disk. A bare
 * `encoding: 'base64'` sitting beside `file_path` invited the other reading, and
 * an agent that took it ran `base64 -d <path>`, got `invalid input`, and burned
 * calls. Worse: `base64 -d` on plaintext exits NON-ZERO with EMPTY stdout, so a
 * piped attempt reads as "the spill is empty" rather than "my decoder was wrong"
 * — an absence-vs-broken-instrument confusion arriving through the recovery path.
 *
 * So this suite pins the CONTRACT rather than either half of it, by following
 * the emitted cursor end-to-end through the real `capability:read` handler. It
 * fails in all four drift directions: the door writing base64 to disk, the read
 * tool ceasing to base64 its `data`, the cursor regaining an unscoped `encoding`
 * field, or the prose losing the disambiguation.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';

// Same seam as result-door.test.ts: the door resolves its constants through the
// config surface per call, so stub it to keep this suite PG-free.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import type { DoorableResult } from './result-door';
import { applyResultDoor, RESULT_DOOR_TOKENS } from './result-door';
import readTool from './agent-tools/capability/read';
import { parseScratchReference, storeVolatileScratchReference } from './scratch-reference';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const WS = 'ws-encoding-contract';
const TOOL = 'work_items:get';

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-door-encoding-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

type SpillCursor = {
  kind: string;
  tool: string;
  args: { file_path: string; byte_offset: number; byte_limit: number };
  maxByteLimit?: number;
  uri?: string;
  encoding?: unknown;
  dataEncoding?: string;
  /** Offset of the JSON body within capability:read's returned `response.data`
   *  (the manifest is already stripped there). */
  bodyOffsetInPayload?: number;
  /** Offset of the JSON body within the RAW on-disk file at `args.file_path`
   *  (manifest header included) — the shell / jq / grep audience. */
  bodyOffsetInFile?: number;
  /** Present and false when the tool clipped fields before this door ran. */
  bodyComplete?: boolean;
};

type BytePage = {
  ok: boolean;
  encoding: string;
  byte_offset: number;
  byte_length: number;
  total_bytes: number;
  data: string;
  eof: boolean;
  next_cursor: { tool: string; args: Record<string, unknown> } | null;
};

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The minimum checks the recovery guidance requires before accepting a page. */
function decodeValidatedPage(page: BytePage): Buffer {
  if (page.ok !== true) throw new Error('byte page did not succeed');
  if (page.encoding !== 'base64') throw new Error('byte page encoding is not base64');
  if (!CANONICAL_BASE64.test(page.data) || Buffer.from(page.data, 'base64').toString('base64') !== page.data) {
    throw new Error('byte page data is not canonical base64');
  }
  const decoded = Buffer.from(page.data, 'base64');
  if (decoded.length !== page.byte_length) {
    throw new Error(`byte page length mismatch: decoded=${decoded.length}, declared=${page.byte_length}`);
  }
  if ((page.eof === true) !== (page.next_cursor === null)) {
    throw new Error('byte page EOF and next_cursor disagree');
  }
  return decoded;
}

/** Drive a payload over the door and return its recovery cursor + prose. */
function doorOversizedResult(): { cursor: SpillCursor; next: string } {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: `WI-${i}`,
    state: 'open',
    detail: `detail ${i} — `.repeat(20),
  }));
  const text = JSON.stringify({ ok: true, rows });
  expect(text.length).toBeGreaterThan(BUDGET_CHARS);

  const doored = applyResultDoor(
    { content: [{ type: 'text' as const, text }] },
    { toolName: TOOL, workspaceId: WS, runId: RUN_ID },
  ) as DoorableResult;

  const body = JSON.parse(
    (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
  ) as { _projection: { cursor: SpillCursor; next: string } };

  expect(body._projection.cursor.kind).toBe('scratch-page');
  return { cursor: body._projection.cursor, next: body._projection.next };
}

/** A valid JSON result whose tool-owned record body is already clipped. */
function doorOversizedPartialJsonResult(): { cursor: SpillCursor; next: string } {
  const records = Array.from({ length: 11 }, (_, i) =>
    `### D-${String(i + 1).padStart(3, '0')}\n${'decision text '.repeat(80)}`,
  ).join('\n\n');
  const text = JSON.stringify({
    ok: true,
    results: [{
      section: {
        heading: 'Decisions',
        level: 2,
        body: records,
        body_truncated: true,
        body_full_chars: records.length + 10_000,
        body_records_shown: 11,
        body_records_total: 22,
      },
    }],
  });
  expect(text.length).toBeGreaterThan(BUDGET_CHARS);

  const doored = applyResultDoor(
    { content: [{ type: 'text' as const, text }] },
    { toolName: TOOL, workspaceId: WS, runId: RUN_ID },
  ) as DoorableResult;
  const body = JSON.parse(
    (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
  ) as { _projection: { cursor: SpillCursor; next: string } };
  return { cursor: body._projection.cursor, next: body._projection.next };
}

/** The unwrapped spill payload returned by capability:read (without the
 *  self-describing manifest header). */
function spillBytes(): Buffer {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, WS, TOOL, RUN_ID);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const reference = parseScratchReference(readFileSync(join(dir, files[0])));
  expect(reference).not.toBeNull();
  return reference!.payload;
}

/** The exact bytes on disk at the cursor's file_path, including its manifest. */
function spillRawBytes(): Buffer {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, WS, TOOL, RUN_ID);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]));
}

describe('EI-20685195115158619: spill cursor encoding contract', () => {
  it('recovers authorized spilled media in a fresh process and reports lost volatile references honestly', () => {
    const owner = 'su-media-recovery';
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
    // A valid mono PCM WAV, with a payload large enough to require paging.
    const audio = Buffer.alloc(32_044);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8_000, 24); audio.writeUInt32LE(16_000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36);
    audio.writeUInt32LE(audio.length - 44, 40);
    const original = {
      content: [
        { type: 'text', text: 'media caption '.repeat(BUDGET_CHARS) },
        { type: 'image', mimeType: 'image/png', data: image.toString('base64') },
        { type: 'audio', mimeType: 'audio/wav', data: audio.toString('base64') },
      ],
    };
    const doored = applyResultDoor(original, { toolName: 'code:run', workspaceId: WS, ownerId: owner, runId: RUN_ID });
    const envelope = JSON.parse((doored.content[0] as { text: string }).text);
    const reference = envelope.content[0];
    expect(reference).toMatchObject({ kind: 'reference', audience: 'owner' });
    expect(envelope.incomplete).toMatchObject({ recoverable: true, spilledItems: 3 });
    const volatile = storeVolatileScratchReference({
      payload: 'process-local media', workspaceId: WS, ownerId: owner,
      audience: 'owner', mediaType: 'text/plain', content: [],
    });
    expect(volatile).not.toBeNull();

    // A separate Node process loads the real reader: no writer Map, mocks,
    // prior tool response, or client-memory payload is available to it.
    const probe = String.raw`
      import { createHash } from 'node:crypto';
      import { pathToFileURL } from 'node:url';
      const [readerPath, uri, workspaceId, ownerId, volatileUri] = process.argv.slice(1);
      const { default: reader } = await import(pathToFileURL(readerPath).href);
      const context = (owner, workspace = workspaceId) => ({
        uiClientId: owner, isSuperuser: true, workspaceId: workspace,
        harnessSlug: 'papercusp', projectDir: process.cwd(),
        principal: { slug: 'system:superuser', workspaceId: workspace },
      });
      const read = async (args, ctx = context(ownerId)) => {
        const result = await reader.handler(args, ctx);
        return JSON.parse(result.content.find(item => item.type === 'text').text);
      };
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      const rejectedOwner = await read({ file_path: uri, content_indexes: [1, 2] }, context('su-foreign'));
      const rejectedWorkspace = await read({ file_path: uri, content_indexes: [1] }, context(ownerId, 'foreign-workspace'));
      const selected = await read({ file_path: uri, content_indexes: [1, 2] });
      if (!selected.ok) throw new Error(JSON.stringify(selected));
      const pages = [];
      let args = { file_path: uri, byte_offset: 0, byte_limit: 1_024 };
      while (args) {
        const page = await read(args);
        if (!page.ok || page.encoding !== 'base64') throw new Error(JSON.stringify(page));
        const bytes = Buffer.from(page.data, 'base64');
        if (bytes.length !== page.byte_length || bytes.toString('base64') !== page.data || page.byte_offset !== Buffer.concat(pages).length) {
          throw new Error('noncanonical or noncontiguous byte page');
        }
        if (page.eof !== (page.next_cursor === null)) throw new Error('cursor/EOF disagreement');
        pages.push(bytes);
        args = page.next_cursor?.args ?? null;
      }
      const restored = JSON.parse(Buffer.concat(pages).toString('utf8'));
      const media = items => items.map(item => ({ type: item.type, mimeType: item.mimeType,
        hash: hash(Buffer.from(item.data, 'base64')), bytes: Buffer.from(item.data, 'base64').length }));
      const lost = await read({ file_path: volatileUri, byte_offset: 0, byte_limit: 1_024 });
      console.log('MEDIA_RECOVERY_RESULT ' + JSON.stringify({
        selected: media(selected.content), paged: media(restored.content.slice(1)),
        pageCount: pages.length, ownerRefusal: rejectedOwner.reason,
        workspaceRefusal: rejectedWorkspace.reason, volatileLost: lost.reason,
        returnedWriterPid: process.ppid, readerPid: process.pid,
      }));
    `;
    const output = execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', probe,
      // Import the handler-only module in the child. Loading the public
      // capability:read wrapper also boots the full agent-mcp catalog, which
      // can consume the entire 15s contract-probe budget before the handler
      // is exercised.
      fileURLToPath(new URL('./agent-tools/capability/read-handler.ts', import.meta.url)),
      reference.uri, WS, owner, volatile!.uri,
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 30_000 });
    const line = output.split('\n').find(row => row.startsWith('MEDIA_RECOVERY_RESULT '));
    expect(line, output).toBeDefined();
    const recovered = JSON.parse(line!.slice('MEDIA_RECOVERY_RESULT '.length));
    const expected = [image, audio].map((bytes, index) => ({
      type: index === 0 ? 'image' : 'audio', mimeType: index === 0 ? 'image/png' : 'audio/wav',
      bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
    }));
    expect(recovered.selected).toEqual(expected);
    expect(recovered.paged).toEqual(expected);
    expect(recovered.pageCount).toBeGreaterThan(1);
    expect(recovered.ownerRefusal).toBe('forbidden_reference');
    expect(recovered.workspaceRefusal).toBe('workspace_mismatch');
    expect(recovered.volatileLost).toBe('expired_reference');
    expect(recovered.readerPid).not.toBe(process.pid);
    expect(recovered.returnedWriterPid).toBe(process.pid);
  }, 20_000);

  it('binds the encoding key to the field it describes, not to the file', () => {
    const { cursor, next } = doorOversizedResult();

    expect(cursor.dataEncoding).toBe('base64');
    // The exact field that caused the misread: unscoped, and adjacent to
    // `file_path`, it reads as a property of the file. It must not come back.
    expect(cursor).not.toHaveProperty('encoding');
    // EI-21349944846228401: the path is a self-describing scratch reference,
    // not the raw JSON payload. Say that at the recovery decision point so a
    // caller does not feed the manifest-bearing file to jq/JSON.parse directly.
    expect(next).toContain('Use capability:read cursor.args');
    expect(next).toContain('byte_offset+byte_limit');
    expect(next).toContain('file_path-only truncates long lines');
    expect(next).toContain('Scratch ref, not JSON');
  });

  it('still LOCATES a tool-internally clipped body, and marks it incomplete (P-005; supersedes the EI-21185758364267344 withholding)', () => {
    const { cursor, next } = doorOversizedPartialJsonResult();

    expect(cursor.kind).toBe('scratch-page');

    // WHERE the body starts and WHETHER it is complete are orthogonal facts.
    // EI-21185758364267344's complaint was the completeness PROMISE, and the
    // remedy taken was to withhold the byte offset entirely. That did not stop
    // anyone parsing these bytes — it pushed them onto "start at the first
    // brace", which in a manifest-bearing spill finds the scratch-reference
    // MANIFEST: a well-formed but WRONG object, i.e. a silent wrong answer
    // instead of a loud failure (EI-21208128396414381, EI-21202588767992062).
    // So the locator is always emitted, and incompleteness is carried by its
    // own field rather than by an ABSENCE no caller can interpret.
    expect(cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
    expect(cursor.bodyComplete).toBe(false);

    // The honesty half must survive intact: the offset must never be read as a
    // promise that paging recovers the omitted records.
    expect(next).toContain('this JSON is partial');
    expect(next).toContain('bodyComplete:false');
    expect(next).toContain('body_truncated');
    expect(next).toContain('paging cannot recover omitted fields');
    expect(next).toContain("Re-read using that field's documented recovery handle or narrower arguments");
    expect(next).not.toContain('recover the exact spill bytes');

    // The locator must actually WORK on the partial path, not merely be present.
    const payload = spillBytes();
    const parsed = JSON.parse(payload.subarray(cursor.bodyOffsetInPayload!).toString('utf8')) as {
      ok: boolean;
      results: { section: { body_records_shown: number } }[];
    };
    expect(parsed.ok).toBe(true);
    // ...and what it locates is still the clipped population it warned about.
    expect(parsed.results[0].section.body_records_shown).toBe(11);

    const spill = payload.toString('utf8');
    expect(spill).toContain('D-011');
    expect(spill).not.toContain('D-012');
  });

  it('keeps the JSON recovery pointer bounded while carrying page integrity and EOF rules', () => {
    // WI-5656's canary sat at the old ambiguity ceiling. The page validation and
    // EOF gate are correctness requirements, so allow a small, explicit budget
    // for them while still pinning this as a length CEILING, not a style check.
    const { cursor, next } = doorOversizedResult();
    const AMBIGUOUS_BASELINE =
      'Call capability:read with _projection.cursor.args, base64-decode data, then follow ' +
      'next_cursor until eof to recover the exact spill bytes. The spill begins with a text ' +
      'header and then contains the result as it reached this door.';
    const PAGE_CONTRACT_HEADROOM = 128;

    const pointerChars = next.indexOf(' ⓘ') === -1 ? next.length : next.indexOf(' ⓘ');
    expect(pointerChars).toBeLessThanOrEqual(AMBIGUOUS_BASELINE.length + PAGE_CONTRACT_HEADROOM);
    expect(JSON.stringify(cursor).length).toBeLessThanOrEqual(
      JSON.stringify({ ...cursor, dataEncoding: undefined, encoding: 'base64' }).length + 8,
    );
  });

  it('distinguishes byte-page and plaintext-line recovery modes without atob', () => {
    const { cursor, next } = doorOversizedResult();

    expect(cursor.args).toHaveProperty('byte_offset');
    expect(cursor.args).toHaveProperty('byte_limit');
    expect(cursor.args).not.toHaveProperty('raw');
    expect(next).toContain('byte_offset+byte_limit; no raw');
    expect(next).toContain('Plaintext: raw:true+offset/limit lines');
    expect(next).not.toContain('raw:true plaintext');
    expect(next).toContain('runtime codec');

    // A bare "base64-decode data" is what left the reporter decoding the file.
    expect(next).toContain('response.data');
    // WI-5656: this is the JSON branch, whose pointer is budgeted together with
    // the retained preview — the fuller prose warning must NOT appear here. A
    // ~90-char addition measurably evicted coord:orient's recovery fields.
    expect(next).not.toContain('grep/tail it directly');
  });

  it('carries the long-line caveat on the plaintext branch only (WI-6554700010018572)', () => {
    // The JSON branch is length-pinned (see the bounded-pointer case above) and already
    // routes readers to byte pages via response.data. The plaintext branch is where raw
    // line windows are a real option, so the caveat must survive there.
    expect(doorOversizedResult().next).not.toContain('long selected lines require byte pages');

    const text = Array.from({ length: 2_000 }, (_, i) => `log line ${i} — ${'payload '.repeat(8)}`).join('\n');
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      { toolName: TOOL, workspaceId: WS, runId: RUN_ID },
    ) as DoorableResult;
    const body = JSON.parse(
      (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
    ) as { _projection: { cursor: SpillCursor; next: string } };

    expect(body._projection.cursor.kind).toBe('scratch-page');
    expect(body._projection.next).toContain(
      'Plaintext: raw:true+offset/limit lines (long selected lines require byte pages).',
    );
  });

  it('requires per-page validation and gates JSON parsing on terminal EOF', () => {
    const { next } = doorOversizedResult();

    // The recovery pointer is the only instruction available at the spill
    // boundary. Keep the checks explicit so a future wording-only change cannot
    // regress to accepting a decodable-but-incomplete page or parsing early.
    expect(next).toContain('canonical');
    expect(next).toContain('base64');
    expect(next).toContain('decoded.length===byte_length');
    expect(next).toContain('parse only at eof:true+next_cursor:null');
  });

  it("surfaces capability:read's schema byte-page ceiling in the cursor", () => {
    const { cursor } = doorOversizedResult();

    expect(cursor.maxByteLimit).toBe(4_096);
    expect(cursor.args.byte_limit).toBeLessThanOrEqual(cursor.maxByteLimit!);
  });

  it('carries the full plaintext warn-off on the raw-text branch, which has budget', () => {
    // Non-JSON body: the `{ text, _projection }` envelope, where the fuller
    // honesty wording already lives and the preview budget is not at stake.
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: 'not json — '.repeat(4_000) }] },
      { toolName: 'code:tools', workspaceId: WS, runId: RUN_ID },
    ) as DoorableResult;
    const body = JSON.parse(
      (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
    ) as { _projection: { next: string } };

    expect(body._projection.next).toContain('response.data');
    // A capability sandbox masks the scratch directory: direct grep/tail can
    // produce ENOENT for an existing spill, falsely implying no data exists.
    expect(body._projection.next).not.toContain('grep/tail it directly');
    expect(body._projection.next).toContain('direct shell access to args.file_path can be sandbox-masked');
    expect(body._projection.next).toContain('plaintext');
    expect(body._projection.next).toContain('base64 -d');
    expect(body._projection.next).toContain('response.data is base64');
  });

  it('keeps the referenced payload as plaintext — capability:read unwraps the manifest', () => {
    doorOversizedResult();
    const bytes = spillBytes();
    const text = bytes.toString('utf8');

    expect(text.startsWith('# result-door spill')).toBe(true);
    // Positive proof of plaintext rather than a lenient decode round-trip:
    // the header carries characters that cannot occur in base64 at all.
    expect(text.slice(0, 200)).toMatch(/[#\s]/);
    expect(/^[A-Za-z0-9+/\r\n=]*$/.test(text)).toBe(false);
  });

  it('gives each byte stream its OWN body offset, and each one parses (EI-21239097430071791)', () => {
    const { cursor, next } = doorOversizedResult();

    // The regression this pins: a SINGLE `bodyByteOffset` was measured against
    // the raw on-disk file while the cursor's own `next` sends the caller to
    // capability:read, which strips the ~450-byte manifest header BEFORE
    // applying byte_offset. Following the cursor exactly therefore overshot
    // into the middle of the JSON and produced an unparseable fragment. Each
    // offset is now named for the stream it measures, and both are proved here
    // against that stream — an offset that parses on one and not the other is
    // precisely the defect, so asserting only one would not catch it.
    expect(cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
    expect(cursor.bodyOffsetInFile).toEqual(expect.any(Number));
    expect(next).toContain('JSON at response.data[cursor.bodyOffsetInPayload].');

    // A complete body must NOT carry the incompleteness marker.
    expect(cursor.bodyComplete).toBeUndefined();

    const expectWholeBody = (body: string, stream: string): void => {
      let parsed: { ok: boolean; rows: unknown[] };
      try {
        parsed = JSON.parse(body) as { ok: boolean; rows: unknown[] };
      } catch (err) {
        throw new Error(`${stream}: offset did not land on parseable JSON — ${String(err)}`);
      }
      expect(parsed.ok).toBe(true);
      expect(parsed.rows).toHaveLength(400);
    };

    // Stream 1 — capability:read's `response.data`: manifest already stripped.
    expectWholeBody(
      spillBytes().subarray(cursor.bodyOffsetInPayload!).toString('utf8'),
      'response.data',
    );
    // Stream 2 — the raw file at `args.file_path`: manifest header included.
    expectWholeBody(
      spillRawBytes().subarray(cursor.bodyOffsetInFile!).toString('utf8'),
      'raw file',
    );

    // The two streams differ by exactly the manifest header — the quantity that
    // was silently conflated. Pinning the RELATION keeps the two offsets from
    // drifting back into one.
    expect(cursor.bodyOffsetInFile!).toBeGreaterThan(cursor.bodyOffsetInPayload!);
    expect(cursor.bodyOffsetInFile! - cursor.bodyOffsetInPayload!).toBe(
      spillRawBytes().length - spillBytes().length,
    );

    // The first `{` in the raw file is the MANIFEST, not the body: the reason a
    // "start at the first brace" fallback returns a well-formed WRONG object.
    expect(spillRawBytes().indexOf('{')).toBeLessThan(cursor.bodyOffsetInFile!);

    // CONTROLS — a permanently-wrong implementation kept beside the real one, so
    // this test is demonstrably falsifiable rather than merely passing. Both
    // reproduce the exact original defect; if either ever starts succeeding, the
    // two offsets have collapsed back into one and the assertions above have
    // stopped discriminating.
    //
    // Control 1: the OLD behaviour — the file-relative offset applied to
    // capability:read's payload, which is what the cursor's `next` sends you to.
    expect(() =>
      JSON.parse(spillBytes().subarray(cursor.bodyOffsetInFile!).toString('utf8')),
    ).toThrow();
    // Control 2: the fallback the missing offset forced — "start at the first
    // brace" in the raw file parses, but yields the MANIFEST, not the result.
    const firstBrace = JSON.parse(
      spillRawBytes().subarray(spillRawBytes().indexOf('{')).toString('utf8').split('\n')[0],
    ) as Record<string, unknown>;
    expect(firstBrace).toHaveProperty('schemaVersion');
    expect(firstBrace).not.toHaveProperty('rows');
  });

  it('the FILE alone carries its body boundary — a consumer with no cursor can still parse it', () => {
    // EI-21949915395361184, an umbrella over TEN reports spanning 2026-08-14..08-25.
    // Every one describes the same consumer: someone holding the path and nothing
    // else — a later session, a shell, a human in the scratch tree. The boundary
    // existed only in the cursor THIS call returns, so that consumer had to guess, and
    // both natural guesses fail badly: `jq .` chokes on the magic line, and "first `{`
    // through EOF" parses the MANIFEST — well-formed, wrong object, no error raised.
    const { cursor } = doorOversizedResult();
    const raw = spillRawBytes();

    // Exactly the shell recipe, executed: line 2 is the manifest, and the header is
    // exactly the first two lines, so the file offset is a derivation, not a guess.
    const firstNewline = raw.indexOf(0x0a);
    const secondNewline = raw.indexOf(0x0a, firstNewline + 1);
    const manifest = JSON.parse(raw.subarray(firstNewline + 1, secondNewline).toString('utf8')) as {
      bodyOffsetInPayload?: number;
    };
    expect(manifest.bodyOffsetInPayload).toEqual(expect.any(Number));

    const bodyOffsetInFile = secondNewline + 1 + manifest.bodyOffsetInPayload!;
    const parsed = JSON.parse(raw.subarray(bodyOffsetInFile).toString('utf8')) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(400);

    // The two publications of ONE boundary must agree. Without this, the manifest could
    // drift away from the cursor and each would look right in its own test.
    expect(bodyOffsetInFile).toBe(cursor.bodyOffsetInFile);

    // The file also TELLS the reader how to do this, and names the wrong guess — a
    // machine-readable field nobody can find is not a fix.
    const text = raw.toString('utf8');
    expect(text).toContain(".bodyOffsetInPayload'");
    expect(text).toContain('Do NOT parse from the first `{`');

    // CONTROL — the guess this exists to replace still fails, so the assertions above
    // are discriminating rather than passing on a file that would parse anyway.
    expect(() => JSON.parse(text)).toThrow();
  });

  it('follows the emitted cursor end-to-end through the real capability:read', async () => {
    const { cursor } = doorOversizedResult();
    expect(cursor.tool).toBe('capability:read');

    // Execute the instruction exactly as an agent would: the cursor's own args,
    // through the actual tool handler — no re-implementation of the byte window.
    const res = (await readTool.handler(cursor.args as never, {
      projectDir: sandbox,
      workspaceId: WS,
    } as never)) as {
      content: Array<{ text: string }>;
    };
    const page = JSON.parse(res.content[0].text) as {
      ok: boolean;
      encoding: string;
      byte_length: number;
      data: string;
      eof: boolean;
    };

    expect(page.ok).toBe(true);
    // The RESPONSE is where base64 is real — this is what the cursor declares.
    expect(page.encoding).toBe(cursor.dataEncoding);
    expect(page.encoding).toBe('base64');

    const decoded = Buffer.from(page.data, 'base64');
    expect(decoded.equals(spillBytes().subarray(0, page.byte_length))).toBe(true);
    expect(decoded.toString('utf8').startsWith('# result-door spill')).toBe(true);
  });

  it('follows the volatile fallback cursor after primary scratch persistence times out', async () => {
    const source = {
      ok: true,
      rows: Array.from({ length: 200 }, (_, i) => ({
        id: `WI-${i}`,
        state: 'open',
        detail: `detail ${i} — `.repeat(18),
      })),
    };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const failure = Object.assign(
      new Error('Timed out after 5000ms waiting for fs-mutex "papercusp-scratch-quota".'),
      { code: 'ETIMEDOUT' },
    );
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: TOOL,
        workspaceId: WS,
        runId: RUN_ID,
        scratchWriteFailure: { error: failure },
      },
    ) as DoorableResult;
    const body = JSON.parse(
      (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
    ) as {
      _projection: {
        cursor: {
          kind: string;
          tool: string;
          reason: string;
          errorCode?: string;
          uri: string;
          args: { uri: string; byte_offset: number; byte_limit: number };
          bodyOffsetInPayload: number;
        };
        next: string;
      };
    };
    const { cursor } = body._projection;

    expect(cursor).toMatchObject({
      kind: 'volatile-scratch-page',
      tool: 'capability:read',
      reason: 'spill-write-failed',
      errorCode: 'ETIMEDOUT',
      args: { uri: cursor.uri, byte_offset: 0, byte_limit: 3_072 },
    });
    expect(cursor.args).not.toHaveProperty('file_path');
    expect(body._projection.next).toContain('Read cursor.args with capability:read');

    const chunks: Buffer[] = [];
    let args: Record<string, unknown> = { ...cursor.args };
    let terminal: BytePage | undefined;
    for (let hop = 0; hop < 100; hop++) {
      const res = (await readTool.handler(args as never, {
        projectDir: sandbox,
        workspaceId: WS,
      } as never)) as { content: Array<{ text: string }> };
      const page = JSON.parse(res.content[0].text) as BytePage;
      chunks.push(decodeValidatedPage(page));
      if (page.eof) {
        terminal = page;
        break;
      }
      expect(page.next_cursor).not.toBeNull();
      expect(page.next_cursor!.tool).toBe('capability:read');
      args = page.next_cursor!.args;
    }

    expect(terminal?.eof).toBe(true);
    expect(terminal?.next_cursor).toBeNull();
    const recovered = Buffer.concat(chunks)
      .subarray(cursor.bodyOffsetInPayload)
      .toString('utf8');
    expect(JSON.parse(recovered)).toEqual(source);
  });

  it('rejects incomplete pages and inconsistent EOF metadata before JSON.parse', () => {
    const data = Buffer.from('page bytes', 'utf8').toString('base64');
    const valid: BytePage = {
      ok: true,
      encoding: 'base64',
      byte_offset: 0,
      byte_length: Buffer.byteLength('page bytes'),
      total_bytes: 100,
      data,
      eof: false,
      next_cursor: { tool: 'capability:read', args: { byte_offset: 10 } },
    };

    // Removing a complete base64 quantum still leaves canonical base64. The
    // declared byte_length is what makes this incomplete page detectable.
    expect(() => decodeValidatedPage({ ...valid, data: data.slice(0, -4) })).toThrow(
      'byte page length mismatch',
    );
    // Buffer.from tolerates whitespace/other malformed input; canonical
    // round-tripping keeps that silent corruption from entering the accumulator.
    expect(() => decodeValidatedPage({ ...valid, data: `${data} ` })).toThrow(
      'canonical base64',
    );
    expect(() => decodeValidatedPage({ ...valid, eof: false, next_cursor: null })).toThrow(
      'EOF and next_cursor disagree',
    );
    expect(() => decodeValidatedPage({ ...valid, eof: true })).toThrow(
      'EOF and next_cursor disagree',
    );
  });

  it('pages the complete JSON body and parses it only after eof', async () => {
    const { cursor } = doorOversizedResult();
    const chunks: Buffer[] = [];
    let args: Record<string, unknown> = { ...cursor.args };
    let terminal: BytePage | undefined;

    for (let hop = 0; hop < 200; hop++) {
      const res = (await readTool.handler(args as never, {
        projectDir: sandbox,
        workspaceId: WS,
      } as never)) as { content: Array<{ text: string }> };
      const page = JSON.parse(res.content[0].text) as BytePage;
      const decoded = decodeValidatedPage(page);
      chunks.push(decoded);

      if (page.eof) {
        terminal = page;
        break;
      }

      // A non-terminal page must never be treated as a complete JSON document.
      // This assertion is intentionally before following the cursor.
      const received = Buffer.concat(chunks).subarray(cursor.bodyOffsetInPayload!);
      expect(() => JSON.parse(received.toString('utf8'))).toThrow();
      expect(page.next_cursor).not.toBeNull();
      expect(page.next_cursor!.tool).toBe('capability:read');
      args = page.next_cursor!.args;
    }

    expect(terminal).toBeDefined();
    expect(terminal!.eof).toBe(true);
    expect(terminal!.next_cursor).toBeNull();
    const body = Buffer.concat(chunks).subarray(cursor.bodyOffsetInPayload!).toString('utf8');
    const parsed = JSON.parse(body) as { ok: boolean; rows: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(400);
  });
});
