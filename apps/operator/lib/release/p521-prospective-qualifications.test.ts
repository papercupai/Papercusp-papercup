/**
 * Independent D298-D302 qualification oracle, WI-6554700010020476.
 * Private signed unit originals only: these never attest a physical execution.
 * Resolver maps model custody acquired separately from the untrusted packet.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import {
  canonicalJson, signAuthorityRpc, verifyAuthorityRpc,
} from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../../packages/operator-core/lib/identity/ed25519';
import {
  TestRunArtifactPacket, testRunDeadline,
} from '../../../../packages/operator-core/lib/agent-tools/testing/run-artifacts';
import { parseVitestJsonForHarnessRows } from '../../../../packages/operator-core/lib/testing-run-store';
import { CURRENT_SCHEMA_VERSION } from '../../../../packages/operator-core/lib/sync/hyperbee/schema-version';
import * as consumer from './p2p-candidate-evidence';

type Data = Record<string, any>; // Deliberately mutable adversarial JSON, never a production trust type.
interface Raw { ref: string; bytesBase64: string; sha256: string }
interface Report { ok: boolean; checks: Array<{ id: string; status: string; detail: string }> }
interface Resolvers {
  resolveCustody(subject: Data): Data | null;
  resolveOriginal(ref: string): Raw | null;
  resolvePrecheck(ref: string): Data | null;
}
interface Fixture {
  input: Data;
  deps: Resolvers;
  originals: Map<string, Raw>;
  prechecks: Map<string, Data>;
  custody: Data;
  devices: ReturnType<typeof generateEd25519KeypairDer>[];
  rebind(record: Data): Promise<void>;
}
const PLAN = 'p2p-public-release-endgame-2026-09-01';
const WORKSPACE = 'private-qualification-workspace';
const HARNESS = 'papercusp';
const START = Date.parse('2026-10-23T08:00:00Z');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Populations are independent literals: deleting a producer entry cannot shrink them.
const KINDS = ['restart', 'hlc-rules', 'churn', 'revocation'] as const;
const CORE = ['create', 'announced', 'degraded-cupboard', 'discovered', 'member-links', 'join-offer',
  'offer-from-directory', 'join', 'join-clone', 'federate-A-to-B', 'federate-B-to-A', 'federate-continuous'];
const TABLES = ['contributors', 'claims', 'queue', 'working-set', 'features-by-id', 'plans-by-slug', 'issues',
  'presence', 'usage', 'coord-conversations', 'coord-messages', 'coord-threads', 'coord-thread-posts',
  'item-assignments', 'hive-settings-by-key', 'agent-facts-by-key', 'p2p-memories-by-id', 'gym-qd-elites-by-niche',
  'bee-claim-specs', 'gate-verdicts', 'hive-policy', 'hive-reports', 'hive-pending-joins', 'hive-members',
  'hive-epoch-keys', 'engineer-issues', 'plan-parts', 'p2p-peer-grants', 'p2p-receipts', 'p2p-fleet-directory',
  'p2p-work-offers', 'p2p-fleet-leader-leases'];
const MERGE_FILE = 'packages/operator-core/lib/sync/hyperbee/__tests__/p532-prospective-merge-contract.test.ts';
const WRITER_FILE = 'packages/operator-core/lib/sync/hyperbee/__tests__/p532-prospective-table-writers.integration.test.ts';
const FILE_PINS = [
  { path: MERGE_FILE, sha256: '7b6c5d8fe2259a6a611c345eab959e078a087dabbc2acf21bb9391d0117dc7e1' },
  { path: WRITER_FILE, sha256: '2e844e7a57591ef097c6909fed3f018641ee0b2b5de514da954081d701754deb' },
];
const MERGE_CASES = [
  'refuses registration of a replicated table with no declared merge rule',
  'refuses an unknown merge rule instead of silently defaulting to LWW',
  'refuses a remote table operation without HLC before writing data',
  'a declared LWW table accepts an operation carrying its causal clock',
  'the causal winner is independent of arrival order and contrary wall-clock order',
  ...['""', '"not-an-hlc"', '"123"', '"ffffffffffffffffffffffffffffffff"'].map(value => `refuses malformed remote HLC ${value} before data writes`),
  'the producer refuses or repairs a malformed preset clock instead of propagating it',
  'the complete production projection census equals its declared registry and has a rule per table',
  ...['full', 'incremental'].map(fold => `${fold} fold converges to the causal LWW winner in both arrival orders`),
  ...['append-only', 'set-union', 'counter'].map(rule => `${rule} contributions survive both fold paths and opposing arrivals without replay inflation`),
  'append-only rejects a causal tombstone at the maintained apply boundary',
];
const WRITER_CASES = [
  'single admitted writer persists a typed usage row once across replay',
  ...['full', 'incremental'].map(fold => `${fold} fold preserves set fields, event identities and additive usage under reverse arrivals and replay`),
  ...['full', 'incremental'].map(fold => `${fold} fold scopes claim replay authority to the exact receiver-stamped snapshot event`),
];
function bodyWithout(value: Data, key: string): Data {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
function decoded(raw: Raw): any { return JSON.parse(Buffer.from(raw.bytesBase64, 'base64').toString('utf8')); }

async function fixture(): Promise<Fixture> {
  const devices = [0, 1, 2].map(() => generateEd25519KeypairDer());
  const hosts = devices.map((device, index) => ({
    schemaVersion: 'hive-git-physical-host-identity/v1', hostId: ['owner', 'member', 'joiner'][index]!,
    deviceKey: device.pubkeyBase64, keychainId: `${5000 + index}:private-machine-${index}`,
    githubUserId: 5000 + index, githubLogin: `fixture-${index}`, machineFingerprint: sha(`machine-${index}`),
  }));
  const subject = { sourceSha: 'cbd21646b5c73bd23cad5608f9526cf9bd0048ce', artifactDigest: sha('candidate'),
    installerSha256: sha('installer'), runtimeSha256: sha('runtime'), seedSha256: sha('seed'), builtAtMs: START - 60_000 };
  const originals = new Map<string, Raw>();
  const prechecks = new Map<string, Data>();
  let sequence = 0;
  const rawBytes = (name: string, bytes: string): Raw => {
    const result = { ref: `fixture:${name}:${sequence++}`, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
    originals.set(result.ref, structuredClone(result));
    return result;
  };
  const raw = (name: string, value: unknown): Raw => rawBytes(name, canonicalJson(value));
  const atom = (name: string, value: Data): Data => ({ ...value, raw: raw(name, value) });
  const step = (name: string, at: number, argv = ['papercusp-fixture-probe', name]) => atom(name, {
    name, startMs: START + at, endMs: START + at + 10, argv, exitCode: 0, skipped: 0,
  });
  const write = (id: string, hostId: string, at: number, epoch = 7, key = id, clock = at) => atom(id, {
    id, hostId, atMs: START + at,
    op: { type: 'put', table: 'engineer-issues', hbKey: key, value: { id, content: `private-${id}` },
      ts: START + (100_000 - at), hlc: encodeHlc({ ms: START + clock, count: 0 }), epoch,
      schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: hosts.find(host => host.hostId === hostId)!.deviceKey },
  });
  const row = (entry: Data) => bodyWithout(bodyWithout(entry.op, 'type'), 'value');
  const snapshot = (entry: Data) => ({ ...row(entry), value: entry.op.value });
  const seen = (entry: Data, hostId: string, at: number) => atom(`seen-${entry.id}-${hostId}`, {
    writeId: entry.id, hostId, atMs: START + at, row: snapshot(entry),
  });
  const common = (kind: string, at: number): Data => ({ kind, subject: structuredClone(subject), workspaceId: WORKSPACE,
    harnessSlug: HARNESS, planSlug: PLAN, runId: `private-${kind}`, startMs: START + at, endMs: START + at + 20_000,
    hosts: structuredClone(hosts), raw: [], attestations: [] });

  // A retained TestRunArtifactPacket with a complete synthetic reporter is a UNIT
  // model of a native npm run. It is never registered as a real test-ledger run.
  const dir = mkdtempSync(join(tmpdir(), 'p521-qualification-packet-'));
  temporary.push(dir);
  const packet = new TestRunArtifactPacket('private-p532-precheck', root,
    testRunDeadline(60_000, { now: START - 40_000 }), dir);
  packet.captureSelectedSources(FILE_PINS.map(file => file.path), { head: subject.sourceSha, dirty: false });
  packet.childState = 'closed';
  packet.stage('child-close', { exitCode: 0, signal: null });
  const command = ['npm', 'run', 'test:file', '--', MERGE_FILE, WRITER_FILE];
  packet.finish({ exitCode: 0, command, startedAtMs: START - 39_000, finishedAtMs: START - 20_000,
    workspaceId: WORKSPACE, harnessSlug: HARNESS });
  const report = { success: true, numTotalTestSuites: 2, numPassedTestSuites: 2,
    numTotalTests: 22, numPassedTests: 22, numFailedTests: 0, numPendingTests: 0,
    testResults: [MERGE_CASES, WRITER_CASES].map((cases, index) => ({
      name: join(root, FILE_PINS[index]!.path), status: 'passed', startTime: START - 39_000, endTime: START - 20_000,
      assertionResults: cases.map(title => ({ title, fullName: title, ancestorTitles: [], status: 'passed', duration: 1, failureMessages: [] })),
    })) };
  const ledgerRows = parseVitestJsonForHarnessRows(JSON.stringify(report), root).map((entry, index) => raw(`ledger-${index}`, {
    ...entry, runId: packet.runId, workspaceId: WORKSPACE, harnessSlug: HARNESS,
    sourceSha: subject.sourceSha, worktreeDirty: false, childSubstituted: false,
  }));
  const execution = { runId: packet.runId, root,
    manifest: raw('manifest', JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))),
    phases: rawBytes('phases', readFileSync(packet.paths.phases, 'utf8')),
    source: raw('source', JSON.parse(readFileSync(join(packet.paths.directory, 'source.json'), 'utf8'))),
    runtimeInputs: [raw('runtime-inputs', { runId: packet.runId, workspaceId: WORKSPACE, harnessSlug: HARNESS,
      sourceSha: subject.sourceSha, subject, files: FILE_PINS, loadedSourceFiles: FILE_PINS,
      command, executable: process.execPath, npmLifecycleShell: 'sh -c', childSubstituted: false })],
    reports: [raw('vitest-report', report)], stdout: rawBytes('stdout', 'Test Files  2 passed (2)\nTests  22 passed (22)\n'),
    stderr: rawBytes('stderr', ''), ledgerRows };
  const receipt = raw('precheck', { journey: 'git-consistency-signed-scope',
    check: 'p521-local-precheck:git-consistency-signed-scope', verdict: 'pass',
    startedAt: new Date(START - 39_000).toISOString(), finishedAt: new Date(START - 20_000).toISOString(),
    subject: Object.fromEntries(['artifactDigest', 'installerSha256', 'runtimeSha256', 'seedSha256'].map(key => [key, subject[key as keyof typeof subject]])),
    command, evidence: [execution.manifest, execution.source, ...execution.runtimeInputs, ...execution.reports,
      execution.stdout, execution.stderr, ...ledgerRows].map(value => ({ ref: value.ref, kind: 'testing-run-original' })),
    exitCode: 0, skipped: 0 });
  prechecks.set(receipt.ref, { receipt, execution });

  const restart = common('restart', 0);
  restart.core = CORE.map((name, index) => step(name, index * 20));
  restart.restarts = hosts.slice(0, 2).map((host, index) => atom(`restart-${host.hostId}`, {
    hostId: host.hostId, startMs: START + 1000 + index * 3000, endMs: START + 1100 + index * 3000,
    beforeRuntime: `${host.hostId}-boot-1`, afterRuntime: `${host.hostId}-boot-2`,
  }));
  restart.writes = restart.restarts.flatMap((entry: Data, index: number) => [
    write(`restart-${index}-out`, 'owner', entry.endMs - START + 100),
    write(`restart-${index}-in`, 'member', entry.endMs - START + 200),
  ]);
  restart.seen = restart.writes.map((entry: Data) => seen(entry, entry.hostId === 'owner' ? 'member' : 'owner', entry.atMs - START + 200));

  const hlc = common('hlc-rules', 30_000);
  hlc.precheck = receipt;
  hlc.rules = TABLES.map(table => ({ table, mergeRule: table === 'usage' ? 'counter' : table === 'coord-messages' ? 'append-only' : table === 'hive-members' ? 'set-union' : 'lww' }));
  hlc.writes = [write('causal-early', 'owner', 31_000, 7, 'same-key', 1000), write('causal-late', 'member', 31_100, 7, 'same-key', 2000)];
  hlc.arrivals = hosts.map((host, index) => atom(`arrival-${host.hostId}`, {
    hostId: host.hostId, writeIds: (index % 2 ? [...hlc.writes].reverse() : hlc.writes).map((entry: Data) => entry.id),
    rows: [snapshot(hlc.writes[1])],
  }));

  const churn = common('churn', 60_000);
  Object.assign(churn, { joiningHostId: 'joiner', survivorHostIds: ['owner', 'member'], joinMs: START + 62_000,
    departMs: START + 66_000, rejoinMs: START + 70_000 });
  churn.rosters = ['before', 'joined', 'departed', 'rejoined'].flatMap((stage, stageIndex) => {
    const members = (stage === 'before' || stage === 'departed' ? hosts.slice(0, 2) : hosts);
    return members.map(host => atom(`roster-${stage}-${host.hostId}`, { hostId: host.hostId, stage,
      atMs: START + [61_000, 63_000, 67_000, 71_000][stageIndex]!,
      members: members.map(member => ({ githubUserId: member.githubUserId, deviceKeys: [member.deviceKey] })) }));
  });
  churn.prejoin = write('prejoin', 'owner', 60_100);
  churn.cWrites = [write('joined-to-owner', 'joiner', 64_000), write('joined-to-member', 'joiner', 64_100)];
  churn.survivorWrite = write('survivor-during-outage', 'owner', 68_000);
  churn.seen = [seen(churn.prejoin, 'owner', 60_200), seen(churn.prejoin, 'member', 60_300),
    seen(churn.prejoin, 'joiner', 63_100), seen(churn.cWrites[0], 'owner', 64_200), seen(churn.cWrites[1], 'member', 64_300),
    seen(churn.survivorWrite, 'member', 68_100), seen(churn.survivorWrite, 'joiner', 71_100)];

  const revocation = common('revocation', 90_000);
  Object.assign(revocation, { ownerHostId: 'owner', revokedHostId: 'joiner', survivorHostId: 'member', epochBefore: 7, epochAfter: 8,
    revoke: step('owner-revoke', 93_000, ['papercusp', 'pot:revoke-member', '--device', hosts[2]!.deviceKey]),
    deniedReconnect: step('denied-reconnect', 96_000), readmit: step('owner-readmit', 98_000),
    pre: write('pre-revoke', 'owner', 91_000, 7), post: write('post-revoke', 'owner', 94_000, 8),
    afterReadmit: write('fresh-after-readmit', 'owner', 100_000, 8) });
  const read = (hostId: string, entry: Data, at: number, readable: boolean) => atom(`read-${entry.id}-${hostId}-${at}`, {
    hostId, writeId: entry.id, atMs: START + at, exitCode: 0, rows: readable ? [snapshot(entry)] : [],
    decryption: readable ? 'readable' : 'denied',
  });
  revocation.reads = [read('joiner', revocation.pre, 92_000, true), read('member', revocation.pre, 92_100, true),
    read('joiner', revocation.post, 95_000, false), read('member', revocation.post, 95_100, true),
    read('joiner', revocation.post, 97_000, false), read('joiner', revocation.afterReadmit, 101_000, true),
    read('member', revocation.afterReadmit, 101_100, true)];
  revocation.keyInventory = ['before', 'revoked', 'readmitted'].flatMap(stage => ['joiner', 'member'].map(hostId => atom(`keys-${stage}-${hostId}`, {
    hostId, stage, epochs: stage === 'before' || (stage === 'revoked' && hostId === 'joiner') ? [7] : [7, 8],
  })));
  const admissionPayload = { workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN,
    ownerDeviceKey: hosts[0]!.deviceKey, memberDeviceKey: hosts[2]!.deviceKey,
    githubUserId: hosts[2]!.githubUserId, admittedAtMs: START + 98_000, epoch: 8 };
  const admissionAuth = await signAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-readmission/v1', payload: admissionPayload,
    device_pubkey: hosts[0]!.deviceKey }, async bytes => signWithPrivateKeyDer(devices[0]!.privateKeyDer, bytes),
  { nowMs: START + 98_000, nonce: 'private-owner-readmit' });
  const admission = raw('readmission', { harnessSlug: HARNESS, kind: 'p521-readmission/v1', payload: admissionPayload, auth: admissionAuth });
  revocation.readmit.argv.push('--authorization-ref', admission.ref);
  // Rebind changed argv to its atomic original before signing the common body.
  revocation.readmit.raw = raw('owner-readmit', bodyWithout(revocation.readmit, 'raw'));

  const records = [restart, hlc, churn, revocation];
  let custody: Data | undefined;
  function atomicRaws(value: any): Raw[] {
    if (!value || typeof value !== 'object') return [];
    if (typeof value.ref === 'string' && typeof value.bytesBase64 === 'string') return [value];
    return Object.entries(value).filter(([key]) => !['raw', 'attestations'].includes(key)).flatMap(([, child]) => atomicRaws(child))
      .concat(value.raw && !Array.isArray(value.raw) ? [value.raw] : []);
  }
  async function rebind(record: Data): Promise<void> {
    // Semantic counterexamples represent corrupted observations from an admitted
    // writer: re-encode their actual atomic originals and genuinely sign them.
    // This prevents a hash-only verifier from catching every semantic mutant.
    // Substitution tests deliberately DO NOT call this helper: their maps stay fixed.
    function refreshAtomic(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (value.raw && !Array.isArray(value.raw)) {
        const bytes = canonicalJson(bodyWithout(value, 'raw'));
        value.raw = { ...value.raw, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
        originals.set(value.raw.ref, structuredClone(value.raw));
      }
      for (const [key, child] of Object.entries(value)) if (!['raw', 'attestations'].includes(key)) refreshAtomic(child);
    }
    refreshAtomic(record);
    // Keep executed-original controls byte-consistent while changing one actual
    // report/chronology/child-state property. Canonical maps remain independent.
    for (const precheck of prechecks.values()) {
      for (const value of [precheck.receipt, ...atomicRaws(precheck.execution)]) {
        value.sha256 = sha(Buffer.from(value.bytesBase64, 'base64'));
        originals.set(value.ref, structuredClone(value));
      }
    }
    record.raw = [...new Map([...atomicRaws(record), ...(record.kind === 'revocation' ? [admission] : [])].map(value => [value.ref, value])).values()];
    record.attestations = await Promise.all(hosts.map(async (host, index) => ({ hostId: host.hostId,
      auth: await signAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-qualification/v1',
        payload: bodyWithout(record, 'attestations'), device_pubkey: host.deviceKey },
      async bytes => signWithPrivateKeyDer(devices[index]!.privateKeyDer, bytes), { nowMs: record.endMs, nonce: `private-${record.runId}-${host.hostId}` }),
    })));
    if (custody) custody.originalInventory = [...originals.values()].map(({ ref, sha256 }) => ({ ref, sha256 }));
  }
  for (const record of records) await rebind(record);
  custody = { subject: structuredClone(subject), workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN,
    expectedHosts: structuredClone(hosts), expectedTables: [...TABLES], precheckFiles: structuredClone(FILE_PINS),
    originalInventory: [...originals.values()].map(({ ref, sha256 }) => ({ ref, sha256 })) };
  const deps: Resolvers = {
    resolveCustody: supplied => canonicalJson(supplied) === canonicalJson(subject) ? structuredClone(custody) : null,
    resolveOriginal: ref => { const value = originals.get(ref); return value ? structuredClone(value) : null; },
    resolvePrecheck: ref => { const value = prechecks.get(ref); return value ? structuredClone(value) : null; },
  };
  return { input: { subject, expectedHosts: structuredClone(hosts), expectedTables: [...TABLES], records },
    deps, originals, prechecks, custody, devices, rebind };
}

function evaluate(f: Fixture): Report {
  const candidate: unknown = Reflect.get(consumer, 'validateP521Qualifications');
  expect(candidate, 'D302 requires the maintained qualification verifier, not a fixture verdict').toBeTypeOf('function');
  return (candidate as (input: Data, deps: Resolvers) => Report)(f.input, f.deps);
}
function rejected(f: Fixture, kind?: string) {
  const report = evaluate(f);
  expect(report.ok).toBe(false);
  const ids = ['P-521:qualification', ...KINDS.map(value => `P-521:qualification:${value}`)];
  for (const id of ids) expect(report.checks.filter(check => check.id === id), id).toHaveLength(1);
  for (const id of ['P-521:qualification', ...(kind ? [`P-521:qualification:${kind}`] : [])]) {
    const check = report.checks.find(value => value.id === id)!;
    expect(check.status).not.toBe('pass');
    expect(check.detail.trim()).not.toBe('');
  }
}
const recordOf = (f: Fixture, kind: string): Data => f.input.records.find((record: Data) => record.kind === kind)!;

/** Sign substituted bytes with the SAME admitted fixture keys, without touching
 * any independent resolver or inventory. Crypto/custody-only guards must miss it. */
async function standaloneResign(record: Data, f: Fixture): Promise<void> {
  const replacements = new Map<string, Raw>();
  function visit(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (value.raw && !Array.isArray(value.raw)) {
      const bytes = canonicalJson(bodyWithout(value, 'raw'));
      value.raw = { ...value.raw, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
      replacements.set(value.raw.ref, value.raw);
    }
    for (const [key, child] of Object.entries(value)) if (!['raw', 'attestations'].includes(key)) visit(child);
  }
  visit(record);
  record.raw = record.raw.map((value: Raw) => replacements.get(value.ref) ?? value);
  record.attestations = await Promise.all(record.hosts.map(async (host: Data) => {
    const index = f.input.expectedHosts.findIndex((value: Data) => value.deviceKey === host.deviceKey);
    return { hostId: host.hostId, auth: await signAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-qualification/v1',
      payload: bodyWithout(record, 'attestations'), device_pubkey: host.deviceKey },
    async bytes => signWithPrivateKeyDer(f.devices[index]!.privateKeyDer, bytes),
    { nowMs: record.endMs, nonce: `private-replacement-${record.runId}-${host.hostId}` }) };
  }));
}

describe('D298-D302 independently resolved signed P521 qualification originals', () => {
  it('constructs nonvacuous signed originals and parses the full two-file reporter (fixture control)', async () => {
    const f = await fixture();
    expect(f.input.records.map((record: Data) => record.kind)).toEqual([...KINDS]);
    for (const pin of FILE_PINS) expect(sha(readFileSync(join(root, pin.path)))).toBe(pin.sha256);
    for (const original of f.originals.values()) expect(sha(Buffer.from(original.bytesBase64, 'base64'))).toBe(original.sha256);
    for (const record of f.input.records) for (const { auth } of record.attestations) {
      expect(verifyAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-qualification/v1', payload: bodyWithout(record, 'attestations') },
        auth, { nowMs: record.endMs })).toBe(true);
    }
    const precheck = [...f.prechecks.values()][0]!;
    const rows = parseVitestJsonForHarnessRows(canonicalJson(decoded(precheck.execution.reports[0])), root);
    expect(rows.map(value => value.filePath)).toEqual(FILE_PINS.map(value => value.path));
    expect(rows.map(value => value.execution?.passed)).toEqual([17, 5]);
    expect(rows.every(value => value.status === 'pass')).toBe(true);
    expect(new Set(f.input.expectedHosts.map((host: Data) => host.machineFingerprint)).size).toBe(3);
  });

  it('accepts the complete four-variant packet against independently fixed maps', async () => {
    const report = evaluate(await fixture());
    expect(report.ok).toBe(true);
    expect(report.checks.filter(check => check.status === 'pass').map(check => check.id).sort()).toEqual(
      ['P-521:qualification', ...KINDS.map(kind => `P-521:qualification:${kind}`)].sort());
  });
  it.each(KINDS)('refuses missing %s without shrinking the required population', async kind => {
    const f = await fixture(); f.input.records = f.input.records.filter((record: Data) => record.kind !== kind); rejected(f, kind);
  });
  it.each(['duplicate', 'extra', 'no-custody', 'foreign-subject', 'reduced-tables', 'reduced-hosts'])(
    'refuses %s at the independently admitted boundary', async defect => {
      const f = await fixture();
      if (defect === 'duplicate') f.input.records.push(structuredClone(f.input.records[0]));
      if (defect === 'extra') f.input.records.push({ ...f.input.records[0], kind: 'unknown' });
      if (defect === 'no-custody') f.deps.resolveCustody = () => null;
      if (defect === 'foreign-subject') f.input.subject.seedSha256 = sha('foreign');
      if (defect === 'reduced-tables') f.input.expectedTables.pop();
      if (defect === 'reduced-hosts') f.input.expectedHosts.pop();
      rejected(f);
    });
  it.each(KINDS)('refuses a separately signed self-consistent %s substitution while resolver maps stay fixed', async kind => {
    const f = await fixture(); const replacement = await fixture();
    f.input.records[f.input.records.findIndex((record: Data) => record.kind === kind)] = recordOf(replacement, kind);
    rejected(f, kind);
  });
  it.each(KINDS)('refuses byte-substituted %s originals signed by the SAME admitted devices', async kind => {
    const f = await fixture(); const before = canonicalJson([...f.originals]);
    const r = structuredClone(recordOf(f, kind));
    const entry = kind === 'restart' ? r.writes[0] : kind === 'hlc-rules' ? r.writes[1] : kind === 'churn' ? r.prejoin : r.pre;
    entry.op.value.content = 'different-but-self-consistent-private-content';
    for (const observation of r.seen ?? []) if (observation.writeId === entry.id) observation.row.value = structuredClone(entry.op.value);
    for (const arrival of r.arrivals ?? []) arrival.rows[0].value = structuredClone(entry.op.value);
    for (const read of r.reads ?? []) if (read.writeId === entry.id && read.rows.length) read.rows[0].value = structuredClone(entry.op.value);
    await standaloneResign(r, f);
    for (const { auth } of r.attestations) expect(verifyAuthorityRpc({ harnessSlug: HARNESS,
      kind: 'p521-qualification/v1', payload: bodyWithout(r, 'attestations') }, auth, { nowMs: r.endMs })).toBe(true);
    expect(canonicalJson([...f.originals]), 'independent originals must remain fixed').toBe(before);
    f.input.records[f.input.records.findIndex((value: Data) => value.kind === kind)] = r;
    rejected(f, kind);
  });
  it.each(['bad-signature', 'missing-host-signature', 'stale-signature', 'raw-byte-tamper', 'missing-inventory-ref'])(
    'refuses %s despite a passing-looking record', async defect => {
      const f = await fixture(); const record = recordOf(f, 'restart');
      if (defect === 'bad-signature') record.attestations[0].auth.sig = Buffer.alloc(64).toString('base64');
      if (defect === 'missing-host-signature') record.attestations.pop();
      if (defect === 'stale-signature') record.attestations[0].auth.ts = record.startMs - 200_000;
      if (defect === 'raw-byte-tamper') record.writes[0].raw.bytesBase64 = Buffer.from('{}').toString('base64');
      if (defect === 'missing-inventory-ref') f.originals.delete(record.writes[0].raw.ref);
      rejected(f, 'restart');
    });
  it.each(['core-subset', 'wrong-order', 'core-over-90s', 'unchanged-runtime', 'missing-return-write', 'late-transfer', 'wrong-observed-row'])(
    'refuses signed restart semantic corruption: %s', async defect => {
      const f = await fixture(); const r = recordOf(f, 'restart');
      if (defect === 'core-subset') r.core.pop();
      if (defect === 'wrong-order') r.core.reverse();
      if (defect === 'core-over-90s') r.core[0].endMs = r.core[0].startMs + 90_001;
      if (defect === 'unchanged-runtime') r.restarts[0].afterRuntime = r.restarts[0].beforeRuntime;
      if (defect === 'missing-return-write') r.writes = r.writes.filter((value: Data) => value.hostId !== 'member');
      if (defect === 'late-transfer') r.seen[0].atMs = r.writes[0].atMs + 90_001;
      if (defect === 'wrong-observed-row') r.seen[0].row.value = { unrelated: true };
      await f.rebind(r); rejected(f, 'restart');
    });
  it.each(['wall-clock-winner', 'missing-rule', 'same-arrival-order', 'unresolved-precheck', 'late-precheck',
    'aggregate-only-report', 'filtered-report', 'failed-case', 'skipped-case', 'open-child', 'missing-loaded-inputs', 'foreign-run', 'ledger-disagrees'])(
    'refuses signed HLC/precheck corruption: %s', async defect => {
      const f = await fixture(); const r = recordOf(f, 'hlc-rules'); const pre = f.prechecks.get(r.precheck.ref)!;
      if (defect === 'wall-clock-winner') r.arrivals[0].rows[0] = decoded(r.writes[0].raw).op;
      if (defect === 'missing-rule') r.rules.pop();
      if (defect === 'same-arrival-order') r.arrivals.forEach((arrival: Data) => { arrival.writeIds = r.writes.map((value: Data) => value.id); });
      if (defect === 'unresolved-precheck') f.prechecks.clear();
      if (defect === 'late-precheck') { const v = decoded(pre.receipt); v.finishedAt = new Date(r.startMs + 1).toISOString(); pre.receipt.bytesBase64 = Buffer.from(canonicalJson(v)).toString('base64'); }
      if (['aggregate-only-report', 'filtered-report', 'failed-case', 'skipped-case'].includes(defect)) {
        const v = decoded(pre.execution.reports[0]);
        if (defect === 'aggregate-only-report') v.testResults.forEach((file: Data) => { delete file.assertionResults; });
        if (defect === 'filtered-report') v.testResults[1].assertionResults.pop();
        if (defect === 'failed-case') v.testResults[1].assertionResults[0].status = 'failed';
        if (defect === 'skipped-case') v.testResults[1].assertionResults[0].status = 'skipped';
        pre.execution.reports[0].bytesBase64 = Buffer.from(canonicalJson(v)).toString('base64');
      }
      if (defect === 'open-child') { const v = decoded(pre.execution.manifest); v.childState = 'pending'; pre.execution.manifest.bytesBase64 = Buffer.from(canonicalJson(v)).toString('base64'); }
      if (defect === 'missing-loaded-inputs') pre.execution.runtimeInputs = [];
      if (defect === 'foreign-run') pre.execution.runId = 'foreign-run';
      if (defect === 'ledger-disagrees') pre.execution.ledgerRows = [];
      await f.rebind(r); rejected(f, 'hlc-rules');
    });
  it.each(['two-machines', 'missing-roster', 'no-prejoin-backfill', 'broken-survivor-wire', 'no-rejoin-backfill'])(
    'refuses signed churn corruption: %s', async defect => {
      const f = await fixture(); const r = recordOf(f, 'churn');
      if (defect === 'two-machines') r.hosts[2].machineFingerprint = r.hosts[1].machineFingerprint;
      if (defect === 'missing-roster') r.rosters.pop();
      if (defect === 'no-prejoin-backfill') r.seen = r.seen.filter((value: Data) => !(value.writeId === r.prejoin.id && value.hostId === 'joiner'));
      if (defect === 'broken-survivor-wire') r.seen = r.seen.filter((value: Data) => !(value.writeId === r.survivorWrite.id && value.hostId === 'member'));
      if (defect === 'no-rejoin-backfill') r.seen = r.seen.filter((value: Data) => !(value.writeId === r.survivorWrite.id && value.hostId === 'joiner'));
      await f.rebind(r); rejected(f, 'churn');
    });
  it.each(['unreadable-baseline', 'leaked-revoked-content', 'hidden-current-key', 'leaked-reconnect', 'no-fresh-readmit-control', 'missing-owner-authorization'])(
    'refuses signed revocation corruption: %s', async defect => {
      const f = await fixture(); const r = recordOf(f, 'revocation');
      if (defect === 'unreadable-baseline') r.reads[0].rows = [];
      if (defect === 'leaked-revoked-content') r.reads[2].rows = r.reads[3].rows;
      if (defect === 'hidden-current-key') r.keyInventory.find((value: Data) => value.hostId === 'joiner' && value.stage === 'revoked').epochs.push(8);
      if (defect === 'leaked-reconnect') r.reads[4].rows = r.reads[3].rows;
      if (defect === 'no-fresh-readmit-control') r.reads = r.reads.filter((value: Data) => value.writeId !== r.afterReadmit.id);
      if (defect === 'missing-owner-authorization') f.originals.delete(r.readmit.argv.at(-1));
      await f.rebind(r); rejected(f, 'revocation');
    });
});
