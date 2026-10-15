import { describe, it, expect } from 'vitest';
import { prepareForReading, prepareForTTS } from './prepareForTTS';

describe('original-content reading', () => {
  it('preserves source phrases, names, symbols and capitalization instead of shaping a reply', () => {
    const source = 'great question! as an AI, Google uses {name}. 2 < 5; a_b_c * 3.\nLet me know if you need anything else.';
    expect(prepareForReading(source)).toEqual({ text: source, nameUsed: false, modifications: [] });
  });

  it('retains every word and final Unicode tail in long plain text', () => {
    const source = 'A long paragraph. '.repeat(900) + 'FINAL TAIL: 日本語 🐉';
    expect(prepareForReading(source).text).toBe(source);
  });

  it('normalizes line endings without changing whitespace or content', () => {
    expect(prepareForReading('  first\r\nsecond\rlast  ')).toMatchObject({
      text: '  first\nsecond\nlast  ', modifications: ['line-endings'],
    });
  });

  it('normalizes explicit Markdown while retaining link targets and code symbols', () => {
    const source = '# Guide\n**Read** [docs](https://example.test/a) and `a_b_c * 2`.\n```js\nconst {name} = "great question";\n```\nEnd.';
    expect(prepareForReading(source, 'markdown')).toEqual({
      text: 'Guide\nRead docs (https://example.test/a) and a_b_c * 2.\nconst {name} = "great question";\n\nEnd.',
      nameUsed: false, modifications: ['markdown'],
    });
  });

  it('keeps markup literal unless Markdown normalization was requested', () => {
    const source = '# example\n**literal** `x_y_z`';
    expect(prepareForReading(source).text).toBe(source);
  });
});

const NOW = 1_700_000_000_000;
const fixedNow = () => NOW;

function call(input: string, opts: Parameters<typeof prepareForTTS>[1] = {}) {
  return prepareForTTS(input, { now: fixedNow, ...opts });
}

describe('markdown stripping', () => {
  it('strips bold + italic + inline code', () => {
    const r = call('Done **fast**, the _hot_ path is `clean`.');
    expect(r.text).toBe('Done fast, the hot path is clean.');
    expect(r.modifications).toContain('markdown');
  });
  it('strips heading hashes', () => {
    const r = call('# Status\nthings are fine');
    expect(r.text).toContain('Status');
    expect(r.text).not.toContain('#');
  });
  it('strips link syntax keeping text', () => {
    const r = call('Open [the docs](https://x.dev) now');
    expect(r.text).toBe('Open the docs now');
  });
});

describe('length cap by mode', () => {
  const long = 'A'.repeat(150) + '. ' + 'B'.repeat(150) + '. ' + 'C'.repeat(80);
  it('default mode caps at 200', () => {
    const r = call(long, { mode: 'default' });
    expect(r.text!.length).toBeLessThanOrEqual(200);
    expect(r.modifications.some((m) => m.startsWith('length-cap'))).toBe(true);
  });
  it('assertive mode caps at 350', () => {
    const r = call(long, { mode: 'assertive' });
    expect(r.text!.length).toBeLessThanOrEqual(350);
  });
  it('sober mode caps at 350', () => {
    const r = call(long, { mode: 'sober' });
    expect(r.text!.length).toBeLessThanOrEqual(350);
  });
  it('short input under cap is unchanged', () => {
    const r = call('on it.');
    expect(r.text).toBe('On it.');
    expect(r.modifications.some((m) => m.startsWith('length-cap'))).toBe(false);
  });
});

describe('no-op suppression', () => {
  it('empty input returns null', () => {
    const r = call('');
    expect(r.text).toBeNull();
    expect(r.modifications).toContain('noop');
  });
  it('whitespace-only returns null', () => {
    const r = call('   \n  ');
    expect(r.text).toBeNull();
  });
  it('preamble-only after stripping returns null', () => {
    const r = call('Great question!');
    expect(r.text).toBeNull();
  });
});

describe('banned preambles', () => {
  it.each([
    ['Great question! 3 features in progress.', '3 features in progress.'],
    ["I'd be happy to help! On it.", 'On it.'],
    ['As an AI assistant, I cannot do that. Will skip.', 'Will skip.'],
    ['Done. Let me know if there is anything else!', 'Done.'],
    ['This reminds me of a thing. Use the cli.', 'A thing. Use the cli.'],
    ['Speaking of which, the test failed.', 'The test failed.'],
    ['Fun story! That worked.', 'That worked.'],
  ])('strips %j', (input, expected) => {
    const r = call(input);
    expect(r.text).toBe(expected);
    expect(r.modifications).toContain('preamble');
  });
  it('strips moralizing tail', () => {
    const r = call('Migrated 200 features at once. And the lesson there is to go small.');
    expect(r.text).toBe('Migrated 200 features at once.');
  });
});

describe('{name} token + budget', () => {
  it('strips {name} when name unset', () => {
    const r = call('Heads up, {name} — replan.', { mode: 'apologetic' });
    expect(r.text).not.toContain('{name}');
    expect(r.text).toMatch(/heads up/i);
    expect(r.nameUsed).toBe(false);
  });
  it('strips {name} within 5-min budget window', () => {
    const r = call('Heads up, {name} — replan.', {
      mode: 'apologetic',
      name: 'Dev',
      lastNameUseAt: NOW - 60_000,
    });
    expect(r.text).not.toContain('Dev');
    expect(r.nameUsed).toBe(false);
  });
  it('substitutes outside budget window in apologetic mode', () => {
    // Force the rate roll: apologetic = 0.8, run 30 trials
    const samples = Array.from({ length: 30 }, () =>
      call('Heads up, {name} — replan.', {
        mode: 'apologetic',
        name: 'Dev',
        lastNameUseAt: NOW - 10 * 60_000,
      }),
    );
    const used = samples.filter((s) => s.nameUsed).length;
    expect(used).toBeGreaterThan(15);
    expect(used).toBeLessThanOrEqual(30);
  });
  it('routine mode never substitutes (rate=0)', () => {
    const samples = Array.from({ length: 50 }, () =>
      call('Heads up, {name} — done.', {
        mode: 'default',
        name: 'Dev',
        lastNameUseAt: NOW - 10 * 60_000,
      }),
    );
    expect(samples.every((s) => !s.nameUsed)).toBe(true);
    expect(samples.every((s) => !s.text!.includes('Dev'))).toBe(true);
  });
  it('refuses substitution when {name} is first', () => {
    const r = call('{name}, replan now.', {
      mode: 'apologetic',
      name: 'Dev',
      lastNameUseAt: NOW - 10 * 60_000,
    });
    expect(r.nameUsed).toBe(false);
    expect(r.text).not.toContain('Dev');
  });
  it('refuses substitution when {name} is last', () => {
    // Even with 100% rate, last-position should strip.
    const samples = Array.from({ length: 20 }, () =>
      call('That was wrong, {name}.', {
        mode: 'apologetic',
        name: 'Dev',
        lastNameUseAt: NOW - 10 * 60_000,
      }),
    );
    expect(samples.every((s) => !s.nameUsed)).toBe(true);
  });
});

describe('company denylist (telemetry)', () => {
  it('flags real company names without rewriting', () => {
    const r = call('Saw this at Google once. Be careful.');
    expect(r.modifications.some((m) => m.startsWith('company:'))).toBe(true);
    expect(r.text).toContain('Google');
  });
  it("doesn't flag generic phrases", () => {
    const r = call('At the last place I worked, this exact thing happened.');
    expect(r.modifications.some((m) => m.startsWith('company:'))).toBe(false);
  });
});

describe('integration', () => {
  it('strips markdown + preamble + caps length in one pass', () => {
    const r = call(
      'Great question! **Sheets** is at `28/88`. ' + 'A'.repeat(300),
      { mode: 'default' },
    );
    expect(r.text!.length).toBeLessThanOrEqual(200);
    expect(r.text).not.toContain('**');
    expect(r.text).not.toContain('`');
    expect(r.text).not.toMatch(/great question/i);
  });
});
