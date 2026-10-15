/**
 * seed-provider-corestore.test.ts — the corestore SeedProvider (P-003).
 *
 * Proves the load-bearing properties with a REAL corestore (no network, no PG):
 *  - cut → restore PRE-POSITIONS an admitted log's blocks so a fresh peer reads
 *    them OFFLINE, and subsequent replication transfers ONLY the delta;
 *  - restore does NOT collide the joiner's own log key (no primary-key leak);
 *  - restore is idempotent;
 *  - verify fails closed on a hash mismatch.
 *
 * Mirrors peer-log.test.ts resource hygiene: every tmp dir + store torn down in
 * afterEach so a thrown assertion can't leak a dir or an open store.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Corestore from 'corestore';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadSodium, encodeOpAAD } from './hive-epoch-aead';
import { openOwnLog, type PeerLogOp } from './peer-log';
import {
  createCorestoreSeedProvider,
  captureSeedUuidOriginalSpan,
  exportSeedUuidIdempotencySource,
  CORESTORE_SEED_KIND,
  isExternalTriggerEnvelope,
  mintFilteredSeedContentCore,
  redactSeedValue,
  SEED_EXCLUDED_TABLES,
  SEED_REDACT_IN_PLACE_TABLES,
  seedSnapshotValueTransform,
  valueCarriesSeedIdentity,
  type SeedUuidIdempotencyDropPlan,
} from './seed-provider-corestore';
import { buildSnapshotChunkOp, DROP_SNAPSHOT_ROW, foldFilteredSnapshotRows, produceLogSnapshot, SNAPSHOT_TABLE_TAG, type SnapshotRow } from './log-snapshot';

const cleanups: Array<() => void | Promise<void>> = [];
const NEVER_EMIT_MARKER = 'never-emit-me';

describe('D-174 original signed snapshot-span census', () => {
  const row = (hbKey: string, value: unknown): PeerLogOp => ({ type: 'put', table: 'harness_plans',
    hbKey, value, author_pubkey: '', ts: 1, schema_version: 1 });
  it('matches the from-zero winner/disposition census and omits a superseded prefix sentinel from both outputs', async () => {
    const source = makeStore(tmpDir('span-source-')); await source.ready();
    const own = await openOwnLog(source);
    await own.append(row('safe', { body: 'superseded-prefix-sentinel' }));
    await own.append(row('safe', { body: 'public' }));
    await own.append(row('redact', { contact: 'fixture@example.org' }));
    await own.append(row('drop', { body: 'fixture-private-owner' }));
    const seedIndex = own.length;
    await produceLogSnapshot(own, { now: 1000, schemaVersion: 1, maxChunkBytes: 100 });
    await own.append(row('tail', { public: true }));
    const dir = tmpDir('span-private-'); chmodSync(dir, 0o700);
    const exported = await exportSeedUuidIdempotencySource({ sourceStore: source, sourceKeyHex: own.keyHex,
      sourceLength: own.length, outputDir: dir, segment: 'segment-000001.blob', now: 1000,
      redactValues: ['fixture-private-owner'] });
    const full = await foldFilteredSnapshotRows(own, { now: 1000, excludeTables: SEED_EXCLUDED_TABLES, priorSnapshotHint: null });
    const fullProjected = await foldFilteredSnapshotRows(own, { now: 1000, excludeTables: SEED_EXCLUDED_TABLES,
      priorSnapshotHint: null, transformValue: seedSnapshotValueTransform(['fixture-private-owner']).transform });
    const projected = new Map(fullProjected.rows.map(r => [JSON.stringify([r.table, r.hbKey]), r]));
    const originalRows = readFileSync(exported.rowsPath, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(originalRows.map(({ segment, line, storedValueJson, privacyProjection, ...r }) => r)).toEqual(full.rows);
    expect(exported.sourceInput.winners).toEqual(full.rows.map(r => ({ table: r.table, hbKey: r.hbKey,
      disposition: !projected.has(JSON.stringify([r.table, r.hbKey])) ? 'drop'
        : JSON.stringify(projected.get(JSON.stringify([r.table, r.hbKey]))!.value) === JSON.stringify(r.value) ? 'carry' : 'redact' })));
    expect(exported.sourceInput).toMatchObject({ coverage: 'complete-snapshot-set + tail', seedIndex,
      coversUpTo: seedIndex, omittedPrefixBlocks: seedIndex, sourceBlocksRead: own.length - seedIndex, foldNow: 1000 });
    expect(exported.sourceInput.snapshotSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exported.sourceInput.proofInventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(originalRows) + JSON.stringify(fullProjected.rows)).not.toContain('superseded-prefix-sentinel');
    const replicaDir = join(dir, 'original-span');
    const captured = await captureSeedUuidOriginalSpan({ sourceStore: source, sourceKeyHex: own.keyHex,
      sourceInput: exported.sourceInput, replicaDir });
    expect(captured).toEqual({ sourceHead: exported.sourceInput.sourceHead,
      proofInventorySha256: exported.sourceInput.proofInventorySha256, sourceBlocksRead: exported.sourceBlocksRead });
    const replicaStore = new Corestore(replicaDir, { readOnly: true, wait: false });
    cleanups.push(() => replicaStore.close()); await replicaStore.ready();
    const replicaExport = await exportSeedUuidIdempotencySource({ sourceStore: replicaStore, sourceKeyHex: own.keyHex,
      sourceLength: own.length, outputDir: dir, segment: 'segment-000003.blob', now: 1000,
      redactValues: ['fixture-private-owner'] });
    expect(replicaExport.sourceInput).toEqual(exported.sourceInput);
    expect(readFileSync(replicaExport.rowsPath, 'utf8').trim().split('\n')
      .map(text => { const { segment, ...r } = JSON.parse(text); return r; }))
      .toEqual(originalRows.map(({ segment, ...r }) => r));
    await expect(captureSeedUuidOriginalSpan({ sourceStore: source, sourceKeyHex: own.keyHex,
      sourceInput: { ...exported.sourceInput, proofInventorySha256: '00'.repeat(32) }, replicaDir: join(dir, 'bad-replica') }))
      .rejects.toThrow(/inventory/);
    expect(readdirSync(dir)).not.toContain('bad-replica');
    const target = makeStore(tmpDir('span-target-')); await target.ready();
    const plan: SeedUuidIdempotencyDropPlan = { schema: 'papercusp-uuid-idempotency-row-drop-plan-v1',
      reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166', sourceKeyHex: own.keyHex,
      sourceLength: own.length, rows: [], sourceInput: exported.sourceInput };
    const minted = await mintFilteredSeedContentCore({ sourceStore: source, stagingStore: target,
      ownerKeyHex: own.keyHex, uuidIdempotencyDropPlan: plan, redactValues: ['fixture-private-owner'], onProjection: vi.fn() });
    const output = await exportSeedUuidIdempotencySource({ sourceStore: target, sourceKeyHex: minted.keyHex,
      sourceLength: minted.length, outputDir: dir, segment: 'segment-000002.blob', now: 1000 });
    const emitted = readFileSync(output.rowsPath, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(emitted.map(({ segment, line, storedValueJson, privacyProjection, ...r }) => r)).toEqual(fullProjected.rows);
    expect(JSON.stringify(emitted)).not.toContain('superseded-prefix-sentinel');
    for (const sourceInput of [{ ...exported.sourceInput, sourceBlocksRead: exported.sourceBlocksRead + 1 },
      { ...exported.sourceInput, winners: exported.sourceInput.winners.slice(1) },
      { ...exported.sourceInput, sourceHead: { ...exported.sourceInput.sourceHead, treeHash: '00'.repeat(32) } }]) {
      await expect(mintFilteredSeedContentCore({ sourceStore: source, stagingStore: target, ownerKeyHex: own.keyHex,
        uuidIdempotencyDropPlan: { ...plan, sourceInput }, redactValues: ['fixture-private-owner'], onProjection: vi.fn() }))
        .rejects.toThrow(/census\/producer/);
    }
  });

  for (const earlier of [true, false]) {
    it(`keeps exact coverage after a torn newest set falls back ${earlier ? 'to an earlier complete set' : 'to zero'}`, async () => {
      const source = makeStore(tmpDir('span-torn-')); await source.ready();
      const own = await openOwnLog(source); await own.append(row('safe', { public: true }));
      if (earlier) await produceLogSnapshot(own, { now: 1000, schemaVersion: 1 });
      const completeIndex = earlier ? 1 : 0;
      await own.append(buildSnapshotChunkOp({ rows: [], coversUpTo: own.length, chunkCount: 2,
        chunkIdx: 0, author_pubkey: own.keyHex, ts: 1000, schema_version: 1 }));
      await own.append(row('tail', { public: true }));
      const dir = tmpDir('span-torn-private-'); chmodSync(dir, 0o700);
      const exported = await exportSeedUuidIdempotencySource({ sourceStore: source, sourceKeyHex: own.keyHex,
        sourceLength: own.length, outputDir: dir, segment: 'segment-000001.blob', now: 1000 });
      expect(exported.sourceInput.seedIndex).toBe(completeIndex);
      expect(exported.sourceBlocksRead).toBe(own.length - completeIndex);
      expect(exported.sourceInput.coverage).toBe(earlier ? 'complete-snapshot-set + tail' : 'full-log');
    });
  }
});

describe('D-166 source-bound UUID output row drops', () => {
  for (const priorSnapshot of [false, true]) {
    it(`independently validates UUID and ordinary privacy partitions (${priorSnapshot ? 'prior snapshot' : 'raw ops'})`, async () => {
      const source = makeStore(tmpDir('uuid-privacy-source-')); await source.ready();
      const target = makeStore(tmpDir('uuid-privacy-target-')); await target.ready();
      const own = await openOwnLog(source);
      const sodium = await loadSodium(); const key = Buffer.alloc(32); sodium.randombytes_buf(key);
      const row = (table: string, hbKey: string, value: unknown): PeerLogOp => ({
        type: 'put', table, hbKey, value, author_pubkey: '', ts: 1, schema_version: 1,
      });
      const seal = (hbKey: string, value: unknown): PeerLogOp => {
        const op = row('harness_plans', hbKey, value);
        const opId = createHash('sha256').update(JSON.stringify([op.table, hbKey, ''])).digest('hex');
        const nonce = Buffer.alloc(24); sodium.randombytes_buf(nonce);
        const plain = Buffer.from(JSON.stringify(value)); const cipher = Buffer.alloc(plain.length + 16);
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, plain,
          encodeOpAAD({ potId: 'fixture-pot', epoch: 0, opId }), null, nonce, key);
        return { ...op, epoch: 0, value: { __rekey: Buffer.concat([nonce, cipher]).toString('base64') } };
      };
      const literal = 'private-fixture-owner';
      const token = ['48a1c70f', 'a4cb', '4fa8', '8be7', 'd26eca349d80'].join('-');
      const ops = [seal('uuid-drop', { idempotencyKey: token }), seal('auth-keep', { safe: 'unchanged' }),
        seal(literal, { safe: 'private address' }), row('harness_plans', 'private-content', { body: literal }),
        row('harness_plans', 'external', { source: 'mail', event: 'x', dedupeKey: 'mail:1:x', adapterPayload: { raw: 1 } }),
        row('hive-members', '42', { github_username: literal }),
        row('harness_plans', 'email', { contact: 'fixture@example.org' }),
        row('harness_plans', 'public', { safe: 'public' }),
        row('harness_plans', 'overlap', { idempotencyKey: token, body: literal })];
      for (const op of ops) await own.append(op);
      if (priorSnapshot) await produceLogSnapshot(own, { now: 1000, schemaVersion: 1 });
      const before = own.length; const first = JSON.stringify(await own.get(0));
      const dir = tmpDir('uuid-privacy-private-'); chmodSync(dir, 0o700);
      const exported = await exportSeedUuidIdempotencySource({ sourceStore: source, sourceKeyHex: own.keyHex,
        sourceLength: before, outputDir: dir, segment: 'segment-000001.blob', redactValues: [literal] });
      const originalRows = readFileSync(exported.rowsPath, 'utf8').trim().split('\n').map(text => JSON.parse(text));
      expect(originalRows.filter(r => r.privacyProjection.disposition === 'drop')).toHaveLength(4);
      const keysPath = join(dir, 'keys.json'); const keys = JSON.stringify({ 'fixture-pot': { 0: key.toString('base64') } });
      writeFileSync(keysPath, keys, { mode: 0o600 });
      const configPath = join(dir, 'config.json'); const planPath = join(dir, 'plan.json');
      writeFileSync(configPath, JSON.stringify({ reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
        potId: 'fixture-pot', epochKeysPath: keysPath, epochKeysSha256: createHash('sha256').update(keys).digest('hex'),
        sources: [exported] }), { mode: 0o600 });
      const formatter = join(import.meta.dirname, '../../../../../papercusp-desktop/bin/lib/print-gitleaks-findings.py');
      const assembled = spawnSync('python3', [formatter, '--assemble-uuid-row-drops', configPath, planPath],
        { encoding: 'utf8', timeout: 30_000 });
      expect(assembled.status, assembled.stderr).toBe(0);
      const packet = JSON.parse(readFileSync(planPath, 'utf8'));
      expect(packet.counts).toMatchObject({ originalRows: 9, originalAuthenticated: 3, droppedRows: 2,
        droppedAuthenticated: 1, privacyDroppedRows: 3, privacyDroppedAuthenticated: 1,
        privacyRedactedPlaintext: 2, authenticatedOriginalRetained: 1, redactedReattested: 0 });
      const minted = await mintFilteredSeedContentCore({ sourceStore: source, ownerKeyHex: own.keyHex,
        stagingStore: target, redactValues: [literal], uuidIdempotencyDropPlan: packet.plans[0], onProjection: vi.fn() });
      expect(minted.rowCount).toBe(4);
      const output = await exportSeedUuidIdempotencySource({ sourceStore: target, sourceKeyHex: minted.keyHex,
        sourceLength: minted.length, outputDir: dir, segment: 'segment-000002.blob', redactValues: [literal] });
      const outputPath = join(dir, 'output.json'); const manifestPath = join(dir, 'manifest.json');
      writeFileSync(outputPath, JSON.stringify([{ ...output, sourceKeyHex: own.keyHex }]), { mode: 0o600 });
      writeFileSync(manifestPath, JSON.stringify({ reports: [minted.projection.uuidIdempotencyRedaction] }), { mode: 0o600 });
      const validation = spawnSync('python3', ['-c', String.raw`
import importlib.util,json,sys,pathlib,copy
s=importlib.util.spec_from_file_location('f',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
base=pathlib.Path(sys.argv[2]);config=base/'config.json';plan=json.loads((base/'plan.json').read_text())
outputs=json.loads((base/'output.json').read_text());reports=json.loads((base/'manifest.json').read_text())['reports']
def valid():return m.validate_uuid_idempotency_row_drops(config,plan,outputs,reports,[base/'manifest.json'])
assert valid()['counts']==plan['counts']
file=pathlib.Path(outputs[0]['rowsPath']);saved=file.read_bytes();rows=[json.loads(t) for t in saved.decode().splitlines()]
def refused(fn):
 try:fn();raise AssertionError('invalid privacy partition passed')
 except ValueError:pass
def changed(new):
 file.write_text(''.join(json.dumps(r)+'\n' for r in new));outputs[0]['rowsSha256']=m._sha256(file);outputs[0]['rowCount']=len(new);valid()
refused(lambda:changed(rows[:-1]))
bad=copy.deepcopy(rows);bad[0]['author_pubkey']='changed';refused(lambda:changed(bad))
bad=copy.deepcopy(rows);next(r for r in bad if r['hbKey']=='email')['value']={'contact':'altered'};refused(lambda:changed(bad))
originals=[json.loads(t) for t in pathlib.Path(plan['privateSourceBindings']['sources'][0]['rowsPath']).read_text().splitlines()]
private=next(r for r in originals if r['hbKey']=='private-content');refused(lambda:changed([*rows,private]))
sealed=next(r for r in originals if r.get('epoch')==0);sealed['privacyProjection']={'disposition':'redact','value':{}}
refused(lambda:m._uuid_privacy_projection(sealed,True))
file.write_bytes(saved);outputs[0]['rowsSha256']=m._sha256(file);outputs[0]['rowCount']=len(rows);assert valid()['rawClassHits']==0
print(json.dumps({'verified':True,'negativeControls':5}))
`, formatter, dir], { encoding: 'utf8', timeout: 30_000 });
      expect(validation.status, validation.stderr).toBe(0);
      expect(JSON.parse(validation.stdout)).toEqual({ verified: true, negativeControls: 5 });
      expect(assembled.stdout + assembled.stderr + validation.stdout + validation.stderr).not.toContain(token);
      expect(own.length).toBe(before); expect(JSON.stringify(await own.get(0))).toBe(first);
    });
  }

  it('assembles an authenticated plan from a real Hypercore export and applies it to a new read-only core', async () => {
    const source = makeStore(tmpDir('uuid-census-crypto-source-')); await source.ready();
    const target = makeStore(tmpDir('uuid-census-crypto-target-')); await target.ready();
    const own = await openOwnLog(source);
    const sodium = await loadSodium();
    const key = Buffer.alloc(32); sodium.randombytes_buf(key);
    const seal = (hbKey: string, value: unknown): PeerLogOp => {
      const row = { type: 'put' as const, table: 'harness_plans', hbKey, author_pubkey: '',
        epoch: 0, ts: 1, schema_version: 1 };
      const opId = createHash('sha256').update(JSON.stringify([row.table, hbKey, ''])).digest('hex');
      const nonce = Buffer.alloc(24); sodium.randombytes_buf(nonce);
      const plain = Buffer.from(JSON.stringify(value)); const cipher = Buffer.alloc(plain.length + 16);
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, plain,
        encodeOpAAD({ potId: 'fixture-pot', epoch: 0, opId }), null, nonce, key);
      return { ...row, value: { __rekey: Buffer.concat([nonce, cipher]).toString('base64') } };
    };
    const refusedValue = ['6063cec6', 'f2df', '44d5', '8f67', 'd2d359ce7a23'].join('-');
    const dropped = seal('drop', { idempotencyKey: refusedValue });
    const retained = seal('keep', { public: 'unchanged' });
    await own.append(dropped); await own.append(retained);
    const original = await own.get(0);
    const dir = tmpDir('uuid-census-crypto-private-'); chmodSync(dir, 0o700);
    const exported = await exportSeedUuidIdempotencySource({ sourceStore: source, sourceKeyHex: own.keyHex,
      sourceLength: own.length, outputDir: dir, segment: 'segment-000001.blob' });
    const keysPath = join(dir, 'epoch-keys.json');
    const keys = JSON.stringify({ 'fixture-pot': { 0: key.toString('base64') } });
    writeFileSync(keysPath, keys, { mode: 0o600 });
    const configPath = join(dir, 'config.json'); const planPath = join(dir, 'plans.json');
    writeFileSync(configPath, JSON.stringify({ reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
      potId: 'fixture-pot', epochKeysPath: keysPath,
      epochKeysSha256: createHash('sha256').update(keys).digest('hex'), sources: [exported] }), { mode: 0o600 });
    const assembler = spawnSync('python3', [join(import.meta.dirname, '../../../../../papercusp-desktop/bin/lib/print-gitleaks-findings.py'),
      '--assemble-uuid-row-drops', configPath, planPath], { encoding: 'utf8', timeout: 30_000 });
    expect(assembler.status, assembler.stderr).toBe(0);
    expect(assembler.stdout + assembler.stderr).not.toContain(refusedValue);
    const packet = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(packet.counts).toMatchObject({ originalAuthenticated: 2, droppedAuthenticated: 1,
      authenticatedOriginalRetained: 1, redactedReattested: 0, occurrenceCount: 1 });
    const minted = await mintFilteredSeedContentCore({ sourceStore: source, ownerKeyHex: own.keyHex,
      stagingStore: target, redactValues: [], uuidIdempotencyDropPlan: packet.plans[0], onProjection: vi.fn() });
    expect(minted.rowCount).toBe(1);
    const output = target.get({ key: Buffer.from(minted.keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore & { writable: boolean }; await output.ready();
    expect(output.writable).toBe(false);
    const block = await output.get(0) as { value: { rows: PeerLogOp[] } };
    expect(block.value.rows[0]).toMatchObject({ hbKey: 'keep', value: retained.value, author_pubkey: '', epoch: 0 });
    expect(JSON.stringify(block)).not.toContain((dropped.value as { __rekey: string }).__rekey);
    expect(await own.get(0)).toEqual(original); expect(own.length).toBe(2);
  });

  it('exports actual local source blocks into a private immutable census with original headers and ciphertext', async () => {
    const source = makeStore(tmpDir('seed-uuid-export-'));
    await source.ready();
    const own = await openOwnLog(source);
    const encrypted = { __rekey: 'synthetic-framing-only-assembler-must-authenticate' };
    const row: PeerLogOp = { type: 'put', table: 'harness_plans', hbKey: 'row', ts: 1,
      schema_version: 1, epoch: 0, author_pubkey: '', value: encrypted };
    await own.append(row);
    await own.append({ ...row, hbKey: 'discarded', value: { obsolete: true } });
    await own.append({ ...row, type: 'del', hbKey: 'discarded', value: undefined });
    const before = await own.get(0);
    const dir = tmpDir('seed-uuid-export-files-'); chmodSync(dir, 0o700);
    const input = { sourceStore: source, sourceKeyHex: own.keyHex, sourceLength: own.length,
      outputDir: dir, segment: 'segment-000001.blob', now: 1 };
    const exported = await exportSeedUuidIdempotencySource(input);
    const bytes = readFileSync(exported.rowsPath);
    const rows = bytes.toString().trim().split('\n').map(text => JSON.parse(text));
    expect(exported.sourceBlocksRead).toBe(3);
    expect(exported.rowsSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(rows.find(r => r.hbKey === 'row')).toMatchObject({ author_pubkey: '', epoch: 0, value: encrypted,
      segment: input.segment, storedValueJson: JSON.stringify(encrypted) });
    expect(rows.find(r => r.hbKey === 'discarded')).toMatchObject({ deleted: true, value: null });
    expect(rows.every((r, index) => r.line === index + 1)).toBe(true);
    expect(statSync(exported.rowsPath).mode & 0o077).toBe(0);
    expect(own.length).toBe(3); expect(await own.get(0)).toEqual(before);
    await expect(exportSeedUuidIdempotencySource(input)).rejects.toThrow('EEXIST');
    await expect(exportSeedUuidIdempotencySource({ ...input, sourceLength: 2 })).rejects.toThrow('head changed');
    chmodSync(dir, 0o755);
    await expect(exportSeedUuidIdempotencySource({ ...input, segment: 'segment-000002.blob' })).rejects.toThrow('private');
  });

  const sourceKeyHex = 'ab'.repeat(32);
  const value = { ciphertext: 'unchanged-authenticated-envelope', originalSignature: 'original-auth' };
  const valueHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const plan = (): SeedUuidIdempotencyDropPlan => ({
    schema: 'papercusp-uuid-idempotency-row-drop-plan-v1',
    reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
    sourceKeyHex, sourceLength: 1,
    rows: [{ table: 'coord-messages', hbKey: 'message-1', valueSha256: valueHash(value),
      occurrences: [{ segment: 'segment-000104.blob', line: 17, fieldPath: ['body', 'idempotencyKey'] }] }],
  });
  const projection = (p = plan()) => seedSnapshotValueTransform([], { plan: p, ownerKeyHex: sourceKeyHex, sourceLength: 1 });

  it('drops only the bound complete row and emits value-free manifest with explicit dropped auth', () => {
    const p = projection();
    const clean = { body: 'unrelated content' };
    expect(p.transform(clean, { table: 'coord-messages', hbKey: 'message-2' })).toBe(clean);
    expect(p.transform(value, { table: 'coord-messages', hbKey: 'message-1' })).toBe(DROP_SNAPSHOT_ROW);
    // A duplicate scan visit must not inflate the unique row/occurrence counts.
    expect(p.transform(value, { table: 'coord-messages', hbKey: 'message-1' })).toBe(DROP_SNAPSHOT_ROW);
    p.finishUuidRedaction!();
    expect(p.stats.uuidIdempotencyRedaction).toMatchObject({ droppedRows: 1, occurrenceCount: 1,
      replacement: '<redacted:idempotency-key>', authenticationDisposition: 'dropped',
      ciphertextAuthentication: 'requires-independent-candidate-validation' });
    const report = JSON.stringify(p.stats.uuidIdempotencyRedaction);
    expect(report).not.toContain(valueHash(value));
    expect(report).not.toContain(value.ciphertext);
    expect(report).not.toContain(value.originalSignature);
    expect(report).not.toContain('message-1');
    expect(value.originalSignature).toBe('original-auth');
  });

  it('refuses changed values and missing targets rather than certifying a partial plan', () => {
    const p = projection();
    expect(() => p.transform({ ...value, ciphertext: 'changed' },
      { table: 'coord-messages', hbKey: 'message-1' })).toThrow('original value binding mismatch');
    expect(() => p.finishUuidRedaction!()).toThrow('missing targets');
  });

  it('refuses wrong source, wrong head, duplicate rows, duplicate locators and value-bearing locators', () => {
    const good = plan();
    for (const bad of [
      { ...good, sourceKeyHex: 'cd'.repeat(32) },
      { ...good, sourceLength: 2 },
      { ...good, rows: [good.rows[0]!, good.rows[0]!] },
      { ...good, rows: [{ ...good.rows[0]!, occurrences: [good.rows[0]!.occurrences[0]!, good.rows[0]!.occurrences[0]!] }] },
      { ...good, rows: [{ ...good.rows[0]!, occurrences: [{ segment: '../../value.blob', line: 1, fieldPath: ['idempotencyKey'] }] }] },
      { ...good, rows: [{ ...good.rows[0]!, occurrences: [{ segment: 'segment-000104.blob', line: 1,
        fieldPath: ['00000000-0000-4000-8000-000000000000'] }] }] },
    ]) expect(() => projection(bad)).toThrow();
  });

  it('refuses plans on unfiltered cuts and plans for an unrequested core', async () => {
    const provider = createCorestoreSeedProvider();
    const ctx = { coreKeys: [sourceKeyHex], uuidIdempotencyDropPlans: [plan()] };
    await expect(provider.cut(ctx as never)).rejects.toThrow('unique requested filtered source core');
    await expect(provider.cut({ ...ctx, filtered: true, coreKeys: [] } as never))
      .rejects.toThrow('unique requested filtered source core');
  });

  for (const priorSnapshot of [false, true]) {
    it(`mints read-only output without dropped rows/signatures and leaves source intact (${priorSnapshot ? 'prior snapshot' : 'raw ops'})`, async () => {
      const source = makeStore(tmpDir('seed-d166-source-'));
      const target = makeStore(tmpDir('seed-d166-target-'));
      await source.ready(); await target.ready();
      const own = await openOwnLog(source);
      const original: PeerLogOp = { type: 'put', table: 'coord-messages', hbKey: 'message-1', value,
        ts: 1, schema_version: 1, author_pubkey: own.keyHex };
      await own.append(original);
      await own.append({ ...original, hbKey: 'message-2', value: { body: 'keep-this' }, ts: 2 });
      if (priorSnapshot) await produceLogSnapshot(own, { now: 1000, schemaVersion: 1 });
      const before = own.length;
      const firstBlock = JSON.stringify(await own.get(0));
      const minted = await mintFilteredSeedContentCore({ sourceStore: source, stagingStore: target,
        ownerKeyHex: own.keyHex, redactValues: [], onProjection: () => {},
        uuidIdempotencyDropPlan: { ...plan(), sourceKeyHex: own.keyHex, sourceLength: before } });
      expect(own.length).toBe(before);
      expect(JSON.stringify(await own.get(0))).toBe(firstBlock);
      expect(minted.projection.uuidIdempotencyRedaction?.droppedRows).toBe(1);
      const replica = target.get({ key: Buffer.from(minted.keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore & { writable: boolean };
      await replica.ready();
      expect(replica.writable).toBe(false);
      let output = '';
      for (let i = 0; i < replica.length; i++) output += JSON.stringify(await replica.get(i, { wait: false }));
      expect(output).toContain('keep-this');
      expect(output).not.toContain('message-1');
      expect(output).not.toContain(value.originalSignature);
      expect(output).not.toContain(value.ciphertext);
    });
  }

  it('carries the value-free redaction report through the maintained provider manifest', async () => {
    const source = makeStore(tmpDir('seed-d166-provider-source-'));
    await source.ready();
    const own = await openOwnLog(source);
    const original: PeerLogOp = { type: 'put', table: 'coord-messages', hbKey: 'message-1', value,
      ts: 1, schema_version: 1, author_pubkey: own.keyHex };
    await own.append(original);
    await own.append({ ...original, hbKey: 'message-2', value: { body: 'keep-this' } });
    const result = await createCorestoreSeedProvider().cut({ sourceStore: source,
      stagingDir: tmpDir('seed-d166-provider-output-'), coreKeys: [own.keyHex], filtered: true,
      redactValues: [], onProjection: () => {}, uuidIdempotencyDropPlans: [
        { ...plan(), sourceKeyHex: own.keyHex, sourceLength: own.length },
      ] } as never);
    const reports = result.entry.meta?.uuidIdempotencyRedactions;
    expect(reports).toEqual([expect.objectContaining({ occurrenceCount: 1, droppedRows: 1,
      authenticationDisposition: 'dropped' })]);
    expect(JSON.stringify(reports)).not.toContain(valueHash(value));
    expect(JSON.stringify(reports)).not.toContain(value.originalSignature);
    expect(own.length).toBe(2);
  });

  it('refuses missing planned rows before replicating a partially certified output', async () => {
    const source = makeStore(tmpDir('seed-d166-missing-source-'));
    const target = makeStore(tmpDir('seed-d166-missing-target-'));
    await source.ready(); await target.ready();
    const own = await openOwnLog(source);
    await own.append({ type: 'put', table: 'coord-messages', hbKey: 'different-row', value,
      ts: 1, schema_version: 1, author_pubkey: own.keyHex });
    const onProjection = vi.fn();
    await expect(mintFilteredSeedContentCore({ sourceStore: source, stagingStore: target,
      ownerKeyHex: own.keyHex, redactValues: [], onProjection,
      uuidIdempotencyDropPlan: { ...plan(), sourceKeyHex: own.keyHex, sourceLength: own.length } }))
      .rejects.toThrow('missing targets');
    expect(onProjection).not.toHaveBeenCalled();
    expect(own.length).toBe(1);
  });
});

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* ignore teardown errors */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeStore(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => store.close());
  return store;
}

/** Recursively chmod a tree (files then dirs) — simulate a root-owned,
 *  read-only `/usr/lib/<Product>/seed` install. Registers a cleanup that
 *  restores writable perms FIRST (LIFO) so the tmpDir rmSync can delete it. */
function makeReadOnly(root: string): void {
  const walk = (dir: string, fileMode: number, dirMode: number, dirsFirst: boolean) => {
    const ents = readdirSync(dir, { withFileTypes: true });
    if (dirsFirst) chmodSync(dir, dirMode);
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, fileMode, dirMode, dirsFirst);
      else chmodSync(full, fileMode);
    }
    if (!dirsFirst) chmodSync(dir, dirMode);
  };
  // Restore-perms cleanup pushed BEFORE we lock down, so LIFO pops it first.
  cleanups.push(() => walk(root, 0o644, 0o755, true));
  walk(root, 0o444, 0o555, false); // files 0o444, dirs 0o555 (r-x, no write)
}

function op(i: number): PeerLogOp {
  return {
    type: 'put',
    table: 'harness_plans',
    hbKey: `P-${i}`,
    value: { id: `P-${i}` },
    ts: 100 + i,
    schema_version: 1,
    author_pubkey: 'ownerdev',
  };
}

/** `store.get()` is typed loosely upstream (`unknown`); narrow at the boundary. */
interface TestCore {
  readonly length: number;
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<void>;
  get(i: number, opts?: { wait?: boolean }): Promise<unknown>;
}

describe('corestore seed provider', () => {
  it('delivers bounded fold attribution through the default seed sink', async () => {
    const source = makeStore(tmpDir('seed-stall-source-'));
    const staging = makeStore(tmpDir('seed-stall-staging-'));
    await source.ready();
    await staging.ready();
    const own = await openOwnLog(source);
    await own.append({ ...op(0), value: { secret: NEVER_EMIT_MARKER } });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reportStall!: () => void;
    const reported = new Promise<void>((resolve) => { reportStall = resolve; });
    const errors = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (String(args[0]).includes('filtered source scan stalled')) reportStall();
    });
    const originalStoreGet = source.get.bind(source);
    const restoreReads: Array<() => void> = [];
    const storeReads = vi.spyOn(source, 'get').mockImplementation((...args) => {
      const result = originalStoreGet(...args);
      const core = result as unknown as TestCore;
      const originalCoreGet = core.get.bind(core);
      const coreReads = vi.spyOn(core, 'get').mockImplementation(async (index, options) => {
        await readGate;
        return originalCoreGet(index, options);
      });
      restoreReads.push(() => coreReads.mockRestore());
      return result;
    });
    let settled = false;
    const pending = mintFilteredSeedContentCore({
      sourceStore: source,
      ownerKeyHex: own.keyHex,
      stagingStore: staging,
      redactValues: [],
      filteredScanStallMs: 25,
      // This fixture gates EVERY core read until `releaseRead()`, and the prior-snapshot
      // seek reads before the fold does. Its production budget is minutes — deliberately,
      // since abandoning costs an O(history) fold — so it must be shrunk here or the seek
      // parks on the gate far past this test's timeout.
      seekReadBudgetMs: 5,
      onProjection: () => {},
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await reported;
      // Two distinct events, in order: the gated read first abandons the bounded seek
      // (which FALLS BACK to the full fold — the scan this test is actually about),
      // then that fold's cursor stalls on the very same gated read.
      expect(errors).toHaveBeenCalledTimes(2);
      expect(String(errors.mock.calls[0]![0])).toContain('prior-snapshot seek abandoned');
      const message = String(errors.mock.calls[1]![0]);
      for (const field of [
        '[seed:corestore]',
        'phase=filtered-source-scan',
        `core=${own.keyHex}`,
        'sourceStart=0',
        'sourceEnd=1',
        'cursor=0/1',
        'decodedOps=0',
        'decodedBytes=0',
        'stalledForMs=',
      ]) expect(message).toContain(field);
      expect(message).not.toContain(NEVER_EMIT_MARKER);
      expect(message.length).toBeLessThan(600);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(errors).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      releaseRead();
      expect((await pending).length).toBeGreaterThan(0);
    } finally {
      releaseRead();
      await pending;
      for (const restore of restoreReads) restore();
      storeReads.mockRestore();
      errors.mockRestore();
    }
  });

  it('cut → restore pre-positions blocks offline; replication carries only the delta; no own-log collision', async () => {
    // --- Peer A (owner): an admitted author log with 3 ops ---
    const dirA = tmpDir('seed-A-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    for (let i = 0; i < 3; i++) await logA.append(op(i));
    expect(logA.length).toBe(3);
    const keyHex = logA.keyHex;

    // --- CUT into a read-only replica (the seed payload) ---
    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir });
    expect(entry.kind).toBe(CORESTORE_SEED_KIND);
    expect((entry.meta as { coreLengths: Record<string, number> }).coreLengths[keyHex]).toBe(3);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);

    // --- VERIFY passes on the untouched payload ---
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // --- RESTORE into a fresh peer B's store dir ---
    const dirBroot = tmpDir('seed-B-');
    const targetStoreDir = join(dirBroot, 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });

    // --- B opens A's core by key OFFLINE: blocks are already present (seed) ---
    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(3); // length carried by the seed, no peer connected
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
    expect(await coreB.get(2, { wait: false })).toMatchObject({ hbKey: 'P-2' });

    // --- B's OWN log is unique (no primary-key collision with the seed/owner) ---
    const logB = await openOwnLog(storeB);
    expect(logB.length).toBe(0);
    expect(logB.keyHex).not.toBe(keyHex);

    // --- A appends the DELTA (2 more ops) → length 5 ---
    for (let i = 3; i < 5; i++) await logA.append(op(i));
    expect(logA.length).toBe(5);

    // --- Connect replication A <-> B; B fetches ONLY blocks 3..4 ---
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };
    const a = storeA.replicate(true) as unknown as Pipeable;
    const b = storeB.replicate(false) as unknown as Pipeable;
    (a as unknown as { on(e: string, cb: () => void): void }).on('error', () => {});
    (b as unknown as { on(e: string, cb: () => void): void }).on('error', () => {});
    a.pipe(b).pipe(a);
    cleanups.push(() => {
      a.destroy();
      b.destroy();
    });
    await coreB.update({ wait: true });
    expect(coreB.length).toBe(5);
    expect(await coreB.get(4, { wait: true })).toMatchObject({ hbKey: 'P-4' });
  });

  it('P-004 sparse cut ships only [snapshotIndex,len); restore materializes the suffix (no prefix, no hang)', async () => {
    // seed-history-trim-public-builds-2026-07-07 P-004: a public build ships the
    // current-state SUFFIX only. Build an owner log, compact it (a real
    // __snapshot__ set at the tail), append a post-snapshot delta, then cut
    // sparse. The seed must drop the summarized prefix [0,coversUpTo) yet stay
    // restorable OFFLINE — proving both the byte-trim and the restore-side
    // range-limit (a wrong restore that loops [0,len) with wait:true would HANG
    // on the absent prefix and fail this test by timeout).
    const dirA = tmpDir('seed-sparse-A-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    const PRE = 12;
    for (let i = 0; i < PRE; i++) await logA.append(op(i)); // [0,12) — the prefix to drop
    // Compact: appends a 1-chunk __snapshot__ set at index 12 (coversUpTo=12).
    const snap = await produceLogSnapshot(logA, { now: 1000, schemaVersion: 1 });
    expect(snap.appended).toBe(true);
    expect(snap.coversUpTo).toBe(PRE);
    const snapshotIdx = snap.coversUpTo; // 12 — the seed's expected sparse-from
    // Post-snapshot delta (still shipped, folds forward on the reader).
    for (let i = PRE; i < PRE + 2; i++) await logA.append(op(i));
    const fullLen = logA.length; // 12 prefix + snap.chunkCount + 2 tail
    const keyHex = logA.keyHex;

    const provider = createCorestoreSeedProvider();

    // --- SPARSE cut ---
    const sparseStage = tmpDir('seed-sparse-stage-');
    const { entry: sEntry, payload: sPayload } = await provider.cut({
      sourceStore: storeA,
      coreKeys: [keyHex],
      stagingDir: sparseStage,
      sparse: true,
    });
    const meta = sEntry.meta as { coreLengths: Record<string, number>; coreSparseFrom?: Record<string, number> };
    expect(meta.coreSparseFrom?.[keyHex]).toBe(snapshotIdx); // dropped [0,12)
    expect(meta.coreLengths[keyHex]).toBe(fullLen); // full authenticated length recorded
    expect(await provider.verify(sEntry, sPayload)).toEqual({ ok: true });

    // --- RESTORE the sparse seed into a fresh peer B, OFFLINE ---
    const targetStoreDir = join(tmpDir('seed-sparse-B-'), 'hyperbee');
    await provider.restore(sEntry, sPayload, { targetStoreDir }); // must not hang
    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(fullLen); // authenticated head length (whole log)
    // PREFIX dropped: summarized blocks are absent locally (offline → null).
    expect(await coreB.get(0, { wait: false })).toBeNull();
    expect(await coreB.get(snapshotIdx - 1, { wait: false })).toBeNull();
    // SUFFIX present: the snapshot op + the post-snapshot tail restored offline.
    expect(await coreB.get(snapshotIdx, { wait: false })).toMatchObject({ table: SNAPSHOT_TABLE_TAG });
    expect(await coreB.get(fullLen - 1, { wait: false })).toMatchObject({ hbKey: `P-${PRE + 1}` });

    // --- CONTRAST: a FULL cut of the SAME log ships the prefix too ---
    const fullStage = tmpDir('seed-full-stage-');
    const { entry: fEntry } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir: fullStage });
    expect((fEntry.meta as { coreSparseFrom?: unknown }).coreSparseFrom).toBeUndefined();
    const fullTarget = join(tmpDir('seed-full-B-'), 'hyperbee');
    await provider.restore(fEntry, { path: fullStage }, { targetStoreDir: fullTarget });
    const storeC = makeStore(fullTarget);
    await storeC.ready();
    const coreC = storeC.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreC.ready();
    expect(coreC.length).toBe(fullLen);
    expect(await coreC.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' }); // prefix PRESENT on a full seed
  });

  it('WI-37822 resolves a requested core from a sibling host for full, sparse, and filtered cuts', async () => {
    // The cut process has its own empty source store, while the requested admitted
    // log exists only in a sibling harness store. This models the separate CLI
    // process after remote-core-host's in-memory registry has been lost.
    const sourceStore = makeStore(tmpDir('seed-cross-process-source-'));
    await sourceStore.ready();

    const hostDir = tmpDir('seed-cross-process-host-');
    const hostStore = makeStore(hostDir);
    await hostStore.ready();
    const hostLog = await openOwnLog(hostStore);
    const prefixLength = 12;
    for (let i = 0; i < prefixLength; i++) await hostLog.append(op(i));
    const snapshot = await produceLogSnapshot(hostLog, { now: 1000, schemaVersion: 1 });
    expect(snapshot.appended).toBe(true);
    for (let i = prefixLength; i < prefixLength + 2; i++) await hostLog.append(op(i));
    const keyHex = hostLog.keyHex;
    const fullLength = hostLog.length;
    // A real sibling host is another process, so close this fixture's writable
    // handle before the provider opens the candidate read-only.
    await hostStore.close();
    const sourceStoreDirs = [hostDir];
    const provider = createCorestoreSeedProvider();

    const fullStage = tmpDir('seed-cross-process-full-stage-');
    const { entry: fullEntry, payload: fullPayload } = await provider.cut({
      sourceStore,
      sourceStoreDirs,
      coreKeys: [keyHex],
      stagingDir: fullStage,
    });
    const fullMeta = fullEntry.meta as { coreLengths: Record<string, number> };
    expect(fullMeta.coreLengths[keyHex]).toBe(fullLength);
    expect(await provider.verify(fullEntry, fullPayload)).toEqual({ ok: true });
    const fullTargetDir = join(tmpDir('seed-cross-process-full-target-'), 'hyperbee');
    await provider.restore(fullEntry, fullPayload, { targetStoreDir: fullTargetDir });
    const fullTarget = makeStore(fullTargetDir);
    await fullTarget.ready();
    const fullCore = fullTarget.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await fullCore.ready();
    expect(fullCore.length).toBe(fullLength);
    expect(await fullCore.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });

    const sparseStage = tmpDir('seed-cross-process-sparse-stage-');
    const { entry: sparseEntry, payload: sparsePayload } = await provider.cut({
      sourceStore,
      sourceStoreDirs,
      coreKeys: [keyHex],
      stagingDir: sparseStage,
      sparse: true,
    });
    const sparseMeta = sparseEntry.meta as { coreLengths: Record<string, number>; coreSparseFrom: Record<string, number> };
    expect(sparseMeta.coreSparseFrom[keyHex]).toBe(snapshot.coversUpTo);
    expect(sparseMeta.coreLengths[keyHex]).toBe(fullLength);
    const sparseTargetDir = join(tmpDir('seed-cross-process-sparse-target-'), 'hyperbee');
    await provider.restore(sparseEntry, sparsePayload, { targetStoreDir: sparseTargetDir });
    const sparseTarget = makeStore(sparseTargetDir);
    await sparseTarget.ready();
    const sparseCore = sparseTarget.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await sparseCore.ready();
    expect(await sparseCore.get(0, { wait: false })).toBeNull();
    expect(await sparseCore.get(snapshot.coversUpTo, { wait: false })).toMatchObject({ table: SNAPSHOT_TABLE_TAG });

    const filteredStage = tmpDir('seed-cross-process-filtered-stage-');
    const { entry: filteredEntry } = await provider.cut({
      sourceStore,
      sourceStoreDirs,
      coreKeys: [keyHex],
      stagingDir: filteredStage,
      filtered: true,
      onProjection: () => {},
    } as unknown as Parameters<typeof provider.cut>[0]);
    const filteredMeta = filteredEntry.meta as {
      coreKeys: string[];
      coreLengths: Record<string, number>;
      coreProjectedFrom?: Record<string, string>;
    };
    const filteredKeyHex = filteredMeta.coreKeys[0]!;
    expect(filteredKeyHex).not.toBe(keyHex);
    expect(filteredMeta.coreLengths[filteredKeyHex]).toBeGreaterThan(0);

    // WI-10001612 — the branch must RECORD that it minted a projection. seed-degradation-guard
    // exempts this population from the history size floor on exactly this fact; without it the
    // guard falls back to judging bytes and refuses a healthy cut (it did, 4.5 hours in, after
    // the block-count proxy that used to stand in for this fact expired at 1,041 blocks).
    expect(filteredMeta.coreProjectedFrom).toEqual({ [filteredKeyHex]: keyHex });
    // And the guard's falsifier is a REAL property of this branch, not an assumption: the
    // projection is minted into a fresh core, so the shipped key is never its own source.
    expect(filteredMeta.coreProjectedFrom![filteredKeyHex]).not.toBe(filteredKeyHex);
  });

  it('restore works from a READ-ONLY, moved seed (packaged-install regression, WI-2902)', async () => {
    // The real failure: a bundled seed is a COPY (built into the .deb, dpkg-extracted
    // to a root-owned read-only dir). corestore 7.x's storage guards every writable
    // open with a `device-file` (CORESTORE header + a `user.device-file` xattr); a copy
    // loses the xattr + changes the inode, so a default open throws "moved unsafely",
    // and the read-only dir also blocks the RocksDB LOCK/LOG. Both made every packaged
    // install log `restored=[]`. restore() must open the seed `readOnly` to dodge both.
    const dirA = tmpDir('seed-Aro-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    for (let i = 0; i < 2; i++) await logA.append(op(i));
    const keyHex = logA.keyHex;

    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stagero-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir });

    // Simulate the packaged install: lock the seed payload read-only.
    makeReadOnly(stagingDir);
    // Sanity: a DEFAULT (writable) open of the moved+read-only seed must fail — this is
    // exactly the bug. (If this ever stops throwing, the regression guard is moot.)
    await expect(
      (async () => {
        const bad = new Corestore(stagingDir);
        await bad.ready();
        const c = bad.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
        await c.ready();
        await bad.close();
      })(),
    ).rejects.toThrow();

    // The FIX: restore() opens the seed readOnly, so it succeeds from the locked dir.
    const targetStoreDir = join(tmpDir('seed-Bro-'), 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });

    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(2); // seeded blocks landed offline from the read-only seed
    expect(await coreB.get(1, { wait: false })).toMatchObject({ hbKey: 'P-1' });
    // Target store dir stays writable (restore never mutated the read-only seed).
    expect(statSync(targetStoreDir).isDirectory()).toBe(true);
  });

  it('restore is idempotent (re-running leaves the seeded core readable)', async () => {
    const dirA = tmpDir('seed-A2-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    await logA.append(op(0));
    const keyHex = logA.keyHex;

    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage2-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [keyHex], stagingDir });

    const targetStoreDir = join(tmpDir('seed-B2-'), 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });
    await provider.restore(entry, payload, { targetStoreDir }); // second run must not throw

    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(1);
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
  });

  it('verify fails closed on a hash mismatch', async () => {
    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-stage3-');
    writeFileSync(join(stagingDir, 'x'), 'some bytes');
    const bogus = {
      kind: CORESTORE_SEED_KIND,
      hash: 'deadbeef'.repeat(8),
      sizeBytes: 0,
      source: { type: 'resource' as const, path: stagingDir },
    };
    const res = await provider.verify(bogus, { path: stagingDir });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });

  it('EI-12881: a scrubbed/regenerated RocksDB info log does not break verify (it is not content identity)', async () => {
    // The 0.0.11 showstopper: the cut hashed the seed INCLUDING RocksDB's `LOG`,
    // then the WI-4736 identity scrub deleted it, so verify re-hashed a different
    // directory, failed closed, and every packaged install silently cold-pathed to
    // an EMPTY hive. RocksDB also rewrites `LOG` on EVERY store open, so a hash that
    // covers it can never be stable. All four states below must hash identically.
    const dirA = tmpDir('seed-log-A-');
    const storeA = makeStore(dirA);
    await storeA.ready();
    const logA = await openOwnLog(storeA);
    for (let i = 0; i < 3; i++) await logA.append(op(i));

    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('seed-log-stage-');
    const { entry, payload } = await provider.cut({ sourceStore: storeA, coreKeys: [logA.keyHex], stagingDir });
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    const dbDir = join(stagingDir, 'db');
    expect(statSync(dbDir).isDirectory()).toBe(true);

    // (a) a store re-open regenerated LOG — it leaks the build box's identity.
    // Derive the identity strings at runtime (never a literal in tracked source —
    // WI-4776) so the fixture faithfully mimics a real RocksDB LOG without shipping
    // one developer's home path inside the release source drop.
    writeFileSync(join(dbDir, 'LOG'), `Host name (Env): ${hostname()}\n${homedir()}/abs/path\n`);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // (b) plus a rotated LOG.old.<ts>
    writeFileSync(join(dbDir, 'LOG.old.1784143000'), 'rotated diagnostics\n');
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // (c) the release scrub removed both — this is what actually ships
    rmSync(join(dbDir, 'LOG'));
    rmSync(join(dbDir, 'LOG.old.1784143000'));
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // The numbered <NNN>.log WALs are DATA — they must still be covered, or the
    // exclusion above would blind the hash to real corruption.
    const wal = readdirSync(dbDir).find((f) => /^\d+\.log$/.test(f));
    expect(wal).toBeDefined();
    writeFileSync(join(dbDir, wal as string), 'corrupted wal bytes');
    const corrupted = await provider.verify(entry, payload);
    expect(corrupted.ok).toBe(false);
    expect(corrupted.reason).toMatch(/hash mismatch/);
  });

  it('verify fails when the payload path is missing', async () => {
    const provider = createCorestoreSeedProvider();
    const res = await provider.verify(
      { kind: CORESTORE_SEED_KIND, hash: 'x', sizeBytes: 0, source: { type: 'resource', path: '/no/such' } },
      { path: '/no/such/path/at/all' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/payload path missing/);
  });
});

/**
 * EI-20108164746219771 — the SERVER installer shipped the build box owner's identity,
 * because the seed corestore is a slice of the owner's LIVE log and that log carries
 * `presence` rows keyed `<github_user_id>/<machine_label>`.
 *
 * The fix makes the seed a PRODUCT rather than a slice: one filtered snapshot in a core
 * the owner never wrote.
 */
describe('mintFilteredSeedContentCore — the seed carries content, not the owner', () => {
  interface TestCore {
    readonly length: number;
    ready(): Promise<void>;
    get(
      i: number,
      opts: { wait: boolean },
    ): Promise<{
      value?: { rows?: { table: string; hbKey: string }[] };
    } | null>;
    readonly writable: boolean;
  }

  async function sourceWithIdentity() {
    const store = new Corestore(tmpDir('papercusp-seed-src-'));
    cleanups.push(() => store.close());
    await store.ready();
    const own = await openOwnLog(store);
    const privateEmail = `owner${'@'}example.org`;
    const privateHandle = ['avi', 'ynw'].join('');
    const op = (table: string, hbKey: string, value: unknown, ts: number): PeerLogOp => ({
      type: 'put',
      table,
      hbKey,
      value,
      ts,
      schema_version: 1,
      author_pubkey: own.keyHex,
    });
    await own.append(op('plans', 'p1', { title: 'intended content', owner: privateEmail, handle: privateHandle }, 1));
    // EI-22086776666843792 / D-002: p1 NAMES the handle, so the public projection drops the
    // whole row. p2 carries only an email SHAPE, which is redacted in place — the control
    // proving the row-drop is literal-driven, not "anything with an address".
    await own.append(op('plans', 'p2', { title: 'intended content', contact: privateEmail }, 1));
    // EI-20342237035251887: the real 0.0.17 cut failed on this exact class — an
    // included plan-parts row whose KEY (not value) named the build user. A key is an
    // address and cannot be rewritten safely, so the public projection drops the row.
    const privateKey = `p1/section:recon-against-${privateHandle}-restart`;
    await own.append(op('plan-parts', privateKey, { body: 'private build-box finding' }, 2));
    // Identity derived at RUNTIME — never a literal in tracked source (WI-4776). Writing
    // the real hostname in here would put the exact string this fix removes back into
    // shipped source and red the identity-lint gate.
    await own.append(
      op('presence', `${hostname()}`, { machine_label: hostname(), machine_user: userInfo().username }, 3),
    );
    await own.append(op('usage', 'u1', { tokens: 5 }, 4));
    // Match production: the source contains raw history PLUS a later head snapshot.
    // Both SnapshotRowFolder branches must apply the drop or the snapshot re-admits it.
    await produceLogSnapshot(own, { now: 1000, schemaVersion: 1 });
    return { store, own, privateEmail, privateHandle, privateKey };
  }

  async function stagingStore() {
    const store = new Corestore(tmpDir('papercusp-seed-staging-'));
    cleanups.push(() => store.close());
    await store.ready();
    return store;
  }

  function openReplica(store: Corestore, keyHex: string): TestCore {
    return store.get({
      key: Buffer.from(keyHex, 'hex'),
      valueEncoding: 'json',
    }) as unknown as TestCore;
  }

  it('redacts email values in encoded JSON while preserving opaque binary', () => {
    const privateEmail = `owner${'@'}example.org`;
    const encoded = Buffer.from(
      JSON.stringify({
        owner: privateEmail,
        nested: { contact: privateEmail },
      }),
    );

    expect(redactSeedValue(encoded)).toEqual({
      owner: '[email]',
      nested: { contact: '[email]' },
    });

    const opaque = Buffer.from([0xff, 0x00, 0x91, 0x02]);
    expect(redactSeedValue(opaque)).toBe(opaque);
  });

  it('carries intended content, drops presence, KEEPS usage, and never writes the source', async () => {
    const { store: src, own, privateEmail, privateHandle, privateKey } = await sourceWithIdentity();
    const lengthBefore = own.length;
    const staging = await stagingStore();

    const minted = await mintFilteredSeedContentCore({
      sourceStore: src,
      ownerKeyHex: own.keyHex,
      stagingStore: staging,
      redactValues: [privateHandle],
      onProjection: () => {},
    });

    // Filtering the owner's live log in place would make historical rows unreachable
    // for every live reader — the source must come back untouched.
    expect(own.length).toBe(lengthBefore);
    expect(minted.keyHex).not.toBe(own.keyHex);
    expect(minted.length).toBeGreaterThan(0);

    const core = openReplica(staging, minted.keyHex);
    await core.ready();
    const tables = new Set<string>();
    const hbKeys = new Set<string>();
    let bytes = '';
    for (let i = 0; i < minted.length; i++) {
      const blk = await core.get(i, { wait: false });
      bytes += JSON.stringify(blk);
      for (const r of blk?.value?.rows ?? []) {
        tables.add(r.table);
        hbKeys.add(r.hbKey);
      }
    }

    // CONTROL: the fixture really did contain the identity, so a no-op filter fails here.
    expect(tables.size).toBeGreaterThan(0);
    expect(tables.has('plans')).toBe(true);
    expect(tables.has('presence')).toBe(false);
    // D-002 row-drop: the content row that NAMED the handle is gone whole (not redacted),
    // the email-only sibling is carried with `[email]`, and the cut reports both counts.
    expect(hbKeys.has('p1')).toBe(false);
    expect(hbKeys.has('p2')).toBe(true);
    expect(minted.projection.droppedIdentityContent).toBeGreaterThanOrEqual(1);
    expect(minted.projection.droppedIdentityKey).toBeGreaterThanOrEqual(1);
    expect(minted.projection.droppedPrivateIngest).toBe(0);
    // `usage` SURVIVES by design — it is the append-only contributor ledger and carries
    // no identity (measured against the release gate's own denylist). This assertion is
    // deliberately the opposite of what an earlier revision asserted; see the
    // SEED_EXCLUDED_TABLES docstring for why excluding it was a 1517-row own-goal.
    expect(tables.has('usage')).toBe(true);
    expect(hbKeys.has(privateKey)).toBe(false);
    expect(bytes).not.toContain(hostname());
    if (!['root', 'runner', 'build', 'ubuntu'].includes(userInfo().username)) {
      expect(bytes).not.toContain(userInfo().username);
    }
    expect(bytes).not.toContain(privateEmail);
    expect(bytes).not.toContain(privateHandle);
    expect(bytes).toContain('[email]');
  });

  it('ships NO signing secret — the staging copy is a read-only replica', async () => {
    // This module's FIRST stated correctness property. Minting the core directly inside
    // the staging store would make it writable there, and a writable hypercore's storage
    // contains its signing secret — which then ships in the installer. A privacy fix that
    // leaked a signing key would be strictly worse than the leak it removes, so the core
    // is minted in a throwaway store and only its BLOCKS are replicated in.
    const { store: src, own } = await sourceWithIdentity();
    const staging = await stagingStore();

    const minted = await mintFilteredSeedContentCore({
      sourceStore: src,
      ownerKeyHex: own.keyHex,
      stagingStore: staging,
      onProjection: () => {},
    });

    const core = openReplica(staging, minted.keyHex);
    await core.ready();
    expect(core.writable).toBe(false);
  });

  it('release filtered cut emits a sanitized synthetic core and restores it offline', async () => {
    const { store: src, own, privateEmail, privateHandle } = await sourceWithIdentity();
    const provider = createCorestoreSeedProvider();
    const stagingDir = tmpDir('papercusp-seed-filtered-cut-');

    const { entry, payload } = await provider.cut({
      sourceStore: src,
      coreKeys: [own.keyHex],
      stagingDir,
      filtered: true,
      redactValues: [privateHandle],
      onProjection: () => {},
    } as unknown as Parameters<typeof provider.cut>[0]);
    const meta = entry.meta as { coreKeys: string[]; coreLengths: Record<string, number>; coreSparseFrom?: unknown };
    const [seedKey] = meta.coreKeys;
    expect(seedKey).toBeDefined();
    expect(seedKey).not.toBe(own.keyHex);
    expect(meta.coreLengths[seedKey!]).toBeGreaterThan(0);
    expect(meta.coreSparseFrom).toBeUndefined();
    expect(readdirSync(join(stagingDir, 'db')).some((file) => /^\d+\.log$/.test(file))).toBe(true);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    const targetStoreDir = join(tmpDir('papercusp-seed-filtered-target-'), 'hyperbee');
    await provider.restore(entry, payload, { targetStoreDir });
    const target = makeStore(targetStoreDir);
    await target.ready();
    const core = openReplica(target, seedKey!);
    await core.ready();
    expect(core.length).toBe(meta.coreLengths[seedKey!]);

    let bytes = '';
    for (let i = 0; i < core.length; i++) bytes += JSON.stringify(await core.get(i, { wait: false }));
    expect(bytes).not.toContain(privateEmail);
    expect(bytes).not.toContain(privateHandle);
    expect(bytes).toContain('[email]');
    expect(bytes).not.toContain(hostname());
  });

  it('does not over-filter: only presence is excluded', () => {
    expect(SEED_EXCLUDED_TABLES).toContain('presence');

    // `usage` (contributor_usage_events) is an append-only FEDERATED ledger and the
    // source of truth for tier-C contributor stats. An earlier revision excluded it on
    // a census that matched FIELD NAMES rather than identity values; re-measured against
    // the release gate's own denylist it carries ZERO identity. Excluding it would drop
    // 1517 legitimate ledger rows to remove nothing — this assertion is what stops that
    // from being "re-fixed" back in.
    expect(SEED_EXCLUDED_TABLES).not.toContain('usage');

    // Required, owner-authorised content — never exclude wholesale. (They DO carry
    // identity in specific value fields; that is a field-level decision, not a table
    // exclusion. See the constant's docstring.)
    expect(SEED_EXCLUDED_TABLES).not.toContain('hive-members');
    expect(SEED_EXCLUDED_TABLES).not.toContain('hive-policy');
    expect(SEED_EXCLUDED_TABLES).not.toContain('contributors');
  });

  it('structural tables are redacted in place; content tables are row-dropped (D-002)', () => {
    // A joiner cannot function without these rows — they are never dropped for a literal.
    for (const t of ['hive-members', 'hive-policy', 'hive-settings-by-key', 'hive-epoch-keys', 'contributors', 'usage']) {
      expect(SEED_REDACT_IN_PLACE_TABLES.has(t)).toBe(true);
    }
    // Content tables must NOT be listed: that would reinstate the redact path whose blind
    // spots (case, object keys) shipped the owner's name in build #5.
    for (const t of ['engineer-issues', 'features-by-id', 'plans', 'plan-parts', 'coord-messages', 'plans-by-slug']) {
      expect(SEED_REDACT_IN_PLACE_TABLES.has(t)).toBe(false);
    }
    // The two lists must not overlap — an excluded table has no rows to redact.
    for (const t of SEED_EXCLUDED_TABLES) expect(SEED_REDACT_IN_PLACE_TABLES.has(t)).toBe(false);
  });
});

/**
 * EI-22086776666843792 / endgame D-002 — the per-row projection. Build #5's seed shipped the
 * owner's name because the scrub matched case-sensitively and never looked at object keys,
 * and shipped the owner's inbox because the Gmail ingest lives INSIDE work-item payloads.
 * Each case below is the exact shape that leaked, with a control proving the rule is not
 * vacuous. The handle is assembled at runtime so the literal never sits in tracked source.
 */
describe('seed projection — literal matching mirrors the release gate; private ingest is dropped', () => {
  const handle = ['avi', 'ynw'].join('');
  const ctx = (table: string, hbKey = 'row-1') => ({ table, hbKey });

  it('drops a CONTENT row whose value carries the literal in a different CASE', () => {
    const { transform, stats } = seedSnapshotValueTransform([handle]);
    const shouted = handle.charAt(0).toUpperCase() + handle.slice(1);
    expect(transform({ title: `mentions ${shouted} in prose` }, ctx('engineer-issues'))).toBe(DROP_SNAPSHOT_ROW);
    // control: a row without the literal is carried by reference, untouched
    const clean = { title: 'plain content' };
    expect(transform(clean, ctx('engineer-issues'))).toBe(clean);
    expect(stats).toMatchObject({ droppedIdentityContent: 1, carried: 1, redactedInPlace: 0 });
  });

  it('drops a CONTENT row whose value carries the literal as an object KEY', () => {
    const { transform } = seedSnapshotValueTransform([handle]);
    // the exact 2026-09-01 survivor: account-pool ids as JSON keys under a rubric rating
    const value = { 'accounts-capacity': { value: { [`${handle}3`]: 'walled', accounts: 4 } } };
    expect(valueCarriesSeedIdentity(value, [handle])).toBe(true);
    expect(transform(value, ctx('features-by-id'))).toBe(DROP_SNAPSHOT_ROW);
    // control: the same shape with an innocent key is carried
    expect(valueCarriesSeedIdentity({ 'accounts-capacity': { value: { pool3: 'walled' } } }, [handle])).toBe(false);
  });

  it('a SHORT literal matches on a word boundary only, still case-insensitively', () => {
    const short = 'kip';
    expect(valueCarriesSeedIdentity({ t: 'kipling wrote this' }, [short])).toBe(false);
    expect(valueCarriesSeedIdentity({ t: 'for Kip: review' }, [short])).toBe(true);
    expect(valueCarriesSeedIdentity({ t: 'host kip-dev pid 1' }, [short])).toBe(true);
  });

  it('sees through encoded-JSON bytes, and leaves opaque binary alone', () => {
    const encoded = Buffer.from(JSON.stringify({ note: `ping ${handle.toUpperCase()}` }));
    expect(valueCarriesSeedIdentity(encoded, [handle])).toBe(true);
    expect(valueCarriesSeedIdentity(Buffer.from([0xff, 0x00, 0x91, 0x02]), [handle])).toBe(false);
  });

  it('REDACTS in place — never drops — a STRUCTURAL row (the roster) carrying the literal', () => {
    const { transform, stats } = seedSnapshotValueTransform([handle]);
    const out = transform(
      { github_user_id: 42, github_username: handle, device_label: `${handle}-laptop` },
      ctx('hive-members', '42'),
    );
    expect(out).toEqual({ github_user_id: 42, github_username: '[build-identity]', device_label: '[build-identity]-laptop' });
    expect(stats).toMatchObject({ redactedInPlace: 1, droppedIdentityContent: 0 });
  });

  it('redacts an identity literal used as an object KEY when the row is kept', () => {
    expect(redactSeedValue({ [handle]: 'walled', keep: 1 }, [handle])).toEqual({ '[build-identity]': 'walled', keep: 1 });
  });

  it('EI-23523718191785410: REDACTS encoded bytes that are valid UTF-8 but NOT JSON (structural row)', () => {
    // The 0.0.20 cut's survivor shape: a git author token (`build-git-name@<id>`) — plain
    // text, not JSON. The DETECTOR judges these bytes as text (decodeEncodedJson returns
    // `{ text }` with NO `json`), so a CONTENT row carrying them is dropped. A STRUCTURAL
    // row skips that drop BY DESIGN, which makes redaction its only compensating control —
    // so the redactor must cover exactly the ground the detector does. It previously bailed
    // to `return value` when JSON.parse threw, and the row was counted `carried`, i.e. clean.
    const { transform, stats } = seedSnapshotValueTransform([handle]);
    const bytes = new TextEncoder().encode(`build-git-name@${handle}`);
    expect(valueCarriesSeedIdentity(bytes, [handle])).toBe(true);

    const out = transform(bytes, ctx('hive-members', '42'));
    expect(out).not.toBe(DROP_SNAPSHOT_ROW);
    // The post-condition that matters: whatever came back no longer carries the literal.
    expect(valueCarriesSeedIdentity(out, [handle])).toBe(false);
    expect(new TextDecoder().decode(out as Uint8Array)).toBe('build-git-name@[build-identity]');
    expect(stats).toMatchObject({ redactedInPlace: 1, carried: 0 });
  });

  it('leaves NON-UTF-8 opaque binary byte-identical (the redactor does not over-reach)', () => {
    const { transform, stats } = seedSnapshotValueTransform([handle]);
    const opaque = Buffer.from([0xff, 0x00, 0x91, 0x02]);
    expect(transform(opaque, ctx('hive-members', '42'))).toBe(opaque);
    // ...and valid-UTF-8 text with NO literal is likewise carried by reference.
    const clean = new TextEncoder().encode('build-git-name@nobody');
    expect(transform(clean, ctx('hive-members', '43'))).toBe(clean);
    expect(stats).toMatchObject({ redactedInPlace: 0, carried: 2 });
  });

  it('drops a row carrying an external-integration ingest envelope in ANY table, with NO literal hit', () => {
    const { transform, stats } = seedSnapshotValueTransform([]);
    const envelope = {
      key: 'ext:mail:message.received',
      event: 'message.received',
      source: 'mail',
      payload: { from: `Intro <intro${'@'}example.org>`, subject: 'hello', html: '<!DOCTYPE html><p>private</p>' },
    };
    expect(isExternalTriggerEnvelope(envelope)).toBe(true);
    // the exact nesting the 2026-09-01 seed shipped: a plan run's inputs.trigger inside a
    // work-item payload (features-by-id PR-974-P-001)
    const row = { harness_slug: 'h', payload: { plan_run: { runId: 974, inputs: { trigger: envelope } } } };
    expect(transform(row, ctx('features-by-id', 'PR-974-P-001'))).toBe(DROP_SNAPSHOT_ROW);
    // a structural table does NOT exempt the owner's inbox
    expect(transform(row, ctx('hive-settings-by-key', 'k'))).toBe(DROP_SNAPSHOT_ROW);
    // the canonical ingest record shape is an envelope too
    expect(isExternalTriggerEnvelope({ source: 'mail', event: 'x', dedupeKey: 'mail:1:x', adapterPayload: { raw: 1 } })).toBe(true);
    // controls: trigger-shaped objects WITHOUT a payload are not envelopes and are carried
    const notEnvelope = { payload: { plan_run: { inputs: { trigger: { key: 'plan:run', source: 'cron', event: 'tick' } } } } };
    expect(isExternalTriggerEnvelope(notEnvelope.payload.plan_run.inputs.trigger)).toBe(false);
    expect(transform(notEnvelope, ctx('features-by-id'))).toBe(notEnvelope);
    expect(stats).toMatchObject({ droppedPrivateIngest: 2, carried: 1 });
  });

  it('drops a row whose ADDRESS carries the literal before looking at the value', () => {
    const { transform, stats } = seedSnapshotValueTransform([handle]);
    const value = { body: 'clean' };
    expect(transform(value, ctx('plan-parts', `p1/section:recon-against-${handle}-restart`))).toBe(DROP_SNAPSHOT_ROW);
    expect(stats.droppedIdentityKey).toBe(1);
  });

  it.each([false, true])('omits identity tombstones from a real seed (prior snapshot: %s)', async (priorSnapshot) => {
    const source = makeStore(tmpDir('seed-tombstone-source-'));
    const staging = makeStore(tmpDir('seed-tombstone-staging-'));
    await source.ready();
    await staging.ready();
    const own = await openOwnLog(source);
    const privateKey = `workspace/host:${handle}/retired`;
    const table = 'agent-facts-by-key';
    for (const hbKey of [privateKey, 'public-retired', 'public-live']) {
      await own.append({ type: 'put', table, hbKey, value: { public: true },
        ts: 1, schema_version: 1, author_pubkey: '' });
    }
    for (const hbKey of [privateKey, 'public-retired']) {
      await own.append({ type: 'del', table, hbKey, ts: 2, hlc: '2:0:fixture',
        schema_version: 1, author_pubkey: '' });
    }
    if (priorSnapshot) await produceLogSnapshot(own, { now: 10, schemaVersion: 1 });
    const sourceLength = own.length;
    const minted = await mintFilteredSeedContentCore({ sourceStore: source,
      ownerKeyHex: own.keyHex, stagingStore: staging, now: 10,
      redactValues: [handle], onProjection: () => {} });
    const replica = staging.get({ key: Buffer.from(minted.keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await replica.ready();
    const rows: SnapshotRow[] = [];
    for (let i = 0; i < minted.length; i++) {
      const block = await replica.get(i, { wait: false }) as { value?: { rows?: SnapshotRow[] } };
      rows.push(...(block.value?.rows ?? []));
    }
    expect(rows.map(row => row.hbKey).sort()).toEqual(['public-live', 'public-retired']);
    expect(rows.find(row => row.hbKey === 'public-retired')).toMatchObject({
      value: null, deleted: true, ts: 2, hlc: '2:0:fixture',
    });
    expect(rows.find(row => row.hbKey === 'public-live')?.value).toEqual({ public: true });
    expect(JSON.stringify(rows)).not.toContain(handle);
    expect(own.length).toBe(sourceLength);
    expect((await own.get(3) as PeerLogOp).hbKey).toBe(privateKey);
  });
});

/**
 * EI-20108164746219771 — the cut must REFUSE a suffix that still carries an excluded
 * table, rather than hash it into a seed entry.
 *
 * The two failing cases below are the whole reason this guard exists: filtering the head
 * snapshot is necessary but NOT sufficient, and each case fails in a way the filter alone
 * cannot see. Both are written as real cuts over real corestores — the guard reads the
 * blocks that landed in STAGING, so a test that stubbed the read would not exercise it.
 */
describe('shipped-suffix guard — the cut refuses to ship an excluded table', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  function tmpDir2(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }
  function presenceOp(i: number): PeerLogOp {
    // The real shape: identity lives in the KEY, which is why the table is dropped
    // wholesale rather than redacted (see the constant's docstring).
    return {
      type: 'put',
      table: 'presence',
      hbKey: `1567022/main-server-${hostname()}`,
      value: { machine_label: hostname() },
      ts: 500 + i,
      schema_version: 1,
      author_pubkey: 'ownerdev',
    };
  }

  it('THROWS when the head snapshot was produced WITHOUT the exclusion (operator on an older build)', async () => {
    const dir = tmpDir2('seed-guard-unfiltered-');
    const store = makeStore(dir);
    await store.ready();
    const log = await openOwnLog(store);
    for (let i = 0; i < 4; i++) await log.append(op(i));
    await log.append(presenceOp(0));
    // NO excludeTables — exactly what a live operator running a pre-fix build produces.
    const snap = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1 });
    expect(snap.appended).toBe(true);

    const provider = createCorestoreSeedProvider();
    await expect(
      provider.cut({
        sourceStore: store,
        coreKeys: [log.keyHex],
        stagingDir: tmpDir2('seed-guard-unfiltered-stage-'),
        sparse: true,
      }),
    ).rejects.toThrow(/REFUSING TO CUT[\s\S]*snapshot row presence/);
  });

  it('THROWS on a RAW presence op appended AFTER the filtered snapshot (the 30s keep-alive race)', async () => {
    // THE CASE FILTERING ALONE CANNOT FIX. What ships is [coreSparseFrom, len), and `len`
    // is read at the cutter's open — strictly after the operator appended the snapshot.
    // presence re-announces every 30s, so a heartbeat lands inside the shipped span.
    const dir = tmpDir2('seed-guard-race-');
    const store = makeStore(dir);
    await store.ready();
    const log = await openOwnLog(store);
    for (let i = 0; i < 4; i++) await log.append(op(i));
    const snap = await produceLogSnapshot(log, {
      now: 1000,
      schemaVersion: 1,
      excludeTables: SEED_EXCLUDED_TABLES,
    });
    expect(snap.appended).toBe(true);
    await log.append(presenceOp(1)); // the keep-alive, landing after the snapshot

    const provider = createCorestoreSeedProvider();
    await expect(
      provider.cut({
        sourceStore: store,
        coreKeys: [log.keyHex],
        stagingDir: tmpDir2('seed-guard-race-stage-'),
        sparse: true,
      }),
    ).rejects.toThrow(/REFUSING TO CUT[\s\S]*raw op presence/);
  });

  it('ACCEPTS a filtered snapshot with no post-snapshot presence (the guard is not vacuous)', async () => {
    // The positive control. Without it, the two throws above would also pass if the guard
    // rejected EVERY cut — which is the failure mode that makes a guard worthless.
    const dir = tmpDir2('seed-guard-clean-');
    const store = makeStore(dir);
    await store.ready();
    const log = await openOwnLog(store);
    for (let i = 0; i < 4; i++) await log.append(op(i));
    await log.append(presenceOp(2)); // present in the log, and must NOT reach the seed
    const snap = await produceLogSnapshot(log, {
      now: 1000,
      schemaVersion: 1,
      excludeTables: SEED_EXCLUDED_TABLES,
    });
    expect(snap.appended).toBe(true);

    const provider = createCorestoreSeedProvider();
    const stage = tmpDir2('seed-guard-clean-stage-');
    const { entry } = await provider.cut({
      sourceStore: store,
      coreKeys: [log.keyHex],
      stagingDir: stage,
      sparse: true,
    });
    expect(entry.kind).toBe('corestore');
    // And the shipped span really is the filtered snapshot, not an accidental empty range.
    const meta = entry.meta as { coreSparseFrom?: Record<string, number>; coreLengths: Record<string, number> };
    expect(meta.coreSparseFrom?.[log.keyHex]).toBe(snap.coversUpTo);
    expect(meta.coreLengths[log.keyHex]).toBeGreaterThan(snap.coversUpTo);
  });
});
