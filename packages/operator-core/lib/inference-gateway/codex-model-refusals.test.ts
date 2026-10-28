/**
 * WI-10003306 — the per-(account, model) refusal registry that lets the gateway route around a
 * ChatGPT account for ONE model without removing it from the pool or parking it for others.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_REFUSAL_RE,
  codexModelRefusalDetail,
  createCodexModelRefusalRegistry,
  isCodexModelRefusal,
  type CodexModelRefusalChange,
  type CodexModelRefusalEntry,
} from './codex-model-refusals';
import { emptyPool, getAccount, registerAccount, setAccountModelRefusal } from '../deployment/account-pool';

const LIVE_BODY = `{"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}`;

describe('isCodexModelRefusal', () => {
  it('recognises the live backend refusal body (captured 2026-09-26)', () => {
    expect(isCodexModelRefusal(400, LIVE_BODY)).toBe(true);
    expect(CODEX_MODEL_REFUSAL_RE.test(LIVE_BODY)).toBe(true);
  });

  it('ignores auth, rate-limit and server statuses even when the wording matches', () => {
    for (const status of [200, 401, 403, 429, 500, 503]) expect(isCodexModelRefusal(status, LIVE_BODY)).toBe(false);
  });

  it('ignores an ordinary 4xx that is not about the model', () => {
    expect(isCodexModelRefusal(400, '{"detail":"Input must be a list"}')).toBe(false);
  });

  it('extracts the backend detail for logs and stats', () => {
    expect(codexModelRefusalDetail(LIVE_BODY)).toBe(
      "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(codexModelRefusalDetail('plain text refusal')).toBe('plain text refusal');
  });
});

describe('createCodexModelRefusalRegistry', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('marks exactly the refused (account, model) pair — other models and accounts stay eligible', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('aviynw3_codex', 'gpt-6-sol', 'refused')).toBe(true);

    expect(reg.isRefused('aviynw3_codex', 'gpt-6-sol')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'GPT-6-SOL ')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'gpt-5.6-luna')).toBe(false);
    expect(reg.isRefused('aviynw6_codex', 'gpt-6-sol')).toBe(false);
  });

  it('reports a transition only once per episode, extending the window on repeats', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('a', 'm', 'first')).toBe(true);
    c.advance(50_000);
    expect(reg.record('a', 'm', 'again')).toBe(false);
    c.advance(50_000); // 100s after the first hit, 50s after the repeat
    expect(reg.isRefused('a', 'm')).toBe(true);
    expect(reg.snapshot()).toEqual([expect.objectContaining({ accountId: 'a', model: 'm', hits: 2, detail: 'again' })]);
  });

  it('recovers automatically: the mark lapses after the TTL, and a 2xx clears it at once', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    reg.record('a', 'm', 'x');
    c.advance(60_001);
    expect(reg.isRefused('a', 'm')).toBe(false);
    expect(reg.snapshot()).toEqual([]);

    reg.record('b', 'm', 'x');
    expect(reg.clear('b', 'm')).toBe(true);
    expect(reg.isRefused('b', 'm')).toBe(false);
    expect(reg.clear('b', 'm')).toBe(false);
  });

  // WI-6554700010030462: measured 2026-10-27 — the only healthy account refused gpt-5.6-sol, the
  // mark lapsed with the 30-minute re-check window, /stats dropped the model, and both launch
  // preflights read "unknown" and paid a convert that 429-aborted. Re-check and belief are separate.
  it('keeps BELIEVING a refusal after the selection re-check window lapses', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now });

    reg.record('a', 'gpt-5.6-sol', 'refused');
    c.advance(60_001);
    // Selection may re-try the account (cheap, in-request failover)…
    expect(reg.isRefused('a', 'gpt-5.6-sol')).toBe(false);
    expect(reg.snapshot()).toEqual([]);
    // …but the launch preflights are still told it refuses.
    expect(reg.isBelievedRefused('a', 'gpt-5.6-sol')).toBe(true);
    expect(reg.believedSnapshot()).toEqual([expect.objectContaining({ accountId: 'a', model: 'gpt-5.6-sol', hits: 1 })]);

    // The belief ends at the report horizon when nothing re-confirms it.
    c.advance(600_000 - 60_001);
    expect(reg.isBelievedRefused('a', 'gpt-5.6-sol')).toBe(false);
    expect(reg.believedSnapshot()).toEqual([]);
  });

  it('re-arms both horizons when a lapsed re-check is refused again, and logs that as a new exclusion', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now });

    reg.record('a', 'm', 'first');
    c.advance(30_000);
    expect(reg.record('a', 'm', 'inside the window')).toBe(false);
    c.advance(100_000); // re-check window lapsed, belief still held
    expect(reg.record('a', 'm', 'refused on re-check')).toBe(true);
    expect(reg.isRefused('a', 'm')).toBe(true);
    c.advance(599_999); // the belief horizon restarted at the re-confirmation
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
    expect(reg.believedSnapshot()).toEqual([
      expect.objectContaining({ since: 1_000_000, hits: 3, detail: 'refused on re-check' }),
    ]);
  });

  it('a 2xx clears the belief too, and the report horizon is never shorter than the re-check TTL', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 1_000, now: c.now });

    reg.record('a', 'm', 'x');
    c.advance(30_000);
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
    expect(reg.clear('a', 'm')).toBe(true);
    expect(reg.isBelievedRefused('a', 'm')).toBe(false);
    expect(reg.believedSnapshot()).toEqual([]);
  });

  it('stays bounded under a flood of distinct pairs', () => {
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) reg.record(`acct-${i}`, 'm', 'x');
    expect(reg.snapshot()).toHaveLength(3);
  });
});

/** WI-6554700010030570 — durable write-through + re-seed, so a gateway restart keeps the belief. */
describe('codex model refusal persistence', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };
  const entry = (over: Partial<CodexModelRefusalEntry> = {}): CodexModelRefusalEntry => ({
    accountId: 'a', model: 'm', since: 900_000, lastAt: 950_000, until: 1_010_000, reportUntil: 2_000_000, hits: 2, detail: 'stored',
    ...over,
  });

  it('onChange fires on every record (new and re-confirmed) and on an effective clear only', () => {
    const c = clock();
    const changes: CodexModelRefusalChange[] = [];
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now, onChange: (x) => changes.push(x) });

    reg.record('a', 'm', 'first');
    c.advance(10_000);
    reg.record('a', 'm', 'again');
    expect(reg.clear('a', 'other')).toBe(false); // a no-op clear writes nothing
    c.advance(1_000);
    expect(reg.clear('a', 'm')).toBe(true);

    expect(changes).toEqual([
      { kind: 'record', entry: expect.objectContaining({ accountId: 'a', model: 'm', hits: 1, lastAt: 1_000_000, reportUntil: 1_600_000 }) },
      { kind: 'record', entry: expect.objectContaining({ hits: 2, since: 1_000_000, lastAt: 1_010_000, detail: 'again' }) },
      { kind: 'clear', accountId: 'a', model: 'm', at: 1_011_000 },
    ]);
  });

  it('the emitted entry is a copy — mutating it cannot reach the registry', () => {
    const changes: CodexModelRefusalChange[] = [];
    const reg = createCodexModelRefusalRegistry({ onChange: (x) => changes.push(x) });
    reg.record('a', 'm', 'x');
    (changes[0] as { entry: CodexModelRefusalEntry }).entry.hits = 99;
    expect(reg.believedSnapshot()[0]?.hits).toBe(1);
  });

  it('a throwing onChange never breaks routing', () => {
    const reg = createCodexModelRefusalRegistry({ onChange: () => { throw new Error('store down'); } });
    expect(reg.record('a', 'm', 'x')).toBe(true);
    expect(reg.isRefused('a', 'm')).toBe(true);
    expect(reg.clear('a', 'm')).toBe(true);
  });

  it('hydrate: newer wins, expired and pre-clear entries are skipped, and it never fires onChange', () => {
    const c = clock();
    const changes: CodexModelRefusalChange[] = [];
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now, onChange: (x) => changes.push(x) });

    expect(reg.hydrate([
      entry(),
      entry({ accountId: 'b', reportUntil: 1_000_000 }), // belief already lapsed
      entry({ accountId: '', model: 'm' }),
    ])).toBe(1);
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
    expect(reg.isRefused('a', 'm')).toBe(true); // stored re-check window still open
    expect(reg.isBelievedRefused('b', 'm')).toBe(false);

    // An older stored copy never overwrites a newer in-memory one.
    expect(reg.hydrate([entry({ lastAt: 940_000, detail: 'older' })])).toBe(0);
    expect(reg.believedSnapshot()[0]).toMatchObject({ detail: 'stored', hits: 2 });
    expect(reg.hydrate([entry({ lastAt: 990_000, detail: 'newer', hits: 3 })])).toBe(1);
    expect(reg.believedSnapshot()[0]).toMatchObject({ detail: 'newer', hits: 3 });

    // A resync that read the store before a clear's write landed cannot resurrect the pair.
    c.advance(5_000);
    reg.clear('a', 'm');
    expect(reg.hydrate([entry({ lastAt: 990_000 })])).toBe(0);
    expect(reg.isBelievedRefused('a', 'm')).toBe(false);
    // ...but a refusal observed AFTER the clear (another gateway) does apply.
    expect(reg.hydrate([entry({ lastAt: 1_006_000, until: 1_066_000 })])).toBe(1);
    expect(reg.isRefused('a', 'm')).toBe(true);

    expect(changes.map((x) => x.kind)).toEqual(['clear']);
  });

  it('a hydrated entry past its re-check window is believed but not excluded', () => {
    const reg = createCodexModelRefusalRegistry({ now: () => 1_000_000 });
    reg.hydrate([entry({ until: 999_000 })]);
    expect(reg.isRefused('a', 'm')).toBe(false);
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
  });

  it('round-trips through the account-pool projection across a gateway restart', () => {
    const c = clock();
    let pool = registerAccount(emptyPool(), { id: 'cx', provider: 'codex', credentialRef: 'codex-cli:/tmp/cx' }, c.now());
    const writeThrough = (x: CodexModelRefusalChange): void => {
      pool = x.kind === 'record'
        ? setAccountModelRefusal(pool, x.entry.accountId, x.entry.model, {
          model: x.entry.model, since: x.entry.since, lastAt: x.entry.lastAt, until: x.entry.until,
          reportUntil: x.entry.reportUntil, hits: x.entry.hits, detail: x.entry.detail,
        }, c.now())
        : setAccountModelRefusal(pool, x.accountId, x.model, null, c.now());
    };
    const before = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now, onChange: writeThrough });
    before.record('cx', 'GPT-5.6-Sol', 'not supported');

    // Restart: a fresh registry seeded only from the store.
    c.advance(120_000); // past the re-check window, inside the belief horizon
    const seed = (): CodexModelRefusalEntry[] => pool.accounts.flatMap((a) =>
      Object.values(a.rate.modelRefusals ?? {}).map((r) => ({ ...r, accountId: a.id })));
    const after = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now, onChange: writeThrough });
    expect(after.hydrate(seed())).toBe(1);
    expect(after.isBelievedRefused('cx', 'gpt-5.6-sol')).toBe(true);
    expect(after.isRefused('cx', 'gpt-5.6-sol')).toBe(false);

    // A 2xx after the restart clears the store too, so the next restart starts clean.
    expect(after.clear('cx', 'GPT-5.6-Sol')).toBe(true);
    expect(getAccount(pool, 'cx')?.rate.modelRefusals).toBeUndefined();
    expect(createCodexModelRefusalRegistry({ now: c.now }).hydrate(seed())).toBe(0);
  });
});
