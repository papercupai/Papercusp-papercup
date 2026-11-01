/**
 * WI-10003357 — prove that pending migrations can apply while a backup still
 * holds the backup↔migration rendezvous.
 *
 * The rendezvous (`BACKUP_MIGRATION_ADVISORY_LOCK_KEY`) is held by a backup
 * producer for its whole dump lifecycle, which on this box includes a ~99 GiB
 * transcript tier that locks only the session-archive tables. Boot-migrate
 * used to wait on it unconditionally whenever any migration was pending, so a
 * request-only operator stayed dark for the entire backup (2026-09-26: 17:21 →
 * 17:46) even though its one pending migration touched a table the running
 * dump no longer held.
 *
 * What the rendezvous protects is real: `pg_dump -j` workers take their table
 * locks with NOWAIT, so a migration's AccessExclusive request on a table the
 * dump is reading fails the dump, and a queued AccessExclusive also stalls
 * every ordinary reader of that table. Both hazards exist only for relations
 * the backup has LOCKED. So the proof is relation-scoped: it reads the
 * relations currently locked by backup backends (the same identity predicate
 * `db:migrate`'s `migrationBackupLockGuardSql` uses), expands them with their
 * inheritance ancestors and index names, and refuses when any pending
 * migration names one — or contains a statement whose lock footprint cannot be
 * read from its text.
 *
 * It is deliberately conservative: a false "conflict" only means boot keeps
 * waiting (the old behaviour), while a false "safe" is the thing to avoid.
 */
import type { Sql } from 'postgres';
import { BACKUP_APPLICATION_NAMES, BACKUP_MIGRATION_ADVISORY_LOCK_KEY } from '@papercusp/backup/application-names';
import { splitStatements } from './db-tools/sanitize-baseline';

export interface PendingMigrationText {
  file: string;
  sqlText: string;
}

export interface MigrationLockConflict {
  file: string;
  /** The locked relation named, or the unprovable construct matched. */
  subject: string;
  reason: 'names-locked-relation' | 'unprovable-statement';
}

/**
 * Statements whose lock footprint reaches relations they do not name, so the
 * text match below cannot prove them safe.
 */
const UNPROVABLE_STATEMENTS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'EXECUTE (dynamic SQL)', re: /\bexecute\b/ },
  { label: 'ALL TABLES IN SCHEMA', re: /\ball\s+tables\s+in\s+schema\b/ },
  { label: 'ALL IN TABLESPACE', re: /\ball\s+in\s+tablespace\b/ },
  { label: 'DROP SCHEMA', re: /\bdrop\s+schema\b/ },
  { label: 'DROP OWNED', re: /\bdrop\s+owned\b/ },
  { label: 'REASSIGN OWNED', re: /\breassign\s+owned\b/ },
  { label: 'VACUUM', re: /\bvacuum\b/ },
  { label: 'CLUSTER', re: /\bcluster\b/ },
  { label: 'REINDEX SCHEMA/DATABASE/SYSTEM', re: /\breindex\s+(?:\([^)]*\)\s*)?(?:schema|database|system)\b/ },
  { label: 'ALTER DOMAIN', re: /\balter\s+domain\b/ },
  { label: 'DROP … CASCADE', re: /\bdrop\b[^;]*\bcascade\b/ },
  { label: 'TRUNCATE … CASCADE', re: /\btruncate\b[^;]*\bcascade\b/ },
];

/**
 * Lowercase, drop double quotes, and blank out comments so a rationale that
 * merely mentions a table cannot create a conflict, while every executable
 * identifier (including ones inside dollar-quoted DO/function bodies) remains
 * visible — those are matched conservatively on purpose.
 */
export function normalizeMigrationSql(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .toLowerCase()
    .replace(/"/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SQL_IDENTIFIER = '[a-z_][a-z0-9_$]*(?:\\.[a-z_][a-z0-9_$]*)*';
const STATIC_TABLE_ANNOTATION = new RegExp(
  '^(comment\\s+on\\s+table\\s+' + SQL_IDENTIFIER + '\\s+is\\s+)' +
  "(?:'(?:''|[^'])*'|(\\$[a-z_][a-z0-9_]*\\$|\\$\\$)[\\s\\S]*\\2)$",
);

/** A table annotation is data, while its target still takes a relation lock.
 * Only recognize this narrow static form. Keep executable function/DO bodies
 * and unknown COMMENT syntax visible to the conservative safety proof. */
function withoutStaticTableAnnotation(text: string): string {
  return splitStatements(text)
    .map((statement) => statement.replace(STATIC_TABLE_ANNOTATION, '$1null'))
    .join(';\n');
}

const TRIGGER_COLUMNS = SQL_IDENTIFIER + '(?:\\s*,\\s*' + SQL_IDENTIFIER + ')*';
const TRIGGER_EVENT = '(?:insert|update(?:\\s+of\\s+' + TRIGGER_COLUMNS + ')?|delete|truncate)';
// A row-field comparison against a literal has no executable function call.
// Keep complex WHEN expressions outside this narrow lock-footprint proof.
const STATIC_TRIGGER_WHEN = '\\s+when\\s*\\(\\s*(?:new|old)\\.[a-z_][a-z0-9_$]*\\s*' +
  '(?:=|<>|!=|not\\s+like|like|is(?:\\s+not)?\\s+distinct\\s+from)\\s*' +
  "(?:'(?:''|[^'])*'|null|true|false|[0-9]+)\\s*\\)";
const STATIC_TRIGGER_ACTION = new RegExp(
  '^(create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+' + SQL_IDENTIFIER +
  '\\s+(?:before|after|instead\\s+of)\\s+' + TRIGGER_EVENT + '(?:\\s+or\\s+' + TRIGGER_EVENT + ')*' +
  '\\s+on\\s+' + SQL_IDENTIFIER + '(?:\\s+for\\s+(?:each\\s+)?(?:row|statement))?' +
  '(?:' + STATIC_TRIGGER_WHEN + ')?\\s+)' +
  'execute(\\s+(?:function|procedure)\\s+' + SQL_IDENTIFIER + '\\s*\\(\\s*\\))$',
);

/** CREATE TRIGGER declares a future action; it does not execute dynamic SQL.
 * Recognize only the simple static form. Other syntax remains conservative.
 * Reuse the statement splitter so a DO body or following prepared EXECUTE
 * cannot acquire this exemption. Relation checks still inspect the full text. */
function withoutStaticTriggerAction(text: string): string {
  return splitStatements(text)
    .map((statement) => statement.replace(STATIC_TRIGGER_ACTION, '$1trigger_action$2'))
    .join(';\n');
}

const STATIC_RLS_POLICY_GRANT_LOOP =
  /^do\s+\$([a-z_][a-z0-9_]*)\$\s+declare\s+([a-z_][a-z0-9_$]*)\s+text\s*;\s+begin\s+foreach\s+\2\s+in\s+array\s+array\s*\[\s*((?:'[a-z_][a-z0-9_$]*'\s*,\s*)*'[a-z_][a-z0-9_$]*')\s*\]\s+loop([\s\S]*?)end\s+loop\s*;\s+end\s+\$\1\$\s*;?$/;

/**
 * Recognize only the bounded RLS setup shape used by migrations: one explicit
 * identifier array, one CREATE POLICY format string, and one GRANT format
 * string, both targeting the loop variable. The relation-name proof still
 * scans the original SQL, so a backup lock on any listed table remains a
 * conflict. Any extra or different EXECUTE stays fail-closed.
 */
function isStaticRlsPolicyGrantLoop(statement: string): boolean {
  const match = STATIC_RLS_POLICY_GRANT_LOOP.exec(statement);
  if (!match) return false;
  const [, , loopVariable, tableArray, body] = match;
  const tableNames = [...tableArray.matchAll(/'([a-z_][a-z0-9_$]*)'/g)].map((entry) => entry[1]);
  if (tableNames.length === 0 || new Set(tableNames).size !== tableNames.length) return false;

  const calls = [...body.matchAll(/\bexecute\s+format\s*\(\s*'((?:''|[^'])*)'\s*,\s*([a-z_][a-z0-9_$]*)\s*\)/g)];
  if (calls.length !== 2 || (body.match(/\bexecute\b/g) ?? []).length !== calls.length) return false;
  const templates = calls.map((call) => call[1].replace(/\s+/g, ' ').trim());
  if (calls.some((call) => call[2] !== loopVariable)) return false;

  const policyTemplate =
    /^create policy workspace_isolation on harness_shared\.%i using \(workspace_id=current_setting\(''app\.workspace_id'',true\)\) with check \(workspace_id=current_setting\(''app\.workspace_id'',true\)\)$/;
  const grantTemplate =
    /^grant select,insert,update,delete on harness_shared\.%i to harness_app$/;
  return templates.filter((template) => policyTemplate.test(template)).length === 1 &&
    templates.filter((template) => grantTemplate.test(template)).length === 1;
}

function withoutStaticRlsPolicyGrantExecutes(text: string): string {
  return splitStatements(text)
    .map((statement) =>
      isStaticRlsPolicyGrantLoop(statement)
        ? statement.replace(/\bexecute\b/g, 'bounded_dynamic_statement')
        : statement,
    )
    .join(';\n');
}

/**
 * Pure verdict: which pending migrations touch a relation the backup holds, or
 * cannot be proven not to. An empty result means every pending file is safe to
 * apply without the rendezvous.
 */
export function findBackupLockConflicts(
  pending: ReadonlyArray<PendingMigrationText>,
  lockedRelationNames: ReadonlyArray<string>,
): MigrationLockConflict[] {
  const names = [...new Set(lockedRelationNames.map((name) => name.toLowerCase()).filter(Boolean))];
  const matchers = names.map((name) => ({
    name,
    re: new RegExp(`(^|[^a-z0-9_$])${escapeRegExp(name)}([^a-z0-9_$]|$)`),
  }));
  const conflicts: MigrationLockConflict[] = [];
  for (const { file, sqlText } of pending) {
    const text = withoutStaticTableAnnotation(normalizeMigrationSql(sqlText));
    const statementText = withoutStaticRlsPolicyGrantExecutes(withoutStaticTriggerAction(text));
    for (const { label, re } of UNPROVABLE_STATEMENTS) {
      if (re.test(statementText)) conflicts.push({ file, subject: label, reason: 'unprovable-statement' });
    }
    for (const { name, re } of matchers) {
      if (re.test(text)) conflicts.push({ file, subject: name, reason: 'names-locked-relation' });
    }
  }
  return conflicts;
}

export interface BackupRendezvousInspection {
  /** Whether another session currently owns the backup/migration advisory lock. */
  rendezvousBusy: boolean;
  /** Conflicts for this migration when the rendezvous is busy. */
  conflicts: MigrationLockConflict[];
}

/**
 * Inspect the manual migration rendezvous using the same proof as boot-migrate.
 * A successful try-lock is immediately released; the actual psql apply then
 * takes the normal transaction lock. When another session owns the rendezvous,
 * only a complete relation proof with no conflicts permits a concurrent apply.
 * Query or shape failures throw so callers can retain the blocking path.
 */
export async function inspectBackupRendezvousForMigration(
  client: Sql,
  migration: PendingMigrationText,
): Promise<BackupRendezvousInspection> {
  const lock = await client.unsafe<{ acquired: boolean }[]>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
    [BACKUP_MIGRATION_ADVISORY_LOCK_KEY],
  );
  if (lock[0]?.acquired === true) {
    const unlocked = await client.unsafe<{ released: boolean }[]>(
      'SELECT pg_advisory_unlock(hashtext($1)) AS released',
      [BACKUP_MIGRATION_ADVISORY_LOCK_KEY],
    );
    if (unlocked[0]?.released !== true) {
      throw new Error('the advisory-lock preflight could not release its probe lock');
    }
    return { rendezvousBusy: false, conflicts: [] };
  }
  if (lock[0]?.acquired !== false) {
    throw new Error('the advisory-lock preflight returned no explicit result');
  }
  const lockedRelations = await readBackupLockedRelationNames(client);
  return {
    rendezvousBusy: true,
    conflicts: findBackupLockConflicts([migration], lockedRelations),
  };
}

/**
 * Relation names currently locked in THIS database by a backup backend,
 * expanded with inheritance/partition ancestors (DDL on a parent recurses into
 * a locked child) and the index names of every locked table (DROP/ALTER INDEX
 * locks the table without naming it).
 */
export async function readBackupLockedRelationNames(client: Sql): Promise<string[]> {
  const rows = await client<{ name: string }[]>`
    WITH RECURSIVE locked AS (
      SELECT DISTINCT l.relation AS oid
        FROM pg_locks AS l
        JOIN pg_stat_activity AS a ON a.pid = l.pid
       WHERE l.locktype = 'relation'
         AND l.granted
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND a.application_name = ANY(${client.array([...BACKUP_APPLICATION_NAMES])})
         AND a.pid <> pg_backend_pid()
    ), ancestry AS (
      SELECT oid FROM locked
      UNION
      SELECT i.inhparent FROM pg_inherits AS i JOIN ancestry AS c ON c.oid = i.inhrelid
    ), named AS (
      SELECT oid FROM ancestry
      UNION
      SELECT x.indexrelid FROM pg_index AS x JOIN ancestry AS t ON t.oid = x.indrelid
    )
    SELECT DISTINCT c.relname AS name
      FROM named
      JOIN pg_class AS c ON c.oid = named.oid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'`;
  return rows.map((row) => row.name);
}

/** One-line summary for boot logs and retryable error messages. */
export function describeConflicts(conflicts: ReadonlyArray<MigrationLockConflict>): string {
  return conflicts
    .map((c) =>
      c.reason === 'names-locked-relation'
        ? `${c.file} names backup-locked relation ${c.subject}`
        : `${c.file} contains ${c.subject}, whose lock footprint cannot be proven`,
    )
    .join('; ');
}
