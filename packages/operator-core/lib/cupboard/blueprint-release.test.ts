import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinPackageInput } from '@papercusp/orchestrator/blueprint';
import {
  BlueprintLifecycleError,
  buildBlueprintReleaseArchive,
  commitBlueprintRelease,
  diffBlueprintReleases,
  prepareBlueprintPublicRelease,
  readBlueprintLifecycle,
  blueprintReleaseRevenueDependencies,
  readBlueprintReleaseRevenueDependencies,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
  type BlueprintLifecycleJournal,
} from './blueprint-release';
import { prepareReleaseForPublish } from './publish-release-gate';
import { listingManifestSigningBytes, type CupboardReleaseManifest } from './listing-manifest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';

let root = '';
let installedDir = '';

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'blueprint-release-'));
  installedDir = join(root, 'blueprints');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function source(version: string, prompt: string, maxCostUsd: number) {
  const dir = join(root, `source-${version}`);
  const yaml =
    ['id: identity', `version: ${version}`, 'slots: [{ slot: domain }]', `knobs: { maxCostUsd: ${maxCostUsd} }`].join(
      '\n',
    ) + '\n';
  await fs.mkdir(join(dir, 'prompts'), { recursive: true });
  await fs.writeFile(join(dir, 'blueprint.yaml'), yaml);
  await fs.writeFile(join(dir, 'prompts', 'persona.md'), prompt);
  const pin = pinPackageInput({
    packageKind: 'blueprint',
    ref: 'identity',
    revision: version,
    files: [
      { path: 'blueprint.yaml', bytes: yaml },
      { path: 'prompts/persona.md', bytes: prompt },
    ],
    value: { id: 'identity', version, slots: [{ slot: 'domain' }], knobs: { maxCostUsd } },
  });
  return { dir, pin };
}

describe('immutable blueprint release lifecycle', () => {
  const reference = ({ packageKind, ref, revision, contentHash }:
    Pick<ReturnType<typeof pinPackageInput>, 'packageKind' | 'ref' | 'revision' | 'contentHash'>) =>
    ({ packageKind, ref, revision, contentHash });

  it('derives each transitive component once from exact publisher pins, excluding the root and unrelated packages', () => {
    const dependency = (ref: string, publisher: string, dependencies: Parameters<typeof pinPackageInput>[0]['dependencies'] = []) =>
      pinPackageInput({ packageKind: 'blueprint', ref, revision: '1.0.0', files: [],
        value: { publisher: { id: publisher } }, dependencies: dependencies.map(reference) });
    const shared = dependency('shared', 'alice');
    const parent = dependency('parent', 'bob', [shared]);
    const other = dependency('unrelated', 'mallory');
    const identity = dependency('identity', 'creator', [parent, shared]);
    const archive = buildBlueprintReleaseArchive([other, shared, identity, parent], 'identity');
    expect(blueprintReleaseRevenueDependencies(archive)).toEqual([
      { packageKind: 'blueprint', ref: 'parent', revision: '1.0.0', contentHash: parent.contentHash, author: 'bob' },
      { packageKind: 'blueprint', ref: 'shared', revision: '1.0.0', contentHash: shared.contentHash, author: 'alice' },
    ]);
  });

  it('refuses missing component authors and modified closure metadata instead of crediting the identity creator', () => {
    const component = pinPackageInput({ packageKind: 'blueprint', ref: 'component', revision: '1.0.0', files: [] });
    const identity = pinPackageInput({ packageKind: 'blueprint', ref: 'identity', revision: '1.0.0', files: [],
      value: { publisher: { id: 'creator' } }, dependencies: [reference(component)] });
    const archive = buildBlueprintReleaseArchive([identity, component], 'identity');
    expect(() => blueprintReleaseRevenueDependencies({ ...archive,
      root: { ...archive.root, contentHash: 'f'.repeat(64) } })).toThrow(/retained release/);
    expect(() => blueprintReleaseRevenueDependencies({ ...archive,
      package: { ...archive.package, rootHash: 'f'.repeat(64) } })).toThrow(/retained release/);
    expect(() => blueprintReleaseRevenueDependencies(archive)).toThrow(/no pinned publisher id/);
    archive.pins.find((pin) => pin.ref === 'component')!.value = { publisher: { id: 'forged' } };
    expect(() => blueprintReleaseRevenueDependencies(archive)).toThrow(/hash/i);
  });

  it('reads revenue authors from the retained historical release despite active-source edits and refuses a re-pinned forgery', async () => {
    const v1 = await source('1.0.0', 'old prompt', 2);
    const component = pinPackageInput({ packageKind: 'blueprint', ref: 'component', revision: '2.0.0',
      files: [], value: { publisher: { id: 'alice' } } });
    const identity = pinPackageInput({ packageKind: 'blueprint', ref: 'identity', revision: '1.0.0',
      files: v1.pin.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, 'base64') })),
      value: v1.pin.value, dependencies: [reference(component)] });
    const installed = await commitBlueprintRelease({ installedDir, sourceDir: v1.dir, id: 'identity', version: '1.0.0',
      source: 'https://github.com/example/identity', pins: [identity, component] });
    await fs.writeFile(join(installed.installedTo, 'blueprint.yaml'), 'publisher: { id: mallory }\n');
    expect(await readBlueprintReleaseRevenueDependencies(installedDir, { id: 'identity', version: '1.0.0' }))
      .toEqual([{ packageKind: 'blueprint', ref: 'component', revision: '2.0.0', contentHash: component.contentHash, author: 'alice' }]);
    const forgedComponent = pinPackageInput({ packageKind: 'blueprint', ref: 'component', revision: '2.0.0',
      files: [], value: { publisher: { id: 'mallory' } } });
    const forgedIdentity = pinPackageInput({ packageKind: 'blueprint', ref: 'identity', revision: '1.0.0',
      files: v1.pin.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, 'base64') })),
      value: v1.pin.value, dependencies: [reference(forgedComponent)] });
    await fs.writeFile(join(installed.historyDir, 'closure.json'), JSON.stringify({ pins: [forgedIdentity, forgedComponent] }));
    await expect(readBlueprintReleaseRevenueDependencies(installedDir, { id: 'identity', version: '1.0.0' }))
      .rejects.toThrow(/retained closure hash mismatch/);
    await expect(readBlueprintReleaseRevenueDependencies(installedDir, { id: 'identity', version: '9.0.0' }))
      .rejects.toThrow(/one exact retained release/);
  });

  it('refuses two distinct retained releases with the same version instead of selecting the active one', async () => {
    const first = await source('1.0.0', 'first release', 2);
    await commitBlueprintRelease({ installedDir, sourceDir: first.dir, id: 'identity', version: '1.0.0',
      source: 'https://github.com/example/identity', pins: [first.pin] });
    expect(await readBlueprintReleaseRevenueDependencies(installedDir, { id: 'identity', version: '1.0.0' })).toEqual([]);
    const second = await source('1.0.0', 'different bytes at the same version', 2);
    await commitBlueprintRelease({ installedDir, sourceDir: second.dir, id: 'identity', version: '1.0.0',
      source: 'https://github.com/example/identity', pins: [second.pin] });
    const lifecycle = await readBlueprintLifecycle(installedDir, 'identity');
    expect(lifecycle.releases.map((release) => release.version)).toEqual(['1.0.0', '1.0.0']);
    await expect(readBlueprintReleaseRevenueDependencies(installedDir, { id: 'identity', version: '1.0.0' }))
      .rejects.toThrow(/one exact retained release; found 2/);
  });

  it('stores mode policy approval only for the exact moderated artifact', async () => {
    const dir = join(root, 'mode-source');
    const yaml = 'id: su.mode-auto-custom\nversion: 1.0.0\nslots: [{ slot: autonomy }]\n';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'blueprint.yaml'), yaml);
    const pin = pinPackageInput({
      packageKind: 'blueprint', ref: 'su.mode-auto-custom', revision: '1.0.0',
      files: [{ path: 'blueprint.yaml', bytes: yaml }],
      value: { id: 'su.mode-auto-custom', version: '1.0.0', slots: [{ slot: 'autonomy' }],
        mode: { id: 'auto', policyRef: 'auto' } },
    });
    const contentHash = buildBlueprintReleaseArchive([pin], 'su.mode-auto-custom').package.rootHash;
    const request = {
      installedDir, sourceDir: dir, id: 'su.mode-auto-custom', version: '1.0.0',
      source: 'https://github.com/acme/mode', pins: [pin],
    };
    await expect(commitBlueprintRelease(request)).rejects.toThrow(/mode policy needs approval/);
    await expect(commitBlueprintRelease({ ...request, modeApproval: {
      listingId: 'listing-1', policyRef: 'auto', approvedArtifactContentHash: 'wrong',
    } })).rejects.toThrow(/mode policy needs approval/);
    const installed = await commitBlueprintRelease({ ...request, modeApproval: {
      listingId: 'listing-1', policyRef: 'auto', approvedArtifactContentHash: contentHash,
    } });
    expect(installed.record.modePolicyApproval).toEqual({
      listingId: 'listing-1', policyRef: 'auto', artifactContentHash: contentHash,
    });
    expect((await readBlueprintLifecycle(installedDir, request.id)).active?.modePolicyApproval)
      .toEqual(installed.record.modePolicyApproval);
    const renewed = await commitBlueprintRelease({ ...request, modeApproval: {
      listingId: 'listing-2', policyRef: 'auto', approvedArtifactContentHash: contentHash,
    } });
    expect(renewed.operation).toBe('no-op');
    expect((await readBlueprintLifecycle(installedDir, request.id)).active?.modePolicyApproval?.listingId)
      .toBe('listing-2');
  });

  it('installs, updates with exact prompt/knob diffs, rolls back, and uninstalls without erasing pinned history', async () => {
    const v1 = await source('1.0.0', 'sell potatoes\n', 2);
    const first = await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'https://github.com/acme/identity',
      pins: [v1.pin],
      nowMs: 1,
    });
    expect(first.operation).toBe('install');
    expect(first.activationPreflight.ok).toBe(true);

    const v2 = await source('2.0.0', 'sell excellent potatoes\n', 5);
    const update = await commitBlueprintRelease({
      installedDir,
      sourceDir: v2.dir,
      id: 'identity',
      version: '2.0.0',
      source: 'https://github.com/acme/identity',
      pins: [v2.pin],
      nowMs: 2,
    });
    expect(update.operation).toBe('update');
    expect(update.diff.promptText[0]).toMatchObject({ path: 'identity/prompts/persona.md' });
    expect(update.diff.promptText[0]!.patch).toContain('-sell potatoes');
    expect(update.diff.promptText[0]!.patch).toContain('+sell excellent potatoes');
    expect(update.diff.burnKnobs).toEqual([
      { path: 'maxCostUsd', before: 2, after: 5 },
      { path: 'promptBytes', before: Buffer.byteLength('sell potatoes\n'), after: Buffer.byteLength('sell excellent potatoes\n') },
    ]);
    expect(update.diff.grants).toEqual([]);
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toContain('excellent');

    const rollback = await rollbackBlueprintRelease({ installedDir, id: 'identity', target: '1.0.0' });
    expect(rollback).toMatchObject({ operation: 'rollback', activationRequired: true, record: { version: '1.0.0' } });
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('sell potatoes\n');

    const removed = await uninstallBlueprintRelease({ installedDir, id: 'identity', nowMs: 3 });
    expect(removed).toMatchObject({ operation: 'uninstall', activationRequired: true });
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
    expect(removed.retained.map((release) => release.version).sort()).toEqual(['1.0.0', '2.0.0']);
    const state = await readBlueprintLifecycle(installedDir, 'identity');
    expect(state.active).toBeNull();
    expect(state.releases).toHaveLength(2);
    for (const release of state.releases) {
      expect(
        existsSync(join(installedDir, '.releases', 'identity', release.contentHash, 'content/blueprint.yaml')),
      ).toBe(true);
    }
  });

  it('repairs active-dir drift on a package no-op', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'repo',
      pins: [v1.pin],
    });
    await fs.writeFile(join(installedDir, 'identity/stale.txt'), 'stale');
    const again = await commitBlueprintRelease({
      installedDir,
      sourceDir: v1.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'repo',
      pins: [v1.pin],
    });
    expect(again.operation).toBe('no-op');
    expect(existsSync(join(installedDir, 'identity/stale.txt'))).toBe(false);
  });

  it('installs a second identity claiming the same exclusive slot as an inactive alternative', async () => {
    // D-029: installing into the library is allowed even when another stored
    // identity already fills the same exclusive slot, because activation is a
    // separate door (the P-040 desired/applied transition). An install that
    // declares no activation stack must therefore land the alternative without
    // refusing and without displacing the incumbent. The refusal half — a
    // COMBINED install-and-activate whose stack collides on that slot — is the
    // next test; together they are what makes install distinct from activation.
    const incumbent = await source('1.0.0', 'incumbent persona\n', 1);
    await commitBlueprintRelease({
      installedDir,
      sourceDir: incumbent.dir,
      id: 'identity',
      version: '1.0.0',
      source: 'repo',
      pins: [incumbent.pin],
    });

    const yaml = ['id: challenger', 'version: 1.0.0', 'slots: [{ slot: domain }]', 'knobs: { maxCostUsd: 1 }'].join('\n') + '\n';
    const prompt = 'challenger persona\n';
    const dir = join(root, 'source-challenger');
    await fs.mkdir(join(dir, 'prompts'), { recursive: true });
    await fs.writeFile(join(dir, 'blueprint.yaml'), yaml);
    await fs.writeFile(join(dir, 'prompts', 'persona.md'), prompt);
    const pin = pinPackageInput({
      packageKind: 'blueprint',
      ref: 'challenger',
      revision: '1.0.0',
      files: [
        { path: 'blueprint.yaml', bytes: yaml },
        { path: 'prompts/persona.md', bytes: prompt },
      ],
      value: { id: 'challenger', version: '1.0.0', slots: [{ slot: 'domain' }], knobs: { maxCostUsd: 1 } },
    });

    const alternative = await commitBlueprintRelease({
      installedDir,
      sourceDir: dir,
      id: 'challenger',
      version: '1.0.0',
      source: 'repo',
      pins: [pin],
    });

    expect(alternative.operation).toBe('install');
    expect(alternative.activationPreflight.ok).toBe(true);
    // The incumbent is untouched — the alternative did not activate over it.
    expect(await fs.readFile(join(installedDir, 'identity/prompts/persona.md'), 'utf8')).toBe('incumbent persona\n');
    expect(await fs.readFile(join(installedDir, 'challenger/prompts/persona.md'), 'utf8')).toBe('challenger persona\n');
    // Library "active" is per-package content, NOT the exclusive stack slot:
    // two identities both claiming `domain` coexist, each with its own active
    // release, because nothing here resolved the slot.
    expect((await readBlueprintLifecycle(installedDir, 'identity')).active?.version).toBe('1.0.0');
    expect((await readBlueprintLifecycle(installedDir, 'challenger')).active?.version).toBe('1.0.0');
  });

  it('refuses a listed-content mismatch and an exclusive-slot activation conflict before changing the active package', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    await expect(
      commitBlueprintRelease({
        installedDir,
        sourceDir: v1.dir,
        id: 'identity',
        version: '1.0.0',
        source: 'repo',
        pins: [v1.pin],
        expectedRelease: { contentHash: `sha256:${'0'.repeat(64)}` },
      }),
    ).rejects.toBeInstanceOf(BlueprintLifecycleError);
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);

    await expect(
      commitBlueprintRelease({
        installedDir,
        sourceDir: v1.dir,
        id: 'identity',
        version: '1.0.0',
        source: 'repo',
        pins: [v1.pin],
        activationStack: [{ id: 'other-domain', slots: ['domain'] }],
      }),
    ).rejects.toThrow(/activation slot conflict.*domain/);
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
  });

  it('builds a signed publish-release manifest over the complete closure bytes', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    const prepared = await prepareBlueprintPublicRelease({
      blueprintFile: join(v1.dir, 'blueprint.yaml'),
      listingRef: 'identity',
      resolveExtends: () => null,
      signer: {
        githubUserId: 7,
        githubLogin: 'publisher',
        devicePubkey: 'device-key',
        sign: async (bytes) => Buffer.from(`signed:${bytes.length}`),
      },
    });
    expect(prepared.manifest.release).toMatchObject({
      listingKind: 'blueprint',
      listingRef: 'identity',
      releaseVersion: '1.0.0',
      publisher: { githubUserId: 7 },
    });
    expect(prepared.manifest.rootHash).toBe(prepared.source.archive.package.rootHash);
    expect(prepared.manifest.release.contentHash).toBe(prepared.source.archive.package.rootHash);
    expect(prepared.manifest.release.signature).toMatch(/^c2lnbmVkOj/);
    expect((prepared.release as { bytes?: Buffer }).bytes?.equals(prepared.source.archive.bytes)).toBe(true);
    expect(await prepareReleaseForPublish(prepared.release)).toMatchObject({ ok: true });
  });
  // identities-v1 R-2 / D-073+D-074. A real keypair, a real signature, and the
  // SAME byte derivation publish signs with — so a refusal here cannot be an
  // artifact of a second, divergent reconstruction of the signing bytes.
  it('verifies a PRESENT publisher signature over the listed manifest and refuses a tampered one, while an absent manifest still installs unsigned', async () => {
    const v1 = await source('1.0.0', 'persona\n', 1);
    const rootHash = buildBlueprintReleaseArchive([v1.pin], 'identity').package.rootHash;
    const keypair = generateEd25519KeypairDer();
    const sign = (unsigned: Omit<CupboardReleaseManifest, 'signature'>): CupboardReleaseManifest => ({
      ...unsigned,
      signature: signWithPrivateKeyDer(keypair.privateKeyDer, listingManifestSigningBytes(unsigned)).toString('base64'),
    });
    const unsigned: Omit<CupboardReleaseManifest, 'signature'> = {
      schemaVersion: 1,
      listingKind: 'blueprint',
      listingRef: 'identity',
      releaseVersion: '1.0.0',
      contentHash: rootHash,
      dependencies: [],
      compatibility: {},
      permissions: [],
      capabilities: [],
      license: 'MIT',
      publisher: { githubUserId: 42, login: 'publisher', devicePubkey: keypair.pubkeyBase64 },
      reviewStatus: 'pending',
    };
    const manifest = sign(unsigned);
    const commit = (expectedRelease: Parameters<typeof commitBlueprintRelease>[0]['expectedRelease']) =>
      commitBlueprintRelease({
        installedDir,
        sourceDir: v1.dir,
        id: 'identity',
        version: '1.0.0',
        source: 'repo',
        pins: [v1.pin],
        expectedRelease,
      });

    // A field INSIDE the signed bytes, altered after signing. The closure and
    // the content-hash pin both still match, so this is refused by the
    // signature check alone — nothing else in the system would catch it.
    await expect(commit({ contentHash: rootHash, manifest: { ...manifest, license: 'PROPRIETARY' } })).rejects.toThrow(
      /INVALID publisher signature/,
    );
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);

    // A signature that verifies, over a manifest pinning a DIFFERENT closure
    // than the one cloned: authentic, but not a release of THIS source.
    await expect(commit({ manifest: sign({ ...unsigned, contentHash: `sha256:${'0'.repeat(64)}` }) })).rejects.toThrow(
      /signed manifest for identity@1\.0\.0 pins/,
    );
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);

    // The intact signed manifest installs, and an ABSENT manifest is permitted
    // rather than refused (D-073 — verify-always would refuse every unsigned
    // release, including this plan's own unpriced proof install).
    expect((await commit({ contentHash: rootHash, manifest })).operation).toBe('install');
    expect((await commit(undefined)).operation).toBe('no-op');
  });
});

describe('P-014 lifecycle journal order (D-034)', () => {
  /** Records every journal call with the release the file tier had active at that moment. */
  function recordingJournal(options: { refuse?: boolean } = {}) {
    const calls: string[] = [];
    const active = async () => (await readBlueprintLifecycle(installedDir, 'identity')).active?.version ?? 'none';
    const journal: BlueprintLifecycleJournal = {
      async recover(activeContentHash) {
        calls.push(`recover(${activeContentHash ?? 'null'}) @${await active()}`);
        return [];
      },
      async prepare(contentHash) {
        calls.push(`prepare(${contentHash ?? 'null'}) @${await active()}`);
        if (options.refuse) throw new BlueprintLifecycleError('binding refused', 409, 'capability_provider_binding_failed');
        return {
          async apply() {
            calls.push(`apply @${await active()}`);
            return { pots: [], residue: [] };
          },
          async compensate(cause) {
            calls.push(`compensate(${(cause as NodeJS.ErrnoException).code}) @${await active()}`);
          },
        };
      },
    };
    return { journal, calls };
  }

  it('recovers and prepares before every switch, and applies only after it', async () => {
    const v1 = await source('1.0.0', 'one\n', 1);
    const v2 = await source('2.0.0', 'two\n', 2);
    const request = { installedDir, id: 'identity', source: 'repo' };
    const { journal, calls } = recordingJournal();

    const first = await commitBlueprintRelease({ ...request, sourceDir: v1.dir, version: '1.0.0', pins: [v1.pin], nowMs: 1, journal });
    const h1 = first.record.contentHash;
    expect(first.journal).toEqual({ recovered: [], pots: [], residue: [] });
    const second = await commitBlueprintRelease({ ...request, sourceDir: v2.dir, version: '2.0.0', pins: [v2.pin], nowMs: 2, journal });
    const h2 = second.record.contentHash;
    await rollbackBlueprintRelease({ installedDir, id: 'identity', target: '1.0.0', journal });
    const removed = await uninstallBlueprintRelease({ installedDir, id: 'identity', nowMs: 3, journal });
    expect(removed.journal).toEqual({ recovered: [], pots: [], residue: [] });

    expect(calls).toEqual([
      'recover(null) @none', `prepare(${h1}) @none`, 'apply @1.0.0',
      `recover(${h1}) @1.0.0`, `prepare(${h2}) @1.0.0`, 'apply @2.0.0',
      `recover(${h2}) @2.0.0`, `prepare(${h1}) @2.0.0`, 'apply @1.0.0',
      // Uninstall prepares for no release; the file tier goes before the pot installs are cleaned.
      `recover(${h1}) @1.0.0`, 'prepare(null) @1.0.0', 'apply @none',
    ]);
  });

  it('never switches a release whose bindings the journal refused', async () => {
    const v1 = await source('1.0.0', 'one\n', 1);
    const { journal, calls } = recordingJournal({ refuse: true });
    await expect(commitBlueprintRelease({
      installedDir, sourceDir: v1.dir, id: 'identity', version: '1.0.0', source: 'repo', pins: [v1.pin], journal,
    })).rejects.toMatchObject({ status: 409, code: 'capability_provider_binding_failed' });
    expect(calls).toHaveLength(2);
    expect(existsSync(join(installedDir, 'identity'))).toBe(false);
    expect((await readBlueprintLifecycle(installedDir, 'identity')).releases).toEqual([]);
  });

  it('compensates the prepared attempt when the switch fails, and never applies it', async () => {
    const v1 = await source('1.0.0', 'one\n', 1);
    // The pins verify, but the bytes the switch copies are gone.
    await fs.rm(v1.dir, { recursive: true, force: true });
    const { journal, calls } = recordingJournal();
    await expect(commitBlueprintRelease({
      installedDir, sourceDir: v1.dir, id: 'identity', version: '1.0.0', source: 'repo', pins: [v1.pin], journal,
    })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.slice(2)).toEqual(['compensate(ENOENT) @none']);
    expect((await readBlueprintLifecycle(installedDir, 'identity')).active).toBeNull();
  });

  it('refuses an activation conflict before the journal is touched', async () => {
    const v1 = await source('1.0.0', 'one\n', 1);
    const { journal, calls } = recordingJournal();
    await expect(commitBlueprintRelease({
      installedDir, sourceDir: v1.dir, id: 'identity', version: '1.0.0', source: 'repo', pins: [v1.pin], journal,
      activationStack: [{ id: 'other', slots: ['domain'] }],
    })).rejects.toThrow(/activation slot conflict/);
    expect(calls).toEqual([]);
  });
});

describe('P-005 complete-closure update disclosures', () => {
  function archive(version: string, required: string[], optional: string[], effort: string) {
    const parent = pinPackageInput({
      packageKind: 'blueprint', ref: 'parent', revision: version, files: [],
      value: { id: 'parent', version, grants: { requires: required, optional }, roles: { worker: { effort } },
        knobs: { loop: { intervalSec: version === '1.0.0' ? 60 : 30 } } },
    });
    const rootPin = pinPackageInput({
      packageKind: 'blueprint', ref: 'child', revision: version, files: [],
      value: { id: 'child', version, extends: 'parent' },
      dependencies: [{ packageKind: 'blueprint', ref: 'parent', revision: version, contentHash: parent.contentHash }],
    });
    return buildBlueprintReleaseArchive([parent, rootPin], 'child');
  }

  it('reports inherited grant widening and optional-to-required changes without claiming authority', () => {
    const before = archive('1.0.0', ['crm.read@1.0.0'], ['crm.send@1.0.0'], 'low');
    const after = archive('2.0.0', ['crm.read@1.0.0', 'crm.send@1.0.0'], ['crm.delete@1.0.0'], 'high');
    const diff = diffBlueprintReleases(before, after);
    expect(diff.grants).toEqual([
      { layer: 'parent', kind: 'requires', added: ['crm.send@1.0.0'], removed: [] },
      { layer: 'parent', kind: 'optional', added: ['crm.delete@1.0.0'], removed: ['crm.send@1.0.0'] },
    ]);
    expect(diff.burnKnobs).toEqual([
      { path: 'parent:loop.intervalSec', before: 60, after: 30 },
      { path: 'parent:roles.worker.effort', before: 'low', after: 'high' },
    ]);
    const reverse = diffBlueprintReleases(after, before);
    expect(reverse.grants[0]).toEqual({ layer: 'parent', kind: 'requires', added: [], removed: ['crm.send@1.0.0'] });
    expect(diffBlueprintReleases(after, after)).toMatchObject({ grants: [], burnKnobs: [], promptText: [] });
  });
});
