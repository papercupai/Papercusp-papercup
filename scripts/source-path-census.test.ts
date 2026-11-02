import { describe, expect, it, vi } from 'vitest';
import { boundedFrontier, censusSites, changedSites, createPreparationLedger, openPreparationLedger, preparationDisposition,
  selectSourcePath, verifyPreparationCitation } from './lib/source-path-census.mjs';

describe('source-only call-site preparation', () => {
  it('does not attribute a shadowed parameter call to an imported process primitive', () => {
    const unit = censusSites('unit.ts', `import { spawn } from 'node:child_process';
      function handler(spawn) { spawn('local callback'); }`);
    const call = unit.sites.find(site => site.expression === 'spawn');
    expect(call?.binding).toBeNull();
    expect(call?.calleeCoverage).toBe('UNKNOWN');
  });

  it.each([
    `function handler(){ const run = local; run(); }`,
    `function handler({ run }){ run(); }`,
    `function handler([run]){ run(); }`,
    `function handler(){ try { work(); } catch(run) { run(); } }`,
    `function handler(){ function run(){} run(); }`,
    `function handler(){ class run{} new run(); }`,
  ])('retains ambiguous calls without selecting an import across a local declaration: %s', body => {
    const unit = censusSites('unit.ts', `import { run } from './effects'; ${body}`);
    const calls = unit.sites.filter(site => site.expression === 'run');
    expect(calls).toHaveLength(1);
    expect(calls[0].binding).toBeNull(); expect(calls[0].calleeCoverage).toBe('UNKNOWN');
  });

  it.each(['run = local', '[run] = values', '({ run } = values)', 'run++'])('invalidates a reassigned dynamic import alias: %s', mutation => {
    const unit = censusSites('unit.ts', `async function handler(){ let { run } = await import('./effects'); ${mutation}; run(); }`);
    expect(unit.sites.find(site => site.expression === 'run')?.binding).toBeNull();
    expect(unit.sites.some(site => site.specifier === './effects')).toBe(true);
  });

  it.each([
    `const { run } = wrap(await import('./effects'))`,
    `const { run = local } = await import('./effects')`,
    `const { [field]: run } = await import('./effects')`,
    `const { ...run } = await import('./effects')`,
  ])('keeps non-exact destructuring unresolved: %s', declaration => {
    const unit = censusSites('unit.ts', `async function handler(){ ${declaration}; run(); }`);
    expect(unit.sites.find(site => site.expression === 'run')?.binding).toBeNull();
    expect(unit.sites.some(site => site.specifier === './effects')).toBe(true);
  });

  it('preserves unambiguous renamed imports and direct dynamic aliases without claiming callee coverage', () => {
    const unit = censusSites('unit.ts', `import { spawn as launch } from 'node:child_process';
      async function handler(){ const { 'writeFile': save } = await import('node:fs/promises'); launch(); save(); }`);
    expect(unit.sites.find(site => site.expression === 'launch')?.binding).toEqual({ imported: 'spawn', specifiers: ['node:child_process'] });
    expect(unit.sites.find(site => site.expression === 'save')?.binding).toEqual({ imported: 'writeFile', specifiers: ['node:fs/promises'] });
    expect(unit.sites.filter(site => site.kind === 'call').every(site => site.calleeCoverage === 'UNKNOWN')).toBe(true);
  });

  it('does not turn type-only imports into executable aliases', () => {
    const unit = censusSites('unit.ts', `import type { run } from './types'; run();`);
    expect(unit.sites.find(site => site.expression === 'run')?.binding).toBeNull();
  });

  it('retains a new import occurrence even when its module specifier already existed', () => {
    const before = censusSites('unit.ts', `async function handler(){ if (old) await import('./funding'); }`);
    const after = censusSites('unit.ts', `async function handler(){ if (old) await import('./funding'); if (preserveArtifact) await import('./funding'); }`);
    const added = changedSites(before, after).addedOrChanged;
    expect(added.filter(site => site.specifier === './funding')).toHaveLength(1);
    expect(added[0].predicates[0].condition).toBe('preserveArtifact');
    expect(added[0].byteEnd).toBeGreaterThan(added[0].byteStart);
  });
  it('keeps eager and pre-branch imports while proving a later lazy branch excluded', () => {
    const unit = censusSites('unit.ts', `import './eager'; async function handler(){
      const [{ verify }] = await Promise.all([import('./verifier')]);
      if (preserveArtifact) { verify(); return true; }
      if (otherRole) { await import('./role-repair'); }
    }`);
    const path = selectSourcePath(unit, { functionName: 'handler', branchValues: { preserveArtifact: true } });
    expect(path.selected.filter(site => site.specifier).map(site => site.specifier)).toEqual(['./eager', './verifier']);
    expect(path.selected.find(site => site.expression === 'verify')?.binding).toEqual({ imported: 'verify', specifiers: ['./verifier'] });
    expect(path.excluded.find(row => row.site.specifier === './role-repair')?.reason).toBe('selected-branch-terminates-before-site');
  });
  it('does not exclude a later branch when the selected branch can fall through', () => {
    const unit = censusSites('unit.ts', `async function handler(){ if(preserveArtifact){ if(bad) return; } await import('./later'); }`);
    const path = selectSourcePath(unit, { functionName: 'handler', branchValues: { preserveArtifact: true } });
    expect(path.selected.some(site => site.specifier === './later')).toBe(true);
  });
  it('retains nonliteral imports and computed dispatch as unresolved coverage', () => {
    const unit = censusSites('unit.ts', `async function handler(){ await import(which); operations[name](); }`);
    const path = selectSourcePath(unit, { functionName: 'handler' });
    expect(path.selected.find(site => site.kind === 'dynamic-import')?.specifier).toBeNull();
    expect(path.selected.find(site => site.expression === 'operations[name]')?.calleeCoverage).toBe('UNKNOWN');
  });
  it('does not confuse another endpoint handler with the selected handler', () => {
    const unit = censusSites('unit.ts', `const first = define({ async handler(){ await import('./first'); } });
      const second = define({ async handler(){ await import('./second'); } });`);
    const path = selectSourcePath(unit, { functionName: 'handler', containerName: 'first' });
    expect(path.selected.filter(site => site.specifier).map(site => site.specifier)).toEqual(['./first']);
  });
  it('retains an identical second import occurrence in the same function', () => {
    const before = censusSites('unit.ts', `async function handler(){ await import('./same'); }`);
    const after = censusSites('unit.ts', `async function handler(){ await import('./same'); await import('./same'); }`);
    expect(changedSites(before, after).addedOrChanged.filter(site => site.specifier === './same')).toHaveLength(1);
  });
  it('counts shared additions once and retains the same total bound across seeds', () => {
    const result = boundedFrontier([{ path: 'shared' }, { path: 'shared' }, { path: 'next' }], { priorAdditions: ['prior'], bound: 2 });
    expect(result.status).toBe('STOPPED-bound');
    expect(result.additions).toEqual(['prior', 'shared']);
    expect(result.refusedEdge?.path).toBe('next');
    expect(result.complete).toBe(false);
  });
});

describe('prospective preparation controls (no candidate census or execution)', () => {
  const prefix = Array.from({ length: 60 }, (_, i) => `prefix/${i}`);
  const config = { attemptId: 'same-attempt', candidate: 'fixture-candidate', clockId: 'same-boot',
    baseline: ['known'], priorAdditions: prefix };
  const input = (path: string, text = 'abc') => ({
    stat: vi.fn(async () => ({ size: Buffer.byteLength(text), identity: 'immutable-fixture', canonicalPath: path })),
    readChunk: vi.fn(async ({ offset, length }: { offset: number; length: number }) => Buffer.from(text).subarray(offset, offset + length)),
  });
  const durableStore = () => {
    const records = new Map<string, { revision: number; snapshot: ReturnType<ReturnType<typeof createPreparationLedger>['snapshot']> }>();
    return {
      load: vi.fn(async (id: string) => structuredClone(records.get(id) ?? null)),
      compareAndSwap: vi.fn(async (id: string, expected: number | null, snapshot: ReturnType<ReturnType<typeof createPreparationLedger>['snapshot']>) => {
        const current = records.get(id);
        if ((current?.revision ?? null) !== expected) return { ok: false, revision: current?.revision ?? 0 };
        const revision = (current?.revision ?? -1) + 1;
        records.set(id, { revision, snapshot: structuredClone(snapshot) });
        return { ok: true, revision };
      }),
    };
  };
  it('replays the old refusal at input61 before any metadata or source access', async () => {
    const ledger = createPreparationLedger(config), io = input('loader61');
    await expect(ledger.read('loader61', io)).rejects.toThrow('input-limit');
    expect(io.stat).not.toHaveBeenCalled(); expect(io.readChunk).not.toHaveBeenCalled();
    expect(ledger.snapshot().additions).toEqual(prefix);
  });
  it('admits synthetic61-80 in one union and refuses81 before access, including after resume', async () => {
    let ledger = createPreparationLedger({ ...config, bound: 80 });
    for (let i = 61; i <= 80; i++) {
      await ledger.read(`new/${i}`, input(`new/${i}`));
      ledger = createPreparationLedger({ ...config, bound: 80 }, { snapshot: ledger.snapshot() });
    }
    const io = input('new/81');
    await expect(ledger.read('new/81', io)).rejects.toThrow('input-limit');
    expect(io.readChunk).not.toHaveBeenCalled(); expect(io.stat).not.toHaveBeenCalled();
    expect(ledger.snapshot().additions.slice(0, 60)).toEqual(prefix);
  });
  it.each(['deleted-prefix', 'reordered-prefix', 'promoted-baseline', 'different-attempt', 'different-clock', 'wider-budget'])('rejects %s on restore', kind => {
    const saved = createPreparationLedger(config).snapshot();
    const changed = { ...config, baseline: [...config.baseline], priorAdditions: [...prefix] };
    if (kind === 'deleted-prefix') changed.priorAdditions.pop();
    if (kind === 'reordered-prefix') changed.priorAdditions.reverse();
    if (kind === 'promoted-baseline') { changed.baseline.push(changed.priorAdditions.pop()!); }
    if (kind === 'different-attempt') changed.attemptId = 'new-attempt';
    if (kind === 'different-clock') changed.clockId = 'new-boot';
    expect(() => createPreparationLedger(kind === 'wider-budget' ? { ...changed, maxBytes: 999999999 } : changed, { snapshot: saved })).toThrow('snapshot/configuration');
  });
  it.each(['a/../known', './known', '/known', 'a\\known', 'a//known'])('refuses noncanonical alias %s without access', async path => {
    const ledger = createPreparationLedger(config), io = input(path);
    await expect(ledger.read(path, io)).rejects.toThrow('noncanonical-input');
    expect(io.stat).not.toHaveBeenCalled();
  });
  it('debits known/repeated reads and preserves cumulative bytes across restart', async () => {
    const options = { ...config, maxBytes: 6 };
    let ledger = createPreparationLedger(options);
    await ledger.read('known', input('known')); await ledger.read('known', input('known'));
    ledger = createPreparationLedger(options, { snapshot: ledger.snapshot() });
    const io = input('known'); await expect(ledger.read('known', io)).rejects.toThrow('byte-limit');
    expect(io.readChunk).not.toHaveBeenCalled(); expect(ledger.snapshot().bytesRead).toBe(6);
  });
  it('reopens the durable attempt without requiring the caller to supply saved counters', async () => {
    const options = { ...config, maxBytes: 3 }, store = durableStore();
    const first = await openPreparationLedger(options, { store });
    await first.read('known', input('known'));
    const restarted = await openPreparationLedger(options, { store }), io = input('known');
    await expect(restarted.read('known', io)).rejects.toThrow('byte-limit');
    expect(io.readChunk).not.toHaveBeenCalled(); expect(restarted.snapshot().bytesRead).toBe(3);
  });
  it('refuses a stale concurrent opener before it can access even metadata', async () => {
    const store = durableStore(), first = await openPreparationLedger(config, { store });
    const stale = await openPreparationLedger(config, { store });
    await first.read('known', input('known'));
    const io = input('known'); await expect(stale.read('known', io)).rejects.toThrow('attempt-state-conflict');
    expect(io.stat).not.toHaveBeenCalled(); expect(io.readChunk).not.toHaveBeenCalled();
  });
  it('persists a pre-read terminal refusal before reopening the durable attempt', async () => {
    const store = durableStore(), first = await openPreparationLedger(config, { store });
    await expect(first.read('loader61', input('loader61'))).rejects.toThrow('input-limit');
    const resumed = await openPreparationLedger(config, { store }), known = input('known');
    await expect(resumed.read('known', known)).rejects.toThrow('input-limit');
    expect(known.stat).not.toHaveBeenCalled(); expect(known.readChunk).not.toHaveBeenCalled();
    expect((await store.load(config.attemptId))?.snapshot.status).toBe('STOPPED');
  });
  it('closes the real-reader seam when metadata rejects an oversized input', async () => {
    const ledger = createPreparationLedger({ ...config, maxInputBytes: 2 });
    const io = { ...input('known'), close: vi.fn(async () => {}) };
    await expect(ledger.read('known', io)).rejects.toThrow('byte-limit');
    expect(io.readChunk).not.toHaveBeenCalled(); expect(io.close).toHaveBeenCalledOnce();
  });
  it('records pending access before the reader runs and stops after a simulated process loss', async () => {
    const store = durableStore(), first = await openPreparationLedger(config, { store }), io = input('known');
    io.readChunk.mockImplementation(async () => {
      const durable = await store.load(config.attemptId);
      expect(durable?.snapshot.pending?.path).toBe('known');
      const recovered = await openPreparationLedger(config, { store }), retry = input('known');
      await expect(recovered.read('known', retry)).rejects.toThrow('interrupted-read');
      expect(retry.stat).not.toHaveBeenCalled();
      return Buffer.from('abc');
    });
    // Recovery persists a terminal stop; the original in-flight writer must
    // lose its revision rather than overwrite that stop with a successful read.
    await expect(first.read('known', io)).rejects.toThrow('attempt-state-conflict');
    expect((await store.load(config.attemptId))?.snapshot).toMatchObject({
      status: 'STOPPED', reason: 'interrupted-read', byteAccounting: 'unknown',
    });
  });
  it('charges durable-store waits to the global deadline before payload access', async () => {
    let at = 0;
    const store = durableStore(), original = store.compareAndSwap.getMockImplementation()!;
    const first = await openPreparationLedger({ ...config, maxElapsedMs: 10 }, { store, now: () => at });
    store.compareAndSwap.mockImplementation(async (...args) => { const result = await original(...args); at = 10; return result; });
    const io = input('known'); await expect(first.read('known', io)).rejects.toThrow('elapsed-limit');
    expect(io.stat).not.toHaveBeenCalled();
  });
  it('does not let caller mutation promote the next refused input into the baseline', async () => {
    const mutable = { ...config, baseline: [...config.baseline], priorAdditions: [...prefix] };
    const ledger = createPreparationLedger(mutable), io = input('loader61');
    mutable.baseline.push('loader61'); mutable.priorAdditions.length = 0;
    await expect(ledger.read('loader61', io)).rejects.toThrow('input-limit');
    expect(io.stat).not.toHaveBeenCalled(); expect(ledger.snapshot().additions).toEqual(prefix);
  });
  it('treats object-prototype names as ordinary input identities across persistence', async () => {
    const options = { ...config, bound: 61 };
    let ledger = createPreparationLedger(options);
    await ledger.read('__proto__', input('__proto__'));
    ledger = createPreparationLedger(options, { snapshot: ledger.snapshot() });
    await ledger.read('__proto__', input('__proto__'));
    expect(Object.keys(ledger.snapshot().digests)).toEqual(['__proto__']);
    expect(ledger.snapshot().bytesRead).toBe(6);
  });
  it('refuses an oversized input before payload access', async () => {
    const ledger = createPreparationLedger({ ...config, maxInputBytes: 2 }), io = input('known');
    await expect(ledger.read('known', io)).rejects.toThrow('byte-limit'); expect(io.readChunk).not.toHaveBeenCalled();
  });
  it('retains global elapsed time across metadata waits, restart and terminal retries', async () => {
    let at = 100;
    let ledger = createPreparationLedger({ ...config, maxElapsedMs: 10 }, { now: () => at });
    const io = input('known'); io.stat.mockImplementation(async () => { at = 110; return { size: 3, identity: 'fixture', canonicalPath: 'known' }; });
    await expect(ledger.read('known', io)).rejects.toThrow('elapsed-limit');
    expect(io.readChunk).not.toHaveBeenCalled();
    ledger = createPreparationLedger({ ...config, maxElapsedMs: 10 }, { now: () => at, snapshot: ledger.snapshot() });
    await expect(ledger.read('known', input('known'))).rejects.toThrow('elapsed-limit');
    expect(ledger.snapshot().startedAtMs).toBe(100);
  });
  it('debits completed chunks, stops an interrupted reader and refuses further I/O after restore', async () => {
    const ledger = createPreparationLedger(config), io = input('known', 'x'.repeat(65537));
    io.readChunk.mockImplementation(async ({ offset }) => { if (offset) throw new Error('read-interrupted'); return Buffer.alloc(65536); });
    await expect(ledger.read('known', io)).rejects.toThrow('read-interrupted');
    expect(ledger.snapshot().bytesRead).toBe(65536); expect(ledger.snapshot().byteAccounting).toBe('unknown');
    const resumed = createPreparationLedger(config, { snapshot: ledger.snapshot() }), next = input('known');
    await expect(resumed.read('known', next)).rejects.toThrow('read-interrupted'); expect(next.stat).not.toHaveBeenCalled();
  });
  it('stops a snapshot of an in-flight read instead of resetting the interrupted access', async () => {
    const ledger = createPreparationLedger(config), io = input('known');
    const saved: ReturnType<typeof ledger.snapshot>[] = [];
    io.readChunk.mockImplementation(async () => { saved.push(ledger.snapshot()); return Buffer.from('abc'); });
    await ledger.read('known', io);
    const resumed = createPreparationLedger(config, { snapshot: saved[0] }), next = input('known');
    await expect(resumed.read('known', next)).rejects.toThrow('interrupted-read');
    expect(next.stat).not.toHaveBeenCalled(); expect(resumed.report().byteAccounting).toBe('unknown');
  });
  it.each(['bounded-read', 'metadata-drift', 'metadata-alias', 'clock-backwards'])('stops on %s and refuses retries', async fault => {
    let at = 100;
    const ledger = createPreparationLedger(config, { now: () => at }), io = input('known');
    if (fault === 'bounded-read') io.readChunk.mockResolvedValue(Buffer.from('toolong'));
    if (fault === 'metadata-drift') io.stat.mockResolvedValueOnce({ size: 3, identity: 'before', canonicalPath: 'known' });
    if (fault === 'metadata-alias') io.stat.mockResolvedValue({ size: 3, identity: 'before', canonicalPath: 'different' });
    if (fault === 'clock-backwards') at = 99;
    await expect(ledger.read('known', io)).rejects.toThrow();
    const next = input('known'); await expect(ledger.read('known', next)).rejects.toThrow();
    expect(next.stat).not.toHaveBeenCalled(); expect(ledger.report().status).toBe('STOPPED');
  });
  it('rejects source drift and a forged byte counter rather than upgrading a receipt', async () => {
    const ledger = createPreparationLedger(config);
    await ledger.read('known', input('known', 'abc'));
    await expect(ledger.read('known', input('known', 'xyz'))).rejects.toThrow('input-digest-drift');
    expect(ledger.report()).toMatchObject({ receipt: false, executionAdmitted: false, fullClosureQualified: false });
    const saved = ledger.snapshot(); saved.bytesRead = 0;
    expect(() => createPreparationLedger(config, { snapshot: saved })).toThrow('snapshot/configuration');
  });
  it('requires a call/function/span/hash/candidate witness, not a journal citation or changed source', () => {
    const unit = censusSites('fixture.ts', 'function preflight(){ journal(); buildPrivateBundle(); }');
    const call = unit.sites.find(site => site.expression === 'buildPrivateBundle')!;
    const pin = { candidate: 'fixture', expectedCandidate: 'fixture', sourceSha256: unit.sha256,
      start: call.start, end: call.end, expression: 'buildPrivateBundle', functionName: 'preflight' };
    expect(verifyPreparationCitation(unit, pin)).toBe(true);
    const journal = unit.sites.find(site => site.expression === 'journal')!;
    expect(verifyPreparationCitation(unit, { ...pin, start: journal.start, end: journal.end })).toBe(false);
    expect(verifyPreparationCitation(censusSites('fixture.ts', 'function preflight(){ changed(); }'), pin)).toBe(false);
    expect(verifyPreparationCitation(unit, { ...pin, candidate: 'other' })).toBe(false);
  });
  it('keeps ambiguous targets and refuses config/version-only artifacts, missing custody and dirty source', () => {
    const result = preparationDisposition({ candidate: 'fixture', expectedCandidate: 'fixture', targetCandidates: ['hono/esm', 'hono/cjs'] });
    expect(result).toMatchObject({ status: 'BLOCKED', targetCandidates: ['hono/esm', 'hono/cjs'], currentGuardPassed: false });
    expect(result.residue).toEqual(['target-ambiguous', 'actual-artifact-unbound', 'custody-unverified', 'source-not-current']);
    expect(preparationDisposition({ candidate: 'fixture', expectedCandidate: 'fixture', targetCandidates: ['esm'],
      actualArtifactSha256: 'esbuild-0.25.0', expectedArtifactSha256: 'esbuild-0.25.0', custodyVerified: true, sourceCurrent: true }).residue).toContain('actual-artifact-unbound');
    expect(preparationDisposition({ candidate: 'fixture', expectedCandidate: 'fixture', targetCandidates: ['esm'],
      actualArtifactSha256: 'a'.repeat(64), expectedArtifactSha256: 'a'.repeat(64), custodyVerified: true, sourceCurrent: true })).toMatchObject({
      status: 'PARTIAL-source-preparation', receipt: false, fullClosureQualified: false, currentGuardPassed: false, executionAdmitted: false,
    });
  });
});
