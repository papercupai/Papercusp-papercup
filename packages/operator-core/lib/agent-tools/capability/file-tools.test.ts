/**
 * Unit tests for the capability file tools (P-010, B-05): read / write / edit.
 * Uses temp paths OUTSIDE any git repo, so the file lock is uncoordinated and
 * guardFileLock runs the body directly (no PG) — the lock control-flow itself
 * is covered in locks/file-lock-guard.test.ts.
 *
 * The "outside any git repo" guarantee comes from `mkNonRepoTmpDir`, NOT a raw
 * `mkdtempSync(os.tmpdir())`: when the suite runner's TMPDIR resolves inside this
 * monorepo, a bare os.tmpdir() temp dir has the monorepo `.git` as an ancestor,
 * so guardFileLock treats the path as coordinated and tries to resolve identity
 * (no identity on the test ctx → throws). That is EI-5826 (the EI-5541 class).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toJsonSchema } from '@papercusp/tooldef';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import readTool, { capabilityReadSeeAlso, DEFAULT_LIMIT, MAX_FILE_BYTES } from './read';
import writeTool, { emptyWriteWouldDestroy, looksLikeDisplayFormattedRead } from './write';
import editTool from './edit';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';
import * as scratchReference from '../../scratch-reference';
import {
  DURABLE_SCRATCH_REFERENCE_SCHEME,
  storeVolatileScratchReference,
  writeScratchReference,
} from '../../scratch-reference';

const editCaptureMocks = vi.hoisted(() => ({
  useCoordinatedLock: false,
  recordEditAttribution: vi.fn(),
}));

vi.mock('../locks/file-lock-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../locks/file-lock-guard')>();
  const guardFileLock = vi.fn(async (...args: Parameters<typeof actual.guardFileLock>) => {
    const [ctx, paths, spec, run] = args;
    if (!editCaptureMocks.useCoordinatedLock) return actual.guardFileLock(ctx, paths, spec, run);
    return {
      acquired: true as const,
      coordinated: true,
      result: await run({
        coordinated: true,
        paths: ['src/captured.ts'],
        newlyHeld: ['src/captured.ts'],
        coordinationDomain: '/repo',
        ownerId: 'owner-123',
      }),
    };
  });
  return { ...actual, guardFileLock };
});

vi.mock('../../edit-attribution', () => ({
  recordEditAttribution: editCaptureMocks.recordEditAttribution,
}));

const DIR = mkNonRepoTmpDir('cap-file-');
const baseCtx = {
  projectDir: DIR,
  stateDir: DIR,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
};
const ctx = baseCtx as never;

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

afterEach(() => {
  editCaptureMocks.useCoordinatedLock = false;
  editCaptureMocks.recordEditAttribution.mockReset();
});

describe('capability:read', () => {
  it('does not append human guidance to machine-oriented read modes', () => {
    expect(capabilityReadSeeAlso({}, { raw: true })).toEqual([]);
    expect(capabilityReadSeeAlso({}, { byte_offset: 0, byte_limit: 512 })).toEqual([]);
    expect(capabilityReadSeeAlso({}, { content_indexes: [0] })).toEqual([]);
    expect(capabilityReadSeeAlso({}, { evidence_class: 'test-verdict' })).toEqual([]);
    expect(capabilityReadSeeAlso({}, {})).toContain('capability:edit (exact-string edit)');
    // ToolGuidance.seeAlso owns a generic `args: unknown` callback contract. A
    // non-object value must be accepted and treated like an ordinary read rather
    // than narrowing the callback signature enough to break defineTool inference.
    expect(capabilityReadSeeAlso({}, null)).toContain('capability:edit (exact-string edit)');
  });

  it('recovers a project-relative read from a phantom root through the canonical integration checkout', async () => {
    const phantom = mkNonRepoTmpDir('cap-read-phantom-');
    const canonical = mkNonRepoTmpDir('cap-read-canonical-');
    const relativePath = join('packages', 'operator-core', 'canonical-only.ts');
    const canonicalFile = join(canonical, relativePath);
    mkdirSync(dirname(canonicalFile), { recursive: true });
    writeFileSync(canonicalFile, 'export const canonical = true;\n');

    const previousIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = canonical;
    try {
      const r = (await readTool.handler!({ file_path: relativePath, offset: 1, limit: 1 }, {
        ...baseCtx,
        projectDir: phantom,
      } as never)) as { content: Array<{ text: string }>; isError?: boolean };

      expect(r.isError).not.toBe(true);
      expect(r.content[0].text).toContain(canonicalFile);
      expect(r.content[0].text).toContain('export const canonical = true;');
    } finally {
      if (previousIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = previousIntegrationRoot;
    }
  });

  it('keeps the requested project tree authoritative when both trees contain the relative path', async () => {
    const requested = mkNonRepoTmpDir('cap-read-requested-');
    const canonical = mkNonRepoTmpDir('cap-read-canonical-');
    const relativePath = 'shared.txt';
    writeFileSync(join(requested, relativePath), 'requested\n');
    writeFileSync(join(canonical, relativePath), 'canonical\n');

    const previousIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = canonical;
    try {
      const r = (await readTool.handler!({ file_path: relativePath, raw: true }, {
        ...baseCtx,
        projectDir: requested,
      } as never)) as { content: Array<{ text: string }>; isError?: boolean };

      expect(r.isError).not.toBe(true);
      expect(r.content[0].text).toBe('requested\n');
    } finally {
      if (previousIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = previousIntegrationRoot;
    }
  });

  it('keeps a missing relative path loud at the requested root when no canonical match exists', async () => {
    const requested = mkNonRepoTmpDir('cap-read-missing-requested-');
    const canonical = mkNonRepoTmpDir('cap-read-missing-canonical-');

    const previousIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = canonical;
    try {
      const r = (await readTool.handler!({ file_path: 'still-missing.ts' }, {
        ...baseCtx,
        projectDir: requested,
      } as never)) as { content: Array<{ text: string }>; isError?: boolean };

      expect(r.isError).toBe(true);
      expect(parse(r)).toMatchObject({ reason: 'read_failed' });
      expect(String(parse(r).message)).toContain(join(requested, 'still-missing.ts'));
    } finally {
      if (previousIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = previousIntegrationRoot;
    }
  });

  it('returns numbered lines', async () => {
    const f = join(DIR, 'r.txt');
    writeFileSync(f, 'alpha\nbravo\ncharlie\n');
    const r = (await readTool.handler!({ file_path: f }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('alpha');
    expect(text).toMatch(/\s+1\talpha/);
    expect(text).toMatch(/\s+3\tcharlie/);
  });

  it('returns exact undecorated text for a write-safe whole-file read', async () => {
    const f = join(DIR, 'r-raw.txt');
    const original = 'alpha\n     2\tbravo\ncharlie (3 lines)\n';
    writeFileSync(f, original);
    const r = (await readTool.handler!({ file_path: f, raw: true }, ctx)) as { content: Array<{ text: string }> };

    expect(r.content[0].text).toBe(original);
    expect(r.content[0].text).not.toContain(`${f} (`);
  });

  it('reports line-window metadata for raw reads capped by the default limit', async () => {
    const f = join(DIR, 'r-raw-capped.txt');
    const lines = Array.from({ length: DEFAULT_LIMIT + 3 }, (_, i) => `line-${i + 1}`);
    writeFileSync(f, `${lines.join('\n')}\n`);
    const codeCtx = { ...baseCtx, codeMode: true } as never;

    const first = (await readTool.handler!({ file_path: f, raw: true }, codeCtx)) as {
      content: Array<{ text: string }>;
      structuredContent?: {
        body: string;
        total_lines: number;
        start_line: number | null;
        end_line: number | null;
        has_more: boolean;
      };
    };
    const firstWindow = `${lines.slice(0, DEFAULT_LIMIT).join('\n')}\n`;
    expect(first.content[0].text).toBe(firstWindow);
    expect(first.structuredContent).toMatchObject({
      body: firstWindow,
      total_lines: DEFAULT_LIMIT + 3,
      start_line: 1,
      end_line: DEFAULT_LIMIT,
      has_more: true,
    });

    const last = (await readTool.handler!({
      file_path: f,
      offset: DEFAULT_LIMIT + 1,
      limit: 5,
      raw: true,
    }, codeCtx)) as {
      content: Array<{ text: string }>;
      structuredContent?: {
        total_lines: number;
        start_line: number | null;
        end_line: number | null;
        has_more: boolean;
      };
    };
    expect(last.structuredContent).toMatchObject({
      total_lines: DEFAULT_LIMIT + 3,
      start_line: DEFAULT_LIMIT + 1,
      end_line: DEFAULT_LIMIT + 3,
      has_more: false,
    });
    expect(last.content[0].text).toBe(`${lines.slice(DEFAULT_LIMIT).join('\n')}\n`);
  });

  it('redacts credential-bearing config line reads and refuses exact read modes', async () => {
    const f = join(DIR, 'config.toml');
    const NEVER_EMIT_MARKER = 'never-emit-me';
    writeFileSync(
      f,
      ['[mcp_servers.papercusp-su]', `http_headers = { Authorization = "Bearer ${NEVER_EMIT_MARKER}" }`, 'model = "gpt-5"'].join(
        '\n',
      ),
    );

    const lineRead = (await readTool.handler!({ file_path: f }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(lineRead.isError).not.toBe(true);
    expect(lineRead.content[0].text).toContain('[redacted]');
    expect(lineRead.content[0].text).not.toContain(NEVER_EMIT_MARKER);

    const rawRead = (await readTool.handler!({ file_path: f, raw: true }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(rawRead.isError).toBe(true);
    expect(parse(rawRead)).toMatchObject({ ok: false, reason: 'sensitive_file' });
    expect(rawRead.content[0].text).not.toContain(NEVER_EMIT_MARKER);

    const byteRead = (await readTool.handler!({ file_path: f, byte_offset: 0, byte_limit: 512 }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(byteRead.isError).toBe(true);
    expect(parse(byteRead)).toMatchObject({ ok: false, reason: 'sensitive_file' });
    expect(byteRead.content[0].text).not.toContain(NEVER_EMIT_MARKER);
  });

  it('keeps exact reads available for ordinary files named like configs when no exact secret surface is requested', async () => {
    const f = join(DIR, 'plain-config.toml');
    const original = 'model = "gpt-5"\n';
    writeFileSync(f, original);
    const r = (await readTool.handler!({ file_path: f, raw: true }, ctx)) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toBe(original);
  });

  it('refuses structured reads before parsing a credential-bearing scratch reference', async () => {
    const f = join(DIR, 'config.toml');
    const NEVER_EMIT_MARKER = 'never-emit-me';
    writeScratchReference({
      filePath: f,
      payload: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ Authorization: `Bearer ${NEVER_EMIT_MARKER}` }) }],
      }),
      workspaceId: 'ws-1',
      mediaType: 'application/json',
      evidence: [{ evidenceClass: 'event', contentIndex: 0, jsonPointers: ['/Authorization'] }],
    });
    const readCtx = { ...baseCtx, workspaceId: 'ws-1' } as never;

    for (const args of [{ content_indexes: [0] }, { evidence_class: 'event' }]) {
      const result = (await readTool.handler!({ file_path: f, ...args } as never, readCtx)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ ok: false, reason: 'sensitive_file' });
      expect(result.content[0].text).not.toContain(NEVER_EMIT_MARKER);
    }
  });

  it('preserves exact delimiters for raw line windows', async () => {
    const f = join(DIR, 'r-raw-window.txt');
    writeFileSync(f, 'first\nsecond\nthird');

    const r = (await readTool.handler!({ file_path: f, offset: 2, limit: 2, raw: true }, ctx)) as {
      content: Array<{ text: string }>;
    };

    expect(r.content[0].text).toBe('second\nthird');
  });

  it('rejects raw text mode mixed with exact byte pages', async () => {
    const f = join(DIR, 'r-raw-mixed.txt');
    writeFileSync(f, 'alpha\n');

    // The transport schema must admit the field long enough for the handler to
    // return its actionable mutual-exclusion diagnostic. A z.never() field in
    // the byte branch instead leaks `expected never` before the handler runs.
    const argsSchema = readTool.args as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(argsSchema.safeParse({ file_path: f, raw: true, byte_offset: 0, byte_limit: 32 }).success).toBe(true);

    const r = (await readTool.handler!({ file_path: f, raw: true, byte_offset: 0, byte_limit: 32 } as never, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('mixed_window_modes');
    expect(parse(r).message).toContain('raw text windows cannot be combined with byte_offset/byte_limit');
  });

  it('honors offset + limit', async () => {
    const f = join(DIR, 'r2.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = (await readTool.handler!({ file_path: f, offset: 4, limit: 2 }, ctx)) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    expect(text).toContain('line4');
    expect(text).toContain('line5');
    expect(text).not.toContain('line6');
    expect(text).toContain('more lines');
  });

  it('returns exact resumable byte pages for a single long line', async () => {
    const f = join(DIR, 'r-bytes.json');
    const original = Buffer.from(JSON.stringify({ value: '🙂'.repeat(4_000) }), 'utf8');
    writeFileSync(f, original);

    const recovered: Buffer[] = [];
    let byteOffset = 0;
    let eof = false;
    while (!eof) {
      const r = (await readTool.handler!(
        {
          file_path: f,
          byte_offset: byteOffset,
          byte_limit: 997,
        },
        ctx,
      )) as { content: Array<{ text: string }> };
      const page = parse(r) as {
        encoding: string;
        data: string;
        eof: boolean;
        next_cursor: { args: { byte_offset: number } } | null;
      };
      expect(page.encoding).toBe('base64');
      recovered.push(Buffer.from(page.data, 'base64'));
      eof = page.eof;
      if (!eof) byteOffset = page.next_cursor!.args.byte_offset;
    }

    expect(Buffer.concat(recovered)).toEqual(original);
  });

  it('recovers a long single-line result-door papercusp://scratch URI through byte pages', async () => {
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const scratchRoot = join(DIR, 'result-door-scratch');
    const uri = 'papercusp://scratch/test-workspace/work_items:get/77777777-8888-4999-8aaa-bbbbbbbbbbbb/spill.md';
    const file = join(
      scratchRoot,
      'test-workspace',
      'work_items:get',
      '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      'spill.md',
    );
    const original = Buffer.from(JSON.stringify({ payload: 'x'.repeat(6_100) }), 'utf8');
    process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
    mkdirSync(dirname(file), { recursive: true });
    writeScratchReference({
      filePath: file,
      payload: original,
      workspaceId: 'test-workspace',
      mediaType: 'text/plain',
    });
    const trackedPhases = new Set<string>();
    const trackedCtx = {
      ...baseCtx,
      workspaceId: 'test-workspace',
      phases: {
        track: async (phase: string, work: () => Promise<unknown>) => {
          trackedPhases.add(phase);
          return work();
        },
        addCompleted: (phase: string) => trackedPhases.add(phase),
      },
    };

    try {
      const lineRead = (await readTool.handler!({ uri }, trackedCtx as never)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(lineRead.isError).toBe(true);
      expect(parse(lineRead)).toMatchObject({
        ok: false,
        reason: 'scratch_line_window_too_large',
      });
      expect(parse(lineRead).message).toContain('byte_offset+byte_limit');
      expect([...trackedPhases]).toEqual(expect.arrayContaining([
        'capability:read:scratch:stat',
        'capability:read:scratch:file-read',
        'capability:read:scratch:scratch-reference-parse',
      ]));

      const recovered: Buffer[] = [];
      let byteOffset = 0;
      let eof = false;
      while (!eof && recovered.length < 100) {
        const r = (await readTool.handler!(
          { uri, byte_offset: byteOffset, byte_limit: 997 },
          { ...baseCtx, workspaceId: 'test-workspace' } as never,
        )) as { content: Array<{ text: string }>; isError?: boolean };
        expect(r.isError).not.toBe(true);
        const page = parse(r) as {
          ok: boolean;
          encoding: string;
          data: string;
          byte_length: number;
          eof: boolean;
          next_cursor: { args: { byte_offset: number } } | null;
        };
        expect(page.ok).toBe(true);
        expect(page.encoding).toBe('base64');
        const bytes = Buffer.from(page.data, 'base64');
        expect(bytes.length).toBe(page.byte_length);
        recovered.push(bytes);
        eof = page.eof;
        if (!eof) {
          expect(page.next_cursor).not.toBeNull();
          byteOffset = page.next_cursor!.args.byte_offset;
        }
      }

      expect(eof).toBe(true);
      expect(Buffer.concat(recovered)).toEqual(original);
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
    }
  });

  it('unwraps and authorizes stable references before applying byte windows', async () => {
    const f = join(DIR, 'stable-reference.bin');
    writeScratchReference({
      filePath: f,
      payload: 'first line\nsecond line\n',
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'text/plain',
    });
    const r = (await readTool.handler!(
      {
        file_path: f,
        byte_offset: 0,
        byte_limit: 512,
      },
      { ...baseCtx, workspaceId: 'ws-1' } as never,
    )) as { content: Array<{ text: string }> };
    const page = parse(r) as { data: string; reference: { workspaceId: string; sha256: string } };
    expect(Buffer.from(page.data, 'base64').toString('utf8')).toBe('first line\nsecond line\n');
    expect(page.reference.workspaceId).toBe('ws-1');
    expect(page.reference.sha256).toMatch(/^[a-f0-9]{64}$/);

    const lines = (await readTool.handler!(
      {
        file_path: f,
        offset: 2,
        limit: 1,
      },
      { ...baseCtx, workspaceId: 'ws-1' } as never,
    )) as { content: Array<{ text: string }> };
    expect(lines.content[0].text).toContain('second line');
    expect(lines.content[0].text).not.toContain('first line');
  });

  it('reads durable scratch-spool URIs as exact byte pages with the caller manifest context', async () => {
    const payload = Buffer.from('durable result-page bytes', 'utf8');
    const manifest = writeScratchReference({
      filePath: join(DIR, 'durable-reference.spill'),
      payload,
      workspaceId: 'ws-1',
      ownerId: 'su-owner',
      audience: 'owner',
      mediaType: 'text/plain',
    });
    const uri = DURABLE_SCRATCH_REFERENCE_SCHEME + '/' + 'a'.repeat(64);
    const durableReader = vi.spyOn(
      scratchReference,
      'readDurableScratchReference',
    ).mockResolvedValue({ manifest, payload });
    const ownerCtx = {
      ...baseCtx,
      workspaceId: 'ws-1',
      uiClientId: 'su-owner',
      isSuperuser: true,
    };

    try {
      const first = (await readTool.handler!({
        uri,
        byte_offset: 2,
        byte_limit: 4,
      }, ownerCtx as never)) as { content: Array<{ text: string }>; isError?: boolean };
      expect(first.isError).not.toBe(true);
      const firstPage = parse(first) as {
        encoding: string;
        data: string;
        byte_offset: number;
        byte_length: number;
        eof: boolean;
        next_cursor: { tool: string; args: Record<string, unknown> } | null;
      };
      expect(firstPage).toMatchObject({
        encoding: 'base64',
        byte_offset: 2,
        byte_length: 4,
        eof: false,
        next_cursor: {
          tool: 'capability:read',
          args: { file_path: uri, byte_offset: 6, byte_limit: 4 },
        },
      });
      expect(Buffer.from(firstPage.data, 'base64')).toEqual(payload.subarray(2, 6));

      const next = (await readTool.handler!(
        firstPage.next_cursor!.args as never,
        ownerCtx as never,
      )) as { content: Array<{ text: string }>; isError?: boolean };
      expect(next.isError).not.toBe(true);
      const nextPage = parse(next) as { byte_offset: number; data: string };
      expect(nextPage.byte_offset).toBe(6);
      expect(Buffer.from(nextPage.data, 'base64')).toEqual(payload.subarray(6, 10));
      expect(durableReader).toHaveBeenNthCalledWith(1, uri, {
        workspaceId: 'ws-1',
        ownerId: 'su-owner',
      });
      expect(durableReader).toHaveBeenNthCalledWith(2, uri, {
        workspaceId: 'ws-1',
        ownerId: 'su-owner',
      });
    } finally {
      durableReader.mockRestore();
    }
  });

  it('rejects line, query, and view modes on durable and volatile scratch references', async () => {
    const payload = Buffer.from('scratch mode guard payload', 'utf8');
    const manifest = writeScratchReference({
      filePath: join(DIR, 'durable-mode-guard.spill'),
      payload,
      workspaceId: 'ws-1',
      ownerId: 'su-owner',
      audience: 'owner',
      mediaType: 'text/plain',
    });
    const durableUri = DURABLE_SCRATCH_REFERENCE_SCHEME + '/' + 'b'.repeat(64);
    const durableReader = vi.spyOn(
      scratchReference,
      'readDurableScratchReference',
    ).mockResolvedValue({ manifest, payload });
    const volatile = storeVolatileScratchReference({
      payload,
      workspaceId: 'ws-1',
      ownerId: 'su-owner',
      audience: 'owner',
      mediaType: 'text/plain',
    });
    expect(volatile).not.toBeNull();
    if (!volatile) throw new Error('volatile scratch reference was not stored');
    const ownerCtx = {
      ...baseCtx,
      workspaceId: 'ws-1',
      uiClientId: 'su-owner',
      isSuperuser: true,
    };

    try {
      for (const entry of [
        { uri: durableUri, missingWindow: 'durable_reference_requires_byte_window' },
        { uri: volatile.uri, missingWindow: 'volatile_reference_requires_byte_window' },
      ]) {
        const missing = (await readTool.handler!(
          { uri: entry.uri } as never,
          ownerCtx as never,
        )) as { content: Array<{ text: string }>; isError?: boolean };
        expect(missing.isError).toBe(true);
        expect(parse(missing).reason).toBe(entry.missingWindow);

        for (const mode of [
          { query: 'payload' },
          { view_lines: { offset: 1, limit: 1 } },
        ]) {
          const mixed = (await readTool.handler!(
            { uri: entry.uri, byte_offset: 0, byte_limit: 4, ...mode } as never,
            ownerCtx as never,
          )) as { content: Array<{ text: string }>; isError?: boolean };
          expect(mixed.isError).toBe(true);
          expect(parse(mixed).reason).toBe('mixed_window_modes');
        }
      }
      expect(durableReader).not.toHaveBeenCalled();
    } finally {
      durableReader.mockRestore();
    }
  });

  it('selects only requested MCP content items and rejects the wrong owner', async () => {
    const f = join(DIR, 'owner-reference.json');
    const nestedJson = JSON.stringify({ results: [{ checkpoint: 'saved' }] });
    writeScratchReference({
      filePath: f,
      payload: JSON.stringify({
        content: [
          { type: 'text', text: nestedJson },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'text', text: 'keep me too' },
        ],
        isError: false,
      }),
      workspaceId: 'ws-1',
      ownerId: 'su-owner',
      mediaType: 'application/json',
    });
    const ownerCtx = {
      ...baseCtx,
      workspaceId: 'ws-1',
      uiClientId: 'su-owner',
      isSuperuser: true,
    };
    const selected = (await readTool.handler!(
      {
        file_path: f,
        content_indexes: [2, 1, 2],
      },
      ownerCtx as never,
    )) as { content: Array<{ text: string }> };
    expect(parse(selected)).toMatchObject({
      selected_indexes: [2, 1],
      total_content_items: 3,
      content: [
        { type: 'text', text: 'keep me too' },
        { type: 'image', mimeType: 'image/png' },
      ],
    });

    const nestedSelected = parse((await readTool.handler!(
      { file_path: f, content_indexes: [0] },
      ownerCtx as never,
    )) as { content: Array<{ text: string }> }) as {
      content: Array<{ text: string }>;
      results?: unknown;
    };
    expect(nestedSelected.content[0].text).toBe(nestedJson);
    expect(nestedSelected).not.toHaveProperty('results');

    const denied = (await readTool.handler!(
      {
        file_path: f,
        byte_offset: 0,
        byte_limit: 512,
      },
      { ...ownerCtx, uiClientId: 'su-other' } as never,
    )) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    expect(parse(denied).reason).toBe('forbidden_reference');
  });

  it('reads a signed judge session spill despite its synthesized role principal', async () => {
    const f = join(DIR, 'judge-owner-reference.spill');
    writeScratchReference({
      filePath: f,
      payload: 'judge spill bytes',
      workspaceId: 'ws-1',
      ownerId: 'judge-session-1',
      mediaType: 'text/plain',
    });
    const signedJudgeCtx = {
      ...baseCtx,
      workspaceId: 'ws-1',
      uiClientId: 'judge-session-1',
      sigVerifiedSpawn: true,
      principal: { kind: 'system', slug: 'system:judge', workspaceId: 'ws-1' },
    };
    const own = (await readTool.handler!(
      { file_path: f, byte_offset: 0, byte_limit: 512 },
      signedJudgeCtx as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(own.isError).not.toBe(true);
    expect(Buffer.from(parse(own).data as string, 'base64').toString()).toBe('judge spill bytes');

    const other = (await readTool.handler!(
      { file_path: f, byte_offset: 0, byte_limit: 512 },
      { ...signedJudgeCtx, uiClientId: 'judge-session-2' } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(other.isError).toBe(true);
    expect(parse(other).reason).toBe('forbidden_reference');

    const unsigned = (await readTool.handler!(
      { file_path: f, byte_offset: 0, byte_limit: 512 },
      { ...signedJudgeCtx, sigVerifiedSpawn: false } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(unsigned.isError).toBe(true);
    expect(parse(unsigned).reason).toBe('forbidden_reference');
  });

  it('marks a scratch-reference read whose stored payload may contain producer truncation markers', async () => {
    const f = join(DIR, 'partial-result-door-reference.spill');
    writeScratchReference({
      filePath: f,
      payload: '# result-door spill\n{"outputTailTruncated":true,"textTruncated":true}\n',
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'text/markdown',
    });

    const result = (await readTool.handler!({ file_path: f, offset: 1, limit: 4 }, {
      ...baseCtx,
      workspaceId: 'ws-1',
    } as never)) as {
      content: Array<{ text: string }>;
      _meta?: { capabilityRead?: { source?: string } };
    };

    expect(result.content[0].text).toContain('"outputTailTruncated":true');
    expect(result._meta).toMatchObject({ capabilityRead: { source: 'scratch-reference' } });
  });

  it('resolves one typed evidence class from a shared result-door reference', async () => {
    const f = join(DIR, 'evidence-reference.json');
    writeScratchReference({
      filePath: f,
      payload: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ events: [{ status: 'fired' }], fleet: { alive: 2 } }) }],
      }),
      workspaceId: 'ws-1',
      mediaType: 'application/json',
      evidence: [
        { evidenceClass: 'event', contentIndex: 0, jsonPointers: ['/events'] },
        { evidenceClass: 'fleet', contentIndex: 0, jsonPointers: ['/fleet'] },
      ],
    });
    const selected = (await readTool.handler!(
      {
        file_path: f,
        evidence_class: 'event',
      },
      { ...baseCtx, workspaceId: 'ws-1' } as never,
    )) as { content: Array<{ text: string }> };
    expect(parse(selected)).toMatchObject({
      ok: true,
      evidence_class: 'event',
      evidence: [{ contentIndex: 0, jsonPointer: '/events', value: [{ status: 'fired' }] }],
    });
  });

  it('resolves typed evidence from an ordinary JSON spill using its declared body offset', async () => {
    const f = join(DIR, 'ordinary-json-evidence-reference.txt');
    const prefix = '# Result summary and paging guidance\n\n';
    const body = JSON.stringify({
      ok: true,
      results: [{ id: 'EI-123', workItem: { id: 'EI-123', state: 'open' } }],
    });
    writeScratchReference({
      filePath: f,
      payload: `${prefix}${body}`,
      workspaceId: 'ws-1',
      mediaType: 'text/plain',
      content: [{ index: 0, type: 'text', byteCount: Buffer.byteLength(body) }],
      evidence: [{ evidenceClass: 'work-item', contentIndex: 0, jsonPointers: ['/results/0/workItem'] }],
      bodyOffsetInPayload: Buffer.byteLength(prefix),
    });

    const selected = (await readTool.handler!(
      { file_path: f, evidence_class: 'work-item' },
      { ...baseCtx, workspaceId: 'ws-1' } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(selected.isError).not.toBe(true);
    expect(parse(selected)).toMatchObject({
      ok: true,
      evidence_class: 'work-item',
      evidence: [{
        contentIndex: 0,
        jsonPointer: '/results/0/workItem',
        value: { id: 'EI-123', state: 'open' },
      }],
    });
  });

  it('directs text scratch spills to byte windows when evidence selection needs JSON', async () => {
    const f = join(DIR, 'markdown-evidence-reference.txt');
    const payload = '## Work item\nID: EI-123\n';
    writeScratchReference({
      filePath: f,
      payload,
      workspaceId: 'ws-1',
      mediaType: 'text/markdown',
      evidence: [{ evidenceClass: 'work-item', contentIndex: 0, jsonPointers: ['/id'] }],
    });
    const readCtx = { ...baseCtx, workspaceId: 'ws-1' } as never;

    const selected = (await readTool.handler!(
      { file_path: f, evidence_class: 'work-item' },
      readCtx,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(selected.isError).toBe(true);
    expect(parse(selected)).toMatchObject({
      ok: false,
      reason: 'evidence_not_selectable',
      message: 'scratch reference JSON body is not valid JSON. Use line or byte windows for text or Markdown spills.',
    });

    const bytes = (await readTool.handler!(
      { file_path: f, byte_offset: 0, byte_limit: 256 },
      readCtx,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(bytes.isError).not.toBe(true);
    expect(parse(bytes)).toMatchObject({
      ok: true,
      encoding: 'base64',
      data: Buffer.from(payload).toString('base64'),
      eof: true,
    });
  });

  it('advertises and enforces evidence-class window exclusivity', async () => {
    const published = toJsonSchema(readTool.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { description?: string; not?: unknown }>;
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { description?: string; not?: unknown }>;
      }>;
    };
    const branches = published.anyOf ?? published.oneOf ?? [];
    // Query and searched-view modes were added after the original four branches;
    // keep them in the published schema contract and test their exclusivity too.
    expect(branches).toHaveLength(6);

    const evidenceBranch = branches.find((branch) => branch.required?.includes('evidence_class'));
    expect(evidenceBranch).toBeDefined();
    for (const field of ['offset', 'limit', 'tail', 'byte_offset', 'byte_limit', 'content_indexes']) {
      expect(evidenceBranch?.properties?.[field]?.not, `evidence_class branch must exclude ${field}`).toBeDefined();
    }

    const byteBranch = branches.find(
      (branch) => branch.required?.includes('byte_offset') && branch.required?.includes('byte_limit'),
    );
    expect(byteBranch?.properties?.evidence_class?.not).toBeDefined();
    expect(byteBranch?.properties?.tail?.not).toBeDefined();

    const contentBranch = branches.find((branch) => branch.required?.includes('content_indexes'));
    expect(contentBranch?.properties?.evidence_class?.not).toBeDefined();
    expect(contentBranch?.properties?.tail?.not).toBeDefined();

    const queryBranch = branches.find((branch) => branch.required?.includes('query'));
    expect(queryBranch?.properties?.offset?.not).toBeDefined();
    expect(queryBranch?.properties?.byte_offset?.not).toBeDefined();
    expect(queryBranch?.properties?.evidence_class?.not).toBeDefined();

    const viewBranch = branches.find((branch) => branch.required?.includes('view_lines'));
    expect(viewBranch?.properties?.query?.not).toBeDefined();
    expect(viewBranch?.properties?.offset?.not).toBeDefined();
    expect(viewBranch?.properties?.byte_offset?.not).toBeDefined();
    expect(viewBranch?.properties?.evidence_class?.not).toBeDefined();

    const lineBranch = branches.find((branch) => !branch.required?.length);
    expect(lineBranch?.properties?.evidence_class?.not).toBeDefined();
    expect(lineBranch?.properties?.byte_offset?.not).toBeDefined();

    const descriptions = new Map<string, string>();
    for (const branch of branches) {
      for (const [field, schema] of Object.entries(branch.properties ?? {})) {
        if (schema.description && !descriptions.has(field)) descriptions.set(field, schema.description);
      }
    }
    const peersByField: Record<string, string[]> = {
      offset: ['byte_offset', 'byte_limit', 'content_indexes', 'evidence_class'],
      limit: ['byte_offset', 'byte_limit', 'content_indexes', 'evidence_class'],
      tail: ['byte_offset', 'byte_limit', 'content_indexes', 'evidence_class'],
      byte_offset: ['offset', 'limit', 'tail', 'content_indexes', 'evidence_class'],
      byte_limit: ['offset', 'limit', 'tail', 'content_indexes', 'evidence_class'],
      content_indexes: ['offset', 'limit', 'tail', 'byte_offset', 'byte_limit', 'evidence_class'],
      evidence_class: ['offset', 'limit', 'tail', 'byte_offset', 'byte_limit', 'content_indexes'],
    };
    for (const [field, peers] of Object.entries(peersByField)) {
      const description = descriptions.get(field);
      expect(description, `${field} must be described in the published schema`).toEqual(expect.any(String));
      for (const peer of peers) {
        expect(description, `${field} description must name ${peer}`).toContain(peer);
      }
    }

    for (const field of ['offset', 'limit', 'tail']) {
      const description = lineBranch?.properties?.[field]?.description;
      expect(description, `${field} must explain scratch-reference size limits`).toContain(
        'Scratch-reference line windows can be refused when selected text exceeds the response-size limit',
      );
      expect(description).toContain('byte_offset+byte_limit');
    }

    const contentIndexesDescription = contentBranch?.properties?.content_indexes?.description;
    expect(contentIndexesDescription).toContain("under the response's content field");
    expect(contentIndexesDescription).toContain('it does not parse JSON serialized inside');
    expect(contentIndexesDescription).toContain('Use evidence_class');

    const argsSchema = readTool.args as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(argsSchema.safeParse({ file_path: '/tmp/checkpoint.log', evidence_class: 'event', tail: 10 }).success).toBe(
      false,
    );

    const f = join(DIR, 'evidence-mixed-window.json');
    writeFileSync(f, '{}');
    const mixed = (await readTool.handler!(
      {
        file_path: f,
        evidence_class: 'event',
        byte_offset: 0,
        byte_limit: 32,
      } as never,
      ctx,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(mixed.isError).toBe(true);
    expect(parse(mixed).reason).toBe('mixed_window_modes');
  });

  it('rejects a non-scratch URI instead of resolving it under the project directory', async () => {
    const r = (await readTool.handler!(
      { uri: 'papercusp://not-scratch/file', byte_offset: 0, byte_limit: 512 },
      ctx,
    )) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('invalid_path');
  });

  it('rejects incomplete or mixed byte windows', async () => {
    const f = join(DIR, 'r-byte-invalid.txt');
    writeFileSync(f, 'hello');
    const incomplete = (await readTool.handler!({ file_path: f, byte_offset: 0 } as never, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(incomplete.isError).toBe(true);
    expect(parse(incomplete).reason).toBe('invalid_byte_window');

    const mixed = (await readTool.handler!(
      {
        file_path: f,
        byte_offset: 0,
        byte_limit: 4,
        offset: 1,
      } as never,
      ctx,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(mixed.isError).toBe(true);
    expect(parse(mixed).reason).toBe('mixed_window_modes');
  });

  it('errors on a missing file', async () => {
    const r = (await readTool.handler!({ file_path: join(DIR, 'nope.txt') }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
  });

  // The two widenings below close the file-read gaps the 2026-07-26 bash audit
  // measured against real commands (plan bash-to-tool-substitution-2026-07-26,
  // P-005). Without them the `tail -n N FILE` and `~/`-path forms — 1,752 and
  // ~200 real atoms respectively — had NO tool expression, so the substitution
  // registry could not honestly claim equivalence for them.

  it('reads the last N lines with tail', async () => {
    const f = join(DIR, 'r-tail.txt');
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = (await readTool.handler!({ file_path: f, tail: 3 }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('line98');
    expect(text).toContain('line100');
    expect(text).not.toContain('line97\n');
    // Line numbers stay absolute, so a tail read is still addressable by offset.
    expect(text).toMatch(/\s+100\tline100/);
    // Nothing follows the end of the file.
    expect(text).not.toContain('more lines');
  });

  it('clamps tail to the file length', async () => {
    const f = join(DIR, 'r-tail-short.txt');
    writeFileSync(f, 'only\ntwo\n');
    const r = (await readTool.handler!({ file_path: f, tail: 500 }, ctx)) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toMatch(/\s+1\tonly/);
    expect(r.content[0].text).toContain('two');
  });

  it('streams bounded line windows from files over the unbounded-read cap', async () => {
    const f = join(DIR, 'r-large-tail.log');
    const line = Buffer.from(`${'x'.repeat(128)}\n`);
    const lineCount = Math.ceil((MAX_FILE_BYTES + 1) / line.length);
    const large = Buffer.alloc(line.length * lineCount);
    for (let offset = 0; offset < large.length; offset += line.length) line.copy(large, offset);
    const marker = Buffer.from('tail-marker\n');
    marker.copy(large, large.length - marker.length);
    writeFileSync(f, large);

    const bounded = (await readTool.handler!({ file_path: f, tail: 1 }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(bounded.isError).not.toBe(true);
    expect(bounded.content[0].text).toContain('tail-marker');
    expect(bounded.content[0].text).not.toContain('too_large');

    const raw = (await readTool.handler!({ file_path: f, tail: 1, raw: true }, {
      ...baseCtx,
      codeMode: true,
    } as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(raw.isError).not.toBe(true);
    expect(raw.content[0].text).toContain('tail-marker');
    expect(raw.structuredContent).toMatchObject({
      total_lines: lineCount,
      start_line: lineCount,
      end_line: lineCount,
      has_more: false,
    });

    const unbounded = (await readTool.handler!({ file_path: f }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(unbounded.isError).toBe(true);
    expect(parse(unbounded)).toMatchObject({ reason: 'too_large' });
  });

  it('expands a ~/ path instead of resolving it under the project dir', async () => {
    // `~` is a SHELL feature: Node sees it as relative, so before this the read
    // silently looked for `<projectDir>/~/…` and failed with a confusing error.
    const r = (await readTool.handler!({ file_path: '~/definitely-not-a-real-file-xyz.txt' }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    const message = String(parse(r).message);
    expect(message).toContain(homedir());
    expect(message).not.toContain('~');
  });

  // EI-22044192752243601: ordinary and raw:true reads return a plain TEXT body,
  // not JSON — a code:run script reading `.content` or `.text` off that got a
  // silent `undefined` (a primitive is never wrapped by run-script.ts's
  // field-miss Proxy), and an `?? ''` fallback then wrote an empty string over a
  // tracked file. These pin the fix: a structured, machine-readable twin under
  // `ctx.codeMode`, using field names that avoid run-script.ts's
  // ROOT_ENVELOPE_FIELDS (`content`/`text`) so a script's envelope-shaped guess
  // still throws a loud error instead of silently "succeeding" against the
  // wrong key.
  describe('code-mode structuredContent (EI-22044192752243601)', () => {
    const codeCtx = { ...baseCtx, codeMode: true } as never;
    const mcpStructuredCtx = { ...baseCtx, transport: 'mcp', requestedStructured: true } as never;

    it('attaches an undecorated body for the default (line-numbered) view', async () => {
      const f = join(DIR, 'r-codemode-default.txt');
      writeFileSync(f, 'alpha\nbeta\ngamma\n');
      const r = (await readTool.handler!({ file_path: f }, codeCtx)) as {
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      // The model-facing text keeps its cat -n decoration — the structured twin
      // is additive, never a replacement.
      expect(r.content[0].text).toMatch(/\s+1\talpha/);
      expect(r.structuredContent).toMatchObject({
        ok: true,
        file_path: f,
        body: 'alpha\nbeta\ngamma',
        total_lines: 3,
        start_line: 1,
        end_line: 3,
        has_more: false,
      });
      // The bug's exact failure shape: `.content` / `.text` must not silently
      // resolve to something a naive `?? ''` guess would launder into "".
      expect(r.structuredContent!.content).toBeUndefined();
      expect(r.structuredContent!.text).toBeUndefined();
    });

    it('reports has_more and the visible line range on a windowed default read', async () => {
      const f = join(DIR, 'r-codemode-windowed.txt');
      writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
      const r = (await readTool.handler!({ file_path: f, offset: 2, limit: 3 }, codeCtx)) as {
        structuredContent?: Record<string, unknown>;
      };
      expect(r.structuredContent).toMatchObject({
        body: 'line2\nline3\nline4',
        total_lines: 10,
        start_line: 2,
        end_line: 4,
        has_more: true,
      });
    });

    it('attaches the exact raw span as body for raw:true', async () => {
      const f = join(DIR, 'r-codemode-raw.txt');
      writeFileSync(f, 'one\ntwo\nthree\n');
      const r = (await readTool.handler!({ file_path: f, raw: true }, codeCtx)) as {
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };
      // Raw mode's own contract: the text body is the exact source span.
      expect(r.content[0].text).toBe('one\ntwo\nthree\n');
      expect(r.structuredContent).toEqual({
        ok: true,
        file_path: f,
        body: 'one\ntwo\nthree\n',
        total_lines: 3,
        start_line: 1,
        end_line: 3,
        has_more: false,
      });
    });

    it('still returns a real object — not a vanished falsy value — for an empty raw window', async () => {
      const f = join(DIR, 'r-codemode-raw-empty.txt');
      writeFileSync(f, 'only line\n');
      // offset past the end of the file: the raw branch's empty-slice path,
      // one of the three return sites this fix touches.
      const r = (await readTool.handler!({ file_path: f, raw: true, offset: 5 }, codeCtx)) as {
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };
      expect(r.content[0].text).toBe('');
      // The whole point: an empty BODY must still arrive as a real object a
      // script can branch on (`result.body === ''`), never as the bare '' string
      // this bug's `cur.content ?? cur.text ?? ''` fallback could not tell apart
      // from "the field was never there".
      expect(typeof r.structuredContent).toBe('object');
      expect(r.structuredContent).toEqual({
        ok: true,
        file_path: f,
        body: '',
        total_lines: 1,
        start_line: null,
        end_line: null,
        has_more: false,
      });
    });

    it('costs a non-code-mode caller nothing on all three affected return sites', async () => {
      const f = join(DIR, 'r-codemode-gated.txt');
      writeFileSync(f, 'x\ny\n');
      const direct = (await readTool.handler!({ file_path: f }, ctx)) as { structuredContent?: unknown };
      const directRaw = (await readTool.handler!({ file_path: f, raw: true }, ctx)) as { structuredContent?: unknown };
      const directRawEmpty = (await readTool.handler!({ file_path: f, raw: true, offset: 99 }, ctx)) as { structuredContent?: unknown };
      expect(direct.structuredContent).toBeUndefined();
      expect(directRaw.structuredContent).toBeUndefined();
      expect(directRawEmpty.structuredContent).toBeUndefined();
    });

    it('honors requestedStructured for a direct MCP caller on all three affected return sites', async () => {
      const f = join(DIR, 'r-mcp-structured-direct.txt');
      writeFileSync(f, 'x\ny\n');

      const direct = (await readTool.handler!({ file_path: f }, mcpStructuredCtx)) as {
        structuredContent?: Record<string, unknown>;
      };
      const directRaw = (await readTool.handler!({ file_path: f, raw: true }, mcpStructuredCtx)) as {
        structuredContent?: Record<string, unknown>;
      };
      const directRawEmpty = (await readTool.handler!(
        { file_path: f, raw: true, offset: 99 },
        mcpStructuredCtx,
      )) as { structuredContent?: Record<string, unknown> };

      expect(direct.structuredContent).toMatchObject({ body: 'x\ny', total_lines: 2 });
      expect(directRaw.structuredContent).toEqual({
        ok: true,
        file_path: f,
        body: 'x\ny\n',
        total_lines: 2,
        start_line: 1,
        end_line: 2,
        has_more: false,
      });
      expect(directRawEmpty.structuredContent).toEqual({
        ok: true,
        file_path: f,
        body: '',
        total_lines: 2,
        start_line: null,
        end_line: null,
        has_more: false,
      });
    });

    it('preserves requestedStructured through the projected MCP transport', async () => {
      const f = join(DIR, 'r-mcp-structured-transport.txt');
      writeFileSync(f, 'transport body\n');
      const projected = lookupByMcpName('capability:read');
      expect(projected).toBeDefined();

      const dispatched = await dispatchProjectedTool(
        projected!,
        'capability:read',
        { file_path: f },
        {
          ...baseCtx,
          workspaceId: 'file-tools-test',
          runId: 'capability-read-requested-structured-test',
          role: 'operator',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
        } as never,
        {},
      );

      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      expect(dispatched.result?.structuredContent).toMatchObject({
        ok: true,
        file_path: f,
        body: 'transport body',
        total_lines: 1,
      });
    });
  });
});

describe('capability:write', () => {
  it('creates a file', async () => {
    const f = join(DIR, 'sub/w.txt');
    const r = (await writeTool.handler!({ file_path: f, content: 'hi there\n' }, ctx)) as {
      content: Array<{ text: string }>;
    };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hi there\n');
  });

  it.each(['sub/*.test.ts', 'sub/**/scorecard*', 'sub/scorecard?.ts', 'sub/[scorecard].ts'])(
    'rejects a glob-shaped destination before creating a literal file (%s)',
    async (relativePath) => {
      const f = join(DIR, relativePath);
      const r = (await writeTool.handler!({ file_path: f, content: '{"name":"work_items:get","args":{}}\n' }, ctx)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(r.isError).toBe(true);
      expect(parse(r)).toMatchObject({ ok: false, reason: 'invalid_path' });
      expect(parse(r).message).toContain('concrete destination path');
      expect(() => readFileSync(f, 'utf8')).toThrow();
    },
  );

  /**
   * EI-21824594852517420: an empty write over existing bytes is the one write
   * whose damage is entirely silent — ok:true, bytes:0, and the loss visible
   * only on a later byte-compare. The measured cause was guarding a code:run
   * tool result as `result.content ?? ''`, where the result is already the
   * unwrapped string, so `.content` is undefined and the guard yields ''.
   */
  describe('empty-content overwrite', () => {
    /**
     * The obvious-but-wrong predicate, kept PERMANENTLY as a falsifiability
     * control: guarding on `content === ''` alone also refuses creating a new
     * empty file and re-writing an already-empty one, neither of which destroys
     * anything. The cases below disagree with it, so a regression that widens
     * the guard back to the naive form fails here instead of looking green.
     */
    const naiveWouldDestroy = (content: string, _existingBytes: number | null) => content === '';

    it('refuses to replace an existing non-empty file with empty content', async () => {
      const f = join(DIR, 'empty-guard/keep.txt');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, 'important\n', 'utf8');

      const r = (await writeTool.handler!({ file_path: f, content: '' }, ctx)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(r.isError).toBe(true);
      expect(parse(r)).toMatchObject({ ok: false, reason: 'empty_overwrite_refused', existingBytes: 10 });
      // The refusal must teach the actual cause, not just say no.
      expect(parse(r).message).toContain('allow_empty_overwrite');
      expect(parse(r).message).toContain('raw: true');
      // The whole point: the bytes are still there.
      expect(readFileSync(f, 'utf8')).toBe('important\n');
    });

    it('truncates when the caller explicitly opts in', async () => {
      const f = join(DIR, 'empty-guard/truncate.txt');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, 'goodbye\n', 'utf8');

      const r = (await writeTool.handler!(
        { file_path: f, content: '', allow_empty_overwrite: true },
        ctx,
      )) as { content: Array<{ text: string }> };

      expect(parse(r)).toMatchObject({ ok: true, bytes: 0 });
      expect(readFileSync(f, 'utf8')).toBe('');
    });

    it('still creates a NEW empty file (nothing to destroy)', async () => {
      const f = join(DIR, 'empty-guard/fresh.txt');
      const r = (await writeTool.handler!({ file_path: f, content: '' }, ctx)) as {
        content: Array<{ text: string }>;
      };
      expect(parse(r)).toMatchObject({ ok: true, bytes: 0 });
      expect(readFileSync(f, 'utf8')).toBe('');
      // The naive guard would have refused this.
      expect(naiveWouldDestroy('', null)).toBe(true);
      expect(emptyWriteWouldDestroy('', null)).toBe(false);
    });

    it('still re-writes an already-empty file (nothing to destroy)', async () => {
      const f = join(DIR, 'empty-guard/already-empty.txt');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, '', 'utf8');

      const r = (await writeTool.handler!({ file_path: f, content: '' }, ctx)) as {
        content: Array<{ text: string }>;
      };
      expect(parse(r)).toMatchObject({ ok: true, bytes: 0 });
      // The naive guard would have refused this too.
      expect(naiveWouldDestroy('', 0)).toBe(true);
      expect(emptyWriteWouldDestroy('', 0)).toBe(false);
    });

    it('leaves every non-empty write untouched', async () => {
      expect(emptyWriteWouldDestroy('x', 10)).toBe(false);
      expect(emptyWriteWouldDestroy('', 10)).toBe(true);
    });
  });

  /**
   * EI-21824594852517420, the corruption that was actually MEASURED: the default
   * capability:read view is display-formatted, and writing it back grew a
   * 33,955-byte source into a 38,626-byte destination while reporting ok:true.
   *
   * These cases drive the real read tool rather than a hand-written imitation of
   * its output, so the detector is pinned to read.ts's actual rendering — if that
   * rendering changes, this fails instead of silently ceasing to match.
   */
  describe('display-formatted content', () => {
    const SOURCE = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n';

    function seedSource(name: string): string {
      const src = join(DIR, `roundtrip/${name}.ts`);
      mkdirSync(dirname(src), { recursive: true });
      writeFileSync(src, SOURCE, 'utf8');
      return src;
    }

    async function readText(file: string, raw?: boolean): Promise<string> {
      const r = (await readTool.handler!({ file_path: file, ...(raw ? { raw: true } : {}) }, ctx)) as {
        content: Array<{ text: string }>;
      };
      return r.content[0].text;
    }

    it('refuses real capability:read display output, leaving the destination intact', async () => {
      const src = seedSource('display-src');
      const dest = join(DIR, 'roundtrip/display-dest.ts');
      writeFileSync(dest, 'placeholder\n', 'utf8');

      const displayText = await readText(src);
      // Guard the premise: this really is the decorated view, not raw text.
      expect(displayText).toContain('(4 lines)');
      expect(displayText).toMatch(/\d+\texport const a/);

      const w = (await writeTool.handler!({ file_path: dest, content: displayText }, ctx)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(w.isError).toBe(true);
      expect(parse(w)).toMatchObject({ ok: false, reason: 'display_formatted_content' });
      expect(parse(w).message).toContain('raw: true');
      expect(readFileSync(dest, 'utf8')).toBe('placeholder\n');
    });

    it('lets the CORRECT raw:true route round-trip byte-identically', async () => {
      const src = seedSource('raw-src');
      const dest = join(DIR, 'roundtrip/raw-dest.ts');

      const rawText = await readText(src, true);
      const w = (await writeTool.handler!({ file_path: dest, content: rawText }, ctx)) as {
        content: Array<{ text: string }>;
      };
      expect(parse(w).ok).toBe(true);
      // The whole point of the guard: the correct route is not merely permitted, it is exact.
      expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'));
    });

    it('permits a captured read transcript when the caller says so', async () => {
      const src = seedSource('opt-in-src');
      const dest = join(DIR, 'roundtrip/transcript.txt');
      const displayText = await readText(src);

      const w = (await writeTool.handler!(
        { file_path: dest, content: displayText, allow_display_formatted_content: true },
        ctx,
      )) as { content: Array<{ text: string }> };
      expect(parse(w).ok).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe(displayText);
    });

    it('does not refuse ordinary source that merely mentions a line count', () => {
      // Needs BOTH signals; a parenthesised count alone must not trip it.
      expect(looksLikeDisplayFormattedRead('report.txt (12 lines)\nplain\nbody\ntext\n')).toBe(false);
      expect(looksLikeDisplayFormattedRead(SOURCE)).toBe(false);
      expect(looksLikeDisplayFormattedRead('')).toBe(false);
    });
  });
});

describe('capability:edit', () => {
  it('leaves direct capability edits to PostToolUse attribution', async () => {
    editCaptureMocks.useCoordinatedLock = true;
    const f = join(DIR, 'edit-attribution.txt');
    writeFileSync(f, 'old value\n');

    const result = (await editTool.handler!(
      { file_path: f, old_string: 'old value', new_string: 'new value' },
      { ...baseCtx, workspaceId: 'workspace-1', dispatchCallId: 'dispatch-edit-1' } as never,
    )) as { content: Array<{ text: string }> };

    expect(parse(result).ok).toBe(true);
    expect(editCaptureMocks.recordEditAttribution).not.toHaveBeenCalled();
  });

  it('records frozen repair hunks for code-mode child edits using the edit dispatch id', async () => {
    editCaptureMocks.useCoordinatedLock = true;
    const f = join(DIR, 'edit-code-mode.txt');
    writeFileSync(f, 'old old\n');
    const dispatchTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: true }) }],
    });

    const result = (await editTool.handler!(
      { file_path: f, old_string: 'old', new_string: 'new', replace_all: true },
      {
        ...baseCtx,
        workspaceId: 'workspace-1',
        dispatchCallId: 'dispatch-edit-code-mode',
        codeMode: true,
        dispatchTool,
      } as never,
    )) as { content: Array<{ text: string }> };

    expect(parse(result).ok).toBe(true);
    expect(editCaptureMocks.recordEditAttribution).toHaveBeenCalledWith({
      repoRoot: '/repo',
      files: ['src/captured.ts'],
      agentId: 'owner-123',
      intent: 'capability:edit',
      workspaceId: 'workspace-1',
      dispatchCallId: 'dispatch-edit-code-mode',
    });
    expect(dispatchTool).toHaveBeenCalledWith('release:repair-queue', {
      op: 'record-edit',
      path: 'src/captured.ts',
      hunk: { kind: 'edit', old: 'old', new: 'new', replaceAll: true },
      toolUseId: 'dispatch-edit-code-mode',
      editIndex: 0,
      atMs: expect.any(Number),
    });
  });

  it('records frozen repair hunks for indirect dispatch edits as well as code-mode edits', async () => {
    editCaptureMocks.useCoordinatedLock = true;
    const f = join(DIR, 'edit-indirect.txt');
    writeFileSync(f, 'old value\n');
    const dispatchTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: true }) }],
    });

    const result = (await editTool.handler!(
      { file_path: f, old_string: 'old value', new_string: 'new value' },
      {
        ...baseCtx,
        workspaceId: 'workspace-1',
        dispatchCallId: 'dispatch-edit-indirect',
        indirectDispatch: true,
        dispatchTool,
      } as never,
    )) as { content: Array<{ text: string }> };

    expect(parse(result).ok).toBe(true);
    expect(editCaptureMocks.recordEditAttribution).toHaveBeenCalledWith({
      repoRoot: '/repo',
      files: ['src/captured.ts'],
      agentId: 'owner-123',
      intent: 'capability:edit',
      workspaceId: 'workspace-1',
      dispatchCallId: 'dispatch-edit-indirect',
    });
    expect(dispatchTool).toHaveBeenCalledWith('release:repair-queue', {
      op: 'record-edit',
      path: 'src/captured.ts',
      hunk: { kind: 'edit', old: 'old value', new: 'new value' },
      toolUseId: 'dispatch-edit-indirect',
      editIndex: 0,
      atMs: expect.any(Number),
    });
  });

  it('replaces a unique string', async () => {
    const f = join(DIR, 'e.txt');
    writeFileSync(f, 'const x = 1;\nconst y = 2;\n');
    const r = (await editTool.handler!(
      { file_path: f, old_string: 'const x = 1;', new_string: 'const x = 42;' },
      ctx,
    )) as { content: Array<{ text: string }> };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('const x = 42;');
  });

  it('errors when old_string is absent', async () => {
    const f = join(DIR, 'e2.txt');
    writeFileSync(f, 'hello\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'missing', new_string: 'x' }, ctx)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('not_found');
  });

  it('errors on a non-unique match unless replace_all', async () => {
    const f = join(DIR, 'e3.txt');
    writeFileSync(f, 'dup\ndup\n');
    const bad = (await editTool.handler!({ file_path: f, old_string: 'dup', new_string: 'x' }, ctx)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(bad.isError).toBe(true);
    expect(parse(bad).reason).toBe('not_unique');

    const ok = (await editTool.handler!(
      { file_path: f, old_string: 'dup', new_string: 'x', replace_all: true },
      ctx,
    )) as { content: Array<{ text: string }> };
    expect(parse(ok).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('x\nx\n');
  });

  it('rejects a no-op edit', async () => {
    const f = join(DIR, 'e4.txt');
    writeFileSync(f, 'same\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'same', new_string: 'same' }, ctx)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('no_op');
  });

  // EI-18693907749585513: `String.prototype.replace(old, new)` pattern-interprets
  // `$`-sequences in the REPLACEMENT string even when the search side is a plain
  // string — `` $` `` in particular expands to "everything before the match" and
  // silently spliced an entire file into itself in production. Every one of these
  // must land byte-for-byte, and the resulting file length must equal
  // before.length - old_string.length + new_string.length (no hidden duplication).
  describe('new_string containing JS String.replace special patterns lands verbatim', () => {
    const dollarCases: Array<[label: string, newString: string]> = [
      ['$&  (whole match)', 'prefix $& suffix'],
      ['$` (backtick — everything before the match)', 'prefix $` suffix'],
      ["$' (everything after the match)", "prefix $' suffix"],
      ['$1  (capture group, no regex used)', 'prefix $1 suffix'],
      ['$$  (literal dollar escape)', 'prefix $$ suffix'],
    ];

    for (const [i, [label, newString]] of dollarCases.entries()) {
      it(`single replace: ${label}`, async () => {
        const f = join(DIR, `e-dollar-${i}.txt`);
        const before = 'HEADER\nconst anchor = 1;\nFOOTER\n';
        writeFileSync(f, before);
        const r = (await editTool.handler!(
          { file_path: f, old_string: 'const anchor = 1;', new_string: newString },
          ctx,
        )) as {
          content: Array<{ text: string }>;
          isError?: boolean;
        };
        expect(r.isError).toBeUndefined();
        expect(parse(r).ok).toBe(true);
        const after = readFileSync(f, 'utf8');
        const expected = before.replace('const anchor = 1;', () => newString); // literal splice via callback form (never pattern-interpreted)
        expect(after).toBe(expected);
        expect(after.length).toBe(before.length - 'const anchor = 1;'.length + newString.length);
        expect(after).not.toContain('HEADER\nconst anchor = 1;\nFOOTER\nHEADER'); // the observed corruption shape: prefix spliced back in
      });

      it(`replace_all: ${label}`, async () => {
        const f = join(DIR, `e-dollar-all-${i}.txt`);
        const before = 'anchor\nanchor\n';
        writeFileSync(f, before);
        const r = (await editTool.handler!(
          { file_path: f, old_string: 'anchor', new_string: newString, replace_all: true },
          ctx,
        )) as {
          content: Array<{ text: string }>;
        };
        expect(parse(r).ok).toBe(true);
        expect(readFileSync(f, 'utf8')).toBe(`${newString}\n${newString}\n`);
      });
    }
  });
});
