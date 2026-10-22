/**
 * Guard: every FILE adapter that has a psu isolation home must scan it.
 *
 * A psu-launched agent does NOT write to the client's default home — it gets a
 * per-session isolation dir under ~/.papercusp. The claude adapter has carried its
 * psu root (`~/.papercusp/session-claude/...`) for a while; the omp adapter did not,
 * so EVERY psu-launched OMP (e.g. Gemini) transcript was silently absent from
 * `harness_shared.session_turns` — `session_ingest_state` had zero rows for those
 * paths, and cross-client behaviour work had to hand-parse jsonl off disk
 * (EI-20212281439039808).
 *
 * The failure mode is invisible: nothing errors, the ingest sweep just never opens a
 * file it was never told about. So the invariant is asserted here rather than left to
 * be rediscovered.
 */
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FILE_ADAPTERS } from './session-ingest.js';

const HOME = homedir();

/** A real transcript path each adapter must reach, taken from the live layouts. */
const PSU_LAYOUTS: Record<string, { root: string; sample: string }> = {
  claude: {
    root: join(HOME, '.papercusp', 'session-claude'),
    // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
    sample: join(
      HOME,
      '.papercusp',
      'session-claude',
      'su-00000000-0000-4000-8000-000000000000',
      'projects',
      '-example-workspace-repo',
      '06a44889-ad40-464c-8af2-8e3f02cae7c2.jsonl',
    ),
  },
  omp: {
    root: join(HOME, '.papercusp', 'su-omp-homes'),
    // ~/.papercusp/su-omp-homes/session-<advSessionId>/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
    sample: join(
      HOME,
      '.papercusp',
      'su-omp-homes',
      'session-14830',
      'agent',
      'sessions',
      '-example-workspace-repo',
      '2026-08-11T19-31-28-125Z_019ff24e-f2fd-7000-a2ff-36c02fc83c32.jsonl',
    ),
  },
  codex: {
    root: join(HOME, '.papercusp', 'su-codex-homes'),
    sample: join(
      HOME, '.papercusp', 'su-codex-homes', 'session-14830', 'sessions',
      '2026', '10', '22', 'rollout-2026-10-22T12-13-47-01a16463-d80d-7410-b9e4-102587216c41.jsonl',
    ),
  },
};

describe('session-ingest psu isolation roots', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps live legacy homes discoverable with a workspace-scoped state directory', () => {
    const scopedHome = join(HOME, '.papercusp-workspaces', 'test-workspace', '.papercusp');
    vi.stubEnv('PAPERCUSP_HOME', scopedHome);
    for (const [sourceKind, layout] of Object.entries(PSU_LAYOUTS)) {
      const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind)!;
      const roots = adapter.roots();
      const legacy = roots.find((r) => r.root === layout.root);
      const scoped = roots.find((r) => r.root === join(scopedHome, layout.root.split(sep).at(-1)!));
      expect(legacy, sourceKind).toBeDefined();
      expect(scoped, sourceKind).toBeDefined();
      expect(scoped!.dirDepth).toBe(legacy!.dirDepth);
      expect(new Set(roots.map((r) => r.root)).size).toBe(roots.length);
      if (sourceKind === 'codex') {
        expect(legacy!.descend?.('sessions', 2)).toBe(true);
        expect(legacy!.descend?.('cache', 2)).toBe(false);
        expect(scoped!.descend?.('sessions', 2)).toBe(true);
        expect(scoped!.descend?.('cache', 2)).toBe(false);
      }
    }
  });

  it('scans a managed home once when the state directory is the legacy home', () => {
    vi.stubEnv('PAPERCUSP_HOME', join(HOME, '.papercusp'));
    for (const [sourceKind, layout] of Object.entries(PSU_LAYOUTS)) {
      const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind)!;
      expect(adapter.roots().filter((r) => r.root === layout.root)).toHaveLength(1);
    }
  });

  for (const [sourceKind, layout] of Object.entries(PSU_LAYOUTS)) {
    it(`${sourceKind}: scans its psu isolation home`, () => {
      const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
      expect(adapter, `no FILE adapter for ${sourceKind}`).toBeDefined();

      const spec = adapter!.roots().find((r) => r.root === layout.root);
      expect(
        spec,
        `${sourceKind} adapter does not scan ${layout.root} — every psu-launched ` +
          `${sourceKind} transcript is invisible to sessions:search`,
      ).toBeDefined();

      // dirDepth is EXACT (jsonlAtDepth descends exactly that many levels), so pin it
      // to the real path shape instead of a magic number: a layout change that moves
      // the transcript one level fails here rather than silently indexing nothing.
      const depth = relative(spec!.root, dirname(layout.sample)).split(sep).length;
      expect(spec!.dirDepth).toBe(depth);
    });
  }

  it('CONTROL: the same predicate fails on an adapter missing its psu root', () => {
    // Calibration for the cases above — a guard that has never failed is a guard you
    // have not tested. This is the omp adapter EXACTLY as it was before
    // EI-20212281439039808: default root only. If this control ever passes, the
    // predicate above has stopped being able to detect a missing root.
    const beforeTheFix = [{ root: join(HOME, '.omp', 'agent', 'sessions'), dirDepth: 1 }];
    expect(beforeTheFix.find((r) => r.root === PSU_LAYOUTS.omp.root)).toBeUndefined();
  });

  it('the client default root is still scanned alongside the psu root', () => {
    // The psu root is ADDITIVE — an agent the owner starts by hand still writes to the
    // client's own home, so replacing rather than adding would trade one blind spot
    // for another.
    const defaults: Record<string, string> = {
      claude: join(HOME, '.claude', 'projects'),
      omp: join(HOME, '.omp', 'agent', 'sessions'),
      codex: join(HOME, '.codex', 'sessions'),
    };
    for (const [sourceKind, root] of Object.entries(defaults)) {
      const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
      expect(adapter!.roots().map((r) => r.root)).toContain(root);
    }
  });
});
