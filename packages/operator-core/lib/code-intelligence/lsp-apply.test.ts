/**
 * P-013's proof obligation.
 *
 * The plan item ends "Keep production read-only if any invariant is not
 * proven", which makes this file the gate on the `CODE_INTEL_LSP_APPLY` flag
 * defaulting ON rather than a routine test suite. Each of the six invariants
 * gets a test that FAILS if the invariant is removed — the whole point being
 * that a guard which has never failed is a guard nobody has tested.
 *
 * Falsifiability is proven the tier-1 way the repo prescribes for a module you
 * `import` (CLAUDE.md, "Proving a guard is falsifiable"): a deliberately-wrong
 * implementation lives permanently in this file as a CONTROL, alongside a
 * calibration case the real subject must pass. No production file is mutated —
 * a copy-out or in-tree mutation probe would race the git-sync sweep on this
 * shared checkout, which is exactly the hazard the module under test exists to
 * prevent.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyRenameEdit,
  applyTextEdits,
  checkContentCas,
  contentSha,
  isInsideRoot,
  positionToOffset,
  resolveEditTargets,
  type ApplyDeps,
  type ApplyRenameRequest,
  type ApplyResult,
  type EditTarget,
  type LockOutcome,
  type LspTextEdit,
  type RawWorkspaceEdit,
} from './lsp-apply.ts';

const ROOT = '/repo';

/** Identity realpath: the tests that care about symlinks override it. */
const realpathIdentity = (p: string) => p;

function edit(
  sl: number,
  sc: number,
  el: number,
  ec: number,
  newText: string,
): LspTextEdit {
  return { range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, newText };
}

function expectRefusal(r: { ok: boolean }): asserts r is { ok: false } & Record<string, unknown> {
  expect(r.ok).toBe(false);
}

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT 1 — resolve the COMPLETE target set.
// ═══════════════════════════════════════════════════════════════════════════

describe('invariant 1 — complete target set across both WorkspaceEdit encodings', () => {
  it('reads the legacy `changes` encoding', () => {
    const raw: RawWorkspaceEdit = {
      changes: { 'file:///repo/a.ts': [edit(0, 0, 0, 3, 'foo')] },
    };
    const r = resolveEditTargets(raw, ROOT, realpathIdentity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.map((t) => t.relPath)).toEqual(['a.ts']);
  });

  it('reads the modern `documentChanges` encoding', () => {
    const raw: RawWorkspaceEdit = {
      documentChanges: [
        { textDocument: { uri: 'file:///repo/b.ts', version: 1 }, edits: [edit(0, 0, 0, 3, 'foo')] },
      ],
    };
    const r = resolveEditTargets(raw, ROOT, realpathIdentity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.map((t) => t.relPath)).toEqual(['b.ts']);
  });

  /**
   * THE CASE A NAIVE IMPLEMENTATION MISSES, and the reason this invariant is
   * listed first. Reading only `changes` — which is what the READ-ONLY preview
   * in lsp-adapter.ts does, correctly, because it is a report — returns an
   * EMPTY target set for a server that prefers `documentChanges`. For a writer
   * that is not an under-report, it is a silent no-op that reports success.
   */
  it('a changes-only reader would see NOTHING here — the control that keeps this test honest', () => {
    const raw: RawWorkspaceEdit = {
      documentChanges: [
        { textDocument: { uri: 'file:///repo/b.ts' }, edits: [edit(0, 0, 0, 3, 'foo')] },
      ],
    };
    // The deliberately-wrong reader kept as a permanent control.
    const changesOnly = Object.keys(raw.changes ?? {});
    expect(changesOnly).toHaveLength(0);

    const r = resolveEditTargets(raw, ROOT, realpathIdentity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
  });

  it('merges both encodings when a server emits both', () => {
    const raw: RawWorkspaceEdit = {
      changes: { 'file:///repo/a.ts': [edit(0, 0, 0, 1, 'x')] },
      documentChanges: [
        { textDocument: { uri: 'file:///repo/b.ts' }, edits: [edit(0, 0, 0, 1, 'y')] },
      ],
    };
    const r = resolveEditTargets(raw, ROOT, realpathIdentity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.map((t) => t.relPath).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it.each(['create', 'rename', 'delete'])(
    'REFUSES the whole edit when it carries a %s file operation',
    (kind) => {
      const raw: RawWorkspaceEdit = {
        documentChanges: [
          { textDocument: { uri: 'file:///repo/a.ts' }, edits: [edit(0, 0, 0, 1, 'x')] },
          { kind, uri: 'file:///repo/new.ts' },
        ],
      };
      const r = resolveEditTargets(raw, ROOT, realpathIdentity);
      expectRefusal(r);
      expect(r.reason).toBe('unsupported_file_operation');
      // Refusing the WHOLE edit, not applying its text half, is the property.
      expect(r.message).toContain(kind);
    },
  );

  it('refuses a malformed TextEdit rather than skipping it', () => {
    const raw = {
      changes: { 'file:///repo/a.ts': [{ range: { start: { line: 0 } }, newText: 'x' }] },
    } as unknown as RawWorkspaceEdit;
    const r = resolveEditTargets(raw, ROOT, realpathIdentity);
    expectRefusal(r);
    expect(r.reason).toBe('malformed_edit');
  });

  it('refuses an empty edit distinctly from a failed one', () => {
    expectRefusal(resolveEditTargets({}, ROOT, realpathIdentity));
    expect((resolveEditTargets({}, ROOT, realpathIdentity) as { reason: string }).reason).toBe(
      'empty_edit',
    );
    expect((resolveEditTargets(null, ROOT, realpathIdentity) as { reason: string }).reason).toBe(
      'empty_edit',
    );
  });

  it('reports a target that no longer exists as stale, never as absent', () => {
    const raw: RawWorkspaceEdit = { changes: { 'file:///repo/gone.ts': [edit(0, 0, 0, 1, 'x')] } };
    const r = resolveEditTargets(raw, ROOT, (p) => {
      if (p === '/repo/gone.ts') throw new Error('ENOENT');
      return p;
    });
    expectRefusal(r);
    expect(r.reason).toBe('missing_file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT 3 — root confinement, AFTER realpath.
// ═══════════════════════════════════════════════════════════════════════════

describe('invariant 3 — root confinement', () => {
  it('accepts a path inside the root and rejects one outside', () => {
    expect(isInsideRoot('/repo/a.ts', '/repo')).toBe(true);
    expect(isInsideRoot('/repo/deep/nest/a.ts', '/repo')).toBe(true);
    expect(isInsideRoot('/etc/passwd', '/repo')).toBe(false);
    expect(isInsideRoot('/repo/../etc/passwd', '/repo')).toBe(false);
  });

  it('rejects the root itself — a root is not a file', () => {
    expect(isInsideRoot('/repo', '/repo')).toBe(false);
  });

  /**
   * A SIBLING PREFIX is the case a naive `abs.startsWith(root)` accepts.
   * `/repo-evil/x.ts` starts with `/repo`, and is not inside it.
   */
  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    expect('/repo-evil/x.ts'.startsWith('/repo')).toBe(true); // the wrong test passes...
    expect(isInsideRoot('/repo-evil/x.ts', '/repo')).toBe(false); // ...the real one does not.
  });

  it('rejects a symlink that escapes the root, judged on the RESOLVED path', () => {
    const raw: RawWorkspaceEdit = {
      changes: { 'file:///repo/innocent.ts': [edit(0, 0, 0, 1, 'x')] },
    };
    // The unresolved path is squarely inside the root; only realpath reveals it.
    expect(isInsideRoot('/repo/innocent.ts', '/repo')).toBe(true);
    const r = resolveEditTargets(raw, ROOT, (p) =>
      p === '/repo/innocent.ts' ? '/elsewhere/secret.ts' : p,
    );
    expectRefusal(r);
    expect(r.reason).toBe('out_of_root');
    expect(r.paths).toEqual(['/elsewhere/secret.ts']);
  });

  it('rejects a non-absolute path in the WorkspaceEdit', () => {
    const r = resolveEditTargets(
      { changes: { 'relative/path.ts': [edit(0, 0, 0, 1, 'x')] } },
      ROOT,
      realpathIdentity,
    );
    expectRefusal(r);
    expect(r.reason).toBe('out_of_root');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT 5 — canonical application: overlap, bounds, reverse order.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE PERMANENT CONTROL for the reverse-order property.
 *
 * A forward-order applier is the obvious implementation and it is wrong: the
 * first edit changes the string length, so every later edit's offsets — which
 * were computed against the ORIGINAL document — land in the wrong place. Kept
 * here so the reverse-order test cannot silently stop testing anything.
 */
function applyForwardOrder_WRONG(text: string, edits: readonly LspTextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const off = (p: { line: number; character: number }) => starts[p.line] + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => off(a.range.start) - off(b.range.start))) {
    out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
  }
  return out;
}

describe('invariant 5 — canonical application', () => {
  it('applies several edits on one line without offset drift', () => {
    // `aa bb cc` → rename the three tokens to differing lengths.
    const text = 'aa bb cc\n';
    const edits = [edit(0, 0, 0, 2, 'AAAA'), edit(0, 3, 0, 5, 'B'), edit(0, 6, 0, 8, 'CCC')];
    const r = applyTextEdits(text, edits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('AAAA B CCC\n');
    expect(r.applied).toBe(3);
  });

  it('CONTROL: the forward-order applier gets that same case wrong', () => {
    const text = 'aa bb cc\n';
    const edits = [edit(0, 0, 0, 2, 'AAAA'), edit(0, 3, 0, 5, 'B'), edit(0, 6, 0, 8, 'CCC')];
    // If this ever equals the correct answer, the test above has stopped
    // discriminating and the control must be re-derived.
    expect(applyForwardOrder_WRONG(text, edits)).not.toBe('AAAA B CCC\n');
  });

  it('CALIBRATION: on a single edit both implementations agree, so the control is not vacuous', () => {
    const text = 'aa bb\n';
    const edits = [edit(0, 0, 0, 2, 'ZZ')];
    const r = applyTextEdits(text, edits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(applyForwardOrder_WRONG(text, edits));
    expect(r.text).toBe('ZZ bb\n');
  });

  it('applies a multi-line range', () => {
    const r = applyTextEdits('one\ntwo\nthree\n', [edit(0, 1, 2, 2, 'X')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('oXree\n');
  });

  it('refuses overlapping edits instead of picking a winner', () => {
    const r = applyTextEdits('abcdef\n', [edit(0, 0, 0, 4, 'X'), edit(0, 2, 0, 6, 'Y')]);
    expectRefusal(r);
    expect(r.reason).toBe('overlapping_edits');
  });

  it('allows edits that merely touch at a boundary', () => {
    const r = applyTextEdits('abcdef\n', [edit(0, 0, 0, 3, 'X'), edit(0, 3, 0, 6, 'Y')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('XY\n');
  });

  it('applies several pure insertions at one position in array order', () => {
    const r = applyTextEdits('ab\n', [edit(0, 1, 0, 1, 'X'), edit(0, 1, 0, 1, 'Y')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('aXYb\n');
  });

  it('refuses an edit past the end of the file — a staleness signal, not a clamp', () => {
    const r = applyTextEdits('short\n', [edit(9, 0, 9, 3, 'X')]);
    expectRefusal(r);
    expect(r.reason).toBe('edit_out_of_bounds');
  });

  it('refuses an edit past the end of a LINE', () => {
    const r = applyTextEdits('ab\ncd\n', [edit(0, 0, 0, 99, 'X')]);
    expectRefusal(r);
    expect(r.reason).toBe('edit_out_of_bounds');
  });

  it('refuses an inverted range', () => {
    const r = applyTextEdits('abcdef\n', [edit(0, 4, 0, 1, 'X')]);
    expectRefusal(r);
    expect(r.reason).toBe('malformed_edit');
  });

  it('is a no-op for an empty edit list', () => {
    const r = applyTextEdits('abc', []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('abc');
    expect(r.applied).toBe(0);
  });
});

describe('positionToOffset', () => {
  const starts = (t: string) => {
    const s = [0];
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) s.push(i + 1);
    return s;
  };

  it('addresses the end of a line (an append) but not past it', () => {
    const t = 'ab\ncd\n';
    expect(positionToOffset(t, starts(t), { line: 0, character: 2 })).toBe(2);
    expect(positionToOffset(t, starts(t), { line: 0, character: 3 })).toBeNull();
  });

  it('excludes BOTH characters of a CRLF terminator from the line bound', () => {
    const t = 'ab\r\ncd';
    // The line's content is "ab" — 2 chars. Trimming only "\n" would leave a
    // bound of 3 and accept an edit targeting the bare "\r".
    expect(positionToOffset(t, starts(t), { line: 0, character: 2 })).toBe(2);
    expect(positionToOffset(t, starts(t), { line: 0, character: 3 })).toBeNull();
  });

  it('handles the empty final line after a trailing newline', () => {
    const t = 'ab\n';
    expect(positionToOffset(t, starts(t), { line: 1, character: 0 })).toBe(3);
    expect(positionToOffset(t, starts(t), { line: 1, character: 1 })).toBeNull();
  });

  it('handles an empty document', () => {
    expect(positionToOffset('', [0], { line: 0, character: 0 })).toBe(0);
    expect(positionToOffset('', [0], { line: 0, character: 1 })).toBeNull();
    expect(positionToOffset('', [0], { line: 1, character: 0 })).toBeNull();
  });

  it('applies a CRLF file without disturbing its line endings', () => {
    const r = applyTextEdits('aa\r\nbb\r\n', [edit(1, 0, 1, 2, 'ZZ')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('aa\r\nZZ\r\n');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT 4 — the content compare-and-swap.
// ═══════════════════════════════════════════════════════════════════════════

describe('invariant 4 — content compare-and-swap', () => {
  const targets: EditTarget[] = [
    { absPath: '/repo/a.ts', relPath: 'a.ts', edits: [] },
    { absPath: '/repo/b.ts', relPath: 'b.ts', edits: [] },
  ];

  it('passes when nothing moved between planning and locking', () => {
    const m = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'sha-b'],
    ]);
    expect(checkContentCas(targets, m, new Map(m))).toBeNull();
  });

  it('refuses when a file drifted, and names it', () => {
    const planned = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'sha-b'],
    ]);
    const current = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'PEER-WROTE-THIS'],
    ]);
    const r = checkContentCas(targets, planned, current);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('stale_document');
    expect(r!.paths).toEqual(['b.ts']);
  });

  it('treats a missing hash on either side as drift, never as agreement', () => {
    const planned = new Map([['/repo/a.ts', 'sha-a']]);
    const current = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'sha-b'],
    ]);
    expect(checkContentCas(targets, planned, current)!.paths).toEqual(['b.ts']);
  });

  it('honours a caller-supplied `expect` map, by absolute OR relative key', () => {
    const same = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'sha-b'],
    ]);
    expect(checkContentCas(targets, same, new Map(same), new Map([['a.ts', 'sha-a']]))).toBeNull();
    const r = checkContentCas(
      targets,
      same,
      new Map(same),
      new Map([['/repo/b.ts', 'WHAT-THE-CALLER-SAW']]),
    );
    expect(r!.reason).toBe('stale_document');
    expect(r!.paths).toEqual(['b.ts']);
  });

  it('lets a caller vouch for only a subset without failing the rest', () => {
    const same = new Map([
      ['/repo/a.ts', 'sha-a'],
      ['/repo/b.ts', 'sha-b'],
    ]);
    expect(checkContentCas(targets, same, new Map(same), new Map())).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The orchestrator — invariants 2, 4, 6, the flag gate, the diagnostic delta.
// ═══════════════════════════════════════════════════════════════════════════

interface Harness {
  deps: ApplyDeps;
  files: Map<string, string>;
  writes: string[];
}

function harness(over: Partial<ApplyDeps> = {}, seed?: Map<string, string>): Harness {
  const files =
    seed ??
    new Map([
      ['/repo/a.ts', 'const oldName = 1;\n'],
      ['/repo/b.ts', 'use oldName;\n'],
    ]);
  const writes: string[] = [];
  const deps: ApplyDeps = {
    flagsEnabled: async () => ({ ok: true }),
    computeEdit: async () => ({
      ok: true,
      projectRoot: ROOT,
      edit: {
        changes: {
          'file:///repo/a.ts': [edit(0, 6, 0, 13, 'newName')],
          'file:///repo/b.ts': [edit(0, 4, 0, 11, 'newName')],
        },
      },
      completenessProven: true,
      completenessWarning: null,
    }),
    realpath: realpathIdentity,
    readText: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeText: async (p, t) => {
      writes.push(p);
      files.set(p, t);
    },
    withLock: async <T,>(_paths: string[], run: () => Promise<T>): Promise<LockOutcome<T>> => ({
      acquired: true,
      result: await run(),
      coordinated: true,
    }),
    resync: () => true,
    diagnosticCount: async () => 0,
    now: () => 1000,
    ...over,
  };
  return { deps, files, writes };
}

const REQ: ApplyRenameRequest = {
  file: '/repo/a.ts',
  line1: 1,
  character: 6,
  newName: 'newName',
  rootPath: ROOT,
};

function ok(r: ApplyResult): asserts r is Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${r.message}`);
}

describe('applyRenameEdit — the happy path', () => {
  it('writes every target and reports the sites it changed', async () => {
    const h = harness();
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(r.editsApplied).toBe(2);
    expect(h.files.get('/repo/a.ts')).toBe('const newName = 1;\n');
    expect(h.files.get('/repo/b.ts')).toBe('use newName;\n');
  });

  it('returns a post-write hash per file — the next CAS token', async () => {
    const h = harness();
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.contentAfter['a.ts']).toBe(contentSha('const newName = 1;\n'));
  });
});

// WI-2142449: rename-for-application's readiness gate accepts BOTH a
// completeness proof ('certified') and a settle-window heuristic
// ('answerable') — a write can succeed on either. These pin that
// `computeEdit`'s completeness verdict reaches the caller UNCHANGED on a
// completed write, rather than being silently dropped between the adapter and
// `ApplySuccess`.
describe('WI-2142449 — completeness is reported, never silently dropped', () => {
  it('a certified rename reports completenessProven:true and no warning', async () => {
    const h = harness({
      computeEdit: async () => ({
        ok: true,
        projectRoot: ROOT,
        edit: {
          changes: {
            'file:///repo/a.ts': [edit(0, 6, 0, 13, 'newName')],
            'file:///repo/b.ts': [edit(0, 4, 0, 11, 'newName')],
          },
        },
        completenessProven: true,
        completenessWarning: null,
      }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.completenessProven).toBe(true);
    expect(r.completenessWarning).toBeNull();
  });

  it('a settle-window-only rename still writes, but reports completenessProven:false with a warning — the write is NOT refused on this signal alone', async () => {
    const warning = 'call-site completeness is NOT proven for this rename: settle-window heuristic only';
    const h = harness({
      computeEdit: async () => ({
        ok: true,
        projectRoot: ROOT,
        edit: {
          changes: {
            'file:///repo/a.ts': [edit(0, 6, 0, 13, 'newName')],
            'file:///repo/b.ts': [edit(0, 4, 0, 11, 'newName')],
          },
        },
        completenessProven: false,
        completenessWarning: warning,
      }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    // The write still landed — this is TypeScript's normal case, not a fault.
    expect(r.filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(r.completenessProven).toBe(false);
    expect(r.completenessWarning).toBe(warning);
  });
});

describe('the flag gate — CODE_INTEL_LSP_APPLY', () => {
  it('refuses BEFORE computing anything, so a disabled flag spawns no work', async () => {
    const computeEdit = vi.fn();
    const h = harness({
      flagsEnabled: async () => ({ ok: false, message: 'lsp.apply is disabled' }),
      computeEdit: computeEdit as unknown as ApplyDeps['computeEdit'],
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('flag_disabled');
    expect(computeEdit).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe('invariant 2 — atomic, FAIL-CLOSED locking', () => {
  it('locks the COMPLETE target set in ONE acquire, not per file', async () => {
    const seen: string[][] = [];
    const h = harness({
      withLock: async <T,>(paths: string[], run: () => Promise<T>): Promise<LockOutcome<T>> => {
        seen.push(paths);
        return { acquired: true, result: await run(), coordinated: true };
      },
    });
    await applyRenameEdit(REQ, h.deps);
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('REFUSES and writes nothing when the lock authority faults (fail-closed)', async () => {
    const h = harness({
      withLock: async () => ({ acquired: false, lockUnavailable: true, error: 'pg timeout' }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('lock_unavailable');
    expect(h.writes).toEqual([]);
    // The distinction that makes the refusal actionable: nobody is holding
    // anything, so the advice is "retry", not "go coordinate".
    expect(r.message).toContain('unarbitrated');
  });

  it('reports a genuine holder as file_locked, distinctly from an unavailable authority', async () => {
    const h = harness({
      withLock: async () => ({ acquired: false, busy: [{ path: 'a.ts', owner: 'peer' }] }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('file_locked');
    expect(h.writes).toEqual([]);
  });

  it('the body never runs outside the lock — every read and write is inside it', async () => {
    const order: string[] = [];
    const h = harness({
      withLock: async <T,>(_p: string[], run: () => Promise<T>): Promise<LockOutcome<T>> => {
        order.push('lock-acquired');
        const result = await run();
        order.push('lock-released');
        return { acquired: true, result, coordinated: true };
      },
      writeText: async (p) => {
        order.push(`write:${p}`);
      },
    });
    await applyRenameEdit(REQ, h.deps);
    expect(order[0]).toBe('lock-acquired');
    expect(order.at(-1)).toBe('lock-released');
    expect(order.filter((o) => o.startsWith('write:'))).toHaveLength(2);
  });
});

describe('invariant 4 — a peer writing between planning and locking', () => {
  it('refuses, and writes nothing, when a target drifts inside the race window', async () => {
    const files = new Map([
      ['/repo/a.ts', 'const oldName = 1;\n'],
      ['/repo/b.ts', 'use oldName;\n'],
    ]);
    let reads = 0;
    const h = harness(
      {
        readText: async (p) => {
          reads++;
          const v = files.get(p);
          if (v === undefined) throw new Error(`ENOENT ${p}`);
          // Reads 1–2 are the PLAN-time pass (a.ts, b.ts); reads 3–4 are the
          // in-lock pass. The peer must write AFTER planning has observed the
          // file and BEFORE the lock re-reads it — that window is the entire
          // subject of this test. Mutating any earlier just makes the peer's
          // content the planned content, and the CAS correctly sees no drift.
          if (reads === 2) files.set('/repo/b.ts', 'use oldName; // peer touched this\n');
          return v;
        },
      },
      files,
    );
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('stale_document');
    expect(r.paths).toEqual(['b.ts']);
    expect(h.writes).toEqual([]);
    expect(files.get('/repo/a.ts')).toBe('const oldName = 1;\n');
  });

  it('refuses when the caller-supplied preview hash no longer matches', async () => {
    const h = harness();
    const r = await applyRenameEdit(
      { ...REQ, expect: { 'a.ts': contentSha('something the caller saw earlier') } },
      h.deps,
    );
    expectRefusal(r);
    expect(r.reason).toBe('stale_document');
    expect(h.writes).toEqual([]);
  });

  it('proceeds when the caller-supplied hash DOES match — the control for the test above', async () => {
    const h = harness();
    const r = await applyRenameEdit(
      { ...REQ, expect: { 'a.ts': contentSha('const oldName = 1;\n') } },
      h.deps,
    );
    ok(r);
    expect(r.filesChanged).toEqual(['a.ts', 'b.ts']);
  });
});

describe('invariant 5 — nothing is written when any file fails validation', () => {
  it('a bad edit in the LAST file prevents the FIRST file from being written', async () => {
    const h = harness({
      computeEdit: async () => ({
        ok: true,
        projectRoot: ROOT,
        edit: {
          changes: {
            'file:///repo/a.ts': [edit(0, 6, 0, 13, 'newName')],
            // Out of bounds — b.ts has one short line.
            'file:///repo/b.ts': [edit(40, 0, 40, 3, 'newName')],
          },
        },
        completenessProven: true,
        completenessWarning: null,
      }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('edit_out_of_bounds');
    expect(h.writes).toEqual([]);
    expect(h.files.get('/repo/a.ts')).toBe('const oldName = 1;\n');
  });
});

describe('invariant 6 — all-or-nothing across files', () => {
  it('restores already-written files when a later write fails', async () => {
    const files = new Map([
      ['/repo/a.ts', 'const oldName = 1;\n'],
      ['/repo/b.ts', 'use oldName;\n'],
    ]);
    let writeCalls = 0;
    const h = harness(
      {
        writeText: async (p, t) => {
          writeCalls++;
          // Fail on the SECOND target's forward write, but let the restore of
          // the first succeed — the ordinary partial-failure shape.
          if (writeCalls === 2) throw new Error('EROFS');
          files.set(p, t);
        },
      },
      files,
    );
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('apply_failed');
    expect(r.message).toContain('restored');
    // THE PROPERTY: the tree is byte-identical to before the call.
    expect(files.get('/repo/a.ts')).toBe('const oldName = 1;\n');
    expect(files.get('/repo/b.ts')).toBe('use oldName;\n');
  });

  it('says MIXED STATE loudly when a restore also fails', async () => {
    let writeCalls = 0;
    const h = harness({
      writeText: async () => {
        writeCalls++;
        if (writeCalls >= 2) throw new Error('EROFS');
      },
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('apply_failed');
    expect(r.message).toContain('MIXED STATE');
    expect(r.paths).toEqual(['/repo/a.ts']);
  });
});

describe('the diagnostic delta', () => {
  it('reports a measured delta when both sides are available', async () => {
    // Calls ALTERNATE before/after per file (before-a, after-a, before-b,
    // after-b), so a threshold on the call count would encode "file a is clean,
    // file b is broken" rather than "each file gained two diagnostics".
    let call = 0;
    const h = harness({ diagnosticCount: async () => (++call % 2 === 1 ? 1 : 3) });
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.diagnostics.measured).toBe(true);
    expect(r.diagnostics.beforeTotal).toBe(2);
    expect(r.diagnostics.afterTotal).toBe(6);
    expect(r.diagnostics.files.map((f) => f.delta)).toEqual([2, 2]);
  });

  /**
   * The honesty property, and the one this subsystem's plan keeps having to
   * relearn: a delta that could not be measured must never read as a clean one.
   * A failed re-sync means the server still holds the PRE-write text, so its
   * diagnostics would describe a file that no longer exists on disk — and they
   * would look reassuring.
   */
  it('marks the delta UNMEASURED — not clean — when a document cannot be re-synced', async () => {
    const h = harness({ resync: async () => false });
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.diagnostics.measured).toBe(false);
    expect(r.diagnostics.files).toEqual([]);
    expect(r.diagnostics.note).toContain('PRE-write');
    // The write itself still succeeded; a reporting failure never retracts it.
    expect(h.files.get('/repo/a.ts')).toBe('const newName = 1;\n');
  });

  it('marks the delta UNMEASURED when diagnostics are unavailable', async () => {
    const h = harness({ diagnosticCount: async () => null });
    const r = await applyRenameEdit(REQ, h.deps);
    ok(r);
    expect(r.diagnostics.measured).toBe(false);
    expect(r.diagnostics.note).toContain('UNMEASURED');
  });
});

describe('backend failures never become writes', () => {
  it('surfaces a half-loaded-project refusal as backend_error', async () => {
    const h = harness({
      computeEdit: async () => ({ ok: false, error: 'server did not finish loading the project' }),
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('backend_error');
    expect(h.writes).toEqual([]);
  });

  it('never takes a lock for an edit that resolved to nothing', async () => {
    const withLock = vi.fn();
    const h = harness({
      computeEdit: async () => ({
        ok: true,
        projectRoot: ROOT,
        edit: {},
        completenessProven: true,
        completenessWarning: null,
      }),
      withLock: withLock as unknown as ApplyDeps['withLock'],
    });
    const r = await applyRenameEdit(REQ, h.deps);
    expectRefusal(r);
    expect(r.reason).toBe('empty_edit');
    expect(withLock).not.toHaveBeenCalled();
  });
});
