import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openClaudeDialog } from '../dialog-answer-provenance.mjs';

describe('dialog answer provenance paths', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('uses PAPERCUSP_HOME ahead of HOME when no explicit provenance directory is set', () => {
    root = mkdtempSync(join(tmpdir(), 'dialog-answer-provenance-'));
    const scopedHome = join(root, 'scoped');
    const fallbackHome = join(root, 'fallback');
    const env = {
      PAPERCUSP_HOME: scopedHome,
      PAPERCUSP_TURN_PROVENANCE_DIR: '',
      HOME: fallbackHome,
    };

    openClaudeDialog('su-test-owner', 'session-1', 'tool-1', env);

    const scopedReceipt = join(scopedHome, 'turn-provenance', 'su-test-owner.dialog.json');
    const fallbackReceipt = join(fallbackHome, '.papercusp', 'turn-provenance', 'su-test-owner.dialog.json');
    expect(JSON.parse(readFileSync(scopedReceipt, 'utf8'))).toEqual({
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      sources: [],
    });
    expect(existsSync(fallbackReceipt)).toBe(false);
  });

  it('keeps the explicit provenance directory as the highest-priority override', () => {
    root = mkdtempSync(join(tmpdir(), 'dialog-answer-provenance-'));
    const explicitDir = join(root, 'explicit');

    openClaudeDialog('su-test-owner', 'session-2', 'tool-2', {
      PAPERCUSP_HOME: join(root, 'scoped'),
      PAPERCUSP_TURN_PROVENANCE_DIR: explicitDir,
      HOME: join(root, 'fallback'),
    });

    expect(existsSync(join(explicitDir, 'su-test-owner.dialog.json'))).toBe(true);
  });
});
