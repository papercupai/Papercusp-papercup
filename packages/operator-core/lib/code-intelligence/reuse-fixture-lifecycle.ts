/** D039: dispose runtime resources, retain the fixture's immutable proof.
 * No ledger rows are deleted. The retained journal binds the exact workspace,
 * owner, token, root, harness, claims and session incarnations for later replay.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectEntry } from '../harness-registry';

export interface ReuseFixtureIdentity {
  workspaceId: string;
  owner: string;
  token: string;
  root: string;
  evidenceRoot: string;
  /** Frozen before admission; plans:new preserves an existing UTC date suffix. */
  planSlug: string;
}
export interface ReuseFixtureSession {
  id: number;
  sessionId: string;
  /** Full precision PostgreSQL timestamp, never a Date round-trip. */
  startedAt: string;
  planSlug: string;
}
export interface ReuseFixtureClaim { id: string; harness: string }
interface Journal extends ReuseFixtureIdentity {
  schema: 'reuse-fixture-lifecycle-v1';
  harness?: ProjectEntry;
  claims: ReuseFixtureClaim[];
  sessions: ReuseFixtureSession[];
  cleaned: boolean;
  retiring?: boolean;
  executionStarted?: boolean;
  retention: typeof REUSE_FIXTURE_RETENTION;
}
export const REUSE_FIXTURE_RETENTION =
  'Retain test, coverage, provenance, activity, audit, issued-advice and planning rows unchanged; '
  + 'retain this journal and client receipts. Cleanup ends only owned session incarnations, '
  + 'releases only owned claims, unregisters only the exact passive harness and removes its runtime root.';

interface SessionState extends ReuseFixtureSession {
  workspaceId: string; owner: string; root: string; ended: boolean;
}
interface ClaimState { workspaceId: string; owner: string | null; harness: string }
export interface ReuseFixtureLifecyclePorts {
  readSession(id: number): Promise<SessionState | null>;
  endSession(fixture: ReuseFixtureIdentity, session: ReuseFixtureSession): Promise<boolean>;
  readClaim(claim: ReuseFixtureClaim, workspaceId: string): Promise<ClaimState | null>;
  releaseClaim(fixture: ReuseFixtureIdentity, claim: ReuseFixtureClaim): Promise<boolean>;
  readHarness(workspaceId: string, slug: string): Promise<ProjectEntry | null>;
  removeHarness(workspaceId: string, entry: ProjectEntry): Promise<void>;
}

/** Canonical writes; reads retain the original full-precision session CAS pin. */
export const reuseFixtureLifecyclePorts: ReuseFixtureLifecyclePorts = {
  async readSession(id) {
    const { boundedOrgTxn } = await import('../pg-bounded-txn');
    const rows = await boundedOrgTxn(tx => tx<Array<{
      id: number; session_id: string; started_at: string; plan_slug: string;
      workspace_id: string; coord_owner_id: string; cwd: string; ended: boolean;
    }>>`SELECT id, session_id, started_at::text, plan_slug, workspace_id, coord_owner_id, cwd,
      (ended_at IS NOT NULL OR ended_by IS NOT NULL) AS ended
      FROM harness_shared.adv_sessions WHERE id = ${id}`,
    { readOnly: true, phase: 'reuse-fixture:session-binding' });
    const row = rows[0];
    return row ? { id: Number(row.id), sessionId: row.session_id, startedAt: row.started_at,
      planSlug: row.plan_slug, workspaceId: row.workspace_id, owner: row.coord_owner_id,
      root: row.cwd, ended: row.ended } : null;
  },
  async endSession(fixture, session) {
    const { markAdvSessionEnded } = await import('../adv-sessions');
    return markAdvSessionEnded(session.id, null, 'cleanup', { throwOnError: true,
      expectedBinding: { coordOwnerId: fixture.owner, sessionId: session.sessionId,
        startedAt: session.startedAt, workspaceId: fixture.workspaceId, cwd: fixture.root,
        planSlug: session.planSlug } });
  },
  async readClaim(claim, workspaceId) {
    const { getWorkItem } = await import('../work-items');
    const { runWithWorkspace } = await import('../workspace-als');
    const row = await runWithWorkspace(workspaceId, () => getWorkItem(claim.id, claim.harness));
    return row ? { workspaceId, owner: row.assignee ?? null, harness: row.harness! } : null;
  },
  async releaseClaim(fixture, claim) {
    const { releaseWorkItem } = await import('../work-items');
    const { runWithWorkspace } = await import('../workspace-als');
    return (await runWithWorkspace(fixture.workspaceId, () => releaseWorkItem(claim.id,
      { harness: claim.harness, expectedAssignee: fixture.owner,
        releasingOwnerId: fixture.owner, announceClaimable: false }))) != null;
  },
  async readHarness(workspaceId, slug) {
    const { loadHarnessRegistry } = await import('../harness-registry');
    return (await loadHarnessRegistry(workspaceId)).projects.find(row => row.slug === slug) ?? null;
  },
  async removeHarness(workspaceId, entry) {
    const { mutateHarnessRegistry } = await import('../harness-registry');
    await mutateHarnessRegistry(reg => {
      const current = reg.projects.find(row => row.slug === entry.slug);
      if (current && !isDeepStrictEqual(current, entry)) throw new Error('Fixture harness ownership changed');
      return { ...reg, projects: reg.projects.filter(row => row.slug !== entry.slug) };
    }, workspaceId, { allowEmpty: true });
  },
};

const marker = '.reuse-fixture-owner.json';
const journalPath = (fixture: ReuseFixtureIdentity) => join(fixture.evidenceRoot, 'lifecycle.json');
const sameIdentity = (a: ReuseFixtureIdentity, b: ReuseFixtureIdentity) =>
  ['workspaceId', 'owner', 'token', 'root', 'evidenceRoot', 'planSlug'].every(key =>
    a[key as keyof ReuseFixtureIdentity] === b[key as keyof ReuseFixtureIdentity]);
function assertIdentity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function save(journal: Journal) {
  const path = journalPath(journal), pending = path + '.next';
  await writeFile(pending, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, path);
}
async function ownedJournal(fixture: ReuseFixtureIdentity): Promise<Journal> {
  const directory = await lstat(fixture.evidenceRoot);
  assertIdentity(directory.isDirectory() && !directory.isSymbolicLink(), 'Fixture evidence root changed');
  const journal = JSON.parse(await readFile(journalPath(fixture), 'utf8')) as Journal;
  assertIdentity(journal.schema === 'reuse-fixture-lifecycle-v1' && sameIdentity(fixture, journal),
    'Fixture ownership mismatch');
  return journal;
}
async function exclusive<T>(fixture: ReuseFixtureIdentity, run: (journal: Journal) => Promise<T>): Promise<T> {
  // Validate before even creating the cleanup mutex. Concurrent cleanup refuses
  // rather than racing a second remove; a later explicit retry is idempotent.
  await ownedJournal(fixture);
  const lockPath = join(fixture.evidenceRoot, 'lifecycle.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try { return await run(await ownedJournal(fixture)); }
  finally { await lock.close(); await rm(lockPath); }
}

export async function createReuseFixture(workspaceId: string, owner: string,
  preparedAt = new Date()): Promise<ReuseFixtureIdentity> {
  assertIdentity(workspaceId.trim() && owner.trim(), 'Explicit fixture workspace and owner required');
  const date = preparedAt.toISOString().slice(0, 10);
  const root = await mkdtemp(join(tmpdir(), 'r-'));
  let evidenceRoot: string | undefined;
  try {
    evidenceRoot = await mkdtemp(join(tmpdir(), 'reuse-proof-'));
    const token = randomUUID();
    const fixture = { workspaceId, owner, token, root, evidenceRoot,
      planSlug: `r-${token.slice(0, 8)}-${date}` };
    await writeFile(join(root, marker), JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
    await save({ ...fixture, schema: 'reuse-fixture-lifecycle-v1', claims: [], sessions: [],
      cleaned: false, retention: REUSE_FIXTURE_RETENTION });
    return fixture;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (evidenceRoot) await rm(evidenceRoot, { recursive: true, force: true });
    throw error;
  }
}

/** D040: validate and consume a prepared identity before any shared mutation.
 * The durable mutex/flag refuses concurrent execution and later reuse. A
 * mismatched or tampered identity never acquires lifecycle cleanup authority. */
export async function activatePreparedReuseFixture(fixture: ReuseFixtureIdentity) {
  await exclusive(fixture, async journal => {
    assertIdentity(!journal.cleaned && !journal.retiring && !journal.executionStarted
      && !journal.harness && journal.claims.length === 0 && journal.sessions.length === 0,
    'Prepared fixture already used');
    assertIdentity(typeof fixture.planSlug === 'string'
      && fixture.planSlug.startsWith(`r-${fixture.token.slice(0, 8)}-`)
      && /-\d{4}-\d{2}-\d{2}$/.test(fixture.planSlug), 'Prepared dated plan identity required');
    const root = await lstat(fixture.root);
    assertIdentity(root.isDirectory() && !root.isSymbolicLink(), 'Prepared fixture root changed');
    assertIdentity(sameIdentity(fixture, JSON.parse(await readFile(join(fixture.root, marker), 'utf8'))),
      'Prepared fixture ownership changed');
    journal.executionStarted = true;
    await save(journal);
  });
}

/** Record exact identities before the next fallible fixture phase. Harness can
 * be journaled before registration; an absent registration is a cleanup no-op.
 * Evidence references and client receipts are saved outside the runtime root.
 */
export async function trackReuseFixture(fixture: ReuseFixtureIdentity, resource:
  { harness: ProjectEntry } | { claim: ReuseFixtureClaim } | { session: ReuseFixtureSession }) {
  await exclusive(fixture, async journal => {
    assertIdentity(!journal.cleaned, 'Fixture already cleaned');
    if ('harness' in resource) {
      assertIdentity(resource.harness.path === fixture.root && resource.harness.registrationOnly?.commitSha,
        'Only the exact passive fixture root may be registered');
      assertIdentity(!journal.harness || isDeepStrictEqual(journal.harness, resource.harness),
        'Fixture harness identity changed');
      journal.harness = resource.harness;
    } else if ('claim' in resource) {
      assertIdentity(journal.harness?.slug === resource.claim.harness && resource.claim.id, 'Fixture claim scope mismatch');
      if (!journal.claims.some(row => row.id === resource.claim.id)) journal.claims.push(resource.claim);
    } else {
      assertIdentity(Number.isSafeInteger(resource.session.id) && resource.session.id > 0
        && resource.session.sessionId.includes(fixture.token) && resource.session.startedAt && resource.session.planSlug,
      'Exact fixture session incarnation required');
      const old = journal.sessions.find(row => row.id === resource.session.id);
      assertIdentity(!old || isDeepStrictEqual(old, resource.session), 'Fixture session identity changed');
      if (!old) journal.sessions.push(resource.session);
    }
    await save(journal);
  });
}

export async function cleanupReuseFixture(fixture: ReuseFixtureIdentity,
  ports: ReuseFixtureLifecyclePorts = reuseFixtureLifecyclePorts) {
  return exclusive(fixture, async journal => {
    if (journal.cleaned) return { cleaned: true, evidenceRoot: fixture.evidenceRoot, retention: journal.retention };
    const retired = join(fixture.evidenceRoot, 'retired-runtime');
    const finishRetirement = async () => {
      const inspect = async (path: string) => {
        try { return await lstat(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      };
      const original = await inspect(fixture.root), staged = await inspect(retired);
      assertIdentity(!(original && staged), 'Fixture retirement paths conflict');
      const path = original ? fixture.root : staged ? retired : null;
      if (path) {
        const stat = original ?? staged!;
        assertIdentity(stat.isDirectory() && !stat.isSymbolicLink(), 'Fixture retiring root changed');
        assertIdentity(sameIdentity(fixture, JSON.parse(await readFile(join(path, marker), 'utf8'))),
          'Fixture retiring ownership changed');
        if (original) await rename(fixture.root, retired);
        await rm(retired, { recursive: true, force: true });
      }
      journal.cleaned = true;
      await save(journal);
      return { cleaned: true, evidenceRoot: fixture.evidenceRoot, retention: journal.retention };
    };
    if (journal.retiring) return finishRetirement();
    const root = await lstat(fixture.root);
    assertIdentity(root.isDirectory() && !root.isSymbolicLink(), 'Fixture runtime root changed');
    assertIdentity(sameIdentity(fixture, JSON.parse(await readFile(join(fixture.root, marker), 'utf8'))),
      'Fixture runtime ownership changed');
    // Preflight the complete population before any lifecycle mutation. The
    // canonical writes below independently CAS their expected owner/binding.
    const harness = journal.harness ? await ports.readHarness(fixture.workspaceId, journal.harness.slug) : null;
    assertIdentity(!harness || isDeepStrictEqual(harness, journal.harness), 'Fixture harness ownership changed');
    const sessions = await Promise.all(journal.sessions.map(async pin => {
      const row = await ports.readSession(pin.id);
      assertIdentity(row && row.workspaceId === fixture.workspaceId && row.owner === fixture.owner
        && row.root === fixture.root && row.sessionId === pin.sessionId
        && row.startedAt === pin.startedAt && row.planSlug === pin.planSlug, 'Fixture session ownership changed');
      return { pin, row };
    }));
    const claims = await Promise.all(journal.claims.map(async pin => {
      const row = await ports.readClaim(pin, fixture.workspaceId);
      assertIdentity(row && row.workspaceId === fixture.workspaceId && row.harness === pin.harness
        && (row.owner === fixture.owner || row.owner === null), 'Fixture claim ownership changed');
      return { pin, row };
    }));
    for (const { pin, row } of claims) {
      if (row.owner !== null) assertIdentity(await ports.releaseClaim(fixture, pin), 'Fixture claim changed during cleanup');
    }
    for (const { pin, row } of sessions) {
      if (!row.ended) assertIdentity(await ports.endSession(fixture, pin), 'Fixture session changed during cleanup');
    }
    if (journal.harness && harness) await ports.removeHarness(fixture.workspaceId, journal.harness);
    // Recheck after asynchronous writers; do not follow a swapped runtime link.
    const finalRoot = await lstat(fixture.root);
    assertIdentity(finalRoot.isDirectory() && !finalRoot.isSymbolicLink()
      && finalRoot.ino === root.ino && finalRoot.dev === root.dev, 'Fixture runtime root changed during cleanup');
    assertIdentity(sameIdentity(fixture, JSON.parse(await readFile(join(fixture.root, marker), 'utf8'))),
      'Fixture runtime ownership changed during cleanup');
    // Persist the retirement phase before moving/removing runtime. A failed
    // rename, rm or final journal save can resume without repeating DB writes.
    journal.retiring = true;
    await save(journal);
    return finishRetirement();
  });
}
