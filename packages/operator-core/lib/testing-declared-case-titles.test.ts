import { describe, expect, it } from 'vitest';
import { declaredCaseTitles, mayMatchUnresolvedCaseTitle } from './testing-declared-case-titles';

describe('declaredCaseTitles source syntax', () => {
  it.each(['ts', 'mts', 'cts'])('keeps cases after a generic helper in .%s files', (extension) => {
    const source = `
      import { describe, it } from 'vitest';
      const run = async <T>(operation: () => Promise<T>): Promise<T> => operation();
      describe('strict reader', () => {
        it('distinguishes unreadable from absent', async () => {
          await run(async () => true);
        });
      });
    `;
    expect(declaredCaseTitles(`reader.test.${extension}`, source)).toEqual({
      titles: ['strict reader > distinguishes unreadable from absent'],
      unresolvedTitles: [],
    });
  });

  it.each(['tsx', 'jsx'])('keeps cases following JSX in .%s files', (extension) => {
    const source = `
      import { describe, it } from 'vitest';
      const view = <section><span>reader</span></section>;
      describe('reader view', () => { it('renders the failure', () => {}); });
    `;
    expect(declaredCaseTitles(`reader.test.${extension}`, source).titles)
      .toEqual(['reader view > renders the failure']);
  });

  it('retains bounded parameterized title uncertainty after a TypeScript generic', () => {
    const source = `
      const identity = <T>(value: T): T => value;
      describe('actor routing', () => {
        it.each(['system:plan-drain'])('rejects %s', () => {});
        it('keeps the authenticated actor', () => {});
      });
    `;
    const actual = declaredCaseTitles('actor.test.ts', source);
    expect(actual.titles).toEqual(['actor routing > keeps the authenticated actor']);
    expect(mayMatchUnresolvedCaseTitle('rejects system:plan-drain', actual.unresolvedTitles)).toBe(true);
    expect(mayMatchUnresolvedCaseTitle('unrelated case', actual.unresolvedTitles)).toBe(false);
  });
});
