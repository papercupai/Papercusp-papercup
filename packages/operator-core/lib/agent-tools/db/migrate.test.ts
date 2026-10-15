/**
 * migrate.test.ts — db:migrate tool surface (EI-6962).
 *
 * Locks in the two behaviors this ticket touches:
 *  - the WITHHELD (PAPERCUSP_ALLOW_DB_MIGRATE unset) branch's fallback command
 *    still tells the caller to record schema_migrations in the same
 *    BEGIN/COMMIT (unchanged from before this fix — a human/agent applying by
 *    hand still needs the reminder);
 *  - the ENABLED branch now ACTUALLY records the schema_migrations row itself
 *    (the fix): the script piped to psql wraps the migration file's own `\i`
 *    in the SAME BEGIN/COMMIT as an INSERT into harness_shared.schema_migrations
 *    with the file's sha256 — not just the su_meta coordination-domain
 *    idempotency ledger (recordResourceAction), which is a separate concern.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/db/migrate.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// WI-5217: explicit result/param types so `.mock.calls[...]` destructures and
// `.mockResolvedValue({...extra fields})` overrides typecheck against the real
// shapes (checkResourceAction's ResourceActionRecord has an optional fence_seq;
// openEscalation takes (identity, input) — an untyped `vi.fn(async () => ...)`
// infers a ZERO-arg mock, so `.mock.calls[0]` was a `[]` tuple with no index 0/1).
type ResourceActionResult = { applied: boolean; fence_seq?: number; applied_ts?: Date };
type EscalationInputLike = {
  severity: string;
  summary: string;
  body: string;
  meta?: { subjectSignature?: string };
};
type ExecFileCallback = (
  error: (Error & { code?: number | string; signal?: string | null }) | null,
  stdout: string,
  stderr: string,
) => void;

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
  readFileSync: vi.fn(() => 'CREATE TABLE foo (id int);\n'),
  checkResourceAction: vi.fn(async (): Promise<ResourceActionResult> => ({ applied: false })),
  recordResourceAction: vi.fn(async () => undefined),
  inWorkspaceTxn: vi.fn(async (_domain: unknown, _owner: unknown, fn: (tx: unknown) => unknown) => fn({})),
  openEscalation: vi.fn(async (_identity: unknown, _input: EscalationInputLike) => ({
    msg_id: 'msg-esc-1',
    ts: '2026-07-17T00:00:00.000Z',
  })),
  // EI-18159491440495603: default behavior mirrors the original inline mock (acquire +
  // run the callback); individual tests override with mockImplementationOnce to throw
  // a transient connection error before eventually resolving.
  //
  // EI-18769559897594065: explicit return-type annotation (the acquired/not-acquired
  // union, matching resource-lock-guard.ts's real GuardOutcome<T>) — otherwise TS infers
  // the mock's type from ONLY this success-shape literal, and a later
  // `.mockResolvedValue({ acquired: false, reason, holders })` override (the
  // drain-timeout test below) fails to typecheck against that narrowed inference.
  guardResource: vi.fn(
    async (
      _spec: unknown,
      run: (fence: unknown) => Promise<unknown>,
    ): Promise<{ acquired: true; result: unknown } | { acquired: false; reason: string; holders: unknown[] }> => ({
      acquired: true,
      result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
    }),
  ),
  postgres: vi.fn(),
  backupRendezvousBusy: false,
  backupLockedRelations: [] as string[],
}));

vi.mock('postgres', () => ({ default: h.postgres }));
vi.mock('node:child_process', () => ({ execFile: h.execFile, spawnSync: h.spawnSync }));
vi.mock('../../resource-governor/execution', () => ({
  runGovernedOperation: async (_input: unknown, run: (context: unknown) => Promise<unknown>) => run({}),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'default',
}));
// Keep the real fs surface for transitive imports (self-describing-store uses
// existsSync while locating the repository root); only replace migration-file reads.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: h.readFileSync,
}));
vi.mock('../locks/identity', () => ({
  readIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', coordinationDomain: 'default' }),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', workspaceId: 'default' }),
}));
vi.mock('../coordination/escalations', () => ({ openEscalation: h.openEscalation }));
vi.mock('../../embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => 'postgres://admin-url/db',
  // The migrate target resolver now reads the URL WITH its provenance; keep the
  // two in agreement so a source-aware branch sees the same admin url.
  getHarnessAdminUrlWithSource: () => ({ url: 'postgres://admin-url/db', source: 'env' }),
}));
vi.mock('../locks/su-lock-store', () => ({
  checkResourceAction: h.checkResourceAction,
  recordResourceAction: h.recordResourceAction,
  getTxPool: () => ({}),
}));
vi.mock('../locks/in-workspace-txn', () => ({ inWorkspaceTxn: h.inWorkspaceTxn }));
vi.mock('../locks/resource-lock-guard', () => ({
  guardResource: h.guardResource,
}));

import migrateTool, {
  dbMigrateAbortCompletionReceipt,
  isLockTimeoutFailure,
  isDeadlockFailure,
  isSerializationFailure,
  isRetryableLockFailure,
  lockRetryBackoffMs,
  isTransientConnectionFailure,
  connectionRetryBackoffMs,
  isDuplicateMigrationLedgerFailure,
  BACKUP_MIGRATION_ADVISORY_LOCK_KEY,
  BACKUP_APPLICATION_NAMES,
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
  migrationBackupAdvisoryLockSql,
  migrationBackupLockGuardSql,
  PSQL_PROGRESS_INTERVAL_MS,
} from './migrate';
import {
  preDestructiveSnapshotAdmissionGuardSql,
  requiresPreDestructiveSnapshotAdmission,
} from '@papercusp/backup/snapshot-admission';
import { migrationReservationGuardSql } from '../../migration-reservation';

const CTX = { role: 'operator' } as never;
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);
const FILE = '/repo/libs/papercusp/libs/db/sql/999-fake.sql';

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
// EI-21413636618986324: relative migration paths resolve against this root when
// set — delete it per-test so every existing test exercises the deterministic
// legacy fallback, and the canonical-resolution describe sets it explicitly.
const ORIGINAL_INTEGRATION_ROOT = process.env.PAPERCUSP_INTEGRATION_ROOT;
const ORIGINAL_CANONICAL_TREE = process.env.PAPERCUSP_CANONICAL_TREE;

beforeEach(() => {
  h.backupRendezvousBusy = false;
  h.backupLockedRelations = [];
  h.postgres.mockReset().mockImplementation(() => {
    const respond = (query: string) => {
      if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: !h.backupRendezvousBusy }]);
      if (query.includes('pg_advisory_unlock')) return Promise.resolve([{ released: true }]);
      if (query.includes('WITH RECURSIVE locked AS')) {
        return Promise.resolve(h.backupLockedRelations.map((name) => ({ name })));
      }
      throw new Error('unexpected SQL in fake postgres client');
    };
    return Object.assign(
      (strings: TemplateStringsArray) => respond(strings.join('')),
      {
        array: (values: unknown[]) => values,
        unsafe: (query: string) => respond(query),
        end: vi.fn(async () => undefined),
      },
    );
  });
  h.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' });
  h.execFile
    .mockReset()
    .mockImplementation((cmd: string, args: string[], opts: { encoding: 'utf8' }, callback: ExecFileCallback) => {
      const stdout = new EventEmitter();
      let buffered = '';
      return { stdout, kill: vi.fn(),
      stdin: {
        write: (input: string) => {
          buffered += input;
          const marker = /\\echo (PAPERCUSP_MIGRATION_FENCE_\w+)\n$/.exec(input)?.[1];
          if (marker) queueMicrotask(() => stdout.emit('data', marker + '\n'));
        },
        end: (input?: string) => {
          input = buffered + (input ?? '');
          const result = h.spawnSync(cmd, args, {
            ...opts,
            ...(input === undefined ? {} : { input }),
          });
          queueMicrotask(() => {
            const status = typeof result.status === 'number' ? result.status : 1;
            callback(
              status === 0
                ? null
                : Object.assign(new Error(result.stderr || `psql exited ${status}`), { code: status }),
              result.stdout ?? '',
              result.stderr ?? '',
            );
          });
        },
      },
    }; });
  h.readFileSync.mockReset().mockReturnValue('CREATE TABLE foo (id int);\n');
  h.checkResourceAction.mockReset().mockResolvedValue({ applied: false });
  h.recordResourceAction.mockReset().mockResolvedValue(undefined);
  h.openEscalation.mockReset().mockResolvedValue({ msg_id: 'msg-esc-1', ts: '2026-07-17T00:00:00.000Z' });
  h.guardResource.mockReset().mockImplementation(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
    acquired: true,
    result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
  }));
  delete process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
  delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  delete process.env.PAPERCUSP_CANONICAL_TREE;
});

/** A postgres-js-shaped transient connection error (see node_modules/postgres/src/errors.js's
 *  `connection()` factory) — `.code` is what isTransientConnectionFailure keys on. */
const connErr = (code: string) => Object.assign(new Error(`write ${code} 127.0.0.1:6432`), { code });

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
  else process.env.PAPERCUSP_ALLOW_DB_MIGRATE = ORIGINAL_ENV;
  if (ORIGINAL_INTEGRATION_ROOT === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = ORIGINAL_INTEGRATION_ROOT;
  if (ORIGINAL_CANONICAL_TREE === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
  else process.env.PAPERCUSP_CANONICAL_TREE = ORIGINAL_CANONICAL_TREE;
});

describe('db:migrate — dry run', () => {
  it('never touches psql / the lock when confirm is omitted', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE }, CTX));
    expect(out.dry_run).toBe(true);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('validates the migration file before a dry run, matching confirm resolution (legacy fallback: no PAPERCUSP_INTEGRATION_ROOT)', async () => {
    const relativeFile = 'libs/papercusp/libs/db/sql/922-datatype-display-spec.sql';
    h.readFileSync.mockImplementation(() => {
      throw new Error(`ENOENT: no such file or directory, open '${relativeFile}'`);
    });

    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: relativeFile }, CTX));

    expect(out).toMatchObject({
      ok: false,
      applied: false,
      reason: 'migration_file_unreadable',
      file: relativeFile,
    });
    expect(h.readFileSync).toHaveBeenCalledWith(relativeFile, 'utf8');
    expect(h.guardResource).not.toHaveBeenCalled();
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('returns a structured unreadable-file result before acquiring the lock', async () => {
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${FILE}'`), { code: 'ENOENT' });
    h.readFileSync.mockImplementation(() => {
      throw error;
    });

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );

    expect(out).toMatchObject({
      ok: false,
      applied: false,
      reason: 'migration_file_unreadable',
      file: FILE,
    });
    expect(out.error).toContain('ENOENT');
    expect(out.note).toContain('no lock was acquired');
    expect(h.guardResource).not.toHaveBeenCalled();
    expect(h.spawnSync).not.toHaveBeenCalled();
  });
});

describe('db:migrate — canonical staging-root resolution (EI-21413636618986324)', () => {
  const handler = (a: Record<string, unknown>) =>
    (
      migrateTool as never as {
        handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).handler(a, CTX);
  const REL = 'libs/papercusp/libs/db/sql/953-canon.sql';
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'pc-migrate-canon-'));
    mkdirSync(path.join(root, 'libs/papercusp/libs/db/sql'), { recursive: true });
    writeFileSync(path.join(root, REL), 'SELECT 1;\n');
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('dry run resolves a repo-root-relative path against the canonical staging tree, not the serving cwd', async () => {
    const expected = path.join(root, REL);
    const out = parse(await handler({ file: REL }));
    expect(out.dry_run).toBe(true);
    expect(out.resolved_file).toBe(expected);
    expect(out.would_run).toContain(expected);
    expect(h.readFileSync).toHaveBeenCalledWith(expected, 'utf8');
  });

  it('a bare filename falls back to the canonical sql dir', async () => {
    const expected = path.join(root, REL);
    const out = parse(await handler({ file: '953-canon.sql' }));
    expect(out.dry_run).toBe(true);
    expect(out.resolved_file).toBe(expected);
    expect(h.readFileSync).toHaveBeenCalledWith(expected, 'utf8');
  });

  it('an absolute path passes through untouched', async () => {
    const out = parse(await handler({ file: FILE }));
    expect(out.dry_run).toBe(true);
    expect(out.resolved_file).toBe(FILE);
    expect(out.would_run).toContain(FILE);
    expect(h.readFileSync).toHaveBeenCalledWith(FILE, 'utf8');
  });

  it('an unreadable bare filename reports every attempted location, before any lock', async () => {
    h.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    const out = parse(await handler({ file: '954-missing.sql' }));
    expect(out).toMatchObject({
      ok: false,
      applied: false,
      reason: 'migration_file_unreadable',
      file: '954-missing.sql',
    });
    expect(out.attempted_locations).toEqual([
      path.join(root, '954-missing.sql'),
      path.join(root, 'libs/papercusp/libs/db/sql/954-missing.sql'),
    ]);
    expect(h.guardResource).not.toHaveBeenCalled();
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it("the confirmed apply \\i's the SAME resolved path the dry run reported (the dry-ok/confirm-ENOENT split)", async () => {
    const expected = path.join(root, REL);
    const dry = parse(await handler({ file: REL }));
    expect(dry.resolved_file).toBe(expected);

    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    const confirmed = parse(await handler({ file: REL, confirm: true }));
    expect(confirmed.ok).toBe(true);
    const stdinScript = (h.spawnSync.mock.calls[0] as unknown[])[2] as { input?: string };
    expect(stdinScript.input).toContain(`\\i ${expected}\n`);
  });
});

describe('db:migrate — skipWorkspaceTx (EI-18733783500981433)', () => {
  it(
    'opts out of the ambient workspace tx — the handler drains + shells out to psql for up ' +
      "to minutes and never reads ctx.tx, so holding one open the whole time hits Postgres's " +
      'idle_in_transaction_session_timeout (60s) and surfaces as a bare CONNECTION_CLOSED even ' +
      'though the migration completed. Same fix as capability:bash (EI-18666279107998059).',
    () => {
      expect((migrateTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    },
  );
});

describe('db:migrate — WI-1373379: the withheld fallback carries the SAME safety rails as the real apply path', () => {
  // At/after PRE_DESTRUCTIVE_SNAPSHOT_ADMISSION_FROM (1007), so the admission
  // guard is in scope. The pre-existing FILE fixture is 999-*, BELOW the floor —
  // which is exactly why the omission this locks in went unnoticed: every
  // existing assertion about the fallback ran on a file the guard never gates.
  const GATED_FILE = '/repo/libs/papercusp/libs/db/sql/1033-fake.sql';

  const fallbackFor = async (file: string): Promise<string> => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file, confirm: true }, CTX));
    expect(out.applied).toBe(false);
    return out.fallback.command as string;
  };

  it(
    'embeds the pre-destructive snapshot admission guard. This branch is the ONLY path taken on a ' +
      'box without PAPERCUSP_ALLOW_DB_MIGRATE, so a guard-less fallback is not a local shortcut — ' +
      'it is a fleet-wide bypass of a fail-closed rail. Measured 2026-08-30: migrations 1036/1037 ' +
      "applied while the newest pre_destructive receipt was status='degraded', db_dump_ok=NULL.",
    async () => {
      expect(requiresPreDestructiveSnapshotAdmission(path.basename(GATED_FILE))).toBe(true);
      const command = await fallbackFor(GATED_FILE);
      // activeWorkspaceId is mocked to 'default' above.
      expect(command).toContain(preDestructiveSnapshotAdmissionGuardSql('default'));
    },
  );

  it('embeds the rest of the preamble too — backup advisory lock, backup relation-lock guard, reservation guard', async () => {
    const command = await fallbackFor(GATED_FILE);
    expect(command).toContain(migrationBackupAdvisoryLockSql());
    expect(command).toContain(migrationBackupLockGuardSql());
    expect(command).toContain(migrationReservationGuardSql(path.basename(GATED_FILE)));
  });

  it('orders every guard BEFORE the \\i that executes the migration body', async () => {
    const command = await fallbackFor(GATED_FILE);
    const guardAt = command.indexOf(preDestructiveSnapshotAdmissionGuardSql('default'));
    const applyAt = command.indexOf('\\i ');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(applyAt).toBeGreaterThan(guardAt);
  });

  it(
    'CONTROL: a migration BELOW the admission floor gets no snapshot guard — proves the assertions ' +
      'above track requiresPreDestructiveSnapshotAdmission() and are not passing on a constant',
    async () => {
      expect(requiresPreDestructiveSnapshotAdmission(path.basename(FILE))).toBe(false);
      const command = await fallbackFor(FILE);
      expect(command).not.toContain('papercusp_pre_destructive_snapshot_guard');
    },
  );
});

describe('db:migrate — withheld (PAPERCUSP_ALLOW_DB_MIGRATE unset)', () => {
  it('drains but withholds the apply, and the fallback command still records schema_migrations by hand', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.applied).toBe(false);
    expect(out.drained).toBe(true);
    expect(out.fallback.command).toContain('INSERT INTO harness_shared.schema_migrations');
    expect(out.fallback.command).toContain('BEGIN;');
    expect(out.fallback.command).toContain('COMMIT;');
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('EI-23131029724498087: the withheld fallback preserves statement-breakpoint transactions too', async () => {
    h.readFileSync.mockReturnValue(['SELECT 1;', '--> statement-breakpoint', 'SELECT 2;'].join('\n'));
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    const command = out.fallback.command as string;
    expect(command).not.toContain('\\i ');
    expect(command.match(/^BEGIN;\nSET LOCAL statement_timeout = 0;$/gm)).toHaveLength(2);
    expect(command.match(/^COMMIT;$/gm)).toHaveLength(2);
    expect(command.match(/INSERT INTO harness_shared\.schema_migrations/g)).toHaveLength(1);
  });

  it('EI-13299: a routine withheld confirm (no escalate) never raises a coord:escalate', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.escalation).toEqual({ escalated: false });
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  it('EI-13299: escalate:true raises a blocker coord:escalate carrying the ready-to-run command, keyed per-file for coalescing', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true, escalate: true }, CTX),
    );
    expect(out.applied).toBe(false);
    expect(out.escalation).toMatchObject({ escalated: true, msg_id: 'msg-esc-1', ts: '2026-07-17T00:00:00.000Z' });

    expect(h.openEscalation).toHaveBeenCalledTimes(1);
    const [identity, input] = h.openEscalation.mock.calls[0];
    expect(identity).toMatchObject({ ownerId: 'su-test' });
    expect(input.severity).toBe('blocker');
    expect(input.summary).toContain('999-fake.sql');
    expect(input.body).toContain('BEGIN;');
    expect(input.body).toContain('INSERT INTO harness_shared.schema_migrations');
    expect(input.meta?.subjectSignature).toBe('db-migrate-withheld:999-fake.sql');
  });

  it('EI-13299: a failed escalation is fail-soft — the withheld response still succeeds, with the error surfaced', async () => {
    h.openEscalation.mockRejectedValueOnce(new Error('coord log unavailable'));
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true, escalate: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.escalation.escalated).toBe(false);
    expect(out.escalation.error).toContain('coord log unavailable');
  });
});

describe('db:migrate — enabled (PAPERCUSP_ALLOW_DB_MIGRATE=1)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });

  it('refuses a migration that would fail the gate lint before acquiring the schema lock', async () => {
    h.readFileSync.mockReturnValue('BEGIN;\nCREATE TABLE foo (id int);\nCOMMIT;');

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );

    expect(out).toMatchObject({
      ok: false,
      applied: false,
      reason: 'migration_gate_lint_failed',
    });
    expect(out.note).toContain('top-level transaction control');
    expect(h.guardResource).not.toHaveBeenCalled();
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('WI-25783818561428811: checks the authoritative applied-file ledger before any DDL in the same psql session', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out).toMatchObject({ ok: true, applied: true, schema_migrations_recorded: true });

    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    const ledgerPresence = script.indexOf("to_regclass('harness_shared.schema_migrations')");
    const appliedCheck = script.indexOf('SELECT EXISTS (SELECT 1 FROM harness_shared.schema_migrations');
    const conditional = script.indexOf('\\if :papercusp_migration_already_applied');
    const marker = script.indexOf('PAPERCUSP_MIGRATION_ALREADY_APPLIED');
    const ddl = script.indexOf(`\\i ${FILE}`);
    expect(ledgerPresence).toBeGreaterThanOrEqual(0);
    expect(appliedCheck).toBeGreaterThan(ledgerPresence);
    expect(conditional).toBeGreaterThan(appliedCheck);
    expect(marker).toBeGreaterThan(conditional);
    expect(ddl).toBeGreaterThan(marker);
    expect(script).toContain('\\else');
    expect(script).toContain('\\endif');
  });

  it('WI-25783818561428811: a boot-applied filename returns a safe no-op without recording a second tool action', async () => {
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'PAPERCUSP_MIGRATION_ALREADY_APPLIED\n', stderr: '' });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out).toMatchObject({
      ok: true,
      applied: false,
      already_applied: true,
      schema_migrations_recorded: true,
      action_key: 'migrate:999-fake.sql',
    });
    expect(out.note).toContain('same psql session');
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('EI-6962: wraps the file in the SAME BEGIN/COMMIT as a schema_migrations INSERT, fed to psql via stdin (not -f)', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.schema_migrations_recorded).toBe(true);
    expect(typeof out.sha256).toBe('string');
    expect(out.sha256).toHaveLength(64); // sha256 hex digest length

    expect(h.spawnSync).toHaveBeenCalledTimes(1);
    const [cmd, cmdArgs, opts] = h.spawnSync.mock.calls[0];
    expect(cmd).toBe('psql');
    expect(cmdArgs).not.toContain('-f'); // no longer runs the file directly —
    expect(cmdArgs).not.toContain(FILE); // it's `\i`-included inside the piped script
    const script = (opts as { input: string }).input;
    expect(script).toContain('BEGIN;');
    expect(script).toContain('papercusp_migration_reservation_guard');
    expect(script).toContain("reserved_filename <> '999-fake.sql'");
    expect(script).toContain(`\\i ${FILE}`);
    expect(script).toContain('INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES');
    expect(script).toContain('999-fake.sql');
    expect(script).toContain('COMMIT;');
    // The INSERT must be INSIDE the same transaction as the \i, not appended after COMMIT.
    expect(script.indexOf('BEGIN;')).toBeLessThan(script.indexOf('\\i ' + FILE));
    expect(script.indexOf('\\i ' + FILE)).toBeLessThan(script.indexOf('INSERT INTO'));
    expect(script.indexOf('INSERT INTO')).toBeLessThan(script.lastIndexOf('COMMIT;'));

    // The su_meta coordination-domain idempotency ledger is STILL recorded —
    // a separate, additive concern from the schema_migrations row above.
    expect(h.recordResourceAction).toHaveBeenCalledTimes(1);
  });

  it('EI-23131029724498087: preserves statement-breakpoint transactions and records only the final chunk', async () => {
    h.readFileSync.mockReturnValue(
      [
        'ALTER TABLE harness_shared.first_hot ADD COLUMN IF NOT EXISTS profile text;',
        '--> statement-breakpoint',
        'ALTER TABLE harness_shared.second_hot ADD COLUMN IF NOT EXISTS profile text;',
      ].join('\n'),
    );

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out).toMatchObject({ ok: true, applied: true, schema_migrations_recorded: true });

    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).not.toContain('\\i ');
    expect(script.match(/^BEGIN;\nSET LOCAL statement_timeout = 0;$/gm)).toHaveLength(2);
    expect(script.match(/^COMMIT;$/gm)).toHaveLength(2);
    expect(script.match(/DO \$papercusp_migration_reservation_guard\$/g)).toHaveLength(2);
    expect(script.match(/INSERT INTO harness_shared\.schema_migrations/g)).toHaveLength(1);

    const first = script.indexOf('ALTER TABLE harness_shared.first_hot');
    const firstCommit = script.indexOf('COMMIT;', first);
    const second = script.indexOf('ALTER TABLE harness_shared.second_hot');
    const ledger = script.indexOf('INSERT INTO harness_shared.schema_migrations');
    const secondCommit = script.indexOf('COMMIT;', second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(firstCommit).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(firstCommit);
    expect(ledger).toBeGreaterThan(second);
    expect(secondCommit).toBeGreaterThan(ledger);
  });

  it('WI-10007383: mirrors bounded historical projection chunks in guarded psql', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const sql = fs.readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/1422-adv-sessions-launch-harness-projection.sql', import.meta.url), 'utf8');
    h.readFileSync.mockReturnValue(sql);
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out).toMatchObject({ ok: true, applied: true });
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script.match(/LIMIT 64/g)).toHaveLength(1024);
    expect(script.match(/^COMMIT;$/gm)).toHaveLength(1026);
    expect(script.match(/INSERT INTO harness_shared\.schema_migrations/g)).toHaveLength(1);
    expect(script.indexOf('projection_backfill_done')).toBeLessThan(script.indexOf('INSERT INTO harness_shared.schema_migrations'));
  });

  it('EI-217072: places the completed pre-destructive snapshot admission guard before guarded DDL', async () => {
    const guardedFile = '/repo/libs/papercusp/libs/db/sql/1016-pre-snapshot-guarded.sql';
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: guardedFile, confirm: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);

    const [, , opts] = h.spawnSync.mock.calls[0];
    const script = (opts as { input: string }).input;
    const guardIndex = script.indexOf('papercusp_pre_destructive_snapshot_guard');
    const includeIndex = script.indexOf(`\\i ${guardedFile}`);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(includeIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain("latest.status = 'ok'");
    expect(script).toContain('latest.finished_at IS NOT NULL');
    expect(script).toContain('latest.kopia_snapshot_id IS NOT NULL');
    expect(script).toContain('latest.db_dump_ok IS TRUE');
  });

  it('EI-217072: exempts migration 1006 so it can introduce db_dump_ok before the guard is meaningful', async () => {
    const schemaMigration = '/repo/libs/papercusp/libs/db/sql/1006-backup-snapshot-db-dump-integrity.sql';
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: schemaMigration, confirm: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);

    const [, , opts] = h.spawnSync.mock.calls[0];
    const script = (opts as { input: string }).input;
    expect(script).not.toContain('papercusp_pre_destructive_snapshot_guard');
    expect(script).toContain(`\\i ${schemaMigration}`);
  });

  it('a failed psql apply is reported and never records either ledger', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: syntax error' });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.exit_code).toBe(1);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('preserves the child error and terminating signal when psql is killed with empty stderr', async () => {
    const error = Object.assign(new Error('psql process failed'), { signal: 'SIGTERM' });
    h.execFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { encoding: 'utf8' }, callback: ExecFileCallback) => ({
        stdin: { write: () => queueMicrotask(() => callback(error, '', '')), end: vi.fn() },
      }),
    );

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );

    expect(out).toMatchObject({
      ok: false,
      applied: false,
      exit_code: 1,
      stderr: 'psql process failed (killed by SIGTERM)',
      signal: 'SIGTERM',
    });
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('preserves the spawn error when psql cannot be started and stderr is empty', async () => {
    const error = Object.assign(new Error('spawn psql ENOENT'), { code: 'ENOENT' });
    h.execFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { encoding: 'utf8' }, callback: ExecFileCallback) => ({
        stdin: { write: () => queueMicrotask(() => callback(error, '', '')), end: vi.fn() },
      }),
    );

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );

    expect(out).toMatchObject({ ok: false, applied: false, exit_code: 1, stderr: 'spawn psql ENOENT', signal: null });
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('keeps psql stderr when the child error also has a message', async () => {
    const error = Object.assign(new Error('generic execFile failure'), { code: 1 });
    h.execFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { encoding: 'utf8' }, callback: ExecFileCallback) => ({
        stdin: { write: () => queueMicrotask(() => callback(error, '', 'ERROR: syntax error')), end: vi.fn() },
      }),
    );

    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );

    expect(out).toMatchObject({ ok: false, applied: false, exit_code: 1, stderr: 'ERROR: syntax error', signal: null });
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('an already-applied file (su_meta idempotency ledger) short-circuits without touching psql', async () => {
    h.checkResourceAction.mockResolvedValue({ applied: true, fence_seq: 3 });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.already_applied).toBe(true);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });
});

describe('db:migrate — lease loss after SQL guards (WI-10008141)', () => {
  beforeEach(() => { process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1'; });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['expired_or_released', 'superseded'] as const)(
    'withholds the DDL and action receipt when the post-wait fence is %s', async (reason) => {
      const assertCurrent = vi.fn()
        .mockResolvedValueOnce({ current: true, live_fence_seq: 7 })
        .mockResolvedValue({ current: false, reason, live_fence_seq: 8 });
      h.guardResource.mockImplementation(async (_spec, run) => ({
        acquired: true, result: await run({ seq: 7, assertCurrent }),
      }));
      const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
      expect(out).toMatchObject({ ok: false, applied: false, reason: `stale_fence_${reason}`, attempts: 1 });
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      const sent = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
      expect(sent).toContain('pg_advisory_xact_lock');
      expect(sent).not.toContain(`\\i ${FILE}`);
      expect(sent).not.toContain('INSERT INTO harness_shared.schema_migrations');
      expect(h.recordResourceAction).not.toHaveBeenCalled();
    },
  );

  it('fails closed when post-wait lease validation is unavailable', async () => {
    const assertCurrent = vi.fn()
      .mockResolvedValueOnce({ current: true, live_fence_seq: 7 })
      .mockRejectedValue(new Error('lock database unavailable'));
    h.guardResource.mockImplementation(async (_spec, run) => ({
      acquired: true, result: await run({ seq: 7, assertCurrent }),
    }));
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.reason).toBe('stale_fence_check_failed');
    expect(h.recordResourceAction).not.toHaveBeenCalled();
    expect((h.spawnSync.mock.calls[0][2] as { input: string }).input).not.toContain(`\\i ${FILE}`);
  });

  it('cancels its own blocked child on expiry and never retries that fence, even with lock-timeout stderr', async () => {
    vi.useFakeTimers();
    const assertCurrent = vi.fn()
      .mockResolvedValueOnce({ current: true, live_fence_seq: 7 })
      .mockResolvedValue({ current: false, reason: 'expired_or_released' });
    h.guardResource.mockImplementation(async (_spec, run) => ({
      acquired: true, result: await run({ seq: 7, assertCurrent }),
    }));
    const write = vi.fn();
    const kill = vi.fn();
    h.execFile.mockImplementationOnce((_cmd, _args, _opts, callback: ExecFileCallback) => ({
      stdout: new EventEmitter(), kill,
      stdin: { write, end: () => queueMicrotask(() => callback(
        Object.assign(new Error('cancelled'), { code: 3 }), '', 'ERROR: canceling statement due to lock timeout',
      )) },
    }));
    const pending = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(parse(await pending)).toMatchObject({ reason: 'stale_fence_expired_or_released', attempts: 1 });
    expect(kill).toHaveBeenCalledWith('SIGINT');
    expect(h.execFile).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).not.toContain(`\\i ${FILE}`);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });
});

describe('db:migrate — drain/apply progress + timeout safety note (EI-18769559897594065)', () => {
  const progressCtx = () => {
    const progress = vi.fn();
    return { ctx: { role: 'operator', progress } as never, progress };
  };

  it('wires a spec.onTick callback into guardResource that forwards to ctx.progress as a draining-phase tick', async () => {
    const { ctx, progress } = progressCtx();
    h.guardResource.mockImplementation(async (spec: unknown, run: (fence: unknown) => Promise<unknown>) => {
      const s = spec as { onTick?: (info: { waited_sec: number; holders: unknown[] }) => void };
      s.onTick?.({
        waited_sec: 12,
        holders: [{ owner: 'su-peer', owner_label: 'peer', mode: 'shared', status: 'draining' }],
      });
      return { acquired: true, result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }) };
    });
    await (migrateTool as never as { handler: Function }).handler(
      { file: FILE, confirm: true, max_drain_sec: 45 },
      ctx,
    );
    expect(progress).toHaveBeenCalled();
    const draining = progress.mock.calls.map((c) => JSON.parse(c[1] as string)).find((p) => p.phase === 'draining');
    expect(draining).toMatchObject({ phase: 'draining', elapsed_sec: 12, max_drain_sec: 45, remaining_sec: 33 });
    expect(draining.holders[0]).toMatchObject({ owner: 'su-peer', mode: 'shared' });
  });

  it('does not throw when ctx has no progress function (older transport shape)', async () => {
    h.guardResource.mockImplementation(async (spec: unknown, run: (fence: unknown) => Promise<unknown>) => {
      const s = spec as { onTick?: (info: { waited_sec: number; holders: unknown[] }) => void };
      s.onTick?.({ waited_sec: 5, holders: [] });
      return { acquired: true, result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }) };
    });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(true);
  });

  it('emits an applying-phase progress tick when the psql apply begins (enabled path)', async () => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    const { ctx, progress } = progressCtx();
    await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, ctx);
    const applying = progress.mock.calls
      .map((c) => JSON.parse(c[1] as string))
      .find((p) => p.phase === 'applying' && !('retry_attempt' in p));
    expect(applying).toMatchObject({ phase: 'applying', file: '999-fake.sql' });
  });

  it('keeps emitting applying heartbeats while async psql remains pending, then clears the timer', async () => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    vi.useFakeTimers();
    try {
      let finish: ExecFileCallback | undefined;
      h.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: { encoding: 'utf8' }, callback: ExecFileCallback) => {
          finish = callback;
          return { stdin: { write: vi.fn(), end: vi.fn() }, stdout: new EventEmitter(), kill: vi.fn() };
        },
      );
      const { ctx, progress } = progressCtx();
      const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, ctx);

      await vi.advanceTimersByTimeAsync(PSQL_PROGRESS_INTERVAL_MS);
      const heartbeat = progress.mock.calls
        .map((c) => JSON.parse(c[1] as string))
        .find((p) => p.phase === 'applying' && p.heartbeat === true);
      expect(heartbeat).toMatchObject({ phase: 'applying', file: '999-fake.sql', heartbeat: true });

      expect(finish).toBeDefined();
      finish?.(null, '', '');
      const out = parse(await promise);
      expect(out.applied).toBe(true);

      const progressCallsAfterExit = progress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PSQL_PROGRESS_INTERVAL_MS * 2);
      expect(progress).toHaveBeenCalledTimes(progressCallsAfterExit);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a retry-attempt progress tick on attempt 2+ but not on the first attempt', async () => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'ERROR:  canceling statement due to lock timeout' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const { ctx, progress } = progressCtx();
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, ctx);
    await vi.advanceTimersByTimeAsync(2000);
    const out = parse(await promise);
    vi.useRealTimers();
    expect(out.applied).toBe(true);
    const retryTicks = progress.mock.calls
      .map((c) => JSON.parse(c[1] as string))
      .filter((p) => p.phase === 'applying' && 'retry_attempt' in p);
    expect(retryTicks).toEqual([{ phase: 'applying', retry_attempt: 2, max_attempts: 5 }]);
  });

  it('an acquire/drain failure (no DDL ran) carries a note that it is safe to retry immediately', async () => {
    h.guardResource.mockResolvedValue({
      acquired: false,
      reason: 'drain_timeout',
      holders: [{ owner: 'su-peer', owner_label: 'peer', mode: 'shared', status: 'draining' }],
    });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('resource_drain_timeout');
    expect(out.note).toContain('No DDL was applied');
    expect(out.note).toContain('Safe to retry');
  });
});

describe('db:migrate — lock-timeout retry on a hot table (EI-9417)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LOCK_TIMEOUT_STDERR = 'ERROR:  canceling statement due to lock timeout';

  it('sets an explicit lock_timeout so a stuck attempt fails fast instead of hanging indefinitely', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(1);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).toContain("SET LOCAL lock_timeout = '10s';");
    expect(script).toContain(`SELECT pg_advisory_xact_lock(hashtext('${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}'));`);
    for (const applicationName of BACKUP_APPLICATION_NAMES) {
      expect(script).toContain(`'${applicationName}'`);
    }
    expect(script).toContain("ERRCODE = '55P03'");
    expect(script).toContain('backup pg_dump holds AccessShareLock');
    expect(script.indexOf('backup pg_dump holds AccessShareLock')).toBeLessThan(script.indexOf('\\i ' + FILE));
    expect(script.indexOf('SET LOCAL lock_timeout')).toBeLessThan(script.indexOf('\\i ' + FILE));
    expect(script.indexOf('pg_advisory_xact_lock')).toBeLessThan(script.indexOf('\\i ' + FILE));
  });

  it('exports the transaction-scoped backup rendezvous using the canonical key', () => {
    expect(migrationBackupAdvisoryLockSql()).toBe(
      `SET LOCAL lock_timeout = 0;\n` +
        `SET LOCAL statement_timeout = 0;\n` +
        `SELECT pg_advisory_xact_lock(hashtext('${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}'));\n` +
        `SET LOCAL lock_timeout = '10s';\n`,
    );
  });

  it('disables both timeouts only for the rendezvous wait, then restores the requested DDL timeout', () => {
    const sql = migrationBackupAdvisoryLockSql(180);
    const disableLock = sql.indexOf('SET LOCAL lock_timeout = 0;');
    const disableStatement = sql.indexOf('SET LOCAL statement_timeout = 0;');
    const acquire = sql.indexOf('pg_advisory_xact_lock');
    const restore = sql.indexOf("SET LOCAL lock_timeout = '180s';");
    expect(disableLock).toBeGreaterThanOrEqual(0);
    expect(disableStatement).toBeGreaterThan(disableLock);
    expect(acquire).toBeGreaterThan(disableStatement);
    expect(restore).toBeGreaterThan(acquire);
  });

  it('exports a backup-lock guard that raises the retryable lock-timeout shape before DDL', () => {
    const guard = migrationBackupLockGuardSql();
    expect(guard).toContain("l.mode = 'AccessShareLock'");
    expect(HOST_BACKUP_APPLICATION_NAME).not.toBe(WORKSPACE_BACKUP_APPLICATION_NAME);
    expect(guard).toContain(
      `a.application_name IN ('${HOST_BACKUP_APPLICATION_NAME}', '${WORKSPACE_BACKUP_APPLICATION_NAME}')`,
    );
    expect(guard).toContain("USING ERRCODE = '55P03'");
    expect(guard).toContain('canceling statement due to lock timeout');
  });

  it('bypasses a busy rendezvous for an enabled migration proven unrelated to the live backup locks', async () => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    h.backupRendezvousBusy = true;
    h.backupLockedRelations = ['session_archive_files'];
    h.readFileSync.mockReturnValue('ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;');
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.applied).toBe(true);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).not.toContain('pg_advisory_xact_lock');
    expect(script).not.toContain('backup pg_dump holds AccessShareLock');
  });

  it.each([
    [
      'overlapping relation',
      'ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;',
      ['trigger_bindings'],
    ],
    [
      'unprovable dynamic SQL',
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD c int', t); END $$;",
      [],
    ],
  ])('keeps the blocking preamble for a busy rendezvous with %s', async (_label, sqlText, lockedRelations) => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
    h.backupRendezvousBusy = true;
    h.backupLockedRelations = lockedRelations;
    h.readFileSync.mockReturnValue(sqlText);
    await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).toContain(
      'SELECT pg_advisory_xact_lock(hashtext(' +
        "'" +
        BACKUP_MIGRATION_ADVISORY_LOCK_KEY +
        "'));",
    );
    expect(script).toContain('backup pg_dump holds AccessShareLock');
  });

  it('retries a lock-timeout cancel with backoff and succeeds once contention clears', async () => {
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(4000); // backoff after attempt 2
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(3);
    expect(h.spawnSync).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-lock-timeout failure — fails fast on a single attempt', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: syntax error' });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.lock_timeout_retries_exhausted).toBe(false);
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries after 5 repeated lock-timeout cancels and reports lock_timeout_retries_exhausted', async () => {
    vi.useFakeTimers();
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    const out = parse(await promise);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(5);
    expect(out.lock_timeout_retries_exhausted).toBe(true);
    expect(h.spawnSync).toHaveBeenCalledTimes(5);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  // EI-18747087108453188: a deadlock is if anything MORE retryable than a lock
  // timeout (PG has already broken the cycle by killing one side of it), and
  // it is the MORE LIKELY failure here — but the retry loop originally only
  // recognized isLockTimeoutFailure, so a deadlocked migration gave up after
  // one attempt.
  const DEADLOCK_STDERR =
    'ERROR:  deadlock detected\n' +
    'DETAIL:  Process 181887 waits for AccessExclusiveLock on relation 16306610; blocked by process 3301494.\n' +
    '         Process 3301494 waits for AccessShareLock on relation 35727; blocked by process 181887.';
  const SERIALIZATION_FAILURE_STDERR = 'ERROR:  could not serialize access due to concurrent update';

  it('retries a deadlock cancel with backoff and succeeds once the cycle clears', async () => {
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: DEADLOCK_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(2);
    expect(h.spawnSync).toHaveBeenCalledTimes(2);
  });

  it('retries a serialization-failure cancel with backoff and succeeds once contention clears', async () => {
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: SERIALIZATION_FAILURE_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000);
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(2);
    expect(h.spawnSync).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries after 5 repeated deadlock cancels and still reports lock_timeout_retries_exhausted (widened predicate)', async () => {
    vi.useFakeTimers();
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: DEADLOCK_STDERR });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    const out = parse(await promise);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(5);
    expect(out.lock_timeout_retries_exhausted).toBe(true);
    expect(h.spawnSync).toHaveBeenCalledTimes(5);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });
});

describe('db:migrate — caller-widened lock_timeout_sec (WI-6381)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LOCK_TIMEOUT_STDERR = 'ERROR:  canceling statement due to lock timeout';

  it('omitting lock_timeout_sec keeps the EI-9417 default (10s) unchanged', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.applied).toBe(true);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).toContain("SET LOCAL lock_timeout = '10s';");
  });

  it('a caller-supplied lock_timeout_sec widens the per-attempt SQL lock_timeout to that value', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler(
        { file: FILE, confirm: true, lock_timeout_sec: 180 },
        CTX,
      ),
    );
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(1);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).toContain("SET LOCAL lock_timeout = '180s';");
    expect(script.indexOf('SET LOCAL lock_timeout')).toBeLessThan(script.indexOf('\\i ' + FILE));
  });

  it('a caller-supplied lock_timeout_sec drops the retry ceiling to 2 attempts instead of the default 5', async () => {
    vi.useFakeTimers();
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR });
    const promise = (migrateTool as never as { handler: Function }).handler(
      { file: FILE, confirm: true, lock_timeout_sec: 180 },
      CTX,
    );
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    const out = parse(await promise);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(2);
    expect(out.lock_timeout_retries_exhausted).toBe(true);
    expect(h.spawnSync).toHaveBeenCalledTimes(2);
  });

  it('a caller-supplied lock_timeout_sec still succeeds on the first attempt once the long wait rides out the contention', async () => {
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const promise = (migrateTool as never as { handler: Function }).handler(
      { file: FILE, confirm: true, lock_timeout_sec: 180 },
      CTX,
    );
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(2);
    expect(h.spawnSync).toHaveBeenCalledTimes(2);
  });

  it('rejects a lock_timeout_sec above the 300s ceiling at the schema level', () => {
    const argsSchema = (migrateTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    expect(argsSchema.safeParse({ file: FILE, confirm: true, lock_timeout_sec: 301 }).success).toBe(false);
    expect(argsSchema.safeParse({ file: FILE, confirm: true, lock_timeout_sec: 300 }).success).toBe(true);
  });

  it('rejects a non-positive lock_timeout_sec at the schema level', () => {
    const argsSchema = (migrateTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    expect(argsSchema.safeParse({ file: FILE, confirm: true, lock_timeout_sec: 0 }).success).toBe(false);
    expect(argsSchema.safeParse({ file: FILE, confirm: true, lock_timeout_sec: -5 }).success).toBe(false);
  });
});

describe('db:migrate — false-failure guard on the schema_migrations ledger (WI-6002)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });

  const DUP_KEY_STDERR =
    'ERROR:  duplicate key value violates unique constraint "schema_migrations_pkey"\n' +
    'DETAIL:  Key (filename)=(999-fake.sql) already exists.';

  it('a script failure on the schema_migrations duplicate-key guard, with the file ALREADY recorded, reports ok:true/already_applied — not a failure', async () => {
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: DUP_KEY_STDERR }) // the migration script attempt
      .mockReturnValueOnce({ status: 0, stdout: '1\n', stderr: '' }); // the fresh verification SELECT
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.already_applied).toBe(true);
    expect(out.note).toContain('FRESH connection');

    expect(h.spawnSync).toHaveBeenCalledTimes(2);
    const [verifyCmd, verifyArgs] = h.spawnSync.mock.calls[1];
    expect(verifyCmd).toBe('psql');
    expect(verifyArgs).toContain('-tAc');
    expect(verifyArgs.join(' ')).toContain('schema_migrations');
    expect(verifyArgs.join(' ')).toContain('999-fake.sql');
  });

  it('a script failure on the duplicate-key guard, with the file NOT actually recorded (a genuinely different collision), still reports a real failure', async () => {
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: DUP_KEY_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // verification finds no row
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.already_applied).toBeUndefined();
  });

  it('a genuine syntax/logic error never triggers the verification round-trip', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: syntax error at or near "FOO"' });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.already_applied).toBeUndefined();
    expect(h.spawnSync).toHaveBeenCalledTimes(1); // no second (verification) call
  });

  it('a verification psql invocation that itself fails is treated as unknown, not already-applied — reports the real failure', async () => {
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: DUP_KEY_STDERR })
      .mockReturnValueOnce({ status: 2, stdout: '', stderr: 'psql: could not connect to server' });
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.already_applied).toBeUndefined();
  });
});

describe('isDuplicateMigrationLedgerFailure — pure helper (WI-6002)', () => {
  it("matches PG's own duplicate-key error on the schema_migrations ledger, case-insensitively", () => {
    expect(
      isDuplicateMigrationLedgerFailure(
        'ERROR:  duplicate key value violates unique constraint "schema_migrations_pkey"',
      ),
    ).toBe(true);
    expect(isDuplicateMigrationLedgerFailure('error: violates unique constraint "SCHEMA_MIGRATIONS_PKEY"')).toBe(true);
  });

  it('does not match an unrelated failure (including a different unique-constraint violation)', () => {
    expect(isDuplicateMigrationLedgerFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(
      isDuplicateMigrationLedgerFailure('ERROR: duplicate key value violates unique constraint "some_other_pkey"'),
    ).toBe(false);
    expect(isDuplicateMigrationLedgerFailure('')).toBe(false);
  });
});

describe('isLockTimeoutFailure / lockRetryBackoffMs — pure helpers (EI-9417)', () => {
  it("matches PG's own lock-timeout cancel message, case-insensitively", () => {
    expect(isLockTimeoutFailure('ERROR:  canceling statement due to lock timeout')).toBe(true);
    expect(isLockTimeoutFailure('error: CANCELING STATEMENT DUE TO LOCK TIMEOUT')).toBe(true);
  });

  it('does not match an unrelated failure (including the similarly-worded statement_timeout cancel)', () => {
    expect(isLockTimeoutFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(isLockTimeoutFailure('ERROR: canceling statement due to statement timeout')).toBe(false);
    expect(isLockTimeoutFailure('')).toBe(false);
  });

  it('backs off exponentially (2s, 4s, 8s, 16s), capped at 30s', () => {
    expect(lockRetryBackoffMs(1)).toBe(2000);
    expect(lockRetryBackoffMs(2)).toBe(4000);
    expect(lockRetryBackoffMs(3)).toBe(8000);
    expect(lockRetryBackoffMs(4)).toBe(16000);
    expect(lockRetryBackoffMs(5)).toBe(30000); // would be 32000 uncapped
  });
});

describe('isDeadlockFailure / isSerializationFailure / isRetryableLockFailure — pure helpers (EI-18747087108453188)', () => {
  it("matches PG's own deadlock message, case-insensitively, including its DETAIL lines", () => {
    expect(isDeadlockFailure('ERROR:  deadlock detected')).toBe(true);
    expect(isDeadlockFailure('error: DEADLOCK DETECTED')).toBe(true);
    expect(
      isDeadlockFailure(
        'ERROR:  deadlock detected\nDETAIL:  Process 1 waits for AccessExclusiveLock on relation 2; blocked by process 3.',
      ),
    ).toBe(true);
  });

  it('isDeadlockFailure does not match an unrelated failure', () => {
    expect(isDeadlockFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(isDeadlockFailure('ERROR:  canceling statement due to lock timeout')).toBe(false);
    expect(isDeadlockFailure('')).toBe(false);
  });

  it("matches PG's own serialization-failure message, case-insensitively", () => {
    expect(isSerializationFailure('ERROR:  could not serialize access due to concurrent update')).toBe(true);
    expect(
      isSerializationFailure('error: COULD NOT SERIALIZE ACCESS due to read/write dependencies among transactions'),
    ).toBe(true);
  });

  it('isSerializationFailure does not match an unrelated failure', () => {
    expect(isSerializationFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(isSerializationFailure('ERROR:  deadlock detected')).toBe(false);
    expect(isSerializationFailure('')).toBe(false);
  });

  it('isRetryableLockFailure is true for all three retryable classes and false for a genuine logic error', () => {
    expect(isRetryableLockFailure('ERROR:  canceling statement due to lock timeout')).toBe(true);
    expect(isRetryableLockFailure('ERROR:  deadlock detected')).toBe(true);
    expect(isRetryableLockFailure('ERROR:  could not serialize access due to concurrent update')).toBe(true);
    expect(isRetryableLockFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(isRetryableLockFailure('')).toBe(false);
  });

  // EI-19320461261471579 — the ANTI-DRIFT guard, and the one that would have
  // caught the original bug. There are TWO paths that apply migrations: this
  // tool (an agent applying one by hand) and db-boot-migrate (operator boot +
  // the green-checkpoint gate's migration preflight). The deadlock retry was
  // added HERE and never reached the gate, so a deadlocked migration aborted
  // the gate run as INCONCLUSIVE and held main for the whole fleet.
  //
  // Identity — not just equal behaviour — is the assertion, because that is
  // exactly what a re-fork breaks: someone copying the regexes into a second
  // site would still pass a behavioural test today, and drift the moment one
  // copy is updated. If this fails, do not "fix" it by relaxing it to a
  // behavioural check; make both paths import lib/pg-retryable-failure again.
  it('exposes the SAME predicate object the boot/gate migration path uses — one definition, no second copy', async () => {
    const shared = await import('../../pg-retryable-failure');
    expect(isRetryableLockFailure).toBe(shared.isRetryableLockFailure);
    expect(isDeadlockFailure).toBe(shared.isDeadlockFailure);
    expect(isLockTimeoutFailure).toBe(shared.isLockTimeoutFailure);
    expect(isSerializationFailure).toBe(shared.isSerializationFailure);
  });
});

describe('db:migrate — connection-drop retry around guardResource (EI-18159491440495603)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient CONNECTION_CLOSED throw and succeeds once the connection recovers', async () => {
    vi.useFakeTimers();
    h.guardResource
      .mockImplementationOnce(async () => {
        throw connErr('CONNECTION_CLOSED');
      })
      .mockImplementationOnce(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
        acquired: true,
        result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
      }));
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 1
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(h.guardResource).toHaveBeenCalledTimes(2);
  });

  it('retries CONNECTION_DESTROYED and CONNECT_TIMEOUT the same way (all three postgres-js connection-layer codes)', async () => {
    for (const code of ['CONNECTION_DESTROYED', 'CONNECT_TIMEOUT']) {
      h.guardResource.mockReset();
      vi.useFakeTimers();
      h.guardResource
        .mockImplementationOnce(async () => {
          throw connErr(code);
        })
        .mockImplementationOnce(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
          acquired: true,
          result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
        }));
      const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
      await vi.advanceTimersByTimeAsync(1000);
      const out = parse(await promise);
      expect(out.applied).toBe(true);
      vi.useRealTimers();
    }
  });

  it('does NOT retry a genuine (non-connection-layer) throw — fails fast, unretried', async () => {
    h.guardResource.mockImplementation(async () => {
      throw new Error('boom: something unrelated broke');
    });
    await expect(
      (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    ).rejects.toThrow('boom: something unrelated broke');
    expect(h.guardResource).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries after 3 repeated CONNECTION_CLOSED throws and rethrows the last one', async () => {
    vi.useFakeTimers();
    h.guardResource.mockImplementation(async () => {
      throw connErr('CONNECTION_CLOSED');
    });
    const promise = (migrateTool as never as { handler: Function })
      .handler({ file: FILE, confirm: true }, CTX)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 2
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('CONNECTION_CLOSED');
    expect(h.guardResource).toHaveBeenCalledTimes(3);
  });
});

describe('isTransientConnectionFailure / connectionRetryBackoffMs — pure helpers (EI-18159491440495603)', () => {
  it("matches postgres-js's own connection-layer error codes", () => {
    expect(isTransientConnectionFailure(connErr('CONNECTION_CLOSED'))).toBe(true);
    expect(isTransientConnectionFailure(connErr('CONNECTION_DESTROYED'))).toBe(true);
    expect(isTransientConnectionFailure(connErr('CONNECT_TIMEOUT'))).toBe(true);
  });

  it('does not match a genuine SQL/logic error (no matching .code) or a non-Error value', () => {
    expect(isTransientConnectionFailure(new Error('plain error, no code'))).toBe(false);
    expect(isTransientConnectionFailure(Object.assign(new Error('x'), { code: 'SOME_OTHER_CODE' }))).toBe(false);
    expect(isTransientConnectionFailure('not an error')).toBe(false);
    expect(isTransientConnectionFailure(null)).toBe(false);
    expect(isTransientConnectionFailure(undefined)).toBe(false);
  });

  it('backs off exponentially (1s, 2s, 4s), capped at 8s', () => {
    expect(connectionRetryBackoffMs(1)).toBe(1000);
    expect(connectionRetryBackoffMs(2)).toBe(2000);
    expect(connectionRetryBackoffMs(3)).toBe(4000);
    expect(connectionRetryBackoffMs(4)).toBe(8000); // would be 8000 anyway, but locks in the cap
    expect(connectionRetryBackoffMs(5)).toBe(8000); // would be 16000 uncapped
  });
});

describe('db:migrate abort completion receipt (WI-10005670)', () => {
  const result = (payload: Record<string, unknown>) =>
    ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }) as never;

  it('reports a late successful apply as recorded only with the schema ledger receipt', () => {
    expect(dbMigrateAbortCompletionReceipt(
      { file: FILE },
      result({ ok: true, applied: true, schema_migrations_recorded: true }),
    )).toEqual({ status: 'recorded', effectRef: 'migrate:999-fake.sql' });
  });

  it('reports an already-applied migration as recorded using the resource idempotency key', () => {
    expect(dbMigrateAbortCompletionReceipt(
      { file: FILE },
      result({ ok: true, already_applied: true, action_key: 'migrate:999-fake.sql' }),
    )).toEqual({
      status: 'recorded',
      effectRef: 'migrate:999-fake.sql',
      reason: 'migration was already recorded as applied',
    });
  });

  it('reports dry runs and withheld applies as not recorded', () => {
    expect(dbMigrateAbortCompletionReceipt(
      { file: FILE },
      result({ ok: true, dry_run: true }),
    )).toMatchObject({ status: 'not-recorded' });
    expect(dbMigrateAbortCompletionReceipt(
      { file: FILE },
      result({ ok: true, applied: false, note: 'apply withheld' }),
    )).toEqual({ status: 'not-recorded', reason: 'apply withheld' });
  });

  it('fails closed when a successful result lacks a durable migration outcome', () => {
    expect(dbMigrateAbortCompletionReceipt(
      {},
      result({ ok: true, applied: true }),
    )).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-migration-outcome'],
    });
  });

  it('does not claim a failed breakpoint migration had no partial effects', () => {
    expect(dbMigrateAbortCompletionReceipt(
      { file: FILE },
      result({ ok: false, applied: false, stderr: 'chunk 2 failed' }),
    )).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['migration-not-confirmed'],
    });
  });
});
