import { describe, expect, it } from 'vitest';
import { captureEditedSymbols, changedLineRanges, editedSymbols, observeEditedSymbols } from './edited-symbols';

const BEFORE = [
  "import { x } from './x';",
  '',
  'export function alpha() {',
  '  return 1;',
  '}',
  '',
  'export function beta(n: number) {',
  '  const doubled = n * 2;',
  '  return doubled + x;',
  '}',
  '',
  'export class Service {',
  '  run() {',
  '    return alpha();',
  '  }',
  '  stop() {',
  '    return beta(1);',
  '  }',
  '}',
  '',
  'export function gamma() {',
  '  return 3;',
  '}',
  '',
].join('\n');

const replaceLine = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`fixture line missing: ${from}`);
  return text.replace(from, to);
};

describe('changedLineRanges', () => {
  it('reports nothing for identical text and the exact changed line otherwise', () => {
    expect(changedLineRanges(BEFORE, BEFORE)).toEqual([]);
    expect(changedLineRanges(BEFORE, replaceLine(BEFORE, '  return 1;', '  return 10;')))
      .toEqual([{ start: 3, end: 4 }]);
  });

  it('separates two distant hunks instead of spanning everything between them', () => {
    const after = replaceLine(replaceLine(BEFORE, '  return 1;', '  return 10;'), '  return 3;', '  return 30;');
    expect(changedLineRanges(BEFORE, after)).toEqual([{ start: 3, end: 4 }, { start: 21, end: 22 }]);
  });

  it('represents a pure deletion as a point between its neighbours', () => {
    const after = replaceLine(BEFORE, '  const doubled = n * 2;\n', '');
    expect(changedLineRanges(BEFORE, after)).toEqual([{ start: 7, end: 7 }]);
  });
});

describe('editedSymbols', () => {
  it('names only the function whose body changed in a multi-function file', () => {
    expect(editedSymbols('mod.ts', BEFORE, replaceLine(BEFORE, '  const doubled = n * 2;', '  const doubled = n * 3;')))
      .toEqual(['beta']);
  });

  it('names every symbol a multi-hunk edit touched, including class methods with their class', () => {
    const after = replaceLine(replaceLine(BEFORE, '    return alpha();', '    return alpha() + 1;'),
      '  return 3;', '  return 30;');
    expect(editedSymbols('mod.ts', BEFORE, after)).toEqual(['Service', 'Service.run', 'gamma']);
  });

  it('counts a signature change and an in-body deletion against the enclosing function', () => {
    expect(editedSymbols('mod.ts', BEFORE, replaceLine(BEFORE, 'export function alpha() {', 'export function alpha(): number {')))
      .toEqual(['alpha']);
    expect(editedSymbols('mod.ts', BEFORE, replaceLine(BEFORE, '  const doubled = n * 2;\n', '')))
      .toEqual(['beta']);
  });

  it('measures an edit outside every symbol as an empty list, not unknown', () => {
    expect(editedSymbols('mod.ts', BEFORE, replaceLine(BEFORE, "import { x } from './x';", "import { x, y } from './x';")))
      .toEqual([]);
    // Deleting a whole top-level function is enclosed by nothing that remains.
    const without = replaceLine(BEFORE, 'export function gamma() {\n  return 3;\n}\n', '');
    expect(editedSymbols('mod.ts', BEFORE, without)).toEqual([]);
  });

  it('attributes every symbol of a brand-new file', () => {
    expect(editedSymbols('mod.ts', '', BEFORE)).toEqual(['Service', 'Service.run', 'Service.stop', 'alpha', 'beta', 'gamma']);
  });

  it('returns unknown for a parse failure or a non-TS/JS path', () => {
    expect(editedSymbols('mod.ts', BEFORE, `${BEFORE}\nexport function broken( {`)).toBeNull();
    expect(editedSymbols('README.md', 'a', 'b')).toBeNull();
  });
});

describe('captureEditedSymbols', () => {
  const read = (text: string) => async () => text;
  const after = replaceLine(BEFORE, '  return 1;', '  return 10;');

  it('diffs the file on disk against its committed HEAD blob', async () => {
    await expect(captureEditedSymbols('/repo', 'lib/mod.ts', { readText: read(after), headText: read(BEFORE) }))
      .resolves.toEqual(['alpha']);
  });

  it('treats a path absent from HEAD as new, and git failure or an unreadable file as unknown', async () => {
    await expect(captureEditedSymbols('/repo', 'lib/mod.ts', { readText: read(after), headText: async () => '' }))
      .resolves.toHaveLength(6);
    await expect(captureEditedSymbols('/repo', 'lib/mod.ts', { readText: read(after), headText: async () => null }))
      .resolves.toBeNull();
    await expect(captureEditedSymbols('/repo', 'lib/mod.ts', {
      readText: async () => { throw new Error('ENOENT'); }, headText: read(BEFORE) })).resolves.toBeNull();
  });

  it('distinguishes source, Git and syntax failures without inventing measured empty output', async () => {
    const cases = [
      { readText: async () => { throw new Error('ENOENT'); }, headText: read(BEFORE), reason: 'source-unreadable' },
      { readText: read(after), headText: async () => null, reason: 'head-unavailable' },
      { readText: read(after), headText: async () => { throw new Error('git failed'); }, reason: 'head-unavailable' },
      { readText: read('export function broken( {'), headText: read(BEFORE), reason: 'parse-diagnostics' },
    ];
    for (const { reason, ...deps } of cases) {
      expect(await observeEditedSymbols('/repo', 'mod.ts', deps))
        .toEqual({ version: 1, status: 'unknown', reason, symbols: null });
    }
    expect(await observeEditedSymbols('/repo', 'README.md'))
      .toEqual({ version: 1, status: 'unknown', reason: 'unsupported-path', symbols: null });
    expect(await observeEditedSymbols('/repo', 'mod.ts', { readText: read(BEFORE), headText: read(BEFORE) }))
      .toEqual({ version: 1, status: 'measured', reason: null, symbols: [] });
  });
});
