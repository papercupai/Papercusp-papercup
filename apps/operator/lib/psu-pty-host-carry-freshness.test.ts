// @vitest-environment node
import { mkdtempSync, mkdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  carryNativeOwnerInputFreshness,
  readIsolatedNativeTranscriptForward,
} from '../scripts/psu-pty-host.mjs';

const tempDirs: string[] = [];

function transcriptFixture(contents: string) {
  const home = mkdtempSync(join(tmpdir(), 'psu-carry-freshness-'));
  tempDirs.push(home);
  const sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const transcriptPath = join(sessions, 'session.jsonl');
  writeFileSync(transcriptPath, contents);
  return {
    home,
    transcriptPath,
    env: { PAPERCUSP_AGENT: 'codex', CODEX_HOME: home },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('carryNativeOwnerInputFreshness scan evidence', () => {
  it('accepts a complete isolated transcript', () => {
    const fixture = transcriptFixture('{"type":"event_msg","timestamp":"2026-10-14T04:00:00Z"}\n');
    const result = carryNativeOwnerInputFreshness({
      agent: 'codex',
      env: fixture.env,
      transcriptPath: fixture.transcriptPath,
      systemPromptAddendum: 'Carry document built at 2026-10-14T04:30:00Z',
    });

    expect(result).toMatchObject({ status: 'current', snapshotAtMs: Date.parse('2026-10-14T04:30:00Z') });
  });

  it('identifies a missing isolated root and keeps the result fail-closed', () => {
    const fixture = transcriptFixture('{"type":"event_msg"}\n');
    const result = carryNativeOwnerInputFreshness({
      agent: 'codex',
      env: { PAPERCUSP_AGENT: 'codex' },
      transcriptPath: fixture.transcriptPath,
      systemPromptAddendum: 'Carry document built at 2026-10-14T04:30:00Z',
    });

    expect(result).toMatchObject({
      status: 'unverifiable',
      reason: 'native-input-read-incomplete',
      scan: { reason: 'no-isolated-root' },
    });
  });

  it('reports an existing transcript outside the configured isolated root and keeps the result fail-closed', () => {
    const fixture = transcriptFixture('{"type":"event_msg"}\n');
    const configuredHome = mkdtempSync(join(tmpdir(), 'psu-carry-freshness-root-'));
    tempDirs.push(configuredHome);
    const configuredRoot = join(configuredHome, 'sessions');
    mkdirSync(configuredRoot, { recursive: true });
    const result = carryNativeOwnerInputFreshness({
      agent: 'codex',
      env: { ...fixture.env, CODEX_HOME: configuredHome },
      transcriptPath: fixture.transcriptPath,
      systemPromptAddendum: 'Carry document built at 2026-10-14T04:30:00Z',
    });

    expect(result).toMatchObject({
      status: 'unverifiable',
      reason: 'native-input-read-incomplete',
      scan: {
        reason: 'transcript-outside-isolated-root',
        transcriptBinding: {
          sourceTranscriptPath: fixture.transcriptPath,
          configuredIsolatedRoot: configuredRoot,
          status: 'outside',
        },
      },
    });
  });

  it('identifies an unterminated final row instead of treating it as a clean scan', () => {
    const fixture = transcriptFixture('{"type":"event_msg","timestamp":"2026-10-14T04:00:00Z"}');
    const result = carryNativeOwnerInputFreshness({
      agent: 'codex',
      env: fixture.env,
      transcriptPath: fixture.transcriptPath,
      systemPromptAddendum: 'Carry document built at 2026-10-14T04:30:00Z',
    });

    expect(result).toMatchObject({
      status: 'unverifiable',
      reason: 'native-input-read-incomplete',
      scan: { reason: 'unterminated-row' },
    });
  });

  it('completes the snapshot when the filesystem returns short reads', () => {
    const rows = Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: 'event_msg', n: i })).join('\n') + '\n';
    const fixture = transcriptFixture(rows);
    const scan = readIsolatedNativeTranscriptForward({
      agent: 'codex',
      env: fixture.env,
      transcriptPath: fixture.transcriptPath,
      readSyncFn: (fd, buffer, offset, length, position) =>
        readSync(fd, buffer, offset, Math.min(length, 13), position),
    });

    expect(scan).toMatchObject({
      size: Buffer.byteLength(rows),
      nextOffset: Buffer.byteLength(rows),
      scanFailure: null,
    });
    expect(scan?.lines).toHaveLength(100);
  });
});
