import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRegistry,
  readRegistryAsync,
  writeRegistry,
  WorkspaceRegistryUnreadableError,
  activeWorkspaceId,
  resolveConcreteWorkspaceId,
  concreteWorkspaceIdOrNull,
  backgroundWorkspaceIds,
  workspaceById,
  isKnownWorkspace,
  DEFAULT_WORKSPACE_ID,
  setCompanyId,
  companyIdFor,
  workspacesRoot,
  ensureWorkspaceEntry,
  __resetWorkspaceFallbackWarnings,
} from './workspace-registry';
import { runWithWorkspace, runInRequestScope } from './workspace-als';

// Every case in this file must use a private registry. Backing up and restoring
// the live registry with writeFileSync briefly truncated it for other processes.
let registryRoot: string;
let previousRegistryRoot: string | undefined;
beforeEach(() => {
  previousRegistryRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  registryRoot = mkdtempSync(join(tmpdir(), 'workspace-registry-test-'));
  process.env.PAPERCUSP_WORKSPACES_ROOT = registryRoot;
});
afterEach(() => {
  if (previousRegistryRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = previousRegistryRoot;
  rmSync(registryRoot, { recursive: true, force: true });
});

describe('workspace-registry', () => {
  it('keeps registry mutations inside a private test root', () => {
    expect(workspacesRoot()).toBe(registryRoot);
    expect(registryRoot).not.toBe(join(homedir(), '.papercusp-workspaces'));
  });

  it('readRegistry returns the registry shape', () => {
    const reg = readRegistry();
    expect(reg).toHaveProperty('workspaces');
    expect(Array.isArray(reg.workspaces)).toBe(true);
  });

  it('readRegistryAsync keeps a missing registry empty and reads a present registry', async () => {
    await expect(readRegistryAsync()).resolves.toEqual({ workspaces: [] });
    const expected = {
      current: 'ws-async',
      workspaces: [{ id: 'ws-async', name: 'Async workspace', createdAt: 1 }],
    };
    writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify(expected));
    await expect(readRegistryAsync()).resolves.toEqual(expected);
  });

  it('activeWorkspaceId returns a non-empty string', () => {
    const id = activeWorkspaceId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  describe('resolveConcreteWorkspaceId (WI-892 / EI-3409 — never the "*" read sentinel)', () => {
    it('returns the first concrete candidate, in precedence order', () => {
      expect(resolveConcreteWorkspaceId('default')).toBe('default');
      expect(resolveConcreteWorkspaceId('ws-arg', 'ws-ctx')).toBe('ws-arg');
    });

    it('SKIPS the "*" wildcard and empty/blank candidates (the actual bug)', () => {
      // '*' is truthy, so the old `arg ?? ctx ?? … ?? activeWorkspaceId()` let it WIN
      // and persisted it as a workspace_id; here it must be skipped like a non-value.
      expect(resolveConcreteWorkspaceId('*', 'default')).toBe('default');
      expect(resolveConcreteWorkspaceId(undefined, null, '', '   ', 'ws-x')).toBe('ws-x');
      expect(resolveConcreteWorkspaceId('*', '*', 'ws-y')).toBe('ws-y');
    });

    it('falls back to activeWorkspaceId() when no candidate is concrete — and NEVER returns "*"', () => {
      // Pin a concrete request-scope workspace so the fallback is deterministic.
      runWithWorkspace('ws-fallback', () => {
        expect(resolveConcreteWorkspaceId('*', '', null, undefined)).toBe('ws-fallback');
      });
      // Even with no scope pinned, the fallback resolves a CONCRETE id, never the sentinel.
      const out = resolveConcreteWorkspaceId('*');
      expect(out).toBeTruthy();
      expect(out).not.toBe('*');
    });
  });

  describe('concreteWorkspaceIdOrNull (EI-19470389781357111 — the same rule, WITHOUT the fallback)', () => {
    it('agrees with resolveConcreteWorkspaceId whenever a candidate IS concrete', () => {
      // One rule, one author. If these two ever disagree on a concrete input, the
      // predicate has drifted from the resolver it was extracted out of.
      for (const args of [['default'], ['ws-arg', 'ws-ctx'], ['*', 'default'], ['', '  ', 'ws-x']] as const) {
        expect(concreteWorkspaceIdOrNull(...args)).toBe(resolveConcreteWorkspaceId(...args));
      }
    });

    it('returns null where the resolver MANUFACTURES an answer from process state', () => {
      // This pair is the whole point, and it is what makes the difference falsifiable.
      // The resolver's ambient fallback means `!resolveConcreteWorkspaceId(x)` can
      // NEVER be true — a guard written that way is unreachable code that reads
      // exactly like a working one, and the operation it was meant to gate proceeds
      // against a guessed namespace. `concreteWorkspaceIdOrNull` is the form a caller
      // can actually branch on.
      runWithWorkspace('ws-ambient', () => {
        for (const sentinel of ['*', '', '   ', null, undefined] as const) {
          // CONTROL: the resolver answers 'ws-ambient' — truthy, so a `!` guard is dead.
          expect(resolveConcreteWorkspaceId(sentinel)).toBe('ws-ambient');
          expect(concreteWorkspaceIdOrNull(sentinel)).toBeNull();
        }
        expect(concreteWorkspaceIdOrNull('*', '', null, undefined)).toBeNull();
      });
    });

    it('never returns the "*" read sentinel, exactly like the resolver', () => {
      expect(concreteWorkspaceIdOrNull('*', 'ws-y')).toBe('ws-y');
      expect(concreteWorkspaceIdOrNull('*', '*')).toBeNull();
    });
  });

  it('workspaceById returns undefined for unknown id', () => {
    const ws = workspaceById('does-not-exist-' + Date.now());
    expect(ws).toBeUndefined();
  });

  it('isKnownWorkspace: true for the default id + any registered id, false otherwise', () => {
    expect(isKnownWorkspace(DEFAULT_WORKSPACE_ID)).toBe(true);
    const registered = readRegistry().workspaces[0];
    if (registered) expect(isKnownWorkspace(registered.id)).toBe(true);
    expect(isKnownWorkspace('definitely-not-a-workspace-' + Date.now())).toBe(false);
    expect(isKnownWorkspace('')).toBe(false);
  });

  it('isKnownWorkspace: honors the PAPERCUSP_WORKSPACE_ID pin (EI-212 — a pinned process knows its own workspace)', () => {
    const prev = process.env.PAPERCUSP_WORKSPACE_ID;
    try {
      process.env.PAPERCUSP_WORKSPACE_ID = 'pinned-hermetic-ws';
      expect(isKnownWorkspace('pinned-hermetic-ws')).toBe(true);
      expect(isKnownWorkspace('some-other-unregistered-ws')).toBe(false);
      delete process.env.PAPERCUSP_WORKSPACE_ID;
      expect(isKnownWorkspace('pinned-hermetic-ws')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prev;
    }
  });

  it('setCompanyId / companyIdFor round-trip', () => {
    const id = activeWorkspaceId();
    // On a box with no registry (fresh clone / CI runner — WI-123) the
    // active id falls back to 'default', which is unregistered and makes
    // setCompanyId throw "unknown workspace". Register it in this test's
    // private registry so the round-trip is hermetic.
    const registryPath = join(registryRoot, 'registry.json');
    const reg = readRegistry();
    if (!reg.workspaces.some((w) => w.id === id)) {
      writeFileSync(
        registryPath,
        JSON.stringify({ ...reg, workspaces: [...reg.workspaces, { id, name: id, createdAt: Date.now() }] }, null, 2),
      );
    }
    const tag = 'test-co-' + Date.now();
    setCompanyId(id, tag);
    expect(companyIdFor(id)).toBe(tag);
    setCompanyId(id, null);
    expect(companyIdFor(id)).toBeNull();
  });

  it('setCompanyId throws on unknown workspace', () => {
    expect(() => setCompanyId('unknown-workspace-xxx', 'foo')).toThrow(/unknown workspace/);
  });
});

describe('activeWorkspaceId — request-scoped precedence (per-window-workspace-context P-012)', () => {
  const PIN = 'PAPERCUSP_WORKSPACE_ID';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[PIN];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[PIN];
    else process.env[PIN] = prev;
  });

  it('returns the request-scoped workspace inside runWithWorkspace, beating the process pin', () => {
    process.env[PIN] = 'pinned-ws';
    const inside = runWithWorkspace('request-ws', () => activeWorkspaceId());
    expect(inside).toBe('request-ws');
  });

  it('falls back to the PAPERCUSP_WORKSPACE_ID process pin outside any request', () => {
    process.env[PIN] = 'pinned-ws';
    expect(activeWorkspaceId()).toBe('pinned-ws');
  });
});

describe('activeWorkspaceId — P-021 in-request global-fallback diagnostic', () => {
  const PIN = 'PAPERCUSP_WORKSPACE_ID';
  let prevPin: string | undefined;
  beforeEach(() => {
    prevPin = process.env[PIN];
    delete process.env[PIN]; // force the global-fallback branch
    vi.stubEnv('NODE_ENV', 'development'); // enable the dev-only diagnostic
    __resetWorkspaceFallbackWarnings();
  });
  afterEach(() => {
    if (prevPin === undefined) delete process.env[PIN];
    else process.env[PIN] = prevPin;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('warns when activeWorkspaceId falls to the global INSIDE a request scope', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = runInRequestScope(() => activeWorkspaceId());
    expect(id).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('INSIDE a');
  });

  it('does NOT warn outside any request scope (background / CLI)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    activeWorkspaceId();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when the request scope carries a workspace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWithWorkspace('ws-present', () => activeWorkspaceId());
    expect(warn).not.toHaveBeenCalled();
  });

  it('dedupes repeat fall-throughs from the same call site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = () => runInRequestScope(() => activeWorkspaceId());
    call();
    call();
    call();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('activeWorkspaceId — P-525 registry memo (p2p-join-catchup-speed D-013)', () => {
  const ROOT_KEY = 'PAPERCUSP_WORKSPACES_ROOT';
  const PIN_KEY = 'PAPERCUSP_WORKSPACE_ID';
  let prevRoot: string | undefined;
  let prevPin: string | undefined;
  let root: string;
  beforeEach(() => {
    prevRoot = process.env[ROOT_KEY];
    prevPin = process.env[PIN_KEY];
    root = mkdtempSync(join(tmpdir(), 'ws-memo-'));
    process.env[ROOT_KEY] = root;
    delete process.env[PIN_KEY];
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env[ROOT_KEY];
    else process.env[ROOT_KEY] = prevRoot;
    if (prevPin === undefined) delete process.env[PIN_KEY];
    else process.env[PIN_KEY] = prevPin;
    rmSync(root, { recursive: true, force: true });
  });
  const reg = (id: string) => ({ current: id, workspaces: [{ id, name: id, createdAt: 1 }] });

  it('follows every writeRegistry and every in-place write that changes the file', () => {
    writeRegistry(reg('ws-a'));
    expect(activeWorkspaceId()).toBe('ws-a');
    writeRegistry(reg('ws-b'));
    expect(activeWorkspaceId()).toBe('ws-b');
    const p = join(root, 'registry.json');
    writeFileSync(p, JSON.stringify(reg('ws-c'), null, 2));
    utimesSync(p, 2_000_000, 2_000_000); // a distinct mtime, whatever the filesystem granularity
    expect(activeWorkspaceId()).toBe('ws-c');
    rmSync(p);
    expect(activeWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('does not re-read a file whose inode, size and mtime are unchanged', () => {
    writeRegistry(reg('ws-a'));
    const p = join(root, 'registry.json');
    utimesSync(p, 3_000_000, 3_000_000);
    expect(activeWorkspaceId()).toBe('ws-a');
    // Same inode, same size, mtime restored: the memo answers without reading.
    writeFileSync(p, JSON.stringify(reg('ws-z'), null, 2));
    utimesSync(p, 3_000_000, 3_000_000);
    expect(activeWorkspaceId()).toBe('ws-a');
  });
});

describe('workspacesRoot', () => {
  const KEY = 'PAPERCUSP_WORKSPACES_ROOT';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('prefers PAPERCUSP_WORKSPACES_ROOT when set (the desktop-remapped-HOME fix)', () => {
    process.env[KEY] = '/real/home/.papercusp-workspaces';
    expect(workspacesRoot()).toBe('/real/home/.papercusp-workspaces');
  });

  it('falls back to homedir()/.papercusp-workspaces when the env is unset (dev parity)', () => {
    delete process.env[KEY];
    expect(workspacesRoot()).toBe(join(homedir(), '.papercusp-workspaces'));
  });

  it('ignores an empty/whitespace env value', () => {
    process.env[KEY] = '   ';
    expect(workspacesRoot()).toBe(join(homedir(), '.papercusp-workspaces'));
  });
});

describe('ensureWorkspaceEntry — register-before-current (clean-install unknown_workspace / greyed sign-in fix)', () => {
  const KEY = 'PAPERCUSP_WORKSPACES_ROOT';
  let prev: string | undefined;
  let root: string;
  beforeEach(() => {
    prev = process.env[KEY];
    root = mkdtempSync(join(tmpdir(), 'ensure-ws-'));
    process.env[KEY] = root;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it('adds a missing workspace entry (with name) + provisions its dir; makes it isKnownWorkspace', () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ current: 'default', workspaces: [{ id: 'default', name: 'Default', createdAt: 1 }] }));
    expect(isKnownWorkspace('papercusp-workspace')).toBe(false);
    ensureWorkspaceEntry('papercusp-workspace', 'Papercusp');
    const reg = readRegistry();
    const entry = reg.workspaces.find((w) => w.id === 'papercusp-workspace');
    expect(entry).toBeTruthy();
    expect(entry?.name).toBe('Papercusp');
    expect(isKnownWorkspace('papercusp-workspace')).toBe(true);
    expect(existsSync(join(root, 'papercusp-workspace'))).toBe(true);
  });

  it('is idempotent — re-calling does not duplicate the entry', () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ workspaces: [] }));
    ensureWorkspaceEntry('papercusp-workspace', 'Papercusp');
    ensureWorkspaceEntry('papercusp-workspace', 'Papercusp');
    const entries = readRegistry().workspaces.filter((w) => w.id === 'papercusp-workspace');
    expect(entries).toHaveLength(1);
  });

  it('after ensureWorkspaceEntry, setCompanyId no longer throws unknown workspace (the failing git-identity-save path)', () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ current: 'papercusp-workspace', workspaces: [{ id: 'default', name: 'Default', createdAt: 1 }] }));
    // Pre-fix state: current points at an unlisted workspace → setCompanyId throws.
    expect(() => setCompanyId('papercusp-workspace', 'co')).toThrow(/unknown workspace/);
    ensureWorkspaceEntry('papercusp-workspace', 'Papercusp');
    expect(() => setCompanyId('papercusp-workspace', 'co')).not.toThrow();
    expect(companyIdFor('papercusp-workspace')).toBe('co');
  });
});

describe('backgroundWorkspaceIds — which workspaces a background job covers (P-020)', () => {
  // Isolate the registry in a temp root so these cases never touch the real
  // ~/.papercusp-workspaces (workspacesRoot honors PAPERCUSP_WORKSPACES_ROOT).
  const ENV_KEYS = ['PAPERCUSP_WORKSPACES_ROOT', 'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_SHARED_OPERATOR'] as const;
  let saved: Record<string, string | undefined>;
  let root: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    root = mkdtempSync(join(tmpdir(), 'bg-ws-ids-'));
    process.env.PAPERCUSP_WORKSPACES_ROOT = root;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ current: 'ws-a', workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }] }),
    );
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('PAPERCUSP_WORKSPACE_ID pin wins — a dedicated single-workspace process, even under shared-operator', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'pinned-ws';
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(backgroundWorkspaceIds()).toEqual(['pinned-ws']);
  });

  it('shared-operator model, no pin → EVERY registered workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(backgroundWorkspaceIds()).toEqual(['ws-a', 'ws-b', 'ws-c']);
  });

  it('dev / legacy (no shared-operator flag) → just the global active workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    delete process.env.PAPERCUSP_SHARED_OPERATOR;
    expect(backgroundWorkspaceIds()).toEqual(['ws-a']);
  });

  it('shared-operator with an EMPTY registry degrades to the global active workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ workspaces: [] }));
    expect(backgroundWorkspaceIds()).toEqual([DEFAULT_WORKSPACE_ID]);
  });
});

/**
 * WI-6734: a CORRUPT registry must never be reported as an EMPTY one.
 *
 * `activeWorkspaceId()` resolves `reg.current ?? reg.workspaces[0]?.id ??
 * DEFAULT_WORKSPACE_ID`, so "empty" silently scopes every caller to the legacy
 * `'default'` partition — retired by the COORD_PER_WORKSPACE cutover and dead
 * since 2026-07-27. Reads made under that scope return zero rows, which the tool
 * surface renders as an authoritative "does not exist".
 */
describe('workspace-registry — a corrupt registry is not an empty one (WI-6734)', () => {
  const KEY = 'PAPERCUSP_WORKSPACES_ROOT';
  let prev: string | undefined;
  let root: string;

  beforeEach(() => {
    prev = process.env[KEY];
    root = mkdtempSync(join(tmpdir(), 'ws-registry-corrupt-'));
    process.env[KEY] = root;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it('THROWS on an unparseable registry instead of silently returning an empty one', () => {
    writeFileSync(join(root, 'registry.json'), '{"current":"papercusp-workspace","workspa');
    expect(() => readRegistry()).toThrow(WorkspaceRegistryUnreadableError);
  });

  it('keeps the event loop responsive while retrying a corrupt async registry read', async () => {
    writeFileSync(join(root, 'registry.json'), 'not json at all');
    let settled = false;
    const pending = readRegistryAsync();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(pending).rejects.toBeInstanceOf(WorkspaceRegistryUnreadableError);
  });

  it('the throw names the false-NOT-FOUND consequence, so the cause is not re-derived', () => {
    writeFileSync(join(root, 'registry.json'), 'not json at all');
    expect(() => readRegistry()).toThrow(/refusing to report it as EMPTY/);
    expect(() => readRegistry()).toThrow(new RegExp(DEFAULT_WORKSPACE_ID));
  });

  it('a corrupt registry does NOT silently resolve activeWorkspaceId to the retired default partition', () => {
    writeFileSync(join(root, 'registry.json'), '{ truncated');
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    // The pre-fix behaviour returned DEFAULT_WORKSPACE_ID here — a valid-looking
    // id pointing at a dead partition, which is the whole defect.
    expect(() => activeWorkspaceId()).toThrow(WorkspaceRegistryUnreadableError);
  });

  it('a MISSING registry is still legitimately empty (first run) — not an error', () => {
    expect(existsSync(join(root, 'registry.json'))).toBe(false);
    expect(readRegistry()).toEqual({ workspaces: [] });
  });

  // The ENOENT race (registry vanishes between the exists-check and the read) is
  // covered by lib/endpoint-route/__tests__/launch-su.test.ts, which mocks node:fs
  // into exactly that state — it is what caught this branch being wrong. Not
  // duplicated here, because reproducing it needs namespace-wide fs mocking that
  // ESM live bindings make unreliable.

  it('writeRegistry is atomic — a reader never observes a torn file, and leaves no tmp behind', () => {
    const reg = { current: 'papercusp-workspace', workspaces: [{ id: 'papercusp-workspace', name: 'P', createdAt: 1 }] };
    writeRegistry(reg);
    expect(readRegistry()).toEqual(reg);
    // The temp file is renamed, never left as debris beside the registry.
    expect(readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('writeRegistry replaces an existing registry without a truncation window', () => {
    writeRegistry({ current: 'a', workspaces: [{ id: 'a', name: 'A', createdAt: 1 }] });
    writeRegistry({ current: 'b', workspaces: [{ id: 'b', name: 'B', createdAt: 2 }] });
    expect(readRegistry().current).toBe('b');
    expect(readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
describe('workspace-registry — malformed ambient ids never become tenants (EI-21412168682953521)', () => {
  const MALFORMED = [
    '${PAPERCUSP_WORKSPACE}', // unexpanded env template
    '"papercusp-workspace"', // JSON-double-quoted
    '/home/dev/papercusp', // filesystem path
  ];

  it('activeWorkspaceId ignores a malformed PAPERCUSP_WORKSPACE_ID and reads the registry', () => {
    writeRegistry({ current: 'papercusp-workspace', workspaces: [{ id: 'papercusp-workspace', name: 'P', createdAt: 1 }] });
    const saved = process.env.PAPERCUSP_WORKSPACE_ID;
    try {
      for (const bad of MALFORMED) {
        process.env.PAPERCUSP_WORKSPACE_ID = bad;
        expect(activeWorkspaceId()).toBe('papercusp-workspace');
      }
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = saved;
    }
  });

  it('resolveConcreteWorkspaceId skips malformed candidates and returns the next valid one', () => {
    for (const bad of MALFORMED) {
      expect(resolveConcreteWorkspaceId(bad, 'papercusp-workspace')).toBe('papercusp-workspace');
    }
    // All-malformed falls through to activeWorkspaceId() — which, with a clean registry,
    // is the registry default rather than any garbage candidate.
    writeRegistry({ current: 'papercusp-workspace', workspaces: [{ id: 'papercusp-workspace', name: 'P', createdAt: 1 }] });
    const saved = process.env.PAPERCUSP_WORKSPACE_ID;
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    try {
      expect(resolveConcreteWorkspaceId(...MALFORMED)).toBe('papercusp-workspace');
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = saved;
    }
  });

  it('still returns valid slug ids untouched (no false positives)', () => {
    expect(resolveConcreteWorkspaceId('papercusp-workspace')).toBe('papercusp-workspace');
    expect(resolveConcreteWorkspaceId('default')).toBe('default');
  });
});
