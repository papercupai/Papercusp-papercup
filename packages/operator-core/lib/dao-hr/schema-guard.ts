/**
 * dao-hr schema guard (dao-hr-people-2026-10-11 R-1, SPEC-P-002-B, D-011).
 *
 * HR keeps NO contact store of its own: a person's name, email, phone and postal
 * address live only on the shared person record (the canonical PER- entity in
 * harness_shared.work_items). This guard reads dao-hr migration SQL and reports
 * every column a migration adds — via CREATE TABLE, ALTER TABLE … ADD [COLUMN],
 * or ALTER TABLE … RENAME [COLUMN] … TO — whose name is contact data, on any
 * table other than that person record.
 *
 * A column is contact data when one of its `_`-separated words is a personal
 * name/contact word (name, email, phone, mobile, telephone, contact, …) or is
 * `address` unless it is qualified as a machine address (`wallet_address`,
 * `contract_address`, `ip_address`). The rule is deliberately word-based and
 * strict: a descriptive HR column is named `title` / `label` / `key`, never
 * `*_name`, so a false positive costs a rename while a false negative would let
 * a second contact store in.
 *
 * Pure: takes SQL text, returns findings. `listDaoHrMigrationFindings` walks a
 * migration directory for files whose name contains `dao-hr`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only table a dao-hr migration may add contact columns to: the shared person record. */
export const DAO_HR_PERSON_RECORD_TABLE = 'harness_shared.work_items';

/** Words that make a column personal name / contact data wherever they appear. */
const CONTACT_WORDS: ReadonlySet<string> = new Set([
  'name',
  'names',
  'firstname',
  'lastname',
  'fullname',
  'surname',
  'email',
  'emails',
  'mail',
  'e', // `e_mail`
  'phone',
  'phones',
  'mobile',
  'telephone',
  'tel',
  'fax',
  'contact',
  'contacts',
  'street',
  'postcode',
  'zip',
  'zipcode',
]);

/** Qualifiers that make `address` a machine address rather than a postal one. */
const MACHINE_ADDRESS_QUALIFIERS: ReadonlySet<string> = new Set(['wallet', 'contract', 'ip', 'mac', 'evm']);

export interface ContactColumnFinding {
  readonly file: string;
  readonly table: string;
  readonly column: string;
  readonly statement: 'create-table' | 'add-column' | 'rename-column';
}

/** True when a column name is personal name / contact data under the rule above. */
export function isContactColumnName(column: string): boolean {
  const words = unquote(column).toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return false;
  if (words.join('') === 'email') return true; // `e_mail`
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === 'e' && words[i + 1] !== 'mail') continue;
    if (CONTACT_WORDS.has(word)) return true;
    if (word === 'address' || word === 'addresses') {
      const qualifier = i > 0 ? words[i - 1]! : null;
      if (qualifier === null || !MACHINE_ADDRESS_QUALIFIERS.has(qualifier)) return true;
    }
  }
  return false;
}

/** Contact-column findings for one migration's SQL text. */
export function findContactColumns(file: string, sqlText: string): ContactColumnFinding[] {
  const sql = stripComments(sqlText);
  const findings: ContactColumnFinding[] = [];
  // Matches are searched ANYWHERE in a statement (not anchored to its start), so DDL
  // wrapped in a `DO $$ BEGIN … END $$` block or an IF guard is still read.
  for (const statement of splitStatements(sql)) {
    const create = /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s*\(/i.exec(statement);
    if (create) {
      const table = normalizeTable(create[1]!);
      const body = balancedBody(statement, create.index + create[0].length - 1);
      for (const element of splitTopLevel(body)) {
        const column = leadingIdentifier(element);
        if (column && !isTableConstraintKeyword(column) && isContactColumnName(column) && !isPersonRecord(table)) {
          findings.push({ file, table, column: unquote(column), statement: 'create-table' });
        }
      }
      continue;
    }
    const alter = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)\s+/i.exec(statement);
    if (!alter) continue;
    const table = normalizeTable(alter[1]!);
    if (isPersonRecord(table)) continue;
    const actions = statement.slice(alter.index + alter[0].length);
    for (const action of splitTopLevel(actions)) {
      const add = /^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\w+)/i.exec(action);
      if (add && !isTableConstraintKeyword(add[1]!) && isContactColumnName(add[1]!)) {
        findings.push({ file, table, column: unquote(add[1]!), statement: 'add-column' });
        continue;
      }
      const rename = /^\s*RENAME\s+(?:COLUMN\s+)?(?:"[^"]+"|\w+)\s+TO\s+("[^"]+"|\w+)/i.exec(action);
      if (rename && isContactColumnName(rename[1]!)) {
        findings.push({ file, table, column: unquote(rename[1]!), statement: 'rename-column' });
      }
    }
  }
  return findings;
}

/** A migration belongs to the dao-hr family when its file name says so. */
export function isDaoHrMigrationFile(fileName: string): boolean {
  return /dao-hr/i.test(fileName) && /\.sql(?:\.DRAFT)?$/i.test(fileName);
}

/** Every contact-column finding across the dao-hr migrations in `sqlDir` (armed and draft). */
export function listDaoHrMigrationFindings(sqlDir: string): { files: string[]; findings: ContactColumnFinding[] } {
  const files = readdirSync(sqlDir).filter(isDaoHrMigrationFile).sort();
  const findings = files.flatMap((file) => findContactColumns(file, readFileSync(join(sqlDir, file), 'utf8')));
  return { files, findings };
}

function isPersonRecord(table: string): boolean {
  return table === DAO_HR_PERSON_RECORD_TABLE;
}

function isTableConstraintKeyword(identifier: string): boolean {
  return /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/i.test(identifier);
}

function unquote(identifier: string): string {
  return identifier.replace(/^"|"$/g, '');
}

function normalizeTable(raw: string): string {
  const parts = raw.split('.').map((part) => unquote(part).toLowerCase());
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
}

function leadingIdentifier(element: string): string | null {
  const match = /^\s*("[^"]+"|\w+)/.exec(element);
  return match ? match[1]! : null;
}

/** Remove `--` line comments, `/* … *\/` block comments and string literals' contents. */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'") {
      // Keep the quotes, blank the content, so a CHECK literal never reads as a column.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function splitStatements(sql: string): string[] {
  return sql.split(';').filter((statement) => statement.trim().length > 0);
}

/** Text between the `(` at `openIndex` and its matching `)`. */
function balancedBody(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return text.slice(openIndex + 1);
}

/** Split on commas at parenthesis depth 0. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}
