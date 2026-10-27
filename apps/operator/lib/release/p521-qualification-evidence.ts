/** D298–D302: archived measurements are authenticated against independent originals.
 * These validators grant no permission to run a rig or change a candidate. */
import { createHash } from 'node:crypto';
import { canonicalJson, verifyAuthorityRpc, type AuthorityRpcAuth } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import type { PhysicalDrillHostIdentity } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt';
import type { PeerLogOp } from '../../../../packages/operator-core/lib/sync/hyperbee/peer-log';
import type { SnapshotRow } from '../../../../packages/operator-core/lib/sync/hyperbee/log-snapshot';
import { lwwPick } from '../../../../packages/operator-core/lib/sync/hyperbee/projection';
import { parseVitestJsonForHarnessRows } from '../../../../packages/operator-core/lib/testing-run-store';
import type { ProvenanceCheck } from './p2p-candidate-evidence';

export const P521_PLAN = 'p2p-public-release-endgame-2026-09-01';
export interface P521Subject {
  sourceSha: string; artifactDigest: string; installerSha256: string;
  runtimeSha256: string; seedSha256: string; builtAtMs: number;
}
export interface EndgameRawOriginal { ref: string; bytesBase64: string; sha256: string }
export interface OriginalPin { ref: string; sha256: string }
export interface P521QualificationReport { ok: boolean; checks: readonly ProvenanceCheck[] }
interface Write { id: string; hostId: string; atMs: number; op: PeerLogOp; raw: EndgameRawOriginal }
interface Seen { writeId: string; hostId: string; atMs: number; row: SnapshotRow; raw: EndgameRawOriginal }
interface Step { name: string; startMs: number; endMs: number; argv: readonly string[]; exitCode: number; skipped: number; raw: EndgameRawOriginal }
interface Common {
  subject: P521Subject; workspaceId: string; harnessSlug: string; planSlug: string;
  runId: string; startMs: number; endMs: number; hosts: readonly PhysicalDrillHostIdentity[];
  raw: readonly EndgameRawOriginal[];
  attestations: readonly { hostId: string; auth: AuthorityRpcAuth }[];
}
interface RestartQ extends Common {
  kind: 'restart'; core: readonly Step[];
  restarts: readonly { hostId: string; startMs: number; endMs: number; beforeRuntime: string; afterRuntime: string; raw: EndgameRawOriginal }[];
  writes: readonly Write[]; seen: readonly Seen[];
}
interface HlcQ extends Common {
  kind: 'hlc-rules'; rules: readonly { table: string; mergeRule: string }[];
  writes: readonly [Write, Write];
  arrivals: readonly { hostId: string; writeIds: readonly string[]; rows: readonly SnapshotRow[]; raw: EndgameRawOriginal }[];
  precheck: EndgameRawOriginal;
}
interface ChurnQ extends Common {
  kind: 'churn'; joiningHostId: string; survivorHostIds: readonly [string, string];
  joinMs: number; departMs: number; rejoinMs: number;
  rosters: readonly { hostId: string; stage: string; atMs: number; members: readonly { githubUserId: number; deviceKeys: readonly string[] }[]; raw: EndgameRawOriginal }[];
  prejoin: Write; cWrites: readonly [Write, Write]; survivorWrite: Write; seen: readonly Seen[];
}
interface RevocationQ extends Common {
  kind: 'revocation'; ownerHostId: string; revokedHostId: string; survivorHostId: string;
  epochBefore: number; epochAfter: number; revoke: Step; deniedReconnect: Step; readmit: Step;
  pre: Write; post: Write; afterReadmit: Write;
  reads: readonly { hostId: string; writeId: string; atMs: number; exitCode: number; rows: readonly SnapshotRow[]; decryption: string; raw: EndgameRawOriginal }[];
  keyInventory: readonly { hostId: string; stage: string; epochs: readonly number[]; raw: EndgameRawOriginal }[];
}
export type P521Qualification = RestartQ | HlcQ | ChurnQ | RevocationQ;
export interface P521QualificationInput {
  subject: P521Subject; expectedHosts: readonly PhysicalDrillHostIdentity[];
  expectedTables: readonly string[]; records: readonly P521Qualification[];
}
export interface P521QualificationCustody {
  subject: P521Subject; workspaceId: string; harnessSlug: string; planSlug: string;
  expectedHosts: readonly PhysicalDrillHostIdentity[]; expectedTables: readonly string[];
  originalInventory: readonly OriginalPin[]; precheckFiles: readonly { path: string; sha256: string }[];
}
export interface P521PrecheckOriginal {
  receipt: EndgameRawOriginal;
  execution: { runId: string; root: string; manifest: EndgameRawOriginal; phases: EndgameRawOriginal;
    source: EndgameRawOriginal; runtimeInputs: readonly EndgameRawOriginal[];
    reports: readonly EndgameRawOriginal[]; stdout: EndgameRawOriginal; stderr: EndgameRawOriginal;
    ledgerRows: readonly EndgameRawOriginal[] };
}
export interface P521QualificationDeps {
  resolveCustody(subject: P521Subject): P521QualificationCustody | null;
  resolveOriginal(ref: string): EndgameRawOriginal | null;
  resolvePrecheck(ref: string): P521PrecheckOriginal | null;
}

export const originalSha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
class EvidenceMismatch extends Error {}
export function requireEvidence(condition: unknown, diagnostic: string): asserts condition {
  if (!condition) throw new EvidenceMismatch(diagnostic);
}
export const sameEvidence = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export function withoutEvidenceField(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
export function evidenceObject(value: unknown): Record<string, unknown> {
  requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value), 'original object unavailable');
  return value as Record<string, unknown>;
}
export function originalBytes(raw: EndgameRawOriginal): Buffer {
  requireEvidence(raw && typeof raw.ref === 'string' && raw.ref.trim() && typeof raw.bytesBase64 === 'string'
    && /^[0-9a-f]{64}$/.test(raw.sha256), 'invalid original locator');
  const bytes = Buffer.from(raw.bytesBase64, 'base64');
  requireEvidence(bytes.toString('base64') === raw.bytesBase64 && originalSha256(bytes) === raw.sha256, 'original byte/hash mismatch');
  return bytes;
}
export function bindOriginal(raw: EndgameRawOriginal, resolve: P521QualificationDeps['resolveOriginal'], inventory?: readonly OriginalPin[]): Buffer {
  const bytes = originalBytes(raw);
  requireEvidence(sameEvidence(resolve(raw.ref), raw), 'original resolution mismatch');
  if (inventory) requireEvidence(inventory.filter(pin => pin.ref === raw.ref && pin.sha256 === raw.sha256).length === 1
    && inventory.filter(pin => pin.ref === raw.ref).length === 1, 'original inventory mismatch');
  return bytes;
}
export function validateP521Subject(subject: P521Subject): void {
  requireEvidence(subject && /^[0-9a-f]{40}$/.test(subject.sourceSha)
    && ['artifactDigest', 'installerSha256', 'runtimeSha256', 'seedSha256'].every(key => /^[0-9a-f]{64}$/.test(String(Reflect.get(subject, key))))
    && Number.isSafeInteger(subject.builtAtMs), 'candidate subject invalid');
}
const KINDS = ['restart', 'hlc-rules', 'churn', 'revocation'] as const;
const CORE = ['create', 'announced', 'degraded-cupboard', 'discovered', 'member-links', 'join-offer',
  'offer-from-directory', 'join', 'join-clone', 'federate-A-to-B', 'federate-B-to-A', 'federate-continuous'];
const integer = (n: number) => Number.isSafeInteger(n);
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
function window(start: number, end: number, q: Common): void {
  requireEvidence(integer(start) && integer(end) && q.startMs <= start && start <= end && end <= q.endMs, 'measurement chronology mismatch');
}
function step(s: Step, q: Common): void {
  window(s.startMs, s.endMs, q);
  requireEvidence(s.argv.length > 0 && s.argv.every(arg => typeof arg === 'string' && arg.length > 0)
    && s.exitCode === 0 && s.skipped === 0, 'command did not execute successfully');
}
function host(q: Common, id: string): PhysicalDrillHostIdentity {
  const matches = q.hosts.filter(h => h.hostId === id);
  requireEvidence(matches.length === 1, 'host not in independent custody');
  return matches[0]!;
}
function write(w: Write, q: Common): void {
  window(w.atMs, w.atMs, q);
  requireEvidence(w.id && w.op.type === 'put' && w.op.table && w.op.hbKey && w.op.value != null
    && w.op.author_pubkey === host(q, w.hostId).deviceKey && typeof w.op.hlc === 'string'
    && /^\d{15}:\d{5}(?::[0-9a-f]{16})?$/.test(w.op.hlc), 'fresh authenticated causal write unavailable');
}
function snapshot(w: Write): Record<string, unknown> { return withoutEvidenceField(w.op, 'type'); }
function observation(rows: readonly Seen[], w: Write, target: string, after: number, before: number, q: Common): void {
  const matches = rows.filter(s => s.writeId === w.id && s.hostId === target && s.atMs >= after && s.atMs <= before);
  requireEvidence(matches.length === 1, 'required transfer observation missing or duplicated');
  const s = matches[0]!;
  window(s.atMs, s.atMs, q);
  requireEvidence(s.atMs >= w.atMs && s.atMs - w.atMs <= 90_000 && sameEvidence(s.row, snapshot(w)), 'transfer row or latency mismatch');
}
function atomicOriginals(value: unknown, q: Common, custody: P521QualificationCustody, deps: P521QualificationDeps): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const child of value) atomicOriginals(child, q, custody, deps); return; }
  const record = evidenceObject(value);
  if (record.raw && !Array.isArray(record.raw)) {
    const raw = record.raw as EndgameRawOriginal;
    requireEvidence(q.raw.filter(r => sameEvidence(r, raw)).length === 1, 'atomic original absent from signed record');
    requireEvidence(sameEvidence(JSON.parse(bindOriginal(raw, deps.resolveOriginal, custody.originalInventory).toString('utf8')),
      withoutEvidenceField(record, 'raw')), 'normalized measurement differs from original');
  }
  for (const [key, child] of Object.entries(record)) if (!['raw', 'attestations'].includes(key)) atomicOriginals(child, q, custody, deps);
}
function common(q: P521Qualification, input: P521QualificationInput, custody: P521QualificationCustody, deps: P521QualificationDeps): void {
  requireEvidence(sameEvidence(q.subject, input.subject) && sameEvidence(q.hosts, custody.expectedHosts)
    && q.workspaceId === custody.workspaceId && q.harnessSlug === custody.harnessSlug && q.planSlug === P521_PLAN
    && typeof q.runId === 'string' && q.runId.trim(), 'qualification scope/custody mismatch');
  requireEvidence(integer(q.startMs) && integer(q.endMs) && input.subject.builtAtMs <= q.startMs && q.startMs < q.endMs,
    'qualification window invalid');
  requireEvidence(q.hosts.length >= 3 && ['hostId', 'deviceKey', 'machineFingerprint'].every(key =>
    q.hosts.every(h => typeof Reflect.get(h, key) === 'string' && Reflect.get(h, key).length > 0)
      && unique(q.hosts.map(h => Reflect.get(h, key)))), 'distinct physical custody missing');
  requireEvidence(unique(q.raw.map(r => r.ref)) && q.raw.length > 0, 'original record population invalid');
  for (const raw of q.raw) bindOriginal(raw, deps.resolveOriginal, custody.originalInventory);
  atomicOriginals(q, q, custody, deps);
  requireEvidence(q.attestations.length === q.hosts.length && unique(q.attestations.map(a => a.hostId)), 'host attestation census incomplete');
  for (const h of q.hosts) {
    const a = q.attestations.find(a => a.hostId === h.hostId);
    requireEvidence(a && a.auth.device_pubkey === h.deviceKey && a.auth.ts >= q.startMs && a.auth.ts <= q.endMs
      && verifyAuthorityRpc({ harnessSlug: q.harnessSlug, kind: 'p521-qualification/v1', payload: withoutEvidenceField(q, 'attestations') },
        a.auth, { nowMs: q.endMs }), 'qualification signature unavailable or invalid');
  }
}
function restart(q: RestartQ): void {
  requireEvidence(sameEvidence(q.core.map(s => s.name), CORE), 'ordered twelve-leg core census differs');
  q.core.forEach((s, i) => { step(s, q); requireEvidence(s.endMs - s.startMs <= 90_000
    && (!i || q.core[i - 1]!.endMs <= s.startMs), 'core duration/order invalid'); });
  requireEvidence(q.restarts.length === 2 && unique(q.restarts.map(r => r.hostId)) && q.writes.length === 4
    && unique(q.writes.map(w => w.id)), 'restart/fresh-write population incomplete');
  const peers = q.restarts.map(r => r.hostId);
  for (const [index, r] of q.restarts.entries()) {
    host(q, r.hostId); window(r.startMs, r.endMs, q);
    requireEvidence(r.beforeRuntime && r.afterRuntime && r.beforeRuntime !== r.afterRuntime
      && (!index || q.restarts[index - 1]!.endMs <= r.startMs), 'cold restart identity/order invalid');
    const next = q.restarts[index + 1]?.startMs ?? q.endMs;
    for (const source of peers) {
      const matches = q.writes.filter(w => w.hostId === source && w.atMs > r.endMs && w.atMs < next);
      requireEvidence(matches.length === 1, 'fresh bidirectional restart write missing');
      const w = matches[0]!; write(w, q);
      observation(q.seen, w, peers.find(id => id !== source)!, w.atMs, next, q);
    }
  }
  requireEvidence(q.seen.length === q.writes.length, 'restart observation population differs');
}
function precheck(q: HlcQ, custody: P521QualificationCustody, deps: P521QualificationDeps): void {
  const pre = deps.resolvePrecheck(q.precheck.ref);
  requireEvidence(pre && sameEvidence(pre.receipt, q.precheck), 'executed precheck original missing');
  const parse = (raw: EndgameRawOriginal) => evidenceObject(JSON.parse(bindOriginal(raw, deps.resolveOriginal, custody.originalInventory).toString('utf8')));
  const receipt = parse(q.precheck);
  const subject = Object.fromEntries(['artifactDigest', 'installerSha256', 'runtimeSha256', 'seedSha256'].map(k => [k, Reflect.get(q.subject, k)]));
  const start = Date.parse(String(receipt.startedAt)), end = Date.parse(String(receipt.finishedAt));
  requireEvidence(receipt.journey === 'git-consistency-signed-scope' && receipt.check === 'p521-local-precheck:git-consistency-signed-scope'
    && receipt.verdict === 'pass' && receipt.exitCode === 0 && (receipt.skipped === false || receipt.skipped === 0)
    && sameEvidence(receipt.subject, subject) && integer(start) && integer(end) && start <= end && end < q.startMs,
    'precheck subject/result/chronology invalid');
  const e = pre.execution;
  const m = parse(e.manifest), source = parse(e.source);
  requireEvidence(m.runId === e.runId && m.root === e.root && m.state === 'retained' && m.childState === 'closed'
    && m.exitCode === 0 && m.workspaceId === q.workspaceId && m.harnessSlug === q.harnessSlug
    && m.startedAtMs === start && m.finishedAtMs === end && sameEvidence(m.command, receipt.command), 'native child execution unbound');
  const command = m.command as string[];
  requireEvidence(Array.isArray(command) && sameEvidence(command.slice(0, 4), ['npm', 'run', 'test:file', '--'])
    && sameEvidence(command.slice(4).sort(), custody.precheckFiles.map(p => p.path).sort()), 'native full-file command required');
  requireEvidence(custody.precheckFiles.length === 2 && unique(custody.precheckFiles.map(p => p.path))
    && custody.precheckFiles.some(p => p.path.endsWith('/p532-prospective-merge-contract.test.ts'))
    && custody.precheckFiles.some(p => p.path.endsWith('/p532-prospective-table-writers.integration.test.ts')), 'frozen precheck census unavailable');
  const worktree = evidenceObject(source.worktree);
  requireEvidence(source.root === e.root && worktree.head === q.subject.sourceSha && worktree.dirty === false
    && custody.precheckFiles.every(pin => (source.inputs as unknown[]).filter(p => sameEvidence(p, pin)).length === 1), 'selected source pins differ');
  const phases = bindOriginal(e.phases, deps.resolveOriginal, custody.originalInventory).toString('utf8').trim().split('\n').map(line => evidenceObject(JSON.parse(line)));
  requireEvidence(phases.every(p => p.runId === e.runId) && phases.some(p => p.stage === 'child-close' && p.exitCode === 0 && p.signal == null)
    && phases.some(p => p.stage === 'retained' && p.childState === 'closed'), 'native terminal phases missing');
  requireEvidence(e.runtimeInputs.length > 0 && e.reports.length > 0 && e.ledgerRows.length === 2, 'complete execution artifacts missing');
  for (const raw of e.runtimeInputs) {
    const r = parse(raw);
    requireEvidence(r.runId === e.runId && r.workspaceId === q.workspaceId && r.harnessSlug === q.harnessSlug
      && r.sourceSha === q.subject.sourceSha && sameEvidence(r.subject, q.subject) && sameEvidence(r.files, custody.precheckFiles)
      && sameEvidence(r.loadedSourceFiles, custody.precheckFiles) && sameEvidence(r.command, command)
      && typeof r.executable === 'string' && r.executable.length > 0 && r.npmLifecycleShell === 'sh -c' && r.childSubstituted === false,
      'loaded runtime source/subject/shell unbound');
  }
  const parsed = e.reports.flatMap(raw => {
    const bytes = bindOriginal(raw, deps.resolveOriginal, custody.originalInventory), r = evidenceObject(JSON.parse(bytes.toString('utf8')));
    const files = r.testResults as Record<string, unknown>[];
    requireEvidence(r.success === true && r.numTotalTestSuites === 2 && r.numPassedTestSuites === 2
      && r.numTotalTests === 22 && r.numPassedTests === 22 && r.numFailedTests === 0 && r.numPendingTests === 0
      && Array.isArray(files) && files.length === 2, 'complete frozen reporter census differs');
    let total = 0;
    for (const f of files) {
      const cases = f.assertionResults as Record<string, unknown>[];
      requireEvidence(f.status === 'passed' && f.startTime === start && f.endTime === end && Array.isArray(cases)
        && cases.length > 0 && unique(cases.map(c => c.fullName)) && cases.every(c => c.status === 'passed'), 'reporter case execution incomplete');
      total += cases.length;
      const names = cases.map(c => String(c.title));
      requireEvidence(['full', 'incremental'].every(fold => names.some(n => n.startsWith(fold + ' fold'))), 'full/incremental case census missing');
      requireEvidence(cases.length === (String(f.name).endsWith('p532-prospective-merge-contract.test.ts') ? 17 : 5), 'frozen file case census differs');
    }
    requireEvidence(total === 22, 'filtered reporter population');
    return parseVitestJsonForHarnessRows(bytes.toString('utf8'), e.root);
  });
  requireEvidence(parsed.length === 2 && sameEvidence(parsed.map(r => r.filePath).sort(), custody.precheckFiles.map(p => p.path).sort()), 'reporter file population differs');
  const ledger = e.ledgerRows.map(parse);
  for (const row of parsed) {
    const expected = { ...row, runId: e.runId, workspaceId: q.workspaceId, harnessSlug: q.harnessSlug,
      sourceSha: q.subject.sourceSha, worktreeDirty: false, childSubstituted: false };
    // The canonical archival encoder treats Date objects as objects; database
    // JSON transport emits ISO strings. Chronology is independently required
    // from the original numeric reporter times and terminal manifest above.
    requireEvidence(ledger.filter(r => sameEvidence(r, expected)
      || sameEvidence(r, JSON.parse(JSON.stringify(expected)))).length === 1, 'reporter/ledger disagreement');
  }
  const stdout = bindOriginal(e.stdout, deps.resolveOriginal, custody.originalInventory).toString('utf8');
  bindOriginal(e.stderr, deps.resolveOriginal, custody.originalInventory);
  requireEvidence(/Test Files\s+2 passed \(2\)/.test(stdout) && /Tests\s+22 passed \(22\)/.test(stdout), 'native reporter/stream census differs');
  const refs = receipt.evidence as { ref: string; kind: string }[];
  const required = [e.manifest, e.source, ...e.runtimeInputs, ...e.reports, e.stdout, e.stderr, ...e.ledgerRows];
  requireEvidence(Array.isArray(refs) && unique(refs.map(r => r.ref)) && sameEvidence(refs.map(r => r.ref).sort(), required.map(r => r.ref).sort())
    && refs.every(r => r.kind === 'testing-run-original'), 'receipt execution references incomplete');
}
function hlc(q: HlcQ, custody: P521QualificationCustody, deps: P521QualificationDeps): void {
  precheck(q, custody, deps);
  requireEvidence(q.rules.length === custody.expectedTables.length && unique(q.rules.map(r => r.table))
    && sameEvidence(q.rules.map(r => r.table).sort(), [...custody.expectedTables].sort())
    && q.rules.every(r => ['lww', 'append-only', 'set-union', 'counter'].includes(r.mergeRule)), 'table merge-rule census differs');
  requireEvidence(q.writes.length === 2 && q.writes[0].id !== q.writes[1].id, 'two conflicting fresh writes required');
  const [a, b] = q.writes; write(a, q); write(b, q);
  requireEvidence(a.hostId !== b.hostId && a.op.table === b.op.table && a.op.hbKey === b.op.hbKey
    && a.op.hlc !== b.op.hlc && ((a.op.hlc! > b.op.hlc!) !== (a.op.ts > b.op.ts)), 'causal/wall-clock conflict absent');
  const winner = lwwPick(a.op, b.op) === a.op ? a : b;
  requireEvidence(q.arrivals.length === q.hosts.length && unique(q.arrivals.map(r => r.hostId)), 'arrival host census differs');
  const orders = new Set<string>();
  for (const arrival of q.arrivals) {
    host(q, arrival.hostId);
    requireEvidence(sameEvidence([...arrival.writeIds].sort(), [a.id, b.id].sort()) && sameEvidence(arrival.rows, [snapshot(winner)]), 'causal winner or arrival population differs');
    orders.add(JSON.stringify(arrival.writeIds));
  }
  requireEvidence(orders.size === 2, 'opposing arrival orders missing');
}
function groupedMembers(hosts: readonly PhysicalDrillHostIdentity[]) {
  const groups = new Map<number, string[]>();
  for (const h of hosts) groups.set(h.githubUserId, [...(groups.get(h.githubUserId) ?? []), h.deviceKey]);
  return [...groups].sort(([a], [b]) => a - b).map(([githubUserId, keys]) => ({ githubUserId, deviceKeys: keys.sort() }));
}
function churn(q: ChurnQ): void {
  requireEvidence(q.hosts.length === 3 && q.survivorHostIds.length === 2
    && unique([q.joiningHostId, ...q.survivorHostIds]) && q.startMs < q.joinMs && q.joinMs < q.departMs && q.departMs < q.rejoinMs && q.rejoinMs < q.endMs,
    'three-machine churn identities/order invalid');
  [q.joiningHostId, ...q.survivorHostIds].forEach(id => host(q, id));
  requireEvidence(q.rosters.length === 10 && unique(q.rosters.map(r => r.stage + ':' + r.hostId)), 'complete churn roster census missing');
  const stages = ['before', 'joined', 'departed', 'rejoined'];
  stages.forEach((stage, i) => {
    const ids = i === 0 || i === 2 ? q.survivorHostIds : q.hosts.map(h => h.hostId);
    const min = [q.startMs, q.joinMs, q.departMs, q.rejoinMs][i]!, max = [q.joinMs, q.departMs, q.rejoinMs, q.endMs][i]!;
    for (const id of ids) {
      const matches = q.rosters.filter(r => r.stage === stage && r.hostId === id);
      requireEvidence(matches.length === 1, 'churn roster probe missing');
      const r = matches[0]!;
      requireEvidence(integer(r.atMs) && min < r.atMs && r.atMs < max && sameEvidence(
        [...r.members].map(m => ({ githubUserId: m.githubUserId, deviceKeys: [...m.deviceKeys].sort() })).sort((a, b) => a.githubUserId - b.githubUserId),
        groupedMembers(ids.map(id => host(q, id)))), 'churn membership population differs');
    }
  });
  const allWrites = [q.prejoin, ...q.cWrites, q.survivorWrite];
  requireEvidence(q.cWrites.length === 2 && unique(allWrites.map(w => w.id)) && q.prejoin.atMs < q.joinMs
    && q.survivorHostIds.includes(q.prejoin.hostId), 'prejoin causal history unavailable');
  allWrites.forEach(w => write(w, q));
  q.survivorHostIds.forEach(id => observation(q.seen, q.prejoin, id, q.prejoin.atMs, q.joinMs, q));
  observation(q.seen, q.prejoin, q.joiningHostId, q.joinMs, q.departMs, q);
  q.cWrites.forEach((w, i) => {
    requireEvidence(w.hostId === q.joiningHostId && q.joinMs < w.atMs && w.atMs < q.departMs, 'fresh joining-device write missing');
    observation(q.seen, w, q.survivorHostIds[i]!, w.atMs, q.departMs, q);
  });
  requireEvidence(q.survivorHostIds.includes(q.survivorWrite.hostId) && q.departMs < q.survivorWrite.atMs && q.survivorWrite.atMs < q.rejoinMs,
    'survivor outage write missing');
  observation(q.seen, q.survivorWrite, q.survivorHostIds.find(id => id !== q.survivorWrite.hostId)!, q.survivorWrite.atMs, q.rejoinMs, q);
  observation(q.seen, q.survivorWrite, q.joiningHostId, q.rejoinMs, q.endMs, q);
  requireEvidence(q.seen.length === 7, 'churn transfer census differs');
}
function revocation(q: RevocationQ, custody: P521QualificationCustody, deps: P521QualificationDeps): void {
  requireEvidence(unique([q.ownerHostId, q.revokedHostId, q.survivorHostId]) && integer(q.epochBefore) && integer(q.epochAfter)
    && q.epochAfter > q.epochBefore, 'revocation device/epoch invalid');
  const owner = host(q, q.ownerHostId), revoked = host(q, q.revokedHostId); host(q, q.survivorHostId);
  [q.revoke, q.deniedReconnect, q.readmit].forEach(s => step(s, q));
  requireEvidence(q.pre.atMs < q.revoke.startMs && q.revoke.endMs < q.post.atMs && q.post.atMs < q.deniedReconnect.startMs
    && q.deniedReconnect.endMs < q.readmit.startMs && q.readmit.endMs < q.afterReadmit.atMs, 'revocation chronology invalid');
  const writes = [q.pre, q.post, q.afterReadmit]; writes.forEach(w => write(w, q));
  requireEvidence(unique(writes.map(w => w.id)) && writes.every(w => w.hostId === q.ownerHostId)
    && q.pre.op.epoch === q.epochBefore && q.post.op.epoch === q.epochAfter && q.afterReadmit.op.epoch === q.epochAfter,
    'fresh owner epoch writes missing');
  const read = (w: Write, id: string, min: number, max: number, readable: boolean) => {
    const rows = q.reads.filter(r => r.writeId === w.id && r.hostId === id && min < r.atMs && r.atMs < max);
    requireEvidence(rows.length === 1, 'revocation plaintext control missing');
    const r = rows[0]!;
    window(r.atMs, r.atMs, q);
    requireEvidence(r.exitCode === 0 && r.decryption === (readable ? 'readable' : 'denied')
      && sameEvidence(r.rows, readable ? [snapshot(w)] : []), 'revocation plaintext/denial mismatch');
  };
  [q.revokedHostId, q.survivorHostId].forEach(id => read(q.pre, id, q.pre.atMs, q.revoke.startMs, true));
  read(q.post, q.revokedHostId, q.post.atMs, q.deniedReconnect.startMs, false);
  read(q.post, q.survivorHostId, q.post.atMs, q.deniedReconnect.startMs, true);
  read(q.post, q.revokedHostId, q.deniedReconnect.endMs, q.readmit.startMs, false);
  [q.revokedHostId, q.survivorHostId].forEach(id => read(q.afterReadmit, id, q.afterReadmit.atMs, q.endMs, true));
  requireEvidence(q.reads.length === 7 && q.keyInventory.length === 6 && unique(q.keyInventory.map(k => k.stage + ':' + k.hostId)), 'revocation read/key census differs');
  for (const stage of ['before', 'revoked', 'readmitted']) for (const id of [q.revokedHostId, q.survivorHostId]) {
    const rows = q.keyInventory.filter(k => k.stage === stage && k.hostId === id);
    const epochs = stage === 'before' || (stage === 'revoked' && id === q.revokedHostId) ? [q.epochBefore] : [q.epochBefore, q.epochAfter];
    requireEvidence(rows.length === 1 && sameEvidence(rows[0]!.epochs, epochs), 'epoch key membership differs');
  }
  const index = q.readmit.argv.indexOf('--authorization-ref');
  requireEvidence(index >= 0 && q.readmit.argv[index + 1], 'explicit owner readmission original missing');
  const raw = deps.resolveOriginal(q.readmit.argv[index + 1]!);
  requireEvidence(raw && q.raw.some(r => sameEvidence(r, raw)), 'readmission authorization unresolved');
  const auth = evidenceObject(JSON.parse(bindOriginal(raw, deps.resolveOriginal, custody.originalInventory).toString('utf8')));
  const payload = evidenceObject(auth.payload), signature = auth.auth as AuthorityRpcAuth;
  requireEvidence(auth.harnessSlug === q.harnessSlug && auth.kind === 'p521-readmission/v1'
    && payload.workspaceId === q.workspaceId && payload.harnessSlug === q.harnessSlug && payload.planSlug === q.planSlug
    && payload.ownerDeviceKey === owner.deviceKey && payload.memberDeviceKey === revoked.deviceKey
    && payload.githubUserId === revoked.githubUserId && payload.epoch === q.epochAfter
    && typeof payload.admittedAtMs === 'number' && q.readmit.startMs <= payload.admittedAtMs && payload.admittedAtMs <= q.readmit.endMs
    && signature.device_pubkey === owner.deviceKey && verifyAuthorityRpc({ harnessSlug: q.harnessSlug, kind: 'p521-readmission/v1', payload },
      signature, { nowMs: payload.admittedAtMs }), 'fresh owner readmission unauthorized');
}

export function validateP521Qualifications(input: P521QualificationInput, deps: P521QualificationDeps): P521QualificationReport {
  const checks: ProvenanceCheck[] = [];
  let custody: P521QualificationCustody | null = null;
  let boundaryError = '';
  try {
    validateP521Subject(input.subject);
    custody = deps.resolveCustody(input.subject);
    requireEvidence(custody && custody.planSlug === P521_PLAN && custody.workspaceId && custody.harnessSlug
      && sameEvidence(input.subject, custody.subject) && sameEvidence(input.expectedHosts, custody.expectedHosts)
      && sameEvidence(input.expectedTables, custody.expectedTables) && custody.expectedTables.length > 0
      && unique(custody.expectedTables) && unique(custody.originalInventory.map(p => p.ref))
      && input.records.length === KINDS.length && unique(input.records.map(q => q.kind))
      && input.records.every(q => KINDS.includes(q.kind)), 'independent qualification population/custody differs');
  } catch { boundaryError = 'independent qualification population or custody unavailable'; }
  for (const kind of KINDS) {
    let detail = boundaryError, status: ProvenanceCheck['status'] = 'fail';
    if (!detail) try {
      const records = input.records.filter(q => q.kind === kind);
      requireEvidence(records.length === 1 && custody, 'qualification discriminant missing or duplicated');
      const q = records[0]!; common(q, input, custody, deps);
      switch (q.kind) {
        case 'restart': restart(q); break;
        case 'hlc-rules': hlc(q, custody, deps); break;
        case 'churn': churn(q); break;
        case 'revocation': revocation(q, custody, deps); break;
      }
      status = 'pass'; detail = 'independent signed originals and complete semantic controls verified';
    } catch (error) { detail = error instanceof EvidenceMismatch ? error.message : 'qualification original unavailable or malformed'; }
    checks.push({ id: `P-521:qualification:${kind}`, status, detail });
  }
  const ok = checks.every(c => c.status === 'pass');
  checks.unshift({ id: 'P-521:qualification', status: ok ? 'pass' : 'fail', detail: ok ? 'all four independent qualification populations verified' : 'required qualification evidence missing or invalid' });
  return { ok, checks };
}
