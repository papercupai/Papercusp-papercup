import { describe, it, expect, vi } from 'vitest';
import {
  SEED_FORMAT_VERSION,
  SeedManifestError,
  validateManifest,
  encodeManifest,
  decodeManifest,
  canonicalJson,
  SeedProviderRegistry,
  SEED_RESTORE_DIAGNOSTIC_SLOT,
  restoreSeed,
  type SeedManifest,
  type SeedProvider,
  type SeedStoreEntry,
} from './index';

function validManifest(over: Partial<SeedManifest> = {}): SeedManifest {
  return {
    seedFormatVersion: SEED_FORMAT_VERSION,
    potId: 'papercusp',
    cutAtEpoch: 0,
    cutHlc: 'hlc-abc',
    cutTs: 1000,
    stores: [
      {
        kind: 'git',
        hash: 'gh1',
        sizeBytes: 10,
        source: { type: 'resource', path: 'seed/git.bundle' },
        encryption: { scheme: 'xchacha20poly1305', keyRef: { via: 'seed-key-op', potId: 'papercusp' } },
      },
      { kind: 'corestore', hash: 'ch1', sizeBytes: 20, source: { type: 'resource', path: 'seed/corestore' } },
    ],
    ...over,
  };
}

function okProvider(kind: string): SeedProvider {
  return {
    kind,
    cut: vi.fn(async () => ({ entry: { kind, hash: 'h', sizeBytes: 1, source: { type: 'resource' as const, path: 'p' } }, payload: new Uint8Array() })),
    verify: vi.fn(async () => ({ ok: true })),
    restore: vi.fn(async () => {}),
  };
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(validManifest())).toEqual({ ok: true, errors: [] });
  });

  it('accepts every source variant', () => {
    const m = validManifest({
      stores: [
        { kind: 'a', hash: 'h', sizeBytes: 1, source: { type: 'resource', path: 'x' } },
        { kind: 'b', hash: 'h', sizeBytes: 1, source: { type: 'url', url: 'https://x', bytes: 5 } },
        { kind: 'c', hash: 'h', sizeBytes: 1, source: { type: 'swarm', topic: 't' } },
      ],
    });
    expect(validateManifest(m).ok).toBe(true);
  });

  it.each([
    ['a non-object', 42, /must be an object/],
    ['wrong version', validManifest({ seedFormatVersion: 999 }), /seedFormatVersion must be/],
    ['empty potId', validManifest({ potId: '' }), /potId must be/],
    ['negative epoch', validManifest({ cutAtEpoch: -1 }), /cutAtEpoch/],
    ['non-integer epoch', validManifest({ cutAtEpoch: 1.5 }), /cutAtEpoch/],
    ['empty cutHlc', validManifest({ cutHlc: '' }), /cutHlc/],
    ['empty stores', validManifest({ stores: [] }), /stores must be a non-empty array/],
  ])('rejects %s', (_label, input, re) => {
    const v = validateManifest(input);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(re as RegExp);
  });

  it('rejects a store missing its hash', () => {
    const m = validManifest({ stores: [{ kind: 'git', sizeBytes: 1, source: { type: 'resource', path: 'p' } } as unknown as SeedStoreEntry] });
    const v = validateManifest(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/stores\[0\]\.hash/);
  });

  it('rejects a bad source type', () => {
    const m = validManifest({ stores: [{ kind: 'git', hash: 'h', sizeBytes: 1, source: { type: 'ftp' } as unknown as SeedStoreEntry['source'] }] });
    expect(validateManifest(m).errors.join(' ')).toMatch(/source\.type must be one of/);
  });

  it('rejects a url source missing bytes', () => {
    const m = validManifest({ stores: [{ kind: 'g', hash: 'h', sizeBytes: 1, source: { type: 'url', url: 'https://x' } as unknown as SeedStoreEntry['source'] }] });
    expect(validateManifest(m).errors.join(' ')).toMatch(/source\.bytes/);
  });

  it('rejects encryption without a valid keyRef', () => {
    const m = validManifest({
      stores: [{ kind: 'g', hash: 'h', sizeBytes: 1, source: { type: 'resource', path: 'p' }, encryption: { scheme: 'x' } as unknown as SeedStoreEntry['encryption'] }],
    });
    expect(validateManifest(m).errors.join(' ')).toMatch(/keyRef/);
  });

  it('accepts an epoch keyRef', () => {
    const m = validManifest({
      stores: [{ kind: 'g', hash: 'h', sizeBytes: 1, source: { type: 'resource', path: 'p' }, encryption: { scheme: 'x', keyRef: { via: 'epoch', potId: 'papercusp', epoch: 3 } } }],
    });
    expect(validateManifest(m).ok).toBe(true);
  });
});

describe('encode/decode', () => {
  it('round-trips a valid manifest', () => {
    const m = validManifest();
    expect(decodeManifest(encodeManifest(m))).toEqual(m);
  });

  it('canonicalJson is key-order-independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('encodeManifest throws on an invalid manifest', () => {
    expect(() => encodeManifest(validManifest({ potId: '' }))).toThrow(SeedManifestError);
  });

  it('decodeManifest throws on bad JSON', () => {
    expect(() => decodeManifest('{not json')).toThrow(SeedManifestError);
  });

  it('decodeManifest throws on a valid-JSON invalid manifest', () => {
    expect(() => decodeManifest(JSON.stringify({ seedFormatVersion: 1 }))).toThrow(/invalid manifest/);
  });
});

describe('SeedProviderRegistry', () => {
  it('registers, gets, and requires providers', () => {
    const reg = new SeedProviderRegistry();
    const git = okProvider('git');
    reg.register(git);
    expect(reg.get('git')).toBe(git);
    expect(reg.require('git')).toBe(git);
    expect(reg.kinds()).toEqual(['git']);
  });

  it('throws on a duplicate kind', () => {
    const reg = new SeedProviderRegistry();
    reg.register(okProvider('git'));
    expect(() => reg.register(okProvider('git'))).toThrow(/duplicate seed provider kind: git/);
  });

  it('require() throws with the known-kinds list on a miss', () => {
    const reg = new SeedProviderRegistry();
    reg.register(okProvider('git'));
    expect(() => reg.require('corestore')).toThrow(/no seed provider registered for kind: corestore \(have: git\)/);
  });
});

describe('restoreSeed', () => {
  const resolve = async () => new Uint8Array([1, 2, 3]);

  it('restores every store on the happy path', async () => {
    const reg = new SeedProviderRegistry();
    const git = okProvider('git');
    const core = okProvider('corestore');
    reg.register(git).register(core);
    const res = await restoreSeed(validManifest(), reg, resolve, {});
    expect(res.ok).toBe(true);
    expect(res.outcomes).toEqual([
      { kind: 'git', ok: true },
      { kind: 'corestore', ok: true },
    ]);
    expect(git.restore).toHaveBeenCalledOnce();
    expect(core.restore).toHaveBeenCalledOnce();
  });

  it('reports a missing provider without aborting the others', async () => {
    const reg = new SeedProviderRegistry();
    const core = okProvider('corestore');
    reg.register(core); // no git provider
    const res = await restoreSeed(validManifest(), reg, resolve, {});
    expect(res.ok).toBe(false);
    expect(res.outcomes[0]).toMatchObject({ kind: 'git', ok: false });
    expect(res.outcomes[0].reason).toMatch(/no provider registered/);
    expect(res.outcomes[1]).toEqual({ kind: 'corestore', ok: true });
    expect(core.restore).toHaveBeenCalledOnce();
  });

  it('does NOT restore a store whose verify fails', async () => {
    const reg = new SeedProviderRegistry();
    const git = okProvider('git');
    git.verify = vi.fn(async () => ({ ok: false, reason: 'hash mismatch' }));
    reg.register(git).register(okProvider('corestore'));
    const phases: Array<{ kind: string; phase: string; state: string; reason?: string }> = [];
    const res = await restoreSeed(validManifest(), reg, resolve, { onPhase: (event) => phases.push(event) });
    expect(res.ok).toBe(false);
    expect(res.outcomes[0]).toMatchObject({ kind: 'git', ok: false });
    expect(res.outcomes[0].reason).toMatch(/verify failed: hash mismatch/);
    expect(git.restore).not.toHaveBeenCalled();
    expect(phases).toEqual([
      { kind: 'git', phase: 'resolve', state: 'started' },
      { kind: 'git', phase: 'resolve', state: 'succeeded' },
      { kind: 'git', phase: 'verify', state: 'started' },
      { kind: 'git', phase: 'verify', state: 'failed', reason: 'hash mismatch' },
      { kind: 'corestore', phase: 'resolve', state: 'started' },
      { kind: 'corestore', phase: 'resolve', state: 'succeeded' },
      { kind: 'corestore', phase: 'verify', state: 'started' },
      { kind: 'corestore', phase: 'verify', state: 'succeeded' },
      { kind: 'corestore', phase: 'restore', state: 'started' },
      { kind: 'corestore', phase: 'restore', state: 'succeeded' },
    ]);
  });

  it('isolates a restore that throws', async () => {
    const reg = new SeedProviderRegistry();
    const git = okProvider('git');
    git.restore = vi.fn(async () => {
      throw new Error('disk full');
    });
    const core = okProvider('corestore');
    reg.register(git).register(core);
    const phases: Array<{ kind: string; phase: string; state: string; reason?: string }> = [];
    const res = await restoreSeed(validManifest(), reg, resolve, { onPhase: (event) => phases.push(event) });
    expect(res.ok).toBe(false);
    expect(res.outcomes[0].reason).toMatch(/restore threw: disk full/);
    expect(core.restore).toHaveBeenCalledOnce(); // the other store still ran
    expect(phases.slice(0, 6)).toEqual([
      { kind: 'git', phase: 'resolve', state: 'started' },
      { kind: 'git', phase: 'resolve', state: 'succeeded' },
      { kind: 'git', phase: 'verify', state: 'started' },
      { kind: 'git', phase: 'verify', state: 'succeeded' },
      { kind: 'git', phase: 'restore', state: 'started' },
      { kind: 'git', phase: 'restore', state: 'failed', reason: 'disk full' },
    ]);
  });

  it('attributes payload resolver failures before provider verification begins', async () => {
    const reg = new SeedProviderRegistry();
    const core = okProvider('corestore');
    reg.register(core);
    const phases: Array<{ kind: string; phase: string; state: string; reason?: string }> = [];
    const manifest = validManifest({ stores: [validManifest().stores[1]] });
    const result = await restoreSeed(manifest, reg, async () => {
      throw new Error('payload unavailable');
    }, { onPhase: (event) => phases.push(event) });

    expect(result.outcomes).toEqual([{ kind: 'corestore', ok: false, reason: 'resolve threw: payload unavailable' }]);
    expect(core.verify).not.toHaveBeenCalled();
    expect(phases).toEqual([
      { kind: 'corestore', phase: 'resolve', state: 'started' },
      { kind: 'corestore', phase: 'resolve', state: 'failed', reason: 'payload unavailable' },
    ]);
  });

  it.each(['verify', 'restore'] as const)('leaves a visible %s boundary while that provider await is held', async (heldPhase) => {
    const reg = new SeedProviderRegistry();
    const core = okProvider('corestore');
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    if (heldPhase === 'verify') {
      core.verify = vi.fn(async () => { await held; return { ok: true }; });
    } else {
      core.restore = vi.fn(async () => { await held; });
    }
    reg.register(core);
    const phases: Array<{ kind: string; phase: string; state: string; reason?: string }> = [];
    const manifest = validManifest({ stores: [validManifest().stores[1]] });
    const ongoing = restoreSeed(manifest, reg, resolve, { onPhase: (event) => phases.push(event) });

    await vi.waitFor(() => expect(phases).toContainEqual({ kind: 'corestore', phase: heldPhase, state: 'started' }));
    expect(phases).not.toContainEqual({ kind: 'corestore', phase: heldPhase, state: 'succeeded' });
    if (heldPhase === 'verify') {
      expect(phases).not.toContainEqual({ kind: 'corestore', phase: 'restore', state: 'started' });
    }
    release();
    expect((await ongoing).outcomes).toEqual([{ kind: 'corestore', ok: true }]);
    expect(phases).toContainEqual({ kind: 'corestore', phase: heldPhase, state: 'succeeded' });
  });

  it('publishes a bounded identity-pinned diagnostic operation while a provider await is held', async () => {
    const key = Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT);
    const root = globalThis as unknown as Record<symbol, unknown>;
    delete root[key];
    const reg = new SeedProviderRegistry();
    const core = okProvider('corestore');
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    core.verify = vi.fn(async () => { await held; return { ok: true }; });
    reg.register(core);
    const ongoing = restoreSeed(validManifest({ stores: [validManifest().stores[1]] }), reg, resolve, {
      diagnosticIdentity: { buildSha: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), script: 'serve.mjs' },
    });
    try {
      await vi.waitFor(() => {
        const state = root[key] as { operations?: Array<{ status: string; identity: unknown; events: unknown[] }> };
        const operation = state?.operations?.at(-1);
        expect(operation?.status).toBe('running');
        expect(operation?.identity).toMatchObject({ buildSha: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), script: 'serve.mjs' });
        expect(operation?.events).toContainEqual(expect.objectContaining({ phase: 'verify', state: 'started' }));
      });
      release();
      await expect(ongoing).resolves.toMatchObject({ ok: true });
      const state = root[key] as { operations?: Array<{ status: string; finishedAt: number | null }> };
      expect(state.operations?.at(-1)).toMatchObject({ status: 'succeeded', finishedAt: expect.any(Number) });
    } finally {
      release();
      delete root[key];
    }
  });

  it('fails fast on an invalid manifest', async () => {
    const reg = new SeedProviderRegistry();
    reg.register(okProvider('git'));
    const res = await restoreSeed(validManifest({ potId: '' }), reg, resolve, {});
    expect(res.ok).toBe(false);
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ kind: '(manifest)', ok: false });
  });
});
