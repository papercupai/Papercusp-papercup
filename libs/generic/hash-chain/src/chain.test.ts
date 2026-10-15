import { describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH,
  appendLinks,
  canonicalJson,
  CanonicalJsonError,
  entryDigest,
  exportChain,
  linkHash,
  parseChainExport,
  runVerifyCli,
  verifyChain,
  verifyChainExport,
  type ChainRecord,
} from './index';

const STREAM = 'commerce.ledger';
const ENTRIES = [
  { id: 'evt-1', kind: 'order.paid', amountMinor: 1200, currency: 'USD' },
  { id: 'evt-2', kind: 'refund.succeeded', amountMinor: 200, currency: 'USD' },
  { id: 'evt-3', kind: 'payout.paid', amountMinor: 900, currency: 'USD', meta: { batch: 'b1', note: null } },
  { id: 'evt-4', kind: 'order.paid', amountMinor: 50, currency: 'EUR' },
];

function build(entries: readonly unknown[] = ENTRIES): ChainRecord[] {
  const links = appendLinks(STREAM, null, entries.map((e) => entryDigest(e)));
  return links.map((link, i) => ({ link, entry: entries[i] }));
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x'], c: undefined, b: true } })).toBe('{"a":{"b":true,"d":[1,"x"]},"b":1}');
  });
  it('refuses values JSON cannot round-trip', () => {
    for (const bad of [Number.NaN, Infinity, 1n, () => 1, [undefined], new Date(0), Symbol('s')]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });
});

describe('verifyChain startAfter (segment verification)', () => {
  // A batch appended after an already-delivered head verifies on its own, and still catches
  // every break the full-chain verifier does at the segment boundary.
  const full = build();
  const head = full[1]!.link;
  const segment = full.slice(2);

  it('accepts a segment continuing after the given head', () => {
    const verdict = verifyChain(STREAM, segment, { requireEntries: true, startAfter: head });
    expect(verdict).toMatchObject({ ok: true, length: 2, head: full[3]!.link });
  });

  it('matches appendLinks continued from the same head', () => {
    const continued = appendLinks(STREAM, head, ENTRIES.slice(2).map((e) => entryDigest(e)));
    expect(continued).toEqual(segment.map((r) => r.link));
  });

  it('refuses the segment without startAfter (it is not rooted at genesis)', () => {
    const verdict = verifyChain(STREAM, segment);
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('seq-gap');
  });

  it('refuses a segment whose first link does not chain from the head', () => {
    const forkHead = { seq: head.seq, entryHash: 'f'.repeat(64) };
    const verdict = verifyChain(STREAM, segment, { startAfter: forkHead });
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('prev-mismatch');
  });

  it('refuses a segment with a dropped first record (seq gap after the head)', () => {
    const verdict = verifyChain(STREAM, segment.slice(1), { startAfter: head });
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('seq-gap');
  });

  it('refuses a malformed startAfter instead of verifying against it', () => {
    const verdict = verifyChain(STREAM, segment, { startAfter: { seq: -1, entryHash: 'x' } });
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('malformed');
  });

  it('accepts an EMPTY segment whose expected head is the start head (nothing new to deliver)', () => {
    const verdict = verifyChain(STREAM, [], { startAfter: head, expectedHead: head });
    expect(verdict).toMatchObject({ ok: true, length: 0 });
  });

  it('refuses an empty segment claiming a head beyond its start (a dropped batch)', () => {
    const verdict = verifyChain(STREAM, [], { startAfter: head, expectedHead: full[3]!.link });
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('head-mismatch');
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain and reports its head', () => {
    const records = build();
    const verdict = verifyChain(STREAM, records, { requireEntries: true });
    expect(verdict).toMatchObject({ ok: true, length: 4, head: records[3]!.link });
    expect(records[0]!.link.prevHash).toBe(GENESIS_PREV_HASH);
    expect(records[2]!.link.prevHash).toBe(records[1]!.link.entryHash);
  });

  it('accepts the empty chain, and refuses it against a published head', () => {
    expect(verifyChain(STREAM, [])).toMatchObject({ ok: true, length: 0, head: null });
    const bad = verifyChain(STREAM, [], { expectedHead: { seq: 0, entryHash: 'a'.repeat(64) } });
    expect(bad.ok === false && bad.firstBreak.reason).toBe('head-mismatch');
  });

  it('detects an edited entry at its own position', () => {
    const records = build();
    records[2] = { ...records[2]!, entry: { ...ENTRIES[2]!, amountMinor: 9000 } };
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.firstBreak).toMatchObject({ index: 2, seq: 2, reason: 'entry-mismatch' });
      expect(verdict.verifiedThrough).toEqual(records[1]!.link);
      expect(verdict.length).toBe(2);
    }
  });

  it('detects a deleted entry (link survives, entry gone)', () => {
    const records = build();
    records[1] = { link: records[1]!.link, entryMissing: true };
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 1, reason: 'entry-missing' });
  });

  it('detects a deleted record (entry and link both removed)', () => {
    const records = build();
    records.splice(1, 1);
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 1, seq: 2, reason: 'seq-gap' });
  });

  it('detects a reorder', () => {
    const records = build();
    [records[1], records[2]] = [records[2]!, records[1]!];
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 1, reason: 'seq-gap' });
  });

  it('detects an edited link field', () => {
    const records = build();
    records[3] = { ...records[3]!, link: { ...records[3]!.link, entryDigest: entryDigest({ forged: true }) } };
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 3, reason: 'link-hash-mismatch' });
  });

  it('detects a forger who rewrites an entry AND re-hashes its link, at the next link', () => {
    const records = build();
    const forgedEntry = { ...ENTRIES[1]!, amountMinor: 1 };
    const forgedDigest = entryDigest(forgedEntry);
    const old = records[1]!.link;
    const forgedLink = { ...old, entryDigest: forgedDigest, entryHash: linkHash({ ...old, entryDigest: forgedDigest }) };
    records[1] = { link: forgedLink, entry: forgedEntry };
    const verdict = verifyChain(STREAM, records);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 2, reason: 'prev-mismatch' });
  });

  it('detects tail truncation only against an independently published head', () => {
    const records = build();
    const publishedHead = { seq: records[3]!.link.seq, entryHash: records[3]!.link.entryHash };
    const truncated = records.slice(0, 2);
    expect(verifyChain(STREAM, truncated).ok).toBe(true);
    const verdict = verifyChain(STREAM, truncated, { expectedHead: publishedHead });
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 2, reason: 'head-mismatch' });
  });

  it('rejects a link from another stream and a malformed hash', () => {
    const other = appendLinks('treasury.transfers', null, [entryDigest(ENTRIES[0])]);
    const foreign = verifyChain(STREAM, [{ link: other[0]!, entry: ENTRIES[0] }]);
    expect(foreign.ok === false && foreign.firstBreak.reason).toBe('stream-mismatch');
    const records = build();
    records[0] = { ...records[0]!, link: { ...records[0]!.link, prevHash: 'XYZ' } };
    const malformed = verifyChain(STREAM, records);
    expect(malformed.ok === false && malformed.firstBreak).toMatchObject({ index: 0, reason: 'malformed' });
  });

  it('requires entries in a full audit', () => {
    const records = build().map((r) => ({ link: r.link }));
    expect(verifyChain(STREAM, records).ok).toBe(true);
    const verdict = verifyChain(STREAM, records, { requireEntries: true });
    expect(verdict.ok === false && verdict.firstBreak.reason).toBe('entry-missing');
  });

  it('is pinned to a golden vector so the hash format cannot drift silently', () => {
    const records = build();
    expect(records[0]!.link.entryDigest).toBe(GOLDEN.firstDigest);
    expect(records[0]!.link.entryHash).toBe(GOLDEN.firstLinkHash);
    expect(records[3]!.link.entryHash).toBe(GOLDEN.head);
  });
});

// firstDigest and firstLinkHash were computed OUTSIDE this library, with
// `printf '<domain tag>\n<canonical bytes>' | sha256sum`, so they pin the format
// definition rather than restating the implementation; head pins the full chain.
// A change here is a FORMAT change: bump HASH_CHAIN_VERSION, never just the literal.
const GOLDEN = {
  firstDigest: '6172eff72539ca63183ef378c11d89125a5465eeb49f1f3cf10f2b63e75e4958',
  firstLinkHash: 'b1b34b20ba00fa58b8425a6eac33083de25101d14208a7432367531863c8572c',
  head: '349c289e72453d8936ce72ab86c4f63132b5fab5bb40a97ae0115be569301419',
};

describe('export format', () => {
  it('round-trips byte-for-byte and verifies', () => {
    const records = build();
    const text = exportChain(STREAM, records);
    const parsed = parseChainExport(text);
    expect(parsed.header).toMatchObject({ streamId: STREAM, length: 4, head: { seq: 3, entryHash: records[3]!.link.entryHash } });
    expect(parsed.records).toEqual(records);
    expect(exportChain(STREAM, parsed.records)).toBe(text);
    expect(verifyChainExport(text)).toMatchObject({ ok: true, length: 4 });
  });

  it('carries a missing entry explicitly and reports it on verify', () => {
    const records = build();
    records[2] = { link: records[2]!.link, entryMissing: true };
    const text = exportChain(STREAM, records);
    expect(parseChainExport(text).records[2]).toEqual({ link: records[2]!.link, entryMissing: true });
    const verdict = verifyChainExport(text);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 2, reason: 'entry-missing' });
  });

  it('catches a tampered entry inside an export', () => {
    const text = exportChain(STREAM, build());
    const tampered = text.replace('"amountMinor":200', '"amountMinor":201');
    expect(tampered).not.toBe(text);
    const verdict = verifyChainExport(tampered);
    expect(verdict.ok === false && verdict.firstBreak).toMatchObject({ index: 1, reason: 'entry-mismatch' });
  });

  it('catches a dropped body line against the header, and a consistent truncation against an anchor', () => {
    const records = build();
    const text = exportChain(STREAM, records);
    const lines = text.split('\n');
    const bodyDropped = [...lines.slice(0, 4), ''].join('\n');
    expect(verifyChainExport(bodyDropped)).toMatchObject({ ok: false, firstBreak: { reason: 'malformed' } });

    const consistent = exportChain(STREAM, records.slice(0, 3));
    expect(verifyChainExport(consistent).ok).toBe(true);
    const anchored = verifyChainExport(consistent, { expectedHead: { seq: 3, entryHash: records[3]!.link.entryHash } });
    expect(anchored.ok === false && anchored.firstBreak.reason).toBe('head-mismatch');
  });

  it('refuses non-canonical lines and unknown fields', () => {
    const text = exportChain(STREAM, build());
    const [header, first, ...rest] = text.split('\n');
    const spaced = [header, first!.replace(':', ': '), ...rest].join('\n');
    expect(() => parseChainExport(spaced)).toThrow(/not canonical JSON/);
    const extra = [header!.replace('{', '{"extra":1,'), first, ...rest].join('\n');
    expect(() => parseChainExport(extra)).toThrow();
    expect(() => parseChainExport(text.slice(0, -1))).toThrow(/newline/);
  });
});

describe('runVerifyCli', () => {
  const run = (argv: string[], files: Record<string, string>) => {
    const out: string[] = [];
    const code = runVerifyCli(argv, {
      readFile: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
      out: (line) => out.push(line),
    });
    return { code, verdict: JSON.parse(out[0]!) as { ok: boolean; firstBreak?: { reason: string } } };
  };

  it('exits 0 on an intact export, 1 on a broken one, 2 on usage errors', () => {
    const records = build();
    const good = exportChain(STREAM, records);
    expect(run(['verify', 'a.jsonl'], { 'a.jsonl': good })).toMatchObject({ code: 0, verdict: { ok: true } });
    const bad = good.replace('"amountMinor":900', '"amountMinor":901');
    expect(run(['verify', 'b.jsonl'], { 'b.jsonl': bad })).toMatchObject({ code: 1, verdict: { firstBreak: { reason: 'entry-mismatch' } } });
    expect(run(['bogus'], {}).code).toBe(2);
    expect(run(['verify', 'missing.jsonl'], {}).code).toBe(2);
    expect(run(['verify', 'a.jsonl', '--head-seq', '3'], { 'a.jsonl': good }).code).toBe(2);
  });

  it('applies an independently pinned head', () => {
    const records = build();
    const short = exportChain(STREAM, records.slice(0, 2));
    const head = records[3]!.link;
    const result = run(['verify', 's.jsonl', '--head-seq', String(head.seq), '--head-hash', head.entryHash], { 's.jsonl': short });
    expect(result).toMatchObject({ code: 1, verdict: { firstBreak: { reason: 'head-mismatch' } } });
  });
});
