/**
 * Test downgrade store — plan green-main-ratchet-convergence-2026-10-17, P-002 (R-1, D-002/D-005/D-006).
 *
 * Every test blocks main by default. When a blocking test fails and can be neither fixed
 * nor ejected, an agent may DOWNGRADE that one test case to non-blocking. The downgrade is
 * refused unless the record is complete: a written reason, an owner, a filed bug, the
 * author and the time. A test in a critical area (P-003) also needs an acknowledgement
 * naming that area and the risk, and the owner is notified at once.
 *
 * Blocking is DERIVED from the active records, never cached on the test: removing or
 * revoking a record makes the test block again (R-1 falsifier 7).
 */
import {
  classifyCriticalArea,
  criticalAreaAcknowledgementProblem,
  criticalAreaWarning,
  type CriticalArea,
  type CriticalAreaAcknowledgement,
} from './critical-area-registry';

export interface TestDowngradeScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface TestDowngradeRequest {
  testFile: string;
  /** Full case name (D-005). Empty for a non-test gate leg such as `lint:tsc`. */
  testCase?: string | null;
  reason?: string | null;
  owner?: string | null;
  bugId?: string | null;
  author?: string | null;
  acknowledgement?: CriticalAreaAcknowledgement | null;
}

/**
 * What made the test non-blocking. `downgrade` = an agent's written downgrade (P-002, R-1).
 * `flaky-quarantine` = the gate's automatic quarantine of a test whose verdict flipped on one
 * commit (P-008, R-7); its `bugId` is the de-quarantine work-item.
 */
export type TestDowngradeKind = 'downgrade' | 'flaky-quarantine';

export interface TestDowngradeRecord {
  id: number;
  kind: TestDowngradeKind;
  testFile: string;
  testCase: string;
  reason: string;
  owner: string;
  bugId: string;
  author: string;
  createdAt: string;
  criticalArea: string | null;
  riskAcknowledgement: string | null;
  ownerNotifiedAt: string | null;
  revokedAt: string | null;
}

/** A row to insert. `kind` defaults to `downgrade`. */
export type NewTestDowngrade = Omit<TestDowngradeRecord, 'id' | 'kind' | 'createdAt' | 'ownerNotifiedAt' | 'revokedAt'> & {
  kind?: TestDowngradeKind;
};

export type TestDowngradeValidation =
  | { ok: true; record: NewTestDowngrade; criticalArea: CriticalArea | null; warning: string }
  | { ok: false; problems: string[]; criticalArea: CriticalArea | null };

const text = (value: string | null | undefined) => String(value ?? '').trim();

/** PURE: the identity a downgrade and a failing test are matched on (D-005: file + case). */
export function testDowngradeKey(testFile: string, testCase?: string | null): string {
  return `${text(testFile).replace(/\\/g, '/').replace(/^\.\//, '')}\u0000${text(testCase)}`;
}

/** PURE: the warning every accepted downgrade returns (R-1 falsifier 5). */
export function testDowngradeWarning(record: NewTestDowngrade, area: CriticalArea | null): string {
  const target = record.testCase ? `${record.testFile} > ${record.testCase}` : record.testFile;
  const base =
    `⚠ DOWNGRADED: '${target}' no longer blocks main while it fails. This hides a real failure: ` +
    `it stays in the daily digest and the debt count until ${record.bugId} is fixed and the downgrade is revoked.`;
  return area ? `${criticalAreaWarning(area)}\n${base}` : base;
}

/**
 * PURE: refuse an incomplete downgrade. Every problem is listed, so one call shows all the
 * missing fields instead of one per retry.
 */
export function validateTestDowngrade(request: TestDowngradeRequest): TestDowngradeValidation {
  const testFile = text(request.testFile).replace(/\\/g, '/').replace(/^\.\//, '');
  const problems: string[] = [];
  if (!testFile) problems.push('missing testFile: name the repo-relative test file (or the gate leg id)');
  const record: NewTestDowngrade = {
    testFile,
    testCase: text(request.testCase),
    reason: text(request.reason),
    owner: text(request.owner),
    bugId: text(request.bugId),
    author: text(request.author),
    criticalArea: null,
    riskAcknowledgement: null,
  };
  if (!record.reason) problems.push('missing reason: say why the test can neither be fixed nor ejected now');
  if (!record.owner) problems.push('missing owner: name who owns getting this test blocking again');
  if (!record.bugId) problems.push('missing bugId: file a bug for the failure first and pass its id');
  if (!record.author) problems.push('missing author: the caller identity could not be resolved');
  const area = testFile ? classifyCriticalArea(testFile) : null;
  if (area) {
    const problem = criticalAreaAcknowledgementProblem(area, request.acknowledgement);
    if (problem) problems.push(problem);
    record.criticalArea = area.id;
    record.riskAcknowledgement = text(request.acknowledgement?.risk) || null;
  }
  if (problems.length > 0) return { ok: false, problems, criticalArea: area };
  return { ok: true, record, criticalArea: area, warning: testDowngradeWarning(record, area) };
}

/** PURE: a failing test blocks main unless an ACTIVE downgrade covers exactly its file + case. */
export function isTestBlocking(
  activeDowngrades: ReadonlyArray<Pick<TestDowngradeRecord, 'testFile' | 'testCase' | 'revokedAt'>>,
  testFile: string,
  testCase?: string | null,
): boolean {
  const key = testDowngradeKey(testFile, testCase);
  return !activeDowngrades.some((row) => row.revokedAt === null && testDowngradeKey(row.testFile, row.testCase) === key);
}

/** PURE: the start of the UTC day containing `now` — the daily digest window. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface TestDowngradeStore {
  insert(record: NewTestDowngrade): Promise<TestDowngradeRecord | { conflict: TestDowngradeRecord }>;
  listActive(): Promise<TestDowngradeRecord[]>;
  /** Every downgrade CREATED at or after `since`, revoked or not — the daily digest feed. */
  listCreatedSince(since: Date): Promise<TestDowngradeRecord[]>;
  revoke(id: number, by: string, reason: string): Promise<TestDowngradeRecord | null>;
  markOwnerNotified(id: number, at: Date): Promise<void>;
}

/** In-memory store with the same semantics as the Postgres one. Used by unit tests. */
export function memoryTestDowngradeStore(now: () => Date = () => new Date()): TestDowngradeStore & { rows: TestDowngradeRecord[] } {
  const rows: TestDowngradeRecord[] = [];
  let nextId = 1;
  return {
    rows,
    async insert(record) {
      const key = testDowngradeKey(record.testFile, record.testCase);
      const existing = rows.find((row) => row.revokedAt === null && testDowngradeKey(row.testFile, row.testCase) === key);
      if (existing) return { conflict: existing };
      const row: TestDowngradeRecord = {
        ...record,
        kind: record.kind ?? 'downgrade',
        id: nextId++,
        createdAt: now().toISOString(),
        ownerNotifiedAt: null,
        revokedAt: null,
      };
      rows.push(row);
      return row;
    },
    async listActive() {
      return rows.filter((row) => row.revokedAt === null);
    },
    async listCreatedSince(since) {
      return rows.filter((row) => Date.parse(row.createdAt) >= since.getTime());
    },
    async revoke(id) {
      const row = rows.find((candidate) => candidate.id === id && candidate.revokedAt === null);
      if (!row) return null;
      row.revokedAt = now().toISOString();
      return row;
    },
    async markOwnerNotified(id, at) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.ownerNotifiedAt = at.toISOString();
    },
  };
}

/** The slice of a postgres.js client the store uses. */
export interface TestDowngradeSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

const COLUMNS =
  'id, kind, test_file, test_case, reason, owner, bug_id, author, created_at, critical_area, risk_acknowledgement, owner_notified_at, revoked_at';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function fromRow(row: Record<string, unknown>): TestDowngradeRecord {
  return {
    id: Number(row.id),
    kind: row.kind === 'flaky-quarantine' ? 'flaky-quarantine' : 'downgrade',
    testFile: String(row.test_file),
    testCase: String(row.test_case ?? ''),
    reason: String(row.reason),
    owner: String(row.owner),
    bugId: String(row.bug_id),
    author: String(row.author),
    createdAt: iso(row.created_at) ?? '',
    criticalArea: row.critical_area == null ? null : String(row.critical_area),
    riskAcknowledgement: row.risk_acknowledgement == null ? null : String(row.risk_acknowledgement),
    ownerNotifiedAt: iso(row.owner_notified_at),
    revokedAt: iso(row.revoked_at),
  };
}

const rowsOf = (result: unknown) => (Array.isArray(result) ? (result as Record<string, unknown>[]) : []);

/** Postgres store over harness_shared.test_downgrades (migration 1530). */
export function pgTestDowngradeStore(sql: TestDowngradeSql, scope: TestDowngradeScope): TestDowngradeStore {
  const base = [scope.workspaceId, scope.harnessSlug];
  return {
    async insert(record) {
      const inserted = rowsOf(
        await sql.unsafe(
          `INSERT INTO harness_shared.test_downgrades
             (workspace_id, harness_slug, test_file, test_case, reason, owner, bug_id, author, critical_area, risk_acknowledgement, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (workspace_id, harness_slug, test_file, test_case) WHERE revoked_at IS NULL DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            ...base,
            record.testFile,
            record.testCase,
            record.reason,
            record.owner,
            record.bugId,
            record.author,
            record.criticalArea,
            record.riskAcknowledgement,
            record.kind ?? 'downgrade',
          ],
        ),
      );
      if (inserted[0]) return fromRow(inserted[0]);
      const existing = rowsOf(
        await sql.unsafe(
          `SELECT ${COLUMNS} FROM harness_shared.test_downgrades
            WHERE workspace_id = $1 AND harness_slug = $2 AND test_file = $3 AND test_case = $4 AND revoked_at IS NULL`,
          [...base, record.testFile, record.testCase],
        ),
      );
      if (!existing[0]) throw new Error('test downgrade insert conflicted but no active row was found');
      return { conflict: fromRow(existing[0]) };
    },
    async listActive() {
      return rowsOf(
        await sql.unsafe(
          `SELECT ${COLUMNS} FROM harness_shared.test_downgrades
            WHERE workspace_id = $1 AND harness_slug = $2 AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
          base,
        ),
      ).map(fromRow);
    },
    async listCreatedSince(since) {
      return rowsOf(
        await sql.unsafe(
          `SELECT ${COLUMNS} FROM harness_shared.test_downgrades
            WHERE workspace_id = $1 AND harness_slug = $2 AND created_at >= $3 ORDER BY created_at DESC, id DESC`,
          [...base, since.toISOString()],
        ),
      ).map(fromRow);
    },
    async revoke(id, by, reason) {
      const updated = rowsOf(
        await sql.unsafe(
          `UPDATE harness_shared.test_downgrades SET revoked_at = now(), revoked_by = $4, revoke_reason = $5
            WHERE workspace_id = $1 AND harness_slug = $2 AND id = $3 AND revoked_at IS NULL RETURNING ${COLUMNS}`,
          [...base, id, by, reason],
        ),
      );
      return updated[0] ? fromRow(updated[0]) : null;
    },
    async markOwnerNotified(id, at) {
      await sql.unsafe(
        `UPDATE harness_shared.test_downgrades SET owner_notified_at = $4 WHERE workspace_id = $1 AND harness_slug = $2 AND id = $3`,
        [...base, id, at.toISOString()],
      );
    },
  };
}
