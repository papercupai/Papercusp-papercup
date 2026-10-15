/**
 * token-efficiency-prompts-cache-and-behavior-2026-10-11 P-005 / SPEC-P-005-REFUSED.
 *
 * A saved-result query (`capability:read { file_path, query }`) must pass the same
 * scratch-reference authorization and expiry gate as a plain read. If it did not, `query`
 * would be a side door into another workspace's saved tool output, or into one past its
 * retention. Each refusal case asserts that no line of the saved body reaches the caller,
 * and a positive control proves the same fixture IS found when the caller is entitled to it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { writeScratchReference } from '../../scratch-reference';
import readTool from './read';

let sandbox: string;
let prevScratchRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-read-query-auth-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Text that appears only in the saved body — never in the query or an error message. */
const BODY_ONLY = 'leaked-into-the-saved-result';

function writeRef(name: string, workspaceId: string, nowMs?: number): string {
  const filePath = join(sandbox, 'scratch', name);
  const payload = `ok line 1\nFAIL needle ${BODY_ONLY}\nok line 3\n`;
  writeScratchReference({
    filePath,
    payload,
    workspaceId,
    audience: 'workspace',
    mediaType: 'text/plain',
    content: [{ index: 0, type: 'text', byteCount: Buffer.byteLength(payload) }],
    nowMs,
  });
  return filePath;
}

async function query(filePath: string, workspaceId: string) {
  const res = (await readTool.handler(
    { file_path: filePath, query: 'needle' } as never,
    { projectDir: sandbox, workspaceId } as never,
  )) as { content: Array<{ type: string; text: string }> };
  const text = res.content[0].text;
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

describe('capability:read query — the same authorization gate as a plain read', () => {
  it('CONTROL: the owning workspace finds the matching line', async () => {
    const { parsed, text } = await query(writeRef('own.md', 'ws-1'), 'ws-1');
    expect(parsed).toMatchObject({ ok: true, matchCount: 1 });
    expect(text).toContain(BODY_ONLY);
  });

  it('refuses a reference written for another workspace and returns none of its lines', async () => {
    const { parsed, text } = await query(writeRef('foreign.md', 'ws-1'), 'ws-2');
    expect(parsed).toMatchObject({ ok: false, reason: 'workspace_mismatch' });
    expect(parsed).not.toHaveProperty('matches');
    expect(text).not.toContain(BODY_ONLY);
  });

  it('refuses an expired reference and returns none of its lines', async () => {
    const { parsed, text } = await query(writeRef('expired.md', 'ws-1', 0), 'ws-1');
    expect(parsed).toMatchObject({ ok: false, reason: 'expired_reference' });
    expect(parsed).not.toHaveProperty('matches');
    expect(text).not.toContain(BODY_ONLY);
  });
});
