import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAdjudication, type AdjudicationVerdict, type AnswerKey, type FairCase } from './fair-comparison';
import { AUTO_ADJUDICATED_INTENTS, autoAdjudicatePending, createAdjudicator, declarationSiblings, parseSiteKey, type Adjudicator } from './fair-comparison-adjudicate';
import { materializeMicroRepo } from './fair-comparison-arms';
import { openTsTree, type TsTree } from './fair-comparison-first-party';
import { MICRO_CASES, microRepoKeys } from './fair-comparison-micro-repo';

const emptyKey = (caseId: string): AnswerKey => ({ caseId, sites: [], aliases: {}, rejected: [], neutral: [] });

describe('site keys and declaration siblings', () => {
  it('parses path:line and refuses malformed keys', () => {
    expect(parseSiteKey('a/b.ts:12')).toEqual({ path: 'a/b.ts', line1: 12 });
    expect(parseSiteKey('a/b.ts:?')).toBeNull();
    expect(parseSiteKey('a/b.ts:0')).toBeNull();
    expect(parseSiteKey('nocolon')).toBeNull();
  });
  it('maps a JS file to the declaration file TypeScript resolves it to, and back', () => {
    expect(declarationSiblings('s/x.mjs')).toEqual(['s/x.d.mts']);
    expect(declarationSiblings('s/x.d.mts')).toEqual(['s/x.mjs']);
    expect(declarationSiblings('s/x.js')).toEqual(['s/x.d.ts']);
    expect(declarationSiblings('s/x.ts')).toEqual([]);
  });
});

/**
 * Calibration: the micro repo's keys are complete and human-verified (derived from in-source
 * markers). Starting from an EMPTY key, the adjudicator must reproduce every ruling those keys
 * make for the intents it rules on. A mismatch means its rule diverges from D-012, so the
 * verdicts it proposes on the real corpus could not be trusted.
 */
describe('adjudicator reproduces the human-verified micro-repo keys', () => {
  let dir = '';
  let tree: TsTree;
  let adj: Adjudicator;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fair-adj-'));
    await materializeMicroRepo(dir);
    tree = openTsTree(ts, dir);
    adj = createAdjudicator(tree);
  });
  afterAll(async () => {
    tree?.service.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const keys = new Map(microRepoKeys().map((k) => [k.caseId, k]));
  const ruled = MICRO_CASES.filter((c) => AUTO_ADJUDICATED_INTENTS.includes(c.intent));

  it('covers every auto-adjudicated intent', () => {
    expect(new Set(ruled.map((c) => c.intent))).toEqual(new Set(AUTO_ADJUDICATED_INTENTS));
  });

  it.each(ruled.map((c) => [c.id, c] as const))('%s', (_id, kase: FairCase) => {
    const key = keys.get(kase.id)!;
    const expected = new Map<string, { verdict: string; aliasOf?: string }>();
    for (const s of key.sites) expected.set(s, { verdict: 'valid' });
    for (const [s, to] of Object.entries(key.aliases)) expected.set(s, { verdict: 'alias', aliasOf: to });
    for (const s of key.neutral) expected.set(s, { verdict: 'neutral' });
    for (const s of key.rejected) expected.set(s, { verdict: 'invalid' });
    const rulings = adj.adjudicate(kase, [...expected.keys()], emptyKey(kase.id));
    const got = new Map<string, { verdict: string; aliasOf?: string }>();
    for (const r of rulings) for (const v of r.verdicts) if (!got.has(v.site)) got.set(v.site, { verdict: v.verdict, ...(v.aliasOf ? { aliasOf: v.aliasOf } : {}) });
    const undecided = rulings.filter((r) => r.verdicts.length === 0).map((r) => `${r.site}: ${r.undecided}`);
    expect(undecided).toEqual([]);
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected));
    // The proposed verdicts fold into a key without a conflict or a dangling alias.
    expect(() => applyAdjudication(emptyKey(kase.id), rulings.flatMap((r) => r.verdicts))).not.toThrow();
  });

  it('rejects a site that is a real line of the repo but not part of the unit', () => {
    const kase = ruled.find((c) => c.intent === 'callers' && c.tags.length === 0)!;
    const key = keys.get(kase.id)!;
    const anyValid = parseSiteKey(key.sites[0]!)!;
    // The first line of the file holding a valid caller is an import or a comment, never a call.
    const probe = `${anyValid.path}:1`;
    if (key.sites.includes(probe) || probe in key.aliases) return;
    const [r] = adj.adjudicate(kase, [probe], emptyKey(kase.id));
    expect(r!.verdicts.map((v) => v.verdict)).toEqual(['invalid']);
  });

  it('leaves hand-adjudicated intents undecided instead of guessing', () => {
    const kase = MICRO_CASES.find((c) => c.intent === 'impact')!;
    const [r] = adj.adjudicate(kase, ['anything.ts:1'], emptyKey(kase.id));
    expect(r!.verdicts).toEqual([]);
    expect(r!.undecided).toMatch(/hand-adjudicated/);
  });

  it('aliases to a canonical site the key already holds rather than minting a second one', () => {
    const kase = ruled.find((c) => c.intent === 'callers' && Object.keys(keys.get(c.id)!.aliases).length > 0);
    if (!kase) return;
    const key = keys.get(kase.id)!;
    const [aliasSite, canonical] = Object.entries(key.aliases)[0]!;
    const seeded: AnswerKey = { ...emptyKey(kase.id), sites: [canonical] };
    const [r] = adj.adjudicate(kase, [aliasSite], seeded);
    expect(r!.verdicts).toEqual([expect.objectContaining({ site: aliasSite, verdict: 'alias', aliasOf: canonical })]);
  });
});

describe('autoAdjudicatePending merges into recorded verdicts site by site', () => {
  const kase = MICRO_CASES[0]!;
  const human: AdjudicationVerdict = { site: 'b.ts:2', verdict: 'invalid', note: 'human' };
  let keySeen: AnswerKey | null = null;
  const stub: Adjudicator = {
    adjudicate: (_k, sites, key) => {
      keySeen = key;
      return sites.map((site) =>
        site === 'c.ts:3'
          ? { site, verdicts: [{ site, verdict: 'valid', note: 'auto' }] }
          : site === 'd.ts:4'
            ? // Aliases to a site a human already ruled invalid: must be refused for this site only.
              { site, verdicts: [{ site, verdict: 'alias', aliasOf: 'b.ts:2', note: 'auto' }, { site: 'b.ts:2', verdict: 'valid', note: 'auto' }] }
            : { site, verdicts: [], undecided: 'hand-adjudicated intent' },
      );
    },
  };
  const existing = { [kase.id]: [human] };
  const pending = [{ caseId: kase.id, sites: ['c.ts:3', 'd.ts:4', 'e.ts:5'], namedBy: { 'c.ts:3': ['rg'], 'd.ts:4': ['gitnexus'], 'e.ts:5': ['rg', 'trace-mcp'] } }];
  const result = autoAdjudicatePending(stub, [kase], [{ ...emptyKey(kase.id), sites: ['a.ts:1'] }], pending, existing);

  it('hands the adjudicator a key that already carries the recorded verdicts', () => {
    expect(keySeen!.rejected).toContain('b.ts:2');
    expect(keySeen!.sites).toContain('a.ts:1');
  });

  it('keeps every recorded verdict and adds only the accepted auto verdicts', () => {
    expect(result.verdicts[kase.id]).toEqual([human, { site: 'c.ts:3', verdict: 'valid', note: 'auto' }]);
    expect(result.accepted).toBe(1);
    expect(existing[kase.id]).toEqual([human]);
  });

  it('refuses a conflicting ruling for that site alone and leaves it, with the undecided ones, for hand review', () => {
    expect(result.undecided).toEqual([
      { caseId: kase.id, site: 'd.ts:4', reason: expect.stringMatching(/^refused: adjudication conflict .* already invalid, now valid/), namedBy: ['gitnexus'] },
      { caseId: kase.id, site: 'e.ts:5', reason: 'hand-adjudicated intent', namedBy: ['rg', 'trace-mcp'] },
    ]);
  });

  it('lists a pending case the corpus does not know as undecided rather than dropping it', () => {
    const r = autoAdjudicatePending(stub, [kase], [emptyKey(kase.id)], [{ caseId: 'nope', sites: ['x.ts:1'], namedBy: {} }], {});
    expect(r.undecided).toEqual([{ caseId: 'nope', site: 'x.ts:1', reason: 'case or seed key not in the corpus', namedBy: [] }]);
    expect(r.accepted).toBe(0);
  });
});
