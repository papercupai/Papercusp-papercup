import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPublicManualFaq, PUBLIC_FAQ_ANCHORS } from '../../../../../apps/papercusp-docs/scripts/source-contract.mjs';

const source = resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs');
const canonical = readFileSync(resolve(source, 'faq.mdx'), 'utf8');
let fixture: string;

describe('canonical public FAQ publication contract', () => {
  beforeEach(() => {
    fixture = mkdtempSync(resolve(tmpdir(), 'public-faq-'));
    cpSync(source, fixture, { recursive: true });
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  const check = (text: string) => {
    writeFileSync(resolve(fixture, 'faq.mdx'), text);
    return assertPublicManualFaq(fixture);
  };

  it('keeps twenty canonical question destinations with distinct aliases and real fuller guides', () => {
    const faq = assertPublicManualFaq(source);
    expect(faq.questions).toBeGreaterThanOrEqual(20);
    expect(faq.entries.map((entry) => entry.anchor)).toEqual(expect.arrayContaining(PUBLIC_FAQ_ANCHORS));
    expect(new Set(faq.entries.map((entry) => entry.anchor)).size).toBe(faq.questions);
  });
  it('rejects a removed question and broken existing bookmark', () => {
    expect(() => check(canonical.replace(/## What is Papercusp\?[\s\S]*?(?=## What is Papercup\?)/, '')))
      .toThrow('FAQ needs at least 20 questions');
    expect(() => check(canonical.replace('## What is Papercusp?', '## What is this product?')))
      .toThrow('missing stable FAQ anchor: what-is-papercusp');
  });
  it('rejects duplicate question anchors instead of silently publishing a suffixed replacement', () => {
    expect(() => check(canonical.replace('## What is Papercup?', '## What is Papercusp?')))
      .toThrow('duplicate FAQ anchor: what-is-papercusp');
  });
  it('rejects missing or duplicate alternate phrasings', () => {
    const aliases = 'Also asked as: What does this app do? How do I use Papercusp?';
    expect(() => check(canonical.replace(aliases, ''))).toThrow('two alternate phrasings');
    expect(() => check(canonical.replace(aliases, 'Also asked as: What does this app do? What does this app do?')))
      .toThrow('two alternate phrasings');
  });
  it('rejects a link-only answer', () => {
    expect(() => check(canonical.replace(/Papercusp helps[\s\S]*?(?=\n## What is Papercup\?)/,
      '[Try your first task](/docs/quickstart).\n'))).toThrow('FAQ needs a short answer');
  });
  it('rejects missing, nonexistent, self-referential and private fuller guides', () => {
    expect(() => check(canonical.replace('[Try your first task](/docs/quickstart).', '')))
      .toThrow('FAQ needs a fuller-guide link');
    for (const link of ['/docs/not-a-guide', '/docs/faq', '/docs/../outside']) {
      expect(() => check(canonical.replace('/docs/quickstart', link))).toThrow('broken FAQ fuller-guide link');
    }
    expect(() => check(canonical.replace('/docs/quickstart', '/internal/docs/private-project')))
      .toThrow('private-doc link in FAQ');
  });
  it('accepts an actual guide fragment and rejects a nonexistent destination', () => {
    writeFileSync(resolve(fixture, 'quickstart.mdx'), '---\ntitle: Guide\n---\n## Check your result\n');
    expect(check(canonical.replace('/docs/quickstart', '/docs/quickstart#check-your-result')).questions)
      .toBeGreaterThanOrEqual(20);
    expect(() => check(canonical.replace('/docs/quickstart', '/docs/quickstart#missing')))
      .toThrow('broken FAQ guide anchor');
  });
});
