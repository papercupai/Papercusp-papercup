/**
 * Coverage for agent-bin-detect — absolute-path resolution for
 * claude/codex/omp/pi (WI-39538).
 *
 * Both host probes are mocked: `spawnSync` (the PATH lookup) and
 * `accessSync` (the executable-bit check on each fallback candidate). The
 * fallback list is what this bug was about, so the interesting cases here
 * are the ones where PATH MISSES.
 *
 * ⚠ Do not "simplify" these back to asserting all-null on a PATH miss. The
 * pre-fix test did exactly that, and it passed on a box where an installed
 * codex was being reported as missing — the assertion was true and the
 * behaviour was still wrong, because a PATH miss was the END of the search
 * rather than the start of the fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

const spawnSync = vi.fn();
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...a: unknown[]) => spawnSync(...(a as [])) };
});

const accessSync = vi.fn();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, accessSync: (...a: unknown[]) => accessSync(...(a as [])) };
});

import {
  agentBinaryCandidates,
  detectBinaries,
  resolveAgentBinarySync,
} from './agent-bin-detect';

afterEach(() => {
  spawnSync.mockReset();
  accessSync.mockReset();
});

/** Route `which <bin>` by the bin name. */
function routeWhich(found: Record<string, string>) {
  spawnSync.mockImplementation((_cmd: string, args: string[]) => {
    const bin = args[0];
    const path = found[bin];
    return path ? { status: 0, stdout: `${path}\n` } : { status: 1, stdout: '' };
  });
}

/** Only `executable` paths pass accessSync; everything else throws (as fs does). */
function routeExecutable(executable: string[]) {
  const ok = new Set(executable);
  accessSync.mockImplementation((path: string) => {
    if (!ok.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

describe('resolveAgentBinarySync — PATH', () => {
  it('returns the trimmed absolute path when the binary is on PATH', () => {
    routeWhich({ codex: '/usr/bin/codex' });
    routeExecutable([]);
    expect(resolveAgentBinarySync('codex')).toBe('/usr/bin/codex');
  });

  it('treats exit 0 with empty stdout as not found', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '   ' });
    routeExecutable([]);
    expect(resolveAgentBinarySync('codex')).toBeNull();
  });
});

describe('resolveAgentBinarySync — fallback when PATH misses (the WI-39538 bug)', () => {
  it('finds a binary installed beside the node running this process', () => {
    // The reported box: the operator ran under ~/.local/node25/bin/node and
    // codex was its direct sibling, but that dir was not on the systemd PATH.
    const sibling = agentBinaryCandidates('codex')[0];
    routeWhich({});
    routeExecutable([sibling]);
    expect(resolveAgentBinarySync('codex')).toBe(sibling);
  });

  it('SKIPS a dangling symlink and keeps searching', () => {
    // `~/.papercusp/bin/codex` pointed at a removed linuxbrew path. accessSync
    // follows symlinks, so the corpse throws and must not be returned as a hit.
    const candidates = agentBinaryCandidates('codex');
    const dangling = candidates.find((p) => p.includes('.papercusp'));
    const real = candidates[candidates.length - 1];
    expect(dangling).toBeTruthy();
    routeWhich({});
    routeExecutable([real]); // the dangling one is deliberately NOT executable
    const resolved = resolveAgentBinarySync('codex');
    expect(resolved).toBe(real);
    expect(resolved).not.toBe(dangling);
  });

  it('returns null when the binary is on neither PATH nor any candidate', () => {
    routeWhich({});
    routeExecutable([]);
    expect(resolveAgentBinarySync('codex')).toBeNull();
  });

  it('prefers the process-managed candidate over a distinct stale PATH hit', () => {
    const sibling = agentBinaryCandidates('codex')[0];
    routeWhich({ codex: '/usr/bin/codex' });
    routeExecutable([sibling, '/usr/bin/codex']);
    expect(resolveAgentBinarySync('codex')).toBe(sibling);
  });

  it('keeps PATH ahead of unmanaged fallback candidates when no managed install is executable', () => {
    const unmanagedFallback = agentBinaryCandidates('codex')[3];
    routeWhich({ codex: '/operator/override/codex' });
    routeExecutable(['/operator/override/codex', unmanagedFallback]);
    expect(resolveAgentBinarySync('codex')).toBe('/operator/override/codex');
  });
});

describe('agentBinaryCandidates', () => {
  it('leads with the bin dir of the node running this process', () => {
    // Derived, not pinned — a node upgrade (node25 → node26) must not need an
    // edit here, which is the whole reason this entry is computed.
    expect(agentBinaryCandidates('codex')[0]).toBe(
      join(dirname(process.execPath), 'codex'),
    );
  });

  it('includes the papercusp-managed shim dir', () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    expect(agentBinaryCandidates('codex')).toContain(`${home}/.papercusp/bin/codex`);
  });

  it('offers claude-specific locations only for claude', () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    expect(agentBinaryCandidates('claude')).toContain(`${home}/.claude/bin/claude`);
    expect(agentBinaryCandidates('codex').some((p) => p.includes('/.claude/bin/'))).toBe(false);
  });
});

describe('detectBinaries', () => {
  it('returns absolute paths for found binaries', () => {
    routeWhich({ claude: '/usr/local/bin/claude', codex: '/usr/bin/codex', omp: '/opt/omp' });
    routeExecutable([]);
    expect(detectBinaries()).toEqual({
      claude: '/usr/local/bin/claude',
      codex: '/usr/bin/codex',
      omp: '/opt/omp',
      pi: null,
    });
  });

  it('reports all null only when PATH AND every candidate miss', () => {
    routeWhich({});
    routeExecutable([]);
    expect(detectBinaries()).toEqual({ claude: null, codex: null, omp: null, pi: null });
  });
});
