import { describe, expect, it } from 'vitest';
import { summarizeDocsLexicalTiming } from './search-timing';

describe('summarizeDocsLexicalTiming', () => {
  it('preserves active inner phase details while the lexical search is still running', () => {
    expect(summarizeDocsLexicalTiming({
      version: 1,
      totalElapsedMs: 19_999,
      outcome: 'running',
      completedMs: { listPages: 10 },
      active: { phase: 'getContent', elapsedMs: 19_989 },
      pages: { listed: 37, searchable: 33, loaded: 12 },
    })).toBe(
      'docsLexicalTiming total=19999ms outcome=running phases=listPages=10ms active=getContent:19989ms pages=37/33/12',
    );
  });

  it('summarizes completed phases and the final page counts', () => {
    expect(summarizeDocsLexicalTiming({
      totalElapsedMs: 20_000,
      outcome: 'complete',
      completedMs: { listPages: 10, getContent: 19_900, ranking: 90 },
      active: null,
      pages: { listed: 37, searchable: 33, loaded: 33 },
    })).toBe(
      'docsLexicalTiming total=20000ms outcome=complete phases=listPages=10ms,getContent=19900ms,ranking=90ms pages=37/33/33',
    );
  });

  it('omits unknown engine phases and query-like fields', () => {
    expect(summarizeDocsLexicalTiming({
      query: 'must not be logged',
      totalElapsedMs: 12.4,
      outcome: 'running',
      active: { phase: 'unregistered-phase', elapsedMs: 9 },
      pages: { listed: 4, searchable: 4, loaded: 2 },
    })).toBe('docsLexicalTiming total=12ms outcome=running pages=4/4/2');
  });

  it('returns undefined when no recognized measurements are present', () => {
    expect(summarizeDocsLexicalTiming({ query: 'private' })).toBeUndefined();
  });

  it('whitelists safe list-page phase details and omits unrecognized fields', () => {
    expect(summarizeDocsLexicalTiming({
      listPagesPhases: [
        { component: 'starlight', phase: 'walk', state: 'completed', elapsedMs: 3.6, count: 600.8 },
        { component: 'canonical-overlay', phase: 'canonical-read', state: 'shared', docId: 'private' },
        { component: 'unknown', phase: 'query', state: 'completed', elapsedMs: 20 },
      ],
    })).toBe('docsLexicalTiming listParts=starlight.walk:completed:4ms:count=600,canonical-overlay.canonical-read:shared');
  });
});
