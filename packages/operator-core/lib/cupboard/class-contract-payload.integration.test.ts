/**
 * P-021 / D-015 — a novel third-party class contract travels inside the signed
 * Cupboard identity release and enters the destination's EXISTING
 * capability-class registry only through the consent-bound importer.
 *
 * Real publish signing, closure hashing, install validation, immutable release
 * store, Postgres registry/conformance/pot bindings, grant resolver and the
 * production ceiling validator (validateIdentityInstallGrants) are composed
 * here. Substituted: the git clone (fixture copy), and the ceiling POLICY
 * source (a fixture pot/role ceiling fed to the real validator).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIRST_PARTY_CLASS_NAMESPACE, snapshotPackageDirectory } from '@papercusp/orchestrator/blueprint';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import {
  defineCapabilityClass,
  getCapabilityClass,
  getPotCapabilityProviderBinding,
  listActiveCapabilityProviderCandidates,
  listProviderBindings,
  parseCapabilityClassRef,
  recordProviderConformance,
  validateProviderInterface,
} from '../capability-class-registry-store';
import { validateIdentityInstallGrants } from '../capability-envelope/identity-grants-port';
import { resolveCapabilityGrants } from './capability-grant-resolver';
import { prepareBlueprintPublicRelease } from './blueprint-release';
import { blueprintInstallJournal } from './blueprint-install-journal';
import { installBlueprintFromCupboardCore, type InstallBlueprintCoreDeps } from './install-blueprint-core';
import type { IdentityInstallConsent } from './identity-install-consent';
import {
  ClassContractImportError,
  classContractHash,
  importCupboardClassContracts,
  type ClassContract,
  type ClassContractConsent,
  type ClassContractPayloadEntry,
} from './class-contract-payload';
import type { CupboardReleaseManifest } from './listing-manifest';

const WS = 'ws-p021-class-contracts';
const CLASS_REF = 'publisher.mail-send@1.0.0';
const TOOL = 'publisher-mail:send';
const sendInput = { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false };
const sendOutput = { type: 'object', properties: { queued: { type: 'boolean' } }, required: ['queued'] };

let db: OrgTestDb;
let root = '';

beforeAll(async () => {
  db = await createOrgTestDb();
  root = await fs.mkdtemp(join(tmpdir(), 'p021-class-contracts-'));
}, 120_000);
afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  await db?.cleanup();
}, 30_000);

function contract(overrides: Partial<ClassContract> = {}): ClassContract {
  return {
    id: 'publisher.mail-send',
    version: '1.0.0',
    title: 'Send one mail message',
    description: 'Queue a single outbound message for a wearer.',
    interfaceVerbs: { send: { inputSchema: sendInput, outputSchema: sendOutput, capability: 'mail:send' } },
    behavioralSuiteRef: 'recipe:identity-recipe',
    tags: [],
    ...overrides,
  };
}

function entry(value: ClassContract, extra: Partial<ClassContractPayloadEntry> = {}): ClassContractPayloadEntry {
  return { ref: `${value.id}@${value.version}`, contractHash: classContractHash(value), contract: value, ...extra };
}

function approve(artifactContentHash: string, entries: readonly ClassContractPayloadEntry[]): ClassContractConsent {
  return {
    decision: 'approved',
    artifactContentHash,
    contracts: entries.map((item) => ({ ref: item.ref, contractHash: item.contractHash })),
  };
}

async function importedRows(): Promise<Array<{ id: string; version: string }>> {
  return db.adminSql<Array<{ id: string; version: string }>>`
    SELECT id, version FROM harness_shared.capability_class_registry
     WHERE workspace_id = ${WS} AND provenance_kind = 'cupboard-import' ORDER BY id, version`;
}

async function refusal(run: Promise<unknown>): Promise<ClassContractImportError> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClassContractImportError);
  return error as ClassContractImportError;
}

async function publishFixture() {
  const recipeDir = join(root, 'recipe');
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.writeFile(join(recipeDir, 'recipe.json'), '{"id":"identity-recipe","script":"return 1"}');
  const resolvePackage = async () => snapshotPackageDirectory({
    packageKind: 'recipe', ref: 'identity-recipe', revision: '1.0.0', dir: recipeDir,
    value: JSON.parse(await fs.readFile(join(recipeDir, 'recipe.json'), 'utf8')),
  });
  const sourceDir = join(root, 'mailer');
  await fs.mkdir(join(sourceDir, 'class-contracts'), { recursive: true });
  await fs.writeFile(join(sourceDir, 'blueprint.yaml'), [
    'id: mailer',
    'version: 1.0.0',
    'bundles: [{ kind: recipe, ref: identity-recipe, version: 1.0.0 }]',
    `grants: { requires: ['${CLASS_REF}'] }`,
  ].join('\n') + '\n');
  // The publisher also CLAIMS a passing conformance run. It is provenance only.
  await fs.writeFile(join(sourceDir, 'class-contracts', 'mail-send.json'), JSON.stringify({
    ...contract(),
    sourceConformance: [{ runId: 'publisher-claimed-pass', providerPackage: 'publisher-mail', providerVersion: '1.0.0' }],
  }, null, 2));
  const keypair = generateEd25519KeypairDer();
  const published = await prepareBlueprintPublicRelease({
    blueprintFile: join(sourceDir, 'blueprint.yaml'),
    listingRef: 'mailer',
    resolveExtends: () => null,
    resolvePackage,
    signer: {
      githubUserId: 7,
      githubLogin: 'publisher',
      devicePubkey: keypair.pubkeyBase64,
      sign: async (bytes: Uint8Array) => signWithPrivateKeyDer(keypair.privateKeyDer, Buffer.from(bytes)),
    },
    license: 'MIT',
  });
  return { sourceDir, resolvePackage, published };
}

function installDeps(
  sourceDir: string,
  resolvePackage: InstallBlueprintCoreDeps['resolvePackage'],
  potSlug: string,
  allowCapabilities: string[],
): InstallBlueprintCoreDeps {
  const scope = { workspaceId: WS, potSlug };
  return {
    cloneRepo: async (_url, destination) => fs.cp(sourceDir, destination, { recursive: true }),
    installedBlueprintsDir: () => join(root, `installed-${potSlug}`),
    tmpDir: () => root,
    resolveExtends: () => null,
    resolvePackage,
    resolveHostSets: async () => ({
      availableTools: new Set<string>(), installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(), cupboardReachable: true,
    }),
    importClassContracts: (input) => importCupboardClassContracts(db.adminSql, { ...input, workspaceId: WS }),
    capabilityGrantDeps: {
      async getPotBinding(classRef) {
        const parsed = parseCapabilityClassRef(classRef)!;
        return getPotCapabilityProviderBinding(db.adminSql, { ...scope, classId: parsed.id, classVersion: parsed.version });
      },
      async listCandidates(classRef) {
        const parsed = parseCapabilityClassRef(classRef)!;
        const rows = await listActiveCapabilityProviderCandidates(db.adminSql, WS, parsed.id, parsed.version);
        return rows.map((row) => ({ ...row, price: null }));
      },
    },
    // The production ceiling validator; only its policy SOURCE is a fixture.
    validateCapabilityGrants: (resolution, context) => validateIdentityInstallGrants(
      { workspaceId: WS, potSlug, role: context.role, resolution },
      async () => ({
        policyRevision: `fixture:${potSlug}`,
        potSlug,
        bindings: [],
        ceilings: [{ allowCapabilities }],
        tools: new Map([[TOOL, ['mail:send']]]),
        protectedAdditions: [],
      }),
    ),
    // The provider package is already present at this destination (its conformance
    // is recorded locally in the test), so the real closure reviewer returns an
    // installed root and zero installable units — the same shape as
    // capability-provider-package-closure.ts builds for an installed root.
    async reviewCapabilityProviderPackages(selections) {
      return {
        ok: true,
        roots: selections.map((selection) => ({
          providerPackage: selection.providerPackage,
          providerVersion: selection.providerVersion,
          classRefs: [selection.classRef],
          kind: 'plugin' as const,
          status: 'installed' as const,
          listingId: null,
        })),
        units: [],
        stillMissing: { tools: [], packs: [], plugins: [], events: [] },
        advisory: [],
        rounds: 0,
      };
    },
    // The production P-014 journal writes the pot binding.
    blueprintInstallJournal: ({ blueprintId, bindings }) => blueprintInstallJournal(
      { sql: db.adminSql, workspaceId: WS, blueprintId }, { operation: 'install', potSlug, bindings }),
  };
}

describe('P-021 portable class contracts through the signed Cupboard release (real PG)', () => {
  it('a consented signed package supplies an immutable namespaced contract; the destination verifies the binding within the ceiling', async () => {
    const { sourceDir, resolvePackage, published } = await publishFixture();
    const manifest: CupboardReleaseManifest = published.manifest.release;
    const artifact = published.manifest.rootHash;
    // The contract rides in the signed closure: its bytes are covered by the root hash.
    expect(published.source.archive.classContracts.map((item) => item.ref)).toEqual([CLASS_REF]);
    expect(published.source.archive.bytes.toString('utf8')).toContain('"classContracts"');
    const carried = published.source.archive.classContracts;
    // The signed listing declares the destination-independent consent subjects.
    expect(manifest.permissions).toEqual([`grant:${CLASS_REF}`, 'shared:recipe:identity-recipe']);

    const install = (
      potSlug: string, consent: ClassContractConsent | undefined, allow = ['mail:*'],
      identityInstallConsent?: IdentityInstallConsent,
    ) =>
      installBlueprintFromCupboardCore({
        githubUrl: 'https://github.com/publisher/mailer',
        expectedRelease: { manifest },
        ...(consent ? { classContractConsent: consent } : {}),
        ...(identityInstallConsent ? { identityInstallConsent } : {}),
        capabilityContext: { workspaceId: WS, potSlug, mode: 'agent' },
      }, installDeps(sourceDir, resolvePackage, potSlug, allow));

    // No consent / rejected / mismatched consent: refused, nothing written.
    await expect(install('pot-a', undefined)).rejects.toMatchObject({
      code: 'class_contract_consent_required',
      data: { consentSubject: { artifactContentHash: artifact.toLowerCase(), contracts: [{ ref: CLASS_REF }] } },
    });
    await expect(install('pot-a', { ...approve(artifact, carried), decision: 'rejected' }))
      .rejects.toMatchObject({ code: 'class_contract_consent-rejected' });
    await expect(install('pot-a', approve(`sha256:${'1'.repeat(64)}`, carried)))
      .rejects.toMatchObject({ code: 'class_contract_consent-mismatch' });
    expect(await importedRows()).toEqual([]);

    // Consent imports the contract, but a source conformance CLAIM binds nothing:
    // with no destination-verified provider the grant is unresolvable.
    await expect(install('pot-a', approve(artifact, carried)))
      .rejects.toMatchObject({ code: 'required_capability_provider_absent' });
    const row = await db.adminSql<Array<Record<string, unknown>>>`
      SELECT provenance_kind, publisher_namespace, contract_hash, source_artifact_hash, source_provenance, review_status
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${WS} AND id = 'publisher.mail-send' AND version = '1.0.0'`;
    expect(row[0]).toMatchObject({
      provenance_kind: 'cupboard-import', publisher_namespace: 'publisher',
      contract_hash: carried[0]!.contractHash, source_artifact_hash: artifact.toLowerCase(), review_status: 'approved',
      source_provenance: { publisherLogin: 'publisher', sourceConformance: [{ runId: 'publisher-claimed-pass' }] },
    });
    expect(await listProviderBindings(db.adminSql, WS, 'publisher.mail-send', '1.0.0')).toEqual([]);

    // Destination conformance runs against the destination's own live tool registry.
    const imported = (await getCapabilityClass(db.adminSql, WS, 'publisher.mail-send', '1.0.0'))!;
    const lookup = (name: string) => name === TOOL
      ? { name, pluginName: 'publisher-mail', providerVersion: '1.0.0', inputSchema: sendInput, outputSchema: sendOutput } : null;
    const report = validateProviderInterface({
      capabilityClass: imported, providerPackage: 'publisher-mail', providerVersion: '1.0.0',
      registryRevision: 'dest-rev-1', verbBindings: { send: TOOL }, lookup,
    });
    expect(report.ok).toBe(true);
    expect(report.behavioral).toEqual({ status: 'not-run', suiteRef: 'recipe:identity-recipe' });
    // A forged "passing" report whose checks fail is refused and records nothing.
    await expect(recordProviderConformance(db.adminSql, {
      workspaceId: WS, classId: 'publisher.mail-send', classVersion: '1.0.0',
      providerPackage: 'publisher-mail', providerVersion: '1.0.0', verbBindings: { send: TOOL },
      report: { ...report, checks: [{ ...report.checks[0]!, ok: false, problems: ['forged'] }] },
    })).rejects.toThrow(/verdict does not match/);
    expect(await listProviderBindings(db.adminSql, WS, 'publisher.mail-send', '1.0.0')).toEqual([]);
    const conformance = await recordProviderConformance(db.adminSql, {
      workspaceId: WS, classId: 'publisher.mail-send', classVersion: '1.0.0',
      providerPackage: 'publisher-mail', providerVersion: '1.0.0', verbBindings: { send: TOOL }, report,
    });
    expect(conformance.binding).toMatchObject({ classRef: CLASS_REF, behavioralStatus: 'not-run' });
    expect(conformance.runId).not.toBe('publisher-claimed-pass');

    // Within the pot ceiling, the D-034 seat asks once for the grant, the
    // binding it resolves here and the shared recipe; after that consent the
    // install succeeds and the import replays as a no-op.
    const asked = await install('pot-a', approve(artifact, carried)).catch((error: unknown) => error);
    expect(asked).toMatchObject({
      code: 'identity_install_consent_required',
      data: { subjects: {
        grants: [CLASS_REF],
        providerBindings: [`${CLASS_REF} → publisher-mail@1.0.0`],
        sharedContent: ['recipe:identity-recipe'],
      } },
    });
    expect(await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: 'pot-a', classId: 'publisher.mail-send', classVersion: '1.0.0',
    })).toBeNull();
    const identityConsent = (asked as { data: { consentSubject: IdentityInstallConsent } }).data.consentSubject;
    const ok = await install('pot-a', approve(artifact, carried), ['mail:*'], identityConsent);
    expect(ok.classContracts?.imported).toEqual([{ ref: CLASS_REF, contractHash: carried[0]!.contractHash, created: false }]);
    expect(ok.capabilityGrants?.selected).toMatchObject([{ classRef: CLASS_REF, providerPackage: 'publisher-mail' }]);
    const bound = await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: 'pot-a', classId: 'publisher.mail-send', classVersion: '1.0.0',
    });
    expect(bound?.verbBindings).toEqual({ send: TOOL });
    // The binding is the pot install's journaled resource, applied with the release.
    expect(bound?.boundBy).toMatch(/^cupboard:install-blueprint#/);
    expect(ok.bindingJournal?.pots).toMatchObject([{
      potSlug: 'pot-a', applied: true, bindings: [`${CLASS_REF} → publisher-mail@1.0.0`],
    }]);

    // Exceeding the ceiling: the same verified provider is refused for a pot
    // whose ceiling does not admit mail:send, before any binding is written.
    await expect(install('pot-b', approve(artifact, carried), ['calendar:*']))
      .rejects.toMatchObject({ code: 'capability_unsatisfied', status: 403 });
    expect(await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: 'pot-b', classId: 'publisher.mail-send', classVersion: '1.0.0',
    })).toBeNull();

    // Binding an unknown class resolves to absent, never to a guessed provider.
    const unknown = await resolveCapabilityGrants(
      { requires: ['publisher.never-published@1.0.0'] },
      installDeps(sourceDir, resolvePackage, 'pot-a', ['mail:*']).capabilityGrantDeps!,
      { mode: 'agent' },
    );
    expect(unknown.missingRequired).toEqual(['publisher.never-published@1.0.0']);

    // Contract bytes changed after signing: the signed hash pin refuses the install.
    await fs.writeFile(join(sourceDir, 'class-contracts', 'mail-send.json'),
      JSON.stringify({ ...contract(), description: 'Silently widened after signing.' }));
    await expect(install('pot-a', approve(artifact, carried))).rejects.toThrow(/signed manifest for mailer@1\.0\.0 pins/);
  }, 120_000);

  it('refuses each unsafe import with its own code and writes nothing', async () => {
    const before = await importedRows();
    const base = {
      workspaceId: WS, artifactContentHash: `sha256:${'a'.repeat(64)}`, publisherLogin: 'publisher',
      closurePins: [{ packageKind: 'recipe', ref: 'identity-recipe' }],
    };
    const run = (entries: ClassContractPayloadEntry[], overrides: Partial<typeof base> = {}) =>
      importCupboardClassContracts(db.adminSql, {
        ...base, ...overrides, entries, consent: approve(overrides.artifactContentHash ?? base.artifactContentHash, entries),
      });

    const forged = entry(contract({ id: 'publisher.forged', version: '1.0.0' }));
    const forgedError = await refusal(importCupboardClassContracts(db.adminSql, {
      ...base, entries: [{ ...forged, contractHash: `sha256:${'f'.repeat(64)}` }], consent: approve(base.artifactContentHash, [forged]),
    }));
    expect(forgedError.code).toBe('forged-hash');

    expect((await refusal(run([entry(contract({ id: 'publisher.squat' }))], { publisherLogin: 'mallory' }))).code)
      .toBe('namespace-squat');

    await defineCapabilityClass(db.adminSql, {
      workspaceId: WS, id: 'crm.email', version: '1.0.0', title: 'Platform email', description: 'platform-defined',
      interfaceVerbs: { send: { inputSchema: sendInput } },
    });
    expect((await refusal(run([entry(contract({ id: 'crm.email-plus' }))], { publisherLogin: 'crm' }))).code)
      .toBe('platform-shadow');

    // First-party classes are code, not rows (D-039): their namespace is held with no registry row.
    const firstPartyShadow = contract({ id: `${FIRST_PARTY_CLASS_NAMESPACE}.leader-brief` });
    expect((await getCapabilityClass(db.adminSql, WS, firstPartyShadow.id, firstPartyShadow.version))).toBeNull();
    expect((await refusal(run([entry(firstPartyShadow)], { publisherLogin: FIRST_PARTY_CLASS_NAMESPACE }))).code)
      .toBe('platform-shadow');

    expect((await refusal(run([entry(contract({ description: 'Different bytes, same version.' }))]))).code)
      .toBe('same-version-changed-bytes');

    const widened = contract({ version: '1.1.0', interfaceVerbs: {
      send: { inputSchema: { ...sendInput, required: [] }, outputSchema: sendOutput, capability: 'mail:send' },
    } });
    expect((await refusal(run([entry(widened)]))).code).toBe('schema-widening');

    expect((await refusal(run([entry(contract({ id: 'publisher.suite', behavioralSuiteRef: 'recipe:missing-suite' }))]))).code)
      .toBe('unresolved-ref');

    expect((await refusal(run([entry(contract({ id: 'publisher.unsigned' }))], { publisherLogin: null as unknown as string }))).code)
      .toBe('unsigned-publisher');

    expect(await importedRows()).toEqual(before);

    // Adding a verb within the same major is allowed and is a new immutable version.
    const added = contract({ version: '1.2.0', interfaceVerbs: {
      ...contract().interfaceVerbs, cancel: { inputSchema: sendInput },
    } });
    expect((await run([entry(added)])).imported).toEqual([
      { ref: 'publisher.mail-send@1.2.0', contractHash: classContractHash(added), created: true },
    ]);
  }, 60_000);
});
