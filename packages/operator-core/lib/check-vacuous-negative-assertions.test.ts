/**
 * Unit tests for `scripts/check-vacuous-negative-assertions.mjs` (EI-18765867705399052).
 *
 * The lint judges a NEGATIVE assertion by asking whether the literal it pins exists
 * anywhere the system could emit it. Every discriminator below was a LIVE false positive
 * on the first sweep of this repo, so each one is pinned here rather than described.
 *
 * The load-bearing case is `flags the motivating instance` — replayed from the real
 * pre-fix commit, the judge flags that assertion and only that assertion. A detector for
 * a class that cannot demonstrate it catches the instance the class was named for is
 * exactly the vacuous guard it exists to prevent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Typed via scripts/check-vacuous-negative-assertions.d.mts — deliberately NOT a
// `@ts-ignore`. Suppressing TS7016 here would silence the whole import, so these tests
// could go on asserting against a judge shape the script no longer has: a test that
// cannot notice its subject changed, which is this file's own subject matter.
// eslint-disable-next-line import/no-relative-packages
import {
  BASELINE_HIGH_WATERMARK,
  baselineKey,
  driftFragment,
  createCorpusIncludes,
  gateExitCode,
  parseBaseline,
  partitionAgainstBaseline,
  extractDocLiterals,
  extractNegativeLiterals,
  judgeDocFile,
  judgeFile,
  looksLikeEmittedOutput,
  proseShaped,
  regexSourceToAlternatives,
  regexSourceToLiteral,
  resolveSubjectFiles,
} from '../../../scripts/check-vacuous-negative-assertions.mjs';

/** A judge bound to a synthetic "source tree". */
const judge = (text: string, corpus: string) =>
  judgeFile({ file: 't.test.ts', text, includes: (s: string) => corpus.includes(s) }).findings;

describe('regexSourceToLiteral — only plain literals are judgeable', () => {
  it('unescapes punctuation escapes into the literal they encode', () => {
    expect(regexSourceToLiteral('a\\.b \\(c\\)')).toBe('a.b (c)');
  });

  it('refuses a pattern with real regex power — a class, a quantifier, alternation', () => {
    // "does this exact string exist" is a meaningless question for these, so they are
    // never judged at all rather than judged wrongly.
    expect(regexSourceToLiteral('EXCLUDED \\d+ commit')).toBeNull();
    expect(regexSourceToLiteral('a|b')).toBeNull();
    expect(regexSourceToLiteral('colou?r')).toBeNull();
    expect(regexSourceToLiteral('[Ww]arn')).toBeNull();
  });
});

describe('extractNegativeLiterals', () => {
  it('reads regex, string and template forms, and skips interpolation', () => {
    const text = [
      `expect(a).not.toMatch(/plain banner text/);`,
      `expect(a).not.toContain('some phrase here');`,
      "expect(a).not.toContain(`a template phrase`);",
      'expect(a).not.toContain(`built ${x} at runtime`);',
    ].join('\n');
    expect(extractNegativeLiterals(text).map((n) => n.lit)).toEqual([
      'plain banner text',
      'some phrase here',
      'a template phrase',
    ]);
  });
});

// WI-6554700010009190. Each synthetic literal below ALSO appears in an expected value, so the
// real lint, which scans this file too, reads it as fixture evidence rather than a dead guard.
describe('Testing Library absence queries and regex alternation', () => {
  it('splits a plain-branch alternation, and refuses real regex power, an empty or an escaped bar', () => {
    expect(regexSourceToAlternatives('Real graded run|92% opus')).toEqual(['Real graded run', '92% opus']);
    expect(regexSourceToAlternatives('plain words')).toBeNull();
    expect(regexSourceToAlternatives('a\\d|b')).toBeNull();
    expect(regexSourceToAlternatives('a||b')).toBeNull();
    expect(regexSourceToAlternatives('a\\|b')).toBeNull();
  });

  it('reads absence queries by copy, and skips case-insensitive and fuzzy matchers', () => {
    const text = [
      `expect(screen.queryByText('the old banner text')).toBeNull();`,
      `expect(within(dialog).queryByLabelText(/old field label/)).not.toBeInTheDocument();`,
      `expect(screen.queryByRole('button', { name: 'Old button label' })).toBeNull();`,
      `expect(screen.queryByText(/case blind banner/i)).toBeNull();`,
      `expect(screen.queryByText('fuzzy banner text', { exact: false })).toBeNull();`,
      `expect(screen.queryByRole('dialog')).toBeNull();`,
    ].join('\n');
    expect(extractNegativeLiterals(text).map((n) => [n.kind, n.lit])).toEqual([
      ["expect(queryByText('…')).toBeNull()", 'the old banner text'],
      ['expect(queryByLabelText(/…/)).not.toBeInTheDocument()', 'old field label'],
      ["expect(queryByRole(…, { name: '…' })).toBeNull()", 'Old button label'],
    ]);
  });

  const negative = `it('x', () => {\n  expect(screen.queryByText(/Old summary claim text|Gone banner one here/)).toBeNull();\n});`; // vacuous-negative-ok: synthetic fixture input
  const lit = 'Old summary claim text|Gone banner one here';

  it('POSITIVE CONTROL: flags an alternation as DRIFTED when every branch is gone and one was reworded', () => {
    const found = judge(negative, 'return <p>New summary claim text</p>;');
    expect(found).toEqual([expect.objectContaining({ lit, verdict: 'DRIFTED', fragment: ' summary claim text' })]);
  });

  it('stays silent while ANY branch is still producible: the guard can fail through it', () => {
    expect(judge(negative, 'return <p>New summary claim text</p>; const b = "Gone banner one here";')).toEqual([]);
  });

  it('reads a getByText presence query as the positive pin that makes a rename a RENAMED ratchet', () => {
    const text = `it('x', () => {\n  expect(screen.getByText('New summary claim text')).toBeTruthy();\n  expect(screen.queryByText('Old summary claim text')).toBeNull();\n});`; // vacuous-negative-ok: synthetic fixture input
    const src = 'return <p>New summary claim text</p>;';
    expect(judge(text, src)).toEqual([expect.objectContaining({ verdict: 'RENAMED' })]);
    expect(judge(text.replace(`expect(screen.getByText('New summary claim text')).toBeTruthy();`, ''), src)).toEqual([
      expect.objectContaining({ lit: 'Old summary claim text', verdict: 'DRIFTED' }),
    ]);
  });
});

describe('driftFragment — grows the match so the residue is honest', () => {
  const inc = (corpus: string) => (s: string) => corpus.includes(s);

  it('returns the MAXIMAL contiguous fragment, not the threshold-length window', () => {
    // Un-grown, the residue would falsely include characters the source does have.
    const r = driftFragment('⚠ quiet-cut EXCLUDED', inc('note += " quiet-cut EXCLUDED now";'));
    expect(r?.fragment).toBe(' quiet-cut EXCLUDED');
    expect(r?.residue).toEqual(['⚠', '']);
  });

  it('is null when nothing substantial of the literal survives in the source', () => {
    expect(driftFragment('a totally removed phrase', inc('unrelated source text'))).toBeNull();
  });
});

describe('createCorpusIncludes — batches corpus substring probes', () => {
  it('preserves exact includes semantics for indexed and fallback probes', () => {
    const includes = createCorpusIncludes('alpha beta gamma', ['alpha', 'delta']);
    expect(includes('alpha')).toBe(true);
    expect(includes('delta')).toBe(false);
    expect(includes('beta gamma')).toBe(true); // a growth probe not in the batch
    expect(includes('')).toBe(true);
  });

  it('falls back to native semantics when there are no indexed probes', () => {
    const includes = createCorpusIncludes('alpha beta gamma', []);
    expect(includes('beta')).toBe(true);
    expect(includes('delta')).toBe(false);
    expect(includes('')).toBe(true);
  });

  it('propagates overlapping suffix matches through failure links', () => {
    const includes = createCorpusIncludes('ushers', ['he', 'she', 'his', 'hers', 'her']);
    expect(includes('he')).toBe(true);
    expect(includes('she')).toBe(true);
    expect(includes('his')).toBe(false);
    expect(includes('hers')).toBe(true);
    expect(includes('her')).toBe(true);
  });
});

describe('proseShaped — what the GATE is narrowed to', () => {
  it('accepts multi-word wording that interpolation cannot produce', () => {
    expect(proseShaped('⚠ quiet-cut EXCLUDED')).toBe(true);
    expect(proseShaped('the old deflecting note')).toBe(true);
  });

  it('rejects values, single tokens and punctuation-heavy shapes', () => {
    expect(proseShaped('SKIP_FROMREPO="${SKIP_FROMREPO:-0}"')).toBe(false); // a value pin
    expect(proseShaped('pc-advconv__viewtabs')).toBe(false); // one token
    expect(proseShaped('(subpath "/p")')).toBe(false); // fixture-composed
    expect(proseShaped('two words')).toBe(false); // too short / too few words
  });
});

describe('judgeFile — the motivating instance', () => {
  // Verbatim from the pre-fix `checkpoint-run.test.ts`, with the source reworded exactly
  // as it was: the banner lost its `⚠` decoration, so the regex could no longer match
  // anything the tool was capable of emitting — and the test still went green.
  const text = [
    `it('no exclusion warning when the quiet-cut judged the tip directly', () => {`,
    `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`,
    `});`,
  ].join('\n');

  it('flags it as DRIFTED and names the wording the source actually has', () => {
    const found = judge(text, 'const note = `quiet-cut EXCLUDED ${n} commit(s) … they get the NEXT run`;');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      line: 2,
      verdict: 'DRIFTED',
      lit: '⚠ quiet-cut EXCLUDED',
      fragment: 'quiet-cut EXCLUDED',
    });
  });

  it('stays silent once the assertion is re-pointed at the current wording', () => {
    const fixed = text.replace('⚠ quiet-cut EXCLUDED', 'quiet-cut EXCLUDED');
    expect(judge(fixed, 'const note = `quiet-cut EXCLUDED ${n} commit(s)`;')).toEqual([]);
  });
});

// WI-10004205 / D-099: the guard is a green-checkpoint leg with a shrink-only baseline.
// These pin the gate DECISION end to end without building the real ~110M-char corpus.
describe('shrink-only baseline — the gate decision', () => {
  const drifted = judge(
    [`it('x', () => {`, `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`, `});`].join('\n'),
    'const note = `quiet-cut EXCLUDED ${n} commit(s)`;',
  );
  const entryFor = (f: { file: string; kind: string; lit: string }) => ({ file: f.file, kind: f.kind, lit: f.lit });

  it('POSITIVE CONTROL: a genuinely drifted assertion with an empty baseline exits 1', () => {
    // The day-one configuration (0 entries). If this ever passes, the leg is decorative.
    expect(drifted).toHaveLength(1);
    expect(drifted[0]!.verdict).toBe('DRIFTED');
    const p = partitionAgainstBaseline({ drifted, baseline: [] });
    expect(p.fresh).toEqual(drifted);
    expect(gateExitCode(p)).toBe(1);
  });

  it('a baselined finding is tolerated, and matching ignores the line number', () => {
    const moved = drifted.map((f) => ({ ...f, line: f.line + 40 }));
    const p = partitionAgainstBaseline({ drifted: moved, baseline: drifted.map(entryFor), watermark: 1 });
    expect(p.fresh).toEqual([]);
    expect(p.baselined).toHaveLength(1);
    expect(gateExitCode(p)).toBe(0);
  });

  it('a different literal in the same file is NEW, not covered by its neighbour', () => {
    const other = drifted.map((f) => ({ ...f, lit: `${f.lit} (reworded)` }));
    const p = partitionAgainstBaseline({ drifted: other, baseline: drifted.map(entryFor), watermark: 1 });
    expect(p.fresh).toHaveLength(1);
    expect(p.stale).toHaveLength(1);
    expect(gateExitCode(p)).toBe(1);
  });

  it('a stale entry (the assertion was fixed) never reds the gate', () => {
    const p = partitionAgainstBaseline({ drifted: [], baseline: drifted.map(entryFor), watermark: 1 });
    expect(p.stale).toHaveLength(1);
    expect(gateExitCode(p)).toBe(0);
  });

  it('a baseline over the watermark reds even with no findings — growth needs the cap raised', () => {
    const p = partitionAgainstBaseline({ drifted: [], baseline: drifted.map(entryFor), watermark: 0 });
    expect(p.overWatermark).toBe(true);
    expect(gateExitCode(p)).toBe(1);
  });

  it('keys on file, kind and literal', () => {
    const base = { file: 'a.test.ts', kind: 'not.toMatch(/…/)', lit: 'some banner' };
    expect(baselineKey(base)).not.toBe(baselineKey({ ...base, file: 'b.test.ts' }));
    expect(baselineKey(base)).not.toBe(baselineKey({ ...base, kind: 'not.toContain' }));
    expect(baselineKey(base)).not.toBe(baselineKey({ ...base, lit: 'other banner' }));
  });
});

describe('parseBaseline', () => {
  it('reads an absent file as the empty (strictest) baseline', () => {
    expect(parseBaseline(null)).toEqual({ ok: true, entries: [] });
  });

  it('refuses malformed text instead of treating it as empty', () => {
    expect(parseBaseline('{').ok).toBe(false);
    expect(parseBaseline('{"entries":{}}').ok).toBe(false);
    expect(parseBaseline('{"entries":[{"file":"a","kind":"k"}]}').ok).toBe(false);
  });

  it('pins the committed baseline: parseable and within the watermark', () => {
    const text = readFileSync(resolve(__dirname, '../../../scripts/vacuous-negative-baseline.json'), 'utf8');
    const parsed = parseBaseline(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.length).toBeLessThanOrEqual(BASELINE_HIGH_WATERMARK);
  });
});

// WI-10004205: of 31 real DRIFTED findings, 21 carried their fragment only in UNRELATED
// code and 0 were real drift. Only the test's subject can prove its emitter was reworded.
describe('judgeFile — locality: drift must be in the SUBJECT to gate', () => {
  const judgeLocal = (text: string, corpus: string, subject: string) =>
    judgeFile({
      file: 't.test.ts',
      text,
      includes: (s: string) => corpus.includes(s),
      subjectIncludes: (s: string) => subject.includes(s),
    }).findings;
  const motivating = [
    `it('no exclusion warning when the quiet-cut judged the tip directly', () => {`,
    `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`,
    `});`,
  ].join('\n');
  const reworded = 'const note = `quiet-cut EXCLUDED ${n} commit(s) … they get the NEXT run`;';

  it('still gates the motivating instance when the reworded banner is in the subject', () => {
    const found = judgeLocal(motivating, reworded, reworded);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ verdict: 'DRIFTED', fragment: 'quiet-cut EXCLUDED' });
  });

  it('reports COINCIDENT, never DRIFTED, when the fragment exists only outside the subject', () => {
    const text = `it('x', () => {\n  expect(page).not.toContain('The GUI is not ready yet');\n});`; // vacuous-negative-ok: synthetic fixture input, not a real assertion (this file's subject resolves empty: the guard drops itself from its corpus)
    const found = judgeLocal(text, 'return <p>Your desktop is not ready yet</p>;', 'export const page = render();');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ verdict: 'COINCIDENT', fragment: ' is not ready yet' });
  });

  it('reports RENAMED when the same file positively pins the new wording, and DRIFTED without it', () => {
    const text = [
      `it('x', () => {`,
      `  expect(sql).toContain("part_kind = 'tool_use'");`,
      `  expect(sql).not.toContain("part_kind = 'tool'");`,
      `});`,
    ].join('\n');
    const src = "sql`WHERE part_kind = 'tool_use'`";
    expect(judgeLocal(text, src, src)).toEqual([
      expect.objectContaining({ verdict: 'RENAMED', fragment: "part_kind = 'tool" }),
    ]);
    // The positive assertion is the whole reason: drop it and the same drift gates.
    const unpinned = text.replace(`  expect(sql).toContain("part_kind = 'tool_use'");\n`, '');
    expect(judgeLocal(unpinned, src, src)).toEqual([expect.objectContaining({ verdict: 'DRIFTED' })]);
  });
});

describe('resolveSubjectFiles — what a test file is ABOUT', () => {
  const corpus = new Set(['lib/foo.ts', 'lib/bar.ts', 'lib/util/index.ts', 'scripts/deploy.sh', 'lib/unrelated.ts', 'pkg/src/thing.ts']);

  it('takes the basename sibling, including one level up from __tests__/', () => {
    expect(resolveSubjectFiles('lib/foo.test.ts', '', corpus)).toEqual(['lib/foo.ts']);
    expect(resolveSubjectFiles('lib/__tests__/foo.integration.test.ts', '', corpus)).toEqual(['lib/foo.ts']);
  });

  it('follows relative specifiers the way TS resolves them (.js → .ts, directory → index)', () => {
    const text = `import { a } from './bar.js';\nimport u from './util';\nvi.mock('../nope/missing');`;
    expect(resolveSubjectFiles('lib/x.test.ts', text, corpus)).toEqual(['lib/bar.ts', 'lib/util/index.ts']);
  });

  it('takes repo paths the test names verbatim, and does NOT follow package imports', () => {
    const text = `const s = readFileSync('scripts/deploy.sh', 'utf8');\nimport { t } from '@scope/pkg/thing';`;
    expect(resolveSubjectFiles('lib/x.test.ts', text, corpus)).toEqual(['scripts/deploy.sh']);
  });

  it('resolves nothing for a test that names no subject (the caller then judges globally)', () => {
    expect(resolveSubjectFiles('lib/lonely.test.ts', `it('x', () => {});`, corpus)).toEqual([]);
  });
});

describe('judgeFile — the false positives that must stay silent', () => {
  const wrap = (assertion: string, extra = '') => `it('x', () => {\n  ${assertion}\n${extra}\n});`;

  it('the literal is in the source — the guard can still fail', () => {
    expect(judge(wrap(`expect(a).not.toContain('the old deflecting note');`), 'x = "the old deflecting note";')).toEqual([]);
  });

  it('the TEST builds the string as a fixture — nothing in the source needs it', () => {
    const text = wrap(
      `expect(out).not.toContain('old state line here');`,
      `  const body = 'old state line here';`,
    );
    expect(judge(text, 'unrelated source')).toEqual([]);
  });

  it('a "no extra suffix" guard over a string the same file asserts POSITIVELY', () => {
    const text = wrap(
      `expect(out).toContain('title → First title (scoper)');`,
      `  expect(out).not.toContain('title → First title (scoper) →');`,
    );
    expect(judge(text, 'unrelated source')).toEqual([]);
  });

  it('a runtime-COMPOSED string: the template is in the source, the value in the test', () => {
    // `--workspace=` + an interpolated value. The residue (`null`) is supplied by the
    // test, which is the signature of composition — and a perfectly falsifiable guard.
    const text = wrap(
      `expect(argv).not.toContain('--workspace=null');`,
      `  const ws = null;`,
    );
    expect(judge(text, 'argv.push(`--workspace=${workspace}`);')).toEqual([]);
  });

  it('a literal shorter than the floor is never judged — absence proves nothing', () => {
    expect(judge(wrap(`expect(a).not.toContain('nope');`), 'unrelated')).toEqual([]);
  });
});

describe('judgeFile — ORPHANED does not gate', () => {
  it('a deliberate "this phrasing is gone for good" ratchet is reported, not failed', () => {
    // Nothing resembling it survives anywhere, so it is a stable historical ratchet
    // rather than a guard pinned to a string that drifted.
    const found = judge(`it('x', () => {\n  expect(p).not.toContain('the old deflecting note');\n});`, 'entirely unrelated source');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ verdict: 'ORPHANED', fragment: null });
  });

  it('a VALUE pin lands in the non-gating bucket even when the source has the template', () => {
    const found = judge(
      `it('x', () => {\n  expect(s).not.toMatch(/PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=9900/);\n});`,
      'export const FLAG = `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=${mb}`;',
    );
    expect(found.map((f) => f.verdict)).toEqual(['ORPHANED']);
  });
});

describe('judgeFile — suppression', () => {
  const corpus = 'const note = `quiet-cut EXCLUDED ${n} commits`;';
  const assertion = `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`;

  it('honours the pragma on the assertion line', () => {
    const text = `it('x', () => {\n${assertion} // vacuous-negative-ok: deliberate\n});`;
    expect(judge(text, corpus)).toEqual([]);
  });

  it('honours the pragma anywhere in the comment block directly above', () => {
    // A real exemption needs a real reason, and a real reason runs to several lines —
    // requiring the token on exactly the preceding line punishes writing one.
    const text = [
      `it('x', () => {`,
      `  // The banner was removed deliberately in WI-1234 and must never return.`,
      `  // vacuous-negative-ok: historical ratchet, the wording is gone for good`,
      assertion,
      `});`,
    ].join('\n');
    expect(judge(text, corpus)).toEqual([]);
  });

  it('does NOT let a pragma leak across a blank line or a statement', () => {
    const text = [
      `it('x', () => {`,
      `  // vacuous-negative-ok: this comment belongs to the line below it`,
      `  const unrelated = 1;`,
      assertion,
      `});`,
    ].join('\n');
    expect(judge(text, corpus)).toHaveLength(1);
  });
});

/**
 * Front-end 2 (EI-18773280958875269): the prompt-doc counterpart of `judgeFile` above,
 * scanning a blueprint prompt's OWN quoted literals against the code corpus instead of
 * a test file's negative assertions. The motivating instance is the same commit history:
 * `release-fixer.md` telling agents to grep for a banner `checkpoint-run.ts` no longer
 * emits.
 */
describe('looksLikeEmittedOutput — narrowed to the banner-marker signal', () => {
  it('accepts a banner-marked phrase regardless of length or digits', () => {
    expect(looksLikeEmittedOutput('⚠ quiet-cut EXCLUDED')).toBe(true);
    expect(looksLikeEmittedOutput('⚠ PREDICTED exclusion: N commit(s) …')).toBe(true);
    expect(looksLikeEmittedOutput('✓ done')).toBe(true);
  });

  it('rejects plain prose and CLI/URL examples with no banner marker', () => {
    // The real false-positive class from the first pass over this repo's prompt corpus:
    // usage-example commands, not quoted emitted output.
    expect(looksLikeEmittedOutput('harness-features list <your-slug>')).toBe(false);
    expect(looksLikeEmittedOutput('curl http://localhost:3070/api/harness')).toBe(false);
    expect(looksLikeEmittedOutput('the old deflecting note')).toBe(false);
  });

  it('rejects anything too short to judge', () => {
    expect(looksLikeEmittedOutput('⚠')).toBe(false);
  });
});

describe('extractDocLiterals', () => {
  it('extracts single-backtick inline-code spans with their line number', () => {
    const text = ['line one', 'has a `quoted span` here', 'and another `one here too`'].join('\n');
    expect(extractDocLiterals(text)).toEqual([
      { line: 2, lit: 'quoted span' },
      { line: 3, lit: 'one here too' },
    ]);
  });

  it('ignores backticks inside a fenced code block', () => {
    const text = ['before', '```', 'const x = `templated`;', '```', 'after `real span`'].join('\n');
    expect(extractDocLiterals(text).map((d) => d.lit)).toEqual(['real span']);
  });
});

describe('judgeDocFile — the motivating instance', () => {
  const docJudge = (text: string, corpus: string) =>
    judgeDocFile({ file: 'release-fixer.md', text, includes: (s: string) => corpus.includes(s) }).findings;

  it('flags a banner the code no longer emits', () => {
    const text = 'Grep the reply for an inline `⚠ quiet-cut EXCLUDED …` warning.';
    const found = docJudge(text, 'const note = `⚠ PREDICTED exclusion: ${n} commit(s) …`;');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, lit: '⚠ quiet-cut EXCLUDED …' });
  });

  it('stays silent once the prompt is re-pointed at the current wording', () => {
    const text = 'surfaced inline as `⚠ PREDICTED exclusion:` when commits are excluded.';
    expect(docJudge(text, 'const note = `⚠ PREDICTED exclusion: ${n} commit(s)`;')).toEqual([]);
  });

  it('trims a trailing "…" before matching — the doc-truncation false positive', () => {
    const text = 'the note reads `⚠ PREDICTION ONLY — probably PESSIMISTIC …` in that case.';
    const corpus = 'note = `⚠ PREDICTION ONLY — probably PESSIMISTIC: ${n} of ${m} commit(s) …`;';
    expect(docJudge(text, corpus)).toEqual([]);
  });

  it('never flags a CLI-usage example (no banner marker)', () => {
    const text = 'Run `harness-features list <your-slug>` to see the queue.';
    expect(docJudge(text, 'completely unrelated code')).toEqual([]);
  });

  it('honours the pragma on the line above', () => {
    const text = [
      '<!-- vacuous-negative-ok: known placeholder mismatch, see EI-18773280958875269 -->',
      'inline as `⚠ totally absent banner …`.',
    ].join('\n');
    expect(docJudge(text, 'unrelated corpus')).toEqual([]);
  });
});
