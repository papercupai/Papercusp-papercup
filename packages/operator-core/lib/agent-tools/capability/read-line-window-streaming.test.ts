import { mkdtempSync, promises as fs, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import readTool from './read';

let sandbox = '';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'capability-read-window-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('capability:read streamed line windows', () => {
  it('does not materialize a multi-megabyte file for repeated bounded line pages', async () => {
    const filePath = join(sandbox, 'mcp-proxy-failures.jsonl.1');
    const rows = Array.from(
      { length: 25_000 },
      (_, index) => String(index + 1) + '\t' + 'x'.repeat(96),
    );
    writeFileSync(filePath, rows.join('\n') + '\n');
    expect(statSync(filePath).size).toBeGreaterThan(1024 * 1024);

    const fullFileRead = vi.spyOn(fs, 'readFile');
    try {
      for (const offset of [1, 16_001]) {
        const result = await readTool.handler({
          file_path: filePath,
          offset,
          limit: 10,
        } as never, { projectDir: sandbox } as never) as {
          content: Array<{ type: string; text: string }>;
        };
        const text = result.content[0].text;
        const end = offset + 9;
        expect(text).toContain('25000 lines');
        expect(text).toContain('showing ' + offset + '–' + end);
        expect(text).toContain(String(offset).padStart(6) + '\t' + String(offset));
      }

      expect(fullFileRead).not.toHaveBeenCalled();
    } finally {
      fullFileRead.mockRestore();
    }
  });
});
