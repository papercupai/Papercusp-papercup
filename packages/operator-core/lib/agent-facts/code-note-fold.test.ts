/**
 * code-intel-epoch-carry-2026-10-20 P-005 (R-9) — code notes stay out of the
 * general standing-facts fold.
 *
 * Unit tier: drives the REAL foldFactsWithCensus / countLiveFacts with a recording
 * SQL tag, so the predicate the fold actually sends is what is asserted. The
 * real-PG behaviour (including the jsonb anchor filter) is covered in
 * store.integration.test.ts › "code-intel-epoch-carry P-005 code notes".
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_NOTE_KEY_PREFIX, countLiveFacts, foldCodeNotesForPaths, foldFacts, foldFactsWithCensus, foldIncludesCodeNotes,
  isCodeNoteKey, validateCodeNoteAnchor,
} from './store';

type Frag = { strings: readonly string[]; values: unknown[] };

/** A postgres.js-shaped tag that records the rendered statement of every awaited query. */
function recordingSql() {
  const statements: { text: string; params: unknown[] }[] = [];
  const render = (frag: Frag, params: unknown[]): string =>
    frag.strings.reduce((acc, s, i) => {
      if (i === 0) return s;
      const v = frag.values[i - 1];
      if (v && typeof v === 'object' && 'strings' in (v as object)) return acc + render(v as Frag, params) + s;
      params.push(v);
      return `${acc}$${params.length}${s}`;
    }, '');
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Frag & { then?: unknown } = { strings, values };
    frag.then = (resolve: (rows: unknown[]) => void) => {
      const params: unknown[] = [];
      statements.push({ text: render(frag, params), params });
      resolve(/count\(\*\)::text AS n/.test(strings.join('')) ? [{ n: '0' }] : []);
    };
    return frag;
  }) as unknown as Parameters<typeof foldFacts>[2];
  return { sql, statements };
}

const sel = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
const excludesCodeNotes = (s: { text: string; params: unknown[] }) =>
  /key NOT LIKE \$\d+/.test(s.text) && s.params.includes(`${CODE_NOTE_KEY_PREFIX}%`);

describe('R-9: the general fold excludes code notes', () => {
  it('the default fold (coord:orient standing facts) sends the code-note exclusion', async () => {
    const { sql, statements } = recordingSql();
    await foldFactsWithCensus(sel, { workspaceId: 'ws' }, sql);
    expect(statements).toHaveLength(1);
    expect(excludesCodeNotes(statements[0]!)).toBe(true);
  });

  it('the census counts the same population the fold shows', async () => {
    const { sql, statements } = recordingSql();
    await countLiveFacts(sel[0]!, { workspaceId: 'ws' }, sql);
    expect(excludesCodeNotes(statements[0]!)).toBe(true);
  });

  it('a never-drop or dead-end prefix fold still excludes code notes', async () => {
    const { sql, statements } = recordingSql();
    await foldFacts(sel, { workspaceId: 'ws', keyPrefixes: ['dead-end:', 'wall:'] }, sql);
    expect(excludesCodeNotes(statements[0]!)).toBe(true);
  });

  it('explicit reads opt in: includeCodeNotes, or a prefix inside the namespace', async () => {
    for (const opts of [{ includeCodeNotes: true }, { keyPrefixes: ['code-note:'] }, { keyPrefixes: ['code-note:lib/'] }]) {
      const { sql, statements } = recordingSql();
      await foldFacts(sel, { workspaceId: 'ws', ...opts }, sql);
      expect(excludesCodeNotes(statements[0]!), JSON.stringify(opts)).toBe(false);
    }
  });

  it('foldCodeNotesForPaths narrows to the namespace and to file anchors on the paths, in SQL', async () => {
    const { sql, statements } = recordingSql();
    await foldCodeNotesForPaths(sel, ['lib/a.ts', 'lib/a.ts', 'lib/b.ts'], { workspaceId: 'ws' }, sql);
    const s = statements[0]!;
    expect(excludesCodeNotes(s)).toBe(false);
    expect(s.params).toContainEqual(['code-note:%']);
    expect(s.text).toMatch(/jsonb_array_elements\(depends_on\)/);
    expect(s.params).toContainEqual(['file:lib/a.ts', 'file:lib/b.ts']);
    // No paths ⇒ no query at all.
    const empty = recordingSql();
    expect(await foldCodeNotesForPaths(sel, [], { workspaceId: 'ws' }, empty.sql)).toEqual([]);
    expect(empty.statements).toEqual([]);
  });
});

describe('code-note helpers (pure)', () => {
  it('foldIncludesCodeNotes: only an explicit opt-in or a prefix INSIDE the namespace counts', () => {
    expect(foldIncludesCodeNotes([], undefined)).toBe(false);
    expect(foldIncludesCodeNotes(['code-'], undefined)).toBe(false);
    expect(foldIncludesCodeNotes(['code-note:'], undefined)).toBe(true);
    expect(foldIncludesCodeNotes([], true)).toBe(true);
  });

  it('isCodeNoteKey / validateCodeNoteAnchor (R-10)', () => {
    expect(isCodeNoteKey('code-note:x')).toBe(true);
    expect(isCodeNoteKey('code-notes-about-x')).toBe(false);
    expect(validateCodeNoteAnchor('code-note:x', false)).toMatch(/file anchor/);
    expect(validateCodeNoteAnchor('code-note:x', true)).toBeNull();
    expect(validateCodeNoteAnchor('ordinary', false)).toBeNull();
  });
});
